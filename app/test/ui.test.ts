// Pure screens and helpers: wording, limits Telegram enforces, and settings that really exist.
import { describe, expect, test } from 'bun:test'
import { describe as act } from '../src/activity'
import { finalFor, renderCard, type Card } from '../src/cards'
import { code, parseCsv } from '../src/jobs'
import { ago, parseList, parseNumber, splitMsg, until, type Page } from '../src/kit'
import * as OB from '../src/onboarding'
import * as P from '../src/pages'
import * as ST from '../src/settings'
import { DEFAULT_SETTINGS, SETTINGS_FILE, SettingsSchema, getPath, inWindow, loadSettings, trySettingsUpdate, writeJson, type Settings } from '../src/state'

const S = (): Settings => structuredClone(DEFAULT_SETTINGS)
const datas = (p: Page) => p.rows.flat().filter(b => !b.url).map(b => b.data ?? 'noop')
const fits = (p: Page) => { for (const d of datas(p)) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64); expect(p.text.length).toBeLessThan(4096) }
const setAt = (s: any, path: string[], v: unknown) => { let o = s; for (const k of path.slice(0, -1)) o = o[k]; o[path.at(-1)!] = v; return s }

describe('kit', () => {
  test('numbers and lists as people type them', () => {
    expect([parseNumber('95k'), parseNumber('$95,000'), parseNumber('1.2m'), parseNumber('lots')]).toEqual([95000, 95000, 1200000, null])
    expect(parseList('Data Analyst, BI analyst\ndata analyst;  ')).toEqual(['Data Analyst', 'BI analyst'])
  })
  test('long messages split on line breaks', () => {
    const parts = splitMsg(Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n'))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(p => p.length <= 4096 && !p.startsWith('\n'))).toBe(true)
  })
  test('relative times and quiet windows', () => {
    const now = Date.parse('2026-11-22T12:00:00Z')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(until(now + 130 * 60_000, now)).toBe('in 2 h 10 min')
    expect(inWindow(new Date(2026, 1, 1, 23, 30), '23:00', '07:00')).toBe(true)
    expect(inWindow(new Date(2026, 1, 1, 12, 0), '23:00', '07:00')).toBe(false)
  })
  test('csv with quotes and commas', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']])
  })
})

describe('activity lines', () => {
  test('tool calls become plain words', () => {
    expect(act('Bash', { command: 'uv run --project agent jobagent fill greenhouse-acme-1 --dry-run' })).toContain('Filling in the application')
    expect(act('Bash', { command: 'uv run --project agent jobagent tailor x --fallback' })).toBe('Using your original resume unchanged')
    expect(act('Write', { file_path: 'C:\\x\\data\\jobs\\a\\company.json' })).toBe('Writing down what I found about the company')
    expect(act('Read', { file_path: '/x/data/jobs/a/analysis.json' })).toBe('Reading the job analysis')
    expect(act('Bash', { command: 'uv run --project agent jobagent job set-status x READY' })).toBeNull()
    expect(act('mcp__jobbot__tg_send', {})).toBeNull()
  })
})

describe('settings catalog', () => {
  test('every setting points at a real field, and every choice it offers is valid', () => {
    const s = S()
    expect(SettingsSchema.safeParse(s).success).toBe(true)
    for (const spec of ST.SPECS) {
      expect(getPath(s, spec.path)).not.toBeUndefined()
      for (const [v] of spec.opts ?? []) expect(SettingsSchema.safeParse(setAt(structuredClone(s), spec.path, spec.t === 'multi' ? [v] : v)).success).toBe(true)
      for (const n of spec.presets ?? []) expect(SettingsSchema.safeParse(setAt(structuredClone(s), spec.path, n)).success).toBe(true)
    }
    expect(new Set(ST.SPECS.map(x => x.id)).size).toBe(ST.SPECS.length)
  })
  test('every settings screen fits Telegram limits', () => {
    const s = S()
    s.filters.titles = Array.from({ length: 30 }, (_, i) => `A very long job title number ${i}`)
    fits(ST.settingsRoot(s, 3))
    for (const k of Object.keys(ST.CATS)) fits(ST.categoryPage(k, s))
    for (const spec of ST.SPECS) { fits(ST.specPage(spec, s)); fits(ST.promptFor(spec, true)) }
    fits(ST.companiesPage(Array.from({ length: 50 }, (_, i) => `${'x'.repeat(57)}${i}`.slice(0, 60))))
    fits(ST.practicePage(s)); fits(ST.goLiveConfirm())
    const lp = ST.loginsPage(null, '✅ Logged in to LinkedIn.', { site: 'linkedin', n: 3 })
    fits(lp)
    expect(lp.rows[0][0]).toMatchObject({ text: '🔄 Retry 3 jobs that needed this login', data: 'L:rt:linkedin' })
    expect(ST.loginsPage(null, undefined, { site: 'linkedin', n: 0 }).rows[0][0].data).toBe('L:in:linkedin')
  })
  test('settings files from before related titles still load, and the list is capped', () => {
    writeJson(SETTINGS_FILE, { version: 2, filters: { titles: ['X'] }, discovery: { enabled: true } })
    const s = loadSettings()
    expect([s.filters.related_titles, s.discovery.related_jobs]).toEqual([[], 'few'])
    expect(SettingsSchema.safeParse(s).success).toBe(true)
    expect(SettingsSchema.safeParse({ ...s, filters: { ...s.filters, related_titles: Array.from({ length: 16 }, (_, i) => `T${i}`) } }).success).toBe(false)
  })
  test('related titles: ideas seen in searches, offered with one tap', () => {
    const s = S(); s.filters.titles = ['Detection Engineer']; s.filters.related_titles = ['SOC Analyst']
    const now = Date.parse('2026-11-22T12:00:00Z'), at = (days: number) => new Date(now - days * 86_400_000).toISOString()
    const seen: ST.SeenTitles = {
      'soc analyst': { t: 'SOC Analyst', n: 5, last: at(1) }, 'threat hunter': { t: 'Threat Hunter', n: 2, last: at(2) },
      'security architect': { t: 'Security Architect', n: 9, last: at(20) }, 'siem engineer': { t: 'SIEM Engineer', n: 1, last: at(1) },
      'appsec engineer': { t: 'AppSec Engineer', n: 3, last: at(0) },
    }
    expect(ST.relatedIdeas(seen, s, now)).toEqual(['AppSec Engineer', 'Threat Hunter']) // twice lately, not listed yet, most seen first
    const page = ST.specPage(ST.specById('rt')!, s, undefined, Array.from({ length: 6 }, (_, i) => `A very long related job title number ${i}`))
    fits(page)
    expect(datas(page)).toContain('s:rt:g:5')
    expect(page.text).toContain('Seen often in your searches')
    fits(ST.companiesPage(['acme', 'beta'], undefined, 2))
    expect(ST.companiesPage(['acme'], undefined, 1).text).toContain('+1 found from your searches')
    const agg = ST.companiesPage(['acme', 'jobgether'])
    expect(agg.text).toContain("jobgether ⚠️ <i>reposts other companies' jobs</i>")
    expect(datas(agg)).toContain('C:r:jobgether') // a Remove button: never removed silently
    expect(ST.companiesPage(['acme']).text).not.toContain('reposts')
  })
  test('autopilot: one choice at the end of setup and in How I apply, writing exactly its settings', () => {
    const s = { ...S(), onboarded: true, filters: { ...S().filters, titles: ['Data Analyst'] } }
    const done = OB.obPage({ step: 'done', picks: [], locs: [] }, s)
    fits(done)
    expect(datas(done)).toEqual(expect.arrayContaining(['o:ap:on', 'o:ap:off', 'm:home']))
    expect(done.text).toContain('Nothing is sent until you approve')
    const apply = ST.categoryPage('apply', s)
    fits(apply)
    expect(datas(apply).slice(0, 2)).toEqual(['ap:on', 'ap:off'])
    expect(apply.text).toContain('Practice mode stays on')
    const flat = (o: any, p = ''): Record<string, string> => Object.assign({}, ...Object.entries(o).map(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : { [`${p}${k}`]: JSON.stringify(v) }))
    const changed = (a: any, b: any) => Object.keys(flat(b)).filter(k => flat(a)[k] !== flat(b)[k]).sort()
    writeJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS, discovery: { ...DEFAULT_SETTINGS.discovery, enabled: false } })
    const before = loadSettings()
    expect(trySettingsUpdate(ST.AUTOPILOT.on).ok).toBe(true)
    const on = loadSettings()
    expect(changed(before, on)).toEqual(['apply.mode', 'discovery.enabled', 'notify.digest'])
    expect(ST.autopilotOn(on) && on.dry_run).toBe(true) // practice mode untouched
    expect(OB.obPage({ step: 'done', picks: [], locs: [] }, on).text).toContain('Strong matches go out after a short countdown')
    expect(trySettingsUpdate(ST.AUTOPILOT.off).ok).toBe(true)
    expect(changed(on, loadSettings())).toEqual(['apply.mode', 'notify.digest']) // auto-search stays as it was
    expect(ST.autopilotOn(loadSettings())).toBe(false)
    writeJson(SETTINGS_FILE, DEFAULT_SETTINGS)
  })
  test('filtered out: reasons grouped, the 10 newest, and a way to look at one anyway', () => {
    const now = Date.parse('2026-11-25T15:00:00Z'), at = (h: number) => new Date(now - h * 3600_000).toISOString()
    const row = (i: number, c: string, h = 1) => ({ at: at(h), job_id: `greenhouse-acme-${i}`, title: `Engineer <${i}> ${'x'.repeat(80)}`, company: 'Acme & Co',
      url: `https://x.test/${i}`, stage: c === 'triage' ? 'triage' as const : 'rules' as const, code: c, reason: `Reason ${i} ${'y'.repeat(120)}` })
    const rows = [...Array.from({ length: 30 }, (_, i) => row(i, 'where', 50)), ...Array.from({ length: 8 }, (_, i) => row(30 + i, i % 2 ? 'pay' : 'triage'))]
    const p = P.filteredPage(rows, 'United States', now)
    fits(p)
    expect(p.text).toContain('• <b>30</b> · Not open to people in United States')
    expect(p.text).toContain('Acme &amp; Co · Engineer &lt;37&gt;') // third-party titles are escaped
    expect(datas(p).filter(d => d.startsWith('fo:look:'))).toHaveLength(10)
    expect(datas(p)).toContain(`fo:look:${code('greenhouse-acme-37')}`)
    expect(P.filteredPage([], 'United States', now).text).toContain('Nothing yet')
    expect(P.filteredLine(rows, 'United States', now)).toBe('🔎 <b>Filtered out today:</b> 8') // 4 triage, 4 pay: no reason is most
    expect(P.filteredLine([...rows, row(40, 'pay'), row(41, 'pay')], '', now)).toBe('🔎 <b>Filtered out today:</b> 10, most pay below your minimum')
    expect(P.filteredLine(rows.slice(0, 30), 'United States', now)).toBeNull() // nothing today
    const home = P.home({ s: { ...S(), onboarded: true }, queued: 0, jobs: [], forms: [], filtered: P.filteredLine(rows, '', now) }, now)
    expect(home.text).toContain('Filtered out today:</b> 8')
    expect(home.rows.flat().map(b => b.data)).toContain('fo:list')
    const held = P.home({ s: { ...S(), onboarded: true }, queued: 0, jobs: [], forms: [], hold: true }, now)
    fits(held)
    expect(held.text).toContain('Auto-apply is on hold')
    expect(datas(held)).toContain('ap:resume')
    expect(datas(P.home({ s: { ...S(), onboarded: true }, queued: 0, jobs: [], forms: [] }, now))).not.toContain('ap:resume')
  })
  test('board links and names', () => {
    expect(ST.boardSlug('https://job-boards.greenhouse.io/acme/jobs/123')).toBe('acme')
    expect(ST.boardSlug('https://boards.greenhouse.io/embed/job_board?for=Beta')).toBe('beta')
    expect(ST.boardSlug('https://jobs.lever.co/Plaid/2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f')).toBe('plaid')
    expect(ST.boardSlug('https://jobs.ashbyhq.com/notion')).toBe('notion')
    expect(ST.boardSlug('stripe')).toBe('stripe')
    expect(ST.boardSlug('not a board!')).toBeNull()
  })
})

describe('setup wizard', () => {
  test('every step renders within limits', () => {
    const steps: OB.ObStep[] = ['welcome', 'resume', 'reading', 'profile', 'fix', 'titles', 'level', 'locations', 'remote', 'salary', 'auth', 'sponsor', 'start', 'relocate', 'eeo', 'eeo_gender', 'eeo_race', 'eeo_veteran', 'eeo_disability', 'done']
    const summary: OB.Summary = { name: 'Jane', headline: 'Data Analyst at Acme', years: 4, level: 'mid', location: 'Austin, TX', country: 'United States', email: 'j@x', phone: '1', skills: ['SQL'], suggested_titles: ['Data Analyst', 'BI Analyst'] }
    for (const step of steps) fits(OB.obPage({ step, picks: ['Data Analyst'], locs: [], summary }, S()))
    const rel = Array.from({ length: 8 }, (_, i) => `A long related title from the resume ${i}`)
    const p = OB.obPage({ step: 'titles', picks: ['Data Analyst'], locs: [], rel: [rel[1]], summary: { ...summary, related_titles: [...rel, 'BI Analyst'] } }, S())
    fits(p)
    expect(datas(p).filter(d => d.startsWith('o:rt:'))).toEqual(['o:rt:0', 'o:rt:1', 'o:rt:2', 'o:rt:3', 'o:rt:4', 'o:rt:5']) // at most 6, none repeating a title above
    expect(p.text).toContain('Related titles')
  })
  test('work authorization keys are reusable save keys', () => {
    expect(OB.keyFor('United States')).toBe('work_auth_united_states')
    expect(/^[a-z0-9_]{1,40}$/.test(OB.keyFor('Bosnia and Herzegovina, really long name'))).toBe(true)
  })
})

describe('screens', () => {
  const job = (id: string, status: string): any => ({
    id, status, updated_at: '2026-11-22T10:00:00Z',
    history: [{ status: 'NEW', at: new Date().toISOString(), detail: '' }, { status, at: new Date().toISOString(), detail: 'Pay below your minimum' }],
    url: 'https://job-boards.greenhouse.io/acme/jobs/1', source: 'manual', company: 'Acme', role: 'Data Analyst', location: 'Remote', salary: '$100k', score: 82, reasons: ['SQL'], dealbreakers: [], breakdown: {}, must_haves: [],
  })
  test('home says what is happening and what needs you', () => {
    const s = S()
    const jobs = [job('a', 'AWAITING_APPROVAL'), job('b', 'NEEDS_HUMAN'), job('c', 'SKIPPED')]
    const live = { task: { id: 't', kind: 'job' as const, title: 'Acme · Data Analyst', payload: {}, created: 0, tries: 0 }, started: Date.now() - 65_000, doing: 'Tailoring your resume', steps: 4 }
    expect(P.home({ s, jobs, forms: [], queued: 2, work: live }).text).toContain("Setup isn't finished") // mid-setup: no "send me a link" yet
    s.onboarded = true
    const p = P.home({ s, jobs, forms: [], queued: 2, work: live, workTitle: 'Acme · Data Analyst', usage: { five_hour: 0.4, at: 0 } })
    expect(p.text).toContain('Working on:')
    expect(p.text).toContain('Tailoring your resume')
    expect(p.text).toContain('+ 2 more tasks waiting')
    expect(p.text).toContain('1 review · 1 problem')
    expect(p.text).toContain('Practice mode')
    expect(p.text).toContain('40%')
    fits(p)
    expect(P.statusBar({ s, jobs, forms: [], queued: 0 })).toContain('2 things need you')
    expect(P.home({ s: { ...s, agent_on: false }, jobs: [], forms: [], queued: 3 }).text).toContain('Paused')
  })
  test('jobs, job detail, needs-you and help fit', () => {
    const jobs = Array.from({ length: 20 }, (_, i) => job(`j-${i}`, ['AWAITING_APPROVAL', 'SUBMITTED', 'SKIPPED', 'NEEDS_HUMAN'][i % 4]))
    for (const t of ['a', 'd', 's']) fits(P.jobsPage(jobs, t, 1))
    for (const j of jobs.slice(0, 4)) fits(P.jobPage(j, { running: false, hasForm: true }))
    fits(P.needsPage({ jobs, forms: [] }))
    fits(P.helpPage())
    for (const t of ['how', 'practice', 'auto', 'approve', 'privacy', 'stop', 'trouble']) fits(P.helpPage(t))
  })
})

describe('cards', () => {
  const base = (o: Partial<Card> = {}): Card => ({
    key: 't1', mode: 'job', icon: '🏢', title: 'New job', state: 'running', started: Date.now() - 5000,
    jobs: [{ job_id: 'j1', title: 'Acme · Data Analyst', url: 'https://x.test/1', stage: 'tailor', details: { score: '82/100' } }], ...o,
  })
  test('a running job shows the stepper, the current action and Stop', () => {
    const p = renderCard({ ...base(), doing: 'Rewording resume lines to match the job' })
    expect(p.text).toContain('✅ Match score · <b>82/100</b>')
    expect(p.text).toContain('⏳ <b>Tailoring your resume</b>')
    expect(p.text).toContain('▫️ <i>Fill in the application</i>')
    expect(p.text).toContain('Rewording resume lines')
    expect(datas(p)).toContain('x:t1')
  })
  test('ended cards say how it ended; waiting cards say when they resume', () => {
    const fin = finalFor('SKIPPED', 'Pay below your minimum', 'j1')!
    const p = renderCard(base({ state: 'ended', ended: Date.now(), jobs: [{ ...base().jobs[0], final: fin }], final: fin }))
    expect(p.text).toContain('Skipped: Pay below your minimum')
    expect(p.rows.flat().some(b => b.text.includes('Apply anyway'))).toBe(true)
    expect(datas(p)).not.toContain('x:t1')
    expect(renderCard(base({ state: 'waiting', wait_until: Date.now() + 3600_000 })).text).toContain('usage limit')
    expect(renderCard(base({ state: 'queued', position: 3 })).text).toContain('#3')
  })
  test('a job that needs a job-site login offers the log-in button', () => {
    const fin = finalFor('FAILED', 'LinkedIn only shows this posting to people who are logged in. Log in under Settings, Job site logins, then tap Try again.', 'j1')!
    expect(fin.buttons?.map(b => b.data)).toEqual(['L:in:linkedin', `j:rt:${code('j1')}`])
    expect(finalFor('FAILED', 'Indeed only shows this posting to people who are logged in.', 'j1')!.buttons?.[0].data).toBe('L:in:indeed')
    expect(finalFor('FAILED', "I couldn't download the posting.", 'j1')!.buttons?.map(b => b.data)).toEqual([`j:rt:${code('j1')}`])
  })
  test('an auto-search card lists each job on one line', () => {
    const p = renderCard({
      key: 'd', mode: 'multi', icon: '🔭', title: 'Auto-search', state: 'running', note: 'Checked 4 companies',
      jobs: [{ job_id: 'a', title: 'A · X', details: {}, final: finalFor('AWAITING_APPROVAL', '', 'a') }, { job_id: 'b', title: 'B · Y', details: {}, stage: 'read' }],
    })
    expect(p.text).toContain('Ready for your review')
    expect(p.text).toContain('Reading the posting')
    expect(p.text).toContain('Checked 4 companies')
  })
  test('ended cards: two buttons a row, the posting on its own, and a way to the stuck jobs of a search', () => {
    const fin = { ...finalFor('FAILED', 'LinkedIn only shows this posting to people who are logged in.', 'j1')! }
    const one = renderCard(base({ state: 'ended', ended: Date.now(), jobs: [{ ...base().jobs[0], final: fin }], final: fin }))
    expect(one.rows.every(r => r.length <= 2)).toBe(true)
    expect(one.rows.at(-1)).toEqual([{ text: '🔗 Open posting', url: 'https://x.test/1' }])
    const multi = renderCard({ key: 'd', mode: 'multi', icon: '🔭', title: 'Auto-search', state: 'ended', final: { emoji: '✅', text: 'Done.' },
      jobs: [{ job_id: 'a', title: 'A', details: {}, final: fin }, { job_id: 'b', title: 'B', details: {}, final: finalFor('AWAITING_APPROVAL', '', 'b') }] })
    expect(multi.rows.flat().find(b => b.data === 'N:0')?.text).toBe('🙋 See the 1 that needs you')
    expect(datas(renderCard(base({ state: 'paused' })))).toContain('H:resume')
  })
})

describe('upgrade: screens', () => {
  const { SCREENS, JOBS, REVIEW } = require('../dev/preview') as typeof import('../dev/preview')
  test('every preview screen fits Telegram', () => { for (const [, p] of SCREENS) fits(p) })
  test('wording is reviewed on purpose (snapshots)', () => { for (const [name, p] of SCREENS.filter(([n]) => !/Home|card/i.test(n))) expect(p.text).toMatchSnapshot(name) })
  test('Home leads with the one thing worth doing', () => {
    const c = (jobs: typeof JOBS, s = { ...S(), onboarded: true }) => ({ s, queued: 0, jobs, forms: [] }) as P.HomeCtx
    expect(P.nextAction({ ...c(JOBS), s: S() }).data).toBe('o:resume')
    expect(P.nextAction(c(JOBS)).text).toBe('🔔 Review your application')
    expect(P.nextAction(c(JOBS.filter(j => j.status === 'KIT_READY'))).data).toMatch(/^j:kit:/)
    expect(P.nextAction(c([])).data).toBe('s:ae')
    const home = P.home(c(JOBS))
    expect(home.rows[0][0].text).toBe('🔔 Review your application')
    expect(new Set(datas(home)).size).toBe(datas(home).length) // nothing twice
  })
  test('the review card shows resume changes and offers quick edits', () => {
    const { reviewPage, editValue } = require('../src/review') as typeof import('../src/review')
    const p = reviewPage(REVIEW, true)
    expect(p.text).toContain('<s>Ran weekly reports for sales</s>')
    expect(p.text).toContain('Cover letter')
    expect(datas(p)).toContain(`r:ea:${datas(p)[0].slice(5)}`)
    expect(editValue({ action: 'check', value: true }, [], 'no')).toBe(false)
    expect(editValue({ action: 'select', value: 'Yes' }, ['Yes', 'No'], 'no')).toBe('No')
    expect(editValue({ action: 'select', value: 'Yes' }, ['Yes', 'No'], 'maybe')).toEqual({ error: 'Please send one of: Yes · No' })
    expect(editValue({ action: 'fill', value: 'x' }, [], '  ')).toEqual({ error: 'Send the new answer as a message.' })
  })
  test('a kit answer can carry markup only as text', () => {
    const { kitPage } = require('../src/applykit') as typeof import('../src/applykit')
    const p = kitPage(JOBS[1], { answers: [{ question: 'Why <b>us</b>?', answer: 'Because & so' }], files: [] })
    expect(p.text).toContain('Why &lt;b&gt;us&lt;/b&gt;?')
    expect(p.text).toContain('<code>Because &amp; so</code>')
    fits(p)
  })
  test('statuses for forms I cannot fill', () => {
    expect(finalFor('KIT_READY', '', 'x')?.buttons?.[0].data).toMatch(/^j:ap:/)
    expect(finalFor('APPLIED_SELF', '', 'x')?.text).toBe('You applied.')
  })
  test('where auto-search looked, in words', () => {
    const { whereText } = require('../src/app') as typeof import('../src/app')
    expect(whereText(12, ['LinkedIn', 'Indeed'])).toBe('12 companies, LinkedIn and Indeed')
    expect(whereText(0, ['LinkedIn'])).toBe('LinkedIn')
    expect(whereText(1, [])).toBe('1 company')
  })
  test('the country setting accepts every offered country and "not set"', () => {
    expect(SettingsSchema.safeParse({ ...S(), filters: { ...S().filters, country: 'Germany' } }).success).toBe(true)
  })
})

describe('upgrade: time expectations', () => {
  test('typical time needs 3 samples per stage, then uses medians', () => {
    const { typicalMs } = require('../src/cards') as typeof import('../src/cards')
    expect(typicalMs({ read: [1, 2], score: [1, 1, 1], tailor: [1, 1, 1], fill: [1, 1, 1] })).toBeNull()
    expect(typicalMs({ read: [60_000, 10, 120_000], score: [1000, 1000, 1000], tailor: [60_000, 60_000, 60_000], fill: [0, 0, 0] })).toBe(121_000)
  })
  test('a running job card shows a bar and the usual time', () => {
    const c: Card = { key: 'k', mode: 'job', icon: '🏢', title: 'Acme · Analyst', state: 'running', started: Date.now() - 60_000, typical_ms: 4 * 60_000, jobs: [{ job_id: 'a', title: 'Acme · Analyst', stage: 'tailor', details: {} }] }
    const t = renderCard(c).text
    expect(t).toContain('usually about 4 min')
    expect(t).toContain('▰▰▰▰▱▱▱▱')
  })
})

describe('upgrade: digest, receipts and health', () => {
  const { JOBS } = require('../dev/preview') as typeof import('../dev/preview')
  test('one digest per search, best match first, nothing when nothing was prepared', () => {
    const p = P.digestPage(JOBS)!
    expect(p.text).toContain('Auto-search found 2 good matches')
    expect(datas(p)).toContain('Q:0')
    fits(p)
    expect(P.digestPage(JOBS.filter(j => j.status === 'SKIPPED'))).toBeNull()
    expect(P.reviewQueue([{ ...JOBS[0], id: 'b', score: 60 }, JOBS[0]]).map(j => j.score)).toEqual([86, 60])
  })
  test('receipts never show answers, and say when it was practice', () => {
    const p = P.receiptPage(JOBS[3], { at: '2026-11-20T10:00:00Z', url: 'https://x', plan_hash: 'abcdef1234567890', practice: true, files: ['resume.pdf'], answers: 9 })
    expect(p.text).toContain('Practice receipt')
    expect(p.text).toContain('abcdef123456')
    fits(p)
  })
  test('health problems in plain words; the Word converter matters only for a .docx resume', () => {
    const checks = [{ name: 'claude login', ok: false, detail: 'x', required: true }, { name: 'docx->pdf converter', ok: false, detail: 'x', required: false }, { name: 'bun', ok: true, detail: '1', required: true }]
    expect(P.problemsFrom(checks, false)).toHaveLength(1)
    expect(P.problemsFrom(checks, true)).toHaveLength(2)
    const home = P.home({ s: { ...S(), onboarded: true }, queued: 0, jobs: [], forms: [], problems: P.problemsFrom(checks, false) })
    expect(home.text).toContain('Claude is not logged in')
    expect(datas(home)).toContain('m:health')
    fits(P.healthPage(checks, Date.now()))
  })
})

describe('upgrade: chat shortcuts', () => {
  test('everyday questions are answered without Claude; the rest goes to Claude', () => {
    expect(P.intentOf("What's waiting for me?")).toBe('needs')
    expect(P.intentOf('show my jobs')).toBe('jobs')
    expect(P.intentOf('Pause')).toBe('pause')
    expect(P.intentOf('status')).toBe('home')
    expect(P.intentOf('snooze for an hour')).toBe('snooze')
    expect(P.intentOf('raise my minimum salary to 120k')).toBeNull()
    expect(P.intentOf('pause the search for contract jobs and tell me why you skipped Acme')).toBeNull()
  })
})

describe('upgrade: follow-ups', () => {
  test('ask once about sent applications with no news; never about practice runs', () => {
    const { JOBS } = require('../dev/preview') as typeof import('../dev/preview')
    const now = Date.now()
    const sent = { ...JOBS[3], history: [{ status: 'SUBMITTED', at: new Date(now - 9 * 86_400_000).toISOString(), detail: '' }] }
    const practice = { ...sent, id: 'p', status: 'DRY_RUN_DONE' }
    expect(P.followUpsDue([sent, practice], {}, {}, 7, now).map(j => j.id)).toEqual([sent.id])
    expect(P.followUpsDue([sent], { [sent.id]: 'interview' }, {}, 7, now)).toEqual([])
    expect(P.followUpsDue([sent], {}, { [sent.id]: { asked: 'x' } }, 7, now)).toEqual([])
    expect(P.followUpsDue([sent], {}, {}, 0, now)).toEqual([])
    fits(P.followUpPage(sent, 7))
  })
  test('Interview and Offer tabs come from outcomes', () => {
    const { JOBS } = require('../dev/preview') as typeof import('../dev/preview')
    const p = P.jobsPage(JOBS, 'i', 0, { [JOBS[3].id]: 'interview' })
    expect(p.text).toContain('Umbrella')
    fits(p)
  })
})

describe('upgrade: insights', () => {
  test('funnel, and a suggestion only when the data supports it', () => {
    const I = require('../src/insights') as typeof import('../src/insights')
    const { JOBS } = require('../dev/preview') as typeof import('../dev/preview')
    const mk = (i: number, score: number) => ({ ...JOBS[3], id: `j${i}`, score, status: 'SUBMITTED', history: [{ status: 'NEW', at: new Date().toISOString(), detail: '' }, { status: 'SUBMITTED', at: new Date().toISOString(), detail: '' }] })
    const jobs = [...[0, 1, 2, 3, 4, 5].map(i => mk(i, 65)), ...[6, 7, 8, 9].map(i => mk(i, 85))]
    const out: Record<string, string> = Object.fromEntries(jobs.map(j => [j.id, j.score! >= 80 && j.id !== 'j9' ? 'interview' : 'rejected']))
    expect(I.funnel(jobs, out)).toMatchObject({ applied: 10, interview: 3, replied: 10 })
    expect(I.suggestion(jobs, out, 60)?.btn?.data).toBe('s:ms')
    expect(I.suggestion(jobs.slice(0, 5), out, 60)).toBeNull() // too little data
    const p = I.insightsPage(jobs, out, 60)
    expect(p.text).toContain('💡')
    fits(p)
  })
})

describe('upgrade: score breakdown and learning from decisions', () => {
  const I = require('../src/insights') as typeof import('../src/insights')
  const J = require('../src/jobs') as typeof import('../src/jobs')
  test('breakdown and must-haves are clamped, filtered and shown escaped', () => {
    expect(J.breakdownOf({ breakdown: { title: 140, skills: 61.6, pay: 'x' } })).toEqual({ title: 100, skills: 62 })
    expect(J.mustHavesOf({ must_haves: [{ text: '<b>SQL</b>', status: 'met' }, { text: 'x', status: 'maybe' }, 'junk'] })).toEqual([{ text: '<b>SQL</b>', status: 'met' }])
    const { JOBS, REVIEW } = require('../dev/preview') as typeof import('../dev/preview')
    const p = P.jobPage({ ...JOBS[0], must_haves: [{ text: '<b>SQL</b>', status: 'met' }] }, { running: false, hasForm: true })
    expect(p.text).toContain('✅ &lt;b&gt;SQL&lt;/b&gt;')
    expect(p.text).toContain('Skills ▰')
    fits(p)
    expect((require('../src/review') as typeof import('../src/review')).reviewPage(REVIEW, true).text).toContain('❌ Tableau')
  })
  test('a minimum-score suggestion needs 15 decisions and a clear split', () => {
    const d = (decision: string, score: number) => ({ decision, score })
    const many = [...Array(8)].map((_, i) => d('approve', 72 + i)).concat([...Array(7)].map((_, i) => d('skip', 50 + i)))
    expect(I.scoreSuggestion(many, 60)).toMatchObject({ min: 70 })
    expect(I.scoreSuggestion(many.slice(0, 14), 60)).toBeNull()
    expect(I.scoreSuggestion(many, 70)).toBeNull() // already there
    expect(I.scoreSuggestion([...many, d('approve', 52)], 50)).toBeNull() // approved a low one: no clear split
  })
  test('the Home tip has a one-tap apply and a dismiss', () => {
    const home = P.home({ s: { ...S(), onboarded: true }, queued: 0, jobs: [], forms: [], tip: { min: 70, text: 'x' } })
    expect(datas(home)).toContain('sg:ms:70')
    expect(datas(home)).toContain('sg:no:70')
  })
})

describe('upgrade: keyword coverage', () => {
  test('the review shows before → after and offers "I have this" only when something is missing', () => {
    const { REVIEW } = require('../dev/preview') as typeof import('../dev/preview')
    const R = require('../src/review') as typeof import('../src/review')
    const p = R.reviewPage(REVIEW, true)
    expect(p.text).toContain('50% → <b>67%</b>')
    expect(datas(p).some(d => d.startsWith('r:hv:'))).toBe(true)
    expect(datas(R.reviewPage({ ...REVIEW, coverage: { before: 80, after: 100, missing: [] } }, true)).some(d => d.startsWith('r:hv:'))).toBe(false)
    fits(p)
  })
})

describe('upgrade: achievements', () => {
  test('list, add until the cap, remove by key, escaped', () => {
    const p = P.achievementsPage([['a1', 'Cut <b>report</b> time 40%'], ['a3', 'Led a team of 4']])
    expect(p.text).toContain('Cut &lt;b&gt;report&lt;/b&gt; time 40%')
    expect(datas(p)).toEqual(expect.arrayContaining(['p:ach:add', 'p:ach:rm:a1', 'p:ach:rm:a3']))
    expect(datas(P.achievementsPage([...Array(P.ACH_MAX)].map((_, i) => [`a${i + 1}`, 'x'] as [string, string])))).not.toContain('p:ach:add')
    fits(p)
    expect(datas(P.profilePage(S(), {}, [], null))).toContain('p:ach')
  })
})

describe('ATS rebuild and resume versions', () => {
  test('versions: list, add until the cap, remove by name; profile shows the count', () => {
    const p = P.versionsPage(['backend-focus', 'old-2021'])
    expect(p.text).toContain('Main resume')
    expect(datas(p)).toEqual(expect.arrayContaining(['p:rv:add', 'p:rv:rm:backend-focus', 'p:rv:rm:old-2021']))
    expect(datas(P.versionsPage([...Array(P.VERSIONS_MAX)].map((_, i) => `v${i}`)))).not.toContain('p:rv:add')
    fits(p)
    const prof = P.profilePage(S(), {}, [], 'base_resume.pdf', ['backend-focus'])
    expect(datas(prof)).toContain('p:rv')
    expect(prof.text).toContain('1 other version')
  })
  test('the review says the resume was rebuilt, from how many versions; ats is a valid setting and the default', () => {
    const { REVIEW } = require('../dev/preview') as typeof import('../dev/preview')
    const R = require('../src/review') as typeof import('../src/review')
    const t = R.reviewPage({ ...REVIEW, resume: { edits: 4, reorders: 0, fallback: false, verified: true, ats: true, versions_used: 2, versions_total: 3 } }, true).text
    expect(t).toContain('rebuilt for hiring software from 2 of your 3 versions, 4 lines reworded')
    expect(S().apply.tailoring).toBe('ats')
    expect(SettingsSchema.safeParse({ ...S(), apply: { ...S().apply, tailoring: 'ats' } }).success).toBe(true)
  })
})

describe('upgrade: notification settings', () => {
  test('each kind is loud or silent; only the weekly summary can be turned off', () => {
    expect(SettingsSchema.safeParse(S()).success).toBe(true)
    expect(SettingsSchema.safeParse({ ...S(), notify: { ...S().notify, weekly: 'off' } }).success).toBe(true)
    expect(SettingsSchema.safeParse({ ...S(), notify: { ...S().notify, reviews: 'off' } }).success).toBe(false)
    const ids = ST.SPECS.filter(x => x.path[0] === 'notify').map(x => x.path[1])
    expect(ids.sort()).toEqual(Object.keys(S().notify).sort()) // every kind has a setting
    fits(ST.categoryPage('quiet', S()))
  })
})

describe('upgrade: dashboard page in Telegram', () => {
  test('phone access adds a Mini App button; off shows setup', () => {
    const on = P.dashPage('http://127.0.0.1:4777/?k=x', 'https://abc.trycloudflare.com')
    expect(on.rows.flat().find(b => b.web_app)?.web_app).toBe('https://abc.trycloudflare.com')
    expect(datas(on)).toContain('m:dash:off')
    const off = P.dashPage('http://127.0.0.1:4777/?k=x', null)
    expect(off.rows.flat().some(b => b.web_app)).toBe(false)
    expect(datas(off)).toContain('m:dash:ph')
    fits(on); fits(P.phoneSetupPage(4777))
  })
})
