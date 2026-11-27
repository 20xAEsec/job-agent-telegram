// Insights: where applications go, what gets replies, and one data-backed suggestion. Pure: jobs + outcomes in, page out.
import { heading, bar, esc, nav, note, plural, type Btn, type Page } from './kit'
import type { Job } from './jobs'

const APPLIED = ['SUBMITTED', 'APPLIED_SELF'], PREPARED = ['AWAITING_APPROVAL', 'KIT_READY']
const reached = (j: Job, st: string[]) => st.includes(j.status) || j.history.some(h => st.includes(h.status))
const BANDS: [string, number, number][] = [['90+', 90, 101], ['80–89', 80, 90], ['70–79', 70, 80], ['under 70', 0, 70]]
const MIN_FOR_SUGGESTIONS = 10 // applications with a known result before any suggestion is made

export type Funnel = { found: number; prepared: number; applied: number; replied: number; interview: number; offer: number }
export function funnel(jobs: Job[], out: Record<string, string>, since = 0): Funnel {
  const js = jobs.filter(j => Date.parse(j.history[0]?.at ?? j.updated_at) >= since)
  const applied = js.filter(j => reached(j, APPLIED))
  return {
    found: js.length,
    prepared: js.filter(j => reached(j, PREPARED)).length,
    applied: applied.length,
    replied: applied.filter(j => ['interview', 'offer', 'rejected'].includes(out[j.id])).length,
    interview: applied.filter(j => out[j.id] === 'interview' || out[j.id] === 'offer').length,
    offer: applied.filter(j => out[j.id] === 'offer').length,
  }
}

// Interview rate per match-score band, among applications that have a result (anything but "no outcome yet").
export function byBand(jobs: Job[], out: Record<string, string>) {
  const done = jobs.filter(j => reached(j, APPLIED) && out[j.id] && j.score != null)
  return BANDS.map(([name, lo, hi]) => {
    const b = done.filter(j => j.score! >= lo && j.score! < hi)
    return { name, lo, n: b.length, interviews: b.filter(j => out[j.id] === 'interview' || out[j.id] === 'offer').length }
  })
}

// One suggestion, only when the data clearly supports it.
export function suggestion(jobs: Job[], out: Record<string, string>, minScore: number): { text: string; btn?: Btn } | null {
  const bands = byBand(jobs, out), total = bands.reduce((n, b) => n + b.n, 0)
  if (total < MIN_FOR_SUGGESTIONS) return null
  const low = bands.filter(b => b.lo < 80), high = bands.filter(b => b.lo >= 80)
  const lowN = low.reduce((n, b) => n + b.n, 0), lowI = low.reduce((n, b) => n + b.interviews, 0)
  const highN = high.reduce((n, b) => n + b.n, 0), highI = high.reduce((n, b) => n + b.interviews, 0)
  if (lowN >= 5 && lowI === 0 && highI > 0 && minScore < 80) {
    return { text: `Your interviews come from matches of 80 or more (${highI} of ${highN}); none of the ${lowN} below 80 led to one. Raising the minimum match score would save time.`, btn: { text: '📊 Minimum match score', data: 's:ms' } }
  }
  const f = funnel(jobs, out)
  if (f.applied >= MIN_FOR_SUGGESTIONS && f.replied === 0) return { text: `No replies yet from ${f.applied} applications. Check that your resume preview looks right, and consider "Rebuild for ATS" tailoring.`, btn: { text: '📨 How I apply', data: 'S:apply' } }
  return null
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')

// The average share of the five-hour limit a prepared application used (v3 P5). `used`: job id -> fraction of the window.
export function avgCost(jobs: Job[], used: Record<string, number>): { pct: number; n: number } | null {
  const xs = jobs.filter(j => reached(j, PREPARED) && used[j.id] > 0).map(j => used[j.id])
  return xs.length ? { pct: Math.max(1, Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100)), n: xs.length } : null
}

export function insightsPage(jobs: Job[], out: Record<string, string>, minScore: number, now = Date.now(), weekly = false, used: Record<string, number> = {}): Page {
  const all = funnel(jobs, out), wk = funnel(jobs, out, now - 7 * 86_400_000)
  const step = (label: string, n: number, of: number) => `${bar(n, Math.max(1, all.found), 8)} <b>${n}</b> ${label}${of ? note(` · ${pct(n, of)}`) : ''}`
  const bySource = (['discovery', 'manual'] as const).map(src => {
    const a = jobs.filter(j => (j.source === src || (src === 'manual' && j.source !== 'discovery')) && reached(j, APPLIED))
    return `${src === 'discovery' ? '🔭 Auto-search' : '🔗 Links you sent'}: ${plural(a.length, 'application')}, ${pct(a.filter(j => ['interview', 'offer', 'rejected'].includes(out[j.id])).length, a.length)} replied`
  })
  const bands = byBand(jobs, out).filter(b => b.n)
  const s = suggestion(jobs, out, minScore), cost = avgCost(jobs, used)
  return {
    text: [
      heading('📊', weekly ? 'Your week' : 'Insights'), '',
      `<b>This week:</b> ${wk.found} found · ${wk.prepared} prepared · ${wk.applied} applied · ${wk.interview} interviews`, '',
      '<b>All time</b>',
      step('found', all.found, 0), step('prepared', all.prepared, all.found), step('applied', all.applied, all.prepared),
      step('interviews', all.interview, all.applied), step('offers', all.offer, all.interview),
      '', '<b>Where replies come from</b>', ...bySource,
      ...(bands.length ? ['', '<b>Interviews by match score</b>', ...bands.map(b => `${esc(b.name)}: ${b.interviews} of ${b.n}`)] : []),
      ...(cost ? ['', `⚡ A prepared application used about ${cost.pct}% of your 5-hour Claude limit (average of ${cost.n}).`] : []),
      ...(s ? ['', `💡 ${esc(s.text)}`] : ['', note(all.applied < MIN_FOR_SUGGESTIONS ? `Suggestions appear after ${MIN_FOR_SUGGESTIONS} applications with a result. Mark results under Jobs → Applied.` : 'Nothing to suggest right now.')]),
    ].join('\n'),
    rows: [...(s?.btn ? [[s.btn]] : []), [{ text: '📋 Jobs', data: 'J:d:0' }, ...nav()]],
  }
}

// From approve/skip decisions: when every approval scored at least `min` and the user skipped 5+ jobs below it, suggest
// raising the minimum match score to `min` (rounded down to 5) so those jobs are not prepared at all. Needs 15 decisions.
const YES = new Set(['approve', 'apply_anyway', 'applied_self'])
export function scoreSuggestion(ds: { decision: string; score: number | null }[], minScore: number): { min: number; text: string } | null {
  const scored = ds.filter(d => typeof d.score === 'number') as { decision: string; score: number }[]
  if (scored.length < 15) return null
  const yes = scored.filter(d => YES.has(d.decision))
  if (!yes.length) return null
  const min = Math.floor(Math.min(...yes.map(d => d.score)) / 5) * 5
  const below = scored.filter(d => d.score < min)
  if (min <= minScore || below.length < 5) return null
  return { min, text: `You approved every job scoring ${min} or more and skipped all ${below.length} below it. Set the minimum match score to ${min}?` }
}
