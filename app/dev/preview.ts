// Renders the main screens from fixture state into dev/out/preview.html, styled like a Telegram chat, so the UI can be
// looked at (and screenshotted with dev/shot.py) without a phone. Pure pages only: nothing is sent, nothing in data/ is touched.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { kitPage } from '../src/applykit'
import { renderCard, type Card } from '../src/cards'
import type { Job } from '../src/jobs'
import type { Page } from '../src/kit'
import * as P from '../src/pages'
import { reviewPage, type Review } from '../src/review'
import * as ST from '../src/settings'
import { DEFAULT_SETTINGS, type Settings } from '../src/state'

const now = Date.now(), iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
const s: Settings = { ...structuredClone(DEFAULT_SETTINGS), onboarded: true, discovery: { ...DEFAULT_SETTINGS.discovery, enabled: true } }
const job = (id: string, status: string, company: string, role: string, score: number, minAgo: number): Job => ({
  id, status, updated_at: iso(minAgo), history: [{ status: 'NEW', at: iso(minAgo + 30), detail: '' }, { status, at: iso(minAgo), detail: status === 'SKIPPED' ? 'Match 48/100: they want 8+ years of Java' : '' }],
  url: `https://job-boards.greenhouse.io/${company.toLowerCase()}/jobs/1`, source: 'discovery', company, role, location: 'Remote (US)', salary: '$110-140k',
  score, reasons: ['4 years of SQL; they ask for 3+', 'Remote, as you asked'], dealbreakers: [],
  breakdown: { title: 95, seniority: 80, skills: score, location: 100, pay: 70 }, must_haves: [{ text: 'SQL', status: 'met' }, { text: 'dbt', status: 'partial' }, { text: 'Tableau', status: 'missing' }],
})
export const JOBS: Job[] = [
  job('greenhouse-acme-1', 'AWAITING_APPROVAL', 'Acme', 'Data Analyst', 86, 12),
  job('web-0000000001', 'KIT_READY', 'Globex', 'BI Analyst', 78, 50),
  job('greenhouse-initech-2', 'SKIPPED', 'Initech', 'Senior Java Engineer', 48, 300),
  job('greenhouse-umbrella-3', 'SUBMITTED', 'Umbrella', 'Analytics Engineer', 81, 3000),
]
export const REVIEW: Review = {
  job_id: 'greenhouse-acme-1', plan_hash: 'x', ats: 'greenhouse', company: 'Acme', role: 'Data Analyst', location: 'Remote (US)', salary: '$110-140k', score: 86,
  breakdown: { title: 95, seniority: 80, skills: 86, location: 100, pay: 70 }, must_haves: [{ text: 'SQL', status: 'met' }, { text: 'dbt', status: 'partial' }, { text: 'Tableau', status: 'missing' }],
  coverage: { before: 50, after: 67, missing: ['Tableau'] },
  reasons: ['4 years of SQL; they ask for 3+', 'Remote, as you asked'], dealbreakers: [], unusual: [], generated_sensitive: [], files: ['resume.pdf'],
  answers: [
    { fid: 'first_name', label: 'First Name', value: 'Jane', source: 'profile', sensitive: false, required: true },
    { fid: 'email', label: 'Email', value: 'jane@example.com', source: 'profile', sensitive: false, required: true },
    { fid: 'q1', label: 'Will you require visa sponsorship?', value: 'No', source: 'user', sensitive: true, required: true },
    { fid: 'q2', label: 'Why Acme?', value: 'I have built the kind of SQL reporting your team describes.', source: 'generated', sensitive: false, required: false },
    { fid: 'resume', label: 'Resume', value: 'resume.pdf', source: 'document', sensitive: false, required: true },
  ],
  resume: { edits: 2, reorders: 0, fallback: false, verified: true }, screenshots: [], url: 'https://job-boards.greenhouse.io/acme/jobs/1',
  changes: [{ old: 'Ran weekly reports for sales', new: 'Built weekly SQL reports for the sales team', reason: "mirrors 'SQL reporting'" }],
  cover_letter: 'Dear Acme team,\n\nI build the reports your analysts rely on.',
}
const card: Card = {
  key: 'search-x', mode: 'multi', icon: '🔭', title: 'Auto-search', state: 'running', started: now - 95_000, active: 'greenhouse-acme-1', doing: 'Tailoring your resume',
  note: 'Checked 12 companies, LinkedIn and Indeed · 3 new jobs fit your settings.',
  jobs: [
    { job_id: 'greenhouse-acme-1', title: 'Acme · Data Analyst', details: { score: '86/100' }, stage: 'tailor' },
    { job_id: 'web-0000000001', title: 'Globex · BI Analyst', details: {}, final: { emoji: '🧰', text: 'Your kit to apply yourself is below.' } },
    { job_id: 'greenhouse-initech-2', title: 'Initech · Java Engineer', details: {} },
  ],
}
const ctx = (over: Partial<P.HomeCtx> = {}): P.HomeCtx => ({ s, queued: 1, jobs: JOBS, forms: [], usage: { five_hour: 0.42, at: now }, nextSearch: now + 3 * 3600_000, companies: 12, ...over })

export const SCREENS: [string, Page][] = [
  ['Home: something to review', P.home(ctx())],
  ['Home: all clear', P.home(ctx({ jobs: JOBS.filter(j => j.status === 'SUBMITTED') }))],
  ['Needs you', P.needsPage({ jobs: JOBS, forms: [] })],
  ['Review card', reviewPage(REVIEW, true)],
  ['Application kit', kitPage(JOBS[1], { answers: [{ question: 'Why are you interested in this role?', answer: 'I have spent four years building SQL reporting for sales teams.' }], files: ['resume.pdf'] })],
  ['Auto-search card', renderCard(card, now)],
  ['Jobs', P.jobsPage(JOBS, 'a', 0)],
  ['Job: skipped', P.jobPage(JOBS[2], { running: false, hasForm: false })],
  ['Settings', ST.settingsRoot(s, 12)],
]

// Telegram HTML -> browser HTML: the same tags, plus spoilers and line breaks.
const html = (t: string) => t.replace(/<tg-spoiler>/g, '<span class="spoiler">').replace(/<\/tg-spoiler>/g, '</span>').replace(/<blockquote expandable>/g, '<blockquote class="x">')
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const bubble = ([name, p]: [string, Page]) => `<section><h2>${esc(name)}</h2><div class="msg">${html(p.text)}</div>${p.rows.filter(r => r.length).map(r => `<div class="row">${r.map(b => `<span class="btn ${b.style ?? ''}">${esc(b.text)}${b.url ? ' ↗' : ''}</span>`).join('')}</div>`).join('')}</section>`

if (import.meta.main) {
  const out = join(import.meta.dir, 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'preview.html'), `<!doctype html><meta charset="utf-8"><title>JobAgent screens</title><style>
body{margin:0;background:#0e1621;font:15px/1.38 -apple-system,"Segoe UI",Roboto,sans-serif;color:#f5f5f5;padding:16px}
section{max-width:420px;margin:0 auto 28px}h2{font:600 12px sans-serif;color:#6c7883;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
.msg{background:#182533;border-radius:12px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word}
blockquote{margin:4px 0;padding:2px 8px;border-left:3px solid #5288c1;background:#1f3247;border-radius:4px}blockquote.x{max-height:7.2em;overflow:hidden}
code,pre{font:13px ui-monospace,Consolas,monospace;color:#7cc4ff}pre{margin:4px 0;white-space:pre-wrap}i{color:#aab6c2}
.spoiler{background:#3a4a5c;color:transparent;border-radius:3px}.row{display:flex;gap:4px;margin-top:4px}
.btn{flex:1;text-align:center;background:#24384d;border-radius:8px;padding:8px 6px;font-size:14px}.btn.success{background:#2f7a47}.btn.danger{background:#8a3434}.btn.primary{background:#2b6cb0}
</style>${SCREENS.map(bubble).join('\n')}`)
  console.log(join(out, 'preview.html'))
}
