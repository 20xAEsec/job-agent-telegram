// Review-and-approve gate. This module is the ONLY writer of approval.json, and the only caller of `jobagent submit`.
// Approval is bound to the plan hash: if anything changed after the review was built, Approve refuses and the review is rebuilt.
import { InputFile, type Api } from 'grammy'
import { existsSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { code, findJob, jobDir, jobIds, JOB_RE } from './jobs'
import { clock, esc, heading, kb, note, quote, short, type Btn, type Page } from './kit'
import { runJobagent, type Run } from './runner'
import { log, loadSettings, practiceOn, readJson, trySettingsUpdate, writeJson, type Settings } from './state'

export type Answer = { fid: string; label: string; value: string; source: string; sensitive: boolean; required: boolean }
export type Review = {
  job_id: string; plan_hash: string; ats: string; company: string; role: string; location: string; salary: string; score: number | null
  reasons: string[]; dealbreakers: string[]; answers: Answer[]; unusual: string[]; generated_sensitive: string[]; files: string[]
  resume: { edits: number; reorders: number; fallback: boolean; verified: boolean }; screenshots: string[]; url: string
}

// ---- Card ----

const SRC: Record<string, string> = { profile: '👤', generated: '✍️', user: '💬', document: '📎' }
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const scorePill = (n: number | null) => (n == null ? '' : n >= 80 ? `🟢 ${n}/100` : n >= 60 ? `🟡 ${n}/100` : `🟠 ${n}/100`)

export function reviewText(rv: Review, practice: boolean, extra?: string): string {
  const head = [
    heading('📋', `${esc(rv.company || 'Unknown company')} · ${esc(rv.role || 'Unknown role')}`),
    [rv.score != null && `Match ${scorePill(rv.score)}`, rv.location && `📍 ${esc(rv.location)}`, rv.salary && `💵 ${esc(rv.salary)}`].filter(Boolean).join('  ·  '),
    '',
    ...(rv.reasons.length ? [`<b>Why it fits</b>`, ...rv.reasons.map(r => `• ${esc(r)}`)] : []),
    ...(rv.dealbreakers.length ? [`⚠️ <b>Heads up:</b> ${esc(rv.dealbreakers.join('; '))}`] : []),
    ...(rv.unusual.length ? [`⚠️ <b>Unusual fields</b> (left blank, never filled automatically): ${esc(rv.unusual.join(', '))}`] : []),
  ]
  const r = rv.resume
  const tail = [
    r.fallback ? '📄 <b>Resume:</b> your original, unchanged ' + note('(tailoring did not pass the layout check)')
      : `📄 <b>Resume:</b> ${r.edits ? `${r.edits} line${r.edits === 1 ? '' : 's'} reworded` : 'unchanged'}${r.reorders ? `, ${r.reorders} section${r.reorders === 1 ? '' : 's'} reordered` : ''}${r.verified ? ', layout checked ✓' : ' ⚠️ layout not verified'}`,
    rv.files.length ? `📎 <b>Attached:</b> ${rv.files.map(esc).join(', ')}` : '',
    '',
    practice ? `🧪 ${note('Practice mode is on: approving records a practice run and sends nothing.')}` : '🚀 <b>Approving sends this application to the employer.</b>',
    extra ?? '',
  ].filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''))
  const legend = note('👤 from your profile · 💬 you told me · ✍️ drafted by me · 📎 file · 🔒 private')
  let budget = 3800 - [...head, ...tail, legend].join('\n').length
  const rows: string[] = []
  for (const [i, a] of rv.answers.entries()) {
    const v = cut(a.value, 80)
    const line = `${a.sensitive ? '🔒' : (SRC[a.source] ?? '👤')} ${esc(cut(a.label, 50))}\n      <b>${a.sensitive ? `<tg-spoiler>${esc(v)}</tg-spoiler>` : esc(v)}</b>`
    if (budget - line.length < 80) { rows.push(note(`…and ${rv.answers.length - i} more in the screenshot`)); break }
    budget -= line.length + 1
    rows.push(line)
  }
  return [...head, '', `<b>📝 What I filled in (${rv.answers.length})</b>`, legend, quote(rows.join('\n') || '—', true), '', ...tail].join('\n')
}

export function reviewPage(rv: Review, practice: boolean, extra?: string): Page {
  const c = code(rv.job_id)
  return {
    text: reviewText(rv, practice, extra),
    rows: [
      [{ text: practice ? '✅ Approve (practice)' : '✅ Approve & send', data: `r:ok:${c}`, style: 'success' }],
      [{ text: '✏️ Change something', data: `r:ch:${c}` }, { text: '🖼 Form screenshot', data: `r:ss:${c}` }],
      [{ text: '⏭ Skip', data: `r:sk:${c}` }, { text: '🚫 Never this company', data: `r:nv:${c}`, style: 'danger' }],
      ...(rv.url ? [[{ text: '🔗 Open posting', url: rv.url }]] : []),
    ],
  }
}

// ---- Auto-apply gates (every one checked in code) ----

export function autoGate(rv: Review, s: Settings): string | null {
  if (s.apply.mode !== 'auto') return 'you review every application'
  if (!s.agent_on) return 'the agent is paused'
  if (rv.score == null || rv.score < s.apply.auto_min_score) return `the match (${rv.score ?? '?'}) is below your auto-apply score of ${s.apply.auto_min_score}`
  if (rv.ats === 'generic') return 'unfamiliar form types always need your review'
  if (rv.unusual.length) return 'the form has unusual fields'
  if (rv.generated_sensitive.length) return 'a private answer was drafted rather than given by you'
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

export type JobPending = { job: string; chat: number; msg: number; at: number } & ({ kind: 'change' } | { kind: 'code' })
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
  async function submitOne(id: string) {
    const r = await run(['submit', id])
    if (r.code === 'company_cooldown') {
      schedule(id, Date.parse(r.next_allowed_at))
      say(`${heading('⏳', 'Approved, sending later')}\n${name(id)}\n${note(`You applied to this company recently, so I'll send it at ${clock(Date.parse(r.next_allowed_at))} to space things out.`)}`)
      return
    }
    const st = r.ok ? r.status : r.code === 'needs_human' || r.code === 'not_confirmed' ? 'NEEDS_HUMAN' : 'FAILED'
    const detail = String(r.error ?? '')
    if (st === 'DRY_RUN_DONE') say(`${heading('🧪', 'Practice run done')}\n${name(id)}\n${note('Everything worked up to the Submit button. Nothing was sent.')}`)
    else if (st === 'SUBMITTED') say(`${heading('🎉', 'Application sent')}\n${name(id)}\n${note('Look out for a confirmation email from the company. Mark how it goes under Jobs → Applied.')}`, true)
    else say(`${heading('🙋', 'This one needs you')}\n${name(id)}\n${esc(short(detail || 'The application could not be sent.', 300))}`, true, [[{ text: '📥 Open in Jobs', data: `j:v:${code(id)}` }]])
    d.onResult(id, st, detail)
    d.refresh()
  }
  async function pump() {
    if (running) return
    running = true
    try { while (queue.length) await submitOne(queue.shift()!).catch(e => log(`submit failed: ${e}`)) } finally { running = false }
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

  async function sendFiles(id: string, rv: Review) {
    const to = d.to()!
    const docs = rv.files.map(f => join(jobDir(id), basename(f))).filter(existsSync)
    if (docs.length > 1) await d.api.sendMediaGroup(to, docs.map(p => ({ type: 'document' as const, media: new InputFile(p) })), { disable_notification: true }).catch(e => log(`album failed: ${e}`))
    else if (docs.length) await d.api.sendDocument(to, new InputFile(docs[0]), { disable_notification: true }).catch(e => log(`attach failed: ${e}`))
  }

  // tg_review: show the review card (or the auto-apply countdown) for a job with a fresh review.json.
  async function send(id: string): Promise<string> {
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
    await sendFiles(id, rv)
    if (s.apply.mode === 'auto' && why === null) {
      const m = await d.api.sendMessage(to, autoText(rv, Date.now() + s.apply.auto_grace_seconds * 1000, practice), { ...OPTS, disable_notification: d.silent() })
      const { at, rows } = startAuto(id, rv, m.message_id)
      await d.api.editMessageText(to, m.message_id, autoText(rv, at, practice), { ...OPTS, reply_markup: kb(rows) }).catch(() => {})
      d.refresh()
      return 'auto-apply countdown started'
    }
    const p = reviewPage(rv, practice, why && s.apply.mode === 'auto' ? note(`Not auto-applied: ${esc(why)}.`) : undefined)
    await d.api.sendMessage(to, p.text, { ...OPTS, reply_markup: kb(p), disable_notification: d.silent() })
    d.refresh()
    return 'review sent'
  }

  // Buttons r:<action>:<code8>. Returns the new card, or a toast.
  async function press(act: string, c: string, chat: number, msg: number): Promise<Page | string | undefined> {
    const id = findJob(c)
    const rv = id ? readReview(id) : null
    if (!id || !rv) return 'That review no longer exists.'
    const practice = practiceOn(loadSettings())
    const done = (emoji: string, title: string, line: string): Page => ({
      text: `${heading(emoji, title)}\n${esc(rv.company)} · ${esc(rv.role)}\n${line}`,
      rows: [[{ text: '📥 Jobs', data: 'J:a:0' }, { text: '🏠 Home', data: 'm:home' }]],
    })
    if (act === 'rv') { cancelAuto(id); return reviewPage(rv, practice) }
    if (act === 'ss') {
      const p = join(jobDir(id), 'screenshots', 'filled.png')
      if (!existsSync(p)) return 'No screenshot for this one.'
      await d.api.sendDocument(chat, new InputFile(p, 'form.png'), { caption: `The filled-in form for ${rv.company} · ${rv.role}`, disable_notification: true }).catch(e => log(`screenshot failed: ${e}`))
      return '🖼 Sent below'
    }
    if (act === 'cx') {
      cancelAuto(id)
      return { ...done('✋', 'Auto-apply cancelled', note('Nothing was sent. It is waiting for you in Jobs.')), rows: [[{ text: '👀 Review it', data: `r:rv:${c}` }, { text: '🏠 Home', data: 'm:home' }]] }
    }
    if (act === 'ok') {
      cancelAuto(id)
      const err = await approve(id, 'manual')
      return err ?? done('✅', practice ? 'Approved (practice)' : 'Approved', note(practice ? 'Running it as practice: nothing is sent.' : 'Sending it now. I will tell you when it is in.'))
    }
    if (act === 'ch') {
      d.setPending({ kind: 'change', job: id, chat, msg, at: Date.now() })
      return {
        text: `${heading('✏️', 'What should I change?')}\n${esc(rv.company)} · ${esc(rv.role)}\n\nSend me a message, for example:\n${quote('Make the cover letter shorter\nSay I can start in 2 weeks\nUse my original resume')}`,
        rows: [[{ text: '✖ Cancel', data: `r:rv:${c}` }]],
      }
    }
    if (act === 'sk' || act === 'nv') {
      cancelAuto(id)
      if (act === 'nv' && rv.company) {
        const have = loadSettings().filters.company_blocklist
        if (!have.some(x => x.toLowerCase() === rv.company.toLowerCase())) trySettingsUpdate({ filters: { company_blocklist: [...have, rv.company] } })
      }
      const s = await run(['job', 'set-status', id, 'SKIPPED', '--detail', act === 'nv' ? 'never this company' : 'you skipped it'])
      d.refresh()
      return s.ok ? done(act === 'nv' ? '🚫' : '⏭', act === 'nv' ? 'Never this company' : 'Skipped', note(act === 'nv' ? `I won't apply to ${esc(rv.company)} again. Undo under Settings → What I look for → Companies to avoid.` : 'Skipped.')) : `Could not skip: ${s.error}`
    }
    return undefined
  }

  // Email-code relay: `jobagent submit` writes needs_input.json and waits for input.json.
  function watchInput() {
    for (const id of jobIds()) {
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
  return { send, press, approve, submitCode, recover, cancelAuto, readReview, _grace: grace, _later: later, _fireAuto: fireAuto }
}
export type ReviewGate = ReturnType<typeof createReview>
