import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Cue } from '../cue.ts';
import { McpHttpHandler } from '../mcp/server.ts';
import { UI_DIR } from '../paths.ts';
import { handleApi } from './api.ts';
import { PAGE_CSP, SECURITY_HEADERS, refuseReason } from './security.ts';

const MAX_BODY = 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body is larger than 1 MB');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const text = await readBody(req);
  if (!text.trim()) return {};
  // A JSON content type forces browsers into a CORS preflight, which Cue never answers.
  if (type !== 'application/json') throw new HttpError(415, 'send JSON with Content-Type: application/json');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function loadUi(dir: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const type = TYPES[extname(name)];
    if (type && /^[\w.-]+$/.test(name)) files.set(`/${name}`, { body: readFileSync(join(dir, name)), type });
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

/**
 * Starts Cue's HTTP server on 127.0.0.1 only: the UI, the JSON API under
 * /api and the MCP endpoint at /mcp. Every request passes the Host/Origin check.
 */
export async function startServer(cue: Cue, opts: { port: number; uiDir?: string; log?: (msg: string) => void }): Promise<RunningServer> {
  const log = opts.log ?? (() => undefined);
  const ui = loadUi(opts.uiDir ?? UI_DIR);
  const mcp = new McpHttpHandler(cue);
  let port = opts.port;

  const server = createServer(async (req, res) => {
    try {
      const reason = refuseReason(req.headers, port);
      if (reason) return send(res, 403, { ok: false, error: `refused: ${reason}` });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        await mcp.handle(req, res, body);
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return send(res, 405, { ok: false, error: 'Cue does not answer cross-origin requests' });
        const body = await readJson(req);
        const r = await handleApi(cue, req, url, body);
        return send(res, r.status, r.body);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = ui.get(url.pathname);
        if (file) {
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': file.type,
            'Cache-Control': 'no-cache',
            ...(file.type.startsWith('text/html') ? { 'Content-Security-Policy': PAGE_CSP } : {}),
          });
          res.end(req.method === 'HEAD' ? undefined : file.body);
          return;
        }
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message });
      log(`error on ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error; see the Cue terminal' });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await mcp.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
