// Local dashboard: the desktop front end, on the computer JobAgent runs on. Bound to 127.0.0.1, behind a random secret
// kept in data/dashboard.json. Reads reuse jobs.ts and insights.ts. Every write is a call into app.ts (`deps.call`) that
// runs the same code as the Telegram button or typed reply it mirrors: button codes go through the Telegram router behind
// the TAPS allowlist, so approval still goes through review.ts and its plan_hash check. Private answers are never sent
// to the page.
//
// Phone access (off by default): the user runs a tunnel to this port, either with scripts/phone.ps1 (which sets its
// address here) or their own (Tailscale Funnel…), pasting the https address in Telegram. Requests arriving through that address never get the local secret: they must sign in with
// Telegram's signed Mini App data (checked with the bot token), for the paired account only, and then use a 12-hour
// session token. See docs/dashboard.md for the threat model.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { readKit } from './applykit'
import { byBand, funnel } from './insights'
import { allJobs, jobDir, JOB_RE, needsYou, readJob, readOutcomes, statusOf, type Job } from './jobs'
import { DATA, log, practiceOn, readJson, loadSettings, writeJson } from './state'

const FILE = join(DATA, 'dashboard.json')
const PAGE = join(import.meta.dir, '..', 'web', 'dashboard.html')
const IMAGES = new Set(['resume.png', 'filled.png', 'submitted.png']) // the only screenshots the page may load
// three.js for the page's background, served from node_modules: the page loads nothing from outside.
const THREE = join(import.meta.dir, '..', 'node_modules', 'three')
const VENDOR = new Set(['build/three.module.js',
  ...['EffectComposer', 'RenderPass', 'ShaderPass', 'UnrealBloomPass', 'MaskPass', 'Pass'].map(f => `examples/jsm/postprocessing/${f}.js`),
  ...['CopyShader', 'LuminosityHighPassShader'].map(f => `examples/jsm/shaders/${f}.js`)])
const TYPES: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain; charset=utf-8' }

// The Telegram buttons the page may press (same router, same checks). Buttons that open a screen, ask for typed text or
// send files into the chat are left out: the page has its own screens and inputs for those.
export const TAPS = /^(H:pause|H:resume|d:run|fix:go|m:hc|P:on|P:yes|m:dash:off|sg:(ms|no):\d{1,3}|fix:(ok|no):[\w-]{1,40}|j:(rt|any|x|sk|ap|fu|pr|go|zz):[0-9a-f]{8}|j:o:[0-9a-f]{8}:[iorg]|r:(sk|nx|or|cx):[0-9a-f]{8}|r:hv:[0-9a-f]{8}:\d{1,3}|C:r:[a-z0-9_-]{1,60}|L:(in|pw|rm|rt):(linkedin|indeed)|p:ach:rm:a\d{1,2}|p:rv:rm:[a-z0-9-]{1,40}|a:dd:[0-9a-f]{8}|u:again:\w+|x:[\w-]{1,80})$/
// Buttons the page answers itself by opening one of its own screens.
export const NAVS = /^(r:rv:[0-9a-f]{8}|j:kit:[0-9a-f]{8}|j:rc:[0-9a-f]{8}|F:list)$/
type Button = { text: string; data?: string; style?: string }
export const pageButtons = (btns: Button[] = []) => btns.filter(b => b.data && (TAPS.test(b.data) || NAVS.test(b.data))).map(({ text, data, style }) => ({ text, data, style }))
// Telegram HTML -> plain text (the page escapes everything it shows).
export const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

export type DashDeps = {
  botToken: string
  pairedId: () => number | null
  approve: (id: string, planHash: string) => Promise<string | null> // null = approved
  skip: (id: string) => Promise<string | null>
  health: () => { checks: { name: string; ok: boolean; detail: string; required: boolean }[]; at: number } | null
  // Everything else the page reads or does ("view:live", "tap", "setting"…), implemented in app.ts. Throws a message to show.
  call?: (op: string, body: Record<string, any>) => Promise<any>
}

export const COLUMNS = ['Preparing', 'Needs you', 'Applied', 'Interview', 'Offer', 'Closed'] as const
export function columnOf(j: Job, outcome?: string): (typeof COLUMNS)[number] {
  if (outcome === 'offer') return 'Offer'
  if (outcome === 'interview') return 'Interview'
  if (outcome === 'rejected' || outcome === 'ghosted' || ['SKIPPED', 'CLOSED', 'FAILED'].includes(j.status)) return 'Closed'
  if (needsYou(j)) return 'Needs you'
  if (statusOf(j.status).done) return 'Applied'
  return 'Preparing'
}

const card = (j: Job, out: Record<string, string>) => ({
  id: j.id, company: j.company, role: j.role, score: j.score, status: statusOf(j.status).text, status_code: j.status,
  column: columnOf(j, out[j.id]), updated_at: j.updated_at, source: j.source, location: j.location, salary: j.salary,
})

export function stateJson(now = Date.now()) {
  const jobs = allJobs(now), out = readOutcomes(), s = loadSettings()
  return {
    now, practice: practiceOn(s), columns: COLUMNS, jobs: jobs.map(j => card(j, out)),
    insights: { all: funnel(jobs, out), week: funnel(jobs, out, now - 7 * 86_400_000), bands: byBand(jobs, out) },
  }
}

// Everything the detail drawer shows. Answers marked private are masked here, before they leave the app.
export function jobJson(id: string) {
  const j = readJob(id)
  if (!j) return null
  const rv = readJson<any>(join(jobDir(id), 'review.json'), null)
  const receipt = readJson<any>(join(jobDir(id), 'receipt.json'), null)
  const answers = Array.isArray(rv?.answers) ? rv.answers.map((a: any) => ({ fid: String(a.fid ?? ''), label: String(a.label ?? ''), value: a.sensitive ? null : String(a.value ?? ''), source: String(a.source ?? ''), private: !!a.sensitive, required: !!a.required, editable: a.source !== 'document' })) : []
  const images = [...IMAGES].filter(f => existsSync(join(jobDir(id), 'screenshots', f)))
  return {
    ...card(j, readOutcomes()), url: j.url, reasons: j.reasons, dealbreakers: j.dealbreakers, breakdown: j.breakdown, must_haves: j.must_haves,
    history: j.history.slice(-12).map(h => ({ ...h, status: statusOf(h.status).text })), outcome: readOutcomes()[id] ?? '',
    review: rv && j.status === 'AWAITING_APPROVAL' ? {
      plan_hash: String(rv.plan_hash), files: rv.files ?? [], cover_letter: String(rv.cover_letter ?? ''), coverage: rv.coverage ?? null,
      unusual: rv.unusual ?? [], resume: rv.resume ?? null, ats: String(rv.ats ?? ''),
    } : null,
    changes: Array.isArray(rv?.changes) ? rv.changes : [], answers, images, files: files(id),
    receipt: receipt ? { at: receipt.at, practice: !!receipt.practice, files: receipt.files ?? [], answers: receipt.answers ?? 0 } : null,
  }
}
// The job's files the page may download: the review's attachments and the apply-yourself kit.
function files(id: string): string[] {
  const rv = readJson<{ files?: string[] } | null>(join(jobDir(id), 'review.json'), null)
  return [...new Set([...(rv?.files ?? []).map(f => basename(String(f))), ...readKit(id).files])].filter(f => /^[\w. -]{1,100}$/.test(f) && existsSync(join(jobDir(id), f)))
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// Telegram Mini App sign-in: returns the Telegram user id when `initData` was signed for this bot, recently, else null.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function checkInitData(initData: string, botToken: string, now = Date.now(), maxAgeS = 24 * 3600): number | null {
  const q = new URLSearchParams(initData), hash = q.get('hash') ?? ''
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  q.delete('hash')
  const check = [...q.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest()
  if (!same(createHmac('sha256', key).update(check).digest('hex'), hash)) return null
  const at = Number(q.get('auth_date'))
  if (!Number.isFinite(at) || now / 1000 - at > maxAgeS || at - now / 1000 > 300) return null
  try { const id = JSON.parse(q.get('user') ?? '{}').id; return Number.isSafeInteger(id) ? id : null } catch { return null }
}

// The tunnel address the user pasted, or null (phone access off). Only an https origin with no path is accepted.
export const phoneUrl = (): string | null => readJson<{ phone_url?: string | null }>(FILE, {}).phone_url ?? null
export function setPhoneUrl(raw: string | null): string | null {
  let url: string | null = null
  if (raw != null) {
    try {
      const u = new URL(raw.trim())
      if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
      if (/^(\d+\.){3}\d+$|^\[|^localhost$/i.test(u.hostname)) return null // a tunnel has a real name
      url = u.origin
    } catch { return null }
  }
  writeJson(FILE, { ...readJson<Record<string, unknown>>(FILE, {}), phone_url: url })
  return url ?? ''
}
// Whether a typed message is meant as a tunnel address (right or slightly wrong), not a job link, profile or chat.
export const looksLikeAddress = (text: string) => /trycloudflare\.com|\.ts\.net/i.test(text) || /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?\/?$/i.test(text.trim())
const cookieOf =(req: Request) => /(?:^|;\s*)jd=([0-9a-f]{64})/.exec(req.headers.get('cookie') ?? '')?.[1] ?? ''

export function startDashboard(deps: DashDeps, port = Number(process.env.JOBAGENT_DASH_PORT || 4777)) {
  const saved = readJson<{ secret?: string }>(FILE, {})
  const secret = /^[0-9a-f]{64}$/.test(saved.secret ?? '') ? saved.secret! : randomBytes(32).toString('hex')
  if (secret !== saved.secret) writeJson(FILE, { ...saved, secret })
  const sessions = new Map<string, number>() // phone session token -> expiry (memory only: a restart signs phones out)
  const json = (x: unknown, status = 200) => Response.json(x, { status, headers: { 'cache-control': 'no-store' } })
  const handler = async (req: Request) => {
    const url = new URL(req.url), host = req.headers.get('host') ?? '', phone = phoneUrl()
    const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    // DNS rebinding: answer only requests addressed to this computer, or to the tunnel the user turned on.
    if (!local && !(phone && host === new URL(phone).host)) return new Response('forbidden', { status: 403 })
    if (req.method === 'POST') {
      const origin = req.headers.get('origin')
      if (origin && origin !== (local ? `http://${host}` : phone)) return json({ error: 'bad origin' }, 403)
      if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'bad request' }, 400)
    }
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('k')) {
      if (!local || !same(url.searchParams.get('k') ?? '', secret)) return new Response('That link is old. Open the newest one from Telegram.', { status: 403 })
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `jd=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` } })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/three/')) { // public library code, no data
      const rel = url.pathname.slice('/vendor/three/'.length)
      if (!VENDOR.has(rel) || !existsSync(join(THREE, rel))) return new Response('not found', { status: 404 })
      return new Response(readFileSync(join(THREE, rel)), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } })
    }
    if (req.method === 'GET' && url.pathname === '/') { // the page itself holds no data: it signs in, then asks the API
      return new Response(readFileSync(PAGE), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors ${local ? "'none'" : 'https://web.telegram.org'}`, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } })
    }
    if (req.method === 'POST' && url.pathname === '/api/tg-auth') {
      let body: any
      try { body = await req.json() } catch { return json({ error: 'bad request' }, 400) }
      const who = checkInitData(String(body?.init_data ?? '').slice(0, 4096), deps.botToken), paired = deps.pairedId()
      if (who == null || paired == null || who !== paired) return json({ error: 'Open the dashboard from your JobAgent chat in Telegram.' }, 403)
      const t = randomBytes(32).toString('hex'), now = Date.now()
      for (const [k, exp] of sessions) if (exp < now) sessions.delete(k)
      sessions.set(t, now + 12 * 3600_000)
      return json({ token: t })
    }
    const sess = req.headers.get('x-session') ?? ''
    const signedIn = (/^[0-9a-f]{64}$/.test(sess) && (sessions.get(sess) ?? 0) > Date.now()) || (local && same(cookieOf(req), secret))
    if (!signedIn) return json({ error: local ? 'Open the dashboard from the link in Telegram (🏠 Home → 🖥 Dashboard).' : 'Open the dashboard from your JobAgent chat in Telegram.' }, 403)
    const call = async (op: string, body: Record<string, any> = {}) => {
      if (!deps.call) throw new Error('Restart JobAgent to use this.')
      return deps.call(op, body)
    }
    const answer = async (f: () => Promise<unknown>) => { try { return json(await f()) } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 409) } }
    if (req.method === 'GET' && url.pathname === '/api/state') return json({ ...stateJson(), health: deps.health(), live: deps.call ? await deps.call('view:live', {}).catch(() => null) : null })
    const v = /^\/api\/view\/(live|settings|profile|forms|logins)$/.exec(url.pathname)
    if (req.method === 'GET' && v) return answer(() => call(`view:${v[1]}`))
    if (req.method === 'POST' && url.pathname === '/api/do') {
      let body: any
      try { body = await req.json() } catch { return json({ error: 'bad request' }, 400) }
      if (!body || typeof body.op !== 'string' || body.op.startsWith('view:') || body.op === 'export') return json({ error: 'bad request' }, 400)
      return answer(() => call(body.op, body))
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      try {
        const r = await call('export')
        return new Response(readFileSync(r.path), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="jobagent-applications.csv"', 'cache-control': 'no-store' } })
      } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 409) }
    }
    const m = /^\/api\/job\/([a-z0-9-]{1,80})(?:\/(approve|skip|img\/([a-z]+\.png)|file\/([^/]{1,300})))?$/.exec(url.pathname)
    if (!m || !JOB_RE.test(m[1])) return json({ error: 'not found' }, 404)
    const id = m[1]
    if (req.method === 'GET' && !m[2]) {
      const x = jobJson(id)
      return x ? json({ ...x, ...(deps.call ? await deps.call('view:job', { id }).catch(() => ({})) : {}) }) : json({ error: 'not found' }, 404)
    }
    if (req.method === 'GET' && m[3] && IMAGES.has(m[3])) {
      const f = join(jobDir(id), 'screenshots', m[3])
      return existsSync(f) ? new Response(readFileSync(f), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } }) : json({ error: 'not found' }, 404)
    }
    if (req.method === 'GET' && m[4]) {
      let name = ''
      try { name = decodeURIComponent(m[4]) } catch { /* bad escape: not found below */ }
      const ext = name.split('.').pop()!.toLowerCase()
      if (!files(id).includes(name)) return json({ error: 'not found' }, 404)
      return new Response(readFileSync(join(jobDir(id), name)), { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'content-disposition': `${ext === 'pdf' ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
    if (req.method === 'POST' && m[2] === 'approve') {
      let body: any
      try { body = await req.json() } catch { return json({ error: 'bad request' }, 400) }
      const err = await deps.approve(id, String(body?.plan_hash ?? ''))
      return err ? json({ error: err }, 409) : json({ ok: true })
    }
    if (req.method === 'POST' && m[2] === 'skip') { const err = await deps.skip(id); return err ? json({ error: err }, 409) : json({ ok: true }) }
    return json({ error: 'not found' }, 404)
  }
  let server: ReturnType<typeof Bun.serve>
  try { server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler }) }
  catch { server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler }) } // that port is taken: any free one
  const bound = server.port ?? port // always set once listening on a TCP port
  writeJson(FILE, { ...readJson<Record<string, unknown>>(FILE, {}), port: bound }) // scripts/phone.ts tunnels to it
  const link = `http://127.0.0.1:${bound}/?k=${secret}`
  log(`dashboard on http://127.0.0.1:${bound}`)
  return { link, stop: () => server.stop(true), port: bound }
}
