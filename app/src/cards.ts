// Live task cards: one message per task, edited in place (silently) from "waiting in line" to its final state.
// A job task shows a stepper; an auto-search task lists each job it found on one line. renderCard is pure.
import type { Api } from 'grammy'
import { join } from 'path'
import { code } from './jobs'
import { clock, elapsed, esc, heading, kb, note, short, type Btn, type Page } from './kit'
import { DATA, log, readJson, writeJson } from './state'

export const STAGES = ['read', 'score', 'tailor', 'fill', 'review'] as const
export type Stage = (typeof STAGES)[number]
const STAGE_TEXT: Record<Stage, [running: string, done: string, todo: string]> = {
  read: ['Reading the posting', 'Read the posting', 'Read the posting'],
  score: ['Checking how well it fits', 'Match score', 'Check the fit'],
  tailor: ['Tailoring your resume', 'Tailored your resume', 'Tailor your resume'],
  fill: ['Filling in the application', 'Filled in the application', 'Fill in the application'],
  review: ['Ready for your review', 'Ready for your review', 'Your review'],
}

export type Final = { emoji: string; text: string; buttons?: Btn[] }
export type JobLine = { job_id: string; title: string; url?: string; stage?: Stage; details: Partial<Record<Stage, string>>; final?: Final }
export type Card = {
  key: string; mode: 'job' | 'multi' | 'plain'; icon: string; title: string; msg?: number; reply_to?: number
  state: 'queued' | 'paused' | 'running' | 'waiting' | 'ended'
  position?: number; started?: number; ended?: number; doing?: string | null; steps?: number
  wait_until?: number; jobs: JobLine[]; final?: Final; note?: string
}

function stepper(j: JobLine, running: boolean): string[] {
  const at = j.stage ? STAGES.indexOf(j.stage) : -1
  return STAGES.map((k, i) => {
    const d = j.details[k] ? ` · <b>${esc(j.details[k])}</b>` : ''
    if (i < at || (i === at && !running && !j.final)) return `✅ ${STAGE_TEXT[k][1]}${d}`
    if (i === at) return k === 'review' ? `🔔 ${STAGE_TEXT[k][0]}` : running ? `⏳ <b>${STAGE_TEXT[k][0]}</b>${d}` : `✅ ${STAGE_TEXT[k][1]}${d}`
    return `▫️ ${note(STAGE_TEXT[k][2])}`
  })
}

const jobLine = (j: JobLine, running: boolean) => {
  if (j.final) return `${j.final.emoji} <b>${esc(short(j.title, 48))}</b>\n     ${note(esc(short(j.final.text, 90)))}`
  const at = j.stage ? STAGE_TEXT[j.stage][0] : 'Starting'
  return `${running ? '⏳' : '▫️'} <b>${esc(short(j.title, 48))}</b>\n     ${note(at + (j.stage && j.details[j.stage] ? ` · ${esc(j.details[j.stage]!)}` : ''))}`
}

export function renderCard(c: Card, now = Date.now()): Page {
  const single = c.mode === 'job' ? c.jobs[0] : undefined
  const title = single ? single.title : c.title
  const lines = [heading(single ? '🏢' : c.icon, esc(short(title, 70)))]
  const running = c.state === 'running'
  if (c.state === 'queued') lines.push(`🕒 Waiting in line${c.position && c.position > 1 ? ` (#${c.position})` : ''}. ${note("I'll start as soon as I'm free.")}`)
  if (c.state === 'paused') lines.push(`⏸ Waiting: the agent is paused. ${note('Resume from Home to continue.')}`)
  if (single) lines.push('', ...stepper(single, running))
  else if (c.jobs.length) lines.push('', ...c.jobs.slice(-12).map(j => jobLine(j, running && !j.final && j === c.jobs.at(-1))), ...(c.jobs.length > 12 ? [note(`…and ${c.jobs.length - 12} earlier`)] : []))
  if (c.note) lines.push('', esc(c.note))
  if (running && c.doing) lines.push('', `↳ ${note(esc(c.doing))}`)
  if (c.state === 'waiting' && c.wait_until) lines.push('', `⏳ <b>Claude usage limit reached.</b>\n${note(`I'll pick this up again automatically at ${clock(c.wait_until)}.`)}`)
  const fin = single?.final ?? c.final
  if (c.state === 'ended' && fin) lines.push('', `${fin.emoji} ${esc(fin.text)}`)
  if (running && c.started) lines.push(note(`⏱ ${elapsed(now - c.started)}${c.steps ? ` · ${c.steps} steps` : ''}`))
  else if (c.state === 'ended' && c.started && c.ended) lines.push(note(`Took ${elapsed(c.ended - c.started)} · finished ${clock(c.ended)}`))

  const rows: Btn[][] = []
  const url = single?.url
  if (c.state !== 'ended') rows.push([...(url ? [{ text: '🔗 Posting', url }] : []), { text: '✋ Stop', data: `x:${c.key}` }])
  else {
    const b = fin?.buttons ?? []
    if (b.length || url) rows.push([...b, ...(url ? [{ text: '🔗 Posting', url }] : [])])
  }
  return { text: lines.join('\n'), rows }
}

// Final line for a job, from its status once the task is over (status.json is the truth, not what the agent said).
export function finalFor(status: string, detail: string, jobId: string): Final | undefined {
  const c = code(jobId), d = detail.trim()
  switch (status) {
    case 'AWAITING_APPROVAL': case 'FILLED_DRY': return { emoji: '🔔', text: 'Ready for your review (below).' }
    case 'NEEDS_ANSWERS': return { emoji: '❓', text: 'I need a few answers from you (below).' }
    case 'SKIPPED': return { emoji: '⏭', text: `Skipped${d ? `: ${d}` : ''}`, buttons: [{ text: '↩ Apply anyway', data: `j:any:${c}` }] }
    case 'CLOSED': return { emoji: '🚪', text: 'This posting is closed. Nothing to do.' }
    case 'NEEDS_HUMAN': return { emoji: '🙋', text: `Needs you${d ? `: ${d}` : ''}`, buttons: [{ text: '🔄 Try again', data: `j:rt:${c}` }] }
    case 'FAILED': return { emoji: '⚠️', text: d || 'Something went wrong.', buttons: [{ text: '🔄 Try again', data: `j:rt:${c}` }] }
    case 'DRY_RUN_DONE': return { emoji: '🧪', text: 'Practice run done. Nothing was sent.' }
    case 'SUBMITTED': return { emoji: '✅', text: 'Applied.' }
    case 'APPROVED': case 'SUBMITTING': return { emoji: '📤', text: 'Approved and on its way.' }
  }
  return undefined
}

// ---- Delivery: throttled edits, persisted so a restart keeps editing the same messages ----

const FILE = join(DATA, 'cards.json')
const MIN_GAP = 2500

export function createCards(api: Api, to: () => number | null) { // cards never make a sound: progress is FYI
  const cards = new Map<string, Card>(Object.entries(readJson<Record<string, Card>>(FILE, {})))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastEdit = new Map<string, number>()
  const lastText = new Map<string, string>()
  const save = () => {
    const keep = [...cards.values()].sort((a, b) => (b.started ?? 0) - (a.started ?? 0)).slice(0, 60) // recent ones only
    writeJson(FILE, Object.fromEntries(keep.map(c => [c.key, c])))
  }

  async function flush(key: string) {
    timers.delete(key)
    const c = cards.get(key), chat = to()
    if (!c || chat == null) return
    const p = renderCard(c)
    const opts = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: kb(p) }
    if (lastText.get(key) === p.text + JSON.stringify(p.rows)) return
    lastEdit.set(key, Date.now())
    try {
      if (c.msg) await api.editMessageText(chat, c.msg, p.text, opts)
      else {
        const m = await api.sendMessage(chat, p.text, { ...opts, disable_notification: true, ...(c.reply_to ? { reply_parameters: { message_id: c.reply_to, allow_sending_without_reply: true } } : {}) })
        c.msg = m.message_id
        save()
      }
      lastText.set(key, p.text + JSON.stringify(p.rows))
    } catch (e) {
      const s = String(e)
      if (/not modified/i.test(s)) lastText.set(key, p.text + JSON.stringify(p.rows))
      else if (/not found|can't be edited/i.test(s)) { c.msg = undefined; schedule(key) } // the user deleted it: send a fresh one
      else log(`card ${key}: ${s.slice(0, 120)}`)
    }
  }

  function schedule(key: string, now = false) {
    if (timers.has(key)) return
    const wait = now ? 0 : Math.max(0, MIN_GAP - (Date.now() - (lastEdit.get(key) ?? 0)))
    timers.set(key, setTimeout(() => void flush(key), wait))
  }

  function update(key: string, f: (c: Card) => void, init?: () => Card) {
    let c = cards.get(key)
    if (!c) { if (!init) return; c = init(); cards.set(key, c) }
    f(c)
    if (c.state === 'ended') save()
    schedule(key, !c.msg)
  }

  // Running cards tick their timer every few seconds while nothing else changes.
  setInterval(() => { for (const c of cards.values()) if (c.state === 'running') schedule(c.key) }, 10_000).unref()

  return {
    update,
    get: (key: string) => cards.get(key),
    all: () => [...cards.values()],
    forJob: (jobId: string) => [...cards.values()].filter(c => c.jobs.some(j => j.job_id === jobId)).sort((a, b) => (b.started ?? 0) - (a.started ?? 0))[0],
    save,
  }
}
export type Cards = ReturnType<typeof createCards>
