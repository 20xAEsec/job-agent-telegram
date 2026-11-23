// Settings screens, table-driven. Every setting says in plain words what it does, shows its current value,
// and opens an editor that fits its type (choices, chips, toggle, list or typed value). Callback codes stay short.
import { esc, heading, label, money, nav, note, pairs, short, type Btn, type Page } from './kit'
import { getPath, practiceForced, practiceOn, type Settings } from './state'

type Opt = [value: string, label: string, desc?: string]
export type Spec = {
  id: string; label: string; emoji: string; path: string[]
  t: 'bool' | 'enum' | 'multi' | 'int' | 'list' | 'time'
  what: string; opts?: Opt[]; presets?: number[]; nullable?: string; unit?: string; example?: string
  show?: (v: any, s: Settings) => string
}
const S = (id: string, emoji: string, lbl: string, path: string, t: Spec['t'], what: string, x: Partial<Spec> = {}): Spec =>
  ({ id, emoji, label: lbl, path: path.split('.'), t, what, ...x })

const LEVELS: Opt[] = ['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director'].map(v => [v, label(v)])

export const CATS: Record<string, { emoji: string; title: string; blurb: string; items: Spec[] }> = {
  search: {
    emoji: '🎯', title: 'What I look for', blurb: 'The jobs I go after, and the ones I skip.',
    items: [
      S('ti', '🎯', 'Job titles', 'filters.titles', 'list', 'The titles I search for. I also match close variations (see "Title matching").', { example: 'Data Analyst, BI Analyst' }),
      S('lv', '📶', 'Seniority', 'filters.experience_level', 'enum', 'The level you are aiming for. Jobs far above or below it get a lower match score.', { opts: LEVELS }),
      S('yr', '⏳', 'Years of experience', 'filters.years_experience', 'int', 'Used to judge whether you meet a job\'s experience requirement.', { presets: [1, 2, 3, 5, 8, 10, 15], nullable: 'Not set', unit: 'years' }),
      S('lo', '📍', 'Locations', 'filters.locations', 'list', 'Cities, regions or countries where you would work on-site or hybrid. Remote jobs are judged separately.', { example: 'Austin, TX, Remote US' }),
      S('rm', '🏡', 'Remote or on-site', 'filters.remote', 'enum', 'Which kinds of workplace I look for.', {
        opts: [
          ['remote_or_hybrid', 'Remote or hybrid', 'Remote jobs, plus hybrid and on-site jobs in your locations'],
          ['remote_only', 'Remote only', 'Only fully remote jobs'],
          ['any', 'Anything', 'Remote, hybrid or on-site, anywhere in your locations'],
          ['onsite_only', 'On-site only', 'Only jobs at an office in your locations'],
        ],
      }),
      S('sa', '💵', 'Minimum salary', 'filters.min_salary', 'int', 'The lowest yearly pay you would accept. Jobs that post a lower range are skipped.', { presets: [50000, 75000, 100000, 125000, 150000, 200000], nullable: 'No minimum', show: (v, s) => (v == null ? 'No minimum' : `${money(v, s.filters.currency)} / year`) }),
      S('cu', '💱', 'Salary currency', 'filters.currency', 'enum', 'The currency of your minimum salary.', { opts: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR'].map(c => [c, c] as Opt) }),
      S('us', '❔', 'Jobs with no salary listed', 'filters.allow_unknown_salary', 'bool', 'Many postings hide the pay. ON keeps them (I still check the rest); OFF skips them when you have a minimum salary.'),
      S('jt', '🗂', 'Job types', 'filters.job_types', 'multi', 'Employment types you want. Jobs of other types are skipped.', { opts: ['full_time', 'part_time', 'contract', 'internship'].map(v => [v, label(v)] as Opt) }),
      S('tm', '🔤', 'Title matching', 'filters.title_match', 'enum', 'How closely a posting\'s title must match one of yours.', {
        opts: [
          ['close', 'Close', '"Senior Data Analyst" and "Data Analyst II" count as Data Analyst'],
          ['exact', 'Exact', 'Only the same title, ignoring case and punctuation'],
          ['broad', 'Broad', 'Loosely related titles too: more jobs, more noise'],
        ],
      }),
      S('pw', '🗓', 'Posted within', 'filters.posted_within_days', 'int', 'Ignore postings older than this. Older postings are more often filled already.', { presets: [3, 7, 14, 30, 60], unit: 'days' }),
      S('ex', '🚫', 'Words to avoid', 'filters.exclude_keywords', 'list', 'Jobs whose title contains any of these are skipped.', { example: 'Intern, Sales, Clearance' }),
      S('bl', '⛔', 'Companies to avoid', 'filters.company_blocklist', 'list', 'I never apply to these companies. "Never this company" on a review adds to this list.'),
    ],
  },
  apply: {
    emoji: '📨', title: 'How I apply', blurb: 'What I do once I find a good match.',
    items: [
      S('mo', '👀', 'Approval', 'apply.mode', 'enum', 'Whether you approve each application, or let me send the strongest matches on my own.', {
        opts: [
          ['review', 'I review every application', 'Nothing is sent until you tap Approve (recommended)'],
          ['auto', 'Auto-apply to strong matches', `Jobs at or above your auto-apply score are sent after a short countdown you can cancel. Odd forms and private questions still come to you.`],
        ],
      }),
      S('ms', '📊', 'Minimum match score', 'apply.min_match_score', 'int', 'I score each job 0–100 against your profile and settings. Jobs below this are skipped, so you only see real candidates.', { presets: [40, 50, 60, 70, 80], unit: '/ 100' }),
      S('am', '⚡', 'Auto-apply score', 'apply.auto_min_score', 'int', 'With auto-apply on, only jobs at or above this score are sent without your review. The rest wait for you.', { presets: [75, 80, 85, 90, 95], unit: '/ 100' }),
      S('gr', '⏱', 'Auto-apply countdown', 'apply.auto_grace_seconds', 'int', 'Before an auto-apply goes out I show it with a Cancel button for this long.', { presets: [60, 120, 300, 600], show: v => (v >= 60 ? `${v / 60} min` : `${v} s`), unit: 'seconds' }),
      S('cd', '🏢', 'Space out one company', 'apply.company_cooldown_hours', 'int', 'Applying to many roles at one company at once looks spammy. I wait at least this long between them.', { presets: [0, 3, 24, 72], unit: 'hours' }),
      S('cl', '✉️', 'Cover letters', 'apply.cover_letter', 'enum', 'When I write a short cover letter (from your real experience only).', {
        opts: [['if_field', 'When the form has a field for one'], ['if_required', 'Only when required'], ['always', 'Always'], ['never', 'Never']].map(([v, l]) => [v, l] as Opt),
      }),
      S('df', '✍️', 'Draft open questions', 'apply.draft_free_text', 'bool', 'ON: I draft answers to questions like "Why do you want to work here?" from your profile; you see every draft in the review. OFF: I ask you instead.'),
      S('tl', '📝', 'Resume tailoring', 'apply.tailoring', 'enum', 'How much I adjust your resume for each job. Your layout is always kept, and I never invent experience.', {
        opts: [
          ['moderate', 'Moderate', 'Reword up to 12 lines to mirror the job (recommended)'],
          ['light', 'Light touch', 'Reword at most 5 lines, keep the length exactly'],
        ],
      }),
      S('md', '🧠', 'Claude model', 'agent_model', 'enum', 'The Claude model that does the thinking. It runs on your own Claude subscription.', {
        opts: [
          ['sonnet', 'Balanced (Sonnet)', 'Fast and good; uses less of your Claude usage limit (recommended)'],
          ['opus', 'Best quality (Opus)', 'Sharper writing and judgment; uses your limit faster'],
        ],
      }),
    ],
  },
  auto: {
    emoji: '🔭', title: 'Auto-search', blurb: 'Let me look for new jobs on a schedule instead of waiting for your links.',
    items: [
      S('ae', '🔭', 'Auto-search', 'discovery.enabled', 'bool', 'ON: I check the companies you watch for new jobs that fit your settings, and prepare the good ones. Nothing is sent without you (unless you turn on auto-apply).'),
      S('ai', '🔁', 'How often', 'discovery.interval_hours', 'int', 'Time between searches. Searches pause during quiet hours.', { presets: [2, 4, 6, 12, 24], show: v => `every ${v} h`, unit: 'hours' }),
      S('aw', '🌐', 'Find new companies', 'discovery.web_search', 'bool', 'ON: once a day I also search the web for companies hiring for your titles, and start watching them. Only your titles and locations are used in the search, never personal details.'),
    ],
  },
  quiet: {
    emoji: '🌙', title: 'Quiet hours', blurb: 'No notification sounds and no automatic searches overnight.',
    items: [
      S('qe', '🌙', 'Quiet hours', 'quiet_hours.enabled', 'bool', 'ON: messages still arrive in these hours, but silently, and auto-search waits until morning.'),
      S('qf', '🌒', 'Starts at', 'quiet_hours.from', 'time', 'When quiet hours begin (your computer\'s clock).'),
      S('qt', '🌅', 'Ends at', 'quiet_hours.to', 'time', 'When quiet hours end.'),
    ],
  },
}
export const SPECS: Spec[] = Object.values(CATS).flatMap(c => c.items)
export const specById = (id: string) => SPECS.find(s => s.id === id)
export const catOf = (spec: Spec) => Object.keys(CATS).find(k => CATS[k].items.includes(spec))!

export function valueText(spec: Spec, s: Settings): string {
  const v = getPath(s, spec.path) as any
  if (spec.show) return spec.show(v, s)
  if (spec.t === 'bool') return v ? 'On' : 'Off'
  if (spec.t === 'list') return Array.isArray(v) && v.length ? short(v.join(', '), 60) : 'None'
  if (spec.t === 'multi') return Array.isArray(v) && v.length ? v.map(label).join(', ') : 'None'
  if (spec.t === 'enum') return spec.opts?.find(o => o[0] === v)?.[1] ?? label(v)
  if (v === null || v === undefined || v === '') return spec.nullable ?? 'Not set'
  return spec.unit && !spec.unit.startsWith('/') ? `${v} ${spec.unit}` : spec.unit ? `${v} ${spec.unit}` : String(v)
}

export function settingsRoot(s: Settings, companies: number): Page {
  const lines = [
    heading('⚙️', 'Settings'), note('Tap a group to see and change what is in it.'), '',
    `🎯 <b>What I look for</b>\n${note(esc(short(s.filters.titles.join(', ') || 'No job titles yet', 60)))}`,
    `📨 <b>How I apply</b>\n${note(s.apply.mode === 'auto' ? `Auto-apply at ${s.apply.auto_min_score}+ · skip below ${s.apply.min_match_score}` : `You approve every application · skip below ${s.apply.min_match_score}`)}`,
    `🔭 <b>Auto-search</b>\n${note(s.discovery.enabled ? `On, every ${s.discovery.interval_hours} h · ${companies} compan${companies === 1 ? 'y' : 'ies'} watched` : 'Off')}`,
    `🌙 <b>Quiet hours</b>\n${note(s.quiet_hours.enabled ? `${s.quiet_hours.from}–${s.quiet_hours.to}` : 'Off')}`,
    `${practiceOn(s) ? '🧪' : '🚀'} <b>Practice mode</b>\n${note(practiceOn(s) ? 'On: applications are prepared but never sent' : 'Off: approved applications are really sent')}`,
  ]
  return {
    text: lines.join('\n'),
    rows: [
      [{ text: '🎯 What I look for', data: 'S:search' }, { text: '📨 How I apply', data: 'S:apply' }],
      [{ text: '🔭 Auto-search', data: 'S:auto' }, { text: '🌙 Quiet hours', data: 'S:quiet' }],
      [{ text: practiceOn(s) ? '🧪 Practice mode: On' : '🚀 Practice mode: Off', data: 'P:show' }],
      nav(),
    ],
  }
}

export function categoryPage(key: string, s: Settings): Page {
  const c = CATS[key]
  const body = c.items.map(spec => `${spec.emoji} <b>${spec.label}</b>: ${esc(valueText(spec, s))}`)
  const btns: Btn[] = c.items.map(spec => ({ text: `${spec.emoji} ${spec.label}`, data: `s:${spec.id}` }))
  const extra: Btn[][] = key === 'auto' ? [[{ text: '🏢 Companies I watch', data: 'C:list' }], ...(s.discovery.enabled ? [[{ text: '🔎 Search now', data: 'd:run' }]] : [])] : []
  return {
    text: [heading(c.emoji, c.title), note(c.blurb), '', ...body].join('\n'),
    rows: [...pairs(btns), ...extra, nav('m:settings')],
  }
}

const chip = (spec: Spec, v: number) => (spec.path[1] === 'min_salary' ? money(v) : spec.show ? spec.show(v, {} as Settings) : String(v))

// The editor for one setting.
export function specPage(spec: Spec, s: Settings, msg?: string): Page {
  const v = getPath(s, spec.path) as any
  const head = [heading(spec.emoji, spec.label), esc(spec.what), '', `<b>Now:</b> ${esc(valueText(spec, s))}`]
  if (msg) head.push('', msg)
  const back = nav(`S:${catOf(spec)}`)
  const id = spec.id
  if (spec.t === 'bool') {
    return { text: head.join('\n'), rows: [[v ? { text: '⚪ Turn off', data: `s:${id}:t` } : { text: '🟢 Turn on', data: `s:${id}:t`, style: 'success' }], back] }
  }
  if (spec.t === 'enum') {
    const lines = spec.opts!.map(([o, l, d]) => `${o === v ? '◉' : '○'} <b>${esc(l)}</b>${d ? `\n     ${note(esc(d))}` : ''}`)
    const btns = spec.opts!.map(([o, l], j) => ({ text: `${o === v ? '◉ ' : ''}${l}`, data: `s:${id}:v:${j}` }))
    return { text: [...head, '', ...lines].join('\n'), rows: [...(btns.length > 4 ? pairs(btns) : btns.map(b => [b])), back] }
  }
  if (spec.t === 'multi') {
    const have: string[] = Array.isArray(v) ? v : []
    return { text: head.join('\n'), rows: [...pairs(spec.opts!.map(([o, l], j) => ({ text: `${have.includes(o) ? '☑️' : '⬜'} ${l}`, data: `s:${id}:m:${j}` }))), back] }
  }
  if (spec.t === 'int') {
    const chips = (spec.presets ?? []).map(p => ({ text: `${p === v ? '◉ ' : ''}${chip(spec, p)}`, data: `s:${id}:n:${p}` }))
    return {
      text: head.join('\n'),
      rows: [...pairs(chips, 3), [{ text: '⌨️ Type a number', data: `s:${id}:c` }, ...(spec.nullable ? [{ text: spec.nullable, data: `s:${id}:x` }] : [])], back],
    }
  }
  if (spec.t === 'time') {
    const presets = spec.id === 'qf' ? ['21:00', '22:00', '23:00', '00:00'] : ['06:00', '07:00', '08:00', '09:00']
    return { text: head.join('\n'), rows: [presets.map(p => ({ text: `${p === v ? '◉ ' : ''}${p}`, data: `s:${id}:h:${p.replace(':', '')}` })), [{ text: '⌨️ Type a time', data: `s:${id}:c` }], back] }
  }
  // list
  const items: string[] = Array.isArray(v) ? v : []
  const list = items.length ? items.map(x => `• ${esc(x)}`).join('\n') : note('Nothing here yet.')
  return {
    text: [heading(spec.emoji, spec.label), esc(spec.what), '', list, ...(msg ? ['', msg] : []), ...(items.length ? ['', note('Tap ✖ to remove one.')] : [])].join('\n'),
    rows: [...pairs(items.map((x, j) => ({ text: `✖ ${short(x, 22)}`, data: `s:${id}:r:${j}` }))), [{ text: '➕ Add', data: `s:${id}:a`, style: 'success' }], back],
  }
}

export const promptFor = (spec: Spec, adding: boolean): Page => ({
  text: [
    heading('⌨️', `${adding ? 'Add to' : 'Change'}: ${spec.label}`), '',
    adding ? 'Send the new item as a message. Several at once? Separate them with commas.'
      : spec.t === 'time' ? 'Send a time like <code>22:30</code>.' : `Send a number${spec.unit ? ` (${spec.unit.replace('/ ', 'out of ')})` : ''}.${spec.path[1] === 'min_salary' ? ' Like <code>95000</code> or <code>95k</code>.' : ''}`,
    ...(spec.example ? ['', note(`For example: ${esc(spec.example)}`)] : []),
  ].join('\n'),
  rows: [[{ text: '✖ Cancel', data: `s:${spec.id}` }]],
})

export function practicePage(s: Settings): Page {
  const on = practiceOn(s)
  const text = [
    heading(on ? '🧪' : '🚀', `Practice mode is ${on ? 'ON' : 'OFF'}`), '',
    'In practice mode I do everything (find jobs, tailor your resume, fill the form, show you the review) except press the final Submit button.',
    'Use it to see how I work before anything real goes out.', '',
    on ? note('Approving an application now records it as a practice run. Nothing is sent.') : '⚠️ <b>Approved applications are really sent to employers.</b>',
    ...(practiceForced() ? ['', note('Locked on: the app was started with --practice.')] : []),
  ].join('\n')
  if (practiceForced()) return { text, rows: [nav('m:settings')] }
  return {
    text,
    rows: [[on ? { text: '🚀 Go live: send real applications', data: 'P:live', style: 'danger' } : { text: '🧪 Turn practice mode back on', data: 'P:on', style: 'success' }], nav('m:settings')],
  }
}

export const goLiveConfirm = (): Page => ({
  text: [
    heading('⚠️', 'Send real applications?'), '',
    'From now on, when you approve an application I submit it to the employer for real. It cannot be taken back.', '',
    '• You still approve each one (unless you turned on auto-apply)',
    '• Every answer and file is shown to you before you approve', '',
    note('You can switch practice mode back on any time.'),
  ].join('\n'),
  rows: [[{ text: '🚀 Yes, go live', data: 'P:yes', style: 'danger' }], [{ text: '🧪 Stay in practice mode', data: 'P:show' }]],
})

// "🏢 Companies I watch": the Greenhouse boards auto-search polls.
export function companiesPage(slugs: string[], msg?: string): Page {
  return {
    text: [
      heading('🏢', 'Companies I watch'),
      'Auto-search checks these companies\' job boards for new openings. I can find more myself ("Find new companies"), or you can add one.', '',
      slugs.length ? slugs.map(x => `• ${esc(x)}`).join('\n') : note('None yet.'),
      ...(msg ? ['', msg] : []),
      '', note('Only Greenhouse job boards are supported for now.'),
    ].join('\n'),
    rows: [...pairs(slugs.slice(0, 40).map(x => ({ text: `✖ ${short(x, 22)}`, data: `C:r:${x}` }))), [{ text: '➕ Add a company', data: 'C:a', style: 'success' }], nav('S:auto')],
  }
}

export const addCompanyPrompt = (): Page => ({
  text: [heading('➕', 'Add a company'), '', 'Send a link to the company\'s Greenhouse job board, or just its board name.', '', note('For example: https://job-boards.greenhouse.io/acme  or  acme')].join('\n'),
  rows: [[{ text: '✖ Cancel', data: 'C:list' }]],
})

// A pasted board link or bare name -> the Greenhouse board slug.
export function boardSlug(text: string): string | null {
  const t = text.trim()
  const m = /greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9][a-z0-9_-]*)/i.exec(t) ?? /[?&]for=([a-z0-9][a-z0-9_-]*)/i.exec(t)
  if (m) return m[1].toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,60}$/i.test(t) ? t.toLowerCase() : null
}
