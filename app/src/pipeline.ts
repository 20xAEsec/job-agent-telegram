// The job pipeline in code (v4 engine; v3 §3.3). Python does every step; Claude is asked only for single judgments, each one
// a tool-less call whose answer Python checks before anything is written. The next step comes from the job's status and its
// files, so a restart or a usage-limit pause picks up exactly where it stopped, and every step can safely run again.
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import type { CodeLive, Outcome, Task } from './agent'
import type { Stage } from './cards'
import type { Question } from './forms'
import { jobDir } from './jobs'
import type { CallResult, Name } from './llm'
import type { Run } from './runner'
import { log, readJson, type Settings } from './state'

export type PipeDeps = {
  run: Run
  llm: (name: Name, job: string | undefined, extra?: Record<string, unknown>) => Promise<CallResult>
  progress: (a: { job_id: string; stage?: Stage; title?: string; url?: string; detail?: string }) => void
  ask: (a: { batch_id: string; job_id: string; title: string; questions: Question[] }) => Promise<void>
  review: (jobId: string) => Promise<unknown>
  tell: (kind: 'info' | 'followup', jobId: string, text: string, extra?: { subject?: string; body?: string }) => Promise<void>
  formExists: (batchId: string) => boolean
  settings: () => Settings
  live: CodeLive
}

type An = {
  company?: string; role?: string; supported?: boolean; skip_detail?: string; has_cover_letter_field?: boolean; cover_letter_required?: boolean
  match?: { score?: number; dealbreakers?: string[] }; questions?: Question[]
}

class Halt extends Error { constructor(public o: Outcome) { super(o.kind) } }
const DONE: Outcome = { kind: 'done', denials: [] }
const RETRY_TAILOR = new Set(['bad_plan', 'verify_failed', 'too_long', 'too_many_edits', 'bad_uid', 'not_editable', 'bad_reorder'])
const MISMATCH = "The form didn't match what I expected. Open the posting to apply yourself, or tap Try again."

// The accepted answer; a usage limit, a login problem or Stop unwinds the whole task. null: refused twice or no answer.
function need(r: CallResult): any {
  if (r.ok) return r.data
  if (r.kind === 'limit') throw new Halt({ kind: 'limit', resets_at: r.resets_at, denials: [] })
  if (r.kind === 'auth') throw new Halt({ kind: 'auth', text: r.error, denials: [] })
  if (r.kind === 'cancelled') throw new Halt({ kind: 'cancelled', denials: [] })
  return null
}

const an = (id: string) => readJson<An>(join(jobDir(id), 'analysis.json'), {})
const titleOf = (a: An) => [a.company, a.role].filter(Boolean).join(' · ')
const mtime = (p: string) => { try { return statSync(p).mtimeMs } catch { return 0 } }

// Skip rules, exactly v2's (a skill's step then). Pure.
export function gate(a: An, s: Settings, tier?: unknown): string | null {
  const m = a.match ?? {}, score = m.score ?? 0
  if (m.dealbreakers?.length) return a.skip_detail || m.dealbreakers[0]
  if (a.company && s.filters.company_blocklist.some(x => x.toLowerCase() === a.company!.toLowerCase())) return `You asked me never to apply to ${a.company}`
  const other = tier === 'related' || tier === 'maybe', bar = s.apply.min_match_score + (other ? 10 : 0)
  if (score < bar) return other ? `Different title ("${a.role ?? '?'}"); match ${score}/100, I need ${bar}+ for these` : a.skip_detail || `Match ${score}/100, below your minimum of ${s.apply.min_match_score}`
  return null
}

// When a cover letter is written: the same rule as v2.
export function wantLetter(s: Settings, a: An, kit = false): boolean {
  const c = s.apply.cover_letter
  if (c === 'never') return false
  if (c === 'always' || a.cover_letter_required) return true
  return !kit && c === 'if_field' && !!a.has_cover_letter_field
}

export function createPipeline(d: PipeDeps) {
  const set = async (id: string, status: string, detail = '') => {
    const r = await d.run(['job', 'set-status', id, status, ...(detail ? ['--detail', detail] : [])])
    if (!r.ok) log(`set-status ${id} ${status}: ${r.code}`)
    return !!r.ok
  }
  const doing = (text: string) => { if (d.live.cancelled()) throw new Halt({ kind: 'cancelled', denials: [] }); d.live.doing(text) }

  async function ask(id: string, questions: Question[]) {
    // a fresh batch id each time: buttons on an older, finished form must never answer this one
    const batch = [id, ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => `${id}-${n}`)].find(b => !d.formExists(b)) ?? `${id}-${Date.now().toString(36)}`
    await d.ask({ batch_id: batch, job_id: id, title: titleOf(an(id)) || id, questions })
    await set(id, 'NEEDS_ANSWERS')
  }

  // resolve -> fetch -> inspect. false: the job stopped here (its status says why).
  async function read(id: string): Promise<boolean> {
    doing('Reading the posting')
    const r = await d.run(['resolve', id], { timeoutMs: 2 * 60_000 })
    if (r.ok && r.duplicate_of) { await set(id, 'SKIPPED', 'Same job as one already in your list'); return false }
    const f = await d.run(['fetch', id], { timeoutMs: 3 * 60_000 })
    if (!f.ok) {
      if (f.code !== 'closed' && f.code !== 'needs_login') await set(id, 'FAILED', "I couldn't download the posting. The site may be down; try again later.")
      return false
    }
    if (f.ats && f.ats !== 'generic') {
      doing('Reading the application form')
      const i = await d.run(['inspect', id], { timeoutMs: 3 * 60_000 })
      if (!i.ok && i.code === 'closed') return false
    }
    return true
  }

  async function analyze(id: string, tier: unknown): Promise<boolean> {
    doing('Scoring the job against your profile')
    const a = need(await d.llm('analyze', id, tier ? { tier } : {}))
    if (!a) { await set(id, 'NEEDS_HUMAN', "I couldn't read this posting reliably. Open it to apply yourself, or tap Try again."); return false }
    await set(id, 'SCORED')
    d.progress({ job_id: id, stage: 'score', title: titleOf(a), detail: `${a.score}/100` })
    return true
  }

  async function tailorStep(id: string) {
    d.progress({ job_id: id, stage: 'tailor' })
    doing('Tailoring your resume')
    const ats = d.settings().apply.tailoring === 'ats'
    if (ats) {
      const b = await d.run(['resume', 'bank'])
      if ((b.ok && b.status === 'missing') || b.code === 'bad_bank' || b.code === 'no_bank') {
        doing('Indexing the lines of your resumes')
        if (!need(await d.llm('resume_bank', undefined))) return void (await d.run(['tailor', id, '--fallback']))
      }
    }
    let errors: string[] = []
    for (let i = 0; i < 3; i++) {
      if (!need(await d.llm(ats ? 'tailor_ats' : 'tailor_edit', id, errors.length ? { errors } : {}))) break
      doing('Building your resume')
      const r = await d.run(['tailor', id], { timeoutMs: 5 * 60_000 })
      const miss: string[] = r.ok ? r.keywords?.missing_you_have ?? [] : []
      if (r.ok && (!miss.length || i > 0)) return // one try at adding keywords the user's resumes back, then it is good enough
      if (!r.ok && !RETRY_TAILOR.has(r.code)) break
      errors = r.ok ? [`These keywords are on the user's resumes but missing from this one; add them where true: ${miss.join(', ')}`] : [String(r.error ?? r.code)]
    }
    await d.run(['tailor', id, '--fallback']) // the user's original resume, unchanged: the review says so
  }

  async function letterStep(id: string) {
    doing('Writing a short cover letter')
    if (!need(await d.llm('cover_letter', id))) return
    const r = await d.run(['cover-letter', id], { timeoutMs: 3 * 60_000 })
    if (!r.ok) log(`cover-letter ${id}: ${r.code}`)
  }

  async function kit(id: string) {
    const a = an(id), s = d.settings()
    if (!existsSync(join(jobDir(id), 'resume.pdf'))) await tailorStep(id)
    if (wantLetter(s, a, true) && !existsSync(join(jobDir(id), 'cover_letter.pdf'))) await letterStep(id)
    doing('Drafting answers you can paste')
    need(await d.llm('kit', id)) // no answers is still a kit: the resume and the posting link
    await set(id, 'KIT_READY', `match ${a.match?.score ?? '?'}/100`)
  }

  // READY -> FILLED_DRY. false: stopped (questions, a person needed, closed).
  async function prepare(id: string): Promise<boolean> {
    const j = jobDir(id), a = an(id), s = d.settings()
    if (mtime(join(j, 'resume.pdf')) < mtime(join(j, 'analysis.json'))) await tailorStep(id)
    if (wantLetter(s, a) && !existsSync(join(j, 'cover_letter.pdf'))) await letterStep(id)
    const p = await d.run(['plan', 'build', id])
    if (!p.ok) {
      if (p.code === 'needs_answers' && p.questions?.length) { await ask(id, p.questions); return false }
      await set(id, 'NEEDS_HUMAN', p.code === 'missing_document' ? 'The form needs a file I could not make (like a cover letter). Open the posting to apply yourself' : MISMATCH)
      return false
    }
    d.progress({ job_id: id, stage: 'fill' })
    doing('Filling in the form (practice: nothing is sent)')
    const f = await d.run(['fill', id, '--dry-run'], { timeoutMs: 5 * 60_000 })
    if (f.ok) return true
    // closed and needs_human: fill already set the status, with a plain-words reason for the card. A plan the page disagrees
    // with (a control the form API never listed, a value the page refused) does not get better by filling it again.
    if (f.code !== 'closed' && f.code !== 'needs_human') await set(id, 'NEEDS_HUMAN', MISMATCH)
    return false
  }

  async function finishReview(id: string): Promise<boolean> {
    const r = await d.run(['review', 'build', id])
    if (!r.ok) {
      if (r.code === 'stale_fill' && await set(id, 'READY', 'the form changed: filling it in again')) return true // the loop fills it again
      await set(id, 'NEEDS_HUMAN', MISMATCH)
      return false
    }
    d.progress({ job_id: id, stage: 'review' })
    await d.review(id)
    return false
  }

  // Walk the job forward from wherever it is until it stops for a reason the user sees on its card.
  async function advance(id: string, t: Task, ignoreGate: boolean) {
    let reread = false, stale = 0
    for (let guard = 0; guard < 25; guard++) {
      const g = await d.run(['job', 'get', id])
      if (!g.ok) throw new Error(`job get ${id}: ${g.code}`)
      switch (g.status) {
        case 'NEW': if (!(await read(id))) return; break
        case 'FETCHED': if (!(await analyze(id, t.payload.tier))) return; break
        case 'SCORED': {
          const a = an(id), why = ignoreGate ? null : gate(a, d.settings(), t.payload.tier)
          if (why) { await set(id, 'SKIPPED', why); return }
          if (!a.supported) {
            const r = reread ? null : await d.run(['resolve', id], { timeoutMs: 2 * 60_000 })
            reread = true
            if (r?.ok && r.duplicate_of) { await set(id, 'SKIPPED', 'Same job as one already in your list'); return }
            if (r?.ok && r.resolved) { // the employer's own fillable form: read that one instead
              d.progress({ job_id: id, stage: 'read', url: r.url })
              if (!(await read(id)) || !(await analyze(id, t.payload.tier))) return
              break
            }
            return kit(id)
          }
          if (a.questions?.length) return ask(id, a.questions)
          if (!(await set(id, 'READY'))) return
          break
        }
        case 'READY': if (!(await prepare(id))) return; break
        case 'FILLED_DRY': if (stale++ > 1 || !(await finishReview(id))) return; break
        default: return // waiting for the user (NEEDS_ANSWERS, AWAITING_APPROVAL, KIT_READY) or done
      }
    }
    log(`pipeline ${id}: too many steps, stopping`)
  }

  async function job(t: Task): Promise<Outcome> {
    const p = t.payload, mode = p.mode as 'continue' | 'retry' | 'apply_anyway' | undefined
    let id = t.job_id
    if (p.url && !mode) {
      const r = await d.run(['job', 'new', String(p.url), '--source', p.source === 'discovery' ? 'discovery' : 'manual'])
      if (!r.ok) return { kind: 'error', text: "That link doesn't look like a job posting.", denials: [] }
      if (r.duplicate && !(t.interrupted || t.job_id === r.job_id)) { // a link sent again: the card shows where that job is
        const g = await d.run(['job', 'get', r.job_id])
        d.progress({ job_id: r.job_id, url: String(p.url), ...(g.company ? { title: `${g.company} · ${g.role}` } : {}) })
        return DONE
      }
      id = t.job_id = r.job_id
      d.progress({ job_id: id!, stage: 'read', url: String(p.url) })
    }
    if (!id) return { kind: 'error', text: 'No job to work on.', denials: [] }
    const g = await d.run(['job', 'get', id])
    if (!g.ok) return { kind: 'error', text: 'That job is gone.', denials: [] }
    const st: string = g.status, files = new Set<string>(g.files ?? [])
    if (!p.url || mode) d.progress({ job_id: id, ...(g.company ? { title: `${g.company} · ${g.role}` } : {}), url: g.url })
    if (mode === 'continue' && st === 'NEEDS_ANSWERS') await set(id, 'READY')
    if (mode === 'retry') {
      if (!files.has('analysis.json') && st === 'FAILED') await set(id, 'NEW')
      else if (st === 'NEEDS_ANSWERS') {
        const have = readJson<Record<string, unknown>>(join(jobDir(id), 'answers.json'), {})
        const left = (an(id).questions ?? []).filter(q => !q.fid || !(q.fid in have))
        if (left.length) { await ask(id, left.map((q, i) => ({ ...q, qid: `q${i + 1}` }))); return DONE }
        await set(id, 'READY')
      } else if ((st === 'NEEDS_HUMAN' || st === 'FAILED') && files.has('analysis.json')) {
        if (!an(id).supported) { await kit(id); return DONE }
        await set(id, 'READY')
      }
    }
    await advance(id, t, mode === 'apply_anyway')
    return DONE
  }

  async function revise(t: Task): Promise<Outcome> {
    const id = t.job_id!, req = String(t.payload.request ?? '')
    const g = await d.run(['job', 'get', id])
    if (['APPROVED', 'SUBMITTING', 'SUBMITTED'].includes(g.status)) { await d.tell('info', id, 'Already on its way: this application was approved, so it can no longer change.'); return DONE }
    if (!['AWAITING_APPROVAL', 'FILLED_DRY', 'READY'].includes(g.status)) return DONE
    d.progress({ job_id: id, stage: 'tailor', ...(g.company ? { title: `${g.company} · ${g.role}` } : {}) })
    if (req.startsWith('SYSTEM:')) { // the app's own notice: the files changed, or a skill was confirmed (re-tailor)
      await set(id, 'READY')
      if (/re-tailor/i.test(req)) await tailorStep(id)
    } else {
      doing('Working on your change')
      const r = need(await d.llm('revise', id, { request: req }))
      if (!r) { await d.tell('info', id, "I couldn't work out that change. Try saying it another way, or tap ✏️ Edit an answer."); return DONE }
      if (r.action !== 'patch') { await d.tell('info', id, r.reply || 'Approving is only the button on the review card.'); return DONE }
      await set(id, 'READY')
      const c = r.changed ?? {}
      if (c.original_resume) await d.run(['tailor', id, '--fallback'])
      else if (c.tailor && !(await d.run(['tailor', id], { timeoutMs: 5 * 60_000 })).ok) await tailorStep(id)
      if (c.letter) await d.run(['cover-letter', id], { timeoutMs: 3 * 60_000 })
      if (r.refused?.length) await d.tell('info', id, 'Private answers (like work authorization or salary) change only with ✏️ Edit an answer on the review card, so I left them as they were.')
    }
    await advance(id, t, true)
    return DONE
  }

  async function followup(t: Task): Promise<Outcome> {
    const id = t.job_id!
    const g = await d.run(['job', 'get', id])
    if (!['SUBMITTED', 'APPLIED_SELF'].includes(g.status)) { await d.tell('info', id, 'There is no sent application to follow up on yet.'); return DONE }
    doing('Drafting your follow-up email')
    const r = need(await d.llm('followup', id))
    if (!r) { await d.tell('info', id, "I couldn't draft that email. Try again in a little while."); return DONE }
    await d.tell('followup', id, '', { subject: r.subject, body: r.body })
    return DONE
  }

  // `profileReady` shows the profile card (onboarding); a `bank` task only indexes the resume lines (v3 P1).
  async function resume(t: Task, profileReady: (summary: unknown) => string | null): Promise<Outcome> {
    if (t.payload.bank) {
      doing('Indexing the lines of your resumes')
      need(await d.llm('resume_bank', undefined))
      return DONE
    }
    doing('Reading your resume')
    const r = need(await d.llm('resume_profile', undefined))
    if (r && !r.not_a_resume) { const err = profileReady(r.summary); if (err) log(`profile card refused: ${err}`) }
    return DONE
  }

  const wrap = (f: () => Promise<Outcome>) => f().catch(e => { if (e instanceof Halt) return e.o; throw e })
  return {
    job: (t: Task) => wrap(() => job(t)),
    revise: (t: Task) => wrap(() => revise(t)),
    followup: (t: Task) => wrap(() => followup(t)),
    resume: (t: Task, profileReady: (summary: unknown) => string | null) => wrap(() => resume(t, profileReady)),
  }
}
