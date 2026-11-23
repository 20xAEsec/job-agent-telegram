// The style kit. Every screen is built from these so spacing, emphasis and wording match everywhere.
// Page text is Telegram HTML: wrap every user- or posting-derived value in esc().
import { InlineKeyboard } from 'grammy'

export type Btn = { text: string; data?: string; url?: string; style?: 'success' | 'danger' | 'primary' }
export type Page = { text: string; rows: Btn[][] }

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const heading = (emoji: string, title: string) => `<b>${emoji} ${title}</b>`
export const kv = (label: string, value: string) => `<b>${label}:</b> ${value}`
export const note = (t: string) => `<i>${t}</i>`
export const quote = (t: string, expandable = false) => `<blockquote${expandable ? ' expandable' : ''}>${t}</blockquote>`
// ▰▰▰▱▱ progress bar
export const bar = (done: number, total: number, w = 10) => {
  const n = total ? Math.max(0, Math.min(w, Math.round((done / total) * w))) : 0
  return '▰'.repeat(n) + '▱'.repeat(w - n)
}
// "Step 2 of 5 · Role" header line used by multi-step flows.
export const stepLine = (i: number, n: number, name: string) => `${bar(i, n, n)}  <i>Step ${i} of ${n} · ${name}</i>`

// The same bottom row everywhere: Back (unless that is Home) + Home.
export const nav = (back = 'm:home'): Btn[] =>
  back === 'm:home' ? [{ text: '🏠 Home', data: 'm:home' }] : [{ text: '← Back', data: back }, { text: '🏠 Home', data: 'm:home' }]
export const pairs = (b: Btn[], n = 2): Btn[][] => Array.from({ length: Math.ceil(b.length / n) }, (_, i) => b.slice(i * n, i * n + n))

export function kb(p: Page | Btn[][]): InlineKeyboard {
  const rows = Array.isArray(p) ? p : p.rows
  const k = new InlineKeyboard()
  for (const row of rows) {
    if (!row.length) continue
    for (const b of row) {
      if (b.url) k.url(b.text, b.url)
      else k.add({ text: b.text, callback_data: b.data ?? 'noop', ...(b.style ? { style: b.style } : {}) } as any)
    }
    k.row()
  }
  return k
}

// Human labels for config values: raw values never reach the user.
const LABELS: Record<string, string> = {
  exact: 'Exact', close: 'Close', broad: 'Broad',
  intern: 'Intern', entry: 'Entry level', mid: 'Mid level', senior: 'Senior', staff: 'Staff', lead: 'Lead', manager: 'Manager', director: 'Director',
  remote_only: 'Remote only', remote_or_hybrid: 'Remote or hybrid', any: 'Any (remote, hybrid or on-site)', onsite_only: 'On-site only',
  review: 'I review every application', auto: 'Auto-apply to strong matches',
  always: 'Always', if_field: 'When the form has a cover-letter field', if_required: 'Only when required', never: 'Never',
  light: 'Light touch', moderate: 'Moderate',
  full_time: 'Full time', part_time: 'Part time', contract: 'Contract', internship: 'Internship',
  sonnet: 'Balanced (Sonnet)', opus: 'Best quality (Opus)',
}
export const label = (v: unknown) => LABELS[String(v)] ?? String(v).replace(/_/g, ' ')

export const money = (n: number, cur = 'USD') => {
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', INR: '₹' }
  const v = n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  return sym[cur] ? `${sym[cur]}${v}` : `${v} ${cur}`
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago"; older falls back to the date.
export function ago(then: number | string, now = Date.now()): string {
  const ms = typeof then === 'string' ? Date.parse(then) : then
  if (Number.isNaN(ms)) return '—'
  const min = Math.floor((now - ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.floor(min / 60)} h ago`
  const d = Math.floor(min / 1440)
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ms).toISOString().slice(0, 10)
}
// "in 2 h 10 min", "in 4 min", "any moment now"
export function until(then: number, now = Date.now()): string {
  const min = Math.ceil((then - now) / 60_000)
  if (min <= 1) return 'any moment now'
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60), m = min % 60
  return `in ${h} h${m ? ` ${m} min` : ''}`
}
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

// Telegram caps messages at 4096 chars. Split on line breaks so HTML tags are rarely cut in half.
export function splitMsg(text: string, max = 4096): string[] {
  const out: string[] = []
  while (text.length > max) {
    const cut = text.lastIndexOf('\n', max)
    const at = cut > 0 ? cut : max
    out.push(text.slice(0, at))
    text = text.slice(at).replace(/^\n/, '')
  }
  out.push(text || ' ')
  return out
}

// Typed numbers: 95000, 95k, $95,000, 1.2m
export function parseNumber(text: string): number | null {
  const m = /^[$€£]?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?$/i.exec(text.trim())
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase() as 'k' | 'm'] ?? 1)
  return Number.isFinite(n) ? Math.round(n) : null
}

// Comma or newline separated list, trimmed, deduplicated (case-insensitive), empties dropped.
export function parseList(text: string): string[] {
  const seen = new Set<string>()
  return text.split(/[,\n;]/).map(x => x.trim()).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
}
