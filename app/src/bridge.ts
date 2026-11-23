// Local-only HTTP endpoint (127.0.0.1, random port, per-run secret) that the MCP shim (mcp.ts) forwards tool calls to.
// It lets each headless Claude task talk to the running app without a second Telegram poller.
import { randomBytes, timingSafeEqual } from 'crypto'
import { logError } from './state'

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }
export type ToolResult = { text: string; isError?: boolean }
export type Handler = (task: string, name: string, args: Record<string, unknown>) => Promise<ToolResult>

export function startBridge(tools: () => ToolDef[], handle: Handler) {
  const secret = randomBytes(24).toString('hex')
  const ok = (got: string | null) => {
    const a = Buffer.from(got ?? ''), b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (!ok(req.headers.get('x-jobbot-secret'))) return new Response('forbidden', { status: 403 })
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/tools') return Response.json(tools())
      if (req.method === 'POST' && url.pathname === '/call') {
        let body: { task?: string; name?: string; args?: Record<string, unknown> }
        try { body = await req.json() } catch { return Response.json({ text: 'bad request', isError: true }) }
        try {
          return Response.json(await handle(String(body.task ?? ''), String(body.name ?? ''), body.args ?? {}))
        } catch (e) {
          logError(`tool ${body.name} failed`, e)
          return Response.json({ text: `error: ${e instanceof Error ? e.message : e}`, isError: true })
        }
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, secret, stop: () => server.stop(true) }
}
