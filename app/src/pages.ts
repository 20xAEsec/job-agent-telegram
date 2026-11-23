// Main screens. Pure: state in, text + buttons out.
import { createHash } from 'crypto'
import type { Live, Usage } from './agent'
import type { Form } from './forms'
import { code, inProgress, jobTitle, lastDetail, needsYou, statusOf, type Job } from './jobs'
import { ago, bar, elapsed, esc, heading, kv, label, money, nav, note, pairs, plural, quote, short, until, type Btn, type Page } from './kit'
import { practiceForced, practiceOn, type Settings } from './state'

export type HomeCtx = {
  s: Settings; work?: Live; workTitle?: string; queued: number; jobs: Job[]; forms: Form[]; usage?: Usage; nextSearch?: number | null; limitedUntil?: number; companies?: number
}

const week = (jobs: Job[], now = Date.now()) => {
  const since = now - 7 * 86_400_000
  const reached = (j: Job, st: string[]) => j.history.some(h => st.includes(h.status) && Date.parse(h.at) >= since)
  return {
    found: jobs.filter(j => Date.parse(j.history[0]?.at ?? '') >= since).length,
    ready: jobs.filter(j => reached(j, ['AWAITING_APPROVAL'])).length,
    sent: jobs.filter(j => reached(j, ['SUBMITTED'])).length,
    practice: jobs.filter(j => reached(j, ['DRY_RUN_DONE'])).length,
  }
}

export function needsCount(c: Pick<HomeCtx, 'jobs' | 'forms'>) {
  const reviews = c.jobs.filter(j => j.status === 'AWAITING_APPROVAL').length
  const forms = c.forms.length
  const other = c.jobs.filter(j => j.status === 'NEEDS_HUMAN' || j.status === 'FAILED').length
  return { reviews, forms, other, total: reviews + forms + other }
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

export function home(c: HomeCtx, now = Date.now()): Page {
  const { s } = c
  const n = needsCount(c)
  const w = week(c.jobs, now)
  const mode = practiceOn(s) ? '🧪 Practice mode' : '🚀 <b>Live</b>: approved applications are sent'
  const lines = [
    heading('🏠', 'JobAgent'),
    `${s.agent_on ? '🟢 Running' : '⏸ Paused'} · ${mode}`,
    '',
    ...workLines(c, now),
    '',
    n.total
      ? `📥 <b>Needs you:</b> ${[n.reviews && plural(n.reviews, 'review'), n.forms && plural(n.forms, 'question form'), n.other && plural(n.other, 'problem')].filter(Boolean).join(' · ')}`
      : `✨ ${note('Nothing needs you right now.')}`,
    s.discovery.enabled
      ? `🔭 <b>Auto-search:</b> ${c.nextSearch ? `next ${until(c.nextSearch, now)}` : 'running soon'}${c.companies != null ? ` · ${c.companies ? plural(c.companies, 'company', 'companies') : s.discovery.web_search ? 'finding companies' : '⚠️ no companies to watch yet'}` : ''}`
      : `🔭 <b>Auto-search:</b> off ${note('(I only work on links you send)')}`,
    `📊 <b>This week:</b> ${w.found} found · ${w.ready} prepared · ${practiceOn(s) && !w.sent ? `${w.practice} practice runs` : `${w.sent} sent`}`,
    ...(c.usage?.five_hour != null ? [`⚡ <b>Claude usage:</b> ${bar(c.usage.five_hour, 1)} ${Math.round(c.usage.five_hour * 100)}% ${note('of your 5-hour limit')}`] : []),
  ]
  const rows: Btn[][] = []
  if (!s.onboarded) rows.push([{ text: '🧩 Finish setup', data: 'o:resume', style: 'success' }])
  rows.push([{ text: `📥 Needs you${n.total ? ` (${n.total})` : ''}`, data: 'N:0', ...(n.total ? { style: 'primary' as const } : {}) }, { text: '📋 Jobs', data: 'J:a:0' }])
  rows.push([
    s.discovery.enabled ? { text: '🔎 Search now', data: 'd:run' } : { text: '🔭 Turn on Auto-search', data: 's:ae' },
    s.agent_on ? { text: '⏸ Pause', data: 'H:pause' } : { text: '▶️ Resume', data: 'H:resume', style: 'success' },
  ])
  rows.push([{ text: '⚙️ Settings', data: 'm:settings' }, { text: '👤 Profile', data: 'm:prof' }])
  rows.push([{ text: '❔ Help', data: 'm:help' }, { text: '🔄 Refresh', data: 'm:home' }])
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
  const problems = c.jobs.filter(j => j.status === 'NEEDS_HUMAN' || j.status === 'FAILED')
  const rows: Btn[][] = [
    ...reviews.map(j => [{ text: `🔔 Review · ${short(jobTitle(j), 44)}`, data: `r:rv:${code(j.id)}` }]),
    ...c.forms.map(f => [{ text: `❓ Answer · ${short(f.title ?? 'Questions', 44)}`, data: `f:${code(f.batch_id)}:open` }]),
    ...problems.map(j => [{ text: `${statusOf(j.status).emoji} ${short(jobTitle(j), 50)}`, data: `j:v:${code(j.id)}` }]),
  ]
  if (!rows.length) return { text: `${heading('📥', 'Needs you')}\n\n✨ All clear. Nothing is waiting for you.\n\n${note('Reviews, questions and problems show up here.')}`, rows: [nav()] }
  const text = [
    heading('📥', 'Needs you'), '',
    ...(reviews.length ? [`🔔 <b>${plural(reviews.length, 'application')} to review</b>`, note('Approve, change or skip.')] : []),
    ...(c.forms.length ? [`❓ <b>${plural(c.forms.length, 'question form')}</b>`, note('Things only you can answer.')] : []),
    ...(problems.length ? [`🙋 <b>${plural(problems.length, 'job')} stuck</b>`, note('A login, a CAPTCHA, or an error. Tap one to see what happened.')] : []),
  ].join('\n')
  return { text, rows: [...rows.slice(0, 20), nav()] }
}

// ---- Jobs ----

const TABS: Record<string, [string, (j: Job) => boolean]> = {
  a: ['Active', j => needsYou(j) || inProgress(j)],
  d: ['Applied', j => j.status === 'SUBMITTED' || j.status === 'DRY_RUN_DONE' || j.status === 'APPROVED' || j.status === 'SUBMITTING'],
  s: ['Skipped', j => j.status === 'SKIPPED' || j.status === 'CLOSED'],
}
const PER = 6
export function jobsPage(jobs: Job[], tab: string, pg: number, outcomes: Record<string, string> = {}): Page {
  const [name, keep] = TABS[tab] ?? TABS.a
  const list = jobs.filter(keep)
  const pages = Math.max(1, Math.ceil(list.length / PER)), p = Math.min(Math.max(pg, 0), pages - 1)
  const slice = list.slice(p * PER, (p + 1) * PER)
  const counts = Object.fromEntries(Object.entries(TABS).map(([k, [, f]]) => [k, jobs.filter(f).length]))
  const body = slice.length
    ? slice.map(j => `${statusOf(j.status).emoji} <b>${esc(short(jobTitle(j), 56))}</b>${j.score != null ? ` · ${j.score}` : ''}\n     ${note(`${statusOf(j.status).text}${outcomes[j.id] ? ` · ${esc(label(outcomes[j.id]))}` : ''} · ${ago(j.updated_at)}`)}`)
    : [note(tab === 'a' ? 'Nothing in progress. Send me a job link to start one.' : 'Nothing here yet.')]
  const pager: Btn[] = pages > 1 ? [
    { text: p > 0 ? '◀' : ' ', data: p > 0 ? `J:${tab}:${p - 1}` : 'noop' }, { text: `${p + 1} / ${pages}`, data: 'noop' }, { text: p < pages - 1 ? '▶' : ' ', data: p < pages - 1 ? `J:${tab}:${p + 1}` : 'noop' },
  ] : []
  return {
    text: [heading('📋', 'Jobs'), '', ...body].join('\n'),
    rows: [
      Object.entries(TABS).map(([k, [n]]) => ({ text: `${k === tab ? '◉ ' : ''}${n} (${counts[k]})`, data: `J:${k}:0` })),
      ...pairs(slice.map(j => ({ text: `${statusOf(j.status).emoji} ${short(jobTitle(j), 26)}`, data: `j:v:${code(j.id)}` }))),
      ...(pager.length ? [pager] : []),
      [{ text: '⬇️ Export all as a spreadsheet (CSV)', data: 'J:csv' }],
      nav(),
    ],
  }
}

export const OUTCOMES: Record<string, string> = { i: 'interview', o: 'offer', r: 'rejected', g: 'ghosted' }
const OUTCOME_LABEL: Record<string, string> = { interview: '🗣 Interview', offer: '🎉 Offer', rejected: '👎 Rejected', ghosted: '🦗 No reply' }

export function jobPage(j: Job, x: { running: boolean; hasForm: boolean; outcome?: string }): Page {
  const c = code(j.id), st = statusOf(j.status)
  const timeline = j.history.slice(-5).reverse().map(h => `${statusOf(h.status).emoji} ${esc(statusOf(h.status).text)}${h.detail ? `: ${esc(short(h.detail, 80))}` : ''} ${note(`· ${ago(h.at)}`)}`)
  const text = [
    heading('🏢', esc(jobTitle(j))),
    [j.location && `📍 ${esc(j.location)}`, j.salary && `💵 ${esc(j.salary)}`, j.score != null && `📊 Match ${j.score}/100`].filter(Boolean).join('  ·  '),
    '', kv('Status', `${st.emoji} ${esc(st.text)}`),
    ...(lastDetail(j) && (j.status === 'NEEDS_HUMAN' || j.status === 'FAILED' || j.status === 'SKIPPED') ? [quote(esc(lastDetail(j)))] : []),
    ...(j.reasons.length ? ['', '<b>Why it fits</b>', ...j.reasons.map(r => `• ${esc(r)}`)] : []),
    ...(j.dealbreakers.length ? [`⚠️ ${esc(j.dealbreakers.join('; '))}`] : []),
    ...(x.outcome ? ['', kv('Outcome', OUTCOME_LABEL[x.outcome] ?? esc(x.outcome))] : []),
    '', '<b>History</b>', ...timeline,
  ].join('\n')
  const act: Btn[][] = []
  if (j.status === 'AWAITING_APPROVAL') act.push([{ text: '👀 Open the review', data: `r:rv:${c}`, style: 'success' }])
  if (j.status === 'NEEDS_ANSWERS' && x.hasForm) act.push([{ text: '❓ Answer the questions', data: `f:job:${c}`, style: 'success' }])
  if ((j.status === 'NEEDS_HUMAN' || j.status === 'FAILED') && !x.running) act.push([{ text: '🔄 Try again', data: `j:rt:${c}`, style: 'success' }])
  if (j.status === 'SKIPPED' && !x.running) act.push([{ text: '↩ Apply anyway', data: `j:any:${c}` }])
  if (x.running) act.push([{ text: '✋ Stop working on it', data: `j:x:${c}`, style: 'danger' }])
  if (j.status === 'SUBMITTED' || j.status === 'DRY_RUN_DONE') {
    act.push(Object.entries(OUTCOMES).slice(0, 2).map(([k, v]) => ({ text: `${x.outcome === v ? '◉ ' : ''}${OUTCOME_LABEL[v]}`, data: `j:o:${c}:${k}` })))
    act.push(Object.entries(OUTCOMES).slice(2).map(([k, v]) => ({ text: `${x.outcome === v ? '◉ ' : ''}${OUTCOME_LABEL[v]}`, data: `j:o:${c}:${k}` })))
  }
  const links: Btn[] = [...(j.url ? [{ text: '🔗 Posting', url: j.url }] : [])]
  if (!st.done && j.status !== 'APPROVED' && j.status !== 'SUBMITTING' && !x.running) links.push({ text: '⏭ Skip it', data: `j:sk:${c}` })
  return { text, rows: [...act, ...(links.length ? [links] : []), nav('J:a:0')] }
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
      nav(),
    ],
  }
}

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
    '2️⃣ <b>I read the posting</b> in a sandboxed reader and score how well it fits you (0–100). Weak fits are skipped, with the reason shown.',
    '3️⃣ <b>I ask only what I can\'t know</b>, like work authorization, once. Your answers are saved for next time.',
    '4️⃣ <b>I tailor your resume</b>: I reword a few lines to mirror the job, keep your layout, and never invent experience.',
    '5️⃣ <b>I fill in the form</b> in a hidden browser and take a screenshot.',
    '6️⃣ <b>You review everything</b>: every answer, the files, the screenshot. Approve, change something, or skip.',
    '', 'Each job has a live card in the chat, so you can always see which step I am on.',
  ].join('\n')],
  practice: ['🧪 Practice mode', 'Practice mode is <b>on</b> until you turn it off. I do every step except pressing Submit, so you can see exactly what would be sent.\n\nTurn it off in Settings → Practice mode when you are ready. You still approve each application.'],
  auto: ['🔭 Auto-search', 'With Auto-search on, I check the companies you watch for new jobs on a schedule, using only your search settings. I can also find new companies hiring for your titles.\n\nGood matches get prepared and sent to you for review. Quiet hours pause it overnight.'],
  approve: ['✅ Approving & auto-apply', 'By default <b>you approve every application</b>. An approval is tied to the exact answers and files you saw: if anything changes, I ask again.\n\n<b>Auto-apply</b> (Settings → How I apply) sends only very strong matches on its own, after a countdown with a Cancel button. Unusual forms and private questions always come to you.'],
  privacy: ['🔒 Your data', 'Everything (your profile, answers and resume) stays in the <code>data</code> folder on your computer. The thinking runs on your own Claude account.\n\nTelegram bot chats are not end-to-end encrypted, so private answers are hidden behind a tap. Job postings are treated as untrusted text and can never give me instructions.'],
  stop: ['⏸ Pausing & stopping', '<b>⏸ Pause</b> (Home) finishes nothing new: links you send wait in line until you resume.\n<b>✋ Stop</b> on a job card stops that job right away.\n/stop pauses and stops everything that is running.\n\nClosing the JobAgent window on your computer turns me off completely.'],
  trouble: ['🛠 Troubleshooting', '<b>I don\'t answer:</b> is the JobAgent window still open on your computer, and is the computer awake?\n<b>"Usage limit reached":</b> your Claude plan\'s limit. I wait and continue by myself.\n<b>A job is "stuck":</b> it hit a login, CAPTCHA or an unusual page. Open it in Jobs and tap Try again, or apply by hand.\n<b>Only Greenhouse</b> application forms can be filled for now. Other links are scored, then you get the link to apply yourself.'],
}
export function helpPage(topic?: string): Page {
  const t = topic && HELP[topic]
  if (t) return { text: `${heading('', t[0]).replace('<b> ', '<b>')}\n\n${t[1]}`, rows: [nav('m:help')] }
  return {
    text: [heading('❔', 'Help'), '', 'Pick a topic.', '', note('Commands: /menu home · /jobs · /settings · /pause · /resume · /stop · /fix')].join('\n'),
    rows: [...pairs(Object.entries(HELP).map(([k, [title]]) => ({ text: title, data: `h:${k}` }))), nav()],
  }
}
