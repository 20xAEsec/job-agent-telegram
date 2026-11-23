#!/usr/bin/env bun
// JobAgent app: started by scripts/start.ps1 (or start.sh). Closing its window stops everything.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createApp } from './app'
import { DATA, loadSettings, log, logError, practiceForced } from './state'

const LOCK = join(DATA, 'run', 'app.lock') // not *.pid: /stop kills every PID listed in run/*.pid
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

// One copy at a time: two copies would fight over the bot (Telegram allows one poller per token).
export function acquire(lock = LOCK): string | null {
  mkdirSync(dirname(lock), { recursive: true })
  for (let i = 0; i < 3; i++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return null } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const pid = parseInt(readFileSync(lock, 'utf8'), 10)
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) return `JobAgent is already running (process ${pid}). Close that window first.`
    rmSync(lock, { force: true }) // stale: its owner is gone
  }
  return 'could not take the app lock'
}
const release = () => { try { if (readFileSync(LOCK, 'utf8') === String(process.pid)) rmSync(LOCK) } catch { /* gone */ } }

function token(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    const m = readFileSync(join(DATA, '.env'), 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)
    if (m) return m[1].trim()
  } catch { /* below */ }
  console.error('No Telegram bot token yet. Run the setup first: scripts\\setup.ps1 (Windows) or scripts/setup.sh (Mac/Linux).')
  process.exit(1)
}

if (import.meta.main) {
  const refused = acquire()
  if (refused) { console.error(refused); process.exit(1) }
  process.on('exit', release)
  // Bun already exits on these; now the reason also reaches the log file (the window may be gone by then).
  for (const ev of ['uncaughtException', 'unhandledRejection'] as const) process.on(ev, e => { logError(`fatal ${ev}`, e); process.exit(1) })
  console.log('\n  Starting JobAgent…')
  // The banner waits until Telegram accepted the token, so "running" is never shown for a bot that is not.
  const onReady = (bot: string) => {
    const s = loadSettings()
    console.log([
      '',
      '  ✅ JobAgent is running.',
      '',
      `  • Open Telegram and talk to @${bot}. ${s.paired_user_id == null ? 'Use the pairing link from setup to connect.' : 'Send /menu to see what is going on.'}`,
      `  • ${practiceForced() || s.dry_run ? 'Practice mode is ON: nothing is ever submitted.' : 'Practice mode is OFF: approved applications are really sent.'}`,
      '  • Keep this window open (you can minimize it). Closing it turns JobAgent off.',
      '',
      '  Activity log below:',
      '',
    ].join('\n'))
  }
  const app = createApp({ token: token(), onReady })
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    log('shutting down')
    void app.stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  void app.start().then(why => { if (why) { log(why); process.exit(1) } })
}
