import type { IncomingMessage } from 'node:http';
import { CueError, type Caller, type Cue } from '../cue.ts';
import { ingestClaudeHook } from '../ingest/hooks.ts';
import { TOOL_MAP, callTool } from '../mcp/tools.ts';
import { UnknownResourceError } from '../store/index.ts';
import { parseSince } from '../util/time.ts';
import { coerceQuery, validate, ValidationError, type ObjectSchema } from '../util/validate.ts';
import { VERSION } from '../version.ts';

export interface ApiResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

function callerFrom(req: IncomingMessage, body: Record<string, unknown>, via: Caller['via'] = 'api'): Caller {
  const header = req.headers['x-cue-session'];
  const session = typeof body.session === 'string' ? body.session : typeof header === 'string' ? header : null;
  return { via, session };
}

const snoozeSchema: ObjectSchema = {
  type: 'object',
  properties: { minutes: { type: 'integer', minimum: 1, maximum: 10080 } },
  additionalProperties: false,
};
const answerSchema: ObjectSchema = {
  type: 'object',
  properties: { answer: { type: 'string', minLength: 1, maxLength: 8000 } },
  required: ['answer'],
  additionalProperties: false,
};

/** Friendly GET names for read-only tools. */
const GET_ALIASES: Record<string, string> = {
  sessions: 'list_sessions',
  signals: 'list_signals',
};

/**
 * JSON API under /api. Every MCP tool is also `POST /api/<tool>` (and
 * `GET /api/<tool>` when it only reads); the UI uses the routes below it.
 */
export async function handleApi(cue: Cue, req: IncomingMessage, url: URL, body: unknown): Promise<ApiResponse> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  try {
    // Tools: GET /api/whats_next, POST /api/ask_human, POST /api/tools/<name>, ...
    const toolName = parts[0] === 'tools' && parts.length === 2 ? parts[1]! : parts.length === 1 ? (GET_ALIASES[parts[0]!] ?? parts[0]!) : null;
    const tool = toolName ? TOOL_MAP.get(toolName) : undefined;
    if (tool) {
      if (method === 'GET' && !tool.readOnly) return ok({ ok: false, error: `${tool.name} changes state; use POST` }, 405);
      if (method !== 'GET' && method !== 'POST') return ok({ ok: false, error: 'use GET or POST' }, 405);
      const args = method === 'GET' ? coerceQuery(tool.inputSchema, url.searchParams) : b;
      if (method === 'GET' && tool.name === 'since' && args.timestamp === undefined && url.searchParams.has('ts')) {
        args.timestamp = url.searchParams.get('ts');
        delete args.ts;
      }
      const caller = callerFrom(req, args);
      const r = await callTool(cue, tool.name, args, caller, AbortSignal.timeout(610_000));
      return ok(r.result, r.status);
    }

    const route = `${method} /${parts.join('/')}`;
    const [, id, action] = parts;

    if (route === 'GET /health') return ok({ ok: true, name: 'cuedesk', version: VERSION, project: cue.config.project });
    if (route === 'GET /state') return ok(cue.state());
    if (route === 'GET /resources') return ok({ ok: true, resources: cue.listResources() });
    if (route === 'GET /board' || route === 'GET /items') return ok({ ok: true, items: cue.board() });
    if (route === 'GET /events') {
      const since = parseSince(url.searchParams.get('since') ?? '24h', cue.now());
      return ok({ ok: true, events: cue.since(since).events });
    }
    if (route === 'POST /sync') {
      const results = await cue.syncAll();
      const rules = cue.evaluate();
      return ok({ ok: true, sources: results, signalsFired: rules.fired.length, signalsResolved: rules.resolved.length });
    }
    if (route === 'POST /hooks/claude') return ok(ingestClaudeHook(cue, body));

    // Asks
    if (parts[0] === 'asks') {
      if (method === 'GET' && parts.length === 1) {
        const status = url.searchParams.get('status') ?? 'open';
        if (!['open', 'answered', 'dismissed', 'all'].includes(status)) throw new CueError('status must be open, answered, dismissed or all');
        return ok({ ok: true, asks: cue.store.listAsks({ status: status as 'open' }) });
      }
      if (method === 'POST' && parts.length === 1) {
        const r = await callTool(cue, 'ask_human', b, callerFrom(req, b));
        return ok(r.result, r.status === 200 ? 201 : r.status);
      }
      if (method === 'GET' && parts.length === 2) return ok({ ok: true, ask: cue.getAsk(id!) });
      if (method === 'POST' && parts.length === 3) {
        switch (action) {
          case 'answer': {
            const a = validate<{ answer: string }>(answerSchema, b);
            return ok({ ok: true, ask: cue.answerAsk(id!, a.answer.trim()) });
          }
          case 'done':
            return ok({ ok: true, ask: cue.answerAsk(id!, 'done') });
          case 'approve':
            return ok({ ok: true, ask: cue.answerAsk(id!, 'approved') });
          case 'reject':
            return ok({ ok: true, ask: cue.answerAsk(id!, 'rejected') });
          case 'dismiss':
            return ok({ ok: true, ask: cue.dismissAsk(id!) });
          case 'snooze': {
            const a = validate<{ minutes?: number }>(snoozeSchema, b);
            return ok({ ok: true, ask: cue.snoozeAsk(id!, a.minutes ?? 60) });
          }
        }
      }
    }

    // Signals
    if (parts[0] === 'signals' && method === 'POST' && parts.length === 3) {
      if (action === 'dismiss') return ok({ ok: true, signal: cue.dismissSignal(id!) });
      if (action === 'snooze') {
        const a = validate<{ minutes?: number }>(snoozeSchema, b);
        return ok({ ok: true, signal: cue.snoozeSignal(id!, a.minutes ?? 60) });
      }
    }

    // The human releasing a claim from the UI (any holder).
    if (parts[0] === 'resources' && method === 'POST' && parts.length === 3 && action === 'release') {
      const r = cue.release(id!, { via: 'ui' });
      return ok(r.ok ? { ok: true, resourceId: id } : { ok: false, error: r.message }, r.ok ? 200 : 409);
    }

    return ok({ ok: false, error: `no route ${method} ${url.pathname}` }, 404);
  } catch (err) {
    if (err instanceof ValidationError) return ok({ ok: false, error: `invalid input: ${err.issues.join('; ')}` }, 400);
    if (err instanceof UnknownResourceError) return ok({ ok: false, error: err.message }, 404);
    if (err instanceof CueError) return ok({ ok: false, error: err.message }, err.status);
    if (err instanceof Error && /timestamp/.test(err.message)) return ok({ ok: false, error: err.message }, 400);
    throw err;
  }
}
