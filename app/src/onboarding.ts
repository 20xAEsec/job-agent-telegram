// First-run setup wizard: one message, edited in place, five short sections. Deterministic (no Claude),
// except reading the resume. Renderers are pure; bot.ts does the saving.
import { join } from 'path'
import { esc, heading, label, money, nav, note, pairs, quote, short, stepLine, type Btn, type Page } from './kit'
import { DATA, readJson, writeJson, type Settings } from './state'

export type Summary = {
  name: string; headline: string; years: number | null; level: string; location: string; country: string
  email: string; phone: string; skills: string[]; suggested_titles: string[]
}
export type ObStep =
  | 'welcome' | 'resume' | 'reading' | 'profile' | 'fix'
  | 'titles' | 'level' | 'locations' | 'remote' | 'salary'
  | 'auth' | 'sponsor' | 'start' | 'relocate'
  | 'eeo' | 'eeo_gender' | 'eeo_race' | 'eeo_veteran' | 'eeo_disability' | 'done'
export type Ob = {
  step: ObStep; msg?: number; summary?: Summary; country?: string; picks: string[]; locs: string[]
  doing?: string | null; error?: string; render_warning?: string; replace?: boolean
}

const FILE = join(DATA, 'onboarding.json')
export const loadOb = (): Ob => ({ step: 'welcome', picks: [], locs: [], ...readJson<Partial<Ob>>(FILE, {}) })
export const saveOb = (o: Ob) => writeJson(FILE, o)

const SECTION: Partial<Record<ObStep, [number, string]>> = {
  resume: [1, 'Your resume'], reading: [1, 'Your resume'], profile: [1, 'Your resume'], fix: [1, 'Your resume'],
  titles: [2, 'The roles you want'], level: [2, 'The roles you want'],
  locations: [3, 'Location and pay'], remote: [3, 'Location and pay'], salary: [3, 'Location and pay'],
  auth: [4, 'Work eligibility'], sponsor: [4, 'Work eligibility'], start: [4, 'Work eligibility'], relocate: [4, 'Work eligibility'],
  eeo: [5, 'Optional questions'], eeo_gender: [5, 'Optional questions'], eeo_race: [5, 'Optional questions'], eeo_veteran: [5, 'Optional questions'], eeo_disability: [5, 'Optional questions'],
}
const top = (s: ObStep) => (SECTION[s] ? stepLine(SECTION[s]![0], 5, SECTION[s]![1]) + '\n\n' : '')
const back = (to: ObStep): Btn => ({ text: '← Back', data: `o:go:${to}` })

export const DECLINE = 'Decline to self-identify'
// [short button label, the answer saved]
export const EEO: Record<'eeo_gender' | 'eeo_race' | 'eeo_veteran' | 'eeo_disability', { key: string; q: string; opts: [string, string][] }> = {
  eeo_gender: { key: 'eeo_gender', q: 'Gender', opts: [['Woman', 'Female'], ['Man', 'Male'], ['Non-binary', 'Non-binary'], ['Prefer not to say', DECLINE]] },
  eeo_race: {
    key: 'eeo_race', q: 'Race / ethnicity', opts: [
      ['Asian', 'Asian'], ['Black or African American', 'Black or African American'], ['Hispanic or Latino', 'Hispanic or Latino'], ['White', 'White'],
      ['American Indian or Alaska Native', 'American Indian or Alaska Native'], ['Native Hawaiian or Pacific Islander', 'Native Hawaiian or Other Pacific Islander'],
      ['Two or more races', 'Two or More Races'], ['Prefer not to say', DECLINE],
    ],
  },
  eeo_veteran: { key: 'eeo_veteran', q: 'Veteran status', opts: [['Not a protected veteran', 'I am not a protected veteran'], ['Protected veteran', 'I identify as one or more of the classifications of protected veteran'], ['Prefer not to say', DECLINE]] },
  eeo_disability: { key: 'eeo_disability', q: 'Disability status', opts: [['No disability', "No, I don't have a disability"], ['Yes, I have one', 'Yes, I have a disability (or previously had a disability)'], ['Prefer not to say', DECLINE]] },
}
export const EEO_ORDER = ['eeo_gender', 'eeo_race', 'eeo_veteran', 'eeo_disability'] as const

// Suggestions first, then what the user added, so chips never jump around when tapped.
export const titlePool = (o: Ob) => [...new Set([...(o.summary?.suggested_titles ?? []), ...o.picks])].slice(0, 10)
export const locPool = (o: Ob) => [...new Set([o.summary?.location, o.summary?.country, ...o.locs].filter((x): x is string => !!x))].slice(0, 8)

export const START_OPTS = ['Immediately', '2 weeks', '1 month']
export const keyFor = (country: string) => `work_auth_${country.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'home'}`

export const PROFILE_FIELDS: [key: string, label: string][] = [
  ['full_name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['linkedin', 'LinkedIn'], ['portfolio', 'Website'],
]

export function obPage(o: Ob, s: Settings, fields: Record<string, string> = {}): Page {
  const step = o.step
  const t = (lines: string[], rows: Btn[][]): Page => ({ text: top(step) + lines.join('\n'), rows })
  const sum = o.summary
  switch (step) {
    case 'welcome':
      return {
        text: [
          heading('👋', 'Welcome to JobAgent'), '',
          'I find jobs that fit you, tailor your resume for each one, fill in the application, and show it all to you <b>before anything is sent</b>.', '',
          '<b>Setup takes about 3 minutes:</b>',
          '① Your resume', '② The roles you want', '③ Location and pay', '④ Work eligibility', '⑤ Optional questions', '',
          `🧪 ${note('Practice mode is on: nothing is ever sent until you decide to go live.')}`,
        ].join('\n'),
        rows: [[{ text: "🚀 Let's start", data: 'o:go:resume', style: 'success' }]],
      }
    case 'resume':
      return t([
        heading('📄', 'Send me your resume'), '',
        'Send it as a <b>PDF</b> or <b>Word (.docx)</b> file: tap 📎 below and pick the file.', '',
        'I use it to fill in your profile, and as the starting point for every tailored version. Your original is never changed.',
        ...(o.error ? ['', `❌ ${esc(o.error)}`] : []),
        '', note('No resume handy? On LinkedIn, open your profile → More → Save to PDF, then send me that.'),
      ], [])
    case 'reading':
      return t([
        heading('📖', 'Reading your resume…'), '',
        'This takes about a minute.',
        ...(o.doing ? ['', `↳ ${note(esc(o.doing))}`] : []),
      ], [])
    case 'profile': {
      const f = { full_name: sum?.name ?? '', email: sum?.email ?? '', phone: sum?.phone ?? '', location: sum?.location ?? '', ...fields }
      return t([
        heading('✅', 'Here is what I found'), '',
        `<b>${esc(f.full_name || 'Name not found')}</b>`,
        esc([sum?.headline, sum?.years != null ? `${sum.years} years` : ''].filter(Boolean).join(' · ') || ''),
        '',
        `📧 ${esc(f.email || '—')}`, `📞 ${esc(f.phone || '—')}`, `📍 ${esc(f.location || '—')}`,
        ...(sum?.skills.length ? [`🛠 ${esc(short(sum.skills.slice(0, 8).join(', '), 120))}`] : []),
        ...(o.render_warning ? ['', `⚠️ ${esc(o.render_warning)}`] : []),
        '', 'Does this look right?',
      ], [[{ text: '✅ Looks right', data: 'o:ok', style: 'success' }, { text: '✏️ Fix something', data: 'o:go:fix' }], [{ text: '📄 Use a different file', data: 'o:go:resume' }]])
    }
    case 'fix':
      return t([heading('✏️', 'What should I fix?'), '', note('Tap a field, then send the right value.')],
        [...pairs(PROFILE_FIELDS.map(([k, l]) => ({ text: l, data: `o:f:${k}` })), 3), [back('profile')]])
    case 'titles': {
      const pool = titlePool(o)
      return t([
        heading('🎯', 'Which job titles should I look for?'), '',
        pool.length ? 'Tap to select. I suggested some from your resume.' : 'Tap ➕ and send one or more titles.',
        ...(o.picks.length ? ['', `<b>Selected:</b> ${esc(o.picks.join(', '))}`] : []),
        '', note('I also match close variations, like "Senior" or "II" versions.'),
      ], [
        ...pairs(pool.map((x, i) => ({ text: `${o.picks.includes(x) ? '☑️' : '⬜'} ${short(x, 28)}`, data: `o:t:${i}` }))),
        [{ text: '➕ Add a title', data: 'o:add:title' }],
        [back('profile'), { text: 'Next →', data: 'o:next:titles', style: 'success' }],
      ])
    }
    case 'level':
      return t([heading('📶', 'What level are you aiming for?'), '', note('Jobs far above or below this get a lower match score.')], [
        ...pairs(['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director'].map(v => ({ text: `${s.filters.experience_level === v ? '◉ ' : ''}${label(v)}`, data: `o:lv:${v}` }))),
        [back('titles')],
      ])
    case 'locations': {
      const sug = locPool(o)
      return t([
        heading('📍', 'Where would you like to work?'), '',
        'Cities, regions or countries for on-site or hybrid jobs. You choose about remote jobs next.',
        ...(o.locs.length ? ['', `<b>Selected:</b> ${esc(o.locs.join(', '))}`] : []),
      ], [
        ...pairs(sug.map((x, i) => ({ text: `${o.locs.includes(x) ? '☑️' : '⬜'} ${short(x, 28)}`, data: `o:l:${i}` }))),
        [{ text: '➕ Add a place', data: 'o:add:loc' }],
        [back('level'), { text: 'Next →', data: 'o:next:locations', style: 'success' }],
      ])
    }
    case 'remote':
      return t([heading('🏡', 'Remote, hybrid or on-site?')], [
        ...([['remote_or_hybrid', 'Remote, or hybrid / on-site nearby'], ['remote_only', 'Remote only'], ['any', 'Anything'], ['onsite_only', 'On-site only']] as const)
          .map(([v, l]) => [{ text: `${s.filters.remote === v ? '◉ ' : ''}${l}`, data: `o:rm:${v}` }]),
        [back('locations')],
      ])
    case 'salary': {
      const cur = s.filters.currency, base = cur === 'INR' ? [500000, 1000000, 2000000, 3000000] : [50000, 75000, 100000, 125000, 150000, 200000]
      return t([
        heading('💵', "What's the lowest yearly salary you'd accept?"), '',
        'Jobs that post a lower range are skipped. Many jobs don\'t list pay; those are kept.', '',
        `🔒 ${note('Private: stored on your computer only.')}`,
      ], [
        ...pairs(base.map(v => ({ text: `${s.filters.min_salary === v ? '◉ ' : ''}${money(v, cur)}`, data: `o:sa:${v}` })), 3),
        [{ text: '⌨️ Type an amount', data: 'o:add:salary' }, { text: `💱 ${cur}`, data: 'o:cur' }],
        [back('remote'), { text: 'No minimum →', data: 'o:sa:0' }],
      ])
    }
    case 'auth': {
      const c = o.country || sum?.country || 'your country'
      return t([
        heading('🛂', `Are you legally allowed to work in ${esc(c)}?`), '',
        'Applications almost always ask this. I never guess it, so I need it from you once.', '',
        `🔒 ${note('Private: stored on your computer only.')}`,
      ], [
        [{ text: 'Yes', data: 'o:au:yes', style: 'success' }, { text: 'No', data: 'o:au:no' }],
        [{ text: '🌍 A different country', data: 'o:add:country' }],
        [back('salary')],
      ])
    }
    case 'sponsor':
      return t([heading('📑', `Will you now or in the future need visa sponsorship to work in ${esc(o.country || sum?.country || 'that country')}?`), '', `🔒 ${note('Private: stored on your computer only.')}`], [
        [{ text: 'No', data: 'o:sp:No' }, { text: 'Yes', data: 'o:sp:Yes' }], [back('auth')],
      ])
    case 'start':
      return t([heading('🗓', 'When could you start a new job?')], [
        START_OPTS.map(v => ({ text: v, data: `o:st:${v}` })), [{ text: '⌨️ Something else', data: 'o:add:start' }], [back('sponsor')],
      ])
    case 'relocate':
      return t([heading('🧳', 'Open to relocating for the right job?'), '', `🔒 ${note('Private: stored on your computer only.')}`], [
        [{ text: 'Yes', data: 'o:rl:Yes' }, { text: 'No', data: 'o:rl:No' }], [back('start')],
      ])
    case 'eeo':
      return t([
        heading('📋', 'Optional diversity questions'), '',
        'Many applications (especially in the US) ask voluntary questions about gender, race/ethnicity, veteran status and disability. They are optional and do not affect your application.', '',
        '<b>How should I handle them?</b>',
      ], [
        [{ text: '🙈 Always "Prefer not to say"', data: 'o:eo:decline' }],
        [{ text: '✍️ Answer them now (4 quick taps)', data: 'o:eo:answer' }],
        [{ text: '❓ Ask me each time', data: 'o:eo:ask' }],
        [back('relocate')],
      ])
    case 'eeo_gender': case 'eeo_race': case 'eeo_veteran': case 'eeo_disability': {
      const e = EEO[step], i = EEO_ORDER.indexOf(step)
      return t([heading('📋', `${e.q}`), note(`Question ${i + 1} of 4 · optional`)], [
        ...e.opts.map(([l], j) => [{ text: l, data: `o:e:${step}:${j}` }]),
        [back(i ? EEO_ORDER[i - 1] : 'eeo')],
      ])
    }
    case 'done':
      return {
        text: [
          heading('🎉', "You're all set"), '',
          '<b>How it works</b>',
          '1️⃣ Send me a link to a job posting, or turn on <b>Auto-search</b> and I\'ll find jobs myself.',
          '2️⃣ I read it, score the fit, tailor your resume and fill in the form. You can watch each step live.',
          '3️⃣ You get a review with every answer and file. <b>Nothing is sent until you approve.</b>', '',
          quote(`🎯 ${esc(short(s.filters.titles.join(', '), 80))}\n📍 ${esc(short(s.filters.locations.join(', ') || 'Anywhere', 60))} · ${label(s.filters.remote)}${s.filters.min_salary ? `\n💵 ${money(s.filters.min_salary, s.filters.currency)}+ per year` : ''}`),
          `🧪 ${note('Practice mode is on: approving runs a practice application. Turn it off in Settings when you are ready.')}`,
          ...(s.filters.titles.length ? ['', `🔎 <b>I'm running your first search now.</b> ${note('The best few matches get prepared for you; watch the card below.')}`] : []),
        ].join('\n'),
        rows: [[{ text: '🔭 Turn on Auto-search', data: 'o:auto', style: 'success' }], [{ text: '🏠 Go to Home', data: 'm:home' }]],
      }
  }
  return { text: 'Setup', rows: [nav()] }
}

export const obPrompt = (what: 'title' | 'loc' | 'salary' | 'country' | 'start' | string, fieldLabel?: string): Page => {
  const m: Record<string, [string, string]> = {
    title: ['🎯 Add a job title', 'Send a job title. Several? Separate them with commas.\n\n' + note('For example: Data Analyst, Analytics Engineer')],
    loc: ['📍 Add a place', 'Send a city, region or country. Several? Separate them with commas.\n\n' + note('For example: Austin, TX or Germany')],
    salary: ['💵 Minimum salary', 'Send a yearly amount, like <code>95000</code> or <code>95k</code>.'],
    country: ['🌍 Which country?', 'Send the country you want to work in, for example <code>Canada</code>.'],
    start: ['🗓 When could you start?', 'Send it in your own words, for example <code>after March 1</code> or <code>3 weeks</code>.'],
  }
  const [h, body] = m[what] ?? [`✏️ ${fieldLabel ?? 'Fix'}`, `Send the correct ${esc((fieldLabel ?? 'value').toLowerCase())}.`]
  return { text: `<b>${h}</b>\n\n${body}`, rows: [[{ text: '✖ Cancel', data: 'o:cancel' }]] }
}
