#!/usr/bin/env bun
// MCP stdio shim. Claude starts this for each task (via --mcp-config); it forwards every tool call to the running app (bridge.ts).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BRIDGE = process.env.JOBBOT_BRIDGE ?? ''
const SECRET = process.env.JOBBOT_SECRET ?? ''
const TASK = process.env.JOBBOT_TASK ?? ''
const headers = { 'x-jobbot-secret': SECRET, 'content-type': 'application/json' }

const server = new Server(
  { name: 'jobbot', version: '2.0.0' },
  { capabilities: { tools: {} }, instructions: 'The user reads Telegram, not this session. Talk to them only through these tools.' },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await fetch(`${BRIDGE}/tools`, { headers })
  return { tools: r.ok ? await r.json() : [] }
})

server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const r = await fetch(`${BRIDGE}/call`, { method: 'POST', headers, body: JSON.stringify({ task: TASK, name: req.params.name, args: req.params.arguments ?? {} }) })
    const j = (await r.json()) as { text: string; isError?: boolean }
    return { content: [{ type: 'text', text: j.text }], isError: !!j.isError }
  } catch (e) {
    return { content: [{ type: 'text', text: `JobAgent app is not reachable (${e instanceof Error ? e.message : e})` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
