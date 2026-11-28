// Application kit: for a form JobAgent cannot fill, everything the user needs to apply by hand in a few minutes
// (tailored files, drafted answers to copy, the link) and a one-tap "I applied". It never submits anything.
import { existsSync } from 'fs'
import { join } from 'path'
import { code, jobDir, jobTitle, type Job } from './jobs'
import { esc, heading, note, short, type Btn, type Page } from './kit'
import { readJson } from './state'

export type KitAnswer = { question: string; answer: string }
export const KIT_FILES = ['resume.pdf', 'cover_letter.pdf']

// kit.json is written by Claude from the profile and analysis: shape and size are checked here, values are escaped on render.
export function readKit(id: string): { answers: KitAnswer[]; files: string[] } {
  const k = readJson<{ answers?: unknown }>(join(jobDir(id), 'kit.json'), {})
  const answers = (Array.isArray(k.answers) ? k.answers : [])
    .filter((a): a is KitAnswer => !!a && typeof a.question === 'string' && typeof a.answer === 'string' && !!a.answer.trim())
    .slice(0, 8).map(a => ({ question: short(a.question.trim(), 200), answer: short(a.answer.trim(), 1200) }))
  return { answers, files: KIT_FILES.filter(f => existsSync(join(jobDir(id), f))) }
}

// Tap-to-copy: one line in <code>, several lines in <pre>.
const copyable = (s: string) => (s.includes('\n') ? `<pre>${esc(s)}</pre>` : `<code>${esc(s)}</code>`)

export function kitPage(j: Job, kit: ReturnType<typeof readKit>): Page {
  const c = code(j.id)
  const steps = [
    j.url ? '1️⃣ Open the posting (button below).' : '1️⃣ Open the posting.',
    kit.files.length ? `2️⃣ Upload ${kit.files.includes('cover_letter.pdf') ? 'the resume and cover letter' : 'the resume'} I sent just above.` : '2️⃣ Upload your resume.',
    kit.answers.length ? '3️⃣ Copy my drafted answers (tap one to copy it).' : '3️⃣ Fill in the form.',
    '4️⃣ Come back and tap <b>I applied</b>, so I can track it.',
  ]
  let budget = 3500
  const answers: string[] = []
  for (const a of kit.answers) {
    const block = `<b>${esc(a.question)}</b>\n${copyable(a.answer)}`
    if (budget - block.length < 0) { answers.push(note('…more answers did not fit here.')); break }
    budget -= block.length
    answers.push(block)
  }
  const rows: Btn[][] = [
    [{ text: '✅ I applied', data: `j:ap:${c}`, style: 'success' }, { text: '⏭ Skip it', data: `j:sk:${c}` }],
    ...(j.url ? [[{ text: '🔗 Open the posting', url: j.url }]] : []),
    [{ text: '📋 Jobs', data: 'J:a:0' }, { text: '🏠 Home', data: 'm:home' }],
  ]
  return {
    text: [
      heading('🧰', `Apply yourself · ${esc(short(jobTitle(j), 60))}`),
      [j.score != null && `📊 Match ${j.score}/100`, j.location && `📍 ${esc(j.location)}`, j.salary && `💵 ${esc(j.salary)}`].filter(Boolean).join('  ·  '),
      note("I can't fill this kind of application form, so I prepared everything for you."),
      '', ...steps,
      ...(answers.length ? ['', ...answers] : []),
      '', note('Private answers (work authorization, salary…) are not drafted: answer those on the site.'),
    ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n'),
    rows,
  }
}

// "Open filled form": a browser window on the user's computer with the application typed in. They send it themselves.
export function handoffPage(j: Job, practice: boolean): Page {
  return {
    text: [
      heading('🖥', `Look at your computer · ${esc(short(jobTitle(j), 60))}`),
      'A browser window is opening with the application filled in.',
      '1️⃣ Do the "are you a human" check.', '2️⃣ Look over every answer.', '3️⃣ Press Submit, and leave the window open until you see the confirmation.',
      ...(practice ? ['', '⚠️ <b>Pressing Submit there really sends it</b>, even in practice mode.'] : []),
    ].join('\n'),
    rows: j.url ? [[{ text: '🔗 Open the posting', url: j.url }]] : [],
  }
}
export function handoffDonePage(j: Job, r: { ok?: boolean; code?: string; submitted?: boolean; unfilled?: unknown }): Page {
  const c = code(j.id), name = esc(short(jobTitle(j), 60))
  if (r.ok && r.submitted) return { text: `${heading('✅', 'Application sent')}\n${name}\n${note('I saw the confirmation page and marked it as applied.')}`, rows: [[{ text: '📋 Jobs', data: 'J:a:0' }, { text: '🏠 Home', data: 'm:home' }]] }
  const unfilled = Array.isArray(r.unfilled) ? r.unfilled.slice(0, 8).map(x => `• ${esc(short(String(x), 80))}`) : []
  const why = r.ok ? "I didn't see a confirmation page. If you sent it, tap I applied."
    : r.code === 'busy' ? 'Another JobAgent browser window is open. Close it and try again.' : "I couldn't fill the form in this time. Try again, or apply from the posting."
  return {
    text: [heading('🖥', r.ok ? 'Window closed' : "Couldn't open it"), name, note(why), ...(unfilled.length ? ['', 'I could not fill these:', ...unfilled] : [])].join('\n'),
    rows: [[{ text: '✅ I applied', data: `j:ap:${c}`, style: 'success' }, { text: '🖥 Open again', data: `j:of:${c}` }], ...(j.url ? [[{ text: '🔗 Open the posting', url: j.url }]] : [])],
  }
}
