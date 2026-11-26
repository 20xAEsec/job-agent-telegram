// The tools Claude gets in every task (served through bridge.ts -> mcp.ts). Handlers live in app.ts.
import type { ToolDef } from './bridge'
import { STAGES } from './cards'

// Buttons Claude may attach to tg_send: a fixed set, so it can never invent an action.
export const AGENT_BUTTONS: Record<string, string> = {
  'm:home': '🏠 Home', 'N:0': '📥 Needs you', 'J:a:0': '📋 Jobs', 'm:settings': '⚙️ Settings', 'S:search': '🎯 What I look for',
  'S:auto': '🔭 Auto-search', 'C:list': '🏢 Companies I watch', 'm:prof': '👤 Profile', 'a:l:0': '💾 Saved answers', 'm:help': '❔ Help',
  'L:show': '🔑 Job site logins', 'Q:0': '🔔 Review queue', 'm:health': '🩺 Health', 'I:0': '📊 Insights', 'F:list': '❓ Open Questions',
  'p:rv': '📚 Resume versions', 'fo:list': '🔎 Filtered out',
}
export const TONES: Record<string, string> = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' }

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
  { name: 'settings_get', description: 'Return the current settings.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'settings_update',
    description: 'Chat tasks only, and only when the user asked for the change in their own words. Deep-merges a patch into settings (validated). Cannot pair, finish setup or turn practice mode off.',
    inputSchema: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] },
  },
]
// v4: tg_ask, tg_review and profile_ready are gone. Questions, review cards and the resume summary come from the app's own
// pipeline (pipeline.ts), never from a Claude session.
