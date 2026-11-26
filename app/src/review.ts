// Review-and-approve gate. This module is the ONLY writer of approval.json, and the only caller of `jobagent submit`.
// Approval is bound to the plan hash: if anything changed after the review was built, Approve refuses and the review is rebuilt.
import { InputFile, type Api } from 'grammy'
import { existsSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { allJobs, code, findJob, jobDir, jobIds, JOB_RE, logDecision } from './jobs'
import { readSection } from './profile'
import { breakdownLines, clock, esc, heading, kb, mustHaveLine, note, pairs, plural, quote, short, splitMsg, type Btn, type Page } from './kit'
import type { Breakdown, MustHave } from './jobs'
import { runJobagent, type Run } from './runner'
import { log, logError, loadSettings, practiceOn, readJson, trySettingsUpdate, writeJson, type Settings } from './state'

export type Answer = { fid: string; label: string; value: string; source: string; sensitive: boolean; required: boolean }
export type Review = {
  job_id: string; plan_hash: string; ats: string; company: string; role: string; location: string; salary: string; score: number | null
  reasons: string[]; dealbreakers: string[]; answers: Answer[]; unusual: string[]; generated_sensitive: string[]; files: string[]; injection_suspected?: boolean
  breakdown?: Breakdown; must_haves?: MustHave[]; coverage?: { before?: number; after?: number; missing?: string[] }
  resume: { edits: number; reorders: number; fallback: boolean; verified: boolean; ats?: boolean; versions_used?: number; versions_total?: number }; screenshots: string[]; url: string
  changes?: { old: string; new: string; reason: string }[]; cover_letter?: string; previews?: string[]
}
export type Change = NonNullable<Review['changes']>[number]

// "<s>old</s> → <b>new</b>" lines for the resume edits; fits `max` characters, the rest stays behind a button.
export function changeLines(changes: Change[], max: number): { text: string; shown: number } {
  const out: string[] = []
  let used = 0
  for (const c of changes) {
    const line = `<s>${esc(cut(c.old, 140))}</s>\n→ <b>${esc(cut(c.new, 140))}</b>${c.reason ? `\n${note(esc(cut(c.reason, 100)))}` : ''}`
    if (used + line.length > max) break
    out.push(line)
    used += line.length + 2
  }
  return { text: out.join('\n\n'), shown: out.length }
}

// ---- Card ----

const SRC: Record<string, string> = { profile: '👤', generated: '✍️', user: '💬', document: '📎' }
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const scorePill = (n: number | null) => (n == null ? '' : n >= 80 ? `🟢 ${n}/100` : n >= 60 ? `🟡 ${n}/100` : `🟠 ${n}/100`)

export function reviewText(rv: Review, practice: boolean, extra?: string): string {
  const head = [
    heading('📋', `${esc(rv.company || 'Unknown company')} · ${esc(rv.role || 'Unknown role')}`),
    [rv.score != null && `Match ${scorePill(rv.score)}`, rv.location && `📍 ${esc(rv.location)}`, rv.salary && `💵 ${esc(rv.salary)}`].filter(Boolean).join('  ·  '),
    ...breakdownLines(rv.breakdown ?? {}).map(l => note(l)),
    '',
    ...(rv.must_haves?.length ? [`<b>They require</b> ${mustHaveLine(rv.must_haves)}`] : []),
    ...(rv.coverage?.after != null ? [`🔑 Keywords on your resume: ${rv.coverage.before}% → <b>${rv.coverage.after}%</b>${rv.coverage.missing?.length ? note(` · missing: ${esc(rv.coverage.missing.join(', '))}`) : ''}`] : []),
    ...(rv.reasons.length ? [`<b>Why it fits</b>`, ...rv.reasons.map(r => `• ${esc(r)}`)] : []),
    ...(rv.dealbreakers.length ? [`⚠️ <b>Heads up:</b> ${esc(rv.dealbreakers.join('; '))}`] : []),
    ...(rv.unusual.length ? [`⚠️ <b>Unusual fields</b> (left blank, never filled automatically): ${esc(rv.unusual.join(', '))}`] : []),
  ]
  const r = rv.resume
  const tail = [
    r.fallback ? '📄 <b>Resume:</b> your original, unchanged ' + note('(tailoring did not pass the layout check)')
      : r.ats ? `📄 <b>Resume:</b> rebuilt for hiring software${(r.versions_total ?? 1) > 1 ? ` from ${r.versions_used} of your ${r.versions_total} versions` : ''}, ${plural(r.edits, 'line')} reworded${r.verified ? ', reads back cleanly ✓' : ' ⚠️ not verified'}`
      : `📄 <b>Resume:</b> ${r.edits ? `${r.edits} line${r.edits === 1 ? '' : 's'} reworded` : 'unchanged'}${r.reorders ? `, ${r.reorders} section${r.reorders === 1 ? '' : 's'} reordered` : ''}${r.verified ? ', layout checked ✓' : ' ⚠️ layout not verified'}`,
    rv.files.length ? `📎 <b>Attached:</b> ${rv.files.map(esc).join(', ')}` : '',
    '',
    practice ? `🧪 ${note('Practice mode is on: approving records a practice run and sends nothing.')}` : '🚀 <b>Approving sends this application to the employer.</b>',
    extra ?? '',
  ].filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''))
  const legend = note('👤 from your profile · 💬 you told me · ✍️ drafted by me · 📎 file · 🔒 private')
  const ch = changeLines(rv.changes ?? [], 1100)
  const extras = [
    ...(ch.shown ? ['', `<b>📝 What I changed on your resume</b>${ch.shown < (rv.changes ?? []).length ? note(` (${ch.shown} of ${rv.changes!.length})`) : ''}`, quote(ch.text, true)] : []),
    ...(rv.cover_letter ? ['', '<b>✉️ Cover letter</b>', quote(esc(cut(rv.cover_letter, 800)), true)] : []),
  ]
  let budget = 3800 - [...head, ...tail, ...extras, legend].join('\n').length
  const rows: string[] = []
  for (const [i, a] of rv.answers.entries()) {
    const v = cut(a.value, 80)
    const line = `${a.sensitive ? '🔒' : (SRC[a.source] ?? '👤')} ${esc(cut(a.label, 50))}\n      <b>${a.sensitive ? `<tg-spoiler>${esc(v)}</tg-spoiler>` : esc(v)}</b>`
    if (budget - line.length < 80) { rows.push(note(`…and ${rv.answers.length - i} more in the screenshot`)); break }
    budget -= line.length + 1
    rows.push(line)
  }
  return [...head, '', `<b>🧾 What I filled in (${rv.answers.length})</b>`, legend, quote(rows.join('\n') || '—', true), ...extras, '', ...tail].join('\n')
}

export const editable = (rv: Review) => rv.answers.filter(a => a.source !== 'document')

export function reviewPage(rv: Review, practice: boolean, extra?: string): Page {
  const c = code(rv.job_id)
  const more = changeLines(rv.changes ?? [], 1100).shown < (rv.changes ?? []).length
  return {
    text: reviewText(rv, practice, extra),
    rows: [
      [{ text: practice ? '✅ Approve (practice)' : '✅ Approve & send', data: `r:ok:${c}`, style: 'success' }],
      [...(editable(rv).length ? [{ text: '✏️ Edit an answer', data: `r:ea:${c}` }] : []), { text: '💬 Ask for a change', data: `r:ch:${c}` }],
      [...(rv.resume.fallback ? [] : [{ text: '📄 Use my original', data: `r:or:${c}` }]), { text: '📎 Files', data: `r:fl:${c}` }, ...(more ? [{ text: '📝 All changes', data: `r:df:${c}` }] : [])],
      ...(rv.coverage?.missing?.length ? [[{ text: '✋ I have a missing skill', data: `r:hv:${c}` }]] : []),
      [{ text: '⏭ Skip', data: `r:sk:${c}` }, { text: '🚫 Never this company', data: `r:nv:${c}`, style: 'danger' }],
      ...(rv.url ? [[{ text: '🔗 Open posting', url: rv.url }]] : []),
    ],
  }
}

// Pick which answer to edit (quick edits never start a Claude task).
export function editListPage(rv: Review): Page {
  const c = code(rv.job_id), list = editable(rv).slice(0, 24)
  return {
    text: [heading('✏️', 'Which answer should I change?'), `${esc(rv.company)} · ${esc(rv.role)}`, '',
      ...list.map((a, i) => `<b>${i + 1}.</b> ${esc(cut(a.label, 60))}\n      ${a.sensitive ? note('🔒 private') : note(esc(cut(a.value, 60)))}`),
      '', note('I update the form and show you a fresh review in a moment. For anything else (like the cover letter), tap Ask for a change.')].join('\n'),
    rows: [...pairs(list.map((_, i) => ({ text: String(i + 1), data: `r:ea:${c}:${i}` })), 6), [{ text: '✖ Cancel', data: `r:rv:${c}` }]],
  }
}

// A typed answer for one plan row: checkboxes take yes/no, selects must name one of the field's options (any case). Pure.
export function editValue(row: { action: string; value: unknown }, options: string[], text: string): unknown | { error: string } {
  const v = text.trim()
  if (row.action === 'check') return /^(yes|y|true)$/i.test(v) ? true : /^(no|n|false)$/i.test(v) ? false : { error: 'Please answer yes or no.' }
  if (row.action === 'select' && options.length) {
    const pick = (x: string) => options.find(o => o.toLowerCase() === x.trim().toLowerCase())
    const parts = (Array.isArray(row.value) ? v.split(',') : [v]).map(pick)
    if (parts.some(x => !x)) return { error: `Please send one of: ${options.slice(0, 12).join(' · ')}${options.length > 12 ? ' …' : ''}` }
    return Array.isArray(row.value) ? parts : parts[0]
  }
  return v ? v.slice(0, 2000) : { error: 'Send the new answer as a message.' }
}

// ---- Auto-apply gates (every one checked in code) ----

export function autoGate(rv: Review, s: Settings): string | null {
  if (s.apply.mode !== 'auto') return 'you review every application'
  if (!s.agent_on) return 'the agent is paused'
  if (rv.score == null || rv.score < s.apply.auto_min_score) return `the match (${rv.score ?? '?'}) is below your auto-apply score of ${s.apply.auto_min_score}`
  if (rv.ats === 'generic') return 'unfamiliar form types always need your review'
  if (rv.unusual.length) return 'the form has unusual fields'
  if (rv.generated_sensitive.length) return 'a private answer was drafted rather than given by you'
  if (rv.injection_suspected) return 'the posting contained text that tried to give me instructions'
  return null
}

// ---- Startup recovery (pure) ----

export type RecoverJob = { id: string; status: string; scheduled_for?: string; auto: boolean }
export type RecoverAction = { id: string; do: 'needs_human' | 'submit_now' | 'submit_at' | 'resend_review'; at?: number }
export function planRecovery(jobs: RecoverJob[], now: number): RecoverAction[] {
  const out: RecoverAction[] = []
  for (const j of jobs) {
    if (j.status === 'SUBMITTING') out.push({ id: j.id, do: 'needs_human' }) // never re-submit on our own
    else if (j.status === 'APPROVED') {
      const at = j.scheduled_for ? Date.parse(j.scheduled_for) : NaN
      out.push(at > now ? { id: j.id, do: 'submit_at', at } : { id: j.id, do: 'submit_now' })
    } else if (j.status === 'AWAITING_APPROVAL' && j.auto) out.push({ id: j.id, do: 'resend_review' }) // a countdown cannot survive a restart: ask normally
  }
  return out
}

// ---- Wiring ----

export type JobPending = { job: string; chat: number; msg: number; at: number } & ({ kind: 'change' } | { kind: 'code' } | { kind: 'edit'; fid: string })
export type Deps = {
  api: Api
  to: () => number | null
  silent: () => boolean
  refresh: () => void
  revise: (jobId: string, request: string) => void
  onResult: (jobId: string, status: string, detail: string) => void
  setPending: (p: JobPending | null) => void
  run?: Run // tests inject a fake `jobagent`
}
const OPTS = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } }
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export function createReview(d: Deps) {
  const run = d.run ?? runJobagent
  const grace = new Map<string, { timer: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval> }>()
  const later = new Map<string, ReturnType<typeof setTimeout>>()
  const queue: string[] = []
  let running = false
  const asked = new Set<string>()
  const readReview = (id: string) => readJson<Review | null>(join(jobDir(id), 'review.json'), null)
  const say = (text: string, loud = false, rows: Btn[][] = []) => {
    const to = d.to()
    if (to != null) void d.api.sendMessage(to, text, { ...OPTS, disable_notification: !loud || d.silent(), reply_markup: kb(rows) }).catch(e => log(`send failed: ${e}`))
  }
  const name = (id: string) => { const r = readReview(id); return r ? `${esc(r.company)} · ${esc(r.role)}` : esc(id) }

  // ---- submit queue: one `jobagent submit` at a time ----
  let submitting: string | null = null // the one job `jobagent submit` is running for (it may ask for an emailed code)
  async function submitOne(id: string) {
    submitting = id
    const r = await run(['submit', id]).finally(() => { submitting = null })
    if (r.code === 'company_cooldown') {
      schedule(id, Date.parse(r.next_allowed_at))
      say(`${heading('⏳', 'Approved, sending later')}\n${name(id)}\n${note(`You applied to this company recently, so I'll send it at ${clock(Date.parse(r.next_allowed_at))} to space things out.`)}`)
      return
    }
    const st = r.ok ? r.status : r.code === 'needs_human' || r.code === 'not_confirmed' ? 'NEEDS_HUMAN' : 'FAILED'
    const detail = String(r.error ?? '')
    if (st === 'DRY_RUN_DONE') say(`${heading('🧪', 'Practice run done')}\n${name(id)}\n${note('Everything worked up to the Submit button. Nothing was sent.')}\n\nWhen you're ready for real applications, turn practice mode off in Settings, then tap Apply for real.`, false,
      [[{ text: '🚀 Apply for real', data: `j:go:${code(id)}`, style: 'success' }, { text: '🧾 Practice receipt', data: `j:rc:${code(id)}` }], [{ text: '📋 Jobs', data: 'J:a:0' }, { text: '🏠 Home', data: 'm:home' }]])
    else if (st === 'SUBMITTED') {
      say(`${heading('🎉', 'Application sent')}\n${name(id)}\n${note('Look out for a confirmation email from the company. Your receipt is under Jobs → Applied.')}`, true, [[{ text: '🧾 Receipt', data: `j:rc:${code(id)}` }]])
      const shot = join(jobDir(id), 'screenshots', 'submitted.png'), to = d.to()
      if (to != null && existsSync(shot)) void d.api.sendPhoto(to, new InputFile(shot), { caption: '🧾 The confirmation page', disable_notification: true }).catch(e => log(`receipt shot failed: ${e}`))
    }
    else say(`${heading('🙋', 'This one needs you')}\n${name(id)}\n${esc(short(detail || 'The application could not be sent.', 300))}`, true, [[{ text: '📥 Open in Jobs', data: `j:v:${code(id)}` }]])
    d.onResult(id, st, detail)
    d.refresh()
  }
  async function pump() {
    if (running) return
    running = true
    try { while (queue.length) await submitOne(queue.shift()!).catch(e => logError('submit failed', e)) } finally { running = false }
  }
  const enqueue = (id: string) => { if (!queue.includes(id)) queue.push(id); void pump() }
  function schedule(id: string, at: number, now = Date.now()) {
    const file = join(jobDir(id), 'approval.json')
    writeJson(file, { ...readJson<object>(file, {}), scheduled_for: new Date(at).toISOString() })
    clearTimeout(later.get(id))
    later.set(id, setTimeout(() => { later.delete(id); enqueue(id) }, Math.max(0, at - now)))
  }

  // The bot gate already checked the press came from the paired user.
  async function approve(id: string, mode: 'manual' | 'auto'): Promise<string | null> {
    const rv = readReview(id)
    const g = await run(['job', 'get', id])
    if (!rv || !g.ok || g.status !== 'AWAITING_APPROVAL') return 'This application is no longer waiting for approval.'
    const h = await run(['review', 'hash', id])
    if (!h.ok || h.plan_hash !== rv.plan_hash) {
      d.revise(id, 'SYSTEM: the plan or its files changed after the review was built. Re-run the dry fill, rebuild the review and send it again.')
      return 'Something changed since you saw this review, so I am rebuilding it. You will get a fresh one to approve.'
    }
    writeJson(join(jobDir(id), 'approval.json'), { plan_hash: rv.plan_hash, approved_at: new Date().toISOString(), mode })
    const s = await run(['job', 'set-status', id, 'APPROVED'])
    if (!s.ok) return `Could not approve: ${s.error}`
    enqueue(id)
    d.refresh()
    return null
  }

  function autoText(rv: Review, at: number, practice: boolean, now = Date.now()) {
    return [
      heading('🚀', `Auto-applying in ${mmss(at - now)}`),
      `<b>${esc(rv.company)} · ${esc(rv.role)}</b>`,
      [rv.score != null && `Match ${scorePill(rv.score)}`, rv.location && `📍 ${esc(rv.location)}`, rv.salary && `💵 ${esc(rv.salary)}`].filter(Boolean).join('  ·  '),
      ...(rv.reasons.length ? ['', ...rv.reasons.slice(0, 2).map(r => `• ${esc(r)}`)] : []),
      '', note(practice ? 'Practice mode is on: nothing will be sent.' : 'Tap Cancel to stop it, or Review to see everything first.'),
    ].join('\n')
  }
  function startAuto(id: string, rv: Review, msg: number) {
    const s = loadSettings(), at = Date.now() + s.apply.auto_grace_seconds * 1000, c = code(id), to = d.to()!
    writeJson(join(jobDir(id), 'auto.json'), { fire_at: new Date(at).toISOString() })
    const rows: Btn[][] = [[{ text: '✋ Cancel', data: `r:cx:${c}`, style: 'danger' }, { text: '👀 Review first', data: `r:rv:${c}` }]]
    const tick = setInterval(() => void d.api.editMessageText(to, msg, autoText(rv, at, practiceOn(loadSettings())), { ...OPTS, reply_markup: kb(rows) }).catch(() => {}), 15_000)
    grace.set(id, { timer: setTimeout(() => void fireAuto(id, msg), s.apply.auto_grace_seconds * 1000), tick })
    return { at, rows }
  }
  async function fireAuto(id: string, msg: number) {
    const g = grace.get(id)
    if (!g) return
    clearInterval(g.tick); grace.delete(id)
    rmSync(join(jobDir(id), 'auto.json'), { force: true })
    const s = loadSettings(), rv = readReview(id), to = d.to()
    const why = !rv ? 'the review is gone' : autoGate(rv, s) // check again at the moment of truth: paused, settings changed...
    const err = why ?? (await approve(id, 'auto'))
    const text = err ? `${heading('✋', 'Auto-apply stopped')}\n${name(id)}\n${note(esc(err))}` : `${heading('🚀', 'Auto-applied')}\n${name(id)}`
    if (to != null) await d.api.editMessageText(to, msg, text, { ...OPTS, reply_markup: kb(err && rv ? [[{ text: '👀 Review', data: `r:rv:${code(id)}` }]] : []) }).catch(() => {})
  }
  function cancelAuto(id: string) {
    const g = grace.get(id)
    if (g) { clearTimeout(g.timer); clearInterval(g.tick); grace.delete(id) }
    rmSync(join(jobDir(id), 'auto.json'), { force: true })
    return !!g
  }

  // Silent pictures before the card (resume page 1, the filled form), so the user can judge without opening a file.
  async function sendPreviews(id: string, rv: Review) {
    const to = d.to()!
    const pics = (rv.previews ?? []).map(f => join(jobDir(id), f)).filter(existsSync)
    if (!pics.length) return sendFiles(id, rv) // an older review: the files themselves
    const cap = (p: string) => (p.endsWith('resume.png') ? '📄 Your resume for this job (page 1)' : '🖼 The filled-in form')
    if (pics.length > 1) await d.api.sendMediaGroup(to, pics.map(p => ({ type: 'photo' as const, media: new InputFile(p), caption: cap(p) })), { disable_notification: true }).catch(e => log(`previews failed: ${e}`))
    else await d.api.sendPhoto(to, new InputFile(pics[0]), { caption: cap(pics[0]), disable_notification: true }).catch(e => log(`preview failed: ${e}`))
  }
  async function sendFiles(id: string, rv: Review) {
    const to = d.to()!
    const docs = rv.files.map(f => join(jobDir(id), basename(f))).filter(existsSync)
    if (docs.length > 1) await d.api.sendMediaGroup(to, docs.map(p => ({ type: 'document' as const, media: new InputFile(p) })), { disable_notification: true }).catch(e => log(`album failed: ${e}`))
    else if (docs.length) await d.api.sendDocument(to, new InputFile(docs[0]), { disable_notification: true }).catch(e => log(`attach failed: ${e}`))
  }

  // tg_review: show the review card (or the auto-apply countdown) for a job with a fresh review.json.
  // `digest`: a job auto-search prepared. Its review waits in the queue and the search's digest announces it,
  // instead of one loud message per job. (The auto-apply countdown still runs on its own.)
  async function send(id: string, digest = false): Promise<string> {
    const to = d.to()
    if (to == null) throw new Error('not paired yet')
    if (!JOB_RE.test(id)) throw new Error('bad job_id')
    const rv = readReview(id)
    if (!rv) throw new Error('review.json is missing: run `jobagent review build` first')
    const g = await run(['job', 'get', id])
    if (!g.ok || (g.status !== 'FILLED_DRY' && g.status !== 'AWAITING_APPROVAL')) throw new Error(`job is ${g.status ?? 'unknown'}: it must be FILLED_DRY (run fill --dry-run, then review build)`)
    const h = await run(['review', 'hash', id])
    if (!h.ok || h.plan_hash !== rv.plan_hash) throw new Error('review.json is stale (plan.json or an upload changed): re-run fill --dry-run and review build')
    if (g.status === 'FILLED_DRY') { const s = await run(['job', 'set-status', id, 'AWAITING_APPROVAL']); if (!s.ok) throw new Error(String(s.error)) }
    const s = loadSettings(), practice = practiceOn(s)
    const why = s.apply.mode === 'auto' ? autoGate(rv, s) : null
    if (digest && !(s.apply.mode === 'auto' && why === null)) { d.refresh(); return 'review ready: it goes into the review queue and the search digest. Stop now.' }
    await sendPreviews(id, rv)
    if (s.apply.mode === 'auto' && why === null) {
      const m = await d.api.sendMessage(to, autoText(rv, Date.now() + s.apply.auto_grace_seconds * 1000, practice), { ...OPTS, disable_notification: d.silent() || s.notify.reviews !== 'loud' })
      const { at, rows } = startAuto(id, rv, m.message_id)
      await d.api.editMessageText(to, m.message_id, autoText(rv, at, practice), { ...OPTS, reply_markup: kb(rows) }).catch(() => {})
      d.refresh()
      return 'auto-apply countdown started'
    }
    const p = reviewPage(rv, practice, why && s.apply.mode === 'auto' ? note(`Not auto-applied: ${esc(why)}.`) : undefined)
    await d.api.sendMessage(to, p.text, { ...OPTS, reply_markup: kb(p), disable_notification: d.silent() || loadSettings().notify.reviews !== 'loud' })
    d.refresh()
    return 'review sent'
  }

  // Buttons r:<action>:<code8>. Returns the new card, or a toast.
  async function press(act: string, c: string, chat: number, msg: number, arg?: string): Promise<Page | string | undefined> {
    const id = findJob(c)
    const rv = id ? readReview(id) : null
    if (!id || !rv) return 'That review no longer exists.'
    const practice = practiceOn(loadSettings())
    const more = allJobs().some(j => j.status === 'AWAITING_APPROVAL' && j.id !== id)
    const done = (emoji: string, title: string, line: string): Page => ({
      text: `${heading(emoji, title)}\n${esc(rv.company)} · ${esc(rv.role)}\n${line}`,
      rows: [...(more ? [[{ text: '▶ Next review', data: 'Q:0', style: 'success' as const }]] : []), [{ text: '📋 Jobs', data: 'J:a:0' }, { text: '🏠 Home', data: 'm:home' }]],
    })
    if (act === 'rv') { cancelAuto(id); return reviewPage(rv, practice) }
    if (act === 'ss') {
      const p = join(jobDir(id), 'screenshots', 'filled.png')
      if (!existsSync(p)) return 'No screenshot for this one.'
      await d.api.sendDocument(chat, new InputFile(p, 'form.png'), { caption: `The filled-in form for ${rv.company} · ${rv.role}`, disable_notification: true }).catch(e => log(`screenshot failed: ${e}`))
      return '🖼 Sent below'
    }
    if (act === 'fl') { await sendFiles(id, rv); return '📎 Sent below' }
    if (act === 'df') {
      const all = changeLines(rv.changes ?? [], 1e9).text
      for (const part of splitMsg(`${heading('📝', 'Every change to your resume')}\n${esc(rv.company)} · ${esc(rv.role)}\n\n${all}`, 3900)) await d.api.sendMessage(chat, part, { ...OPTS, disable_notification: true }).catch(e => log(`send failed: ${e}`))
      return '📝 Sent below'
    }
    if (act === 'ea') {
      if (arg === undefined) return editListPage(rv)
      const a = editable(rv)[parseInt(arg, 10)]
      if (!a) return 'That answer is no longer on the form.'
      d.setPending({ kind: 'edit', job: id, fid: a.fid, chat, msg, at: Date.now() })
      return {
        text: `${heading('✏️', esc(cut(a.label, 80)))}\n\nNow: ${a.sensitive ? `<tg-spoiler>${esc(a.value)}</tg-spoiler>` : `<b>${esc(a.value)}</b>`}\n\nSend the new answer as a message.`,
        rows: [[{ text: '✖ Cancel', data: `r:ea:${c}` }]],
      }
    }
    if (act === 'hv') {
      const miss = rv.coverage?.missing ?? []
      if (arg == null) return {
        text: `${heading('✋', 'Which of these do you really have?')}\n${esc(rv.company)} · ${esc(rv.role)}\n\n${miss.map((x, i) => `<b>${i + 1}.</b> ${esc(x)}`).join('\n')}\n\n${note('I add it to your profile as a confirmed skill and rework the resume to mention it. Only pick what is true.')}`,
        rows: [...pairs(miss.map((_, i) => ({ text: String(i + 1), data: `r:hv:${c}:${i}` })), 6), [{ text: '✖ Cancel', data: `r:rv:${c}` }]],
      }
      const skill = miss[parseInt(arg, 10)]
      if (!skill) return 'That one is gone. Open the review again.'
      if (busy.has(id)) return 'Already updating it…'
      const have = (readSection('Confirmed skills').confirmed ?? '').split(',').map(x => x.trim()).filter(Boolean)
      const list = [...new Set([...have, skill.replace(/[,\n]/g, ' ').trim()])].join(', ')
      if (list.length > 300) return 'Your confirmed skills list is full. Edit it in your profile first.'
      const r = await run(['profile', 'set-field', 'Confirmed skills', 'confirmed', list])
      if (!r.ok) return `Could not save it: ${r.error}`
      cancelAuto(id)
      d.revise(id, `SYSTEM: the user confirmed a skill from the review's missing keywords; it is the last item of "confirmed" under "## Confirmed skills" in profile.md. Re-tailor the resume so it truthfully mentions it where it fits, re-run the dry fill, rebuild the review and send it again.`)
      return done('✋', 'Got it', note('Saved to your profile. I am reworking the resume; a fresh review follows.'))
    }
    if (act === 'or') {
      if (busy.has(id)) return 'Already updating it…'
      cancelAuto(id)
      void rebuild(id, chat, msg, 'the resume to your original one', async () => {
        const r = await run(['tailor', id, '--fallback'])
        return r.ok ? null : 'I could not switch to your original resume.'
      })
      return updatingPage(rv, 'Switching to your original resume')
    }
    if (act === 'cx') {
      cancelAuto(id)
      return { ...done('✋', 'Auto-apply cancelled', note('Nothing was sent. It is waiting for you in Jobs.')), rows: [[{ text: '👀 Review it', data: `r:rv:${c}` }, { text: '🏠 Home', data: 'm:home' }]] }
    }
    if (act === 'ok') {
      cancelAuto(id)
      const err = await approve(id, 'manual')
      if (!err) logDecision(id, 'approve')
      return err ?? done('✅', practice ? 'Approved (practice)' : 'Approved', note(practice ? 'Running it as practice: nothing is sent.' : 'Sending it now. I will tell you when it is in.'))
    }
    if (act === 'ch') {
      d.setPending({ kind: 'change', job: id, chat, msg, at: Date.now() })
      return {
        text: `${heading('✏️', 'What should I change?')}\n${esc(rv.company)} · ${esc(rv.role)}\n\nSend me a message, for example:\n${quote('Make the cover letter shorter\nSay I can start in 2 weeks\nUse my original resume')}`,
        rows: [[{ text: '✖ Cancel', data: `r:rv:${c}` }]],
      }
    }
    if (act === 'nv') { // one confirm step: it changes what I apply to from now on
      cancelAuto(id)
      return { text: `${heading('🚫', `Never apply to ${esc(rv.company)}?`)}\n${note('I skip this job and every future job there. You can undo it under Settings → What I look for → Companies to avoid.')}`,
        rows: [[{ text: '🚫 Yes, never', data: `r:nx:${c}`, style: 'danger' }, { text: '↩ Keep reviewing', data: `r:rv:${c}` }]] }
    }
    if (act === 'nx') act = 'nv'
    if (act === 'sk' || act === 'nv') {
      cancelAuto(id)
      if (act === 'nv' && rv.company) {
        const have = loadSettings().filters.company_blocklist
        if (!have.some(x => x.toLowerCase() === rv.company.toLowerCase())) trySettingsUpdate({ filters: { company_blocklist: [...have, rv.company] } })
      }
      const s = await run(['job', 'set-status', id, 'SKIPPED', '--detail', act === 'nv' ? 'never this company' : 'you skipped it'])
      if (s.ok) logDecision(id, act === 'nv' ? 'never' : 'skip')
      d.refresh()
      return s.ok ? done(act === 'nv' ? '🚫' : '⏭', act === 'nv' ? 'Never this company' : 'Skipped', note(act === 'nv' ? `I won't apply to ${esc(rv.company)} again. Undo under Settings → What I look for → Companies to avoid.` : 'Skipped.')) : `Could not skip: ${s.error}`
    }
    return undefined
  }

  // ---- Quick edits: the app changes plan.json itself and replays the dry fill; no Claude task ----
  const busy = new Set<string>()
  const updatingPage = (rv: Review, what: string): Page => ({ text: `${heading('⏳', `${what}…`)}\n${esc(rv.company)} · ${esc(rv.role)}\n${note('Filling in the form again. A fresh review arrives in a moment.')}`, rows: [] })
  // `change` runs first (edit plan.json, switch the resume); then READY -> dry fill -> review build -> a fresh card.
  // Anything unexpected goes to Claude (revise) with the reason, so the user is never left stuck.
  async function rebuild(id: string, chat: number, msg: number, what: string, change: () => Promise<string | null>) {
    busy.add(id)
    try {
      const g = await run(['job', 'get', id])
      if (!g.ok || g.status !== 'AWAITING_APPROVAL') return void d.api.editMessageText(chat, msg, note('This application is no longer waiting for review.'), OPTS).catch(() => {})
      const err = await change()
      if (err) return void d.api.editMessageText(chat, msg, `${heading('⚠️', 'Nothing changed')}\n${esc(err)}`, { ...OPTS, reply_markup: kb([[{ text: '👀 Back to the review', data: `r:rv:${code(id)}` }]]) }).catch(() => {})
      const steps: [string[], number?][] = [[['job', 'set-status', id, 'READY', '--detail', `you changed ${what}`]], [['fill', id, '--dry-run'], 5 * 60_000], [['review', 'build', id]]]
      for (const [args, timeoutMs] of steps) {
        const r = await run(args, { timeoutMs })
        if (!r.ok) {
          log(`quick edit ${id}: ${args[0]} -> ${r.code}`)
          d.revise(id, `SYSTEM: the user changed ${what} from the review card, and "jobagent ${args.slice(0, 2).join(' ')}" then failed (${r.code}). Fix what is needed, re-run the dry fill, rebuild the review and send it again.`)
          return void d.api.editMessageText(chat, msg, `${heading('🔧', 'Almost there')}\n${note('The form needs a closer look after that change. I am on it and will send a fresh review.')}`, OPTS).catch(() => {})
        }
      }
      await d.api.editMessageText(chat, msg, `${heading('✅', 'Updated')}\n${note(`I changed ${esc(what)}. The fresh review is below.`)}`, OPTS).catch(() => {})
      await send(id)
    } catch (e) { logError('quick edit failed', e) } finally { busy.delete(id) }
  }

  // Check the typed value fits the field, then rebuild. Returns an error to show, or null once the update started.
  function quickEdit(id: string, fid: string, text: string, chat: number, msg: number): string | null {
    if (busy.has(id)) return 'Already updating it…'
    const rv = readReview(id)
    const fields = readJson<{ fid: string; label: string; type: string; options?: string[] }[]>(join(jobDir(id), 'fields.json'), [])
    const f = fields.find(x => x.fid === fid), planFile = join(jobDir(id), 'plan.json')
    const plan = readJson<{ fields?: { fid: string; action: string; value: unknown; source?: string }[] } | null>(planFile, null)
    const row = plan?.fields?.find(r => r.fid === fid)
    if (!rv || !f || !row) return 'That answer is no longer on the form.'
    const value = editValue(row, f.options ?? [], text)
    if (typeof value === 'object' && value && 'error' in value) return (value as { error: string }).error
    cancelAuto(id)
    void rebuild(id, chat, msg, `"${cut(f.label, 60)}"`, async () => {
      row.value = value
      row.source = 'user'
      writeJson(planFile, plan)
      const mine = join(jobDir(id), 'answers.json') // the user's own answers win when the plan is built again (plan build)
      writeJson(mine, { ...readJson<Record<string, unknown>>(mine, {}), [fid]: value })
      return null
    })
    void d.api.editMessageText(chat, msg, updatingPage(rv, 'Updating your answer').text, OPTS).catch(() => {})
    return null
  }

  // Email-code relay: `jobagent submit` writes needs_input.json and waits for input.json.
  function watchInput() {
    for (const id of submitting ? [submitting] : []) {
      const n = readJson<{ kind?: string; at?: number } | null>(join(jobDir(id), 'needs_input.json'), null)
      const key = `${id}:${n?.at}`
      if (!n || n.kind !== 'email_code' || asked.has(key) || d.to() == null) continue
      asked.add(key)
      const to = d.to()!
      void d.api.sendMessage(to, `${heading('🔐', 'Verification code needed')}\n${name(id)}\n\nThe company just emailed you a security code. Paste it here within 10 minutes and I'll finish the application.`, OPTS)
        .then(m => d.setPending({ kind: 'code', job: id, chat: to, msg: m.message_id, at: Date.now() })).catch(e => log(`send failed: ${e}`))
    }
  }
  function submitCode(id: string, text: string): string | null {
    const v = text.trim()
    if (!/^[A-Za-z0-9]{4,12}$/.test(v)) return 'That does not look like a code. Paste only the code itself.'
    writeJson(join(jobDir(id), 'input.json'), { value: v })
    return null
  }

  async function recover() {
    const jobs: RecoverJob[] = jobIds().map(id => ({
      id, status: readJson<{ status?: string }>(join(jobDir(id), 'status.json'), {}).status ?? '',
      scheduled_for: readJson<{ scheduled_for?: string }>(join(jobDir(id), 'approval.json'), {}).scheduled_for,
      auto: existsSync(join(jobDir(id), 'auto.json')),
    }))
    for (const a of planRecovery(jobs, Date.now())) {
      if (a.do === 'needs_human') {
        await run(['job', 'set-status', a.id, 'NEEDS_HUMAN', '--detail', 'the app closed while sending: it may or may not have gone out, check your email'])
        say(`${heading('⚠️', 'Please check your email')}\n${name(a.id)}\n${note('The app closed while this application was being sent. It may or may not have gone out. I will not retry on my own.')}`, true)
      } else if (a.do === 'submit_at') schedule(a.id, a.at!)
      else if (a.do === 'submit_now') enqueue(a.id)
      else { rmSync(join(jobDir(a.id), 'auto.json'), { force: true }); await send(a.id).catch(e => log(`resend failed: ${e}`)) }
    }
  }

  setInterval(watchInput, 3000).unref()
  return { send, press, approve, submitCode, quickEdit, recover, cancelAuto, readReview, _grace: grace, _later: later, _fireAuto: fireAuto }
}
export type ReviewGate = ReturnType<typeof createReview>
