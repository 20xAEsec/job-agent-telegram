// The wired app with Telegram intercepted (no network) and a fake `claude` / `jobagent`.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { claims, createApp, discoverTitles, extractUrls, isAllowed, tryPair } from '../src/app'
import * as F from '../src/forms'
import { code } from '../src/jobs'
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

// A fake tool-less `claude` call: every judgment answers {} at once (llm accept is faked in `run`).
const llmExec = (_a: string[], _in: string, onLine: (l: string) => void) => {
  onLine(JSON.stringify({ type: 'result', is_error: false, structured_output: {} }))
  return { pid: undefined, done: Promise.resolve({ code: 0, stderr: '' }) }
}

function makeApp(answer: (a: string[]) => any = () => undefined) {
  writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, paired_user_id: 42 })
  const calls: { method: string; payload: any }[] = []
  const pyCalls: string[][] = []
  rmSync(join(DATA, 'tasks.json'), { force: true })
  const held: (() => void)[] = []
  const exec = () => ({ pid: undefined, done: new Promise<{ code: number; stderr: string }>(r => { held.push(() => r({ code: 0, stderr: '' })) }) })
  const run = async (a: string[]) => {
    pyCalls.push(a)
    const given = answer(a)
    if (given) return given
    if (a[0] === 'profile' && a[1] === 'show') return { ok: true, fields: { full_name: 'Jane Doe', email: 'jane@x.test' } }
    if (a[0] === 'boards' && a[1] === 'list') return { ok: true, boards: { greenhouse: [] } }
    return { ok: true }
  }
  const app = createApp({ token: '123:fake', exec, run, llmExec })
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
    const job = app.agent.enqueue({ kind: 'prep', job_id: 'greenhouse-acme-1', title: 'x', payload: {} }).task // still a Claude session
    await wait()
    expect((await app.handleTool(chat.id, 'settings_update', { patch: { filters: { min_salary: 120000 } } })).text).toBe('saved')
    expect(loadSettings().filters.min_salary).toBe(120000)
    await expect(app.handleTool(chat.id, 'settings_update', { patch: { dry_run: false } })).rejects.toThrow('practice mode')
    await expect(app.handleTool(chat.id, 'settings_update', { patch: { paired_user_id: 1 } })).rejects.toThrow()
    await expect(app.handleTool(job.id, 'settings_update', { patch: { filters: { min_salary: 1 } } })).rejects.toThrow('only for chat')
    for (const gone of ['profile_ready', 'tg_ask', 'tg_review']) await expect(app.handleTool(job.id, gone, {})).rejects.toThrow('unknown tool') // v4: the app's own code does these
    expect((await app.handleTool('no-such-task', 'tg_send', { text: 'hi' })).isError).toBe(true)
    await expect(app.handleTool(job.id, 'tg_send', { text: 'x', buttons: ['r:ok:12345678'] })).rejects.toThrow('unknown button')
    await expect(app.handleTool(job.id, 'tg_send', { text: 'x', files: ['C:\\Windows\\win.ini'] })).rejects.toThrow()
    release()
    await app.stop()
  })

  test('the job pipeline draws a live card with the job title and score', async () => {
    const ID = 'greenhouse-acme-1', input = join(DATA, 'run', 'llm', 'card.in.json')
    writeJson(input, {})
    let status = 'NEW', hold: (() => void) | null = null
    const { app, calls } = makeApp(a => {
      const [c, s] = a
      if (c === 'job' && s === 'new') return { ok: true, job_id: ID, duplicate: false }
      if (c === 'job' && s === 'get') return status === 'SCORED' ? new Promise(r => { hold = () => r({ ok: true, status: 'SKIPPED' }) }) : { ok: true, status, files: [] }
      if (c === 'job' && s === 'set-status') { status = a[3]; return { ok: true } }
      if (c === 'resolve') return { ok: true, resolved: false }
      if (c === 'fetch') { status = 'FETCHED'; return { ok: true, ats: 'greenhouse' } }
      if (c === 'llm') return s === 'input' ? { ok: true, file: input } : { ok: true, score: 82, company: 'Acme', role: 'Data Analyst' }
      return undefined
    })
    app.agent.enqueue({ kind: 'job', title: 'New job · greenhouse.io', payload: { url: 'https://job-boards.greenhouse.io/acme/jobs/1' } })
    await wait(2800)
    const card = calls.filter(c => c.method === 'sendMessage' || c.method === 'editMessageText').map(c => c.payload.text).find(t => t.includes('🏢 Acme · Data Analyst'))
    expect(card).toContain('82/100')
    expect(card).toContain('Checking how well it fits')
    ;(hold as (() => void) | null)?.()
    await app.stop()
  }, 10_000)
})

describe('setup wizard', () => {
  test('a full run saves settings and private answers, and finishes setup', async () => {
    const { app, pyCalls } = makeApp()
    OB.saveOb({ step: 'profile', picks: [], locs: [], country: 'United States', summary: { name: 'Jane', headline: 'Data Analyst at Acme', years: 4, level: 'mid', location: 'Austin, TX', country: 'United States', email: '', phone: '', skills: ['SQL'], suggested_titles: ['Data Analyst', 'BI Analyst'], related_titles: ['Reporting Analyst', 'BI Analyst'] } })
    const ctx: any = { chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } }
    const tap = (d: string) => app.route(ctx, d, {})
    expect(await tap('o:next:titles')).toContain('at least one')
    await tap('o:ok')
    await tap('o:t:0')
    await tap('o:rt:0') // a related title is saved only when tapped
    expect(((await tap('o:next:titles')) as any).text).toContain('What level')
    expect(loadSettings().filters.titles).toEqual(['Data Analyst'])
    expect(loadSettings().filters.related_titles).toEqual(['Reporting Analyst'])
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

describe('typed input goes to what asked for it', () => {
  const PROFILE = 'https://www.linkedin.com/in/jane-doe'
  const JOB = 'https://job-boards.greenhouse.io/acme/jobs/1'
  function chat() {
    const m = makeApp()
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, paired_user_id: 42, onboarded: true })
    rmSync(join(DATA, 'forms'), { recursive: true, force: true })
    m.app.bot.botInfo = { id: 1, is_bot: true, first_name: 'B', username: 'testbot' } as any
    let n = 0
    const send = (text: string) => m.app.bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, chat: { id: 42, type: 'private', first_name: 'J' }, from: { id: 42, is_bot: false, first_name: 'J' }, text } } as any)
    const tap = (d: string) => m.app.route({ chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } } as any, d, {})
    const jobUrls = () => m.pyCalls.filter(a => a[0] === 'job' && a[1] === 'new').map(a => a[2]) // job tasks run in code: each starts with `job new`
    const ask = (text: string) => F.saveForm(F.newForm('f1', undefined, 'x', F.validateQuestions([{ qid: 'q1', text, kind: 'text' }], false)))
    const open = () => tap(`f:${code('f1')}:open`)
    const answer = () => F.loadForm('f1')!.answers.q1
    const done = async () => { m.release(); await m.app.stop() }
    return { ...m, send, tap, jobUrls, ask, open, answer, done }
  }

  test('a screen only takes what it can use', () => {
    const at = { chat: 42, msg: 1, at: 0 }
    const dash = { ...at, kind: 'dashurl' as const }
    for (const yes of ['https://a-b.trycloudflare.com', 'a-b.trycloudflare.com', 'https://pc.tail1.ts.net/x', 'http://mine.example.com']) expect(claims(dash, yes)).toBe(true)
    for (const no of [PROFILE, JOB, 'linkedin.com/in/jane-doe', 'what is waiting?', '95000']) expect(claims(dash, no)).toBe(false)
    expect(claims({ ...at, kind: 'contact', key: 'linkedin', ob: false }, PROFILE)).toBe(true)
    expect(claims({ ...at, kind: 'contact', key: 'phone', ob: false }, PROFILE)).toBe(false)
    expect(claims({ ...at, kind: 'achievement' }, JOB)).toBe(false)
    expect(claims({ ...at, kind: 'company' }, JOB)).toBe(true)
  })

  test('asking sends a pointer to Open Questions, with nothing to answer on it', async () => {
    const t = chat()
    await t.app.askForm({ batch_id: 'f1', title: 'Acme · Analyst', questions: [{ qid: 'q1', text: 'Remote?', kind: 'yesno' }] })
    const sent = t.calls.find(c => String(c.payload.text).includes('Open Questions'))!
    expect(sent.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(['F:list'])
    expect(((await t.tap('F:list')) as any).rows[0][0]).toMatchObject({ text: 'Open · Acme · Analyst', data: `f:${code('f1')}:open` })
    await t.done()
  })

  test('typed text and buttons answer a question only while it is open', async () => {
    const t = chat()
    t.ask('Your LinkedIn profile URL (optional)')
    await t.send('not opened yet')
    await t.send(PROFILE)
    expect(t.answer()).toBeUndefined()
    expect(t.jobUrls()).toEqual([])
    await t.open()
    await t.tap('m:home') // moving away closes it
    expect(((await t.tap(`f:${code('f1')}:t`)) as any).text).toContain('Open Questions')
    await t.send('still closed')
    expect(t.answer()).toBeUndefined()
    await t.open()
    await t.send(PROFILE)
    expect(t.answer()).toBe(PROFILE)
    await t.done()
  })

  test('opening a question replaces the screen that was waiting', async () => {
    const t = chat()
    t.ask('Anything else?')
    await t.tap('p:ach:add')
    await t.open()
    await t.send('Cut report time by 40 percent')
    expect(t.answer()).toBe('Cut report time by 40 percent')
    expect(t.pyCalls.some(a => a[1] === 'set-field')).toBe(false)
    await t.done()
  })

  test('a job link stays a job link; a profile link never becomes one', async () => {
    const t = chat()
    await t.send(PROFILE)
    expect(t.jobUrls()).toEqual([])
    expect(t.calls.some(c => String(c.payload.text).includes('not a job posting'))).toBe(true)
    t.ask('Link to your portfolio')
    await t.open()
    await t.send(JOB)
    expect(t.jobUrls()).toEqual([JOB])
    expect(t.answer()).toBeUndefined()
    await t.done()
  })
})

describe('auto-search', () => {
  test('"find new companies" takes the titles in turn', () => {
    expect(discoverTitles(['a', 'b', 'c', 'd', 'e'], 0)).toEqual([['a', 'b', 'c'], 3])
    expect(discoverTitles(['a', 'b', 'c', 'd', 'e', 'a'], 3)).toEqual([['d', 'e', 'a'], 6])
    expect(discoverTitles([], 4)).toEqual([[], 3])
  })
  test('each job keeps its tier, and the companies search gets the next titles', async () => {
    const url = (i: number) => `https://job-boards.greenhouse.io/acme/jobs/${i}`
    const poll = { ok: true, boards: 1, sites: [], kept: 2, candidates: [
      { job_id: 'greenhouse-acme-1', title: 'Detection Engineer', company: 'Acme', url: url(1), tier: 'exact' },
      { job_id: 'greenhouse-acme-2', title: 'SOC Analyst', company: 'Acme', url: url(2), tier: 'maybe', hits: 4 },
    ] }
    const { app, calls, release } = makeApp(a => (a[0] === 'discover' ? poll : undefined))
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, paired_user_id: 42, onboarded: true, filters: { ...DEFAULT_SETTINGS.filters, titles: ['A', 'B', 'C', 'D'], related_titles: ['E'] } })
    writeJson(join(DATA, 'discovery.json'), {})
    await app.route({ chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } } as any, 'd:run', {})
    await wait(100)
    const tasks = [app.agent.live('work')?.task, ...app.agent.queued()].flatMap(t => (t ? [t] : []))
    expect(tasks.find(t => t.kind === 'discover')?.payload.titles).toEqual(['A', 'B', 'C'])
    expect(tasks.filter(t => t.kind === 'job').map(t => t.payload.tier)).toEqual([undefined, 'maybe'])
    expect(readJson<any>(join(DATA, 'discovery.json'), {}).title_cursor).toBe(3)
    await wait(2800) // cards are edited at most every 2.5 s
    const text = calls.map(c => c.payload.text ?? '').join('\n')
    expect(text).toContain('0 filtered out · 2 being prepared (1 with a different title)') // the sort could not run here: nothing is lost
    release()
    await app.stop()
  }, 10_000)
  test('"Look at it anyway" reads a filtered-out job in full, like a link the user sent', async () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/77'
    writeFileSync(join(DATA, 'screened.jsonl'), JSON.stringify({ at: new Date().toISOString(), job_id: 'greenhouse-acme-77', title: 'SOC Analyst', company: 'Acme', url, stage: 'triage', code: 'triage', reason: 'Sales role' }) + '\n')
    const { app, release } = makeApp()
    const toast: { text?: string } = {}
    expect(await app.route({ chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } } as any, `fo:look:${code('greenhouse-acme-77')}`, toast)).toBeUndefined()
    expect(toast.text).toContain('Reading it in full')
    const jobs = [app.agent.live('work')?.task, ...app.agent.queued()].flatMap(t => (t?.kind === 'job' ? [t] : []))
    expect(jobs.map(t => t.payload.url)).toEqual([url])
    expect(jobs[0].payload.source).toBeUndefined() // not a discovery job: no quick sort, no auto-search rules
    expect(await app.route({ chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } } as any, 'fo:look:0123abcd', {})).toBe('That job is no longer on the list.')
    rmSync(join(DATA, 'screened.jsonl'), { force: true })
    release()
    await app.stop()
  })
  test('the quick sort: 30 jobs take 2 calls, the 5 best are prepared, the low ones are filtered out', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ job_id: `greenhouse-acme-${i}`, title: `Engineer ${i}`, company: 'Acme', url: `https://job-boards.greenhouse.io/acme/jobs/${i}`, tier: 'exact' }))
    const input = join(DATA, 'run', 'llm', 'screen-x.in.json'), sorts: string[][] = []
    writeJson(input, { jobs: 'cards' })
    const { app, calls, release } = makeApp(a => {
      if (a[0] === 'discover') return { ok: true, boards: 1, sites: [], new: 30, kept: 30, dropped: { where: 4, title: 9 }, candidates }
      if (a[0] !== 'llm' || a[2] !== 'screen') return undefined
      const ids: string[] = JSON.parse(a[a.indexOf('--extra') + 1]).ids
      if (a[1] === 'input') return sorts.push(ids) && { ok: true, file: input }
      const scores = ids.map(id => ({ id, score: Number(id.split('-').pop()) * 3, reason: 'x' })) // job i scores 3i; the bar is 60 - 10
      return { ok: true, scores, bar: 50, filtered: scores.filter(s => s.score < 50).length }
    })
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, paired_user_id: 42, onboarded: true })
    writeJson(join(DATA, 'discovery.json'), { last_expand: Date.now() })
    await app.route({ chat: { id: 42 }, callbackQuery: { message: { message_id: 9 } } } as any, 'd:run', {})
    await wait(400)
    expect(sorts.map(s => s.length)).toEqual([25, 5])
    await wait(2800) // the job tasks run (and end) at once here, so the search card says which five it started
    const text = calls.map(c => c.payload.text ?? '').join('\n')
    expect(text).toContain('30 new jobs · 21 filtered out · 5 being prepared · 8 more next run')
    for (const i of [29, 28, 27, 26, 25]) expect(text).toContain(`Acme · Engineer ${i}`)
    expect(text).not.toContain('Acme · Engineer 24')
    release()
    await app.stop()
  }, 10_000)
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
