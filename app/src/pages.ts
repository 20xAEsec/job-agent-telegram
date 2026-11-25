// Main screens. Pure: state in, text + buttons out.
import { createHash } from 'crypto'
import type { Live, Usage } from './agent'
import type { Form } from './forms'
import { code, inProgress, jobTitle, lastDetail, needsYou, statusOf, type Job } from './jobs'
import { ago, bar, breakdownLines, elapsed, esc, heading, kv, label, money, mustHaveLine, nav, note, pairs, plural, quote, short, until, type Btn, type Page } from './kit'
import { practiceForced, practiceOn, SOURCES, type Settings } from './state'

export type HomeCtx = {
  s: Settings; work?: Live; workTitle?: string; queued: number; jobs: Job[]; forms: Form[]; usage?: Usage; nextSearch?: number | null; limitedUntil?: number; companies?: number
  problems?: string[] // from the health check: plain words, with the fix
  tip?: { min: number; text: string } | null // a suggestion from the user's own decisions
  updates?: number // new versions on GitHub not yet in this copy
}

// ---- Health: `jobagent setup-check`, run at start and every few hours, in plain words ----
export type Check = { name: string; ok: boolean; detail: string; required: boolean }
const CHECK_TEXT: Record<string, [label: string, fix: string]> = {
  'claude login': ['Claude login', 'Claude is not logged in on your computer. Open a terminal, run <code>claude</code> and log in.'],
  claude: ['Claude Code', 'Claude Code is not installed on your computer. Run the setup again.'],
  'playwright chromium': ['Hidden browser', 'The browser I fill forms in is missing. On your computer run <code>uv run --project agent playwright install chromium</code>.'],
  'docx->pdf converter': ['Word → PDF', 'Word or LibreOffice is not installed, so a .docx resume cannot be attached. Install one, or send your resume as a PDF.'],
  'data dir writable': ['Saving files', 'I cannot save files in the data folder. Check the disk and folder permissions.'],
  'disk space': ['Disk space', 'Your disk is almost full (under 1 GB free). Free some space so I can keep saving.'],
  'telegram token': ['Telegram', 'The Telegram bot token is missing. Run the setup again.'],
  bun: ['Bun', 'Bun is missing. Run the setup again.'],
  'python>=3.12': ['Python', 'Python is too old. Run the setup again.'],
}
// The checks worth bothering the user about. The Word converter only matters for a .docx resume.
export const problemsFrom = (checks: Check[], docxResume: boolean) =>
  checks.filter(c => !c.ok && (c.required || c.name === 'disk space' || (c.name === 'docx->pdf converter' && docxResume))).map(c => CHECK_TEXT[c.name]?.[1] ?? `${esc(c.name)}: ${esc(c.detail)}`)

export function healthPage(checks: Check[] | null, at?: number, extra: string[] = []): Page {
  const lines = checks ? checks.map(c => `${c.ok ? '✅' : c.required ? '❌' : '⚠️'} ${CHECK_TEXT[c.name]?.[0] ?? esc(c.name)}${c.ok ? '' : `\n     ${note(CHECK_TEXT[c.name]?.[1] ?? esc(c.detail))}`}`) : [note('Checking…')]
  return {
    text: [heading('🩺', 'Health'), '', ...lines, ...extra, '', note(at ? `Checked ${ago(at)}.` : 'Not checked yet.')].join('\n'),
    rows: [[{ text: '🔄 Check again', data: 'm:hc' }], nav()],
  }
}

const week = (jobs: Job[], now = Date.now()) => {
  const since = now - 7 * 86_400_000
  const reached = (j: Job, st: string[]) => j.history.some(h => st.includes(h.status) && Date.parse(h.at) >= since)
  const added = (j: Job) => Date.parse(j.history[0]?.at ?? '')
  return {
    found: jobs.filter(j => added(j) >= since).length,
    found_before: jobs.filter(j => added(j) >= since - 7 * 86_400_000 && added(j) < since).length,
    ready: jobs.filter(j => reached(j, ['AWAITING_APPROVAL'])).length,
    sent: jobs.filter(j => reached(j, ['SUBMITTED', 'APPLIED_SELF'])).length,
    practice: jobs.filter(j => reached(j, ['DRY_RUN_DONE'])).length,
  }
}

export function needsCount(c: Pick<HomeCtx, 'jobs' | 'forms'>) {
  const reviews = c.jobs.filter(j => j.status === 'AWAITING_APPROVAL').length
  const kits = c.jobs.filter(j => j.status === 'KIT_READY').length
  const forms = c.forms.length
  const other = c.jobs.filter(j => j.status === 'NEEDS_HUMAN' || j.status === 'FAILED').length
  return { reviews, kits, forms, other, total: reviews + kits + forms + other }
}

function workLines(c: HomeCtx, now: number): string[] {
  if (c.limitedUntil && c.limitedUntil > now) return [`⏳ <b>Waiting for Claude:</b> usage limit reached`, note(`I'll continue at ${new Date(c.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, automatically.`)]
  if (!c.s.agent_on) return [`⏸ <b>Paused.</b>${c.queued ? ` ${plural(c.queued, 'task')} waiting.` : ''}`, note('Links you send are kept in line until you resume.')]
  if (!c.work) return [`💤 <b>Idle.</b> ${note('Send me a job link any time.')}`]
  return [
    `⚙️ <b>Working on:</b> ${esc(short(c.workTitle ?? c.work.task.title, 60))}`,
    `     ↳ ${note(`${esc(c.work.doing ?? 'Getting started')} · ${elapsed(now - c.work.started)}`)}`,
    ...(c.queued ? [`     ${note(`+ ${plural(c.queued, 'more task')} waiting`)}`] : []),
  ]
}

// " · 12 companies · LinkedIn · Indeed": where auto-search looks; warns only when it has nowhere to look.
function searchWhere(c: HomeCtx): string {
  const src = c.s.discovery.sources, sites = src.filter(x => x !== 'companies').map(x => SOURCES[x])
  const co = !src.includes('companies') || c.companies == null ? null
    : c.companies ? plural(c.companies, 'company', 'companies') : c.s.discovery.web_search ? 'finding companies' : sites.length ? null : '⚠️ no companies to watch yet'
  return [co, ...sites].filter(Boolean).map(x => ` · ${x}`).join('')
}

// The one thing most worth doing now: Home's first (primary) button. Pure.
export function nextAction(c: HomeCtx): Btn {
  const n = needsCount(c)
  const one = (st: string) => c.jobs.find(j => j.status === st)
  if (!c.s.onboarded) return { text: '🧩 Finish setup', data: 'o:resume', style: 'success' }
  if (n.reviews) return { text: n.reviews === 1 ? '🔔 Review your application' : `🔔 Review ${n.reviews} applications`, data: n.reviews === 1 ? `r:rv:${code(one('AWAITING_APPROVAL')!.id)}` : 'Q:0', style: 'success' }
  if (n.kits) return { text: n.kits === 1 ? '🧰 Apply yourself: 1 match' : `🧰 Apply yourself: ${n.kits} matches`, data: n.kits === 1 ? `j:kit:${code(one('KIT_READY')!.id)}` : 'N:0', style: 'success' }
  if (n.forms) return { text: `❓ Answer ${plural(n.forms, 'question form')}`, data: 'N:0', style: 'primary' }
  if (n.other) return { text: `🙋 Fix ${plural(n.other, 'stuck job')}`, data: 'N:0', style: 'primary' }
  if (c.work) return { text: '📋 See my jobs', data: 'J:a:0' }
  return c.s.discovery.enabled ? { text: '🔎 Search now', data: 'd:run', style: 'primary' } : { text: '🔭 Turn on Auto-search', data: 's:ae', style: 'primary' }
}

// "▲ 3 vs last week": only when there is a last week to compare with.
const trend = (now: number, before: number) => (!before ? '' : now === before ? note(' (same as last week)') : note(` (${now > before ? '▲' : '▼'} ${Math.abs(now - before)} vs last week)`))

export function home(c: HomeCtx, now = Date.now()): Page {
  const { s } = c
  const n = needsCount(c)
  const w = week(c.jobs, now)
  const mode = practiceOn(s) ? '🧪 Practice mode' : '🚀 <b>Live</b>: approved applications are sent'
  const lines = [
    heading('🏠', 'JobAgent'),
    `${s.agent_on ? '🟢 Running' : '⏸ Paused'} · ${mode}`,
    '',
    ...(s.onboarded ? workLines(c, now) : [`🧩 <b>Setup isn't finished.</b> ${note("I need your resume and what you're looking for first.")}`]),
    ...(c.tip ? ['', `💡 ${esc(c.tip.text)}`] : []),
    ...(c.updates ? ['', `⬆️ ${note('An update for JobAgent is available.')}`] : []),
    ...(c.problems?.length ? ['', `🩺 <b>Problem:</b> ${c.problems[0]}${c.problems.length > 1 ? note(` (+${c.problems.length - 1} more)`) : ''}`] : []),
    '',
    n.total
      ? `📥 <b>Needs you:</b> ${[n.reviews && plural(n.reviews, 'review'), n.kits && `${n.kits} to apply yourself`, n.forms && plural(n.forms, 'question form'), n.other && plural(n.other, 'problem')].filter(Boolean).join(' · ')}`
      : `✨ ${note('Nothing needs you right now.')}`,
    s.discovery.enabled
      ? `🔭 <b>Auto-search:</b> ${c.nextSearch ? `next ${until(c.nextSearch, now)}` : 'running soon'}${searchWhere(c)}`
      : `🔭 <b>Auto-search:</b> off ${note('(I only work on links you send)')}`,
    `📊 <b>This week:</b> ${w.found} found${trend(w.found, w.found_before)} · ${w.ready} prepared · ${practiceOn(s) && !w.sent ? `${w.practice} practice runs` : `${w.sent} sent`}`,
    ...(c.usage?.five_hour != null ? [`⚡ <b>Claude usage:</b> ${bar(c.usage.five_hour, 1)} ${Math.round(c.usage.five_hour * 100)}% ${note('of your 5-hour limit')}`] : []),
  ]
  // Primary action first, then the usual places; nothing appears twice.
  const first = nextAction(c)
  const rows: Btn[][] = [[first]]
  rows.push([{ text: `📥 Needs you${n.total ? ` (${n.total})` : ''}`, data: 'N:0' }, { text: '📋 Jobs', data: 'J:a:0' }].filter(b => b.data !== first.data))
  rows.push([
    s.discovery.enabled ? { text: '🔎 Search now', data: 'd:run' } : { text: '🔭 Turn on Auto-search', data: 's:ae' },
    s.agent_on ? { text: '⏸ Pause', data: 'H:pause' } : { text: '▶️ Resume', data: 'H:resume', style: 'success' as const },
  ].filter(b => b.data !== first.data))
  rows.push([{ text: '⚙️ Settings', data: 'm:settings' }, { text: '👤 Profile', data: 'm:prof' }])
  if (c.updates) rows.push([{ text: '⬆️ How to update', data: 'm:upd' }])
  if (c.tip) rows.push([{ text: `📊 Set it to ${c.tip.min}`, data: `sg:ms:${c.tip.min}` }, { text: '✖ No thanks', data: `sg:no:${c.tip.min}` }])
  rows.push([{ text: '❔ Help', data: 'm:help' }, ...(c.problems?.length ? [{ text: '🩺 Health', data: 'm:health' }] : []), ...(c.jobs.length ? [{ text: '🖥 Dashboard', data: 'm:dash' }] : [])]) // no Refresh: Home updates itself
  return { text: lines.join('\n'), rows }
}

// Compact card pinned at the top of the chat and edited in place: always shows what is going on.
export function statusBar(c: HomeCtx, now = Date.now()): string {
  const n = needsCount(c)
  const act = c.limitedUntil && c.limitedUntil > now ? `⏳ Waiting for Claude's usage limit to reset`
    : !c.s.agent_on ? '⏸ Paused'
      : c.work ? `⚙️ ${esc(short(c.work.doing ?? 'Working', 50))} · ${esc(short(c.workTitle ?? c.work.task.title, 40))}`
        : '💤 Idle: send me a job link'
  return [
    `<b>${c.s.agent_on ? '🟢' : '⏸'} JobAgent</b> · ${practiceOn(c.s) ? '🧪 Practice' : '🚀 Live'}${c.s.discovery.enabled ? ' · 🔭 Auto-search on' : ''}`,
    act + (c.queued ? note(` (+${c.queued} waiting)`) : ''),
    n.total ? `📥 <b>${plural(n.total, 'thing')} need${n.total === 1 ? 's' : ''} you</b>: tap /menu` : note('Nothing needs you'),
  ].join('\n')
}

// ---- Needs you ----

export function needsPage(c: Pick<HomeCtx, 'jobs' | 'forms'>): Page {
  const reviews = c.jobs.filter(j => j.status === 'AWAITING_APPROVAL')
  const kits = c.jobs.filter(j => j.status === 'KIT_READY')
  const problems = c.jobs.filter(j => j.status === 'NEEDS_HUMAN' || j.status === 'FAILED')
  const rows: Btn[][] = [
    ...(reviews.length > 1 ? [[{ text: `🔔 Review all ${reviews.length}, best first`, data: 'Q:0', style: 'success' as const }]] : []),
    ...reviews.map(j => [{ text: `🔔 Review · ${short(jobTitle(j), 44)}`, data: `r:rv:${code(j.id)}` }]),
    ...kits.map(j => [{ text: `🧰 Apply yourself · ${short(jobTitle(j), 38)}`, data: `j:kit:${code(j.id)}` }]),
    ...c.forms.map(f => [{ text: `❓ Answer · ${short(f.title ?? 'Questions', 44)}`, data: `f:${code(f.batch_id)}:open` }]),
    ...problems.map(j => [{ text: `${statusOf(j.status).emoji} ${short(jobTitle(j), 50)}`, data: `j:v:${code(j.id)}` }]),
  ]
  if (!rows.length) return { text: `${heading('📥', 'Needs you')}\n\n✨ All clear. Nothing is waiting for you.\n\n${note('Reviews, questions and problems show up here.')}`, rows: [[{ text: '🔎 Search now', data: 'd:run', style: 'primary' }], nav()] }
  const text = [
    heading('📥', 'Needs you'), '',
    ...(reviews.length ? [`🔔 <b>${plural(reviews.length, 'application')} to review</b>`, note('Approve, change or skip.')] : []),
    ...(kits.length ? [`🧰 <b>${plural(kits.length, 'job')} to apply for yourself</b>`, note("Forms I can't fill: your resume and answers are ready.")] : []),
    ...(c.forms.length ? [`❓ <b>${plural(c.forms.length, 'question form')}</b>`, note('Things only you can answer.')] : []),
    ...(problems.length ? [`🙋 <b>${plural(problems.length, 'job')} stuck</b>`, note('A login, a CAPTCHA, or an error. Tap one to see what happened.')] : []),
  ].join('\n')
  return { text, rows: [...rows.slice(0, 20), nav()] }
}

// ---- Follow-ups: applications with no news after a while ----
export type FollowState = Record<string, { asked?: string; snooze_until?: string }>
// Sent applications (not practice runs) with no outcome yet, older than `days`, not asked about or snoozed. Pure.
export function followUpsDue(jobs: Job[], outcomes: Record<string, string>, st: FollowState, days: number, now = Date.now()): Job[] {
  if (!days) return []
  const appliedAt = (j: Job) => Date.parse([...j.history].reverse().find(h => h.status === 'SUBMITTED' || h.status === 'APPLIED_SELF')?.at ?? '')
  return jobs.filter(j => (j.status === 'SUBMITTED' || j.status === 'APPLIED_SELF') && !outcomes[j.id]
    && now - appliedAt(j) > days * 86_400_000 && !st[j.id]?.asked && !(Date.parse(st[j.id]?.snooze_until ?? '') > now))
}
export function followUpPage(j: Job, days: number): Page {
  const c = code(j.id)
  return {
    text: `${heading('📬', 'Any news?')}\n<b>${esc(jobTitle(j))}</b>\n${note(`You applied over ${plural(days, 'day')} ago and I have no reply recorded.`)}`,
    rows: [
      [{ text: '✍️ Draft a follow-up email', data: `j:fu:${c}`, style: 'primary' }],
      [{ text: '🗣 Interview', data: `j:o:${c}:i` }, { text: '👎 Rejected', data: `j:o:${c}:r` }],
      [{ text: '🦗 No reply', data: `j:o:${c}:g` }, { text: '⏰ Ask me in a week', data: `j:zz:${c}` }],
    ],
  }
}

export const updatePage = (n: number): Page => ({
  text: n
    ? `${heading('⬆️', 'Update available')}\n${plural(n, 'change')} since your copy. On your computer, in the JobAgent folder, run:\n<code>git pull</code>\nthen restart JobAgent (or run the setup again if it asks).\n\n${note('I never update myself: you decide when.')}`
    : `${heading('⬆️', 'Up to date')}\n${note('You have the newest version.')}`,
  rows: [nav()],
})

// On the computer the dashboard is a link to open there (Telegram refuses 127.0.0.1 buttons). With phone access on, it
// also opens inside Telegram as a Mini App through the user's own tunnel.
export const dashPage = (link: string | null, phone: string | null = null): Page => ({
  text: link
    ? [`${heading('🖥', 'Dashboard')}\nYour whole pipeline on one screen: score breakdowns, resume changes, insights, and approve or skip.`, '',
      'On the computer JobAgent runs on, open:', `<code>${esc(link)}</code>`, '',
      phone ? `📱 <b>Phone access is on</b> through ${esc(new URL(phone).host)}. Tap below to open it here in Telegram.` : `📱 ${note('Phone access is off.')}`, '',
      note('The computer link is private to you: anyone with it on that computer can approve applications. Private answers are never shown on the dashboard.')].join('\n')
    : `${heading('🖥', 'Dashboard')}\n${note('The dashboard is not running. Restart JobAgent to start it.')}`,
  rows: [
    ...(link && phone ? [[{ text: '📱 Open dashboard', web_app: phone, style: 'success' as const }]] : []),
    ...(link ? [[phone ? { text: '🚫 Turn off phone access', data: 'm:dash:off' } : { text: '📱 Set up phone access', data: 'm:dash:ph' }]] : []),
    nav(),
  ],
})

export const phoneSetupPage = (port: number): Page => ({
  text: [heading('📱', 'Dashboard on your phone'), '',
    'Your phone reaches the dashboard through a secure tunnel to your computer. It is optional, and only you can sign in: every visit is checked against your Telegram account.', '',
    '<b>1.</b> On your computer, install Cloudflare Tunnel (<code>winget install Cloudflare.cloudflared</code> on Windows) or use Tailscale Funnel.',
    `<b>2.</b> Run <code>cloudflared tunnel --url http://127.0.0.1:${port}</code> and keep it open.`,
    '<b>3.</b> It prints an address like <code>https://something.trycloudflare.com</code>. Send that address here.', '',
    note('Quick tunnels get a new address each time they start: send the new one when it changes. Turn phone access off any time from this screen.')].join('\n'),
  rows: [[{ text: '✖ Cancel', data: 'm:dash' }]],
})

// ---- Chat shortcuts: common questions answered on the spot, without starting Claude ----
export type Intent = 'home' | 'needs' | 'jobs' | 'pause' | 'resume' | 'search' | 'help' | 'snooze' | 'reviews'
const INTENTS: [Intent, RegExp][] = [
  ['needs', /^(what('?s| is)|anything|is there anything) .*(waiting|need(s)? me|for me|to do)\b|^needs? you$|^inbox$/],
  ['reviews', /^(review|reviews|what('?s| is) (ready|to review))$/],
  ['jobs', /^(show|list|see)( me)?( my| all)? jobs$|^(my )?jobs$/],
  ['pause', /^(pause|hold on|stop for now|take a break)$/],
  ['resume', /^(resume|continue|carry on|unpause|keep going)$/],
  ['search', /^(search( now)?|find( me)?( new)? jobs( now)?|look for jobs)$/],
  ['snooze', /^(snooze|quiet|mute|be quiet|shh+)( for (an|1|one) hour)?$/],
  ['help', /^(help|what can you do|how does (this|it) work)$/],
  ['home', /^(hi|hello|hey|start|status|home|menu|what('?s| is) (up|happening|going on)|what are you doing|how('?s| is) it going|this week|stats)$/],
]
export const intentOf = (text: string): Intent | null => {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ')
  return t.length > 60 ? null : INTENTS.find(([, re]) => re.test(t))?.[0] ?? null
}

// ---- Review queue and the auto-search digest ----

// Applications waiting for review, best match first.
export const reviewQueue = (jobs: Job[]) => jobs.filter(j => j.status === 'AWAITING_APPROVAL').sort((a, b) => (b.score ?? -1) - (a.score ?? -1))

// One message when an auto-search run is over: what it prepared, ranked. Null when it prepared nothing for the user.
export function digestPage(jobs: Job[]): Page | null {
  const reviews = reviewQueue(jobs), kits = jobs.filter(j => j.status === 'KIT_READY').sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  if (!reviews.length && !kits.length) return null
  const line = (j: Job) => `${statusOf(j.status).emoji} <b>${esc(short(jobTitle(j), 56))}</b>${j.score != null ? ` · ${j.score}/100` : ''}${j.reasons[0] ? `\n     ${note(esc(short(j.reasons[0], 80)))}` : ''}`
  return {
    text: [
      heading('🔭', `Auto-search found ${plural(reviews.length + kits.length, 'good match', 'good matches')}`), '',
      ...(reviews.length ? [`<b>Ready for your review</b>`, ...reviews.map(line)] : []),
      ...(kits.length ? [...(reviews.length ? [''] : []), `<b>Ready for you to apply yourself</b>`, ...kits.map(line)] : []),
    ].join('\n'),
    rows: [
      ...(reviews.length ? [[{ text: reviews.length === 1 ? '🔔 Review it' : `🔔 Review all ${reviews.length}`, data: 'Q:0', style: 'success' as const }]] : []),
      ...kits.slice(0, 5).map(j => [{ text: `🧰 Apply yourself · ${short(jobTitle(j), 38)}`, data: `j:kit:${code(j.id)}` }]),
      [{ text: '🏠 Home', data: 'm:home' }],
    ],
  }
}

// ---- Jobs ----

const TABS: Record<string, [string, (j: Job, outcome?: string) => boolean]> = {
  a: ['Active', j => needsYou(j) || inProgress(j)],
  d: ['Applied', (j, o) => !o && ['SUBMITTED', 'APPLIED_SELF', 'DRY_RUN_DONE', 'APPROVED', 'SUBMITTING'].includes(j.status)],
  i: ['Interview', (_, o) => o === 'interview'],
  o: ['Offer', (_, o) => o === 'offer'],
  s: ['Skipped', (j, o) => j.status === 'SKIPPED' || j.status === 'CLOSED' || o === 'rejected' || o === 'ghosted'],
}
const PER = 6
export function jobsPage(jobs: Job[], tab: string, pg: number, outcomes: Record<string, string> = {}): Page {
  const [name, keep] = TABS[tab] ?? TABS.a
  const list = jobs.filter(j => keep(j, outcomes[j.id])).sort((a, b) => tab === 'a' ? +needsYou(b) - +needsYou(a) : 0) // what needs you first (stable sort keeps the order within)
  const pages = Math.max(1, Math.ceil(list.length / PER)), p = Math.min(Math.max(pg, 0), pages - 1)
  const slice = list.slice(p * PER, (p + 1) * PER)
  const counts = Object.fromEntries(Object.entries(TABS).map(([k, [, f]]) => [k, jobs.filter(j => f(j, outcomes[j.id])).length]))
  const body = slice.length
    ? slice.map(j => `${statusOf(j.status).emoji} <b>${esc(short(jobTitle(j), 56))}</b>${j.score != null ? ` · ${j.score}` : ''}\n     ${note(`${statusOf(j.status).text}${outcomes[j.id] ? ` · ${esc(label(outcomes[j.id]))}` : ''} · ${ago(j.updated_at)}`)}`)
    : [note(tab === 'a' ? 'Nothing in progress. Send me a job link to start one, or search now.' : 'Nothing here yet.')]
  if (tab === 'd' && slice.some(j => j.status === 'DRY_RUN_DONE')) body.push('', note('🧪 = practice run: nothing was sent.'))
  const pager: Btn[] = pages > 1 ? [
    { text: p > 0 ? '◀' : ' ', data: p > 0 ? `J:${tab}:${p - 1}` : 'noop' }, { text: `${p + 1} / ${pages}`, data: 'noop' }, { text: p < pages - 1 ? '▶' : ' ', data: p < pages - 1 ? `J:${tab}:${p + 1}` : 'noop' },
  ] : []
  return {
    text: [heading('📋', 'Jobs'), '', ...body].join('\n'),
    rows: [
      ...pairs(Object.entries(TABS).filter(([k]) => k === tab || counts[k] || 'ads'.includes(k)).map(([k, [n]]) => ({ text: `${k === tab ? '◉ ' : ''}${n} (${counts[k]})`, data: `J:${k}:0` })), 3),
      ...pairs(slice.map(j => ({ text: `${statusOf(j.status).emoji} ${short(jobTitle(j), 26)}`, data: `j:v:${code(j.id)}` }))),
      ...(pager.length ? [pager] : []),
      ...(!list.length && tab === 'a' ? [[{ text: '🔎 Search now', data: 'd:run', style: 'primary' as const }]] : []),
      [{ text: '📊 Insights', data: 'I:0' }, { text: '⬇️ Spreadsheet (CSV)', data: 'J:csv' }],
      nav(),
    ],
  }
}

export const OUTCOMES: Record<string, string> = { i: 'interview', o: 'offer', r: 'rejected', g: 'ghosted' }
const OUTCOME_LABEL: Record<string, string> = { interview: '🗣 Interview', offer: '🎉 Offer', rejected: '👎 Rejected', ghosted: '🦗 No reply' }

export function jobPage(j: Job, x: { running: boolean; hasForm: boolean; outcome?: string; usedPct?: number }): Page {
  const c = code(j.id), st = statusOf(j.status)
  const timeline = j.history.slice(-5).reverse().map(h => `${statusOf(h.status).emoji} ${esc(statusOf(h.status).text)}${h.detail ? `: ${esc(short(h.detail, 80))}` : ''} ${note(`· ${ago(h.at)}`)}`)
  const text = [
    heading('🏢', esc(jobTitle(j))),
    [j.location && `📍 ${esc(j.location)}`, j.salary && `💵 ${esc(j.salary)}`, j.score != null && `📊 Match ${j.score}/100`].filter(Boolean).join('  ·  '),
    '', kv('Status', `${st.emoji} ${esc(st.text)}`),
    ...(lastDetail(j) && (j.status === 'NEEDS_HUMAN' || j.status === 'FAILED' || j.status === 'SKIPPED') ? [quote(esc(lastDetail(j)))] : []),
    ...(breakdownLines(j.breakdown).length ? ['', ...breakdownLines(j.breakdown).map(l => note(l))] : []),
    ...(j.must_haves.length ? [`<b>They require</b> ${mustHaveLine(j.must_haves)}`] : []),
    ...(j.reasons.length ? ['', '<b>Why it fits</b>', ...j.reasons.map(r => `• ${esc(r)}`)] : []),
    ...(j.dealbreakers.length ? [`⚠️ ${esc(j.dealbreakers.join('; '))}`] : []),
    ...(x.outcome ? ['', kv('Outcome', OUTCOME_LABEL[x.outcome] ?? esc(x.outcome))] : []),
    '', '<b>History</b>', ...timeline,
    ...(x.usedPct ? [note(`⚡ This job used about ${x.usedPct}% of your 5-hour Claude limit.`)] : []),
  ].join('\n')
  const act: Btn[][] = []
  if (j.status === 'AWAITING_APPROVAL') act.push([{ text: '👀 Open the review', data: `r:rv:${c}`, style: 'success' }])
  if (j.status === 'KIT_READY') act.push([{ text: '🧰 Show my kit', data: `j:kit:${c}`, style: 'success' }, { text: '✅ I applied', data: `j:ap:${c}` }])
  if (j.status === 'NEEDS_ANSWERS' && x.hasForm) act.push([{ text: '❓ Answer the questions', data: `f:job:${c}`, style: 'success' }])
  if ((j.status === 'NEEDS_HUMAN' || j.status === 'FAILED') && !x.running) act.push([{ text: '🔄 Try again', data: `j:rt:${c}`, style: 'success' }, { text: '✅ I applied myself', data: `j:ap:${c}` }])
  if (j.status === 'SKIPPED' && !x.running) act.push([{ text: '↩ Apply anyway', data: `j:any:${c}` }])
  if (x.running) act.push([{ text: '✋ Stop working on it', data: `j:x:${c}`, style: 'danger' }])
  if (j.status === 'SUBMITTED' || j.status === 'DRY_RUN_DONE') act.push([{ text: j.status === 'SUBMITTED' ? '🧾 Receipt' : '🧾 Practice receipt', data: `j:rc:${c}` }])
  if (x.outcome === 'interview' && !x.running) act.push([{ text: '🎤 Interview prep', data: `j:pr:${c}`, style: 'success' }])
  if ((j.status === 'SUBMITTED' || j.status === 'APPLIED_SELF') && !x.running && (!x.outcome || x.outcome === 'ghosted')) act.push([{ text: '✍️ Draft a follow-up email', data: `j:fu:${c}` }])
  if (j.status === 'DRY_RUN_DONE' && !x.running) act.push([{ text: '🚀 Apply for real', data: `j:go:${c}`, style: 'success' }, { text: '✅ I applied myself', data: `j:ap:${c}` }])
  if (j.status === 'SUBMITTED' || j.status === 'APPLIED_SELF') { // a practice run was never sent, so it has no outcome
    act.push(Object.entries(OUTCOMES).slice(0, 2).map(([k, v]) => ({ text: `${x.outcome === v ? '◉ ' : ''}${OUTCOME_LABEL[v]}`, data: `j:o:${c}:${k}` })))
    act.push(Object.entries(OUTCOMES).slice(2).map(([k, v]) => ({ text: `${x.outcome === v ? '◉ ' : ''}${OUTCOME_LABEL[v]}`, data: `j:o:${c}:${k}` })))
  }
  const links: Btn[] = [...(j.url ? [{ text: '🔗 Posting', url: j.url }] : [])]
  if (!st.done && j.status !== 'APPROVED' && j.status !== 'SUBMITTING' && !x.running) links.push({ text: '⏭ Skip it', data: `j:sk:${c}` })
  return { text, rows: [...act, ...(links.length ? [links] : []), nav('J:a:0')] }
}

export type Receipt = { at: string; url: string; plan_hash: string; practice: boolean; files: string[]; answers: number; screenshot?: string }
export function receiptPage(j: Job, r: Receipt | null): Page {
  const back = [nav(`j:v:${code(j.id)}`)]
  if (!r) return { text: `${heading('🧾', 'No receipt')}\n${note('This application was sent before receipts existed.')}`, rows: back }
  return {
    text: [
      heading('🧾', r.practice ? 'Practice receipt (nothing was sent)' : 'Application receipt'),
      `<b>${esc(jobTitle(j))}</b>`, '',
      kv(r.practice ? 'Practice run' : 'Sent', `${esc(new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))} ${note(`(${ago(r.at)})`)}`),
      kv('Answers', String(r.answers)),
      kv('Files', esc(r.files.join(', ') || 'none')),
      kv('Fingerprint', `<code>${esc(r.plan_hash.slice(0, 12))}</code> ${note('matches what you approved')}`),
    ].join('\n'),
    rows: [...(r.url ? [[{ text: '🔗 Posting', url: r.url }]] : []), ...back],
  }
}

// ---- Profile & saved answers ----

export type AnswerRec = { key: string; base_key: string; question: string; answer: string; sensitive: boolean; scope: 'global' | 'job'; job: string; updated: string }
export const akey = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 8)

export function completeness(s: Settings, contact: Record<string, string>, answers: AnswerRec[]) {
  const checks: [string, boolean][] = [
    ['your name', !!contact.full_name], ['email', !!contact.email], ['phone', !!contact.phone],
    ['job titles', s.filters.titles.length > 0], ['locations', s.filters.locations.length > 0],
    ['work authorization', answers.some(a => a.key.startsWith('work_auth'))], ['sponsorship', answers.some(a => a.key.startsWith('sponsorship'))],
  ]
  const missing = checks.filter(([, ok]) => !ok).map(([n]) => n)
  return { pct: Math.round(((checks.length - missing.length) / checks.length) * 100), missing }
}

export function profilePage(s: Settings, contact: Record<string, string>, answers: AnswerRec[], resume: string | null): Page {
  const c = completeness(s, contact, answers)
  return {
    text: [
      heading('👤', 'Your profile'), '',
      `<b>${esc(contact.full_name || 'No name yet')}</b>`,
      `📧 ${esc(contact.email || '—')}   📞 ${esc(contact.phone || '—')}`,
      `📍 ${esc(contact.location || '—')}`,
      ...(contact.linkedin ? [`🔗 ${esc(contact.linkedin)}`] : []),
      `📄 ${resume ? `Resume: ${esc(resume)}` : note('No resume yet')}`,
      '',
      `${bar(c.pct, 100)} <b>${c.pct}% complete</b>`,
      c.missing.length ? note(`Missing: ${esc(c.missing.join(', '))}`) : note('I have everything I need.'),
      '',
      `💾 <b>${plural(answers.length, 'saved answer')}</b> ${note(`(${answers.filter(a => a.sensitive).length} private)`)}`,
      note('Answers you give me once are reused on every application, so I never ask twice.'),
    ].join('\n'),
    rows: [
      [{ text: '💾 Saved answers', data: 'a:l:0' }, { text: '✏️ Contact details', data: 'p:edit' }],
      [{ text: '📄 Replace resume', data: 'p:resume' }, { text: '🎯 What I look for', data: 'S:search' }],
      [{ text: '🏆 Achievements', data: 'p:ach' }],
      nav(),
    ],
  }
}

// Wins the user never put on the resume: tailoring may use them as true facts (profile.md, ## Achievements).
export const ACH_MAX = 12
const ACH_PROMPTS = [
  'A result you are proud of, with a number if you have one (saved time, money, users, speed).',
  'Something you built or launched, and who used it.',
  'A problem you fixed that others had given up on.',
  'A time you led people or a project, and how it went.',
]
export function achievementsPage(items: [string, string][], msg = ''): Page {
  return {
    text: [heading('🏆', 'Achievements'), note('Wins that are not on your resume yet. I may use them when I tailor your resume, word for word in meaning, never made bigger.'), '',
      ...(items.length ? items.map(([, v], i) => `<b>${i + 1}.</b> ${esc(v)}`) : [note('None yet.')]),
      ...(msg ? ['', msg] : [])].join('\n'),
    rows: [
      ...(items.length < ACH_MAX ? [[{ text: '➕ Add one', data: 'p:ach:add', style: 'primary' as const }]] : []),
      ...pairs(items.map(([k], i) => ({ text: `🗑 ${i + 1}`, data: `p:ach:rm:${k}` })), 6),
      nav('m:prof'),
    ],
  }
}
export const achievementPrompt = (n: number): Page => ({
  text: `${heading('🏆', 'Tell me one win')}\n${ACH_PROMPTS[n % ACH_PROMPTS.length]}\n\n${note('One or two sentences. Only what really happened.')}`,
  rows: [[{ text: '✖ Cancel', data: 'p:ach' }]],
})

export const contactEditPage = (contact: Record<string, string>, fields: [string, string][]): Page => ({
  text: [heading('✏️', 'Contact details'), note('These go on every application. Tap one to change it.'), '', ...fields.map(([k, l]) => `<b>${l}:</b> ${esc(contact[k] || '—')}`)].join('\n'),
  rows: [...pairs(fields.map(([k, l]) => ({ text: l, data: `p:f:${k}` })), 3), nav('m:prof')],
})

const CATS: [string, RegExp][] = [
  ['🛂 Work authorization', /work_auth|sponsor|visa|citizen/],
  ['💵 Pay', /salary|compensation|pay_|_pay/],
  ['🗓 Availability', /start|availab|notice|relocat/],
  ['📋 Diversity (optional)', /eeo|gender|race|ethnic|veteran|disab|pronoun/],
]
const OTHER = '🗂 Other'
const category = (key: string) => (CATS.find(([, re]) => re.test(key)) ?? [OTHER])[0]
const rank = (key: string) => { const c = category(key); return c === OTHER ? CATS.length : CATS.findIndex(([n]) => n === c) }
export const matchAnswers = (list: AnswerRec[], q: string) => {
  const w = q.toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter(a => w.every(x => `${a.key} ${a.question}`.toLowerCase().includes(x)))
}

export function answersPage(list: AnswerRec[], pg: number, searched?: string): Page {
  const PER_A = 6
  const sorted = [...list].sort((a, b) => rank(a.key) - rank(b.key))
  const pages = Math.max(1, Math.ceil(sorted.length / PER_A)), p = Math.min(Math.max(pg, 0), pages - 1)
  const slice = sorted.slice(p * PER_A, (p + 1) * PER_A)
  const body: string[] = []
  let cat = ''
  slice.forEach((a, i) => {
    if (category(a.key) !== cat) { cat = category(a.key); body.push('', `<b>${cat}</b>`) }
    body.push(`${i + 1}. ${a.sensitive ? '🔒 ' : ''}${esc(short(a.question, 90))}\n     → ${a.sensitive ? note('private, tap to view') : `<b>${esc(short(a.answer, 80))}</b>`}`)
  })
  if (!list.length) {
    return {
      text: `${heading('💾', searched ? 'No matches' : 'Saved answers')}\n\n${note(searched ? `Nothing matches "${esc(searched)}". Try fewer words.` : 'None yet. When you answer a question and keep "Remember it" on, it shows up here.')}`,
      rows: [[{ text: '🔎 Search', data: 'a:s' }], nav('m:prof')],
    }
  }
  return {
    text: [heading('💾', searched ? `Matches for "${esc(searched)}"` : 'Saved answers'), note(`${plural(list.length, 'answer')}${pages > 1 ? ` · page ${p + 1} of ${pages}` : ''}. Tap a number to see, change or delete it.`), ...body].join('\n'),
    rows: [
      slice.map((a, i) => ({ text: String(i + 1), data: `a:v:${akey(a.key)}` })),
      ...(pages > 1 ? [[{ text: p > 0 ? '◀ Previous' : ' ', data: p > 0 ? `a:l:${p - 1}` : 'noop' }, { text: p < pages - 1 ? 'Next ▶' : ' ', data: p < pages - 1 ? `a:l:${p + 1}` : 'noop' }]] : []),
      [{ text: '🔎 Search', data: 'a:s' }],
      nav('m:prof'),
    ],
  }
}

export const answerDetail = (a: AnswerRec): Page => ({
  text: [
    `<b>${a.sensitive ? '🔒 ' : ''}${esc(a.question)}</b>`, '',
    a.sensitive ? `<tg-spoiler>${esc(a.answer)}</tg-spoiler>\n${note('Private. Tap to reveal.')}` : quote(esc(a.answer)),
    '', note(`${a.scope === 'job' ? 'Only for one job' : 'Used on every application'} · updated ${a.updated ? ago(a.updated) : '—'}`),
  ].join('\n'),
  rows: [[{ text: '✏️ Change', data: `a:e:${akey(a.key)}` }, { text: '🗑 Delete', data: `a:d:${akey(a.key)}` }], nav('a:l:0')],
})
export const answerDeleteConfirm = (a: AnswerRec): Page => ({
  text: `${heading('🗑', 'Delete this saved answer?')}\n\n${esc(a.question)}\n\n${note('I will ask you again the next time an application needs it.')}`,
  rows: [[{ text: '🗑 Yes, delete it', data: `a:dd:${akey(a.key)}`, style: 'danger' }, { text: 'Keep it', data: `a:v:${akey(a.key)}` }]],
})

// ---- Help ----

const HELP: Record<string, [string, string]> = {
  how: ['🧭 How it works', [
    '1️⃣ <b>You send a job link</b> (or Auto-search finds one).',
    '2️⃣ <b>I read the posting</b> in a locked-down reader that cannot take orders from the posting, and score how well it fits you (0–100). Weak fits are skipped, with the reason shown.',
    '3️⃣ <b>I ask only what I can\'t know</b>, like work authorization, once. Your answers are saved for next time.',
    '4️⃣ <b>I tailor your resume</b>: I reword a few lines to mirror the job, keep your layout, and never invent experience.',
    '5️⃣ <b>I fill in the form</b> in a hidden browser and take a screenshot.',
    '6️⃣ <b>You review everything</b>: every answer, what I changed on your resume, and a picture of the filled form. Approve, edit an answer, or skip.',
    '', 'Each job has a live card in the chat, so you can always see which step I am on.',
  ].join('\n')],
  practice: ['🧪 Practice mode', 'Practice mode is <b>on</b> until you turn it off. I do every step except pressing Submit, so you can see exactly what would be sent.\n\nTurn it off in Settings → Practice mode when you are ready. You still approve each application. A job you practised on has 🚀 Apply for real: I prepare it again and you approve it again.'],
  auto: ['🔭 Auto-search', 'With Auto-search on, I check the companies you watch and search LinkedIn and Indeed (Glassdoor and ZipRecruiter too, if you turn them on) for new jobs on a schedule, using only your search settings. Set "Posted within" to 1 hour and "How often" to every hour to see only the newest postings. I can also find new companies hiring for your titles.\n\nI also search your Related titles, and each day pick a few jobs with a different title in your field whose posting asks for several of your skills (⚙️ Settings → Auto-search → Jobs with other titles). Those only get prepared when they score 10 points above your minimum.\n\nGood matches get prepared and sent to you for review. Quiet hours pause it overnight.'],
  approve: ['✅ Approving & auto-apply', 'By default <b>you approve every application</b>. An approval is tied to the exact answers and files you saw: if anything changes, I ask again.\n\n<b>Auto-apply</b> (Settings → How I apply) sends only very strong matches on its own, after a countdown with a Cancel button. Unusual forms and private questions always come to you.'],
  privacy: ['🔒 Your data', 'Everything (your profile, answers and resume) stays in the <code>data</code> folder on your computer. The thinking runs on your own Claude account.\n\nTelegram bot chats are not end-to-end encrypted, so private answers are hidden behind a tap. Job postings are treated as untrusted text and can never give me instructions.'],
  stop: ['⏸ Pausing & stopping', '<b>⏸ Pause</b> (Home) finishes nothing new: links you send wait in line until you resume.\n<b>✋ Stop</b> on a job card stops that job right away.\n/stop pauses and stops everything that is running.\n\nClosing the JobAgent window on your computer turns me off completely.'],
  more: ['✨ Insights, prep & dashboard', '<b>📊 Insights</b> (Jobs → Insights): where your applications go and which matches get interviews. A weekly summary comes on Monday.\n<b>🎤 Interview prep</b>: mark a job Interview, then tap it for a prep pack built from your own profile.\n<b>✍️ Follow-ups</b>: after a week with no news I ask how it went and can draft a follow-up email for you.\n<b>🖥 Dashboard</b> (Home): your whole pipeline on one screen, on your computer.\n<b>🏆 Achievements</b> (Profile): wins that are not on your resume yet; I may use them when tailoring.'],
  trouble: ['🛠 Troubleshooting', '<b>I don\'t answer:</b> is the JobAgent window still open on your computer, and is the computer awake?\n<b>"Usage limit reached":</b> your Claude plan\'s limit. I wait and continue by myself.\n<b>A job is "stuck":</b> it hit a login, CAPTCHA or an unusual page. Open it in Jobs and tap Try again, or apply by hand.\n<b>LinkedIn or Indeed wants a login:</b> ⚙️ Settings → 🔑 Job site logins. Log in once in the window that opens on your computer, then tap Try again.\n<b>Greenhouse, Lever and Ashby</b> application forms can be filled. For LinkedIn and Indeed links I look for the employer\'s own form first; other links are scored, and good matches get an application kit (your tailored resume and drafted answers) so you can apply yourself, then tap I applied.'],
}
export function helpPage(topic?: string): Page {
  const t = topic && HELP[topic]
  if (t) return { text: `${heading('', t[0]).replace('<b> ', '<b>')}\n\n${t[1]}`, rows: [nav('m:help')] }
  return {
    text: [heading('❔', 'Help'), '', 'Pick a topic.', '', note('Commands: /menu home · /jobs · /settings · /pause · /resume · /snooze · /stop · /health · /fix'), note(`Or just ask: "what's waiting?", "status", "show my jobs".`)].join('\n'),
    rows: [...pairs(Object.entries(HELP).map(([k, [title]]) => ({ text: title, data: `h:${k}` }))), nav()],
  }
}
