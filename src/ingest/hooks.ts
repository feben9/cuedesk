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
function closeHookAsks(cue: Cue, sessionId: string): number {
  let closed = 0;
  for (const ask of cue.store.listAsks({ status: 'open', sessionId })) {
    if (ask.origin !== 'hook') continue;
    cue.store.closeAsk(ask.id, 'answered', HANDLED_IN_TERMINAL);
    cue.store.addEvent({
      type: 'ask.answered',
      sessionId,
      subjectType: 'ask',
      subjectId: ask.id,
      summary: `${ask.askedBy} moved on (handled in the terminal): ${truncate(ask.summary, 100)}`,
    });
    closed++;
  }
  return closed;
}

/**
 * Turns a Claude Code hook event into Cue state:
 *   SessionStart  session seen, working
 *   Notification  an Ask (permission prompts become "approve" asks)
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
    case 'Notification': {
      if (p.notification_type === 'auth_success') return { ...base, ignored: true };
      const message = (p.message ?? 'Claude Code needs your attention').trim();
      const summary = truncate(message, 200);
      const dup = store.listAsks({ status: 'open', sessionId: id }).find((a) => a.origin === 'hook' && a.summary === summary);
      if (dup) return { ...base, askId: dup.id };
      const ask = store.createAsk({ summary, kind: askKind(p), sessionId: id, askedBy: session.label, origin: 'hook' });
      store.setSessionState(id, 'waiting', summary);
      store.addEvent({ type: 'ask.created', sessionId: id, subjectType: 'ask', subjectId: ask.id, summary: `${session.label} is waiting: ${summary}` });
      cue.evaluate();
      return { ...base, askId: ask.id };
    }
    case 'Stop': {
      const closedAsks = closeHookAsks(cue, id);
      if (before && before.state !== 'idle') {
        store.addEvent({ type: 'session.idle', sessionId: id, summary: `${session.label} finished its turn` });
      }
      store.setSessionState(id, 'idle', 'finished its turn');
      if (closedAsks) cue.evaluate();
      return { ...base, closedAsks };
    }
    case 'SessionEnd': {
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
      // PreToolUse, PostToolUse, UserPromptSubmit and friends: a heartbeat.
      if (before?.state === 'idle' || before?.state === 'ended') store.setSessionState(id, 'working');
      return { ...base, ignored: true };
  }
}
