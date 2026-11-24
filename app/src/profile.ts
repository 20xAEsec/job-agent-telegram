// Read-only views of data/profile.md and data/boards.json, so screens open without starting Python.
// The format is owned by agent/jobagent/profile.py (and boards.py); every write still goes through `jobagent`.
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AnswerRec } from './pages'
import { DATA, readJson } from './state'

const FIELD_RE = /^- (\w+):[ \t]?(.*?)\r?$/
const unesc = (v: string) => v.replace(/\\(n|\\)/g, (_, c) => (c === 'n' ? '\n' : '\\'))

// "## Heading" -> its body lines (profile.split_sections).
export function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const line of text.split('\n')) {
    const m = /^## (?!#)(.*?)\r?$/.exec(line)
    if (m) out.set(m[1].trim(), (cur = []))
    else cur?.push(line)
  }
  return out
}

const fields = (lines: string[]) => Object.fromEntries(lines.map(l => FIELD_RE.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1], m[2]]))

function profileText(): string {
  try { return readFileSync(join(DATA, 'profile.md'), 'utf8') } catch { return '' }
}

export const readSection = (name: string): Record<string, string> => fields(sections(profileText()).get(name) ?? [])

// Saved answers (profile.answer_list): every `### key` block of the "Saved answers" section.
export function readAnswers(includeJob?: string): AnswerRec[] {
  const body = sections(profileText()).get('Saved answers') ?? []
  const blocks: [string, string[]][] = []
  for (const line of body) {
    const m = /^### (.+?)\r?$/.exec(line)
    if (m) blocks.push([m[1].trim(), []])
    else blocks.at(-1)?.[1].push(line)
  }
  return blocks.map(([key, lines]) => {
    const f = fields(lines), scope = f.scope === 'job' ? 'job' : 'global'
    return {
      key, base_key: scope === 'job' && key.includes('__') ? key.split('__').slice(1).join('__') : key,
      question: unesc(f.question ?? ''), answer: unesc(f.answer ?? ''), sensitive: f.sensitive === 'true',
      scope, job: scope === 'job' ? f.source_job ?? '' : '', updated: f.updated ?? '',
    } as AnswerRec
  }).filter(a => a.scope === 'global' || (includeJob && a.job === includeJob))
}

// Watched company boards, per ATS (boards.load_boards).
export const readBoards = (): Record<string, string[]> => {
  const b = readJson<Record<string, unknown>>(join(DATA, 'boards.json'), {})
  return Object.fromEntries(Object.entries(b).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]))
}
export const boardCount = () => Object.values(readBoards()).reduce((n, l) => n + l.length, 0)
