// Behaviour: question forms, the Claude task runner (with a fake `claude`), the local bridge, and the review gate.
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createAgent, promptFor, type Outcome, type Task } from '../src/agent'
import { startBridge } from '../src/bridge'
import * as F from '../src/forms'
import { code } from '../src/jobs'
import { autoGate, createReview, planRecovery } from '../src/review'
import { DATA, DEFAULT_SETTINGS, readJson, writeJson } from '../src/state'

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms))

describe('question forms', () => {
  const qs = F.validateQuestions([
    { qid: 'a', text: 'Sponsorship?', kind: 'yesno', sensitive: true, save_key: 'sponsorship_required', fid: 'question_1' },
    { qid: 'b', text: 'Tools?', kind: 'multi', options: ['SQL', 'dbt', 'Python'], save_key: 'tools' },
    { qid: 'c', text: 'Salary?', kind: 'number' },
  ], true)
  test('buttons, multi-select and typed answers, then confirm', () => {
    let f = F.newForm('job-1', 'job-1', 'Acme · Analyst', qs)
    expect(f.save).toEqual({ a: 'global', b: 'global', c: 'no' }) // sensitive starts saved; no save_key means nothing to save
    f = F.act(f, 'o:1').form // No
    f = F.act(f, 'm:0').form; f = F.act(f, 'm:2').form
    f = F.act(f, 'd').form
    expect(F.answerText(f, 'lots').error).toContain('number')
    f = F.answerText(f, '95k').form
    expect(f.confirming).toBe(true)
    expect(F.render(f).rows.flat().map(b => b.text)).toContain('✅ Looks good, send')
    const done = F.act(f, 'c')
    expect(done.event?.kind).toBe('answers')
    const ans = done.event?.kind === 'answers' ? done.event.answers : []
    expect(ans.map(x => x.value)).toEqual(['No', ['SQL', 'Python'], 95000])
    expect(ans[0].fid).toBe('question_1')
  })
  test('change an answer from the list, and skipping asks first', () => {
    let f = F.newForm('job-2', 'job-2', 'X', qs)
    f = F.act(f, 'o:0').form; f = F.act(f, 'm:0').form; f = F.act(f, 'd').form; f = F.answerText(f, '1').form
    f = F.act(f, 'p').form
    expect(F.render(f).text).toContain('Which answer')
    f = F.act(f, 'e:2').form
    expect(f.confirming).toBe(false)
    f = F.answerText(f, '120000').form
    expect(f.answers.c).toBe(120000)
    f = F.act(f, 'x').form
    expect(F.render(f).text).toContain('Skip this job?')
    expect(F.act(f, 's').event?.kind).toBe('skipped')
  })
  test('sensitive questions need a save key', () => {
    expect(() => F.validateQuestions([{ qid: 'a', text: 'Visa?', kind: 'yesno', sensitive: true }], true)).toThrow('save_key')
  })
})

describe('task runner', () => {
  beforeEach(() => rmSync(join(DATA, 'tasks.json'), { force: true }))
  writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)

  // A fake `claude -p`: plays back stream-json lines, then exits.
  function fakeClaude(lines: object[], code = 0) {
    const calls: string[][] = []
    const exec = (args: string[], _env: Record<string, string>, onLine: (l: string) => void) => {
      calls.push(args)
      const done = (async () => { for (const l of lines) { await wait(2); onLine(JSON.stringify(l)) } return { code, stderr: '' } })()
      return { pid: undefined, done }
    }
    return { exec, calls }
  }
  const tool = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

  test('streams plain-words activity, then reports done', async () => {
    const { exec, calls } = fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's1' },
      tool('Bash', { command: 'uv run --project agent jobagent fetch greenhouse-acme-1' }),
      tool('Write', { file_path: '/d/data/jobs/x/tailor_plan.json' }),
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 2000000000, unifiedWindows: { five_hour: { utilization: 0.3 } } } },
      { type: 'result', is_error: false, result: 'ok', permission_denials: [] },
    ])
    const doing: (string | null)[] = [], usage: number[] = []
    const finished: Outcome[] = []
    const a = createAgent({ bridge: () => ({ url: 'http://x', secret: 's' }), exec, onLive: (_l, live) => { if (live) doing.push(live.doing) }, onFinish: (_t, o) => { finished.push(o) }, onUsage: u => usage.push(u.five_hour!) })
    a.enqueue({ kind: 'job', title: 'x', payload: { url: 'https://job-boards.greenhouse.io/acme/jobs/1' } })
    for (let i = 0; i < 100 && !finished.length; i++) await wait()
    expect(doing).toContain('Downloading the posting')
    expect(doing).toContain('Rewording resume lines to match the job')
    expect(usage).toEqual([0.3])
    expect(finished[0].kind).toBe('done')
    expect(calls[0]).toContain('--permission-prompts')
    expect(calls[0][calls[0].indexOf('--permission-prompts') + 1]).toBe('none')
    expect(calls[0][calls[0].indexOf('--setting-sources') + 1]).toBe('project')
    expect(calls[0][calls[0].indexOf('--tools') + 1]).not.toContain('WebFetch')
  })

  test('a usage limit puts the task back in line until the limit resets', async () => {
    const resets = Math.floor(Date.now() / 1000) + 3600
    const { exec } = fakeClaude([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resets } }, { type: 'result', is_error: true, result: 'usage limit reached' }], 1)
    const finished: Outcome[] = []
    const a = createAgent({ bridge: () => ({ url: '', secret: '' }), exec, onLive: () => {}, onFinish: (_t, o) => { finished.push(o) }, onUsage: () => {} })
    a.enqueue({ kind: 'discover', title: 'Auto-search', payload: { reason: 'manual' } })
    for (let i = 0; i < 100 && !finished.length; i++) await wait()
    expect(finished[0].kind).toBe('limit')
    expect(finished[0].resets_at).toBe(resets * 1000)
    const q = a._queue()
    expect(q).toHaveLength(1)
    expect(q[0].not_before).toBeGreaterThan(resets * 1000)
    expect(readJson<any>(join(DATA, 'tasks.json'), {}).queue).toHaveLength(1) // survives a restart
  })

  test('a task that was running at shutdown resumes first, marked interrupted', () => {
    const t: Task = { id: 'aa', kind: 'job', title: 'x', payload: { url: 'u' }, created: 1, tries: 0 }
    writeJson(join(DATA, 'tasks.json'), { queue: [], running: [t] })
    const a = createAgent({ bridge: () => ({ url: '', secret: '' }), exec: fakeClaude([]).exec, onLive: () => {}, onFinish: () => {}, onUsage: () => {} })
    expect(a._queue()[0]).toMatchObject({ id: 'aa', interrupted: true })
    expect(promptFor(a._queue()[0])).toContain('interrupted')
  })

  test('the same job is never queued twice, and paused work waits while chat still answers', async () => {
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, agent_on: false })
    const { exec, calls } = fakeClaude([{ type: 'result', is_error: false, result: 'hi' }])
    const a = createAgent({ bridge: () => ({ url: '', secret: '' }), exec, onLive: () => {}, onFinish: () => {}, onUsage: () => {} })
    const one = a.enqueue({ kind: 'job', job_id: 'greenhouse-a-1', title: 'x', payload: { mode: 'retry' } })
    expect(a.enqueue({ kind: 'job', job_id: 'greenhouse-a-1', title: 'x', payload: { mode: 'retry' } }).existing).toBe(true)
    a.enqueue({ kind: 'chat', title: 'chat', payload: { text: 'hello' } })
    await wait(50)
    expect(calls).toHaveLength(1)
    expect(calls[0].join(' ')).toContain('hello')
    expect(a.cancel(t => t.id === one.task.id)).toBe(true)
    expect(a.queued()).toHaveLength(0)
    writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)
  })
})

describe('bridge', () => {
  test('only the app\'s own tasks can call tools', async () => {
    const got: string[] = []
    const b = startBridge(() => [{ name: 'tg_send', description: '', inputSchema: {} }], async (task, name) => { got.push(`${task}:${name}`); return { text: 'sent' } })
    expect((await fetch(`${b.url}/tools`)).status).toBe(403)
    expect((await fetch(`${b.url}/tools`, { headers: { 'x-jobbot-secret': 'wrong' } })).status).toBe(403)
    expect(await (await fetch(`${b.url}/tools`, { headers: { 'x-jobbot-secret': b.secret } })).json()).toHaveLength(1)
    const r = await fetch(`${b.url}/call`, { method: 'POST', headers: { 'x-jobbot-secret': b.secret }, body: JSON.stringify({ task: 't1', name: 'tg_send', args: {} }) })
    expect(await r.json()).toEqual({ text: 'sent' })
    expect(got).toEqual(['t1:tg_send'])
    b.stop()
  })
})

describe('review gate', () => {
  const ID = 'greenhouse-acme-1'
  const dir = join(DATA, 'jobs', ID)
  const rv = (o: Record<string, unknown> = {}): any => ({
    job_id: ID, plan_hash: 'h1', ats: 'greenhouse', company: 'Acme', role: 'Data Analyst', location: 'Remote', salary: '$95-120k', score: 90,
    reasons: ['SQL'], dealbreakers: [], answers: [{ fid: 'q', label: 'Q', value: 'A', source: 'profile', sensitive: false, required: true }],
    unusual: [], generated_sensitive: [], files: [], resume: { edits: 2, reorders: 0, fallback: false, verified: true }, screenshots: [], url: 'https://x', ...o,
  })
  function setup(status: string, hash = 'h1', submit: any = { ok: true, status: 'DRY_RUN_DONE' }) {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'review.json'), rv())
    writeJson(join(dir, 'status.json'), { status, updated_at: '', history: [] })
    const st = { status }
    const log = { submits: [] as string[], revised: [] as string[], results: [] as string[] }
    const run = async (a: string[]) => {
      if (a[0] === 'job' && a[1] === 'get') return { ok: true, status: st.status }
      if (a[0] === 'review' && a[1] === 'hash') return { ok: true, plan_hash: hash }
      if (a[0] === 'job' && a[1] === 'set-status') { st.status = a[3]; return { ok: true } }
      if (a[0] === 'submit') { log.submits.push(a[1]); return submit }
      return { ok: false }
    }
    const sent: string[] = []
    const api: any = { sendMessage: async (_c: number, t: string) => { sent.push(t); return { message_id: 1 } }, editMessageText: async () => ({}), sendDocument: async () => ({}), sendMediaGroup: async () => ({}) }
    const g = createReview({ api, to: () => 1, silent: () => false, refresh: () => {}, revise: id => log.revised.push(id), onResult: (_i, s) => log.results.push(s), setPending: () => {}, run })
    return { g, st, log, sent }
  }

  test('approve writes approval.json bound to the hash, then submits (practice: nothing sent)', async () => {
    writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)
    const { g, log, sent } = setup('AWAITING_APPROVAL')
    const page = await g.press('ok', code(ID), 1, 1)
    expect(typeof page === 'object' && page.text).toContain('Approved (practice)')
    expect(readJson<any>(join(dir, 'approval.json'), {}).plan_hash).toBe('h1')
    await wait(30)
    expect(log.submits).toEqual([ID])
    expect(log.results).toEqual(['DRY_RUN_DONE'])
    expect(sent.join('\n')).toContain('Practice run done')
  })

  test('if anything changed since the review, approve refuses and the review is rebuilt', async () => {
    const { g, log } = setup('AWAITING_APPROVAL', 'CHANGED')
    const r = await g.press('ok', code(ID), 1, 1)
    expect(r).toContain('rebuilding')
    expect(existsSync(join(dir, 'approval.json'))).toBe(false)
    expect(log.submits).toEqual([])
    expect(log.revised).toEqual([ID])
  })

  test('same-company spacing schedules the submit for later', async () => {
    const at = new Date(Date.now() + 3 * 3600_000).toISOString()
    const { g, sent } = setup('AWAITING_APPROVAL', 'h1', { ok: false, code: 'company_cooldown', next_allowed_at: at })
    await g.press('ok', code(ID), 1, 1)
    await wait(30)
    expect(readJson<any>(join(dir, 'approval.json'), {}).scheduled_for).toBe(at)
    expect(sent.join('\n')).toContain('sending later')
    for (const t of g._later.values()) clearTimeout(t)
  })

  test('auto-apply gates and startup recovery', () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    expect(autoGate(rv(), s)).toContain('review every')
    s.apply.mode = 'auto'
    expect(autoGate(rv(), s)).toBeNull()
    expect(autoGate(rv({ score: 70 }), s)).toContain('below')
    expect(autoGate(rv({ unusual: ['q9'] }), s)).toContain('unusual')
    expect(autoGate(rv({ generated_sensitive: ['q3'] }), s)).toContain('private')
    const now = Date.now()
    expect(planRecovery([
      { id: 'a', status: 'SUBMITTING', auto: false },
      { id: 'b', status: 'APPROVED', scheduled_for: new Date(now + 60_000).toISOString(), auto: false },
      { id: 'c', status: 'APPROVED', auto: false },
      { id: 'd', status: 'AWAITING_APPROVAL', auto: true },
    ], now).map(x => x.do)).toEqual(['needs_human', 'submit_at', 'submit_now', 'resend_review'])
  })
})

describe('upgrade: queue, index and local reads', () => {
  test('links the user sends run before auto-search jobs, which run before finding companies', async () => {
    rmSync(join(DATA, 'tasks.json'), { force: true })
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, agent_on: false }) // paused: nothing starts, we only look at the line
    const a = createAgent({ bridge: () => ({ url: 'http://x', secret: 's' }), onLive: () => {}, onFinish: () => {}, onUsage: () => {}, exec: () => ({ done: new Promise(() => {}) }) })
    a.enqueue({ kind: 'discover', title: 'companies', payload: { expand_boards: true } })
    a.enqueue({ kind: 'job', job_id: 'found-1', title: 'found', payload: { url: 'https://x/1', source: 'discovery', parent: 'search-1' } })
    a.enqueue({ kind: 'job', title: 'mine', payload: { url: 'https://x/2' } })
    expect(a.queued().map(t => t.title)).toEqual(['mine', 'found', 'companies'])
    expect(promptFor(a.queued()[1])).toContain('--source discovery')
    writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)
  })
  test('profile.md and boards.json are read without Python', () => {
    const { readAnswers, readSection, boardCount } = require('../src/profile') as typeof import('../src/profile')
    writeFileSync(join(DATA, 'profile.md'), '# Profile\n\n## Contact\n- full_name: Jane Doe\n- email: jane@example.com\n\n## Saved answers\n<!-- x -->\n### work_auth_us\n- question: Authorized?\\nIn the US\n- answer: Yes\n- sensitive: true\n- scope: global\n- updated: 2026-11-01\n### acme-1__why\n- question: Why?\n- answer: Because\n- sensitive: false\n- scope: job\n- source_job: acme-1\n')
    expect(readSection('Contact')).toEqual({ full_name: 'Jane Doe', email: 'jane@example.com' })
    const all = readAnswers()
    expect(all.map(x => x.key)).toEqual(['work_auth_us'])
    expect(all[0]).toMatchObject({ question: 'Authorized?\nIn the US', answer: 'Yes', sensitive: true, scope: 'global' })
    expect(readAnswers('acme-1').find(x => x.key === 'acme-1__why')?.base_key).toBe('why')
    writeJson(join(DATA, 'boards.json'), { greenhouse: ['a', 'b'], lever: ['c'] })
    expect(boardCount()).toBe(3)
  })
  test('a 1,000-job folder keeps Home fast after the first read', () => {
    const { allJobs, readJob } = require('../src/jobs') as typeof import('../src/jobs')
    for (let i = 0; i < 1000; i++) {
      const d = join(DATA, 'jobs', `perf-${i}`)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'status.json'), JSON.stringify({ status: 'SKIPPED', updated_at: '2026-11-01T00:00:00Z', history: [] })) // plain writes: setup speed only
      writeFileSync(join(d, 'meta.json'), '{"url":"https://x"}')
    }
    allJobs()
    const t0 = performance.now()
    expect(allJobs().length).toBeGreaterThanOrEqual(1000)
    expect(performance.now() - t0).toBeLessThan(300)
    writeJson(join(DATA, 'jobs', 'perf-1', 'status.json'), { status: 'SCORED', updated_at: '2026-11-02T00:00:00Z', history: [] })
    expect(readJob('perf-1')?.status).toBe('SCORED') // a change on disk is seen
    rmSync(join(DATA, 'jobs'), { recursive: true, force: true })
  }, 60_000) // creating 2,000 files is slow on Windows; the budget checked above is the second read only
})

describe('upgrade: dashboard', () => {
  test('needs the secret, rejects other hosts, masks private answers, and approves only the review it showed', async () => {
    const { startDashboard, jobJson, columnOf } = await import('../src/dashboard')
    const id = 'greenhouse-dash-1', d = join(DATA, 'jobs', id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'status.json'), JSON.stringify({ status: 'AWAITING_APPROVAL', updated_at: new Date().toISOString(), history: [] }))
    writeFileSync(join(d, 'review.json'), JSON.stringify({ plan_hash: 'h1', answers: [{ label: 'Salary', value: '150000', sensitive: true }, { label: 'Name', value: 'Jane', sensitive: false }] }))
    const calls: string[] = []
    const dash = startDashboard({ botToken: TOKEN, pairedId: () => 42, approve: async (i, h) => { calls.push(`${i}:${h}`); return h === 'h1' ? null : 'changed' }, skip: async () => null, health: () => null }, 0)
    try {
      const base = `http://127.0.0.1:${dash.port}`
      expect((await fetch(`${base}/api/state`)).status).toBe(403) // no cookie
      expect((await fetch(`${base}/?k=${'0'.repeat(64)}`, { redirect: 'manual' })).status).toBe(403) // wrong secret
      const login = await fetch(dash.link, { redirect: 'manual' })
      expect(login.status).toBe(303)
      const cookie = login.headers.get('set-cookie')!.split(';')[0]
      expect((await fetch(`${base}/api/state`, { headers: { cookie, host: 'evil.example' } })).status).toBe(403) // DNS rebinding
      const st = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()
      expect(st.jobs.find((j: any) => j.id === id).column).toBe('Needs you')
      const j = jobJson(id)!
      expect(j.answers).toEqual([{ label: 'Salary', value: null, source: '', private: true }, { label: 'Name', value: 'Jane', source: '', private: false }])
      expect(JSON.stringify(j)).not.toContain('150000')
      const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/job/${id}/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
      expect((await post({ plan_hash: 'h1' }, { origin: 'https://evil.example' })).status).toBe(403) // cross-site
      expect((await post({ plan_hash: 'old' })).status).toBe(409)
      expect((await post({ plan_hash: 'h1' })).status).toBe(200)
      expect(calls).toEqual([`${id}:old`, `${id}:h1`])
      expect((await fetch(`${base}/api/job/${id}/img/x.png`, { headers: { cookie } })).status).toBe(404) // only known screenshots
      expect(columnOf({ status: 'SUBMITTED' } as any, 'interview')).toBe('Interview')
    } finally { dash.stop(); rmSync(d, { recursive: true, force: true }) }
  })
})

const TOKEN = '123456:test-token'
describe('upgrade: dashboard on the phone (Telegram Mini App)', () => {
  const { createHmac } = require('crypto') as typeof import('crypto')
  const sign = (fields: Record<string, string>, token = TOKEN) => {
    const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n')
    const key = createHmac('sha256', 'WebAppData').update(token).digest()
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', key).update(check).digest('hex') }).toString()
  }
  const now = Math.floor(Date.now() / 1000)
  test('only Telegram-signed, recent data for a real user passes', async () => {
    const { checkInitData } = await import('../src/dashboard')
    const good = sign({ auth_date: String(now), query_id: 'q', user: JSON.stringify({ id: 42, first_name: 'J' }) })
    expect(checkInitData(good, TOKEN)).toBe(42)
    expect(checkInitData(good, '999:other-bot')).toBeNull() // signed for another bot
    expect(checkInitData(good.replace('42', '43'), TOKEN)).toBeNull() // tampered
    expect(checkInitData(sign({ auth_date: String(now - 2 * 86400), user: '{"id":42}' }), TOKEN)).toBeNull() // too old
    expect(checkInitData('user=%7B%22id%22%3A42%7D', TOKEN)).toBeNull() // no hash
  })
  test('the tunnel address must be a plain https origin with a real name', async () => {
    const { setPhoneUrl, phoneUrl } = await import('../src/dashboard')
    for (const bad of ['http://x.trycloudflare.com', 'https://1.2.3.4', 'https://x.example.com/path', 'https://u:p@x.example.com', 'nonsense']) expect(setPhoneUrl(bad)).toBeNull()
    expect(setPhoneUrl('https://abc.trycloudflare.com/')).toBe('https://abc.trycloudflare.com')
    expect(phoneUrl()).toBe('https://abc.trycloudflare.com')
    expect(setPhoneUrl(null)).toBe('')
    expect(phoneUrl()).toBeNull()
  })
  test('through the tunnel: off means refused; on means Telegram sign-in for the paired user only, never the local secret', async () => {
    const { startDashboard, setPhoneUrl } = await import('../src/dashboard')
    let paired: number | null = 42
    const dash = startDashboard({ botToken: TOKEN, pairedId: () => paired, approve: async () => null, skip: async () => null, health: () => null }, 0)
    const base = `http://127.0.0.1:${dash.port}`, host = 'abc.trycloudflare.com'
    const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + path, { ...init, redirect: 'manual', headers: { host, ...(init.headers ?? {}) } })
    const auth = (init_data: string) => req('/api/tg-auth', { method: 'POST', headers: { 'content-type': 'application/json', origin: `https://${host}` }, body: JSON.stringify({ init_data }) })
    const signed = sign({ auth_date: String(now), user: JSON.stringify({ id: 42 }) })
    try {
      expect((await req('/')).status).toBe(403) // phone access off: the tunnel host is unknown
      setPhoneUrl(`https://${host}`)
      const page = await req('/')
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain('frame-ancestors https://web.telegram.org')
      expect((await req(dash.link.slice(base.length))).status).toBe(403) // the local secret link is refused remotely
      expect((await req('/api/state')).status).toBe(403)
      expect((await auth(sign({ auth_date: String(now), user: JSON.stringify({ id: 7 }) }))).status).toBe(403) // not the paired user
      expect((await req('/api/tg-auth', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ init_data: signed }) })).status).toBe(403)
      const ok = await auth(signed)
      expect(ok.status).toBe(200)
      const { token } = await ok.json()
      expect((await req('/api/state', { headers: { 'x-session': token } })).status).toBe(200)
      expect((await req('/api/state', { headers: { 'x-session': '0'.repeat(64) } })).status).toBe(403)
      paired = null
      expect((await auth(signed)).status).toBe(403) // unpaired: nobody signs in
    } finally { setPhoneUrl(null); dash.stop() }
  })
})
