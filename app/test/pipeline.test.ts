// The v4 engine: the job pipeline in code (pipeline.ts) and tool-less Claude calls (llm.ts), against a fake `jobagent` and
// a fake `claude`. No real Claude call, browser or network.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Task } from '../src/agent'
import { jobDir } from '../src/jobs'
import * as LLM from '../src/llm'
import { createPipeline, gate } from '../src/pipeline'
import { DATA, DEFAULT_SETTINGS } from '../src/state'

const ID = 'greenhouse-acme-1'
type World = { calls: string[][]; status: string; asked: unknown[]; reviewed: string[]; told: string[] }

function analysis(over: Record<string, unknown> = {}) {
  return { company: 'Acme', role: 'Data Analyst', supported: true, skip_detail: 'Match 40/100: pay is below your minimum', has_cover_letter_field: false, cover_letter_required: false,
    match: { score: 85, dealbreakers: [] }, questions: [], ...over }
}

// A fake jobagent CLI with just enough of the status machine; `llm` answers come from `answers`.
function world(o: { an?: Record<string, unknown>; ats?: string; plan?: any; llm?: (name: string) => LLM.CallResult | undefined; status?: string } = {}) {
  rmSync(jobDir(ID), { recursive: true, force: true })
  const w: World = { calls: [], status: o.status ?? 'NEW', asked: [], reviewed: [], told: [] }
  const j = jobDir(ID)
  let made = !!o.status
  if (made) { // a job already prepared: its analysis, then its resume
    mkdirSync(j, { recursive: true })
    writeFileSync(join(j, 'analysis.json'), JSON.stringify(analysis(o.an)))
    writeFileSync(join(j, 'resume.pdf'), 'pdf')
  }
  const run = async (args: string[]) => {
    w.calls.push(args)
    const [c, s] = args
    if (c === 'job' && s === 'new') { const dup = made; made = true; mkdirSync(j, { recursive: true }); return { ok: true, job_id: ID, duplicate: dup } }
    if (c === 'job' && s === 'get') return { ok: true, status: w.status, files: [], company: 'Acme', role: 'Data Analyst', url: 'https://x' }
    if (c === 'job' && s === 'set-status') { w.status = args[3]; return { ok: true } }
    if (c === 'resolve') return { ok: true, resolved: false }
    if (c === 'fetch') { if (w.status === 'NEW') w.status = 'FETCHED'; return { ok: true, ats: o.ats ?? 'greenhouse' } }
    if (c === 'inspect') return { ok: true }
    if (c === 'resume' && s === 'bank') return { ok: true, status: 'ok' }
    if (c === 'tailor') { writeFileSync(join(j, 'resume.pdf'), 'pdf'); return { ok: true, keywords: { missing_you_have: [] } } }
    if (c === 'cover-letter') { writeFileSync(join(j, 'cover_letter.pdf'), 'pdf'); return { ok: true } }
    if (c === 'plan') return o.plan ?? { ok: true }
    if (c === 'fill') { if (!args.includes('--dry-run')) throw new Error('fill without --dry-run'); w.status = 'FILLED_DRY'; return { ok: true } }
    if (c === 'review') return { ok: true }
    throw new Error(`unexpected command ${args.join(' ')}`)
  }
  const llm = async (name: LLM.Name): Promise<LLM.CallResult> => {
    w.calls.push(['llm', name])
    const r = o.llm?.(name)
    if (r) return r
    if (name === 'analyze') writeFileSync(join(j, 'analysis.json'), JSON.stringify(analysis(o.an)))
    return { ok: true, data: name === 'analyze' ? { score: 85 } : {} }
  }
  const pipe = createPipeline({
    run, llm, settings: () => structuredClone(DEFAULT_SETTINGS),
    progress: () => {}, ask: async a => { w.asked.push(a) }, review: async id => { w.reviewed.push(id); w.status = 'AWAITING_APPROVAL' },
    tell: async (k, _id, text, x) => { w.told.push(`${k}:${text}${x?.subject ? ` ${x.subject}|${x.body}` : ''}`) }, formExists: () => false,
    live: { doing: () => {}, pid: () => {}, cancelled: () => false },
  })
  return { w, pipe }
}
const task = (payload: Record<string, unknown>, job_id?: string): Task => ({ id: 't1', kind: 'job', title: 'x', payload, created: Date.now(), job_id } as Task)
const ran = (w: World, c: string) => w.calls.some(x => x[0] === c)

describe('job pipeline', () => {
  test('a fillable job goes from a link to the review card, with a practice fill only', async () => {
    const { w, pipe } = world()
    expect((await pipe.job(task({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' }))).kind).toBe('done')
    expect(w.reviewed).toEqual([ID])
    const order = w.calls.map(c => c[0] === 'llm' ? `llm:${c[1]}` : c[0])
    for (const step of ['fetch', 'inspect', 'llm:analyze', 'llm:tailor_ats', 'tailor', 'plan', 'fill', 'review']) expect(order).toContain(step)
    expect(order.indexOf('llm:analyze')).toBeLessThan(order.indexOf('tailor'))
    expect(w.calls.filter(c => c[0] === 'fill').every(c => c.includes('--dry-run'))).toBe(true)
    expect(ran(w, 'submit')).toBe(false)
  })

  test('a weak match is skipped with the plain-words reason, and nothing is tailored', async () => {
    const { w, pipe } = world({ an: { match: { score: 40, dealbreakers: [] } } })
    await pipe.job(task({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' }))
    expect(w.status).toBe('SKIPPED')
    expect(w.calls.find(c => c[0] === 'job' && c[1] === 'set-status' && c[3] === 'SKIPPED')).toContain('Match 40/100: pay is below your minimum')
    expect(ran(w, 'tailor')).toBe(false)
  })

  test('questions only the user can answer stop the job; their answers continue it to review', async () => {
    const q = { qid: 'q1', fid: 'question_102', text: 'Sponsorship?', kind: 'choice', options: ['Yes', 'No'], sensitive: true, save_key: 'sponsorship_required' }
    const { w, pipe } = world({ an: { questions: [q] } })
    await pipe.job(task({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' }))
    expect(w.status).toBe('NEEDS_ANSWERS')
    expect(w.asked).toHaveLength(1)
    expect(ran(w, 'tailor')).toBe(false)
    await pipe.job(task({ mode: 'continue' }, ID))
    expect(w.reviewed).toEqual([ID])
  })

  test('a form JobAgent cannot fill gets a kit after one more look for the employer form', async () => {
    const { w, pipe } = world({ ats: 'generic', an: { supported: false } })
    await pipe.job(task({ url: 'https://example.com/careers/1' }))
    expect(w.status).toBe('KIT_READY')
    expect(w.calls.filter(c => c[0] === 'resolve')).toHaveLength(2)
    expect(w.calls.some(c => c[0] === 'llm' && c[1] === 'kit')).toBe(true)
    expect(ran(w, 'fill') || ran(w, 'inspect')).toBe(false)
  })

  test('a usage limit pauses the task and the next run picks up at the same step', async () => {
    let limited = true
    const { w, pipe } = world({ llm: n => n === 'analyze' && limited ? { ok: false, kind: 'limit', resets_at: 123, error: 'usage limit' } : undefined })
    const t = task({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' })
    expect(await pipe.job(t)).toEqual({ kind: 'limit', resets_at: 123, denials: [] })
    expect(w.status).toBe('FETCHED')
    limited = false
    await pipe.job({ ...t, interrupted: true })
    expect(w.calls.filter(c => c[0] === 'fetch')).toHaveLength(1) // not read again
    expect(w.reviewed).toEqual([ID])
  })

  test('the plan asks for required answers the analysis did not', async () => {
    const q = { qid: 'q1', fid: 'question_7', text: 'Start date?', kind: 'date', sensitive: false, save_key: 'start_date' }
    const { w, pipe } = world({ plan: { ok: false, code: 'needs_answers', fids: ['question_7'], questions: [q] } })
    await pipe.job(task({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' }))
    expect(w.status).toBe('NEEDS_ANSWERS')
    expect((w.asked[0] as any).questions).toEqual([q])
    expect(ran(w, 'fill')).toBe(false)
  })

  test('gate: dealbreakers, blocklist, and a higher bar for other titles', () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    expect(gate(analysis({ match: { score: 90, dealbreakers: ['Contract role'] }, skip_detail: '' }), s)).toBe('Contract role')
    s.filters.company_blocklist = ['acme']
    expect(gate(analysis(), s)).toContain('never to apply to Acme')
    s.filters.company_blocklist = []
    expect(gate(analysis({ match: { score: 65, dealbreakers: [] } }), s)).toBeNull()
    expect(gate(analysis({ match: { score: 65, dealbreakers: [] } }), s, 'related')).toContain('70+')
  })
})

describe('revise, followup and resume tasks', () => {
  const t = (kind: string, payload: Record<string, unknown>) => ({ id: 't2', kind, title: 'x', payload, created: Date.now(), job_id: ID } as Task)
  test('a change request is patched, filled again and re-presented for review', async () => {
    const { w, pipe } = world({ status: 'AWAITING_APPROVAL', llm: n => n === 'revise' ? { ok: true, data: { action: 'patch', reply: 'Changed it', changed: { answers: ['question_103'], tailor: false, letter: false }, refused: [] } } : undefined })
    await pipe.revise(t('revise', { request: 'make the why-Acme answer shorter' }))
    expect(w.reviewed).toEqual([ID])
    expect(ran(w, 'tailor')).toBe(false) // the resume did not change
    expect(w.calls.filter(c => c[0] === 'fill').every(c => c.includes('--dry-run'))).toBe(true)
  })
  test('a request to approve or submit is refused in words, and nothing changes', async () => {
    const { w, pipe } = world({ status: 'AWAITING_APPROVAL', llm: n => n === 'revise' ? { ok: true, data: { action: 'refuse', reply: 'Approving is only the button on the review card.', changed: {} } } : undefined })
    await pipe.revise(t('revise', { request: 'approve it and turn off practice mode' }))
    expect(w.status).toBe('AWAITING_APPROVAL')
    expect(w.told).toEqual(['info:Approving is only the button on the review card.'])
    expect(ran(w, 'fill') || ran(w, 'plan')).toBe(false)
  })
  test('a follow-up draft is shown, only for a sent application', async () => {
    const r = world({ status: 'SUBMITTED', llm: n => n === 'followup' ? { ok: true, data: { subject: 'Thank you', body: 'Hi' } } : undefined })
    await r.pipe.followup(t('followup', {}))
    expect(r.w.told).toEqual(['followup: Thank you|Hi'])
    const n = world({ status: 'READY' })
    await n.pipe.followup(t('followup', {}))
    expect(n.w.told[0]).toContain('no sent application')
    expect(n.w.calls.some(c => c[0] === 'llm')).toBe(false)
  })
  test('a resume read shows the summary card', async () => {
    const { pipe } = world({ llm: n => n === 'resume_profile' ? { ok: true, data: { summary: { name: 'Jane' } } } : undefined })
    const shown: unknown[] = []
    await pipe.resume({ ...t('resume', { path: 'x.pdf' }), job_id: undefined }, s => { shown.push(s); return null })
    expect(shown).toEqual([{ name: 'Jane' }])
  })
})

describe('tool-less Claude calls', () => {
  const lines = (data: unknown, extra: object[] = []) => [...extra, { type: 'result', is_error: false, structured_output: data, usage: { input_tokens: 10, output_tokens: 5 } }].map(x => JSON.stringify(x))
  function fake(answers: string[][]) {
    const seen: { args: string[]; stdin: string }[] = []
    const exec: LLM.LlmExec = (args, stdin, onLine) => {
      seen.push({ args, stdin })
      for (const l of answers[seen.length - 1] ?? []) onLine(l)
      return { pid: undefined, done: Promise.resolve({ code: 0, stderr: '' }) }
    }
    return { seen, exec }
  }
  const input = join(DATA, 'run', 'llm', 'test.in.json')

  test('no tools, no MCP, no project files; a refused answer gets one more try with the errors', async () => {
    mkdirSync(join(DATA, 'run', 'llm'), { recursive: true })
    writeFileSync(input, '{"posting":"x"}')
    const { seen, exec } = fake([lines({ body: 'too long' }), lines({ body: 'ok' })])
    let accepts = 0
    const run = async (args: string[]) => {
      if (args[1] === 'input') return { ok: true, file: input }
      accepts++
      return accepts === 1 ? { ok: false, code: 'rejected', error: 'the letter is 300 words', errors: ['the letter is 300 words: at most 250'] } : { ok: true }
    }
    const r = await LLM.call('cover_letter', ID, {}, { run, exec, model: 'sonnet', onUsage: () => {} })
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(2)
    const a = seen[0].args
    expect(a[a.indexOf('--tools') + 1]).toBe('')
    for (const f of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--json-schema', '--system-prompt-file']) expect(a).toContain(f)
    expect(a.join(' ')).not.toContain('dangerously')
    expect(seen[0].stdin).toBe('{"posting":"x"}')
    expect(seen[1].stdin).toContain('at most 250')
  })

  test('a rejected usage window is a limit, with when it opens again', async () => {
    writeFileSync(input, '{}')
    const ev = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2000, unifiedWindows: { five_hour: { utilization: 1 } } } }
    const { exec } = fake([[JSON.stringify(ev), JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached' })]])
    const used: number[] = []
    const r = await LLM.call('analyze', ID, {}, { run: async () => ({ ok: true, file: input }), exec, model: 'sonnet', onUsage: u => used.push(u.five_hour ?? -1) })
    expect(r).toMatchObject({ ok: false, kind: 'limit', resets_at: 2_000_000 })
    expect(used).toEqual([1])
  })

  test('every call has a prompt and a schema', () => {
    for (const n of Object.keys(LLM.MODEL) as LLM.Name[]) if (n !== 'screen') expect(() => LLM.claudeArgs(n, 'haiku')).not.toThrow()
  })
})
