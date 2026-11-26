// Phone access for the dashboard in one step: gets Cloudflare Tunnel (no package manager needed), runs it and tells
// JobAgent its address. Users run it through scripts/phone.ps1. The phone is connected only while this process runs.
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { phoneUrl, setPhoneUrl } from '../app/src/dashboard'
import { DATA, readJson } from '../app/src/state'

const DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
// The hyphen matters: cloudflared's error messages mention https://api.trycloudflare.com.
const ADDRESS = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/

// The running dashboard's port, or null. It must answer like ours: the tunnel must never expose another program.
export async function dashPort(): Promise<number | null> {
  const { port } = readJson<{ port?: number }>(join(DATA, 'dashboard.json'), {})
  if (!port) return null
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) })
    return r.status === 403 && (await r.text()).includes('Open the dashboard from') ? port : null
  } catch { return null }
}

export function signedByCloudflare(file: string): boolean {
  // Windows PowerShell cannot load its own modules with a PSModulePath inherited from PowerShell 7.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'))
  const r = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    "$s = Get-AuthenticodeSignature -LiteralPath $env:JOBAGENT_CHECK; '{0}|{1}' -f $s.Status, $s.SignerCertificate.Subject"],
    { env: { ...env, JOBAGENT_CHECK: file } })
  return /^Valid\|.*O="Cloudflare, Inc\."/.test(r.stdout.toString())
}

export async function cloudflared(): Promise<string> {
  const installed = Bun.which('cloudflared')
  if (installed) return installed
  if (process.platform !== 'win32') throw new Error('Install Cloudflare Tunnel first (brew install cloudflared), then run this again.')
  const exe = join(DATA, 'bin', 'cloudflared.exe'), part = join(DATA, 'bin', 'cloudflared-download.exe')
  if (existsSync(exe)) return exe
  console.log('  Downloading Cloudflare Tunnel (about 55 MB, first time only)...')
  const r = await fetch(DOWNLOAD)
  if (!r.ok) throw new Error(`The download failed (HTTP ${r.status}). Check your internet connection and run this again.`)
  mkdirSync(join(DATA, 'bin'), { recursive: true })
  await Bun.write(part, await r.arrayBuffer())
  if (!signedByCloudflare(part)) {
    rmSync(part, { force: true })
    throw new Error('Could not confirm the download is signed by Cloudflare, so it was deleted.')
  }
  renameSync(part, exe) // only a complete, checked file ever gets the final name
  return exe
}

let live = ''
// Turns phone access off, unless the user has pointed JobAgent somewhere else since.
export function off() {
  if (live && phoneUrl() === live) setPhoneUrl(null)
  live = ''
}

// Runs the tunnel until it ends; phone access turns on once it is connected. `tail` explains a failure.
export async function runTunnel(cmd: string[], onUp: (url: string) => void) {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const stop = () => proc.kill()
  process.on('exit', stop)
  const tail: string[] = []
  let url = '', up = false, rest = ''
  try {
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop()!
      for (const line of lines) {
        tail.push(line.trim())
        if (tail.length > 8) tail.shift()
        url ||= ADDRESS.exec(line)?.[0] ?? ''
        if (!up && url && line.includes('Registered tunnel connection')) {
          up = true
          live = setPhoneUrl(url)!
          onUp(url)
        }
      }
    }
    await proc.exited
  } finally {
    off()
    process.off('exit', stop)
  }
  return { up, tail }
}

if (import.meta.main) {
  try {
    const port = await dashPort()
    if (!port) throw new Error('The dashboard is not running. Start JobAgent (scripts\\start.ps1), or restart it if it was already open during an update, then run this again.')
    const exe = await cloudflared()
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => process.exit(0))
    process.on('exit', off)
    console.log('  Connecting...')
    const slow = setTimeout(() => console.log('  Still connecting. A firewall, VPN or work network may be blocking Cloudflare Tunnel.'), 45_000)
    const r = await runTunnel([exe, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], () => {
      clearTimeout(slow)
      console.log([
        '',
        '  ✅ Your phone can reach the dashboard.',
        '',
        '  In Telegram: Home → 🖥 Dashboard → 📱 Open dashboard',
        '  (If it does not load right away, wait a few seconds and open it again.)',
        '',
        '  Keep this window open (you can minimize it). Closing it disconnects your phone.',
        '  Next time, just run this script again: it updates the address for you.',
        '',
      ].join('\n'))
    })
    clearTimeout(slow)
    throw new Error(`The tunnel stopped. Run this again. Its last messages:\n     ${r.tail.join('\n     ')}`)
  } catch (e) {
    console.error(`\n  X  ${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
  }
}
