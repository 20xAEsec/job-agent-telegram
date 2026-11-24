// Runs one `jobagent` (Python) command and returns its single JSON object. Args are passed without a shell.
import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { DATA, ROOT } from './state'

export type Run = (args: string[], o?: { timeoutMs?: number }) => Promise<any>

export const runJobagent: Run = (args, o = {}) => new Promise(resolve => {
  const p = spawn('uv', ['run', '--quiet', '--project', join(ROOT, 'agent'), 'jobagent', '--data-dir', DATA, ...args], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let out = '', timedOut = false
  p.stdout.on('data', d => (out += d))
  p.stderr.on('data', () => {}) // drain: a full stderr pipe would block the helper
  const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; if (p.pid) killTree(p.pid) }, o.timeoutMs) : null
  p.on('error', e => resolve({ ok: false, code: 'no_uv', error: `could not run uv: ${e.message}` }))
  p.on('close', () => {
    if (timer) clearTimeout(timer)
    if (timedOut) return resolve({ ok: false, code: 'timeout', error: 'the helper took too long' })
    try { resolve(JSON.parse(out.trim().split('\n').pop() ?? '')) } catch { resolve({ ok: false, code: 'bad_output', error: 'the helper gave no answer' }) }
  })
})

// Kill a process and everything it started (Claude -> uv -> python -> chromium).
export function killTree(pid: number) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

// Every browser session `jobagent` started records its PID in data/run/*.pid.
export function killHelpers(): number {
  const dir = join(DATA, 'run')
  let n = 0
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.pid')) } catch { return 0 }
  for (const f of files) {
    const pid = parseInt(readFileSync(join(dir, f), 'utf8'), 10)
    if (Number.isInteger(pid) && pid > 0) { killTree(pid); n++ }
    rmSync(join(dir, f), { force: true })
  }
  return n
}
