// The wired app with Telegram intercepted (no network) and a fake `claude` / `jobagent`.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createApp, extractUrls, isAllowed, tryPair } from '../src/app'
import * as OB from '../src/onboarding'
import { DATA, DEFAULT_SETTINGS, PAIR_FILE, loadSettings, logError, readJson, writeJson } from '../src/state'

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms))
const LOG = join(DATA, 'logs', 'app.log')
const logSize = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0
const logSince = (n: number) => readFileSync(LOG, 'utf8').slice(n) // the log is shared by every test in the run

describe('gate and pairing', () => {
  test('only the paired user, only in a private chat', () => {
    expect(isAllowed(7, 'private', 7)).toBe(true)
    expect(isAllowed(8, 'private', 7)).toBe(false)
    expect(isAllowed(7, 'group', 7)).toBe(false)
    expect(isAllowed(7, 'private', null)).toBe(false)
  })
  test('pairing codes: right code once, wrong codes limited, expiry', () => {
    const put = (code: string, exp = Date.now() / 1000 + 900) => writeJson(PAIR_FILE, { code_hash: createHash('sha256').update(code).digest('hex'), expires_at: exp, attempts: 0 })
    put('abcdefghjk')
    expect(tryPair('wrongwrong')).toBe('bad')
    expect(tryPair('abcdefghjk')).toBe('ok')
    expect(tryPair('abcdefghjk')).toBe('expired') // used up
    put('abcdefghjk')
    for (let i = 0; i < 5; i++) tryPair('nopenopeno')
    expect(tryPair('abcdefghjk')).toBe('expired') // too many tries burns the code
    put('abcdefghjk', Date.now() / 1000 - 1)
    expect(tryPair('abcdefghjk')).toBe('expired')
  })
  test('links in a message', () => {
    expect(extractUrls('look: https://job-boards.greenhouse.io/acme/jobs/1, and (https://x.test/a).')).toEqual(['https://job-boards.greenhouse.io/acme/jobs/1', 'https://x.test/a'])
  })
})

function makeApp() {
  writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, paired_user_id: 42 })
  const calls: { method: string; payload: any }[] = []
  const pyCalls: string[][] = []
  rmSync(join(DATA, 'tasks.json'), { force: true })
  const held: (() => void)[] = []
  const exec = () => ({ pid: undefined, done: new Promise<{ code: number; stderr: string }>(r => { held.push(() => r({ code: 0, stderr: '' })) }) })
  const run = async (a: string[]) => {
    pyCalls.push(a)
    if (a[0] === 'profile' && a[1] === 'show') return { ok: true, fields: { full_name: 'Jane Doe', email: 'jane@x.test' } }
    if (a[0] === 'boards' && a[1] === 'list') return { ok: true, boards: { greenhouse: [] } }
    return { ok: true }
  }
  const app = createApp({ token: '123:fake', exec, run })
  app.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, result: { message_id: calls.length, chat: { id: 42 }, date: 0 } } as any
  })
  return { app, calls, pyCalls, release: () => held.splice(0).forEach(f => f()) }
}

describe('tools Claude can call', () => {
  test('settings changes: chat only, never pairing or going live', async () => {
    const { app, release } = makeApp()
    const chat = app.agent.enqueue({ kind: 'chat', title: 'Chat', payload: { text: 'raise my minimum' } }).task
    const job = app.agent.enqueue({ kind: 'job', title: 'x', payload: { url: 'https://x.test/1' } }).task
    await wait()
    expect((await app.handleTool(chat.id, 'settings_update', { patch: { filters: { min_salary: 120000 } } })).text).toBe('saved')
    expect(loadSettings().filters.min_salary).toBe(120000)
    await expect(app.handleTool(chat.id, 'settings_update', { patch: { dry_run: false } })).rejects.toThrow('practice mode')
    await expect(app.handleTool(chat.id, 'settings_update', { patch: { paired_user_id: 1 } })).rejects.toThrow()
    await expect(app.handleTool(job.id, 'settings_update', { patch: { filters: { min_salary: 1 } } })).rejects.toThrow('only for chat')
    await expect(app.handleTool(job.id, 'profile_ready', { name: 'x' })).rejects.toThrow('only for resume')
    expect((await app.handleTool('no-such-task', 'tg_send', { text: 'hi' })).isError).toBe(true)
    await expect(app.handleTool(job.id, 'tg_send', { text: 'x', buttons: ['r:ok:12345678'] })).rejects.toThrow('unknown button')
    await expect(app.handleTool(job.id, 'tg_send', { text: 'x', files: ['C:\\Windows\\win.ini'] })).rejects.toThrow()
    release()
    await app.stop()
  })

  test('tg_progress draws a live card with the job title and score', async () => {
    const { app, calls, release } = makeApp()
    const job = app.agent.enqueue({ kind: 'job', title: 'New job · x.test', payload: { url: 'https://x.test/1' } }).task
    await wait()
    await app.handleTool(job.id, 'tg_progress', { job_id: 'greenhouse-acme-1', stage: 'score', title: 'Acme · Data Analyst', detail: '82/100' })
    await wait(2800)
    const card = calls.filter(c => c.method === 'sendMessage' || c.method === 'editMessageText').map(c => c.payload.text).find(t => t.includes('🏢 Acme · Data Analyst'))
    expect(card).toContain('82/100')
    expect(card).toContain('Checking how well it fits')
    release()
    await app.stop()
  }, 10_000)
})

describe('setup wizard', () => {
  test('a full run saves settings and private answers, and finishes setup', async () => {
    const { app, pyCalls } = makeApp()
    OB.saveOb({ step: 'profile', picks: [], locs: [], country: 'United States', summary: { name: 'Jane', headline: 'Data Analyst at Acme', years: 4, level: 'mid', location: 'Austin, TX', country: 'United States', email: '', phone: '', skills: ['SQL'], suggested_titles: ['Data Analyst', 'BI Analyst'] } })
    const ctx: any = { chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } }
    const tap = (d: string) => app.route(ctx, d, {})
    expect(await tap('o:next:titles')).toContain('at least one')
    await tap('o:ok')
    await tap('o:t:0')
    expect(((await tap('o:next:titles')) as any).text).toContain('What level')
    expect(loadSettings().filters.titles).toEqual(['Data Analyst'])
    await tap('o:lv:senior')
    await tap('o:l:0')
    await tap('o:next:locations')
    await tap('o:rm:remote_only')
    await tap('o:sa:100000')
    await tap('o:au:yes')
    await tap('o:sp:No')
    await tap('o:st:2 weeks')
    await tap('o:rl:No')
    const done = (await tap('o:eo:decline')) as any
    expect(done.text).toContain("You're all set")
    await wait(50)
    const s = loadSettings()
    expect(s.onboarded).toBe(true)
    expect(s.filters).toMatchObject({ experience_level: 'senior', locations: ['Austin, TX'], remote: 'remote_only', min_salary: 100000 })
    const saved = pyCalls.filter(a => a[1] === 'answer' && a[2] === 'set')
    const key = (k: string) => saved.find(a => a[3] === k)
    expect(key('work_auth_united_states')).toContain('--sensitive')
    expect(key('work_auth_united_states')).toContain('--value=Yes')
    expect(key('sponsorship_required')).toContain('--value=No')
    expect(key('salary_expectation_min')).toContain('--sensitive')
    for (const k of ['eeo_gender', 'eeo_race', 'eeo_veteran', 'eeo_disability']) expect(key(k)).toContain(`--value=${OB.DECLINE}`)
    expect(readJson<any>(join(DATA, 'onboarding.json'), {}).step).toBe('done')
    await app.stop()
  })
})

describe('logging', () => {
  test('logError records where it failed and still hides the bot token', () => {
    const n = logSize()
    logError('thing failed', new Error('bad call to https://api.telegram.org/bot123456:ABC-def/getMe'))
    const text = logSince(n)
    expect(text).toContain('thing failed: Error: bad call')
    expect(text).toMatch(/\n\s+at /)
    expect(text).toContain('bot<token>')
    expect(text).not.toContain('ABC-def')
  })
})

describe('polling', () => {
  test('the log says why each retry failed and names the bot once, not on every retry', async () => {
    const n = logSize()
    const app = createApp({ token: '123:fake', exec: () => ({ pid: undefined, done: new Promise(() => {}) }), run: async () => ({ ok: true }) })
    app.bot.api.config.use(async (_prev, method) => {
      if (method === 'getUpdates') return { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } as any
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'testbot' } } as any
      return { ok: true, result: true } as any
    })
    await app.start(1)
    const text = logSince(n)
    expect(text.match(/polling as @testbot/g)?.length).toBe(1)
    expect(text).toContain('Telegram connection failed (attempt 1)')
    expect(text).toContain('(attempt 3)')
    expect(text).not.toContain('(attempt 4)')
    await app.stop().catch(() => {})
  })
  test('another poller on the same bot (409) gives up with a plain reason instead of looping forever', async () => {
    const app = createApp({ token: '123:fake', exec: () => ({ pid: undefined, done: new Promise(() => {}) }), run: async () => ({ ok: true }) })
    let polls = 0
    app.bot.api.config.use(async (_prev, method) => {
      if (method === 'getUpdates') { polls++; return { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } as any }
      if (method === 'getMe') return { ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'testbot' } } as any
      return { ok: true, result: true } as any
    })
    const why = await app.start(1)
    expect(why).toContain('Another program is using this Telegram bot')
    expect(polls).toBe(8)
    await app.stop().catch(() => {})
  })
})
