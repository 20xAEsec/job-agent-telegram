// Read-only view of data/jobs/<id>/ for the screens (fast: no Python). All writes go through `jobagent`.
import { createHash } from 'crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from 'fs'
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
  ats?: string // the form type (meta.json): greenhouse, lever, ashby, generic
  score: number | null; reasons: string[]; dealbreakers: string[]
  breakdown: Breakdown; must_haves: MustHave[]
}
export type Breakdown = Partial<Record<'title' | 'seniority' | 'skills' | 'location' | 'pay', number>>
export type MustHave = { text: string; status: 'met' | 'partial' | 'missing' }
const PARTS = ['title', 'seniority', 'skills', 'location', 'pay'] as const
export const breakdownOf = (m: any): Breakdown => {
  const b = m?.breakdown && typeof m.breakdown === 'object' ? m.breakdown : {}
  return Object.fromEntries(PARTS.filter(k => typeof b[k] === 'number').map(k => [k, Math.max(0, Math.min(100, Math.round(b[k])))]))
}
export const mustHavesOf = (m: any): MustHave[] =>
  (Array.isArray(m?.must_haves) ? m.must_haves : []).filter((x: any) => x && typeof x.text === 'string' && ['met', 'partial', 'missing'].includes(x.status))
    .slice(0, 8).map((x: any) => ({ text: x.text.slice(0, 80), status: x.status }))

// The user's decisions, for calibration (jobagent feedback summary) and the Home suggestion. Job features only:
// never posting text or answers.
export type Decision = 'approve' | 'skip' | 'never' | 'apply_anyway' | 'applied_self' | 'skip_reason' | `outcome_${string}`
export function logDecision(id: string, decision: Decision, reason?: string) {
  const j = readJob(id)
  if (!j) return
  const row = { at: new Date().toISOString(), job_id: id, decision, ...(reason ? { reason } : {}), score: j.score, role: j.role.slice(0, 120), source: j.source, breakdown: j.breakdown }
  try { appendFileSync(join(DATA, 'feedback.jsonl'), JSON.stringify(row) + '\n') } catch { /* best effort */ }
}
export function readDecisions(): { job_id: string; decision: string; score: number | null }[] {
  let text = ''
  try { text = readFileSync(join(DATA, 'feedback.jsonl'), 'utf8') } catch { return [] }
  const last = new Map<string, any>()
  for (const l of text.split('\n')) { try { const r = JSON.parse(l); if (r?.job_id && !String(r.decision).startsWith('outcome_') && r.decision !== 'skip_reason') last.set(r.job_id, r) } catch { /* skip */ } }
  return [...last.values()]
}

// data/screened.jsonl (written by Python): jobs auto-search filtered out before a full read, oldest first. Third-party titles: escape on display.
export type Screened = { at: string; job_id: string; title: string; company: string; url: string; stage: 'rules' | 'triage'; code?: string; reason: string; score?: number }
export function readScreened(): Screened[] {
  let text = ''
  try { text = readFileSync(join(DATA, 'screened.jsonl'), 'utf8') } catch { return [] }
  const out: Screened[] = []
  for (const l of text.split('\n')) { try { const r = JSON.parse(l); if (r?.job_id && typeof r.url === 'string') out.push(r) } catch { /* skip */ } }
  return out
}

export function jobIds(): string[] {
  try { return readdirSync(join(DATA, 'jobs')).filter(i => JOB_RE.test(i)) } catch { return [] }
}

// Job index: a job is re-read only when status.json, meta.json or analysis.json changed on disk.
// Home refreshes every 30 s and on every event, so re-parsing every job folder each time would grow with every search.
const cache = new Map<string, { stamp: string; job: Job | null }>()
const mtime = (f: string) => { try { return statSync(f).mtimeMs } catch { return 0 } }
// A folder watcher marks which jobs changed, so a full list (Home, Jobs) re-checks only those. If the watcher cannot
// start, or every minute in case an event was missed, it falls back to checking every job's file times.
let watching = false, verifiedAt = 0
const dirty = new Set<string>()
function watchJobs() {
  if (watching) return
  try {
    mkdirSync(join(DATA, 'jobs'), { recursive: true })
    watch(join(DATA, 'jobs'), { recursive: true }, (_e, f) => { if (f) dirty.add(String(f).split(/[\/]/)[0]) }).unref?.()
    watching = true
  } catch { /* no watcher: readJob checks file times every time */ }
}

export function readJob(id: string, trusted = false): Job | null {
  if (!JOB_RE.test(id)) return null
  if (trusted && cache.has(id) && !dirty.has(id)) return cache.get(id)!.job
  dirty.delete(id)
  const dir = jobDir(id), stamp = `${mtime(join(dir, 'status.json'))}:${mtime(join(dir, 'meta.json'))}:${mtime(join(dir, 'analysis.json'))}`
  const hit = cache.get(id)
  if (hit?.stamp === stamp) return hit.job
  const job = loadJob(id)
  cache.set(id, { stamp, job })
  return job
}

function loadJob(id: string): Job | null {
  const st = readJson<{ status?: string; updated_at?: string; history?: Hist[] } | null>(join(jobDir(id), 'status.json'), null)
  if (!st?.status) return null
  const m = readJson<Record<string, any>>(join(jobDir(id), 'meta.json'), {})
  const a = readJson<Record<string, any>>(join(jobDir(id), 'analysis.json'), {})
  const match = a.match && typeof a.match === 'object' ? a.match : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    id, status: st.status, updated_at: st.updated_at ?? '', history: Array.isArray(st.history) ? st.history : [],
    url: s(m.canonical_url) || s(m.url), source: s(m.source), ats: s(m.ats) || 'generic', company: s(a.company), role: s(a.role), location: s(a.location), salary: s(a.salary),
    score: typeof match.score === 'number' ? match.score : null,
    reasons: Array.isArray(match.reasons) ? match.reasons.map(String).slice(0, 4) : [],
    dealbreakers: Array.isArray(match.dealbreakers) ? match.dealbreakers.map(String).slice(0, 3) : [],
    breakdown: breakdownOf(match), must_haves: mustHavesOf(match),
  }
}

export function allJobs(now = Date.now()): Job[] {
  watchJobs()
  const trusted = watching && now - verifiedAt < 60_000
  if (!trusted) verifiedAt = now
  return jobIds().map(id => readJob(id, trusted)).filter((j): j is Job => !!j).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}
const codes = new Map<string, string>() // id -> code: sha1 once per id, not once per id per tap
export const findJob = (c: string) => jobIds().find(i => { let k = codes.get(i); if (!k) codes.set(i, (k = code(i))); return k === c })

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
  KIT_READY: { emoji: '🧰', text: 'Ready for you to apply', needsYou: true },
  APPLIED_SELF: { emoji: '✅', text: 'You applied', done: true },
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
