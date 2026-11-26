// scripts/phone.ts: the one-step phone access script, with a fake tunnel (nothing leaves this computer).
import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { dashPort, runTunnel, signedByCloudflare } from '../../scripts/phone'
import { phoneUrl, setPhoneUrl, startDashboard } from '../src/dashboard'
import { phoneSetupPage } from '../src/pages'
import { DATA, readJson, writeJson } from '../src/state'

const URL_ = 'https://quiet-river-demo-words.trycloudflare.com'
const printed = `INF |  ${URL_}  |`, connected = 'INF Registered tunnel connection connIndex=0'
const fake = (...lines: string[]) => [process.execPath, '-e', `process.stderr.write(${JSON.stringify(lines.join('\n') + '\n')})`]

describe('phone access script', () => {
  test('phone access is on only while the tunnel is connected', async () => {
    let during: string | null = null
    const r = await runTunnel(fake(printed, connected), () => { during = phoneUrl() })
    expect(during as string | null).toBe(URL_)
    expect(r.up).toBe(true)
    expect(phoneUrl()).toBeNull()
  })
  test('a tunnel that never connects turns nothing on and keeps its reason', async () => {
    const error = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": timeout'
    for (const lines of [[error, connected], [printed, error]]) {
      let called = false
      const r = await runTunnel(fake(...lines), () => { called = true })
      expect(called).toBe(false)
      expect(r.tail).toContain(error)
      expect(phoneUrl()).toBeNull()
    }
  })
  test('an address the user set meanwhile is left alone', async () => {
    await runTunnel(fake(printed, connected), () => { setPhoneUrl('https://mine.example.com') })
    expect(phoneUrl()).toBe('https://mine.example.com')
    setPhoneUrl(null)
  })
  test('only a running JobAgent dashboard is tunnelled to', async () => {
    const dash = startDashboard({ botToken: '1:x', pairedId: () => null, approve: async () => null, skip: async () => null, health: () => null }, 0)
    try { expect(await dashPort()).toBe(dash.port) } finally { dash.stop() }
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('something else', { status: 403 }) })
    try {
      const file = join(DATA, 'dashboard.json')
      writeJson(file, { ...readJson<object>(file, {}), port: other.port })
      expect(await dashPort()).toBeNull()
    } finally { other.stop(true) }
  })
  test.skipIf(process.platform !== 'win32')('a file Cloudflare did not sign is rejected', () => {
    expect(signedByCloudflare(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))).toBe(false)
    expect(signedByCloudflare(import.meta.path)).toBe(false)
  }, 30_000)
  test('Windows users are told to run the script; nobody is told to use winget', () => {
    const win = phoneSetupPage(4777, true), mac = phoneSetupPage(4777, false)
    expect(win.text).toContain('phone.ps1')
    expect(mac.text).toContain('http://127.0.0.1:4777')
    expect(win.text + mac.text).not.toContain('winget')
  })
})
