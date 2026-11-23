// Self-repair, app side: the card that shows a prepared fix, and the Approve / Not now buttons.
// This module (with `jobagent repair publish`) is the only way a fix leaves this computer, and only after Approve:
// Claude cannot write approved.json (see .claude/settings.json), and publish checks it against the exact fix.
import { join } from 'path'
import { esc, heading, note, quote, short, type Btn, type Page } from './kit'
import { DATA, readJson, writeJson } from './state'

export const FIX_BUTTON: Btn = { text: '🔧 Let Claude look into this', data: 'fix:go' }
export const FIX_ID = /^fix:(ok|no):([\w-]{1,40})$/

export type Proposal = { title: string; summary: string; body: string; files: string[]; added: number; removed: number; login: string; hash: string }

const dir = (id: string) => join(DATA, 'repair', id)
export const readProposal = (id: string) => readJson<Proposal | null>(join(dir(id), 'proposal.json'), null)
export const approve = (id: string, p: Proposal) => writeJson(join(dir(id), 'approved.json'), { hash: p.hash })

export function proposalPage(id: string, p: Proposal): Page {
  const n = p.files.length
  return {
    text: [
      heading('🔧', 'A fix is ready to share'), '',
      esc(p.summary), '',
      note(`${n} file${n === 1 ? '' : 's'} changed (+${p.added} −${p.removed}). The tests pass.`), '',
      `If you approve, I'll open a pull request on GitHub as <b>${esc(p.login)}</b> with this title and text:`,
      quote(`<b>${esc(p.title)}</b>\n\n${esc(short(p.body, 1200))}`, true), '',
      note('Your profile, answers and job details are not included. Nothing is shared unless you tap the button.'),
    ].join('\n'),
    rows: [[{ text: '✅ Open the pull request', data: `fix:ok:${id}`, style: 'success' }, { text: '⏭ Not now', data: `fix:no:${id}` }]],
  }
}

export const sharedPage = (url: string): Page => ({
  text: `${heading('✅', 'Shared, thank you')}\n${note('The maintainers will take a look. Your copy gets the fix when they release it.')}`,
  rows: [[{ text: '🔗 Open the pull request', url }]],
})

export const failedPage = (id: string, why: string): Page => ({
  text: `${heading('⚠️', "I couldn't share the fix")}\n${esc(why)}\n\n${note('You can try again or drop it.')}`,
  rows: [[{ text: '🔄 Try again', data: `fix:ok:${id}` }, { text: '⏭ Not now', data: `fix:no:${id}` }]],
})

export const discardedPage = (): Page => ({
  text: `${heading('⏭', 'Not shared')}\n${note('I threw the fix away. Nothing was sent.')}`,
  rows: [],
})
