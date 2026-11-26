// Runs Claude as headless tasks (`claude -p`, the user's own subscription), one work task at a time plus a chat lane.
// Every tool call streams back, so the app always knows what the agent is doing and can say so in plain words.
// The queue lives in data/tasks.json, so a restart picks up where it left off.
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { rmSync } from 'fs'
import { join } from 'path'
import { describe } from './activity'
import { authText, LIMIT_RE, usageOf } from './llm'
import { killHelpers, killTree } from './runner'
import { DATA, ROOT, loadSettings, log, logError, readJson, writeJson } from './state'

export type Kind = 'chat' | 'resume' | 'job' | 'revise' | 'discover' | 'repair' | 'followup' | 'prep'
export type Lane = 'work' | 'chat'
export type Task = {
  id: string; kind: Kind; title: string; payload: Record<string, unknown>
  job_id?: string; created: number; not_before?: number; tries: number; interrupted?: boolean
  reply_to?: number // the user's message the live card answers
}
export type Live = { task: Task; started: number; doing: string | null; steps: number }
export type Usage = { five_hour?: number; seven_day?: number; resets_at?: number; limited?: boolean; at: number }
export type Outcome = {
  kind: 'done' | 'error' | 'limit' | 'cancelled' | 'timeout' | 'auth' | 'retrying'
  text?: string; result?: string; resets_at?: number; denials: string[]
}
type Exec = (args: string[], env: Record<string, string>, onLine: (l: string) => void) => { pid?: number; done: Promise<{ code: number; stderr: string }> }
// The app runs these itself (v4): code steps plus tool-less Claude calls. Chat, repair, prep and discover stay Claude sessions.
export type CodeKind = 'job' | 'resume' | 'revise' | 'followup'
export const CODE_KINDS = new Set<Kind>(['job', 'resume', 'revise', 'followup'] satisfies CodeKind[])
export type CodeLive = { doing: (text: string) => void; pid: (pid?: number) => void; cancelled: () => boolean }

const FILE = join(DATA, 'tasks.json')
const CHAT_FILE = join(DATA, 'chat.json')
const TIMEOUT_MS = 45 * 60_000
const IDLE_MS = 8 * 60_000 // no output at all from Claude for this long: it is stuck, restart it once
const CHAT_IDLE_MS = 6 * 3600_000 // a chat older than this starts a fresh conversation
const laneOf = (k: Kind): Lane => (k === 'chat' ? 'chat' : 'work')
// What runs first: anything the user started (links, answers, changes) > jobs auto-search found > finding new companies.
export const rank = (t: Pick<Task, 'kind' | 'payload'>) => (t.kind === 'discover' ? 0 : t.payload.source === 'discovery' ? 1 : 2)

const TOOLS: Record<Lane, string> = {
  work: 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,Task,Skill',
  chat: 'Bash,Read,Glob,Grep',
}

// What the agent is asked to do. CLAUDE.md maps the task kind to a skill.
export function promptFor(t: Task): string {
  const p = t.payload
  const what: Record<Exclude<Kind, CodeKind>, string> = { // CODE_KINDS never reach Claude as a session
    discover: 'Time to find new companies to watch. Run the discover-jobs skill.',
    repair: `The user asked you to look into a problem with JobAgent itself (${p.trigger}). Run the repair-app skill.`,
    chat: 'A message from the user in Telegram. Answer it (see CLAUDE.md, Chat).',
    prep: `The user has an interview for job ${t.job_id}. Run the interview-prep skill.`,
  }
  if (CODE_KINDS.has(t.kind)) throw new Error(`a ${t.kind} task runs in code, not in a Claude session`)
  const kind = t.kind as Exclude<Kind, CodeKind>
  return [
    `JobAgent task: ${t.kind} (task id ${t.id})`,
    what[kind],
    ...(t.interrupted ? ['This task was interrupted by a restart: check what is already done (jobagent job get) and continue from there. Never submit.'] : []),
    JSON.stringify({ ...(t.job_id ? { job_id: t.job_id } : {}), ...p }),
  ].join('\n')
}

const defaultExec: Exec = (args, env, onLine) => {
  const p = spawn('claude', args, {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  })
  let stderr = ''
  p.stderr!.on('data', d => { stderr = (stderr + d).slice(-4000) })
  createInterface({ input: p.stdout! }).on('line', onLine)
  const done = new Promise<{ code: number; stderr: string }>(res => {
    p.on('error', e => res({ code: -1, stderr: `${e.message}` }))
    p.on('close', code => res({ code: code ?? -1, stderr }))
  })
  return { pid: p.pid, done }
}

export type AgentDeps = {
  bridge: () => { url: string; secret: string }
  onLive: (lane: Lane, live: Live | null) => void
  onFinish: (task: Task, o: Outcome) => void | Promise<void>
  onUsage: (u: Usage) => void
  canRunBackground?: () => boolean // false while the user's Claude limit is nearly used up: only their own work runs
  code?: (t: Task, live: CodeLive) => Promise<Outcome> // CODE_KINDS run here (pipeline.ts) instead of in a Claude session
  exec?: Exec
  now?: () => number
}

export function createAgent(d: AgentDeps) {
  const exec = d.exec ?? defaultExec
  const now = d.now ?? Date.now
  const saved = readJson<{ queue?: Task[]; running?: Task[] }>(FILE, {})
  // Anything that was running when the app stopped goes back to the front of the line, marked as interrupted.
  let queue: Task[] = [...(saved.running ?? []).map(t => ({ ...t, interrupted: true })), ...(saved.queue ?? [])]
  const live: Partial<Record<Lane, Live & { pid?: number; cancelled?: boolean; timedOut?: boolean }>> = {}
  const persist = () => writeJson(FILE, { queue, running: Object.values(live).map(l => l!.task) })

  function enqueue(t: Omit<Task, 'id' | 'created' | 'tries'> & Partial<Pick<Task, 'id'>>): { task: Task; position: number; existing: boolean } {
    const dup = t.job_id ? [...queue, ...Object.values(live).map(l => l!.task)].find(x => x.kind === t.kind && x.job_id === t.job_id && x.kind !== 'revise') : undefined
    if (dup) return { task: dup, position: position(dup.id), existing: true }
    const task: Task = { id: t.id ?? randomUUID().slice(0, 8), created: now(), tries: 0, ...t }
    queue.push(task)
    persist()
    queueMicrotask(pump)
    return { task, position: position(task.id), existing: false }
  }

  // The line in the order tasks will run: highest rank first, oldest first within a rank (sort is stable).
  const ordered = (lane: Lane) => queue.filter(x => laneOf(x.kind) === lane).sort((a, b) => rank(b) - rank(a))

  // 0 = running now, 1 = next, ...
  function position(id: string): number {
    const t = queue.find(x => x.id === id)
    if (!t) return 0
    const lane = laneOf(t.kind)
    return ordered(lane).findIndex(x => x.id === id) + (live[lane] ? 1 : 0)
  }

  function pump() {
    const s = loadSettings()
    for (const lane of ['work', 'chat'] as Lane[]) {
      if (live[lane]) continue
      if (lane === 'work' && !s.agent_on) continue // paused: work waits in line, chat still answers
      const bg = d.canRunBackground?.() ?? true
      const t = ordered(lane).find(x => (x.not_before ?? 0) <= now() && (bg || rank(x) >= 2))
      if (!t) continue
      queue = queue.filter(x => x !== t)
      void run(lane, t)
    }
  }

  function chatSession(): string | undefined {
    const c = readJson<{ id?: string; at?: number }>(CHAT_FILE, {})
    return c.id && now() - (c.at ?? 0) < CHAT_IDLE_MS ? c.id : undefined
  }

  // A job, resume, revise or followup task: the app's pipeline in code, with tool-less Claude calls (no agentic session).
  async function runCode(lane: Lane, t: Task, L: Live & { pid?: number; cancelled?: boolean }) {
    let o: Outcome
    try {
      if (!d.code) throw new Error('no code runner for this kind of task')
      o = await d.code(t, { doing: x => { L.doing = x; L.steps++; d.onLive(lane, L) }, pid: p => { L.pid = p }, cancelled: () => !!L.cancelled })
    } catch (e) {
      logError(`task ${t.id} failed`, e)
      o = { kind: 'error', text: 'Something went wrong on my side.', denials: [] }
    }
    if (L.cancelled) o = { kind: 'cancelled', denials: [] }
    if (o.kind === 'limit') queue.unshift({ ...t, not_before: (o.resets_at ?? now() + 3600_000) + 60_000, interrupted: true })
    delete live[lane]
    log(`task ${t.id} ${t.kind} -> ${o.kind} (code, ${L.steps} steps, ${Math.round((now() - L.started) / 1000)}s)${o.kind === 'error' ? ` [${o.text ?? ''}]` : ''}`)
    persist()
    d.onLive(lane, null)
    try { await d.onFinish(t, o) } catch (e) { logError('onFinish failed', e) }
    pump()
  }

  async function run(lane: Lane, t: Task) {
    const s = loadSettings()
    const L: Live & { pid?: number; cancelled?: boolean; timedOut?: boolean; idle?: boolean } = { task: t, started: now(), doing: null, steps: 0 }
    live[lane] = L
    persist()
    d.onLive(lane, L)
    if (CODE_KINDS.has(t.kind)) return runCode(lane, t, L)
    const mcp = join(DATA, 'run', `mcp-${t.id}.json`)
    const b = d.bridge()
    writeJson(mcp, { mcpServers: { jobbot: { command: process.execPath, args: ['run', join(ROOT, 'app', 'src', 'mcp.ts')], env: { JOBBOT_BRIDGE: b.url, JOBBOT_SECRET: b.secret, JOBBOT_TASK: t.id } } } })
    const resume = lane === 'chat' ? chatSession() : undefined
    const args = [
      '-p', promptFor(t), '--output-format', 'stream-json', '--verbose',
      // Project settings only (the user's own hooks and plugins stay out). The permission rules must be passed
      // explicitly: headless sessions do not apply the project file's rules from --setting-sources alone.
      '--setting-sources', 'project', '--settings', join(ROOT, '.claude', 'settings.json'), '--permission-prompts', 'none',
      '--strict-mcp-config', '--mcp-config', mcp, '--tools', TOOLS[lane], '--model', s.agent_model,
      ...(resume ? ['--resume', resume] : []),
    ]
    let result: any = null, limited: number | undefined, lastText = '', session = '', heard = now()
    const onLine = (line: string) => {
      heard = now()
      let m: any
      try { m = JSON.parse(line) } catch { return }
      if (m.type === 'system' && m.subtype === 'init') session = m.session_id ?? ''
      else if (m.type === 'assistant') {
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_use') {
            L.steps++
            const what = describe(c.name, c.input)
            if (what) { L.doing = what; d.onLive(lane, L) }
          } else if (c.type === 'text' && !m.parent_tool_use_id && c.text?.trim()) lastText = c.text
        }
      } else if (m.type === 'rate_limit_event') {
        const u = usageOf(m, now())
        if (u.limitedUntil) limited = u.limitedUntil
        d.onUsage(u.usage)
      } else if (m.type === 'result') result = m
    }
    const h = exec(args, { JOBBOT_TASK: t.id }, onLine)
    L.pid = h.pid
    const timer = setTimeout(() => { L.timedOut = true; if (h.pid) killTree(h.pid) }, TIMEOUT_MS)
    const watchdog = setInterval(() => { if (now() - heard > IDLE_MS && !L.idle) { L.idle = true; if (h.pid) killTree(h.pid) } }, 30_000)
    const { code, stderr } = await h.done
    clearTimeout(timer)
    clearInterval(watchdog)
    rmSync(mcp, { force: true })
    delete live[lane]

    const denials = (result?.permission_denials ?? []).map((x: any) => String(x.tool_name ?? '')).filter(Boolean)
    if (denials.length) log(`task ${t.id} denied tools: ${denials.join(', ')}`)
    const errText = `${result?.is_error ? result?.result ?? '' : ''} ${stderr}`
    let o: Outcome
    if (L.cancelled) o = { kind: 'cancelled', denials }
    else if (L.idle && t.tries < 1) {
      queue.unshift({ ...t, tries: t.tries + 1, interrupted: true })
      o = { kind: 'retrying', text: 'Claude went quiet for several minutes, so I restarted it.', denials }
    } else if (L.idle) o = { kind: 'timeout', denials }
    else if (L.timedOut) o = { kind: 'timeout', denials }
    else if (limited || (result?.is_error && LIMIT_RE.test(errText))) {
      const at = limited ?? now() + 3600_000
      queue.unshift({ ...t, not_before: at + 60_000, interrupted: L.steps > 0 })
      o = { kind: 'limit', resets_at: at, denials }
    } else if (authText(errText, code)) {
      o = { kind: 'auth', text: authText(errText, code)!, denials }
    } else if (result && !result.is_error) {
      if (lane === 'chat' && session) writeJson(CHAT_FILE, { id: session, at: now() })
      o = { kind: 'done', result: String(result.result ?? lastText ?? ''), denials }
    } else if (lane === 'chat' && resume && t.tries === 0) {
      writeJson(CHAT_FILE, {}) // the saved conversation could not be resumed: start a fresh one
      queue.unshift({ ...t, tries: 1 })
      o = { kind: 'retrying', denials }
    } else if (t.tries < 1 && !result) {
      queue.unshift({ ...t, tries: t.tries + 1, not_before: now() + 60_000, interrupted: L.steps > 0 }) // a hiccup: one retry
      o = { kind: 'retrying', text: 'Claude stopped unexpectedly. Trying again in a minute.', denials }
    } else o = { kind: 'error', text: String(result?.result ?? stderr ?? '').trim().slice(-300) || `exit code ${code}`, denials }
    // Say why a task went wrong (exit code and the end of stderr): the outcome alone cannot be debugged.
    const why = ['error', 'retrying', 'timeout', 'auth'].includes(o.kind) ? ` [exit ${code}: ${stderr.replace(/\s+/g, ' ').trim().slice(-200)}]` : ''
    log(`task ${t.id} ${t.kind} -> ${o.kind} (${L.steps} steps, ${Math.round((now() - L.started) / 1000)}s)${why}`)
    persist()
    d.onLive(lane, null)
    try { await d.onFinish(t, o) } catch (e) { logError('onFinish failed', e) }
    pump()
  }

  // Stop a task: drop it from the line, or kill it (and the browser it started) if it is running.
  function cancel(pred: (t: Task) => boolean): boolean {
    const before = queue.length
    queue = queue.filter(t => !pred(t))
    let hit = queue.length !== before
    for (const l of Object.values(live)) {
      if (l && pred(l.task)) { l.cancelled = true; hit = true; if (l.pid) killTree(l.pid); killHelpers() }
    }
    persist()
    return hit
  }

  setInterval(pump, 15_000).unref() // tasks waiting for a usage-limit reset
  return {
    enqueue, cancel, pump, position,
    live: (lane: Lane) => live[lane] as Live | undefined,
    queued: (lane: Lane = 'work') => ordered(lane),
    _queue: () => queue,
  }
}
export type Agent = ReturnType<typeof createAgent>
