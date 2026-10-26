import { CueError, type Caller, type Cue } from '../cue.ts';
import { ASK_KINDS, UnknownResourceError, type Ask } from '../store/index.ts';
import { iso, parseSince } from '../util/time.ts';
import { validate, ValidationError, type ObjectSchema } from '../util/validate.ts';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ObjectSchema;
  /** Read-only tools never create sessions or change state. */
  readOnly: boolean;
  run(cue: Cue, args: Record<string, unknown>, caller: Caller, signal?: AbortSignal): Promise<Record<string, unknown>> | Record<string, unknown>;
}

const session = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Who is calling: your session id or a short label (e.g. "checkout-tests"). Optional over MCP, where the connection identifies you.',
} as const;

function askView(a: Ask) {
  return {
    askId: a.id,
    status: a.status,
    answer: a.answer,
    answeredAt: iso(a.answeredAt),
    summary: a.summary,
    kind: a.kind,
    dueAt: iso(a.dueAt),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'ask_human',
    title: 'Ask the human',
    description:
      'Put a question, approval or action in front of the human, in one queue across all sessions. Returns an askId. ' +
      'Poll get_answer(askId) for the reply, or pass waitSeconds to wait here for it (up to 600 s).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 300, description: 'One line: what you need.' },
        details: { type: 'string', maxLength: 8000, description: 'Context the human needs to answer.' },
        kind: { type: 'string', enum: ASK_KINDS, description: 'answer (a question), approve (yes/no), action (the human must do something). Default answer.' },
        dueMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'When it becomes overdue, in minutes from now.' },
        tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 10, description: 'Tags the ranking can use, e.g. ["dev"].' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Wait this long for an answer before returning.' },
        session,
      },
      required: ['summary'],
      additionalProperties: false,
    },
    async run(cue, args, caller, signal) {
      const a = args as { summary: string; details?: string; kind?: Ask['kind']; dueMinutes?: number; tags?: string[]; waitSeconds?: number };
      let ask = cue.askHuman(a, caller);
      if (a.waitSeconds) ask = await cue.waitForAnswer(ask.id, a.waitSeconds, signal);
      return {
        ok: true,
        ...askView(ask),
        ...(ask.status === 'open' ? { next: `Not answered yet. Call get_answer with askId "${ask.id}" to check again.` } : {}),
      };
    },
  },
  {
    name: 'get_answer',
    title: 'Get the answer to an ask',
    description: 'Check whether the human answered an ask. Status is open, answered or dismissed. Pass waitSeconds to wait for it.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        askId: { type: 'string', minLength: 1, maxLength: 64, description: 'The id ask_human returned.' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 600 },
        session,
      },
      required: ['askId'],
      additionalProperties: false,
    },
    async run(cue, args, _caller, signal) {
      const a = args as { askId: string; waitSeconds?: number };
      const ask = a.waitSeconds ? await cue.waitForAnswer(a.askId, a.waitSeconds, signal) : cue.getAsk(a.askId);
      return { ok: true, ...askView(ask) };
    },
  },
  {
    name: 'report_progress',
    title: 'Report progress',
    description: 'Log what you are doing. It counts as a heartbeat, shows on the Now view, and feeds the "since you left" brief.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 500, description: 'What you did or are doing, in one line.' },
        item: { type: 'string', maxLength: 200, description: 'The ticket, issue or PR it concerns, e.g. "APP-123".' },
        session,
      },
      required: ['summary'],
      additionalProperties: false,
    },
    run(cue, args, caller) {
      const a = args as { summary: string; item?: string };
      const r = cue.reportProgress(a.summary, a.item, caller);
      return { ok: true, eventId: r.eventId, session: r.sessionId };
    },
  },
  {
    name: 'claim_resource',
    title: 'Claim a shared resource',
    description:
      'Take a device, environment or account for a while, so no other session uses it at the same time. ' +
      'Refused while another session holds it; the refusal names the holder. Claiming again renews your claim.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', minLength: 1, maxLength: 120, description: 'A resource id from the config, e.g. "tablet-1".' },
        reason: { type: 'string', minLength: 1, maxLength: 300, description: 'What you will use it for.' },
        minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'How long you need it. The claim expires after this.' },
        session,
      },
      required: ['resourceId', 'reason', 'minutes'],
      additionalProperties: false,
    },
    run(cue, args, caller) {
      const a = args as { resourceId: string; reason: string; minutes: number };
      const r = cue.claim(a.resourceId, a.reason, a.minutes, caller);
      if (!r.ok) {
        return {
          ok: false,
          refused: true,
          message: r.message,
          holder: { sessionId: r.holder.sessionId, label: r.holderLabel, reason: r.holder.reason, since: iso(r.holder.claimedAt), expiresAt: iso(r.holder.expiresAt) },
        };
      }
      return { ok: true, resourceId: a.resourceId, renewed: r.renewed, expiresAt: iso(r.claim.expiresAt), heldBy: r.claim.sessionId };
    },
  },
  {
    name: 'release_resource',
    title: 'Release a resource',
    description: 'Give back a resource you claimed. Only the holder can release it.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { resourceId: { type: 'string', minLength: 1, maxLength: 120 }, session },
      required: ['resourceId'],
      additionalProperties: false,
    },
    run(cue, args, caller) {
      const a = args as { resourceId: string };
      const r = cue.release(a.resourceId, caller);
      return r.ok ? { ok: true, resourceId: a.resourceId } : { ok: false, message: r.message };
    },
  },
  {
    name: 'whats_next',
    title: "What's next",
    description: 'The ranked list of what needs the human (asks and signals) and the current priorities, most pressing first.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { session }, additionalProperties: false },
    run(cue) {
      return { ok: true, ...cue.whatsNext() };
    },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'Agent sessions Cue knows about: what each is doing, when it was last seen, and what it holds.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { includeEnded: { type: 'boolean', description: 'Include ended sessions. Default false.' }, session },
      additionalProperties: false,
    },
    run(cue, args) {
      return { ok: true, sessions: cue.listSessions({ includeEnded: Boolean(args.includeEnded) }) };
    },
  },
  {
    name: 'list_signals',
    title: 'List signals',
    description: 'Signals raised by the watch rules (stale items, silent sessions holding claims, old asks).',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['live', 'open', 'all'], description: 'live (not resolved; default), open (not dismissed either) or all.' },
        session,
      },
      additionalProperties: false,
    },
    run(cue, args) {
      return { ok: true, signals: cue.listSignals((args.status as 'live' | 'open' | 'all' | undefined) ?? 'live') };
    },
  },
  {
    name: 'since',
    title: 'Since a time',
    description: 'A plain summary of what happened since a time: asks, signals, board moves, claims, progress. Accepts an ISO date, epoch ms, or a span like "8h".',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', minLength: 1, maxLength: 64, description: 'ISO 8601 date, epoch milliseconds, or "90m" / "8h" / "2d" ago.' },
        session,
      },
      required: ['timestamp'],
      additionalProperties: false,
    },
    run(cue, args) {
      let ts: number;
      try {
        ts = parseSince(String(args.timestamp), cue.now());
      } catch (err) {
        throw new CueError((err as Error).message);
      }
      return { ok: true, ...cue.since(ts) };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export interface ToolCallResult {
  isError: boolean;
  /** HTTP status for the API: 200, 400 bad input, 404 unknown id, 409 refused or conflict. */
  status: number;
  result: Record<string, unknown>;
}

/** Validates input and runs a tool. Expected failures come back as { ok: false, error }. */
export async function callTool(cue: Cue, name: string, rawArgs: unknown, caller: Caller, signal?: AbortSignal): Promise<ToolCallResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { isError: true, status: 404, result: { ok: false, error: `unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}` } };
  try {
    const args = validate<Record<string, unknown>>(tool.inputSchema, rawArgs ?? {});
    const withSession: Caller = { ...caller, session: typeof args.session === 'string' ? args.session : caller.session };
    // A read by a known session still counts as a sign of life.
    if (tool.readOnly && withSession.session && cue.store.getSession(withSession.session)) {
      cue.store.touchSession({ id: withSession.session, source: withSession.via });
    }
    const result = await tool.run(cue, args, withSession, signal);
    return { isError: result.ok === false, status: result.ok === false ? 409 : 200, result };
  } catch (err) {
    if (err instanceof ValidationError) return { isError: true, status: 400, result: { ok: false, error: `invalid input: ${err.issues.join('; ')}` } };
    if (err instanceof UnknownResourceError) return { isError: true, status: 404, result: { ok: false, error: err.message } };
    if (err instanceof CueError) return { isError: true, status: err.status, result: { ok: false, error: err.message } };
    throw err;
  }
}
