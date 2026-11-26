// One judgment = one `claude -p` call with no tools (the v4 engine). Checked on Claude Code 2.1.332 (v4.md §6):
// `--tools ""` leaves only StructuredOutput, `--safe-mode` loads no CLAUDE.md, hooks, plugins or MCP servers, the answer is
// `result.structured_output`, the input goes in on stdin, and `rate_limit_event` still reports usage. `--bare` is not used:
// it skips the keychain, where the subscription login lives. The call runs in data/run/llm, a folder with no project files.
// Python builds the input (`jobagent llm input`) and checks the answer before anything is written (`jobagent llm accept`).
import { spawn } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { Usage } from './agent'
import { killTree, type Run } from './runner'
import { DATA, log, writeJson } from './state'

export type Name = 'analyze' | 'tailor_ats' | 'tailor_edit' | 'cover_letter' | 'kit' | 'revise' | 'resume_profile' | 'resume_bank' | 'followup' | 'screen'
// Constants, not settings (v3 §3.2): sorting is cheap work, reading needs care, writing uses the model the user picked.
export const MODEL: Record<Name, 'haiku' | 'sonnet' | 'write'> = {
  screen: 'haiku', analyze: 'sonnet', resume_profile: 'sonnet', resume_bank: 'sonnet', kit: 'sonnet', followup: 'sonnet',
  tailor_ats: 'write', tailor_edit: 'write', cover_letter: 'write', revise: 'write',
}
export const PROMPTS = join(import.meta.dir, '..', '..', 'prompts') // part of the code, not of data: never JOBAGENT_ROOT
const RUN_DIR = join(DATA, 'run', 'llm')
const TIMEOUT_MS = 10 * 60_000
const IDLE_MS = 4 * 60_000

export type LlmExec = (args: string[], stdin: string, onLine: (l: string) => void) => { pid?: number; done: Promise<{ code: number; stderr: string }> }
export type CallResult =
  | { ok: true; data: any }
  | { ok: false; kind: 'limit'; resets_at: number; error: string }
  | { ok: false; kind: 'auth' | 'error' | 'rejected' | 'cancelled'; error: string; errors?: string[] }
export type CallOpts = {
  run: Run; exec?: LlmExec; model: string; onUsage: (u: Usage) => void
  onPid?: (pid: number | undefined) => void; cancelled?: () => boolean; now?: () => number
}

// Shared with agent.ts (one mapping for both kinds of task): what a Claude error means.
export const LIMIT_RE = /usage limit|rate limit|limit reached/i
export const AUTH_RE = /not logged in|please run \/login|invalid api key|authenticat|oauth/i
export function authText(stderr: string, code: number): string | null {
  if (code === -1 && /ENOENT/i.test(stderr)) return 'Claude Code is not installed on this computer.'
  return AUTH_RE.test(stderr) ? 'Claude is not logged in on this computer.' : null
}
// A rate_limit_event: the usage it reports, and when a rejected window opens again.
export function usageOf(m: any, now: number): { usage: Usage; limitedUntil?: number } {
  const r = m.rate_limit_info ?? {}, w = r.unifiedWindows ?? {}
  const resets = typeof r.resetsAt === 'number' ? r.resetsAt * 1000 : undefined
  return {
    usage: { five_hour: w.five_hour?.utilization, seven_day: w.seven_day?.utilization, resets_at: resets, limited: r.status === 'rejected', at: now },
    limitedUntil: r.status === 'rejected' ? resets ?? now + 3600_000 : undefined,
  }
}

const defaultExec: LlmExec = (args, stdin, onLine) => {
  mkdirSync(RUN_DIR, { recursive: true })
  const p = spawn('claude', args, { cwd: RUN_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let stderr = ''
  p.stderr!.on('data', d => { stderr = (stderr + d).slice(-4000) })
  createInterface({ input: p.stdout! }).on('line', onLine)
  p.stdin!.on('error', () => {}) // the process died before reading: `done` reports why
  p.stdin!.end(stdin)
  const done = new Promise<{ code: number; stderr: string }>(res => {
    p.on('error', e => res({ code: -1, stderr: e.message }))
    p.on('close', code => res({ code: code ?? -1, stderr }))
  })
  return { pid: p.pid, done }
}

export function claudeArgs(name: Name, model: string): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--tools', '', '--strict-mcp-config', '--safe-mode',
    '--system-prompt-file', join(PROMPTS, `${name}.md`), '--json-schema', readFileSync(join(PROMPTS, `${name}.schema.json`), 'utf8').replace(/\s+/g, ' '),
    '--no-session-persistence']
}

type Once = { kind: 'answer'; data: any; ms: number; tokens: { input: number; output: number } } | Extract<CallResult, { ok: false }>

async function once(name: Name, stdin: string, o: CallOpts): Promise<Once> {
  const now = o.now ?? Date.now, started = now()
  let result: any = null, limited: number | undefined, heard = now(), idle = false, timedOut = false
  const h = (o.exec ?? defaultExec)(claudeArgs(name, o.model), stdin, line => {
    heard = now()
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (m.type === 'rate_limit_event') { const u = usageOf(m, now()); if (u.limitedUntil) limited = u.limitedUntil; o.onUsage(u.usage) }
    else if (m.type === 'result') result = m
  })
  o.onPid?.(h.pid)
  const timer = setTimeout(() => { timedOut = true; if (h.pid) killTree(h.pid) }, TIMEOUT_MS)
  const watch = setInterval(() => { if (now() - heard > IDLE_MS) { idle = true; if (h.pid) killTree(h.pid) } }, 30_000)
  const { code, stderr } = await h.done
  clearTimeout(timer); clearInterval(watch); o.onPid?.(undefined)
  const errText = `${result?.is_error ? result?.result ?? '' : ''} ${stderr}`
  if (o.cancelled?.()) return { ok: false, kind: 'cancelled', error: 'stopped' }
  if (limited || (result?.is_error && LIMIT_RE.test(errText))) return { ok: false, kind: 'limit', resets_at: limited ?? now() + 3600_000, error: 'usage limit' }
  const auth = authText(errText, code)
  if (auth) return { ok: false, kind: 'auth', error: auth }
  if (timedOut || idle) return { ok: false, kind: 'error', error: 'Claude took too long' }
  const data = result?.structured_output
  if (!result || result.is_error || !data || typeof data !== 'object') {
    log(`llm ${name}: no answer [exit ${code}: ${stderr.replace(/\s+/g, ' ').trim().slice(-200)}]`)
    return { ok: false, kind: 'error', error: 'Claude gave no answer' }
  }
  const u = result.usage ?? {}
  return { kind: 'answer', data, ms: now() - started, tokens: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 } }
}

// get the input, ask Claude, have Python check and write the answer; on a refused answer, one more try with the errors.
export async function call(name: Name, job: string | undefined, extra: Record<string, unknown>, o: CallOpts): Promise<CallResult> {
  const jobArgs = job ? ['--job', job] : [], ex = ['--extra', JSON.stringify(extra)]
  const inp = await o.run(['llm', 'input', name, ...jobArgs, ...ex])
  if (!inp.ok) return { ok: false, kind: 'error', error: String(inp.error ?? inp.code ?? 'no input') }
  const input = readFileSync(String(inp.file), 'utf8')
  let stdin = input
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await once(name, stdin, o)
    if (r.kind !== 'answer') return r
    try { appendFileSync(join(DATA, 'usage_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'llm', step: name, job_id: job ?? '', model: o.model, ms: r.ms, input_tokens: r.tokens.input, output_tokens: r.tokens.output }) + '\n') } catch { /* best effort */ }
    const out = join(RUN_DIR, `${name}-${job ?? 'x'}.out.json`)
    writeJson(out, r.data)
    const a = await o.run(['llm', 'accept', name, ...jobArgs, '--file', out, ...ex])
    if (a.ok) return { ok: true, data: a }
    if (a.code !== 'rejected') return { ok: false, kind: 'error', error: String(a.error ?? a.code) }
    log(`llm ${name} ${job ?? ''}: answer refused (${(a.errors ?? []).length} problems)${attempt ? ', giving up' : ', one more try'}`)
    if (attempt) return { ok: false, kind: 'rejected', error: String(a.error), errors: a.errors }
    stdin = `${input}\n\nYour previous answer was refused by the checks. Fix every error and answer again.\n${JSON.stringify({ previous_answer: r.data, errors: a.errors })}`
  }
  return { ok: false, kind: 'error', error: 'unreachable' }
}
