import { basename } from 'node:path';
import { CueError, type Cue } from '../cue.ts';
import type { AskKind } from '../store/types.ts';
import { truncate } from '../util/misc.ts';

/**
 * The documented common fields of a Claude Code hook payload, plus the
 * per-event ones Cue reads. Anything else in the payload is ignored.
 */
export interface ClaudeHookPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  message?: string; // Notification
  notification_type?: string; // Notification, newer Claude Code versions
  source?: string; // SessionStart: startup | resume | clear | compact
  reason?: string; // SessionEnd
  tool_name?: string; // PreToolUse, PostToolUse
  tool_input?: Record<string, unknown>; // PreToolUse, PostToolUse
}

export interface HookResult {
  ok: true;
  event: string;
  sessionId: string;
  askId?: string;
  closedAsks?: number;
  released?: string[];
  ignored?: boolean;
}

const HANDLED_IN_TERMINAL = '(handled in the terminal)';
const APPROVED_IN_TERMINAL = '(approved in the terminal)';

/** How long a tool call announced by PreToolUse can explain a permission prompt. */
const PENDING_TOOL_MS = 2 * 60_000;

interface PendingTool {
  /** "run: npm test", "edit src/app.ts", "use github › create_issue" */
  action: string;
  /** What the agent said the call is for, when the tool carries that (Bash does). */
  purpose: string | null;
  at: number;
}

/** The last tool call each session announced, per Cue instance. Memory only. */
const pendingTools = new WeakMap<Cue, Map<string, PendingTool>>();

function pendingFor(cue: Cue): Map<string, PendingTool> {
  let m = pendingTools.get(cue);
  if (!m) pendingTools.set(cue, (m = new Map()));
  return m;
}

/**
 * Describes a tool call in a few words, from the tool's name and input:
 * enough to decide on a permission prompt without going to the terminal.
 */
export function describeTool(name: string, input: Record<string, unknown> = {}): { action: string; purpose: string | null } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const oneLine = (t: string) => truncate(t.replace(/\s+/g, ' '), 160);
  const purpose = str('description') ? oneLine(str('description')) : null;
  const path = str('file_path') || str('notebook_path') || str('path');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  let action: string;
  if (name === 'Bash' && str('command')) action = `run: ${oneLine(str('command'))}`;
  else if ((name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') && path) action = `edit ${path}`;
  else if (name === 'Write' && path) action = `write ${path}`;
  else if (name === 'Read' && path) action = `read ${path}`;
  else if (name === 'WebFetch' && str('url')) action = `fetch ${oneLine(str('url'))}`;
  else if (name === 'WebSearch' && str('query')) action = `search the web for "${oneLine(str('query'))}"`;
  else if (mcp) action = `use ${mcp[1]} › ${mcp[2]}`;
  else action = `use ${name}`;
  return { action, purpose };
}

function parsePayload(body: unknown): ClaudeHookPayload {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CueError('hook payload must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.hook_event_name !== 'string' || !b.hook_event_name) throw new CueError('hook payload needs hook_event_name');
  if (typeof b.session_id !== 'string' || !b.session_id.trim()) throw new CueError('hook payload needs session_id');
  if (b.session_id.length > 200) throw new CueError('session_id is too long');
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
  return {
    hook_event_name: b.hook_event_name,
    session_id: b.session_id.trim(),
    transcript_path: str('transcript_path'),
    cwd: str('cwd'),
    message: str('message'),
    notification_type: str('notification_type'),
    source: str('source'),
    reason: str('reason'),
    tool_name: str('tool_name'),
    tool_input: typeof b.tool_input === 'object' && b.tool_input !== null && !Array.isArray(b.tool_input) ? (b.tool_input as Record<string, unknown>) : undefined,
  };
}

function labelFor(p: ClaudeHookPayload): string {
  const dir = p.cwd ? basename(p.cwd) : 'claude';
  return `${dir} · ${p.session_id.slice(0, 6)}`;
}

function askKind(p: ClaudeHookPayload): AskKind {
  if (p.notification_type === 'permission_prompt' || /permission|approve|allow/i.test(p.message ?? '')) return 'approve';
  return 'answer';
}

/** Closes the asks a hook raised for this session: the session moved on, so the human handled them. */
function closeHookAsks(cue: Cue, sessionId: string, how: 'handled' | 'approved' = 'handled'): number {
  let closed = 0;
  for (const ask of cue.store.listAsks({ status: 'open', sessionId })) {
    if (ask.origin !== 'hook') continue;
    cue.store.closeAsk(ask.id, 'answered', how === 'approved' ? APPROVED_IN_TERMINAL : HANDLED_IN_TERMINAL);
    cue.store.addEvent({
      type: 'ask.answered',
      sessionId,
      subjectType: 'ask',
      subjectId: ask.id,
      summary: `${ask.askedBy} moved on (${how === 'approved' ? 'approved' : 'handled'} in the terminal): ${truncate(ask.summary, 100)}`,
    });
    closed++;
  }
  return closed;
}

/**
 * Turns a Claude Code hook event into Cue state:
 *   SessionStart  session seen, working
 *   PreToolUse    session working on that tool call; remembered so a
 *                 permission prompt can say what it is for
 *   Notification  an Ask (permission prompts become "approve" asks)
 *   PostToolUse   the tool ran, so any prompt for it was approved: close it
 *   Stop          session idle; asks it raised are closed as handled
 *   SessionEnd    session ended; its claims are released
 * Other events count as a heartbeat.
 */
export function ingestClaudeHook(cue: Cue, body: unknown): HookResult {
  const p = parsePayload(body);
  const store = cue.store;
  const id = p.session_id;
  const before = store.getSession(id);
  const { session, created } = store.touchSession({
    id,
    source: 'claude-code',
    label: before ? null : labelFor(p),
    cwd: p.cwd ?? null,
    transcriptPath: p.transcript_path ?? null,
  });
  const base = { ok: true as const, event: p.hook_event_name, sessionId: id };

  switch (p.hook_event_name) {
    case 'SessionStart': {
      store.setSessionState(id, 'working', `started (${p.source ?? 'startup'})`);
      if (created || before?.state === 'ended' || p.source === 'resume') {
        store.addEvent({ type: 'session.started', sessionId: id, summary: `${session.label} started (${p.source ?? 'startup'})` });
      }
      return base;
    }
    case 'PreToolUse': {
      if (!p.tool_name) return { ...base, ignored: true };
      const { action, purpose } = describeTool(p.tool_name, p.tool_input);
      pendingFor(cue).set(id, { action, purpose, at: cue.now() });
      store.setSessionState(id, 'working', truncate(`${action[0]!.toUpperCase()}${action.slice(1)}`, 200));
      return base;
    }
    case 'PostToolUse': {
      pendingFor(cue).delete(id);
      const closedAsks = closeHookAsks(cue, id, 'approved');
      if (before?.state !== 'working') store.setSessionState(id, 'working');
      if (closedAsks) cue.evaluate();
      return { ...base, closedAsks };
    }
    case 'Notification': {
      if (p.notification_type === 'auth_success') return { ...base, ignored: true };
      const message = (p.message ?? 'Claude Code needs your attention').trim();
      const kind = askKind(p);
      // A permission prompt says only "Claude needs your permission"; the
      // tool call announced just before it says what for.
      const pending = pendingFor(cue).get(id);
      const tool = kind === 'approve' && pending && cue.now() - pending.at < PENDING_TOOL_MS ? pending : null;
      const summary = truncate(tool ? `Claude wants to ${tool.action}` : message, 200);
      const details = tool ? [tool.purpose, message].filter(Boolean).join('\n') : null;
      const dup = store.listAsks({ status: 'open', sessionId: id }).find((a) => a.origin === 'hook' && a.summary === summary);
      if (dup) return { ...base, askId: dup.id };
      const ask = store.createAsk({ summary, details, kind, sessionId: id, askedBy: session.label, origin: 'hook' });
      store.setSessionState(id, 'waiting', summary);
      store.addEvent({ type: 'ask.created', sessionId: id, subjectType: 'ask', subjectId: ask.id, summary: `${session.label} is waiting: ${summary}` });
      cue.evaluate();
      return { ...base, askId: ask.id };
    }
    case 'Stop': {
      pendingFor(cue).delete(id);
      const closedAsks = closeHookAsks(cue, id);
      if (before && before.state !== 'idle') {
        store.addEvent({ type: 'session.idle', sessionId: id, summary: `${session.label} finished its turn` });
      }
      store.setSessionState(id, 'idle', 'finished its turn');
      if (closedAsks) cue.evaluate();
      return { ...base, closedAsks };
    }
    case 'SessionEnd': {
      pendingFor(cue).delete(id);
      const closedAsks = closeHookAsks(cue, id);
      const released: string[] = [];
      for (const c of store.claimsHeldBy(id)) {
        const r = store.releaseResource(c.resourceId, id, { force: true, reason: 'session ended' });
        if (r.ok) released.push(c.resourceId);
      }
      store.setSessionState(id, 'ended', `ended (${p.reason ?? 'other'})`);
      store.addEvent({
        type: 'session.ended',
        sessionId: id,
        summary: `${session.label} ended (${p.reason ?? 'other'})${released.length ? `; released ${released.join(', ')}` : ''}`,
      });
      cue.evaluate();
      return { ...base, closedAsks, released };
    }
    default:
      // UserPromptSubmit, SubagentStop, PreCompact and friends: a heartbeat.
      if (before?.state === 'idle' || before?.state === 'ended') store.setSessionState(id, 'working');
      return { ...base, ignored: true };
  }
}
