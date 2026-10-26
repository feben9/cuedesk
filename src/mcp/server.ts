import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Cue } from '../cue.ts';
import { VERSION } from '../version.ts';
import { TOOLS, callTool } from './tools.ts';

const INSTRUCTIONS = [
  'Cue is the human\'s chief of staff across agent sessions.',
  'Use ask_human instead of stopping to wait in your own terminal; poll get_answer.',
  'Claim shared devices, environments and accounts with claim_resource before you use them, and release them when done.',
  'Call report_progress at milestones; it is your heartbeat.',
  'Pass the same "session" label on every call so the human sees one line per session.',
].join(' ');

/** One MCP server instance (the SDK binds a server to one transport). */
export function createMcpServer(cue: Cue): Server {
  const server = new Server({ name: 'cuedesk', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as unknown as { type: 'object'; [k: string]: unknown },
      annotations: { title: t.title, readOnlyHint: t.readOnly, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { isError, result } = await callTool(
      cue,
      req.params.name,
      req.params.arguments ?? {},
      { via: 'mcp', mcpSessionId: extra.sessionId ?? null, clientName: server.getClientVersion()?.name ?? null },
      extra.signal,
    );
    // Errors and refusals read as one plain sentence; results as JSON.
    const text = isError ? String(result.error ?? result.message ?? 'failed') : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text' as const, text }], structuredContent: result, isError };
  });
  return server;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastUsed: number;
}

const MAX_SESSIONS = 64;

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Streamable HTTP at /mcp, with one MCP session per connected client. */
export class McpHttpHandler {
  private readonly sessions = new Map<string, McpSession>();
  private readonly cue: Cue;

  constructor(cue: Cue) {
    this.cue = cue;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) {
      const s = this.sessions.get(sid);
      if (!s) return jsonRpcError(res, 404, 'Session not found; start a new MCP session');
      s.lastUsed = Date.now();
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const server = createMcpServer(this.cue);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { transport, server, lastUsed: Date.now() });
          this.evict();
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    jsonRpcError(res, 400, 'Bad request: send an initialize request first, or include the Mcp-Session-Id header');
  }

  private evict(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, this.sessions.size - MAX_SESSIONS);
    for (const [id, s] of oldest) {
      this.sessions.delete(id);
      void s.transport.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.server.close().catch(() => undefined)));
  }
}
