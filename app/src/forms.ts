// Question forms: one message per form, edited as the user answers. Everything except load/save is pure.
import { mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { code } from './jobs'
import { bar, esc, note, parseNumber, quote, short, type Btn, type Page } from './kit'
import { DATA, readJson, writeJson } from './state'

export type Kind = 'choice' | 'multi' | 'yesno' | 'text' | 'number' | 'date'
export type Save = 'global' | 'job' | 'no'
export type Question = {
  qid: string; text: string; kind: Kind; options?: string[]; sensitive?: boolean
  save_key?: string; default_save?: Save; why?: string; fid?: string // fid: the form field this fills (hidden from the user)
}
export type Value = string | number | string[]
export type Form = {
  batch_id: string; job_id?: string; title?: string; questions: Question[]
  answers: Record<string, Value>; save: Record<string, Save>; draft: Record<string, string[]>
  current: number; confirming: boolean; picking?: boolean; skipping?: boolean; status: 'open' | 'done' | 'skipped'
  message_id?: number; created_at: number; updated_at: number
}
export type Answer = { qid: string; fid?: string; value: Value; save: Save; save_key?: string; question: string; sensitive: boolean }
export type FormEvent = { kind: 'answers'; form: Form; answers: Answer[] } | { kind: 'skipped'; form: Form }
export type Step = { form: Form; event?: FormEvent; error?: string }

const MAX_BUTTONS = 8
const DIR = join(DATA, 'forms')

const QSchema = z.object({
  qid: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
  text: z.string().min(1).max(500),
  kind: z.enum(['choice', 'multi', 'yesno', 'text', 'number', 'date']),
  options: z.array(z.string().min(1).max(100)).max(40).optional(),
  sensitive: z.boolean().optional(),
  save_key: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  default_save: z.enum(['global', 'job', 'no']).optional(),
  why: z.string().max(300).optional(),
  fid: z.string().max(120).optional(),
})

export function validateQuestions(raw: unknown, hasJob: boolean): Question[] {
  const r = z.array(QSchema).min(1).max(20).safeParse(raw)
  if (!r.success) throw new Error(`bad questions: ${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`)
  const seen = new Set<string>()
  return r.data.map(q => {
    if (seen.has(q.qid)) throw new Error(`duplicate qid ${q.qid}`)
    seen.add(q.qid)
    if (q.kind === 'yesno') q = { ...q, options: q.options?.length === 2 ? q.options : ['Yes', 'No'] }
    if ((q.kind === 'choice' || q.kind === 'multi') && (q.options?.length ?? 0) < 2) throw new Error(`${q.qid}: needs at least 2 options`)
    if (q.sensitive && !q.save_key) throw new Error(`${q.qid}: sensitive questions need a save_key (they are always saved)`)
    if (q.default_save === 'job' && !hasJob) throw new Error(`${q.qid}: default_save "job" needs a job_id`)
    return q
  })
}

export function newForm(batch_id: string, job_id: string | undefined, title: string | undefined, questions: Question[], now = Date.now()): Form {
  const save: Record<string, Save> = {}
  // Sensitive answers always start saved (you are never asked twice); no save_key means nothing to save.
  for (const q of questions) save[q.qid] = !q.save_key ? 'no' : q.sensitive ? 'global' : (q.default_save ?? 'global')
  return { batch_id, job_id, title, questions, answers: {}, save, draft: {}, current: 0, confirming: false, status: 'open', created_at: now, updated_at: now }
}

// ---- Typed input ----

function parseDate(text: string): string | null {
  const t = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isNaN(Date.parse(t)) || new Date(t).toISOString().slice(0, 10) !== t ? null : t
  if (/^(\d{1,3})\s*(day|week|month)s?$/i.test(t) || /^(immediately|asap|now)$/i.test(t)) return t.toLowerCase()
  return null
}
const numbered = (q: Question) => (q.kind === 'choice' || q.kind === 'yesno' || q.kind === 'multi') && (q.options?.length ?? 0) > MAX_BUTTONS
export const textual = (q: Question) => q.kind === 'text' || q.kind === 'number' || q.kind === 'date' || numbered(q)
function pickOption(q: Question, token: string): string | null {
  const t = token.trim()
  if (/^\d+$/.test(t)) return q.options![parseInt(t, 10) - 1] ?? null
  return q.options!.find(o => o.toLowerCase() === t.toLowerCase()) ?? null
}
function parseAnswer(q: Question, t: string): { v: Value } | { error: string } {
  if (q.kind === 'text') return t.length > 0 && t.length <= 2000 ? { v: t } : { error: 'Please send 1 to 2000 characters.' }
  if (q.kind === 'number') { const n = parseNumber(t); return n === null ? { error: 'Please send a number, like 95000 or 95k.' } : { v: n } }
  if (q.kind === 'date') { const d = parseDate(t); return d === null ? { error: 'Please send a date like 2026-12-01, or "2 weeks", or "immediately".' } : { v: d } }
  if (q.kind === 'multi') {
    const picks = t.split(',').map(x => pickOption(q, x))
    return picks.length && picks.every(p => p !== null) ? { v: [...new Set(picks as string[])] } : { error: 'Send the numbers of your choices, like 1,3.' }
  }
  const o = pickOption(q, t)
  return o === null ? { error: 'Send the number of your choice.' } : { v: o }
}

// ---- Transitions ----

const cur = (f: Form) => f.questions[f.current]
const next = (f: Form): Form => {
  const i = f.questions.findIndex(q => !(q.qid in f.answers))
  return i < 0 ? { ...f, confirming: true, picking: false } : { ...f, current: i, confirming: false, picking: false }
}
const setAnswer = (f: Form, v: Value, now: number): Step => ({ form: next({ ...f, answers: { ...f.answers, [cur(f).qid]: v }, updated_at: now }) })
const bad = (f: Form): Step => ({ form: f, error: 'That button is from an older step.' })

export function act(f: Form, action: string, now = Date.now()): Step {
  if (f.status !== 'open') return { form: f, error: 'This form is already closed.' }
  const [op, arg] = action.split(':')
  if (f.skipping && op !== 's') f = { ...f, skipping: false } // any other tap cancels "Skip this job?"
  const q = cur(f)
  switch (op) {
    case 'o': { // pick an option
      const o = q.options?.[parseInt(arg, 10)]
      if (!(q.kind === 'choice' || q.kind === 'yesno') || o === undefined || f.confirming) return bad(f)
      return setAnswer(f, o, now)
    }
    case 'm': { // toggle a multi-select option
      const o = q.options?.[parseInt(arg, 10)]
      if (q.kind !== 'multi' || o === undefined || f.confirming) return bad(f)
      const d = f.draft[q.qid] ?? []
      return { form: { ...f, updated_at: now, draft: { ...f.draft, [q.qid]: d.includes(o) ? d.filter(x => x !== o) : [...d, o] } } }
    }
    case 'd': { // multi-select done
      const d = f.draft[q.qid] ?? []
      if (q.kind !== 'multi' || f.confirming) return bad(f)
      return d.length ? setAnswer(f, d, now) : { form: f, error: 'Pick at least one option.' }
    }
    case 't': // remember for next time: on / off
      if (!q.save_key || f.confirming) return bad(f)
      return { form: { ...f, updated_at: now, save: { ...f.save, [q.qid]: f.save[q.qid] === 'no' ? (q.default_save && q.default_save !== 'no' ? q.default_save : 'global') : 'no' } } }
    case 'p': // "Change an answer": show the list
      return f.confirming ? { form: { ...f, picking: true, updated_at: now } } : bad(f)
    case 'e': { // edit question n
      const i = parseInt(arg, 10)
      const t = f.questions[i]
      if (!t) return bad(f)
      const draft = t.kind === 'multi' && Array.isArray(f.answers[t.qid]) ? { ...f.draft, [t.qid]: f.answers[t.qid] as string[] } : f.draft
      return { form: { ...f, current: i, confirming: false, picking: false, draft, updated_at: now } }
    }
    case 'k': // keep the old answer while editing
      return f.questions.every(x => x.qid in f.answers) ? { form: { ...f, confirming: true, picking: false, updated_at: now } } : bad(f)
    case 'x': return f.job_id ? { form: { ...f, skipping: true, updated_at: now } } : bad(f)
    case 'xn': return { form: f }
    case 's':
      if (!f.job_id) return bad(f)
      { const g: Form = { ...f, status: 'skipped', updated_at: now }; return { form: g, event: { kind: 'skipped', form: g } } }
    case 'c': {
      if (!f.confirming) return { form: f, error: 'Answer every question first.' }
      const answers: Answer[] = f.questions.map(x => ({
        qid: x.qid, fid: x.fid, value: f.answers[x.qid], save: x.save_key ? f.save[x.qid] : 'no', save_key: x.save_key, question: x.text, sensitive: !!x.sensitive,
      }))
      const g: Form = { ...f, status: 'done', updated_at: now }
      return { form: g, event: { kind: 'answers', form: g, answers } }
    }
  }
  return bad(f)
}

// A typed reply to the current question. Returns an error (form unchanged) if it does not validate.
export function answerText(f: Form, text: string, now = Date.now()): Step {
  if (f.status !== 'open' || f.confirming) return { form: f, error: 'No open question.' }
  const q = cur(f)
  if (!textual(q)) return { form: f, error: 'Please tap one of the buttons.' }
  const p = parseAnswer(q, text.trim())
  return 'error' in p ? { form: f, error: p.error } : setAnswer(f, p.v, now)
}

// ---- Rendering ----

const fmt = (q: Question, v: Value) => (q.sensitive ? '<tg-spoiler>' + esc(short(Array.isArray(v) ? v.join(', ') : String(v), 50)) + '</tg-spoiler>' : esc(short(Array.isArray(v) ? v.join(', ') : String(v), 50)))
const hint = (q: Question) =>
  numbered(q) ? 'Type the number of your choice below.' : q.kind === 'number' ? 'Type a number below, like 95000 or 95k.'
    : q.kind === 'date' ? 'Type a date below, like 2026-12-01, "2 weeks" or "immediately".' : q.kind === 'text' ? 'Type your answer below.' : ''

export function render(f: Form): Page {
  const c = code(f.batch_id)
  const n = f.questions.length
  const name = esc(f.title ?? 'A few questions')
  if (f.status === 'done') {
    const saved = f.questions.filter(x => x.save_key && f.save[x.qid] !== 'no').length
    return { text: `<b>✅ Thanks, got ${n === 1 ? 'your answer' : `all ${n} answers`}</b>\n${name}${saved ? `\n${note(`💾 ${saved} saved, so I won't ask again`)}` : ''}\n${note('Picking the job back up now.')}`, rows: [] }
  }
  if (f.status === 'skipped') return { text: `<b>⏭ Skipped</b>\n${name}`, rows: [] }
  const done = f.questions.filter(x => x.qid in f.answers).length
  const head = `<b>❓ ${name}</b>\n${bar(done, n)}  <i>${done} of ${n} answered</i>`
  const rows: Btn[][] = []

  if (f.confirming && f.picking) {
    return {
      text: `${head}\n\nWhich answer do you want to change?`,
      rows: [...f.questions.map((q, i) => [{ text: `${i + 1}. ${short(q.text, 50)}`, data: `f:${c}:e:${i}` }]), [{ text: '← Back', data: `f:${c}:k` }]],
    }
  }
  if (f.confirming) {
    const lines = f.questions.map((q, i) => `${i + 1}. ${q.sensitive ? '🔒 ' : ''}${esc(short(q.text, 70))}\n    → <b>${fmt(q, f.answers[q.qid])}</b>`)
    rows.push([{ text: '✅ Looks good, continue', data: `f:${c}:c`, style: 'success' }])
    rows.push([{ text: '✏️ Change an answer', data: `f:${c}:p` }])
    let text = `${head}\n\n${lines.join('\n')}\n\n${note('Check your answers, then send them.')}`
    if (f.skipping && f.job_id) {
      text += `\n\n⚠️ <b>Skip this job?</b> ${note("I'll stop working on it.")}`
      rows.push([{ text: '⏭ Yes, skip it', data: `f:${c}:s`, style: 'danger' }, { text: '↩ Keep going', data: `f:${c}:xn` }])
    } else if (f.job_id) rows.push([{ text: '⏭ Skip this job', data: `f:${c}:x` }])
    return { text, rows }
  }

  const q = cur(f)
  const answered = f.questions.map((x, i) => ({ x, i })).filter(({ x, i }) => x.qid in f.answers && i !== f.current)
  let text = head
  if (answered.length) text += '\n' + quote(answered.map(({ x, i }) => `${i + 1}. ${esc(short(x.text, 50))} → ${fmt(x, f.answers[x.qid])}`).join('\n'), answered.length > 3)
  text += `\n\n<b>${f.current + 1}. ${q.sensitive ? '🔒 ' : ''}${esc(q.text)}</b>`
  if (q.why) text += `\n${note(esc(q.why))}`
  if (numbered(q)) text += '\n' + q.options!.map((o, i) => `${i + 1}. ${esc(o)}`).join('\n')
  if (hint(q)) text += `\n\n⌨️ ${note(hint(q))}`
  if ((q.kind === 'choice' || q.kind === 'yesno' || q.kind === 'multi') && !numbered(q)) {
    const d = f.draft[q.qid] ?? []
    const btns = q.options!.map((o, i) => q.kind === 'multi'
      ? { text: `${d.includes(o) ? '☑️' : '⬜'} ${short(o, 30)}`, data: `f:${c}:m:${i}` }
      : { text: short(o, 30), data: `f:${c}:o:${i}` })
    rows.push(...(btns.some(b => b.text.length > 18) ? btns.map(b => [b]) : [btns.slice(0, 2), btns.slice(2, 4), btns.slice(4, 6), btns.slice(6, 8)].filter(r => r.length)))
    if (q.kind === 'multi') rows.push([{ text: '✔ Done', data: `f:${c}:d`, style: 'success' }])
  }
  if (q.qid in f.answers && f.questions.every(x => x.qid in f.answers)) rows.push([{ text: '↩ Keep my old answer', data: `f:${c}:k` }])
  const last: Btn[] = []
  if (q.save_key) last.push({ text: f.save[q.qid] === 'no' ? '💾 Just this once' : '💾 Remember it ✓', data: `f:${c}:t` })
  if (q.sensitive) text += `\n${note('🔒 Private: saved on your computer only, never guessed.')}`
  if (f.skipping && f.job_id) {
    text += `\n\n⚠️ <b>Skip this job?</b> ${note("I'll stop working on it.")}`
    rows.push([{ text: '⏭ Yes, skip it', data: `f:${c}:s`, style: 'danger' }, { text: '↩ Keep going', data: `f:${c}:xn` }])
  } else if (f.job_id) last.push({ text: '⏭ Skip this job', data: `f:${c}:x` })
  if (last.length) rows.push(last)
  return { text, rows }
}

// ---- Storage ----

export const BATCH_RE = /^[A-Za-z0-9_-]{1,80}$/
const file = (b: string) => join(DIR, `${b}.json`)
export const loadForm = (b: string): Form | null => (BATCH_RE.test(b) ? readJson<Form | null>(file(b), null) : null)
export const saveForm = (f: Form) => { mkdirSync(DIR, { recursive: true }); writeJson(file(f.batch_id), f) }
export function listForms(): Form[] {
  try {
    return readdirSync(DIR).filter(n => n.endsWith('.json')).map(n => readJson<Form | null>(join(DIR, n), null)).filter((f): f is Form => !!f)
  } catch { return [] }
}
export const openForms = () => listForms().filter(f => f.status === 'open').sort((a, b) => b.updated_at - a.updated_at)
export const findForm = (c: string) => listForms().find(f => code(f.batch_id) === c)
// Which form a typed message answers: the most recently touched open form waiting for typed input, if it is recent.
// An old form does not swallow a chat message; opening it from Needs you makes it recent again.
export const textForm = (now = Date.now()) => openForms().find(f => !f.confirming && textual(cur(f)) && now - f.updated_at < 2 * 3600_000)
