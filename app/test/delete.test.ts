// 🗑 Delete: offered on a job's page, asks first, and a job that was sent stays counted by the send limits.
import { expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { allJobs, code, jobDir, readJob } from '../src/jobs'
import * as P from '../src/pages'
import { sentToday } from '../src/review'
import { writeJson } from '../src/state'

test('the page offers Delete, asks first, and a sent job stays counted but hidden', () => {
  const ID = 'greenhouse-acme-del', at = new Date().toISOString(), dir = jobDir(ID)
  const datas = (p: { rows: { data?: string }[][] }) => p.rows.flat().map(b => b.data)
  writeJson(join(dir, 'status.json'), { status: 'SUBMITTED', updated_at: at, history: [{ status: 'SUBMITTED', at, detail: '' }] })
  writeJson(join(dir, 'meta.json'), { url: 'https://x', ats: 'greenhouse' })
  const j = readJob(ID)!, before = sentToday()
  expect(datas(P.jobPage(j, { running: false, hasForm: false }))).toContain(`j:dl:${code(ID)}`)
  expect(datas(P.jobPage(j, { running: true, hasForm: false }))).not.toContain(`j:dl:${code(ID)}`)
  expect(P.deletePage(j).text).toContain('cannot unsend')
  expect(datas(P.deletePage(j))).toEqual([`j:dx:${code(ID)}`, `j:v:${code(ID)}`])
  writeJson(join(dir, 'meta.json'), { url: 'https://x', ats: 'greenhouse', deleted_at: at })
  readJob(ID) // as the app does after deleting
  expect(allJobs().some(x => x.id === ID)).toBe(false)
  expect(sentToday()).toBe(before)
  rmSync(dir, { recursive: true, force: true })
})
