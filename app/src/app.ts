// Wires everything together: Telegram (grammy), the Claude task runner, live cards, forms, review gate and setup wizard.
import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import { createHash, timingSafeEqual } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join, relative } from 'path'
import { z } from 'zod'
import { createAgent, type Lane, type Live, type Outcome, type Task, type Usage } from './agent'
import { startBridge, type ToolResult } from './bridge'
import { createCards, finalFor, recordStage, typicalMs, type Card, type Final, type JobLine, type Stage } from './cards'
import * as F from './forms'
import { allJobs, code, findJob, jobDir, jobTitle, JOB_RE, lastDetail, logDecision, readDecisions, readJob, readOutcomes } from './jobs'
import { clock, CURRENCIES, esc, heading, isUS, kb, nav, note, parseList, parseNumber, plural, quote, short, splitMsg, type Btn, type Page } from './kit'
import * as OB from './onboarding'
import { kitPage, readKit } from './applykit'
import { insightsPage, scoreSuggestion } from './insights'
import { looksLikeAddress, pageButtons, phoneUrl, plain, setPhoneUrl, startDashboard, TAPS, type DashDeps } from './dashboard'
import * as P from './pages'
import { boardCount, readAnswers, readBoards, readSection } from './profile'
import { createReview, reviewPage, type JobPending } from './review'
import { approve as approveFix, discardedPage, failedPage, FIX_BUTTON, FIX_ID, proposalPage, readProposal, sharedPage } from './repair'
import { killHelpers, runJobagent, type Run } from './runner'
import * as ST from './settings'
import {
  DATA, PAIR_FILE, SOURCES, getPath, isQuiet, loadSettings, log, logError, patchFor, practiceForced, practiceOn, readJson, trySettingsUpdate, writeJson, type NotifyKind, type Settings,
} from './state'
import { AGENT_BUTTONS, TONES, TOOLS } from './tools'

const OPTS = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } }
const STATUS_FILE = join(DATA, 'status_card.json')
const USAGE_FILE = join(DATA, 'usage.json')
const DISC_FILE = join(DATA, 'discovery.json')
const FOLLOW_FILE = join(DATA, 'followups.json')
const WEEK_FILE = join(DATA, 'weekly.json')
const TIP_FILE = join(DATA, 'suggestion.json')
// One suggestion on Home from the user's own decisions, until they apply or dismiss it.
const tipFor = (s: Settings) => {
  const t = scoreSuggestion(readDecisions(), s.apply.min_match_score)
  return t && readJson<{ dismissed?: number }>(TIP_FILE, {}).dismissed !== t.min ? t : null
}
const PENDING_MS = 15 * 60_000

// "12 companies, LinkedIn and Indeed" (no "0 companies" when job sites are searched).
export function whereText(boards: number, sites: string[]): string {
  const parts = [...(boards || !sites.length ? [plural(boards, 'company', 'companies')] : []), ...sites]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
}

// The 3 titles the daily "find new companies" search uses, taking turns through all of them: [titles, next cursor].
export function discoverTitles(all: string[], cursor: number): [string[], number] {
  const list = [...new Set(all)], at = list.length ? cursor % list.length : 0
  return [[...list.slice(at), ...list.slice(0, at)].slice(0, 3), at + 3]
}

// ---- Gate (pure, unit-tested) ----
export const isAllowed = (from: number | undefined, chatType: string | undefined, paired: number | null) =>
  paired != null && from === paired && chatType === 'private'

// pair.json is written by `jobagent pair --new`: {code_hash: sha256 hex, expires_at: epoch seconds, attempts}.
export function tryPair(code: string, now = Date.now()): 'ok' | 'bad' | 'expired' {
  const p = readJson<{ code_hash: string; expires_at: number; attempts?: number } | null>(PAIR_FILE, null)
  if (!p || now / 1000 > p.expires_at) { rmSync(PAIR_FILE, { force: true }); return 'expired' }
  const attempts = (p.attempts ?? 0) + 1
  const want = Buffer.from(p.code_hash, 'hex'), got = createHash('sha256').update(code).digest()
  if (want.length === got.length && timingSafeEqual(want, got)) { rmSync(PAIR_FILE, { force: true }); return 'ok' }
  if (attempts >= 5) rmSync(PAIR_FILE, { force: true })
  else writeJson(PAIR_FILE, { ...p, attempts })
  return 'bad'
}

export function extractUrls(text: string): string[] {
  const urls = (text.match(/https?:\/\/\S+/g) ?? []).map(u => u.replace(/[.,;:!?)>\]]+$/, ''))
  return [...new Set(urls)].slice(0, 10)
}

// A posting on a job site or careers pages; and a LinkedIn person page, which is never a job.
export const isJobLink = (u: string) => /greenhouse\.io|lever\.co|ashbyhq\.com|indeed\.com|glassdoor\.|ziprecruiter\.com|\/(jobs?|careers?)([/?]|$)/i.test(u)
export const isProfileLink = (u: string) => /^https?:\/\/([\w-]+\.)*linkedin\.com\/(in|pub)\//i.test(u)

type Base = { chat: number; msg: number; at: number }
type Pending = Base & (
  | { kind: 'setting'; id: string; adding: boolean }
  | { kind: 'answer'; rec: P.AnswerRec }
  | { kind: 'find' }
  | { kind: 'company' }
  | { kind: 'contact'; key: string; ob: boolean }
  | { kind: 'achievement' }
  | { kind: 'dashurl' }
  | { kind: 'ob'; what: string }
  | { kind: 'resume' }
  | { kind: 'version' } // another version of the resume, for the ATS rebuild's line pool
  | { kind: 'form'; batch: string } // the question form opened from Open Questions
) | JobPending
const FORM_MS = 2 * 3600_000 // answering may mean looking something up, so a form waits longer than other screens

// Whether a waiting screen can use this message. A link is a reply only where one makes sense; otherwise it goes on to
// job links and chat, and the screen keeps waiting.
export function claims(p: Pending, text: string): boolean {
  if (p.kind === 'dashurl') return looksLikeAddress(text)
  const urls = extractUrls(text)
  if (p.kind === 'form') {
    const f = F.loadForm(p.batch)
    return !!f && f.status === 'open' && !f.confirming && (!urls.length || F.wantsLink(f) && !urls.some(isJobLink))
  }
  if (!urls.length || p.kind === 'company') return true // a company is added by its job board link
  if (urls.some(isJobLink)) return false
  if (p.kind === 'contact') return p.key === 'linkedin' || p.key === 'portfolio'
  return p.kind === 'answer' || p.kind === 'edit' || p.kind === 'change' || p.kind === 'achievement'
}

const SummarySchema = z.object({
  name: z.string().max(100), headline: z.string().max(140), years: z.number().int().min(0).max(60).nullable().optional(),
  level: z.enum(['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director']),
  location: z.string().max(100).optional(), country: z.string().max(60).optional(), email: z.string().max(120).optional(), phone: z.string().max(40).optional(),
  skills: z.array(z.string().max(60)).max(30), suggested_titles: z.array(z.string().min(1).max(80)).max(8),
  related_titles: z.array(z.string().min(1).max(80)).max(8).optional(),
})

export function createApp(o: { token: string; run?: Run; exec?: Parameters<typeof createAgent>[0]['exec']; onReady?: (bot: string) => void }) {
  const bot = new Bot(o.token)
  const api = bot.api
  const run = o.run ?? runJobagent
  const paired = () => loadSettings().paired_user_id
  let snoozeUntil = 0 // "snooze" in chat or /snooze: an hour without notification sounds
  const silent = () => isQuiet(loadSettings()) || Date.now() < snoozeUntil
  let pending: Pending | null = null
  let usage = readJson<Usage>(USAGE_FILE, { at: 0 })
  let limitUntil = 0
  const spoke = new Set<string>() // tasks that already messaged the user

  // One sequential lane for profile.md writes, so two quick taps never race each other.
  let saveQ: Promise<unknown> = Promise.resolve()
  const saveAnswer = (key: string, question: string, value: string, sensitive: boolean, job?: string) => {
    saveQ = saveQ.then(() => run(['profile', 'answer', 'set', key, `--question=${question}`, `--value=${value}`, '--scope=global', ...(job ? [`--job=${job}`] : []), ...(sensitive ? ['--sensitive'] : [])])
      .then(r => { if (!r.ok) log(`answer ${key} not saved: ${r.code}`) }))
    return saveQ
  }

  // ---- Sending ----
  // `kind`: the user's per-kind choice (Settings → Notifications) decides whether it rings, instead of `loud`.
  const sendTo = async (text: string, rows: Btn[][] = [], x: { loud?: boolean; kind?: NotifyKind; reply_to?: number } = {}) => {
    const to = paired()
    if (to == null) throw new Error('not paired yet')
    const loud = x.kind ? loadSettings().notify[x.kind] === 'loud' : x.loud
    const o2 = { ...OPTS, reply_markup: kb(rows), disable_notification: !loud || silent(), ...(x.reply_to ? { reply_parameters: { message_id: x.reply_to, allow_sending_without_reply: true } } : {}) }
    return api.sendMessage(to, text, o2).catch(() => api.sendMessage(to, text.replace(/<[^>]+>/g, ''), { ...o2, parse_mode: undefined }))
  }
  const editAt = async (chat: number, msg: number, p: Page) => {
    if (msg < 0) return // a dashboard press: there is no Telegram message to update
    await api.editMessageText(chat, msg, p.text, { ...OPTS, reply_markup: kb(p) }).catch(e => { if (!/not modified/i.test(String(e))) log(`edit failed: ${String(e).slice(0, 100)}`) })
  }

  const cards = createCards(api, paired)

  // ---- Home and the pinned status bar: always show what is happening ----
  const discState = () => readJson<{ last_tick?: number; last_expand?: number; title_cursor?: number }>(DISC_FILE, {})
  const nextSearch = () => { const s = loadSettings(); return s.discovery.enabled ? (discState().last_tick ?? 0) + s.discovery.interval_hours * 3600_000 : null }
  const cardTitle = (t: Task) => { const c = cards.get(t.id); return c?.mode === 'job' && c.jobs[0]?.title ? c.jobs[0].title : t.title }
  function homeCtx(): P.HomeCtx {
    const work = agent.live('work')
    return {
      s: loadSettings(), work, workTitle: work ? cardTitle(work.task) : undefined, queued: agent.queued('work').length,
      jobs: allJobs(), forms: F.openForms(), usage, nextSearch: nextSearch(), limitedUntil: limitUntil > Date.now() ? limitUntil : undefined,
      companies: boardCount(), tip: tipFor(loadSettings()), updates, problems: health ? P.problemsFrom(health.checks, existsSync(join(DATA, 'base_resume.docx'))) : [],
    }
  }
  // ---- Follow-ups: once a day, ask about applications with no news (one message each, at most 3 a day) ----
  // Monday morning: the week in one message (once per week, only when something happened).
  function weeklyCheck(now = new Date()) {
    const s = loadSettings()
    if (s.paired_user_id == null || !s.onboarded || now.getDay() !== 1 || now.getHours() < 9 || isQuiet(s)) return
    const week = now.toISOString().slice(0, 10), f = readJson<{ last?: string }>(WEEK_FILE, {})
    if (f.last && Date.now() - Date.parse(f.last) < 6 * 86_400_000) return
    writeJson(WEEK_FILE, { last: week })
    const p = insightsPage(allJobs(), readOutcomes(), s.apply.min_match_score, Date.now(), true)
    if (s.notify.weekly !== 'off' && !/This week:<\/b> 0 found/.test(p.text)) void sendTo(p.text, p.rows, { kind: 'weekly' }).catch(e => log(`weekly failed: ${e}`))
  }
  function followUpCheck() {
    weeklyCheck()
    const s = loadSettings()
    if (s.paired_user_id == null || !s.onboarded || isQuiet(s)) return
    const st = readJson<P.FollowState>(FOLLOW_FILE, {})
    const due = P.followUpsDue(allJobs(), readOutcomes(), st, s.apply.followup_days).slice(0, 3)
    if (!due.length) return
    writeJson(FOLLOW_FILE, { ...st, ...Object.fromEntries(due.map(j => [j.id, { asked: new Date().toISOString() }])) })
    for (const j of due) { const p = P.followUpPage(j, s.apply.followup_days); void sendTo(p.text, p.rows, { kind: 'followups' }).catch(e => log(`follow-up failed: ${e}`)) }
  }

  // ---- Updates: once a day, compare this copy with GitHub (clone installs). It only tells the user; it never pulls. ----
  let updates = 0
  async function checkUpdate() {
    const repo = join(import.meta.dir, '..', '..'), git = async (...a: string[]) => {
      const p = Bun.spawn(['git', '-C', repo, ...a], { stdout: 'pipe', stderr: 'ignore' })
      const t = setTimeout(() => p.kill(), 60_000)
      const out = await new Response(p.stdout).text(); clearTimeout(t)
      return (await p.exited) === 0 ? out.trim() : null
    }
    try {
      if ((await git('fetch', '--quiet')) == null) return
      const n = parseInt((await git('rev-list', '--count', 'HEAD..@{u}')) ?? '0', 10) || 0
      if (n !== updates) { updates = n; refresh() }
    } catch { /* no git: not a clone install */ }
  }

  // ---- Dashboard (local web page). Its writes are the same calls the Telegram buttons make. ----
  let dash: { link: string; port: number } | null = null
  const dashDeps: DashDeps = {
    botToken: o.token, pairedId: paired,
    approve: async (id, planHash) => {
      const rv = review.readReview(id)
      if (!rv || rv.plan_hash !== planHash) return 'This review changed. Reload the page to see the newest one.'
      review.cancelAuto(id)
      const err = await review.approve(id, 'manual')
      if (!err) logDecision(id, 'approve')
      return err
    },
    skip: async id => {
      stopTasks(t => t.job_id === id)
      const r = await run(['job', 'set-status', id, 'SKIPPED', '--detail', 'you skipped it'])
      if (!r.ok) return `Could not skip: ${r.error}`
      logDecision(id, 'skip'); refresh()
      return null
    },
    health: () => health,
    call: (op, b) => dashCall(op, b),
  }

  // ---- Health: the setup check at start and every 6 hours, so a problem shows on Home before a job fails ----
  let health: { checks: P.Check[]; at: number } | null = null
  async function checkHealth() {
    const r = await run(['setup-check'], { timeoutMs: 2 * 60_000 })
    if (!Array.isArray(r.checks)) return log(`health check failed: ${r.code}`)
    const before = health ? P.problemsFrom(health.checks, false).length : 0
    health = { checks: r.checks, at: Date.now() }
    const now = P.problemsFrom(health.checks, false)
    if (now.length) log(`health: ${r.checks.filter((c: P.Check) => !c.ok).map((c: P.Check) => c.name).join(', ')}`)
    if (now.length > before) void sendTo(`${heading('🩺', 'Something on your computer needs attention')}\n${now[0]}`, [[{ text: '🩺 Health', data: 'm:health' }]], { kind: 'health' }).catch(() => {})
    refresh()
  }
  let homeMsg: { chat: number; id: number; showing: boolean } | null = null
  let statusText = ''
  async function refreshNow() {
    const to = paired()
    if (to == null || !loadSettings().onboarded) return // no status bar mid-setup: "send me a job link" would be refused there
    const ctx = homeCtx()
    if (homeMsg?.showing) await editAt(homeMsg.chat, homeMsg.id, P.home(ctx))
    const text = P.statusBar(ctx)
    if (text === statusText) return
    const id = readJson<{ id?: number }>(STATUS_FILE, {}).id
    if (id) {
      try { await api.editMessageText(to, id, text, OPTS); statusText = text; return } catch (e) {
        if (/not modified/i.test(String(e))) { statusText = text; return }
        if (!/not found|can't be edited/i.test(String(e))) return // network blip: retry on the next change
      }
    }
    const m = await api.sendMessage(to, text, { ...OPTS, disable_notification: true })
    writeJson(STATUS_FILE, { id: m.message_id })
    statusText = text
    void api.pinChatMessage(to, m.message_id, { disable_notification: true }).catch(() => {})
  }
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const refresh = () => { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; void refreshNow().catch(e => log(`refresh: ${e}`)) }, 1500) }

  // ---- Tasks and their cards ----
  function newCard(t: Task, reply_to?: number): Card {
    if (t.kind === 'repair') return { key: t.id, mode: 'plain', icon: '🔧', title: t.title, state: 'queued', jobs: [] }
    if (t.kind === 'followup') return { key: t.id, mode: 'plain', icon: '✍️', title: t.title, state: 'queued', jobs: [] }
    if (t.kind === 'prep') return { key: t.id, mode: 'plain', icon: '🎤', title: t.title, state: 'queued', jobs: [] }
    const prev = t.job_id ? cards.forJob(t.job_id)?.jobs.find(j => j.job_id === t.job_id) : undefined
    const line: JobLine = { job_id: t.job_id ?? '', title: prev?.title || t.title, url: prev?.url ?? (t.payload.url as string | undefined), details: { ...(prev?.details ?? {}) }, stage: t.kind === 'job' && t.payload.mode === 'continue' ? 'tailor' : prev?.stage && t.kind !== 'job' ? prev.stage : undefined }
    if (t.kind === 'revise') line.stage = 'tailor'
    return { key: t.id, mode: 'job', icon: '🏢', title: t.title, state: 'queued', jobs: [line], reply_to, note: t.kind === 'revise' ? `✏️ Your change: ${short(String(t.payload.request ?? ''), 140)}` : undefined }
  }
  function syncQueued() {
    const s = loadSettings()
    for (const t of agent.queued('work')) {
      if (t.kind === 'discover' || t.payload.parent) continue // background work, or a line on its search card
      cards.update(t.id, c => { c.position = agent.position(t.id); c.state = !s.agent_on ? 'paused' : t.not_before && t.not_before > Date.now() && limitUntil > Date.now() ? 'waiting' : 'queued' }, () => newCard(t, t.reply_to))
    }
  }
  function startTask(t: Parameters<typeof agent.enqueue>[0], card = true) {
    const r = agent.enqueue(t)
    if (!r.existing && card) cards.update(r.task.id, c => { c.position = r.position }, () => newCard(r.task, t.reply_to))
    syncQueued()
    refresh()
    return r
  }
  const startJobUrl = (url: string, reply_to?: number) => startTask({ kind: 'job', title: hostTitle(url), payload: { url }, reply_to })
  const hostTitle = (u: string) => { try { return `New job · ${new URL(u).hostname.replace(/^www\./, '')}` } catch { return 'New job' } }
  const continueJob = (id: string, mode: 'continue' | 'retry' | 'apply_anyway', extra: Record<string, unknown> = {}) => {
    const j = readJob(id)
    return startTask({ kind: 'job', job_id: id, title: j ? jobTitle(j) : id, payload: { mode, ...extra } })
  }
  // Self-repair: the user's Claude reads the logs and prepares a fix; the user approves before anything is shared.
  function startFix(trigger: 'button' | 'command') {
    const busy = agent.live('work')?.task.kind === 'repair' || agent.queued('work').some(t => t.kind === 'repair')
    return busy ? { existing: true } : startTask({ kind: 'repair', title: 'Looking into a problem', payload: { trigger } })
  }
  const sharing = new Set<string>()
  async function fixDecision(what: string, id: string): Promise<Page | string> {
    const p = readProposal(id)
    if (!p) return 'That fix is no longer available.'
    if (what === 'no') { await run(['repair', 'discard', id]); return discardedPage() }
    if (sharing.has(id)) return 'Already on it…'
    sharing.add(id)
    try {
      approveFix(id, p) // the hash of exactly what the user saw; publish refuses if the fix changed since
      const r = await run(['repair', 'publish', id])
      return r.ok ? sharedPage(String(r.url)) : failedPage(id, String(r.error ?? 'Something went wrong.'))
    } finally { sharing.delete(id) }
  }
  async function finishRepair(t: Task, out: Outcome) {
    const p = out.kind === 'done' ? readProposal(t.id) : null
    const final: Final = p ? { emoji: '🔧', text: 'A fix is ready for you to look at.' }
      : out.kind === 'done' ? { emoji: '🔍', text: "I couldn't prepare a fix to share." }
      : out.kind === 'cancelled' ? { emoji: '✋', text: 'Stopped.' }
      : { emoji: '⚠️', text: out.kind === 'timeout' ? 'This took too long, so I stopped it.' : 'Something went wrong on my side.' }
    cards.update(t.id, c => { c.final = final; c.state = 'ended'; c.ended = Date.now(); c.doing = null })
    if (p) { const pg = proposalPage(t.id, p); await sendTo(pg.text, pg.rows) } else void run(['repair', 'discard', t.id])
    refresh()
  }
  // ---- Auto-search: the app polls by itself (no Claude), then each new job that fits becomes its own job task ----
  let searching = false
  const stoppedSearches = new Set<string>() // Stop pressed while the poll was still running
  const discoveryBusy = () => searching || [agent.live('work')?.task, ...agent.queued()].some(t => t?.payload.source === 'discovery')
  async function startDiscover(reason: 'timer' | 'manual' | 'first') {
    const s = loadSettings(), d = discState(), now = Date.now()
    const expand = s.discovery.web_search && now - (d.last_expand ?? 0) > 24 * 3600_000
    const [titles, title_cursor] = discoverTitles([...s.filters.titles, ...s.filters.related_titles], d.title_cursor ?? 0)
    writeJson(DISC_FILE, { ...d, last_tick: now, ...(expand ? { last_expand: now, title_cursor } : {}) })
    // Finding new companies needs web search and judgment: a background Claude task. Its boards are polled from the next run on.
    if (expand && ![agent.live('work')?.task, ...agent.queued()].some(t => t?.kind === 'discover')) agent.enqueue({ kind: 'discover', title: 'Finding new companies', payload: { expand_boards: true, titles } })
    const key = `search-${now.toString(36)}`
    const sitesOn = s.discovery.sources.filter(x => x !== 'companies').map(x => SOURCES[x])
    const card = (f: (c: Card) => void) => cards.update(key, f, () => ({ key, mode: 'multi', icon: '🔭', title: reason === 'first' ? 'Your first matches' : 'Auto-search', state: 'running', started: now, jobs: [] }))
    if (reason !== 'timer') card(c => { c.doing = `Checking ${whereText(s.discovery.sources.includes('companies') ? homeCtx().companies ?? 0 : 0, sitesOn)}` })
    searching = true
    refresh()
    let r: any
    try { r = await run(['discover', 'poll'], { timeoutMs: 5 * 60_000 }) } catch (e) { r = { ok: false, code: 'internal', error: String(e) } } finally { searching = false }
    const end = (final: Final) => { if (reason !== 'timer' || cards.get(key)) card(c => { c.state = 'ended'; c.ended = Date.now(); c.doing = null; c.final = final }) }
    if (!r.ok) {
      log(`discover poll failed: ${r.code}`)
      if (r.code === 'no_titles') end({ emoji: 'ℹ️', text: 'Auto-search needs job titles. Tell me which titles to look for.', buttons: [{ text: '🎯 What I look for', data: 'S:search' }] })
      else end({ emoji: '⚠️', text: r.code === 'timeout' ? 'The search took too long, so I stopped it.' : "I couldn't run the search.", buttons: [FIX_BUTTON] })
      return refresh()
    }
    if (stoppedSearches.delete(key)) { end({ emoji: '✋', text: 'Stopped.' }); return refresh() }
    const where = whereText(r.boards, r.sites ?? [])
    if (!r.boards && !(r.sites ?? []).length) { end({ emoji: 'ℹ️', text: 'No companies to search yet. Add companies, or turn on "Find new companies".', buttons: [{ text: '🏢 Companies', data: 'C:list' }, { text: '🔭 Auto-search', data: 'S:auto' }] }); return refresh() }
    const slow = [...(r.errors ?? []).filter((e: any) => e.site).map((e: any) => `${e.site} is limiting searches right now; I'll try again later.`), ...(r.skipped ?? []).map((x: any) => String(x.reason)).filter((x: string) => /slow down/.test(x))]
    if (!r.kept) { end({ emoji: '✅', text: [`Checked ${where}: nothing new fits your settings yet. Try more titles or places, or send me a link to a job you like.`, ...slow].join(' '), buttons: [{ text: '🎯 What I look for', data: 'S:search' }] }); return refresh() }
    const cap = reason === 'first' ? 3 : (usage.five_hour ?? 0) > 0.8 ? 2 : 8 // save the user's Claude limit when it is nearly used up
    const take = (r.candidates as any[]).slice(0, cap)
    card(c => {
      c.state = 'running'; c.doing = 'Waiting for my turn'
      const other = (r.candidates as any[]).filter(x => x.tier && x.tier !== 'exact').length
      c.note = `Checked ${where} · ${plural(r.kept, 'new job')} fit${r.kept === 1 ? 's' : ''} your settings${other ? ` · ${other} with a different title` : ''}${r.kept > cap ? ` · preparing ${cap} now, the rest come next run` : ''}.${slow.length ? ` ${slow.join(' ')}` : ''}`
      c.jobs = take.map(x => ({ job_id: x.job_id, title: short([x.company, x.title].filter(Boolean).join(' · ') || x.job_id, 80), url: x.url, details: {} }))
    })
    for (const x of take) {
      const q = agent.enqueue({ kind: 'job', job_id: x.job_id, title: short([x.company, x.title].filter(Boolean).join(' · '), 80), payload: { url: x.url, source: 'discovery', parent: key, ...(x.tier && x.tier !== 'exact' ? { tier: x.tier } : {}) } })
      if (q.existing) card(c => { const l = c.jobs.find(j => j.job_id === x.job_id); if (l) l.final = { emoji: '🕒', text: 'Already in line from an earlier search.' } })
    }
    finishSearchIfDone(key)
    syncQueued()
    refresh()
  }
  // The search card ends once every job it started has finished.
  function finishSearchIfDone(key: string) {
    const left = [agent.live('work')?.task, ...agent.queued()].some(t => t?.payload.parent === key)
    if (left || cards.get(key)?.state === 'ended') return
    cards.update(key, c => { c.state = 'ended'; c.ended = Date.now(); c.doing = null; c.active = undefined; c.final = { emoji: '✅', text: 'Done.' } })
    const p = P.digestPage((cards.get(key)?.jobs ?? []).map(l => readJob(l.job_id)).filter((j): j is NonNullable<typeof j> => !!j))
    if (p) void sendTo(p.text, p.rows, { kind: 'search' }).catch(e => log(`digest failed: ${e}`))
  }

  let typingTimer: ReturnType<typeof setInterval> | null = null
  function onLive(lane: Lane, l: Live | null) {
    if (l && !usageAt.has(l.task.id) && usage.five_hour != null) usageAt.set(l.task.id, usage.five_hour)
    if (lane === 'chat') {
      if (l && !typingTimer) { const tick = () => { const to = paired(); if (to != null) void api.sendChatAction(to, 'typing').catch(() => {}) }; tick(); typingTimer = setInterval(tick, 4500) }
      if (!l && typingTimer) { clearInterval(typingTimer); typingTimer = null }
      return
    }
    if (l?.task.kind === 'resume') {
      const ob = OB.loadOb()
      if (ob.step === 'reading' && ob.doing !== l.doing) { ob.doing = l.doing; OB.saveOb(ob); void renderOb(ob) }
    } else if (l?.task.payload.parent) {
      cards.update(String(l.task.payload.parent), c => { c.state = 'running'; c.active = l.task.job_id; c.doing = l.doing ?? 'Starting on the next job'; c.steps = l.steps })
    } else if (l) {
      if (l.task.kind !== 'discover') cards.update(l.task.id, c => { c.state = 'running'; c.started ??= l.started; c.doing = l.doing; c.steps = l.steps; c.note = c.note?.startsWith('Claude stopped') ? undefined : c.note }, () => newCard(l.task))
    }
    syncQueued()
    refresh()
  }

  // How much of the 5-hour limit each task used (data/usage_log.jsonl), shown on the job page.
  const usageAt = new Map<string, number>()
  function logUsage(t: Task) {
    const start = usageAt.get(t.id)
    usageAt.delete(t.id)
    const delta = start == null || usage.five_hour == null ? null : usage.five_hour - start
    if (delta == null || delta < 0 || delta > 1) return // the window reset mid-task: no honest number
    try { appendFileSync(join(DATA, 'usage_log.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: t.kind, job_id: t.job_id ?? '', delta: Math.round(delta * 1000) / 1000 }) + '\n') } catch { /* best effort */ }
  }
  async function onFinish(t: Task, out: Outcome) {
    logUsage(t)
    if (out.kind === 'limit') {
      limitUntil = out.resets_at ?? Date.now() + 3600_000
      if (t.kind === 'resume') { const ob = OB.loadOb(); ob.doing = `Claude's usage limit is reached. I'll continue at ${clock(limitUntil)}.`; OB.saveOb(ob); void renderOb(ob) }
      else if (t.kind !== 'chat') cards.update(String(t.payload.parent ?? t.id), c => { c.state = 'waiting'; c.wait_until = limitUntil })
      else await sendTo(`${heading('⏳', 'Claude usage limit reached')}\n${note(`I'll answer at ${clock(limitUntil)}, automatically.`)}`)
      return refresh()
    }
    if (out.kind === 'auth') {
      await sendTo(`${heading('🔑', 'Claude needs you on your computer')}\n${esc(out.text ?? '')}\n\nOpen a terminal and run <code>claude</code>, log in with your Claude account, then tap Try again (or send the link again).`, [], { loud: true })
    }
    if (t.kind === 'chat') {
      if (out.kind === 'done' && !spoke.has(t.id) && out.result?.trim()) for (const c of splitMsg(esc(out.result.trim()), 3900)) await sendTo(c)
      else if (out.kind === 'error' || out.kind === 'timeout') await sendTo(`${heading('⚠️', "I couldn't answer that")}\n${note('Something went wrong on my side. Try asking again.')}`)
      spoke.delete(t.id)
      return refresh()
    }
    spoke.delete(t.id)
    if (out.kind === 'retrying') { cards.update(t.id, c => { c.state = 'queued'; c.note = out.text }); syncQueued(); return refresh() }
    if (t.kind === 'repair') return finishRepair(t, out)
    if (t.kind === 'resume') return finishResume(out)
    if (t.payload.parent) return finishChild(t, out)
    const failText = out.kind === 'timeout' ? 'This took too long, so I stopped it.' : out.kind === 'auth' ? 'Claude is not logged in on your computer.' : out.kind === 'error' ? 'Something went wrong on my side.' : ''
    cards.update(t.id, c => {
      for (const line of c.jobs) {
        const j = line.job_id ? readJob(line.job_id) : null
        if (j) { line.final = finalFor(j.status, lastDetail(j), j.id); if (j.company) line.title = jobTitle(j); if (!line.url) line.url = j.url }
        if (out.kind === 'cancelled' && j && !line.final?.text.startsWith('Ready')) line.final = { emoji: '✋', text: 'Stopped. Nothing was sent.', buttons: [{ text: '🔄 Resume', data: `j:rt:${code(j.id)}` }, { text: '⏭ Skip it', data: `j:sk:${code(j.id)}` }] }
        else if (failText && (!line.final || j && !['SKIPPED', 'CLOSED', 'AWAITING_APPROVAL', 'NEEDS_ANSWERS', 'KIT_READY'].includes(j.status))) line.final = { emoji: '⚠️', text: failText, buttons: j ? [{ text: '🔄 Try again', data: `j:rt:${code(j.id)}` }] : [] }
        else if (!line.final && j) line.final = { emoji: '⏸', text: 'I stopped partway through.', buttons: [{ text: '🔄 Continue', data: `j:rt:${code(j.id)}` }] }
      }
      if (out.kind === 'cancelled' && !c.jobs.some(l => l.job_id)) c.final = { emoji: '✋', text: 'Stopped.' }
      else if (!c.jobs.some(l => l.job_id)) c.final = failText ? { emoji: '⚠️', text: failText, ...(t.payload.url ? { buttons: [{ text: '🔄 Try again', data: `u:again:${t.id}` }] } : {}) } : c.mode === 'multi' ? { emoji: '✅', text: c.note ? 'Done.' : 'Done. Nothing new this time.' } : { emoji: 'ℹ️', text: 'Done. See my message below.' }
      c.state = 'ended'; c.ended = Date.now(); c.doing = null
      if (c.jobs.length === 1 && c.mode === 'job' && c.jobs[0].final) c.final = c.jobs[0].final
      // A failure with no known cause can be handed to Claude to investigate; an expected one (a login, a site that is down) has its own fix.
      const unknown = (f: Final) => out.kind === 'error' || out.kind === 'timeout' || f.text === 'Something went wrong.'
      for (const f of [c.final, ...c.jobs.map(l => l.final)]) if (f?.emoji === '⚠️' && unknown(f) && !f.buttons?.some(b => b.data === FIX_BUTTON.data || b.data?.startsWith('L:in:'))) f.buttons = [...(f.buttons ?? []), FIX_BUTTON]
    })
    if (t.payload.url) lastUrls.set(t.id, String(t.payload.url))
    for (const l of cards.get(t.id)?.jobs ?? []) await maybeSendKit(l.job_id)
    refresh()
  }
  const lastUrls = new Map<string, string>()
  const usedBy = (id: string) => {
    let text = ''
    try { text = readFileSync(join(DATA, 'usage_log.jsonl'), 'utf8') } catch { return undefined }
    const sum = text.split('\n').filter(l => l.includes(`"job_id":"${id}"`)).reduce((n, l) => { try { return n + (JSON.parse(l).delta ?? 0) } catch { return n } }, 0)
    return sum > 0 ? Math.max(1, Math.round(sum * 100)) : undefined
  }
  // A job that ended at KIT_READY: send its kit once (files first, then the steps and answers).
  const kitSent = new Set<string>()
  async function sendKitFiles(id: string) {
    const to = paired()
    const files = readKit(id).files.map(f => join(jobDir(id), f))
    if (to == null || !files.length) return
    if (files.length > 1) await api.sendMediaGroup(to, files.map(f => ({ type: 'document' as const, media: new InputFile(f) })), { disable_notification: true }).catch(e => log(`kit files failed: ${e}`))
    else await api.sendDocument(to, new InputFile(files[0]), { disable_notification: true }).catch(e => log(`kit file failed: ${e}`))
  }
  async function maybeSendKit(id: string | undefined) {
    const j = id ? readJob(id) : null
    if (!j || j.status !== 'KIT_READY' || kitSent.has(j.id)) return
    kitSent.add(j.id)
    await sendKitFiles(j.id)
    const p = kitPage(j, readKit(j.id))
    await sendTo(p.text, p.rows, { kind: 'search' })
  }
  // One job from an auto-search run: its line on the search card shows how it ended; one failure never stops the others.
  function finishChild(t: Task, out: Outcome) {
    const key = String(t.payload.parent), j = t.job_id ? readJob(t.job_id) : null
    cards.update(key, c => {
      const line = c.jobs.find(l => l.job_id === t.job_id)
      if (!line) return
      if (j?.company) line.title = jobTitle(j)
      line.final = out.kind === 'cancelled' ? { emoji: '✋', text: 'Stopped. Nothing was sent.' }
        : (j && finalFor(j.status, lastDetail(j), j.id)) || (out.kind === 'done' ? { emoji: '⏸', text: 'I stopped partway through.', buttons: j ? [{ text: '🔄 Continue', data: `j:rt:${code(j.id)}` }] : [] }
          : { emoji: '⚠️', text: out.kind === 'timeout' ? 'This took too long, so I stopped it.' : 'Something went wrong on my side.', buttons: [...(j ? [{ text: '🔄 Try again', data: `j:rt:${code(j.id)}` }] : []), FIX_BUTTON] })
      if (c.active === t.job_id) { c.active = undefined; c.doing = 'Waiting for my turn' }
    })
    finishSearchIfDone(key) // its kit or review is announced in the search digest
    refresh()
  }

  const agent = createAgent({
    bridge: () => ({ url: bridge.url, secret: bridge.secret }),
    onLive, onFinish, exec: o.exec,
    onUsage: u => { usage = { ...usage, ...u }; if (u.limited && u.resets_at) limitUntil = u.resets_at; writeJson(USAGE_FILE, usage); refresh() },
    canRunBackground: () => {
      const stale = (usage.resets_at ?? Infinity) < Date.now() || Date.now() - usage.at > 5 * 3600_000 // that 5-hour window is over
      return stale || (usage.five_hour ?? 0) < 1 - loadSettings().discovery.reserve_pct / 100
    },
  })

  const review = createReview({
    api, to: paired, silent, refresh, run,
    revise: (id, request) => { const j = readJob(id); startTask({ kind: 'revise', job_id: id, title: j ? jobTitle(j) : id, payload: { request } }) },
    onResult: () => refresh(),
    setPending: p => { pending = p },
  })

  // ---- Tools (Claude -> app) ----
  const taskById = (id: string) => (['work', 'chat'] as Lane[]).map(l => agent.live(l)?.task).find(t => t?.id === id)
  const inData = (p: string) => {
    if (!isAbsolute(p)) throw new Error(`not an absolute path: ${p}`)
    const rel = relative(realpathSync.native(DATA), realpathSync.native(p))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing a file outside data/: ${p}`)
    return p
  }
  async function handleTool(taskId: string, name: string, a: Record<string, any>): Promise<ToolResult> {
    const t = taskById(taskId)
    if (!t) return { text: 'error: this task is not running any more (it was stopped). Stop now.', isError: true }
    const ok = (text: string) => ({ text })
    if (name === 'settings_get') { const { paired_user_id: _, ...s } = loadSettings(); return ok(JSON.stringify(s, null, 2)) }
    if (name === 'settings_update') {
      if (t.kind !== 'chat') throw new Error('settings_update is only for chat tasks, when the user asked for a change')
      const p = a.patch
      if (!p || typeof p !== 'object' || ['paired_user_id', 'onboarded', 'version'].some(k => k in p) || ('dry_run' in p && p.dry_run !== true)) {
        throw new Error('that setting cannot be changed from chat (practice mode is turned off only with the button in Settings)')
      }
      const r = trySettingsUpdate(p)
      if (!r.ok) throw new Error(r.error)
      refresh()
      return ok('saved')
    }
    if (name === 'profile_ready') {
      if (t.kind !== 'resume') throw new Error('profile_ready is only for resume tasks')
      const r = SummarySchema.safeParse(a)
      if (!r.success) throw new Error(`${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`)
      const ob = OB.loadOb()
      const sum = r.data
      ob.summary = { name: sum.name, headline: sum.headline, years: sum.years ?? null, level: sum.level, location: sum.location ?? '', country: sum.country ?? '', email: sum.email ?? '', phone: sum.phone ?? '', skills: sum.skills, suggested_titles: sum.suggested_titles, related_titles: sum.related_titles ?? [] }
      ob.country = ob.country || sum.country || ''
      OB.saveOb(ob)
      const s = loadSettings()
      if (!s.onboarded) trySettingsUpdate({ filters: { experience_level: sum.level, ...(sum.years != null ? { years_experience: sum.years } : {}), ...(!s.filters.country && ob.country ? { country: short(ob.country, 60) } : {}) } })
      return ok('shown to the user for confirmation. You are done: stop now.')
    }
    if (name === 'tg_send') {
      if (a.tone !== undefined && !(a.tone in TONES)) throw new Error('tone must be info, success, warn or error')
      const bad = (a.buttons ?? []).find((b: string) => !(b in AGENT_BUTTONS))
      if (bad) throw new Error(`unknown button "${bad}". Allowed: ${Object.keys(AGENT_BUTTONS).join(', ')}`)
      const files = ((a.files ?? []) as string[]).map(inData)
      let text = String(a.text ?? '')
      if (a.tone) text = a.title ? `${heading(TONES[a.tone], esc(a.title))}\n${text}` : `${TONES[a.tone]} ${text}`
      else if (a.title) text = `<b>${esc(a.title)}</b>\n${text}`
      const rows: Btn[][] = a.buttons?.length ? [(a.buttons as string[]).map(b => ({ text: AGENT_BUTTONS[b], data: b }))] : []
      const chunks = splitMsg(text)
      for (const [i, c] of chunks.entries()) await sendTo(c, i === chunks.length - 1 ? rows : [], { loud: !a.silent })
      for (const f of files) await api.sendDocument(paired()!, new InputFile(f), { disable_notification: true })
      spoke.add(t.id)
      return ok('sent')
    }
    if (name === 'tg_progress') {
      if (t.kind === 'chat' || t.kind === 'resume') return ok('ok')
      if (a.job_id !== undefined && !JOB_RE.test(String(a.job_id))) throw new Error('bad job_id')
      if (a.stage !== undefined && !['read', 'score', 'tailor', 'fill', 'review'].includes(a.stage)) throw new Error('stage must be read, score, tailor, fill or review')
      if (t.kind === 'discover') return ok('ok') // finding new companies runs in the background, without a card
      const key = String(t.payload.parent ?? t.id)
      cards.update(key, c => {
        if (a.note && !t.payload.parent) c.note = short(String(a.note), 200)
        if (!a.job_id) return
        let line = c.jobs.find(j => j.job_id === a.job_id)
        if (!line && c.mode === 'job' && c.jobs[0] && !c.jobs[0].job_id) line = Object.assign(c.jobs[0], { job_id: String(a.job_id) })
        if (!line) { line = { job_id: String(a.job_id), title: String(a.title ?? a.job_id), details: {} }; c.jobs.push(line) }
        if (a.title) line.title = short(String(a.title), 80)
        if (a.url && /^https?:\/\//.test(a.url)) line.url = String(a.url)
        if (a.stage && a.stage !== line.stage) {
          if (line.stage && line.stage_at) recordStage(line.stage, Date.now() - line.stage_at)
          line.stage_at = Date.now()
        }
        if (a.stage) { line.stage = a.stage as Stage; if (a.detail) line.details[a.stage as Stage] = short(String(a.detail), 40) }
        if (c.mode === 'job') c.typical_ms ??= typicalMs() ?? undefined
      }, t.payload.parent ? undefined : () => ({ ...newCard(t), state: 'running', started: Date.now() }))
      refresh()
      return ok('ok')
    }
    if (name === 'tg_ask') {
      if (!F.BATCH_RE.test(String(a.batch_id))) throw new Error('batch_id must match [A-Za-z0-9_-]{1,80}')
      if (a.job_id !== undefined && !JOB_RE.test(String(a.job_id))) throw new Error('bad job_id')
      if (F.loadForm(String(a.batch_id))?.status === 'open') throw new Error('a form with this batch_id is already open')
      const f = F.newForm(String(a.batch_id), a.job_id, a.title ? short(String(a.title), 100) : undefined, F.validateQuestions(a.questions, !!a.job_id))
      const p = P.askPage(f)
      await sendTo(p.text, p.rows, { kind: 'reviews' })
      F.saveForm(f)
      spoke.add(t.id)
      refresh()
      return ok('form started: the user was told to answer under Open Questions. The answers arrive in a new task once the user confirms. Set the job to NEEDS_ANSWERS now and stop.')
    }
    if (name === 'tg_review') { const r = await review.send(String(a.job_id), !!t.payload.parent); spoke.add(t.id); return ok(r) }
    throw new Error(`unknown tool ${name}`)
  }
  const bridge = startBridge(() => TOOLS, handleTool)

  // ---- Form results: the app saves answers itself, then starts the job again ----
  async function onFormEvent(ev: F.FormEvent) {
    const f = ev.form
    if (ev.kind === 'skipped') {
      if (f.job_id) {
        stopTasks(t => t.job_id === f.job_id)
        await run(['job', 'set-status', f.job_id, 'SKIPPED', '--detail', 'you skipped it from the questions'])
      }
      return refresh()
    }
    for (const x of ev.answers) {
      if (x.save !== 'no' && x.save_key) {
        const v = Array.isArray(x.value) ? x.value.join(', ') : String(x.value)
        if (x.save === 'job' && f.job_id) saveQ = saveQ.then(() => run(['profile', 'answer', 'set', x.save_key!, `--question=${x.question}`, `--value=${v}`, '--scope=job', `--job=${f.job_id}`, ...(x.sensitive ? ['--sensitive'] : [])]))
        else void saveAnswer(x.save_key, x.question, v, x.sensitive, f.job_id)
      }
    }
    await saveQ
    if (!f.job_id) {
      startTask({ kind: 'chat', title: 'Your answers', payload: { text: `(The user answered your questions in a form) ${JSON.stringify(ev.answers.map(x => ({ question: x.question, answer: x.value })))}` } }, false)
      return
    }
    const file = join(jobDir(f.job_id), 'answers.json')
    const byFid = { ...readJson<Record<string, unknown>>(file, {}) }
    for (const x of ev.answers) if (x.fid) byFid[x.fid] = x.value
    writeJson(file, byFid)
    const loose = ev.answers.filter(x => !x.fid).map(x => ({ qid: x.qid, question: x.question, answer: x.value }))
    continueJob(f.job_id, 'continue', loose.length ? { answers: loose } : {})
  }
  async function applyStep(step: F.Step) {
    F.saveForm(step.form)
    const to = paired()
    if (step.form.message_id && to != null) await editAt(to, step.form.message_id, F.render(step.form))
    if (step.event) await onFormEvent(step.event)
    refresh()
  }

  // ---- Setup wizard ----
  async function contactFields(): Promise<Record<string, string>> { return readSection('Contact') }
  async function renderOb(ob = OB.loadOb(), fresh = false) {
    const to = paired()
    if (to == null) return
    const p = OB.obPage(ob, loadSettings(), ob.step === 'profile' ? await contactFields() : {})
    if (ob.msg && !fresh) {
      try { await api.editMessageText(to, ob.msg, p.text, { ...OPTS, reply_markup: kb(p) }); return } catch (e) {
        if (/not modified/i.test(String(e))) return
      }
    }
    if (ob.msg && fresh) void api.deleteMessage(to, ob.msg).catch(() => {})
    ob.msg = (await api.sendMessage(to, p.text, { ...OPTS, reply_markup: kb(p) })).message_id
    OB.saveOb(ob)
  }
  async function importResume(path: string, replace: boolean) {
    const ob = OB.loadOb()
    const r = await run(['resume', 'import', path])
    if (!r.ok || r.warning) {
      ob.step = 'resume'
      ob.error = r.warning ? "I couldn't find any text in that file (is it a scan or a photo?). Please send a text-based PDF or a .docx." : `I couldn't open that file. ${r.code === 'bad_file' ? 'Please send a PDF or .docx.' : 'Try saving it again as PDF.'}`
    } else {
      Object.assign(ob, { step: 'reading', error: undefined, doing: null, replace, render_warning: undefined, summary: undefined })
      startTask({ kind: 'resume', title: 'Reading your resume', payload: { path: r.resume } }, false)
    }
    OB.saveOb(ob)
    await renderOb(ob, true)
  }
  async function finishResume(out: Outcome) {
    const ob = OB.loadOb()
    if (out.kind === 'done' && ob.summary) {
      ob.step = 'profile'; ob.doing = null
      OB.saveOb(ob)
      await renderOb(ob)
      const r = await run(['resume-check'])
      if (!r.ok && r.code === 'no_converter') {
        ob.render_warning = "Word or LibreOffice isn't installed on your computer, so I can't turn a .docx resume into the PDF I attach. Install one of them, or send your resume as a PDF."
        OB.saveOb(ob); await renderOb(ob)
      } else if (r.png && existsSync(r.png)) {
        await api.sendPhoto(paired()!, new InputFile(r.png), { caption: r.ok ? '📄 This is how your resume looks when I attach it.' : '⚠️ Your resume does not convert cleanly on this computer. If this looks wrong, send it as a PDF instead.', disable_notification: true }).catch(e => log(`preview failed: ${e}`))
      }
    } else {
      ob.step = 'resume'; ob.doing = null
      ob.error = out.kind === 'auth' ? (out.text ?? 'Claude is not logged in on your computer.') : "Something went wrong while reading it. Please send the file again."
      OB.saveOb(ob); await renderOb(ob)
    }
  }
  async function obStep(ob: OB.Ob, step: OB.ObStep) {
    ob.step = step
    if (step === 'done') {
      const first = !loadSettings().onboarded
      trySettingsUpdate({ onboarded: true }); refresh()
      // First value in minutes: one search right away, its top 3 prepared, instead of an empty Home.
      if (first && loadSettings().filters.titles.length && !discoveryBusy()) void startDiscover('first')
    }
    OB.saveOb(ob)
  }
  const { titlePool, locPool } = OB

  async function obRoute(data: string, chat: number, msg: number, toast: { text?: string }): Promise<Page | string | undefined> {
    const ob = OB.loadOb()
    ob.msg = msg
    const s = loadSettings()
    const [, op, arg, arg2] = data.split(':')
    const nextAfterSave = async (step: OB.ObStep) => { await obStep(ob, step); return OB.obPage(ob, loadSettings()) }
    switch (op) {
      case 'resume': if (ob.step === 'done') ob.step = 'welcome'; OB.saveOb(ob); return OB.obPage(ob, s, ob.step === 'profile' ? await contactFields() : {})
      case 'go': await obStep(ob, arg as OB.ObStep); if (arg === 'resume') pending = { kind: 'resume', chat, msg, at: Date.now() }; return OB.obPage(ob, s, arg === 'profile' ? await contactFields() : {})
      case 'ok':
        if (ob.replace) { ob.replace = false; await obStep(ob, 'done'); return profileHome() }
        return nextAfterSave('titles')
      case 'f': {
        const lbl = OB.PROFILE_FIELDS.find(([k]) => k === arg)?.[1]
        if (!lbl) return undefined
        pending = { kind: 'contact', key: arg, ob: true, chat, msg, at: Date.now() }
        return OB.obPrompt(arg, lbl)
      }
      case 't': { const x = titlePool(ob)[+arg]; if (x) ob.picks = ob.picks.includes(x) ? ob.picks.filter(y => y !== x) : [...ob.picks, x]; OB.saveOb(ob); return OB.obPage(ob, s) }
      case 'rt': { const x = OB.relPool(ob)[+arg], have = ob.rel ?? []; if (x) ob.rel = have.includes(x) ? have.filter(y => y !== x) : [...have, x]; OB.saveOb(ob); return OB.obPage(ob, s) }
      case 'l': { const x = locPool(ob)[+arg]; if (x) ob.locs = ob.locs.includes(x) ? ob.locs.filter(y => y !== x) : [...ob.locs, x]; OB.saveOb(ob); return OB.obPage(ob, s) }
      case 'add': pending = { kind: 'ob', what: arg, chat, msg, at: Date.now() }; return OB.obPrompt(arg)
      case 'cancel': pending = null; return OB.obPage(ob, s, ob.step === 'profile' ? await contactFields() : {})
      case 'next':
        if (arg === 'titles') {
          if (!ob.picks.length) return 'Pick or add at least one job title.'
          const rel = [...new Set([...s.filters.related_titles, ...(ob.rel ?? []).filter(x => OB.relPool(ob).includes(x))])].filter(x => !ob.picks.includes(x)).slice(0, 15)
          const r = trySettingsUpdate({ filters: { titles: ob.picks, related_titles: rel } })
          return r.ok ? nextAfterSave('level') : r.error
        }
        if (arg === 'locations') { const r = trySettingsUpdate({ filters: { locations: ob.locs } }); return r.ok ? nextAfterSave('remote') : r.error }
        return undefined
      case 'lv': { const r = trySettingsUpdate({ filters: { experience_level: arg } }); return r.ok ? nextAfterSave('locations') : r.error }
      case 'rm': { const r = trySettingsUpdate({ filters: { remote: arg } }); return r.ok ? nextAfterSave('salary') : r.error }
      case 'cur': {
        const all = Object.keys(CURRENCIES), i = all.indexOf(s.filters.currency)
        trySettingsUpdate({ filters: { currency: all[(i + 1) % all.length] } })
        return OB.obPage(ob, loadSettings())
      }
      case 'sa': {
        const n = parseInt(arg, 10)
        trySettingsUpdate({ filters: { min_salary: n > 0 ? n : null } })
        if (n > 0) void saveAnswer('salary_expectation_min', 'Minimum yearly salary you would accept', String(n), true)
        return nextAfterSave('auth')
      }
      case 'au': {
        const c = ob.country || ob.summary?.country || 'your country'
        void saveAnswer(OB.keyFor(c), `Are you legally authorized to work in ${c}?`, arg === 'yes' ? 'Yes' : 'No', true)
        return nextAfterSave('sponsor')
      }
      case 'sp': void saveAnswer('sponsorship_required', 'Will you now or in the future require visa sponsorship?', arg, true); return nextAfterSave('start')
      case 'st': void saveAnswer('start_availability', 'When can you start?', arg, false); return nextAfterSave('relocate')
      case 'rl': void saveAnswer('willing_to_relocate', 'Are you willing to relocate?', arg, true); return nextAfterSave(isUS(s.filters.country || ob.country || ob.summary?.country || '') ? 'eeo' : 'done') // the EEO questions are a US thing
      case 'eo':
        if (arg === 'decline') for (const k of OB.EEO_ORDER) void saveAnswer(OB.EEO[k].key, `${OB.EEO[k].q} (voluntary self-identification)`, OB.DECLINE, true)
        return nextAfterSave(arg === 'answer' ? 'eeo_gender' : 'done')
      case 'e': {
        const st = arg as (typeof OB.EEO_ORDER)[number], e = OB.EEO[st], opt = e?.opts[parseInt(arg2, 10)]
        if (!opt) return undefined
        void saveAnswer(e.key, `${e.q} (voluntary self-identification)`, opt[1], true)
        const i = OB.EEO_ORDER.indexOf(st)
        return nextAfterSave(i < OB.EEO_ORDER.length - 1 ? OB.EEO_ORDER[i + 1] : 'done')
      }
      case 'auto': {
        trySettingsUpdate({ discovery: { enabled: true } })
        refresh()
        toast.text = '🔭 Auto-search is on'
        return OB.obPage(ob, loadSettings()) // the first search is already running, so no "Search now" here
      }
    }
    return undefined
  }

  // ---- Profile and answers ----
  async function answers(): Promise<P.AnswerRec[] | null> { return readAnswers() }
  const helperDown: Page = { text: `${heading('⚠️', "Couldn't read your profile")}\n${note('The helper on your computer did not answer. Is setup complete? Tap to try again.')}`, rows: [[{ text: '🔄 Try again', data: 'm:prof' }], [{ text: '🏠 Home', data: 'm:home' }]] }
  const achievements = (): [string, string][] => Object.entries(readSection('Achievements')).filter(([k, v]) => /^a\d{1,2}$/.test(k) && v.trim()).sort((a, b) => parseInt(a[0].slice(1)) - parseInt(b[0].slice(1)))
  async function profileHome(): Promise<Page> {
    const [contact, list] = await Promise.all([contactFields(), answers()])
    if (!list) return helperDown
    const resume = ['pdf', 'docx'].map(e => `base_resume.${e}`).find(f => existsSync(join(DATA, f))) ?? null
    return P.profilePage(loadSettings(), contact, list, resume, versions())
  }
  // names of the extra resume versions (data/resumes/<name>.txt, written by `jobagent resume import --version`)
  const versions = (): string[] => { try { return readdirSync(join(DATA, 'resumes')).filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)).sort() } catch { return [] } }
  const boards = async (): Promise<string[]> => [...new Set(Object.values(readBoards()).flat())].sort() // every ATS, read without Python
  const companies = async (msg?: string) => { const b = await boards(), l = readJson<Record<string, unknown>>(join(DATA, 'boards_learned.json'), {}); return ST.companiesPage(b, msg, b.filter(x => x in l).length) }
  const ideas = (s: Settings) => ST.relatedIdeas(readJson<ST.SeenTitles>(join(DATA, 'seen_titles.json'), {}), s)
  const specView = (spec: ST.Spec, s: Settings, msg?: string) => ST.specPage(spec, s, msg, spec.id === 'rt' ? ideas(s) : [])
  // A task is running or waiting for this job (its own, or a line on a search card).
  const busyJob = (id: string) => [agent.live('work')?.task, ...agent.queued()].some(t => t && (t.job_id === id || cards.get(t.id)?.jobs.some(l => l.job_id === id)))
  // Typed input, shared by the Telegram screens and the dashboard. Each returns an error to show, or the result.
  async function addCompany(text: string): Promise<{ error: string } | { company: string; open_jobs?: number }> {
    const slug = ST.boardSlug(text)
    if (!slug) return { error: "That doesn't look like a job board link or name." }
    const ats = /lever\.co/i.test(text) ? 'lever' : /ashbyhq\.com/i.test(text) ? 'ashby' : /greenhouse\.io/i.test(text) ? 'greenhouse' : null // a pasted link names its ATS
    const c = await run(['boards', 'check', slug, ...(ats ? [`--ats=${ats}`] : [])])
    if (!c.ok) return { error: c.code === 'not_found' ? `There is no Greenhouse, Lever or Ashby job board called "${slug}".` : "I couldn't reach the job board. Try again in a minute." }
    await run(['boards', 'add', c.ats ?? 'greenhouse', slug])
    return { company: String(c.company), open_jobs: c.open_jobs ?? undefined }
  }
  async function addAchievement(text: string): Promise<string | null> {
    const used = new Set(achievements().map(([k]) => k))
    const key = [...Array(P.ACH_MAX)].map((_, i) => `a${i + 1}`).find(k => !used.has(k))
    if (!key) return 'That is the most I keep. Remove one first.'
    if (text.trim().length < 10) return 'Tell me a little more: what you did and what came of it.'
    const r = await run(['profile', 'set-field', 'Achievements', key, text])
    return r.ok ? null : r.error ?? 'could not save'
  }
  const rewriteAnswer = (a: P.AnswerRec, text: string) =>
    run(['profile', 'answer', 'set', a.base_key, `--question=${a.question}`, `--value=${text}`, `--scope=${a.scope}`, ...(a.job ? [`--job=${a.job}`] : []), ...(a.sensitive ? ['--sensitive'] : [])])
  const requestChange = (id: string, text: string) => {
    review.cancelAuto(id)
    const j = readJob(id)
    startTask({ kind: 'revise', job_id: id, title: j ? jobTitle(j) : id, payload: { request: text.slice(0, 1000) } })
  }
  async function addVersion(path: string): Promise<string | null> {
    const r = await run(['resume', 'import', path, '--version'])
    return r.ok ? null : r.code === 'no_text' ? "I couldn't find any text in it (is it a scan?). Send a text-based PDF or a .docx." : r.code === 'too_many' ? 'You have the most versions I keep. Remove one first.' : 'I couldn\'t open that file. Try saving it again as PDF.'
  }
  let loginOpen = false // one login window at a time: they share JobAgent's browser profile
  // Jobs that failed because a job site wanted a login (fetch's detail starts with the site name), so a login can retry them.
  const needLogin = (site: string) => allJobs().filter(j => j.status === 'FAILED' && /\blogged in\b/i.test(lastDetail(j)) && lastDetail(j).startsWith(ST.JOB_SITES[site]))
  const loginsNow = async (note?: string, site?: string) => {
    const r = loginOpen ? null : await run(['login', 'status'])
    return ST.loginsPage(r?.ok ? r.sites : null, note, site ? { site, n: needLogin(site).length } : undefined)
  }

  // ---- Callback router: returns the page to show in place, a short toast, or nothing ----
  async function route(ctx: Context, data: string, toast: { text?: string }): Promise<Page | string | undefined> {
    const s = loadSettings()
    const chat = ctx.chat!.id, msg = ctx.callbackQuery!.message!.message_id
    if (data === 'noop') return undefined
    // Navigating away cancels a half-typed input. A verification code stays: it expires in minutes.
    if (pending?.kind !== 'code' && !data.startsWith('f:') && !data.startsWith('o:f') && !data.startsWith('o:add')) pending = null
    let m: RegExpExecArray | null

    if (data === 'm:home') return P.home(homeCtx())
    if ((m = /^Q:(\d+)$/.exec(data))) {
      const list = P.reviewQueue(allJobs()), i = Math.min(parseInt(m[1], 10), Math.max(0, list.length - 1))
      const rv = list[i] ? review.readReview(list[i].id) : null
      if (!rv) return { text: `${heading('🔔', 'Review queue')}\n\n✨ ${note('Nothing is waiting for your review.')}`, rows: [nav()] }
      const pg = reviewPage(rv, practiceOn(s))
      return { ...pg, rows: [...pg.rows, [{ text: i > 0 ? '◀' : ' ', data: i > 0 ? `Q:${i - 1}` : 'noop' }, { text: `${i + 1} of ${list.length}`, data: 'noop' }, { text: i < list.length - 1 ? '▶' : ' ', data: i < list.length - 1 ? `Q:${i + 1}` : 'noop' }], nav()] }
    }
    if (data === 'm:help') return P.helpPage()
    if (data === 'I:0') return insightsPage(allJobs(), readOutcomes(), s.apply.min_match_score)
    if ((m = /^sg:ms:(\d{1,3})$/.exec(data))) {
      const n = parseInt(m[1], 10)
      if (n > 100) return 'That is not a score.'
      const r = trySettingsUpdate({ apply: { min_match_score: n } })
      if (!r.ok) return `Could not change it: ${r.error}`
      toast.text = `📊 Minimum match score is now ${n}`
      return P.home(homeCtx())
    }
    if ((m = /^sg:no:(\d{1,3})$/.exec(data))) { writeJson(TIP_FILE, { dismissed: parseInt(m[1], 10) }); return P.home(homeCtx()) }
    if (data === 'm:health') return P.healthPage(health?.checks ?? null, health?.at)
    if (data === 'm:dash') return P.dashPage(dash?.link ?? null, phoneUrl())
    if (data === 'm:dash:ph') { if (!dash) return 'The dashboard is not running.'; pending = { kind: 'dashurl', chat, msg, at: Date.now() }; return P.phoneSetupPage(dash.port) }
    if (data === 'm:dash:off') { setPhoneUrl(null); toast.text = '🚫 Phone access is off'; return P.dashPage(dash?.link ?? null, null) }
    if (data === 'm:upd') return P.updatePage(updates)
    if (data === 'm:hc') { await checkHealth(); return P.healthPage(health?.checks ?? null, health?.at) }
    if ((m = /^h:(\w+)$/.exec(data))) return P.helpPage(m[1])
    if (data === 'm:settings') return ST.settingsRoot(s, boardCount())
    if (data === 'm:prof') return profileHome()
    if (data === 'N:0') return P.needsPage({ jobs: allJobs(), forms: F.openForms() })
    if (data === 'H:pause' || data === 'H:resume') { setAgent(data === 'H:resume'); toast.text = data === 'H:resume' ? '▶️ Resumed' : '⏸ Paused. I will finish the current step, then wait.'; return cards.all().some(c => c.msg === msg) ? undefined : P.home(homeCtx()) } // Resume on a paused card keeps the card
    if (data === 'd:run') {
      if (!s.onboarded) return 'Finish setup first.'
      if (discoveryBusy()) return 'A search is already running.'
      void startDiscover('manual')
      toast.text = '🔎 Searching now. Watch the card below.'
      return undefined
    }
    if (data.startsWith('o:')) return obRoute(data, chat, msg, toast)

    // Jobs
    if ((m = /^J:([ads]):(\d+)$/.exec(data))) return P.jobsPage(allJobs(), m[1], parseInt(m[2], 10), readOutcomes())
    if (data === 'J:csv') {
      const r = await run(['log', 'export'])
      if (!r.ok) return `Export failed: ${r.error}`
      await api.sendDocument(chat, new InputFile(r.path, 'jobagent-applications.csv'), { caption: `📋 ${(r.rows as unknown[]).length} jobs. Opens in Excel, Numbers or Google Sheets.`, disable_notification: true })
      return '⬇️ Sent below'
    }
    if ((m = /^j:(v|rt|any|x|sk|o|ap|kit|rc|fu|zz|pr|go):([0-9a-f]{8})(?::([iorg]))?$/.exec(data))) {
      const id = findJob(m[2]), j = id ? readJob(id) : null
      if (!id || !j) return 'That job no longer exists.'
      const onCard = cards.all().some(c => c.msg === msg)
      const running = busyJob(id)
      const detail = async () => P.jobPage(readJob(id)!, { usedPct: usedBy(id), running: busyJob(id), hasForm: F.openForms().some(f => f.job_id === id), outcome: readOutcomes()[id] })
      if (m[1] === 'v') return detail()
      if (m[1] === 'kit') { await sendKitFiles(id); return kitPage(j, readKit(id)) }
      if (m[1] === 'zz') { writeJson(FOLLOW_FILE, { ...readJson<P.FollowState>(FOLLOW_FILE, {}), [id]: { snooze_until: new Date(Date.now() + 7 * 86_400_000).toISOString() } }); toast.text = '⏰ I will ask again in a week'; return { text: `${heading('⏰', 'Asking again in a week')}\n${esc(jobTitle(j))}`, rows: [nav('J:d:0')] } }
      if (m[1] === 'pr') {
        if (running) return 'I am already working on it.'
        startTask({ kind: 'prep', job_id: id, title: `Interview prep · ${jobTitle(j)}`, payload: {} })
        toast.text = '🎤 Building your prep pack. Watch the card below.'
        return onCard ? undefined : detail()
      }
      if (m[1] === 'fu') {
        if (running) return 'I am already working on it.'
        startTask({ kind: 'followup', job_id: id, title: `Follow-up · ${jobTitle(j)}`, payload: {} })
        toast.text = '✍️ Drafting it. Watch the card below.'
        return onCard ? undefined : detail()
      }
      if (m[1] === 'rc') {
        const r = readJson<P.Receipt | null>(join(jobDir(id), 'receipt.json'), null), shot = join(jobDir(id), 'screenshots', 'submitted.png')
        if (r && !r.practice && existsSync(shot)) await api.sendPhoto(chat, new InputFile(shot), { caption: '🧾 The confirmation page', disable_notification: true }).catch(e => log(`receipt shot failed: ${e}`))
        return P.receiptPage(j, r)
      }
      if (m[1] === 'ap') {
        const r = await run(['job', 'set-status', id, 'APPLIED_SELF', '--detail', 'you applied yourself'])
        if (!r.ok) return `Could not save that: ${r.error}`
        logDecision(id, 'applied_self')
        toast.text = '✅ Marked as applied'; refresh()
        if (onCard) { cards.update(cards.all().find(c => c.msg === msg)!.key, c => { for (const l of c.jobs) if (l.job_id === id) l.final = finalFor('APPLIED_SELF', '', id); if (c.mode === 'job') c.final = c.jobs[0]?.final }); return undefined }
        return detail()
      }
      if (m[1] === 'x') { stopTasks(t => t.job_id === id || !!cards.get(t.id)?.jobs.some(l => l.job_id === id)); toast.text = '✋ Stopped'; return detail() }
      if (m[1] === 'sk') {
        stopTasks(t => t.job_id === id)
        const r = await run(['job', 'set-status', id, 'SKIPPED', '--detail', 'you skipped it'])
        if (!r.ok) return `Could not skip: ${r.error}`
        logDecision(id, 'skip')
        toast.text = '⏭ Skipped'; refresh()
        if (onCard) { cards.update(cards.all().find(c => c.msg === msg)!.key, c => { for (const l of c.jobs) if (l.job_id === id) l.final = finalFor('SKIPPED', 'you skipped it', id); if (c.mode === 'job') c.final = c.jobs[0]?.final }); return undefined }
        return detail()
      }
      if (m[1] === 'go') { // a practice run, now for real: prepared and reviewed again, so nothing is sent without a fresh Approve
        if (j.status !== 'DRY_RUN_DONE') return 'This one is not a practice run.'
        if (practiceOn(s)) { toast.text = '🧪 Turn practice mode off first, then tap Apply for real again'; return ST.practicePage(s) }
        if (running) return 'I am already working on it.'
        const r = await run(['job', 'set-status', id, 'READY', '--detail', 'you chose to apply for real'])
        if (!r.ok) return `Could not do that: ${r.error}`
        continueJob(id, 'retry'); toast.text = '🚀 Preparing it for real. You review it again before it is sent.'; return onCard ? undefined : detail()
      }
      if (m[1] === 'rt') { if (running) return 'I am already working on it.'; continueJob(id, 'retry'); toast.text = '🔄 On it. Watch the new card below.'; return onCard ? undefined : detail() }
      if (m[1] === 'any') {
        if (running) return 'I am already working on it.'
        const r = await run(['job', 'set-status', id, 'SCORED', '--detail', 'you chose Apply anyway'])
        if (!r.ok) return `Could not do that: ${r.error}`
        logDecision(id, 'apply_anyway')
        continueJob(id, 'apply_anyway'); toast.text = '↩ Applying anyway. Watch the card below.'; return undefined
      }
      if (m[1] === 'o' && m[3]) {
        const want = P.OUTCOMES[m[3]], cur = readOutcomes()[id]
        const r = await run(['log', 'outcome', id, cur === want ? '' : want])
        if (!r.ok) return `Could not save: ${r.error}`
        if (cur !== want) logDecision(id, `outcome_${want}`)
        toast.text = cur === want ? 'Cleared' : want === 'interview' ? '🎉 Nice! Tap 🎤 Interview prep for a prep pack.' : 'Saved'
        return detail()
      }
    }
    if (data === 'fix:go') return startFix('button').existing ? 'Already looking into it' : '🔧 On it'
    if ((m = FIX_ID.exec(data))) return fixDecision(m[1], m[2])
    if ((m = /^u:again:(\w+)$/.exec(data))) { const u = lastUrls.get(m[1]); if (!u) return 'Send me the link again.'; startJobUrl(u); return '🔄 Trying again' }
    if ((m = /^x:([\w-]+)$/.exec(data))) { const k = m[1]; if (searching && k.startsWith('search-')) stoppedSearches.add(k); const hit = stopTasks(t => t.id === k || t.payload.parent === k); finishSearchIfDone(k); return hit || stoppedSearches.has(k) ? '✋ Stopping…' : 'That is already finished.' }

    // Review
    if ((m = /^r:(ok|ch|sk|nv|nx|cx|rv|ss|ea|or|fl|df|hv):([0-9a-f]{8})(?::(\d{1,3}))?$/.exec(data))) return review.press(m[1], m[2], chat, msg, m[3])

    // Forms: answered only after "Open" in Open Questions, which makes that form the one thing typed text goes to.
    if (data === 'F:list' || data.startsWith('f:job:')) return P.questionsPage(F.openForms()) // f:job: is on older messages
    if ((m = /^f:([0-9a-f]{8}):(.+)$/.exec(data))) {
      const f = F.findForm(m[1])
      if (!f) return 'That form no longer exists.'
      const listening: Pending = { kind: 'form', batch: f.batch_id, chat, msg, at: Date.now() }
      if (m[2] === 'open') {
        if (pending?.kind === 'code' && Date.now() - pending.at < PENDING_MS) return 'First send me the verification code I asked for.'
        pending = listening
        F.saveForm({ ...f, message_id: msg, updated_at: Date.now() })
        return F.render(f)
      }
      // A button on a form that is not open (an older message, or you moved away): back to the menu.
      if (f.status === 'open' && !(pending?.kind === 'form' && pending.batch === f.batch_id)) return P.questionsPage(F.openForms())
      const step = F.act(f, m[2])
      if (step.error) return step.error
      pending = listening
      step.form.message_id = msg // answered from a copy: keep editing this one
      await applyStep(step)
      return undefined
    }

    // Settings
    if ((m = /^S:(\w+)$/.exec(data))) return ST.CATS[m[1]] ? ST.categoryPage(m[1], s) : undefined
    if ((m = /^s:(\w\w)(?::(\w)(?::(.+))?)?$/.exec(data))) {
      const spec = ST.specById(m[1])
      if (!spec) return undefined
      const op = m[2], arg = m[3], cur = getPath(s, spec.path) as any
      const set = (v: unknown, say?: string): Page | string => {
        const r = trySettingsUpdate(patchFor(spec.path, v))
        if (!r.ok) return r.error
        toast.text = say ?? `${spec.label}: ${ST.valueText(spec, r.settings)}`
        refresh()
        return specView(spec, r.settings)
      }
      if (!op) return specView(spec, s)
      if (op === 't') return set(!cur)
      if (op === 'v') { const o2 = spec.opts?.[parseInt(arg!, 10)]; return o2 ? set(o2[0]) : undefined }
      if (op === 'n') { const n = parseInt(arg!, 10); return spec.presets?.includes(n) ? set(n) : undefined }
      if (op === 'x') return spec.nullable ? set(null) : undefined
      if (op === 'h') return /^\d{4}$/.test(arg!) ? set(`${arg!.slice(0, 2)}:${arg!.slice(2)}`) : undefined
      if (op === 'm') {
        const o2 = spec.opts?.[parseInt(arg!, 10)]?.[0]
        if (!o2) return undefined
        const have: string[] = cur ?? []
        const nextV = have.includes(o2) ? have.filter(x => x !== o2) : [...have, o2]
        return nextV.length ? set(nextV) : 'Keep at least one.'
      }
      if (op === 'r') { const items: string[] = cur ?? []; const x = items[parseInt(arg!, 10)]; return x === undefined ? undefined : set(items.filter(y => y !== x), `Removed ${x}`) }
      if (op === 'g' && spec.id === 'rt') { const x = ideas(s)[parseInt(arg!, 10)]; return x === undefined ? undefined : set([...(cur ?? []), x], `Added ${x}`) }
      if (op === 'a' || op === 'c') { pending = { kind: 'setting', id: spec.id, adding: op === 'a', chat, msg, at: Date.now() }; return ST.promptFor(spec, op === 'a') }
      return undefined
    }
    if (data === 'P:show') return ST.practicePage(s)
    if (data === 'P:live') return practiceForced() ? 'Practice mode is locked on by the start script.' : ST.goLiveConfirm()
    if (data === 'P:yes') { if (practiceForced()) return 'Practice mode is locked on.'; trySettingsUpdate({ dry_run: false }); toast.text = '🚀 Live: approved applications are now sent'; refresh(); return ST.practicePage(loadSettings()) }
    if (data === 'P:on') { trySettingsUpdate({ dry_run: true }); toast.text = '🧪 Practice mode on'; refresh(); return ST.practicePage(loadSettings()) }
    if (data === 'C:list') return companies()
    if (data === 'C:a') { pending = { kind: 'company', chat, msg, at: Date.now() }; return ST.addCompanyPrompt() }
    if ((m = /^C:r:([a-z0-9_-]{1,60})$/.exec(data))) { await run(['boards', 'remove', 'any', m[1]]); toast.text = `Removed ${m[1]}`; return companies() }

    // Job site logins: windows open on the computer and can take minutes, so they run in the background and edit this page when done.
    if (data === 'L:show') return loginsNow()
    if ((m = /^L:rt:(linkedin|indeed)$/.exec(data))) {
      const busy = new Set([agent.live('work')?.task, ...agent.queued()].map(t => t?.job_id))
      const list = needLogin(m[1]).filter(j => !busy.has(j.id)).slice(0, 5) // each retry is a Claude task: a few at a time
      for (const j of list) continueJob(j.id, 'retry')
      toast.text = list.length ? `🔄 Trying ${list.length} again. Watch the new cards below.` : 'Nothing left to retry.'
      return loginsNow()
    }
    if ((m = /^L:(in|pw|rm):(linkedin|indeed)$/.exec(data))) {
      const [op, site] = [m[1], m[2]], name = ST.JOB_SITES[site]
      if (op === 'rm') { await run(['credentials', 'delete', site]); toast.text = `Forgot your ${name} password`; return loginsNow() }
      if (loginOpen) return 'A login window is already open on your computer. Finish or close it first.'
      loginOpen = true
      void (async () => {
        let note = ''
        if (op === 'pw') {
          const r = await run(['credentials', 'set', site])
          if (!r.ok) note = r.code === 'cancelled' ? 'Nothing was saved.' : `⚠️ I couldn't save it (${esc(String(r.error))}).`
        }
        if (!note) {
          const r = await run(['login', site])
          note = r.ok ? `✅ Logged in to ${name}.` : r.code === 'busy' ? '⚠️ Another JobAgent browser window is open. Close it and try again.' : `⚪ The ${name} login wasn't finished. Tap "Log in to ${name}" to try again.`
        }
        loginOpen = false
        await editAt(chat, msg, await loginsNow(note, note.startsWith('✅') ? site : undefined))
      })()
      return ST.loginWaitPage(site, op === 'pw')
    }

    // Profile & saved answers
    if (data === 'p:edit') return P.contactEditPage(await contactFields(), OB.PROFILE_FIELDS)
    if (data === 'p:ach') return P.achievementsPage(achievements())
    if (data === 'p:ach:add') {
      const have = achievements()
      if (have.length >= P.ACH_MAX) return 'That is the most I keep. Remove one first.'
      pending = { kind: 'achievement', chat, msg, at: Date.now() }
      return P.achievementPrompt(have.length)
    }
    if ((m = /^p:ach:rm:(a\d{1,2})$/.exec(data))) {
      const r = await run(['profile', 'set-field', 'Achievements', m[1], ''])
      return r.ok ? P.achievementsPage(achievements(), '🗑 Removed.') : `Could not remove it: ${r.error}`
    }
    if (data === 'p:rv') return P.versionsPage(versions())
    if (data === 'p:rv:add') {
      if (versions().length >= P.VERSIONS_MAX) return 'That is the most I keep. Remove one first.'
      pending = { kind: 'version', chat, msg, at: Date.now() }
      return P.versionPrompt
    }
    if ((m = /^p:rv:rm:([a-z0-9-]{1,40})$/.exec(data))) {
      const r = await run(['resume', 'remove', m[1]])
      return r.ok ? P.versionsPage(versions(), '🗑 Removed.') : `Could not remove it: ${r.error}`
    }
    if ((m = /^p:f:(\w+)$/.exec(data))) {
      const lbl = OB.PROFILE_FIELDS.find(([k]) => k === m![1])?.[1]
      if (!lbl) return undefined
      pending = { kind: 'contact', key: m[1], ob: false, chat, msg, at: Date.now() }
      return { ...OB.obPrompt(m[1], lbl), rows: [[{ text: '✖ Cancel', data: 'p:edit' }]] }
    }
    if (data === 'p:resume') { pending = { kind: 'resume', chat, msg, at: Date.now() }; return { text: `${heading('📄', 'Send your new resume')}\n\nSend it as a PDF or .docx file. I'll read it again and update your profile. Your saved answers are kept.`, rows: [[{ text: '✖ Cancel', data: 'm:prof' }]] } }
    if ((m = /^a:l:(\d+)$/.exec(data))) { const l = await answers(); return l ? P.answersPage(l, parseInt(m[1], 10)) : helperDown }
    if (data === 'a:s') { pending = { kind: 'find', chat, msg, at: Date.now() }; return { text: `${heading('🔎', 'Search saved answers')}\nSend a word or two from the question, like <code>salary</code> or <code>visa</code>.`, rows: [[{ text: '✖ Cancel', data: 'a:l:0' }]] } }
    if ((m = /^a:(v|e|d|dd):([0-9a-f]{8})$/.exec(data))) {
      const l = await answers()
      if (!l) return helperDown
      const a = l.find(x => P.akey(x.key) === m![2])
      if (!a) return 'That answer no longer exists.'
      if (m[1] === 'v') return P.answerDetail(a)
      if (m[1] === 'd') return P.answerDeleteConfirm(a)
      if (m[1] === 'dd') { const r = await run(['profile', 'answer', 'delete', a.key]); toast.text = '🗑 Deleted'; return r.ok ? P.answersPage(l.filter(x => x.key !== a.key), 0) : `Delete failed: ${r.error}` }
      pending = { kind: 'answer', rec: a, chat, msg, at: Date.now() }
      return { text: `${heading('✏️', esc(a.question))}\n\nNow: ${a.sensitive ? `<tg-spoiler>${esc(a.answer)}</tg-spoiler>` : `<b>${esc(a.answer)}</b>`}\n\nSend the new answer as a message.`, rows: [[{ text: '✖ Cancel', data: `a:v:${m[2]}` }]] }
    }
    if ((m = /^up:(yes|no)$/.exec(data))) {
      const path = lastUpload
      lastUpload = null
      if (m[1] === 'no' || !path) return { text: note('OK, I kept it in your inbox folder and did nothing else.'), rows: [] }
      void importResume(path, true)
      return { text: note('Reading your new resume…'), rows: [] }
    }
    return undefined
  }
  let lastUpload: string | null = null

  // ---- Dashboard: the desktop front end. Reads are the data behind each Telegram screen; a button is the same Telegram
  // button pressed through `route` (TAPS lists which), and typed input goes through the helpers the chat uses.
  // Private answer values never leave here. Throws a plain-words message for the page to show.
  async function dashTap(data: string): Promise<string> {
    if (!TAPS.test(data)) throw new Error('That action is not available here.')
    const to = paired()
    if (to == null) throw new Error('JobAgent is not connected to Telegram yet.')
    const keep = pending, toast: { text?: string } = {}
    const ctx = { chat: { id: to }, callbackQuery: { message: { message_id: -1 } } } as unknown as Context // -1: no message to edit
    let res: Page | string | undefined
    try { res = await route(ctx, data, toast) } finally { pending = keep } // a click here never cancels what is being typed in Telegram
    return toast.text ?? (typeof res === 'string' ? res : res ? plain(res.text.split('\n')[0]) : 'Done')
  }
  const fixes = () => {
    try { return readdirSync(join(DATA, 'repair')).filter(id => !existsSync(join(DATA, 'repair', id, 'approved.json'))).map(id => ({ id, p: readProposal(id) })).filter(x => x.p).map(({ id, p }) => ({ id, title: p!.title, summary: p!.summary, files: p!.files.length, added: p!.added, removed: p!.removed, login: p!.login })) } catch { return [] }
  }
  async function dashCall(op: string, b: Record<string, any>): Promise<unknown> {
    const s = loadSettings(), str = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
    switch (op) {
      case 'view:live': {
        const c = homeCtx(), ob = OB.loadOb()
        return {
          agent_on: c.s.agent_on, onboarded: c.s.onboarded, discovery: c.s.discovery.enabled, searching: discoveryBusy(), queued: c.queued,
          work: c.work ? { title: c.workTitle, doing: c.work.doing, steps: c.work.steps, started: c.work.started, kind: c.work.task.kind } : null,
          next_search: c.nextSearch ?? null, usage: c.usage?.five_hour ?? null, limited_until: c.limitedUntil ?? null,
          needs: P.needsCount(c), updates: c.updates ?? 0, tip: c.tip ?? null, problems: (c.problems ?? []).map(plain), fixes: fixes(),
          cards: cards.all().sort((x, y) => (y.started ?? 9e15) - (x.started ?? 9e15)) /* not started yet: first */.slice(0, 12).map(({ msg: _m, reply_to: _r, ...x }) => ({
            ...x, final: x.final && { ...x.final, buttons: pageButtons(x.final.buttons) }, jobs: x.jobs.map(l => ({ ...l, final: l.final && { ...l.final, buttons: pageButtons(l.final.buttons) } })),
          })),
          codes: c.jobs.filter(j => j.status === 'SUBMITTING' && existsSync(join(jobDir(j.id), 'needs_input.json')) && !existsSync(join(jobDir(j.id), 'input.json'))).map(j => ({ id: j.id, title: jobTitle(j) })),
          resume: ob.replace ? { step: ob.step, error: ob.error ?? null, doing: ob.doing ?? null, summary: ob.step === 'profile' ? ob.summary ?? null : null } : null,
        }
      }
      case 'view:job': {
        const id = str(b.id, 80), j = readJob(id)
        if (!j) throw new Error('That job no longer exists.')
        const running = busyJob(id), hasForm = F.openForms().some(f => f.job_id === id)
        const pg = P.jobPage(j, { usedPct: usedBy(id), running, hasForm, outcome: readOutcomes()[id] })
        return { running, has_form: hasForm, used_pct: usedBy(id) ?? null, actions: pageButtons(pg.rows.flat()), kit: j.status === 'KIT_READY' ? readKit(id) : null, code: code(id) }
      }
      case 'view:settings': {
        const b2 = await boards(), learned = readJson<Record<string, unknown>>(join(DATA, 'boards_learned.json'), {})
        return {
          cats: Object.entries(ST.CATS).map(([key, c]) => ({
            key, emoji: c.emoji, title: c.title, blurb: c.blurb,
            items: c.items.map(sp => ({
              id: sp.id, emoji: sp.emoji, label: sp.label, t: sp.t, what: sp.what, opts: sp.opts ?? null, nullable: sp.nullable ?? null, unit: sp.unit ?? null, example: sp.example ?? null,
              presets: (sp.presets ?? []).map(p => [p, ST.chip(sp, p)]), value: getPath(s, sp.path) ?? null, text: ST.valueText(sp, s),
            })),
          })),
          ideas: ideas(s), practice: practiceOn(s), forced: practiceForced(), companies: b2, learned: b2.filter(x => x in learned).length,
          phone: phoneUrl(), port: dash?.port ?? null, windows: process.platform === 'win32',
        }
      }
      case 'view:profile': {
        const [contact, list] = await Promise.all([contactFields(), answers()])
        return {
          contact: OB.PROFILE_FIELDS.map(([key, label]) => ({ key, label, value: contact[key] ?? '' })),
          resume: ['pdf', 'docx'].map(e => `base_resume.${e}`).find(f => existsSync(join(DATA, f))) ?? null, versions: versions(), versions_max: P.VERSIONS_MAX,
          achievements: achievements().map(([key, text]) => ({ key, text })), ach_max: P.ACH_MAX, skills: readSection('Confirmed skills').confirmed ?? '',
          answers: (list ?? []).map(a => ({ key: a.key, code: P.akey(a.key), question: a.question, answer: a.sensitive ? null : a.answer, sensitive: a.sensitive, updated: a.updated })),
          completeness: P.completeness(s, contact, list ?? []), helper: !!list,
        }
      }
      case 'view:forms':
        return F.openForms().map(f => ({
          batch: f.batch_id, job_id: f.job_id ?? null, title: f.title ?? 'A few questions', created_at: f.created_at,
          questions: f.questions.map(q => ({
            qid: q.qid, text: q.text, kind: q.kind, options: q.options ?? null, sensitive: !!q.sensitive, why: q.why ?? null, can_save: !!q.save_key,
            remember: f.save[q.qid] !== 'no', answered: q.qid in f.answers, answer: q.sensitive ? null : f.answers[q.qid] ?? null,
          })),
        }))
      case 'view:logins': {
        const r = loginOpen ? null : await run(['login', 'status'])
        return { sites: r?.ok ? r.sites : null, busy: loginOpen, names: ST.JOB_SITES, retry: Object.fromEntries(Object.keys(ST.JOB_SITES).map(k => [k, needLogin(k).length])) }
      }
      case 'export': {
        const r = await run(['log', 'export'])
        if (!r.ok) throw new Error(`Export failed: ${r.error}`)
        return { path: String(r.path) }
      }
      case 'tap': return { text: await dashTap(str(b.data, 100)) }
      case 'link': {
        if (!s.onboarded) throw new Error('Finish the setup in Telegram first.')
        const urls = extractUrls(str(b.text, 4000)).filter(u => !isProfileLink(u))
        if (!urls.length) throw new Error('Paste the link to a job posting (it starts with https://).')
        for (const u of urls) startJobUrl(u)
        return { text: urls.length === 1 ? '🚀 On it. Watch Activity on Overview.' : `🚀 Starting ${urls.length} jobs.` }
      }
      case 'setting': {
        const spec = ST.specById(str(b.id, 4))
        if (!spec) throw new Error('That setting does not exist.')
        let v: unknown = b.value
        if (spec.t === 'list') v = Array.isArray(v) ? [...new Map(v.map(x => str(x, 100)).filter(Boolean).map(x => [x.toLowerCase(), x])).values()] : null
        else if (spec.t === 'int' && v !== null) v = typeof v === 'number' ? v : parseNumber(str(v, 30))
        else if (spec.t === 'time') { const mm = /^(\d{1,2})[:.](\d{2})$/.exec(str(v, 10)); v = mm ? `${mm[1].padStart(2, '0')}:${mm[2]}` : null }
        if (v == null && !(spec.t === 'int' && spec.nullable && b.value === null)) throw new Error(spec.t === 'time' ? 'Enter a time like 22:30.' : spec.t === 'int' ? 'Please enter a number.' : 'That value does not fit.')
        if (spec.t === 'multi' && (!Array.isArray(v) || !v.length)) throw new Error('Keep at least one.')
        const r = trySettingsUpdate(patchFor(spec.path, v))
        if (!r.ok) throw new Error(r.error)
        refresh()
        return { text: `${spec.label}: ${ST.valueText(spec, r.settings)}` }
      }
      case 'company': {
        const r = await addCompany(str(b.text, 300))
        if ('error' in r) throw new Error(r.error)
        return { text: `✅ Added ${r.company}${r.open_jobs != null ? ` (${r.open_jobs} open jobs right now)` : ''}.` }
      }
      case 'contact': {
        if (!OB.PROFILE_FIELDS.some(([k]) => k === b.key)) throw new Error('That field does not exist.')
        const v = str(b.value, 300)
        if (!v) throw new Error('Type a value first.')
        const r = await run(['profile', 'set-field', 'Contact', String(b.key), v])
        if (!r.ok) throw new Error(r.error ?? 'could not save')
        return { text: '✅ Saved' }
      }
      case 'achievement': {
        const e = await addAchievement(str(b.text, 1000))
        if (e) throw new Error(e)
        return { text: '✅ Saved' }
      }
      case 'answer': {
        const a = readAnswers().find(x => x.key === b.key), v = str(b.value, 2000)
        if (!a) throw new Error('That answer no longer exists.')
        if (!v) throw new Error('Type the new answer first.')
        const r = await rewriteAnswer(a, v)
        if (!r.ok) throw new Error(r.error ?? 'could not save')
        return { text: '✅ Saved' }
      }
      case 'change': {
        const id = str(b.id, 80), t = str(b.text, 1000)
        if (!readJob(id)) throw new Error('That job no longer exists.')
        if (t.length < 3) throw new Error('Tell me what to change.')
        requestChange(id, t)
        return { text: '✏️ On it. A fresh review follows.' }
      }
      case 'edit': {
        const to = paired()
        if (to == null) throw new Error('JobAgent is not connected to Telegram yet.')
        const e = review.quickEdit(str(b.id, 80), str(b.fid, 120), str(b.value, 2000), to, -1)
        if (e) throw new Error(e)
        return { text: '⏳ Updating the form. A fresh review follows in a moment.' }
      }
      case 'form': {
        const f = F.loadForm(str(b.batch, 80))
        if (!f || f.status !== 'open') throw new Error('Those questions are already closed.')
        const step = b.skip ? F.act(f, 's') : F.submitAll(f, b.answers && typeof b.answers === 'object' ? b.answers : {}, b.remember && typeof b.remember === 'object' ? b.remember : {})
        if (step.error) throw new Error(step.error)
        if (pending?.kind === 'form' && pending.batch === f.batch_id) pending = null
        await applyStep(step)
        return { text: b.skip ? '⏭ Skipped' : '✅ Thanks. Picking the job back up now.' }
      }
      case 'code': {
        const id = str(b.id, 80), e = review.submitCode(id, str(b.value, 20))
        if (e) throw new Error(e)
        if (pending?.kind === 'code' && pending.job === id) { await editAt(pending.chat, pending.msg, { text: `${heading('✅', 'Code received')}\n${note('Finishing the application.')}`, rows: [] }); pending = null }
        return { text: '✅ Code received. Finishing the application.' }
      }
      case 'phone': {
        if (b.url == null) { setPhoneUrl(null); return { text: '🚫 Phone access is off' } }
        if (!setPhoneUrl(str(b.url, 300))) throw new Error('Paste the https address the tunnel printed, like https://something.trycloudflare.com')
        return { text: '📱 Phone access is on' }
      }
      case 'upload': {
        const name = basename(str(b.name, 120)).replace(/[^\w.\- ]/g, '_'), data = Buffer.from(String(b.data ?? ''), 'base64')
        if (!/\.(pdf|docx)$/i.test(name)) throw new Error('Please choose a PDF or Word (.docx) file.')
        if (!data.length) throw new Error('That file is empty.')
        if (data.length > 20 * 1024 * 1024) throw new Error('That file is over 20 MB.')
        if (!s.onboarded) throw new Error('Finish the setup in Telegram first.')
        if (b.kind === 'version' && versions().length >= P.VERSIONS_MAX) throw new Error('That is the most I keep. Remove one first.')
        mkdirSync(join(DATA, 'inbox'), { recursive: true })
        const path = join(DATA, 'inbox', `${Date.now()}-${name}`)
        writeFileSync(path, data)
        if (b.kind === 'version') { const why = await addVersion(path); if (why) throw new Error(why); return { text: '✅ Added. I will pick lines from it for the next jobs.' } }
        await importResume(path, true)
        const ob = OB.loadOb()
        if (ob.step === 'resume' && ob.error) throw new Error(ob.error)
        return { text: '📄 Reading your new resume. Check what I found when it is done.' }
      }
      case 'resume_ok': {
        const ob = OB.loadOb()
        if (ob.step !== 'profile' || !ob.replace) throw new Error('There is nothing to confirm.')
        ob.replace = false
        await obStep(ob, 'done')
        const to = paired()
        if (to != null && ob.msg) await editAt(to, ob.msg, await profileHome())
        return { text: '✅ Profile updated' }
      }
      case 'stop': {
        setAgent(false)
        const hit = stopTasks(() => true)
        killHelpers()
        return { text: hit ? '🛑 Stopped everything. Resume when you want me to continue.' : '🛑 Paused. Nothing was running.' }
      }
    }
    throw new Error('That action is not available here.')
  }

  // Stop tasks: running ones end through onFinish; ones still waiting in line are closed here.
  function stopTasks(pred: (t: Task) => boolean): boolean {
    const waiting = agent.queued('work').filter(pred)
    const hit = agent.cancel(pred)
    for (const t of waiting) cards.update(t.id, c => { c.state = 'ended'; c.ended = Date.now(); c.final = { emoji: '✋', text: 'Cancelled before it started.' }; for (const l of c.jobs) l.final = c.final })
    refresh()
    return hit
  }

  function setAgent(on: boolean) {
    trySettingsUpdate({ agent_on: on })
    if (on) agent.pump()
    syncQueued()
    refresh()
  }

  // ---- Typed input that belongs to a screen (returns true when it consumed the message) ----
  async function capture(ctx: Context, text: string): Promise<boolean> {
    const p = pending
    if (!p) return false
    if (Date.now() - p.at > (p.kind === 'form' ? FORM_MS : PENDING_MS)) { pending = null; return false }
    const fail = async (e: string) => { await ctx.reply(`❌ ${esc(e)}\n${note('Try again, or tap Cancel above.')}`, OPTS); return true }
    const tidy = () => void ctx.deleteMessage().catch(() => {}) // keep the chat clean: the screen above shows the result
    if (p.kind === 'resume' || p.kind === 'version') return false // waiting for a file, not text
    if (!claims(p, text)) return false
    pending = null
    if (p.kind === 'form') {
      pending = { ...p, at: Date.now() } // stays open for the next question
      const step = F.answerText(F.loadForm(p.batch)!, text)
      if (step.error) { await ctx.reply(`❌ ${esc(step.error)}`, OPTS); return true } // forms have no Cancel button
      tidy() // the form above shows the answer
      await applyStep(step)
      return true
    }
    if (p.kind === 'change') {
      requestChange(p.job, text)
      await editAt(p.chat, p.msg, { text: `${heading('✏️', 'Change requested')}\n${quote(esc(short(text, 300)))}\n${note('I am on it. You will get a fresh review to approve.')}`, rows: [] })
      return true
    }
    if (p.kind === 'edit') {
      const e = review.quickEdit(p.job, p.fid, text, p.chat, p.msg)
      if (e) { pending = p; return fail(e) }
      tidy()
      return true
    }
    if (p.kind === 'code') {
      const e = review.submitCode(p.job, text)
      if (e) { pending = p; return fail(e) }
      tidy()
      await editAt(p.chat, p.msg, { text: `${heading('✅', 'Code received')}\n${note('Finishing the application.')}`, rows: [] })
      return true
    }
    if (p.kind === 'find') {
      const all = await answers()
      tidy()
      await editAt(p.chat, p.msg, all ? P.answersPage(P.matchAnswers(all, text), 0, text) : helperDown)
      return true
    }
    if (p.kind === 'answer') {
      const a = p.rec
      const r = await rewriteAnswer(a, text)
      if (!r.ok) { pending = p; return fail(r.error ?? 'could not save') }
      tidy()
      const g = readAnswers(a.job || undefined).find(x => x.key === r.key)
      await editAt(p.chat, p.msg, g ? P.answerDetail(g) : { text: '✅ Saved.', rows: [nav('a:l:0')] })
      return true
    }
    if (p.kind === 'company') {
      const slug = ST.boardSlug(text)
      if (!slug) { pending = p; return fail("That doesn't look like a job board link or name.") }
      tidy()
      await editAt(p.chat, p.msg, { text: `${heading('🔎', `Checking ${esc(slug)}…`)}`, rows: [] })
      const c = await addCompany(text)
      if ('error' in c) { pending = { ...p, at: Date.now() }; await editAt(p.chat, p.msg, { ...ST.addCompanyPrompt(), text: `${ST.addCompanyPrompt().text}\n\n❌ ${esc(c.error)}` }); return true }
      await editAt(p.chat, p.msg, await companies(`✅ Added <b>${esc(c.company)}</b>${c.open_jobs != null ? ` (${c.open_jobs} open jobs right now)` : ''}.`))
      return true
    }
    if (p.kind === 'dashurl') {
      const url = setPhoneUrl(text)
      if (!url) { pending = p; return fail('Send the https address the tunnel printed, like https://something.trycloudflare.com') }
      tidy()
      await editAt(p.chat, p.msg, P.dashPage(dash?.link ?? null, url))
      return true
    }
    if (p.kind === 'achievement') {
      const e = await addAchievement(text)
      if (e) { if (!e.startsWith('That is the most')) pending = p; return fail(e) }
      tidy()
      await editAt(p.chat, p.msg, P.achievementsPage(achievements(), '✅ Saved.'))
      return true
    }
    if (p.kind === 'contact') {
      const r = await run(['profile', 'set-field', 'Contact', p.key, text])
      if (!r.ok) { pending = p; return fail(r.error ?? 'could not save') }
      tidy()
      if (p.ob) { const ob = OB.loadOb(); ob.step = 'profile'; OB.saveOb(ob); await editAt(p.chat, p.msg, OB.obPage(ob, loadSettings(), await contactFields())) }
      else await editAt(p.chat, p.msg, P.contactEditPage(await contactFields(), OB.PROFILE_FIELDS))
      return true
    }
    if (p.kind === 'ob') {
      const ob = OB.loadOb()
      if (p.what === 'title') { ob.picks = [...new Set([...ob.picks, ...parseList(text)])].slice(0, 20) }
      else if (p.what === 'loc') { ob.locs = [...new Set([...ob.locs, ...parseList(text)])].slice(0, 20) }
      else if (p.what === 'country') { ob.country = short(text.trim(), 50); trySettingsUpdate({ filters: { country: ob.country } }) }
      else if (p.what === 'salary') {
        const n = parseNumber(text)
        if (n === null || n < 0) { pending = p; return fail('Please send an amount, like 95000 or 95k.') }
        trySettingsUpdate({ filters: { min_salary: n || null } })
        if (n) void saveAnswer('salary_expectation_min', 'Minimum yearly salary you would accept', String(n), true)
        ob.step = 'auth'
      } else if (p.what === 'start') { void saveAnswer('start_availability', 'When can you start?', short(text.trim(), 100), false); ob.step = 'relocate' }
      OB.saveOb(ob)
      tidy()
      await editAt(p.chat, p.msg, OB.obPage(ob, loadSettings()))
      return true
    }
    // a setting
    const spec = ST.specById(p.id)!
    let v: unknown
    if (p.adding) {
      const items = parseList(text)
      if (!items.length) { pending = p; return fail('Nothing to add.') }
      const have = (getPath(loadSettings(), spec.path) as string[]) ?? []
      v = [...have, ...items.filter(x => !have.some(h => h.toLowerCase() === x.toLowerCase()))]
    } else if (spec.t === 'time') {
      const mm = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim())
      if (!mm) { pending = p; return fail('Send a time like 22:30.') }
      v = `${mm[1].padStart(2, '0')}:${mm[2]}`
    } else {
      const n = parseNumber(text)
      if (n === null) { pending = p; return fail('Please send a number.') }
      v = n
    }
    const r = trySettingsUpdate(patchFor(spec.path, v))
    if (!r.ok) { pending = p; return fail(r.error) }
    tidy()
    await editAt(p.chat, p.msg, specView(spec, r.settings, `✅ ${p.adding ? 'Added' : 'Saved'}.`))
    refresh()
    return true
  }

  // ---- Gate: runs before every handler ----
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id, chat = ctx.chat?.type, pid = paired()
    if (pid == null) {
      const m = chat === 'private' && ctx.message?.text?.match(/^\/(?:start|pair)(?:@\w+)?\s+([a-z0-9]{6,12})$/i)
      if (!m || from == null) {
        if (chat === 'private' && /^\/start/.test(ctx.message?.text ?? '')) await ctx.reply(`${heading('🔗', 'Not connected yet')}\nOpen the pairing link (or scan the QR code) shown on your computer during setup.`, OPTS)
        return
      }
      const r = tryPair(m[1].toLowerCase())
      if (r === 'ok') {
        trySettingsUpdate({ paired_user_id: from })
        log('paired')
        await ctx.reply(`${heading('🔗', 'Connected')}\n${note('This chat now controls the JobAgent on your computer. Only you can use it.')}`, OPTS)
        await renderOb(OB.loadOb(), true)
        refresh()
      } else await ctx.reply(r === 'expired' ? `${heading('⌛', 'That link expired')}\nRun the setup again on your computer to get a fresh one.` : `${heading('❌', "That code didn't match")}\nUse the newest link shown on your computer.`, OPTS)
      return
    }
    if (isAllowed(from, chat, pid)) await next()
  })

  async function openHome(ctx: Context) {
    const old = homeMsg
    void ctx.deleteMessage().catch(() => {})
    if (old) void api.deleteMessage(old.chat, old.id).catch(() => {})
    const p = P.home(homeCtx())
    const m = await ctx.reply(p.text, { ...OPTS, reply_markup: kb(p) })
    homeMsg = { chat: m.chat.id, id: m.message_id, showing: true }
  }
  const show = (ctx: Context, p: Page) => ctx.reply(p.text, { ...OPTS, reply_markup: kb(p) })

  bot.command(['start', 'menu'], async ctx => {
    if (!loadSettings().onboarded) { void ctx.deleteMessage().catch(() => {}); return renderOb(OB.loadOb(), true) }
    return openHome(ctx)
  })
  bot.command('jobs', ctx => show(ctx, P.jobsPage(allJobs(), 'a', 0, readOutcomes())))
  bot.command('settings', ctx => show(ctx, ST.settingsRoot(loadSettings(), boardCount())))
  bot.command('help', ctx => show(ctx, P.helpPage()))
  bot.command('health', ctx => show(ctx, P.healthPage(health?.checks ?? null, health?.at)))
  bot.command('snooze', ctx => shortcut(ctx, 'snooze'))
  bot.command(['review', 'search'], async ctx => {
    if (!loadSettings().onboarded) return void ctx.reply(note('Finish the setup first.'), OPTS)
    await shortcut(ctx, ctx.message?.text?.startsWith('/review') ? 'reviews' : 'search')
  })
  bot.command('fix', async ctx => { if (startFix('command').existing) await ctx.reply('🔧 I am already looking into it.') })
  bot.command('pause', async ctx => { setAgent(false); await ctx.reply(`${heading('⏸', 'Paused')}\n${note('I will finish the current step, then wait. Links you send wait in line.')}`, OPTS) })
  bot.command('resume', async ctx => { setAgent(true); await ctx.reply(`${heading('▶️', 'Running again')}`, OPTS) })
  bot.command('stop', async ctx => {
    setAgent(false)
    const hit = stopTasks(() => true)
    killHelpers()
    await ctx.reply(`${heading('🛑', 'Stopped everything')}\n${hit ? 'I stopped what I was doing. ' : ''}${note('Nothing is running now. Tap Resume on Home when you want me to continue.')}`, OPTS)
  })

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    if (!ctx.callbackQuery.message) return void ctx.answerCallbackQuery().catch(() => {})
    log(`tap ${data.split(':').slice(0, 2).join(':')}`)
    // Telegram takes only the first answer to a tap: answer once, at the end so the toast shows, or after 2 s so a slow route stops spinning.
    let acked = false
    const ack = (x?: { text: string; show_alert?: boolean }) => { if (acked) return false; acked = true; void ctx.answerCallbackQuery(x).catch(() => {}); return true }
    const spin = setTimeout(() => ack(), 2000)
    const toast: { text?: string } = {}
    let res: Page | string | undefined
    const t0 = Date.now()
    try { res = await route(ctx, data, toast) } catch (e) { logError('tap failed', e); res = "⚠️ That didn't work. Please try again." } finally { clearTimeout(spin) }
    if (Date.now() - t0 > 300) log(`slow tap ${data.split(':').slice(0, 2).join(':')}: ${Date.now() - t0} ms`) // budget: read-only screens under 300 ms
    const msg = ctx.callbackQuery.message
    if (typeof res === 'string') {
      // Too late for a toast: say it in the chat, unless it only points at what was just sent ("Sent below").
      if (!ack({ text: res.slice(0, 190), show_alert: res.length > 60 }) && !/Sent below$/.test(res)) await ctx.reply(esc(res), OPTS).catch(() => {})
      return
    }
    if (res) {
      await editAt(msg.chat.id, msg.message_id, res)
      if (homeMsg?.id === msg.message_id) homeMsg.showing = data === 'm:home' || data.startsWith('H:')
      else if (data === 'm:home') homeMsg = { chat: msg.chat.id, id: msg.message_id, showing: true }
    }
    ack(toast.text ? { text: toast.text } : undefined)
  })

  bot.on('message:text', async ctx => {
    const text = ctx.message.text, urls = extractUrls(text)
    if (await capture(ctx, text)) return // the one screen the user has open, if any
    const s = loadSettings()
    if (urls.length) {
      if (!s.onboarded) return void ctx.reply(`${heading('🧩', 'Let’s finish setup first')}\n${note('I need your resume and what you are looking for before I can apply.')}`, { ...OPTS, reply_markup: kb([[{ text: '🧩 Continue setup', data: 'o:resume' }]]) })
      const jobs = urls.filter(u => !isProfileLink(u))
      if (!jobs.length) return void ctx.reply(`${heading('👤', 'That is a profile, not a job posting')}\nTo change the LinkedIn address on your applications, open Contact details. Answering a question? Open it under Open Questions, then send it again.`, { ...OPTS, reply_markup: kb([[{ text: '✏️ Contact details', data: 'p:edit' }, { text: '❓ Open Questions', data: 'F:list' }]]) })
      void ctx.react('👀').catch(() => {})
      for (const u of jobs) startJobUrl(u, ctx.message.message_id)
      return
    }
    if (!s.onboarded) { // mid-setup, typed text answers the step on screen; it never starts a Claude chat
      const ob = OB.loadOb(), what = ({ titles: 'title', locations: 'loc', salary: 'salary', start: 'start' } as Record<string, string>)[ob.step]
      if (what && ob.msg) { pending = { kind: 'ob', what, chat: ctx.chat.id, msg: ob.msg, at: Date.now() }; if (await capture(ctx, text)) return }
      return void ctx.reply(note(ob.step === 'resume' ? 'Please send your resume as a file: tap 📎, then File, and pick the PDF or Word document.'
        : ob.step === 'reading' ? "I'm still reading your resume. This takes about a minute." : 'Use the buttons above to continue the setup.'), OPTS)
    }
    if (/^(thanks|thank you|thx|ty|ok|okay|cool|great|nice|perfect|👍)$/i.test(text.trim().replace(/[!.]+$/, ''))) return void ctx.react('👍').catch(() => {})
    if (await shortcut(ctx, P.intentOf(text))) return
    startTask({ kind: 'chat', title: 'Chat', payload: { text: text.slice(0, 4000) } }, false)
  })

  bot.on('message:document', async ctx => {
    const d = ctx.message.document
    const name = basename(d.file_name ?? 'file').replace(/[^\w.\- ]/g, '_')
    if (!/\.(pdf|docx)$/i.test(name)) return void ctx.reply(`${heading('📎', 'Unsupported file')}\nPlease send a PDF or Word (.docx) file.`, OPTS)
    if ((d.file_size ?? 0) > 20 * 1024 * 1024) return void ctx.reply('❌ That file is over 20 MB.', OPTS)
    void ctx.react('👀').catch(() => {})
    const f = await ctx.api.getFile(d.file_id)
    const res = await fetch(`https://api.telegram.org/file/bot${o.token}/${f.file_path}`)
    if (!res.ok) return void ctx.reply('❌ The download failed. Please send it again.', OPTS)
    mkdirSync(join(DATA, 'inbox'), { recursive: true })
    const path = join(DATA, 'inbox', `${Date.now()}-${name}`)
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    if (pending?.kind === 'version') {
      const { chat, msg } = pending
      pending = null
      const why = await addVersion(path)
      return void editAt(chat, msg, P.versionsPage(versions(), !why ? `✅ Added. ${note('I will pick lines from it for the next jobs.')}` : `⚠️ ${why}`))
    }
    const s = loadSettings(), ob = OB.loadOb()
    const asResume = pending?.kind === 'resume' || !s.onboarded && ['welcome', 'resume', 'profile', 'fix'].includes(ob.step)
    if (asResume) { pending = null; return importResume(path, s.onboarded) }
    lastUpload = path
    await ctx.reply(`${heading('📎', 'Got your file')}\nShould I use it as your new resume?`, { ...OPTS, reply_markup: kb([[{ text: '✅ Yes, use it', data: 'up:yes', style: 'success' }, { text: 'No', data: 'up:no' }]]) })
  })

  bot.on('message:photo', ctx => ctx.reply(`${heading('📎', "I can't read photos")}\nSend your resume as a <b>file</b>: tap 📎, then <b>File</b> (not Gallery), and pick the PDF or Word document.`, OPTS))

  // Everyday questions get an instant answer from the app; anything else goes to Claude.
  async function shortcut(ctx: Context, i: P.Intent | null): Promise<boolean> {
    if (!i) return false
    if (i === 'home') await openHome(ctx)
    else if (i === 'needs') await show(ctx, P.needsPage({ jobs: allJobs(), forms: F.openForms() }))
    else if (i === 'jobs') await show(ctx, P.jobsPage(allJobs(), 'a', 0, readOutcomes()))
    else if (i === 'help') await show(ctx, P.helpPage())
    else if (i === 'reviews') {
      const q = P.reviewQueue(allJobs()), rv = q[0] && review.readReview(q[0].id)
      await show(ctx, rv ? reviewPage(rv, practiceOn(loadSettings())) : { text: `✨ ${note('Nothing is waiting for your review.')}`, rows: [nav()] })
    } else if (i === 'pause' || i === 'resume') {
      setAgent(i === 'resume')
      await ctx.reply(i === 'resume' ? heading('▶️', 'Running again') : `${heading('⏸', 'Paused')}
${note('I will finish the current step, then wait.')}`, OPTS)
    } else if (i === 'snooze') {
      snoozeUntil = Date.now() + 3600_000
      await ctx.reply(`${heading('🔕', 'Quiet for an hour')}
${note(`No notification sounds until ${clock(snoozeUntil)}. Work continues.`)}`, OPTS)
    } else if (discoveryBusy()) await ctx.reply(note('A search is already running.'), OPTS)
    else void startDiscover('manual')
    return true
  }

  // Pinning the status bar posts a service message: remove it.
  bot.on('message:pinned_message', ctx => void ctx.deleteMessage().catch(() => {}))
  bot.catch(err => logError('handler error (polling continues)', err.error))

  // ---- Timers ----
  function discoveryCheck() {
    const s = loadSettings()
    if (s.paired_user_id == null || !s.onboarded || !s.agent_on || !s.discovery.enabled || isQuiet(s)) return
    if (discoveryBusy()) return
    if (Date.now() - (discState().last_tick ?? 0) < s.discovery.interval_hours * 3600_000) return
    void startDiscover('timer')
  }

  // Cards that were mid-task when the app stopped: say so (their tasks resume from the saved queue).
  function recoverCards() {
    const known = new Set(agent.queued('work').flatMap(t => [t.id, String(t.payload.parent ?? '')]))
    for (const c of cards.all()) {
      if (c.state === 'ended') continue
      if (known.has(c.key)) continue
      cards.update(c.key, x => { x.state = 'ended'; x.ended = Date.now(); x.final ??= { emoji: '⏸', text: 'Interrupted when the app closed.' } })
    }
  }

  // Resolves '' when stopped normally, or the reason polling gave up (the caller exits).
  async function start(retryMs = 1000): Promise<string> {
    let first = true
    for (let attempt = 1; ; attempt++) {
      let polledAt = 0
      try {
        await bot.start({
          drop_pending_updates: false,
          onStart: info => {
            polledAt = Date.now()
            if (first) log(`polling as @${info.username}`) // onStart also fires on every reconnect attempt
            if (!first) return
            first = false
            o.onReady?.(info.username ?? 'your bot')
            void api.setMyShortDescription('Finds jobs, tailors your resume and prepares applications. Nothing is sent without you.').catch(() => {})
            void api.setMyDescription('JobAgent finds jobs that fit you, tailors your resume for each one, fills in the application and shows it to you before anything is sent.\n\nIt runs on your own computer with your own Claude account, and only answers while JobAgent is open there.').catch(() => {})
            void api.setMyCommands([
              { command: 'menu', description: '🏠 Home: what I am doing and what needs you' },
              { command: 'review', description: '🔔 Applications waiting for your OK' },
              { command: 'search', description: '🔎 Look for new jobs now' },
              { command: 'jobs', description: '📋 All your jobs and applications' },
              { command: 'settings', description: '⚙️ What I look for and how I apply' },
              { command: 'pause', description: '⏸ Pause after the current step' },
              { command: 'resume', description: '▶️ Continue' },
              { command: 'stop', description: '🛑 Stop everything now' },
              { command: 'fix', description: '🔧 Report a problem with JobAgent' },
              { command: 'health', description: '🩺 Check that everything on your computer works' },
              { command: 'snooze', description: '🔕 No notification sounds for an hour' },
              { command: 'help', description: '❔ How JobAgent works' },
            ]).catch(() => {})
            void api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {})
            recoverCards()
            syncQueued()
            refresh()
            void review.recover()
            setInterval(discoveryCheck, 60_000).unref()
            setInterval(refresh, 30_000).unref() // relative times on Home and the status bar
            setTimeout(() => void checkHealth(), 10_000).unref()
            if (process.env.JOBAGENT_UPDATE_CHECK !== '0') { setTimeout(() => void checkUpdate(), 60_000).unref(); setInterval(() => void checkUpdate(), 24 * 3600_000).unref() }
            if (process.env.JOBAGENT_DASHBOARD !== '0') {
              try { dash = startDashboard(dashDeps) } catch (e) { log(`dashboard did not start: ${e}`) }
            }
            setInterval(followUpCheck, 3600_000).unref() // hourly look, but each application is asked about once
            setInterval(() => void checkHealth(), 6 * 3600_000).unref()
          },
        })
        return ''
      } catch (err) {
        // onStart fires before the first getUpdates, so only a minute of good polling counts as recovered.
        if (polledAt && Date.now() - polledAt > 60_000) attempt = 1
        if (err instanceof GrammyError && err.error_code === 401) return 'Telegram rejected the bot token. Run the setup again.'
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt >= 8) return 'Another program is using this Telegram bot (often an older JobAgent still running). Close it and start JobAgent again.'
        if (attempt <= 3 || attempt % 20 === 0) log(`Telegram connection failed (attempt ${attempt}), retrying: ${err instanceof Error ? err.message : err}`) // not every time: a long outage would flood the log
        await new Promise(r => setTimeout(r, Math.min(retryMs * attempt, 15 * retryMs)))
      }
    }
  }

  return { bot, agent, cards, review, start, handleTool, route, capture, refresh, stop: () => { bridge.stop(); return bot.stop() }, _bridge: bridge }
}
