// Look-dev harness for the dashboard: fixture jobs in a throwaway data folder, the real server, the link printed.
// Usage: bun run dev/dash.ts   (then: uv run --project agent python app/dev/dash_shot.py <link>)
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jobagent-dash-'))
process.env.JOBAGENT_ROOT = root
const { JOBS, REVIEW } = await import('./preview')
const { DATA } = await import('../src/state')
const extra = [['Hooli', 'Data Scientist', 'NEW', 0], ['Stark', 'Analytics Lead', 'SUBMITTED', 91], ['Wayne', 'BI Developer', 'SUBMITTED', 74], ['Pied Piper', 'Data Engineer', 'NEEDS_ANSWERS', 83]] as const
const jobs = [...JOBS, ...extra.map(([company, role, status, score], i) => ({ ...JOBS[0], id: `greenhouse-x-${i}`, company, role, status, score: score || null }))]
for (const j of jobs) {
  const d = join(DATA, 'jobs', j.id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'status.json'), JSON.stringify({ status: j.status, updated_at: j.updated_at, history: j.history }))
  writeFileSync(join(d, 'meta.json'), JSON.stringify({ canonical_url: j.url, source: j.source }))
  writeFileSync(join(d, 'analysis.json'), JSON.stringify({ company: j.company, role: j.role, location: j.location, salary: j.salary, match: { score: j.score, reasons: j.reasons, breakdown: j.breakdown, must_haves: j.must_haves } }))
}
writeFileSync(join(DATA, 'jobs', JOBS[0].id, 'review.json'), JSON.stringify(REVIEW))
writeFileSync(join(DATA, 'applications.csv'), 'job_id,outcome\ngreenhouse-x-1,interview\ngreenhouse-umbrella-3,offer\n')
writeFileSync(join(DATA, 'jobs', JOBS[1].id, 'kit.json'), JSON.stringify({ answers: [{ question: 'Why Globex?', answer: 'Your BI team ships the dashboards I have been building for four years.' }] }))
writeFileSync(join(DATA, 'jobs', JOBS[0].id, 'resume.pdf'), '%PDF-1.4\n%dev\n')

// Fake answers for everything app.ts would answer (see dashCall there). Shapes must match it.
const ST = await import('../src/settings'), { DEFAULT_SETTINGS, getPath } = await import('../src/state')
const now = Date.now(), s = { ...structuredClone(DEFAULT_SETTINGS), onboarded: true, discovery: { ...DEFAULT_SETTINGS.discovery, enabled: true } }
const step = (job_id: string, title: string, stage: string, more = {}) => ({ job_id, title, stage, details: { score: '86/100' }, ...more })
const VIEWS: Record<string, unknown> = {
  'view:live': {
    agent_on: true, onboarded: true, discovery: true, searching: false, queued: 1,
    work: { title: 'Acme · Data Analyst', doing: 'Tailoring your resume', steps: 7, started: now - 95_000, kind: 'job' },
    next_search: now + 3 * 3600_000, usage: 0.42, limited_until: null, needs: { reviews: 1, kits: 1, forms: 1, other: 0, total: 3 }, updates: 0,
    tip: { min: 70, text: 'You approved every job scoring 70 or more and skipped all 6 below it. Set the minimum match score to 70?' }, problems: [], fixes: [],
    cards: [
      { key: 'job-1', mode: 'job', icon: '💼', title: 'Acme · Data Analyst', state: 'running', started: now - 95_000, doing: 'Tailoring your resume', steps: 7, jobs: [step('greenhouse-acme-1', 'Acme · Data Analyst', 'tailor')] },
      { key: 'search-x', mode: 'multi', icon: '🔭', title: 'Auto-search', state: 'ended', started: now - 3600_000, ended: now - 3000_000, note: 'Checked 12 companies, LinkedIn and Indeed · 2 new jobs fit your settings.', active: 'web-0000000001',
        jobs: [step('web-0000000001', 'Globex · BI Analyst', 'review', { final: { emoji: '🧰', text: 'Your kit to apply yourself is ready.', buttons: [{ text: '🧰 Open the kit', data: 'j:kit:00000000' }] } }), step('greenhouse-initech-2', 'Initech · Java Engineer', 'score', { final: { emoji: '⏭', text: 'They want 8+ years of Java' } })],
        final: { emoji: '✅', text: 'Done: 1 ready, 1 skipped.' } },
    ],
    codes: [], resume: null,
  },
  'view:settings': {
    cats: Object.entries(ST.CATS).map(([key, c]) => ({ key, emoji: c.emoji, title: c.title, blurb: c.blurb, items: c.items.map(sp => ({ id: sp.id, emoji: sp.emoji, label: sp.label, t: sp.t, what: sp.what, opts: sp.opts ?? null, nullable: sp.nullable ?? null, unit: sp.unit ?? null, example: sp.example ?? null, presets: (sp.presets ?? []).map(p => [p, ST.chip(sp, p)]), value: getPath(s, sp.path) ?? null, text: ST.valueText(sp, s) })) })),
    ideas: ['Analytics Engineer', 'BI Developer'], practice: true, forced: false, companies: ['acme', 'globex', 'stripe'], learned: 1, phone: null, port: 4777, windows: true,
  },
  'view:profile': {
    contact: [['full_name', 'Full name', 'Jane Doe'], ['email', 'Email', 'jane@example.com'], ['phone', 'Phone', '+1 555 0100'], ['location', 'City', 'Austin, TX'], ['linkedin', 'LinkedIn', '']].map(([key, label, value]) => ({ key, label, value })),
    resume: 'base_resume.docx', versions: ['analytics-focus'], versions_max: 5, achievements: [{ key: 'a1', text: 'Cut report build time from 3 days to 4 hours with dbt.' }], ach_max: 10, skills: 'SQL, dbt',
    answers: [{ key: 'work_auth_us', code: 'aaaaaaaa', question: 'Are you authorized to work in the US?', answer: null, sensitive: true, updated: '' }, { key: 'notice', code: 'bbbbbbbb', question: 'Notice period', answer: '2 weeks', sensitive: false, updated: '' }],
    completeness: { pct: 80, missing: ['LinkedIn'] }, helper: true,
  },
  'view:forms': [{ batch: 'b1', job_id: 'greenhouse-x-3', title: 'Pied Piper · Data Engineer', created_at: new Date(now).toISOString(), questions: [
    { qid: 'q1', text: 'Will you now or in the future require sponsorship?', kind: 'yesno', options: ['Yes', 'No'], sensitive: true, why: 'Required on the form.', can_save: true, remember: true, answered: false, answer: null },
    { qid: 'q2', text: 'Earliest start date', kind: 'date', options: null, sensitive: false, why: null, can_save: false, remember: false, answered: false, answer: null },
    { qid: 'q3', text: 'Which tools have you used?', kind: 'multi', options: ['Airflow', 'dbt', 'Spark', 'Kafka'], sensitive: false, why: null, can_save: false, remember: false, answered: false, answer: null },
  ] }],
  'view:logins': { sites: { linkedin: { logged_in: true, saved: true }, indeed: { logged_in: false } }, busy: false, names: ST.JOB_SITES, retry: { linkedin: 0, indeed: 2 } },
}
const call = async (op: string, b: Record<string, any>) => {
  if (op in VIEWS) return VIEWS[op]
  if (op === 'view:job') return { running: false, has_form: false, used_pct: 3, actions: [{ text: '🔄 Retry', data: 'j:rt:00000000' }], kit: b.id === JOBS[1].id ? { answers: [{ question: 'Why Globex?', answer: 'Your BI team ships the dashboards I have been building.' }], files: [] } : null, code: '00000000' }
  if (op === 'export') { const p = join(root, 'export.csv'); writeFileSync(p, 'company,role\nAcme,Data Analyst\n'); return { path: p } }
  return { text: `Done (dev: ${op})` }
}
const { startDashboard } = await import('../src/dashboard')
const d = startDashboard({ botToken: 'dev', pairedId: () => null, approve: async () => null, skip: async () => null, call, health: () => ({ at: Date.now() - 600_000, checks: [{ name: 'claude login', ok: true, detail: 'claude.ai', required: true }, { name: 'docx->pdf converter', ok: false, detail: 'install Word or LibreOffice', required: false }] }) }, 0)
console.log(d.link)
