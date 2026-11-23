// Runs Claude as headless tasks (`claude -p`, the user's own subscription), one work task at a time plus a chat lane.
// Every tool call streams back, so the app always knows what the agent is doing and can say so in plain words.
// The queue lives in data/tasks.json, so a restart picks up where it left off.
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { rmSync } from 'fs'
import { join } from 'path'
import { describe } from './activity'
import { killHelpers, killTree } from './runner'
import { DATA, ROOT, loadSettings, log, logError, readJson, writeJson } from './state'

export type Kind = 'chat' | 'resume' | 'job' | 'revise' | 'discover' | 'repair'
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

const FILE = join(DATA, 'tasks.json')
const CHAT_FILE = join(DATA, 'chat.json')
const TIMEOUT_MS = 45 * 60_000
const CHAT_IDLE_MS = 6 * 3600_000 // a chat older than this starts a fresh conversation
const laneOf = (k: Kind): Lane => (k === 'chat' ? 'chat' : 'work')

const TOOLS: Record<Lane, string> = {
  work: 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,Task,Skill',
  chat: 'Bash,Read,Glob,Grep',
}

// What the agent is asked to do. CLAUDE.md maps the task kind to a skill.
export function promptFor(t: Task): string {
  const p = t.payload
  const what: Record<Kind, string> = {
    job: p.url ? 'The user sent a job link. Run the intake-job skill for it.'
      : `Continue job ${t.job_id} (mode "${p.mode}"). Run the intake-job skill, section Continue.`,
    resume: 'The user uploaded their resume (already imported). Run the read-resume skill.',
    revise: `The user wants a change to the prepared application for job ${t.job_id}. Run the revise-application skill.`,
    discover: 'Time to look for new jobs. Run the discover-jobs skill.',
    repair: `The user asked you to look into a problem with JobAgent itself (${p.trigger}). Run the repair-app skill.`,
    chat: 'A message from the user in Telegram. Answer it (see CLAUDE.md, Chat).',
  }
  return [
    `JobAgent task: ${t.kind} (task id ${t.id})`,
    what[t.kind],
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

  // 0 = running now, 1 = next, ...
  function position(id: string): number {
    const t = queue.find(x => x.id === id)
    if (!t) return 0
    const lane = laneOf(t.kind)
    return queue.filter(x => laneOf(x.kind) === lane).findIndex(x => x.id === id) + (live[lane] ? 1 : 0)
  }

  function pump() {
    const s = loadSettings()
    for (const lane of ['work', 'chat'] as Lane[]) {
      if (live[lane]) continue
      if (lane === 'work' && !s.agent_on) continue // paused: work waits in line, chat still answers
      const t = queue.find(x => laneOf(x.kind) === lane && (x.not_before ?? 0) <= now())
      if (!t) continue
      queue = queue.filter(x => x !== t)
      void run(lane, t)
    }
  }

  function chatSession(): string | undefined {
    const c = readJson<{ id?: string; at?: number }>(CHAT_FILE, {})
    return c.id && now() - (c.at ?? 0) < CHAT_IDLE_MS ? c.id : undefined
  }

  async function run(lane: Lane, t: Task) {
    const s = loadSettings()
    const L: Live & { pid?: number; cancelled?: boolean; timedOut?: boolean } = { task: t, started: now(), doing: null, steps: 0 }
    live[lane] = L
    persist()
    d.onLive(lane, L)
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
    let result: any = null, limited: number | undefined, lastText = '', session = ''
    const onLine = (line: string) => {
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
        const r = m.rate_limit_info ?? {}, w = r.unifiedWindows ?? {}
        const resets = typeof r.resetsAt === 'number' ? r.resetsAt * 1000 : undefined
        if (r.status === 'rejected') limited = resets ?? now() + 3600_000
        d.onUsage({ five_hour: w.five_hour?.utilization, seven_day: w.seven_day?.utilization, resets_at: resets, limited: r.status === 'rejected', at: now() })
      } else if (m.type === 'result') result = m
    }
    const h = exec(args, { JOBBOT_TASK: t.id }, onLine)
    L.pid = h.pid
    const timer = setTimeout(() => { L.timedOut = true; if (h.pid) killTree(h.pid) }, TIMEOUT_MS)
    const { code, stderr } = await h.done
    clearTimeout(timer)
    rmSync(mcp, { force: true })
    delete live[lane]

    const denials = (result?.permission_denials ?? []).map((x: any) => String(x.tool_name ?? '')).filter(Boolean)
    if (denials.length) log(`task ${t.id} denied tools: ${denials.join(', ')}`)
    const errText = `${result?.is_error ? result?.result ?? '' : ''} ${stderr}`
    let o: Outcome
    if (L.cancelled) o = { kind: 'cancelled', denials }
    else if (L.timedOut) o = { kind: 'timeout', denials }
    else if (limited || (result?.is_error && /usage limit|rate limit|limit reached/i.test(errText))) {
      const at = limited ?? now() + 3600_000
      queue.unshift({ ...t, not_before: at + 60_000, interrupted: L.steps > 0 })
      o = { kind: 'limit', resets_at: at, denials }
    } else if (/not logged in|please run \/login|invalid api key|authenticat|oauth/i.test(errText) || code === -1 && /ENOENT/i.test(stderr)) {
      o = { kind: 'auth', text: /ENOENT/i.test(stderr) ? 'Claude Code is not installed on this computer.' : 'Claude is not logged in on this computer.', denials }
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
    queued: (lane: Lane = 'work') => queue.filter(t => laneOf(t.kind) === lane),
    _queue: () => queue,
  }
}
export type Agent = ReturnType<typeof createAgent>
