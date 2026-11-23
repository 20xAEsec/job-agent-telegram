// The tools Claude gets in every task (served through bridge.ts -> mcp.ts). Handlers live in app.ts.
import type { ToolDef } from './bridge'
import { STAGES } from './cards'

// Buttons Claude may attach to tg_send: a fixed set, so it can never invent an action.
export const AGENT_BUTTONS: Record<string, string> = {
  'm:home': '🏠 Home', 'N:0': '📥 Needs you', 'J:a:0': '📋 Jobs', 'm:settings': '⚙️ Settings', 'S:search': '🎯 What I look for',
  'S:auto': '🔭 Auto-search', 'C:list': '🏢 Companies I watch', 'm:prof': '👤 Profile', 'a:l:0': '💾 Saved answers', 'm:help': '❔ Help',
  'L:show': '🔑 Job site logins',
}
export const TONES: Record<string, string> = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' }

const Q = {
  type: 'object',
  properties: {
    qid: { type: 'string' }, text: { type: 'string' },
    kind: { type: 'string', enum: ['choice', 'multi', 'yesno', 'text', 'number', 'date'] },
    options: { type: 'array', items: { type: 'string' } },
    sensitive: { type: 'boolean' }, save_key: { type: 'string' },
    default_save: { type: 'string', enum: ['global', 'job', 'no'] }, why: { type: 'string' },
    fid: { type: 'string', description: 'The fields.json fid this answer fills (hidden from the user). The app writes the answer into answers.json for you.' },
  },
  required: ['qid', 'text', 'kind'],
}

export const TOOLS: ToolDef[] = [
  {
    name: 'tg_send',
    description:
      'Send the user a Telegram message. Text is Telegram HTML (<b>, <i>, <code>, <blockquote>); escape & < > in other text. ' +
      'Optional tone (info|success|warn|error) + title make a bold heading with an emoji. Optional buttons from a fixed set: ' + Object.keys(AGENT_BUTTONS).join(', ') + '. ' +
      'Optional files: absolute paths under data/. silent: true for FYI messages (no notification sound). Keep it short: live job cards already show progress.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, tone: { type: 'string', enum: Object.keys(TONES) }, title: { type: 'string' },
        buttons: { type: 'array', items: { type: 'string', enum: Object.keys(AGENT_BUTTONS) } },
        files: { type: 'array', items: { type: 'string' } }, silent: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tg_progress',
    description:
      'Update the live card the user is watching for this task (edited in place, silently). With job_id: move that job to a stage (' + STAGES.join(' | ') + '); ' +
      'give title "Company · Role" and url once known, and detail as a short result for the stage (for score: "82/100"). ' +
      'Without job_id: note sets one short line on the card (for example an auto-search summary). The final state of each job is read from its status automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' }, stage: { type: 'string', enum: [...STAGES] }, title: { type: 'string' }, url: { type: 'string' },
        detail: { type: 'string' }, note: { type: 'string' },
      },
    },
  },
  {
    name: 'tg_ask',
    description:
      'Ask the user questions with a Telegram form (buttons and typed answers). Returns at once; when the user confirms, the app saves the answers ' +
      '(to profile.md for questions with a save_key and save on, to data/jobs/<job_id>/answers.json for questions with a fid) and starts a new task to continue the job. ' +
      'So after tg_ask, set the job to NEEDS_ANSWERS and stop. kind: choice | multi | yesno | text | number | date. Sensitive questions need a save_key. save_key is reusable, like work_auth_us.',
    inputSchema: {
      type: 'object',
      properties: { batch_id: { type: 'string' }, job_id: { type: 'string' }, title: { type: 'string', description: '"Company · Role"' }, questions: { type: 'array', items: Q } },
      required: ['batch_id', 'questions'],
    },
  },
  {
    name: 'tg_review',
    description:
      'Send the review card for a job whose review.json is fresh (status FILLED_DRY after `jobagent fill --dry-run` and `jobagent review build`). ' +
      'The app shows every answer, attaches the files and owns Approve / Change / Skip. You can never approve. A change request arrives later as a revise task.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
  { name: 'settings_get', description: 'Return the current settings.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'settings_update',
    description: 'Chat tasks only, and only when the user asked for the change in their own words. Deep-merges a patch into settings (validated). Cannot pair, finish setup or turn practice mode off.',
    inputSchema: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] },
  },
  {
    name: 'profile_ready',
    description: 'Resume tasks only: report what you read from the resume, after `jobagent profile write-draft` succeeded. The app shows it to the user to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, headline: { type: 'string', description: 'Latest job title, e.g. "Data Analyst at Acme"' },
        years: { type: ['number', 'null'] }, level: { type: 'string', enum: ['intern', 'entry', 'mid', 'senior', 'staff', 'lead', 'manager', 'director'] },
        location: { type: 'string' }, country: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } }, suggested_titles: { type: 'array', items: { type: 'string' }, description: '3 to 6 job titles this person would search for' },
      },
      required: ['name', 'headline', 'level', 'skills', 'suggested_titles'],
    },
  },
]
