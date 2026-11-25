// Files under data/ (all personal state) and the settings schema. The app is the only writer of settings.json.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { z } from 'zod'

export const ROOT = resolve(process.env.JOBAGENT_ROOT ?? join(import.meta.dir, '..', '..'))
export const DATA = join(ROOT, 'data')
export const SETTINGS_FILE = join(DATA, 'settings.json')
export const PAIR_FILE = join(DATA, 'pair.json')
const LOG_FILE = join(DATA, 'logs', 'app.log')

// Metadata only: never log answers, tokens or posting text.
export function log(m: string) {
  const line = `${new Date().toISOString()} ${m.replace(/bot\d+:[\w-]+/g, 'bot<token>')}\n`
  process.stderr.write(line)
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    try {
      if (statSync(LOG_FILE).size > 2_000_000) { // keep 5 generations: app.log.1 is the newest old one
        for (let i = 4; i >= 1; i--) { try { renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`) } catch { /* gap */ } }
        renameSync(LOG_FILE, LOG_FILE + '.1')
      }
    } catch { /* no file yet */ }
    appendFileSync(LOG_FILE, line)
  } catch { /* logging must never break the app */ }
}

// An error with where it came from: name, message and the top stack frames. Never values from data/.
export function logError(ctx: string, e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e))
  const frames = (err.stack ?? '').split('\n').filter(l => /^\s+at /.test(l)).slice(0, 4).join('\n')
  log(`${ctx}: ${err.name}: ${err.message}${frames ? '\n' + frames : ''}`)
}

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

// Atomic: readers never see a half-written file.
export function writeJson(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, file)
}

// Where auto-search looks: the watched Greenhouse boards, and job sites searched through python-jobspy.
export const SOURCES = { companies: 'Companies I watch', linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', zip_recruiter: 'ZipRecruiter' }
type Source = keyof typeof SOURCES

export const DEFAULT_SETTINGS = {
  version: 2,
  paired_user_id: null as number | null,
  onboarded: false,
  agent_on: true,
  dry_run: true, // "Practice mode" in the UI
  agent_model: 'sonnet',
  filters: {
    titles: [] as string[], title_match: 'close', experience_level: 'mid', years_experience: null as number | null,
    related_titles: [] as string[], // other names for the same work: searched too, held to a higher match score
    country: '', // where job sites search; '' = guess from the locations, then the currency
    locations: [] as string[], remote: 'remote_or_hybrid',
    min_salary: null as number | null, currency: 'USD', allow_unknown_salary: true,
    job_types: ['full_time'], exclude_keywords: [] as string[], posted_within_hours: 336, company_blocklist: [] as string[],
  },
  apply: {
    mode: 'review', min_match_score: 60, auto_min_score: 85, auto_grace_seconds: 120,
    company_cooldown_hours: 3, cover_letter: 'if_field', draft_free_text: true, tailoring: 'moderate',
    followup_days: 7, // ask about an application with no news after this many days (0 = never)
  },
  discovery: { enabled: false, interval_hours: 6, web_search: true, sources: ['companies', 'linkedin', 'indeed'] as Source[], reserve_pct: 20, // sources: keep in step with DEFAULT_SOURCES (agent/jobagent/discover/ats_api.py)
    related_jobs: 'few' as 'off' | 'few' | 'more' }, // jobs with a title you did not list, per day: off, 4 or 12 (agent/jobagent/discover/tiers.py CAPS)
  quiet_hours: { enabled: true, from: '23:00', to: '07:00' },
  // Per kind of message: 'loud' rings, 'silent' arrives without a sound, 'off' is not sent (weekly only).
  notify: { reviews: 'loud', search: 'loud', followups: 'loud', health: 'loud', weekly: 'silent' } as Record<NotifyKind, Loudness>,
}
export type NotifyKind = 'reviews' | 'search' | 'followups' | 'health' | 'weekly'
export type Loudness = 'loud' | 'silent' | 'off'
export type Settings = typeof DEFAULT_SETTINGS

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const k of Object.keys(patch)) out[k] = deepMerge((base as Record<string, unknown>)[k], patch[k])
  return out as T
}

// Always re-read from disk: `jobagent pair --reset` edits this file while we run.
export function loadSettings(): Settings {
  const raw = readJson<Record<string, unknown>>(SETTINGS_FILE, {})
  const f = raw.filters as Record<string, unknown> | undefined
  if (isObj(f) && typeof f.posted_within_days === 'number') { f.posted_within_hours ??= f.posted_within_days * 24; delete f.posted_within_days } // older files counted days
  return deepMerge(DEFAULT_SETTINGS, raw)
}

const str = (max = 100) => z.string().trim().min(1).max(max)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const SettingsSchema = z.object({
  version: z.literal(2),
  paired_user_id: z.number().int().nullable(),
  onboarded: z.boolean(),
  agent_on: z.boolean(),
  dry_run: z.boolean(),
  agent_model: z.enum(['sonnet', 'opus']),
  filters: z.object({
    titles: z.array(str()).max(30),
    related_titles: z.array(str()).max(15),
    title_match: z.enum(['exact', 'close', 'broad']),
    experience_level: z.enum(['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director']),
    years_experience: z.number().int().min(0).max(60).nullable(),
    locations: z.array(str()).max(30),
    country: z.string().trim().max(60),
    remote: z.enum(['remote_only', 'remote_or_hybrid', 'any', 'onsite_only']),
    min_salary: z.number().int().min(0).max(100_000_000).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    allow_unknown_salary: z.boolean(),
    job_types: z.array(z.enum(['full_time', 'part_time', 'contract', 'internship'])).min(1).max(4),
    exclude_keywords: z.array(str()).max(50),
    posted_within_hours: z.number().int().min(1).max(8760),
    company_blocklist: z.array(str()).max(200),
  }).strict(),
  apply: z.object({
    mode: z.enum(['review', 'auto']),
    min_match_score: z.number().int().min(0).max(100),
    auto_min_score: z.number().int().min(0).max(100),
    auto_grace_seconds: z.number().int().min(30).max(3600),
    company_cooldown_hours: z.number().min(0).max(168),
    cover_letter: z.enum(['always', 'if_field', 'if_required', 'never']),
    draft_free_text: z.boolean(),
    tailoring: z.enum(['light', 'moderate']),
    followup_days: z.number().int().min(0).max(60),
  }).strict(),
  discovery: z.object({
    enabled: z.boolean(), interval_hours: z.number().int().min(1).max(168), web_search: z.boolean(),
    sources: z.array(z.enum(Object.keys(SOURCES) as [Source, ...Source[]])).min(1).max(5),
    reserve_pct: z.number().int().min(0).max(80),
    related_jobs: z.enum(['off', 'few', 'more']),
  }).strict(),
  quiet_hours: z.object({ enabled: z.boolean(), from: hhmm, to: hhmm }).strict(),
  notify: z.object({
    reviews: z.enum(['loud', 'silent']), search: z.enum(['loud', 'silent']), followups: z.enum(['loud', 'silent']),
    health: z.enum(['loud', 'silent']), weekly: z.enum(['loud', 'silent', 'off']),
  }).strict(),
}).strict()

export type UpdateResult = { ok: true; settings: Settings } | { ok: false; error: string }

// Deep-merge a patch, validate the whole result, then write.
export function trySettingsUpdate(patch: unknown): UpdateResult {
  if (!isObj(patch)) return { ok: false, error: 'patch must be an object' }
  const merged = deepMerge(loadSettings(), patch)
  const r = SettingsSchema.safeParse(merged)
  if (!r.success) {
    const i = r.error.issues[0]
    return { ok: false, error: `${i.path.join('.') || 'settings'}: ${i.message}` }
  }
  writeJson(SETTINGS_FILE, merged)
  return { ok: true, settings: merged }
}

export const getPath = (o: unknown, path: string[]): unknown => path.reduce<unknown>((a, k) => (isObj(a) ? a[k] : undefined), o)
export const patchFor = (path: string[], value: unknown): Record<string, unknown> =>
  path.reduceRight<unknown>((v, k) => ({ [k]: v }), value) as Record<string, unknown>

// True when the local clock is inside the window; handles a window that wraps midnight (23:00-07:00).
export function inWindow(now: Date, from: string, to: string): boolean {
  const m = now.getHours() * 60 + now.getMinutes()
  const f = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  return f(from) <= f(to) ? m >= f(from) && m < f(to) : m >= f(from) || m < f(to)
}
export const isQuiet = (s: Settings, now = new Date()) => s.quiet_hours.enabled && inWindow(now, s.quiet_hours.from, s.quiet_hours.to)

// JOBAGENT_DRY_RUN=1 (start script --practice) forces practice mode regardless of the setting.
export const practiceForced = () => process.env.JOBAGENT_DRY_RUN === '1'
export const practiceOn = (s: Settings) => s.dry_run || practiceForced()
