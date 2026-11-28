// Behaviour: question forms, the Claude task runner (with a fake `claude`), the local bridge, and the review gate.
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createAgent, promptFor, type Outcome, type Task } from '../src/agent'
import { startBridge } from '../src/bridge'
import * as F from '../src/forms'
import { code, readDecisions } from '../src/jobs'
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
    expect(F.render(f).rows.flat().map(b => b.text)).toContain('✅ Looks good, continue')
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
      tool('Write', { file_path: '/d/data/jobs/x/company.json' }),
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 2000000000, unifiedWindows: { five_hour: { utilization: 0.3 } } } },
      { type: 'result', is_error: false, result: 'ok', permission_denials: [] },
    ])
    const doing: (string | null)[] = [], usage: number[] = []
    const finished: Outcome[] = []
    const a = createAgent({ bridge: () => ({ url: 'http://x', secret: 's' }), exec, onLive: (_l, live) => { if (live) doing.push(live.doing) }, onFinish: (_t, o) => { finished.push(o) }, onUsage: u => usage.push(u.five_hour!) })
    a.enqueue({ kind: 'prep', job_id: 'greenhouse-acme-1', title: 'x', payload: {} })
    for (let i = 0; i < 100 && !finished.length; i++) await wait()
    expect(doing).toContain('Downloading the posting')
    expect(doing).toContain('Writing down what I found about the company')
    expect(usage).toEqual([0.3])
    expect(finished[0].kind).toBe('done')
    expect(calls[0]).toContain('--permission-prompts')
    expect(calls[0][calls[0].indexOf('--permission-prompts') + 1]).toBe('none')
    expect(calls[0][calls[0].indexOf('--setting-sources') + 1]).toBe('project')
    expect(calls[0][calls[0].indexOf('--tools') + 1]).not.toContain('WebFetch')
  })

  test('finding companies runs on Haiku; chat keeps the chosen model', async () => {
    const { exec, calls } = fakeClaude([{ type: 'result', is_error: false, result: 'ok' }])
    const finished: Outcome[] = []
    const a = createAgent({ bridge: () => ({ url: '', secret: '' }), exec, onLive: () => {}, onFinish: (_t, o) => { finished.push(o) }, onUsage: () => {} })
    a.enqueue({ kind: 'discover', title: 'companies', payload: {} })
    a.enqueue({ kind: 'chat', title: 'chat', payload: { text: 'hi' } })
    for (let i = 0; i < 100 && finished.length < 2; i++) await wait()
    const model = (kind: string) => { const c = calls.find(c => c[1].startsWith(`JobAgent task: ${kind}`))!; return c[c.indexOf('--model') + 1] }
    expect(model('discover')).toBe('haiku')
    expect(model('chat')).toBe(DEFAULT_SETTINGS.agent_model)
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
    const t: Task = { id: 'aa', kind: 'prep', job_id: 'greenhouse-a-1', title: 'x', payload: {}, created: 1, tries: 0 }
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

  test('after Skip, one tap says why, and it is stored for the feedback summary (v3 P2)', async () => {
    rmSync(join(DATA, 'feedback.jsonl'), { force: true })
    const { g } = setup('AWAITING_APPROVAL')
    const p = (await g.press('sk', code(ID), 1, 1)) as any
    expect(p.text).toContain('What was off?')
    expect(p.rows.flat().map((b: any) => b.data).slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5].map(i => `r:sk:${code(ID)}:${i}`))
    expect(p.rows.flat().every((b: any) => Buffer.byteLength(b.data) <= 64)).toBe(true)
    expect(((await g.press('sk', code(ID), 1, 1, '0')) as any).text).toContain('Noted: pay')
    expect(await g.press('sk', code(ID), 1, 1, '9')).toBeUndefined()
    const rows = readFileSync(join(DATA, 'feedback.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(r => [r.decision, r.reason])).toEqual([['skip', undefined], ['skip_reason', 'pay']])
    expect(readDecisions().find(r => r.job_id === ID)?.decision).toBe('skip') // the reason row doesn't hide the skip
  })

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

  test('two real sends in a row that fail put auto-apply on hold until Resume; a success in between resets the count', async () => {
    rmSync(join(DATA, 'autopilot.json'), { force: true })
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, dry_run: false })
    const fail = { ok: false, code: 'needs_human', error: 'The form asked something new' }
    const once = async (submit: any) => { const t = setup('AWAITING_APPROVAL', 'h1', submit); await t.g.press('ok', code(ID), 1, 1); await wait(30); return t }
    await once(fail)
    await once({ ok: true, status: 'SUBMITTED' })
    await once(fail)
    expect(readJson<any>(join(DATA, 'autopilot.json'), {}).hold ?? null).toBeNull() // fail, success, fail: not two in a row
    const t = await once({ ok: false, code: 'failed', error: 'x' })
    expect(readJson<any>(join(DATA, 'autopilot.json'), {}).hold?.why).toBe('2 applications in a row could not be sent')
    expect(t.sent.filter(x => x.includes('Auto-apply is on hold'))).toHaveLength(1)
    expect((await once(fail)).sent.join('\n')).not.toContain('Auto-apply is on hold') // already held: said once
    t.g.resumeAuto()
    expect(readJson<any>(join(DATA, 'autopilot.json'), {})).toMatchObject({ fails: 0, hold: null })
    writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)
    rmSync(join(DATA, 'autopilot.json'), { force: true })
  })

  test('the daily cap holds a job back and offers it again on a later day, through the same gate', async () => {
    rmSync(join(DATA, 'autopilot.json'), { force: true })
    writeJson(join(DATA, 'settings.json'), { ...DEFAULT_SETTINGS, dry_run: false, apply: { ...DEFAULT_SETTINGS.apply, mode: 'auto', daily_max: 1 } })
    const sentDir = join(DATA, 'jobs', 'greenhouse-sent-1')
    mkdirSync(sentDir, { recursive: true })
    writeJson(join(sentDir, 'status.json'), { status: 'SUBMITTED', updated_at: new Date().toISOString(), history: [{ status: 'SUBMITTED', at: new Date().toISOString(), detail: '' }] })
    const before = new Date(Date.now() - 3 * 86_400_000).toISOString(), older = [1, 2, 3].map(n => join(DATA, 'jobs', `greenhouse-old-${n}`))
    for (const o of older) { // three earlier real Greenhouse sends, so P3's "first 3 wait" is past and the cap is what holds it
      mkdirSync(o, { recursive: true })
      writeJson(join(o, 'meta.json'), { ats: 'greenhouse' })
      writeJson(join(o, 'status.json'), { status: 'SUBMITTED', updated_at: before, history: [{ status: 'SUBMITTED', at: before, detail: '' }] })
    }
    const t = setup('FILLED_DRY')
    expect(await t.g.send(ID, true)).toContain('review queue') // capped: waits in the queue, no countdown
    expect(readJson<any>(join(DATA, 'autopilot.json'), {}).deferred).toEqual([ID])
    expect(await t.g.retryDeferred()).toBe(0) // still the same day
    rmSync(sentDir, { recursive: true, force: true }) // tomorrow: nothing sent yet
    expect(await t.g.retryDeferred(Date.now() + 86_400_000)).toBe(1)
    expect(t.g._grace.has(ID)).toBe(true) // the countdown started: autoGate passed
    t.g.cancelAuto(ID)
    expect(readJson<any>(join(DATA, 'autopilot.json'), {}).deferred).toEqual([])
    for (const o of older) rmSync(o, { recursive: true, force: true })
    writeJson(join(DATA, 'settings.json'), DEFAULT_SETTINGS)
    rmSync(join(DATA, 'autopilot.json'), { force: true })
  })

  test('auto-apply gates and startup recovery', () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    expect(autoGate(rv(), s)).toContain('review every')
    s.apply.mode = 'auto'
    expect(autoGate(rv(), s)).toBeNull()
    expect(autoGate(rv({ score: 70 }), s)).toContain('below')
    expect(autoGate(rv({ unusual: ['q9'] }), s)).toContain('unusual')
    expect(autoGate(rv({ generated_sensitive: ['q3'] }), s)).toContain('private')
    expect(autoGate(rv(), s, { sent: 0, hold: true })).toContain('on hold')
    expect(autoGate(rv(), s, { sent: 10, hold: false })).toBeNull() // practice mode: nothing reaches an employer, so no cap
    const live = { ...s, dry_run: false }, real = { greenhouse: 3, lever: 0 }
    expect(autoGate(rv(), live, { sent: 9, hold: false, real })).toBeNull()
    expect(autoGate(rv(), live, { sent: 10, hold: false, real })).toBe("today's 10 are sent; the rest go tomorrow")
    expect(autoGate(rv({ score: 70 }), live, { sent: 10, hold: false, real })).toContain('below') // the cap is checked last
    // v3 P3: the first 3 real sends on each form type wait for the user; practice runs don't count and aren't held
    expect(autoGate(rv(), live, { sent: 0, hold: false, real: { greenhouse: 2 } })).toBe('the first 3 real applications on each form type always wait for you')
    expect(autoGate(rv({ ats: 'lever' }), live, { sent: 0, hold: false, real })).toContain('first 3 real')
    expect(autoGate(rv(), live, { sent: 0, hold: false })).toContain('first 3 real') // unknown counts: wait
    expect(autoGate(rv(), s, { sent: 0, hold: false, real: {} })).toBeNull()
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
    a.enqueue({ kind: 'job', job_id: 'found-1', title: 'found', payload: { url: 'https://x/1', source: 'discovery', parent: 'search-1', tier: 'maybe' } })
    a.enqueue({ kind: 'job', title: 'mine', payload: { url: 'https://x/2' } })
    expect(a.queued().map(t => t.title)).toEqual(['mine', 'found', 'companies'])
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
      expect(j.answers.map((a: { label: string; value: string | null; private: boolean }) => [a.label, a.value, a.private])).toEqual([['Salary', null, true], ['Name', 'Jane', false]])
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

  test('front end: library files from an allowlist, actions only signed in and never reads, files only the job\'s own', async () => {
    const { startDashboard, TAPS, pageButtons } = await import('../src/dashboard')
    const id = 'greenhouse-dash-2', d = join(DATA, 'jobs', id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'status.json'), JSON.stringify({ status: 'AWAITING_APPROVAL', updated_at: new Date().toISOString(), history: [] }))
    writeFileSync(join(d, 'review.json'), JSON.stringify({ plan_hash: 'h', files: ['resume.pdf'], answers: [] }))
    writeFileSync(join(d, 'resume.pdf'), '%PDF-1.4')
    writeFileSync(join(d, 'analysis.json'), '{}')
    const ops: string[] = []
    const dash = startDashboard({ botToken: TOKEN, pairedId: () => 42, approve: async () => null, skip: async () => null, health: () => null, call: async op => { ops.push(op); return { text: 'ok' } } }, 0)
    try {
      const base = `http://127.0.0.1:${dash.port}`
      const cookie = (await fetch(dash.link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]
      expect((await fetch(`${base}/vendor/three/build/three.module.js`)).status).toBe(200)
      for (const p of ['package.json', 'build/three.cjs', '..%2F..%2Fpackage.json']) expect((await fetch(`${base}/vendor/three/${p}`)).status).toBe(404)
      const act = (body: unknown, c = cookie) => fetch(`${base}/api/do`, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect((await act({ op: 'tap', data: 'H:pause' }, '')).status).toBe(403)
      expect((await act({ op: 'view:profile' })).status).toBe(400) // reads go through GET /api/view only
      expect((await act({ op: 'export' })).status).toBe(400)
      expect((await act({ op: 'tap', data: 'H:pause' })).status).toBe(200)
      expect(ops).toEqual(['tap'])
      const file = (n: string) => fetch(`${base}/api/job/${id}/file/${n}`, { headers: { cookie } })
      expect((await file('resume.pdf')).status).toBe(200)
      for (const n of ['analysis.json', '..%2F..%2Fsettings.json', '%E0%A4%A']) expect((await file(n)).status).toBe(404)
    } finally { dash.stop(); rmSync(d, { recursive: true, force: true }) }
    for (const ok of ['H:pause', 'r:sk:0123abcd', 'L:in:linkedin', 'x:job-abc', 'a:dd:0123abcd', 'fo:look:0123abcd']) expect(TAPS.test(ok)).toBe(true)
    for (const no of ['p:pair', 'r:ap:0123abcd', 'L:in:evil', 'H:pause ', 'm:settings', 'r:sk:0123abcd\n', 'fo:look:https://x.test']) expect(TAPS.test(no)).toBe(false)
    expect(pageButtons([{ text: 'a', data: 'r:rv:0123abcd' }, { text: 'b', data: 'p:pair' }, { text: 'c', data: 'j:rt:0123abcd' }, { text: 'd' }]).map(b => b.text)).toEqual(['a', 'c'])
  })

  test('a whole form sent from the page is checked like taps and replies, and keeps private answers not sent back', async () => {
    const F = await import('../src/forms')
    const f = F.newForm('b1', 'job-1', 't', F.validateQuestions([
      { qid: 'q1', text: 'Sponsorship?', kind: 'yesno', sensitive: true, save_key: 'sponsor' },
      { qid: 'q2', text: 'Tools', kind: 'multi', options: ['dbt', 'Spark'] },
      { qid: 'q3', text: 'Expected salary', kind: 'number' },
    ], true))
    expect(F.submitAll(f, { q1: 'No', q2: ['dbt'] }).error).toContain('Expected salary')
    expect(F.submitAll(f, { q1: 'Maybe', q2: ['dbt'], q3: '95k' }).error).toContain('Pick one')
    expect(F.submitAll(f, { q1: 'No', q2: ['dbt', 'Rust'], q3: '95k' }).error).toContain('Pick at least one')
    const ok = F.submitAll(f, { q1: 'No', q2: ['dbt', 'dbt'], q3: '95k' }, { q1: false })
    expect(ok.event?.kind).toBe('answers')
    expect(ok.event?.kind === 'answers' && ok.event.answers.map(a => [a.qid, a.value, a.save])).toEqual([['q1', 'No', 'no'], ['q2', ['dbt'], 'no'], ['q3', 95000, 'no']])
    const again = F.submitAll({ ...f, answers: { q1: 'Yes' } }, { q2: ['Spark'], q3: '100000' }) // q1 answered before, not sent back
    expect(again.event?.kind === 'answers' && again.event.answers[0].value).toBe('Yes')
    expect(F.submitAll(ok.form, {}).error).toContain('closed')
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
