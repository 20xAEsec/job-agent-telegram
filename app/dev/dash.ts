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
const { startDashboard } = await import('../src/dashboard')
const d = startDashboard({ botToken: 'dev', pairedId: () => null, approve: async () => null, skip: async () => null, health: () => ({ at: Date.now() - 600_000, checks: [{ name: 'claude login', ok: true, detail: 'claude.ai', required: true }, { name: 'docx->pdf converter', ok: false, detail: 'install Word or LibreOffice', required: false }] }) }, 0)
console.log(d.link)
