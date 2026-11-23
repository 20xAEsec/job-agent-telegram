// Read-only view of data/jobs/<id>/ for the screens (fast: no Python). All writes go through `jobagent`.
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { DATA, readJson } from './state'

export const JOB_RE = /^[a-z0-9-]{1,80}$/
export const jobDir = (id: string) => join(DATA, 'jobs', id)
// 8-hex short code for callback data (Telegram caps it at 64 bytes).
export const code = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 8)

export type Hist = { status: string; at: string; detail: string }
export type Job = {
  id: string; status: string; updated_at: string; history: Hist[]
  url: string; source: string; company: string; role: string; location: string; salary: string
  score: number | null; reasons: string[]; dealbreakers: string[]
}

export function jobIds(): string[] {
  try { return readdirSync(join(DATA, 'jobs')).filter(i => JOB_RE.test(i)) } catch { return [] }
}

export function readJob(id: string): Job | null {
  if (!JOB_RE.test(id)) return null
  const st = readJson<{ status?: string; updated_at?: string; history?: Hist[] } | null>(join(jobDir(id), 'status.json'), null)
  if (!st?.status) return null
  const m = readJson<Record<string, any>>(join(jobDir(id), 'meta.json'), {})
  const a = readJson<Record<string, any>>(join(jobDir(id), 'analysis.json'), {})
  const match = a.match && typeof a.match === 'object' ? a.match : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    id, status: st.status, updated_at: st.updated_at ?? '', history: Array.isArray(st.history) ? st.history : [],
    url: s(m.canonical_url) || s(m.url), source: s(m.source), company: s(a.company), role: s(a.role), location: s(a.location), salary: s(a.salary),
    score: typeof match.score === 'number' ? match.score : null,
    reasons: Array.isArray(match.reasons) ? match.reasons.map(String).slice(0, 4) : [],
    dealbreakers: Array.isArray(match.dealbreakers) ? match.dealbreakers.map(String).slice(0, 3) : [],
  }
}

export const allJobs = (): Job[] =>
  jobIds().map(readJob).filter((j): j is Job => !!j).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
export const findJob = (c: string) => jobIds().find(i => code(i) === c)

export const jobTitle = (j: Pick<Job, 'company' | 'role' | 'url' | 'id'>) =>
  j.company || j.role ? `${j.company || 'Unknown company'} · ${j.role || 'Unknown role'}` : hostOf(j.url) || j.id
export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }
export const lastDetail = (j: Job) => j.history.at(-1)?.detail ?? ''

// What each status means to a person, and whether it needs them.
export const STATUS: Record<string, { emoji: string; text: string; needsYou?: boolean; done?: boolean }> = {
  NEW: { emoji: '🆕', text: 'Just added' },
  FETCHED: { emoji: '📄', text: 'Reading the posting' },
  SCORED: { emoji: '📊', text: 'Scored' },
  NEEDS_ANSWERS: { emoji: '❓', text: 'Waiting for your answers', needsYou: true },
  READY: { emoji: '⚙️', text: 'Preparing the application' },
  FILLED_DRY: { emoji: '⚙️', text: 'Preparing the review' },
  AWAITING_APPROVAL: { emoji: '🔔', text: 'Ready for your review', needsYou: true },
  APPROVED: { emoji: '⏳', text: 'Approved, sending soon' },
  SUBMITTING: { emoji: '📤', text: 'Sending now' },
  SUBMITTED: { emoji: '✅', text: 'Applied', done: true },
  DRY_RUN_DONE: { emoji: '🧪', text: 'Practice run done (not sent)', done: true },
  NEEDS_HUMAN: { emoji: '🙋', text: 'Needs you', needsYou: true },
  FAILED: { emoji: '⚠️', text: 'Something went wrong', needsYou: true },
  SKIPPED: { emoji: '⏭', text: 'Skipped', done: true },
  CLOSED: { emoji: '🚪', text: 'Posting closed', done: true },
}
export const statusOf = (s: string) => STATUS[s] ?? { emoji: '•', text: s.toLowerCase() }
export const needsYou = (j: Job) => !!statusOf(j.status).needsYou
export const inProgress = (j: Job) => !statusOf(j.status).needsYou && !statusOf(j.status).done

// Outcomes ("interview", "offer"...) live in data/applications.csv, written by `jobagent log outcome`.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false; else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
export function readOutcomes(): Record<string, string> {
  let text = ''
  try { text = readFileSync(join(DATA, 'applications.csv'), 'utf8') } catch { return {} }
  const [head, ...rows] = parseCsv(text)
  const id = head?.indexOf('job_id') ?? -1, out = head?.indexOf('outcome') ?? -1
  if (id < 0 || out < 0) return {}
  return Object.fromEntries(rows.filter(r => r[out]).map(r => [r[id], r[out]]))
}
