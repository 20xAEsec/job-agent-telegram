// Pure screens and helpers: wording, limits Telegram enforces, and settings that really exist.
import { describe, expect, test } from 'bun:test'
import { describe as act } from '../src/activity'
import { finalFor, renderCard, type Card } from '../src/cards'
import { parseCsv } from '../src/jobs'
import { ago, parseList, parseNumber, splitMsg, until, type Page } from '../src/kit'
import * as OB from '../src/onboarding'
import * as P from '../src/pages'
import * as ST from '../src/settings'
import { DEFAULT_SETTINGS, SettingsSchema, getPath, inWindow, type Settings } from '../src/state'

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
    expect(act('Write', { file_path: 'C:\\x\\data\\jobs\\a\\tailor_plan.json' })).toBe('Rewording resume lines to match the job')
    expect(act('Write', { file_path: '/x/data/jobs/a/plan.json' })).toBe('Deciding what goes in each form field')
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
  })
  test('board links and names', () => {
    expect(ST.boardSlug('https://job-boards.greenhouse.io/acme/jobs/123')).toBe('acme')
    expect(ST.boardSlug('https://boards.greenhouse.io/embed/job_board?for=Beta')).toBe('beta')
    expect(ST.boardSlug('stripe')).toBe('stripe')
    expect(ST.boardSlug('not a board!')).toBeNull()
  })
})

describe('setup wizard', () => {
  test('every step renders within limits', () => {
    const steps: OB.ObStep[] = ['welcome', 'resume', 'reading', 'profile', 'fix', 'titles', 'level', 'locations', 'remote', 'salary', 'auth', 'sponsor', 'start', 'relocate', 'eeo', 'eeo_gender', 'eeo_race', 'eeo_veteran', 'eeo_disability', 'done']
    const summary: OB.Summary = { name: 'Jane', headline: 'Data Analyst at Acme', years: 4, level: 'mid', location: 'Austin, TX', country: 'United States', email: 'j@x', phone: '1', skills: ['SQL'], suggested_titles: ['Data Analyst', 'BI Analyst'] }
    for (const step of steps) fits(OB.obPage({ step, picks: ['Data Analyst'], locs: [], summary }, S()))
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
    url: 'https://job-boards.greenhouse.io/acme/jobs/1', source: 'manual', company: 'Acme', role: 'Data Analyst', location: 'Remote', salary: '$100k', score: 82, reasons: ['SQL'], dealbreakers: [],
  })
  test('home says what is happening and what needs you', () => {
    const s = S()
    const jobs = [job('a', 'AWAITING_APPROVAL'), job('b', 'NEEDS_HUMAN'), job('c', 'SKIPPED')]
    const live = { task: { id: 't', kind: 'job' as const, title: 'Acme · Data Analyst', payload: {}, created: 0, tries: 0 }, started: Date.now() - 65_000, doing: 'Tailoring your resume', steps: 4 }
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
  test('an auto-search card lists each job on one line', () => {
    const p = renderCard({
      key: 'd', mode: 'multi', icon: '🔭', title: 'Auto-search', state: 'running', note: 'Checked 4 companies',
      jobs: [{ job_id: 'a', title: 'A · X', details: {}, final: finalFor('AWAITING_APPROVAL', '', 'a') }, { job_id: 'b', title: 'B · Y', details: {}, stage: 'read' }],
    })
    expect(p.text).toContain('Ready for your review')
    expect(p.text).toContain('Reading the posting')
    expect(p.text).toContain('Checked 4 companies')
  })
})
