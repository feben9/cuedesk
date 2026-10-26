import type { CueConfig } from './config/index.ts';
import { Store, type Ask, type AskKind, type Claim, type Session } from './store/index.ts';
import { createSource, syncSource, type Source, type SyncResult } from './sources/index.ts';
import type { FetchLike } from './sources/github.ts';
import { evaluateRules, type RulesResult } from './rules/index.ts';
import { whatsNext, type WhatsNext } from './ranking/index.ts';
import { buildBrief, type Brief } from './brief/index.ts';
import { Notifier, type PostLike } from './notify/index.ts';
import { formatDuration, iso, MINUTE, systemClock, type Clock } from './util/time.ts';
import { truncate } from './util/misc.ts';

/** Who is calling an operation: a named session, an MCP connection, or the human in the UI. */
export interface Caller {
  via: 'mcp' | 'api' | 'ui' | 'hook' | 'demo';
  /** Session id or label the caller gave explicitly. */
  session?: string | null;
  /** Streamable HTTP session id, used when an MCP client names no session. */
  mcpSessionId?: string | null;
  clientName?: string | null;
}

export class CueError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CueError';
    this.status = status;
  }
}

export interface SourceStatus {
  name: string;
  type: string;
  lastSync: string | null;
  ok: boolean | null;
  error: string | null;
  count: number;
}

export interface CueOptions {
  config: CueConfig;
  store?: Store;
  clock?: Clock;
  sources?: Source[];
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  /** How often rules run. Default 30 s. */
  rulesIntervalMs?: number;
  /** Sends phone alerts; tests pass a fake. Default: fetch. */
  post?: PostLike;
  /** Pause before retrying a failed alert. Default 2 s. */
  alertRetryDelayMs?: number;
  log?: (msg: string) => void;
}

const MAX_WAIT_SECONDS = 600;

/**
 * The core: one store, the configured sources and rules, and every operation
 * the MCP tools, the HTTP API, the hooks endpoint and the UI share.
 */
export class Cue {
  readonly store: Store;
  readonly config: CueConfig;
  readonly sources: Source[];
  readonly sourceStatus = new Map<string, SourceStatus>();
  /** Phone alerts, when "notify" is configured. */
  readonly notifier: Notifier | null;
  private readonly rulesIntervalMs: number;
  private readonly log: (msg: string) => void;
  private timers: NodeJS.Timeout[] = [];
  private syncing: Promise<SyncResult[]> | null = null;
  private stopped = false;

  constructor(opts: CueOptions) {
    this.config = opts.config;
    this.store = opts.store ?? new Store(opts.config.db, opts.clock ?? systemClock);
    this.sources = opts.sources ?? opts.config.sources.map((s) => createSource(s, { fetch: opts.fetch, env: opts.env }));
    this.rulesIntervalMs = opts.rulesIntervalMs ?? 30_000;
    this.log = opts.log ?? (() => undefined);
    this.notifier = opts.config.notify
      ? new Notifier(opts.config.notify, {
          project: opts.config.project,
          quietHours: opts.config.quietHours,
          now: () => this.now(),
          post: opts.post,
          env: opts.env,
          log: this.log,
          retryDelayMs: opts.alertRetryDelayMs,
        })
      : null;
    for (const r of opts.config.resources) this.store.upsertResource(r);
    for (const s of this.sources) {
      this.sourceStatus.set(s.name, { name: s.name, type: s.type, lastSync: null, ok: null, error: null, count: 0 });
    }
  }

  now(): number {
    return this.store.now();
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    void this.syncAll().then(() => this.evaluate());
    this.evaluate();
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref();
      this.timers.push(t);
    };
    every(this.rulesIntervalMs, () => this.evaluate());
    if (this.sources.length) {
      every(Math.max(6_000, this.config.pollMinutes * MINUTE), () => {
        void this.syncAll().then(() => this.evaluate());
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.syncing?.catch(() => undefined);
    await Promise.all(this.sources.map((s) => s.close?.().catch(() => undefined)));
    await this.notifier?.idle();
  }

  /** Reads every source once. Concurrent calls share one run. */
  syncAll(): Promise<SyncResult[]> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const results: SyncResult[] = [];
      for (const s of this.sources) {
        if (this.stopped) break;
        const r = await syncSource(this.store, s);
        results.push(r);
        this.sourceStatus.set(s.name, {
          name: s.name,
          type: s.type,
          lastSync: iso(this.now()),
          ok: r.ok,
          error: r.ok ? null : r.error,
          count: r.ok ? r.count : (this.sourceStatus.get(s.name)?.count ?? 0),
        });
        if (!r.ok) this.log(`source ${s.name}: ${r.error}`);
      }
      return results;
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  evaluate(): RulesResult {
    const result = evaluateRules(this.store, this.config.rules);
    for (const s of result.fired) void this.notifier?.signalFired(s);
    return result;
  }

  /** Tells the phone about a new ask, if alerts for asks are on. */
  announceAsk(ask: Ask): void {
    void this.notifier?.askCreated(ask);
  }

  // ------------------------------------------------------------- sessions

  /**
   * Finds or creates the session a caller speaks for. An explicit name wins
   * (matched by id, then label); an MCP connection without a name gets its own.
   */
  resolveSession(caller: Caller, opts: { required?: boolean } = {}): string | null {
    const given = caller.session?.trim();
    if (given) {
      const byId = this.store.getSession(given);
      if (byId) {
        this.store.touchSession({ id: byId.id, source: byId.source });
        return byId.id;
      }
      const byLabel = this.store.listSessions({ includeEnded: true }).find((s) => s.label.toLowerCase() === given.toLowerCase());
      if (byLabel) {
        this.store.touchSession({ id: byLabel.id, source: byLabel.source });
        return byLabel.id;
      }
      const { session } = this.store.touchSession({ id: given, source: caller.via, label: given });
      this.store.addEvent({ type: 'session.started', sessionId: session.id, summary: `${session.label} checked in (${caller.via})` });
      return session.id;
    }
    if (caller.mcpSessionId) {
      const id = `mcp-${caller.mcpSessionId.replace(/-/g, '').slice(0, 8)}`;
      const label = `${caller.clientName || 'mcp client'} · ${id.slice(4)}`;
      const { session, created } = this.store.touchSession({ id, source: 'mcp', label });
      if (created) this.store.addEvent({ type: 'session.started', sessionId: id, summary: `${session.label} connected over MCP` });
      return id;
    }
    if (opts.required) throw new CueError('name the session: pass "session" (an id or a label) so Cue knows who is asking');
    return null;
  }

  listSessions(opts: { includeEnded?: boolean } = {}) {
    const now = this.now();
    const claims = this.store.liveClaims();
    const openAsks = this.store.listAsks({ status: 'open' });
    const silentSignals = this.store.listSignals({ status: 'live' }).filter((s) => s.subjectType === 'session');
    return this.store.listSessions(opts).map((s: Session) => ({
      id: s.id,
      label: s.label,
      source: s.source,
      state: s.state,
      activity: s.activity,
      cwd: s.cwd,
      firstSeen: iso(s.firstSeen),
      lastSeen: iso(s.lastSeen),
      silentFor: formatDuration(now - s.lastSeen),
      silentMs: now - s.lastSeen,
      flagged: silentSignals.some((sig) => sig.subjectId === s.id),
      holds: claims.filter((c) => c.sessionId === s.id).map((c) => ({ resourceId: c.resourceId, reason: c.reason, expiresAt: iso(c.expiresAt) })),
      openAsks: openAsks.filter((a) => a.sessionId === s.id).length,
    }));
  }

  // ----------------------------------------------------------------- asks

  askHuman(
    input: { summary: string; details?: string; kind?: AskKind; dueMinutes?: number; tags?: string[]; askedBy?: string },
    caller: Caller,
  ): Ask {
    const sessionId = this.resolveSession(caller);
    const askedBy = input.askedBy?.trim() || (sessionId ? this.store.sessionLabel(sessionId) : caller.via === 'ui' ? 'you' : 'a script');
    const ask = this.store.createAsk({
      summary: input.summary,
      details: input.details ?? null,
      kind: input.kind ?? 'answer',
      sessionId,
      askedBy,
      origin: caller.via,
      tags: input.tags,
      dueMinutes: input.dueMinutes ?? null,
    });
    if (sessionId) this.store.setSessionState(sessionId, 'waiting');
    this.store.addEvent({
      type: 'ask.created',
      sessionId,
      subjectType: 'ask',
      subjectId: ask.id,
      summary: `${askedBy} asked (${ask.kind}): ${truncate(ask.summary, 140)}`,
    });
    this.announceAsk(ask);
    return ask;
  }

  /** Waits for an answer, polling the store, up to `seconds`. */
  async waitForAnswer(askId: string, seconds: number, signal?: AbortSignal): Promise<Ask> {
    const deadline = Date.now() + Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
    for (;;) {
      const ask = this.store.getAsk(askId);
      if (!ask) throw new CueError(`no ask with id ${askId}`, 404);
      if (ask.status !== 'open' || Date.now() >= deadline || signal?.aborted || this.stopped) return ask;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  getAsk(askId: string): Ask {
    const ask = this.store.getAsk(askId);
    if (!ask) throw new CueError(`no ask with id ${askId}`, 404);
    return ask;
  }

  private afterAskClosed(ask: Ask): void {
    if (!ask.sessionId) return;
    const stillOpen = this.store.listAsks({ status: 'open', sessionId: ask.sessionId }).length;
    const session = this.store.getSession(ask.sessionId);
    if (session && session.state === 'waiting' && stillOpen === 0) this.store.setSessionState(ask.sessionId, 'working');
  }

  answerAsk(askId: string, answer: string, by = 'you'): Ask {
    const current = this.getAsk(askId);
    if (current.status !== 'open') throw new CueError(`ask ${askId} is already ${current.status}`, 409);
    const ask = this.store.closeAsk(askId, 'answered', answer)!;
    this.store.addEvent({
      type: 'ask.answered',
      sessionId: ask.sessionId,
      subjectType: 'ask',
      subjectId: ask.id,
      summary: `${by} answered ${ask.askedBy}: "${truncate(answer, 100)}" (to: ${truncate(ask.summary, 80)})`,
    });
    this.afterAskClosed(ask);
    this.evaluate();
    return ask;
  }

  dismissAsk(askId: string, by = 'you'): Ask {
    const current = this.getAsk(askId);
    if (current.status !== 'open') throw new CueError(`ask ${askId} is already ${current.status}`, 409);
    const ask = this.store.closeAsk(askId, 'dismissed', null)!;
    this.store.addEvent({ type: 'ask.dismissed', sessionId: ask.sessionId, subjectType: 'ask', subjectId: ask.id, summary: `${by} dismissed: ${truncate(ask.summary, 120)}` });
    this.afterAskClosed(ask);
    this.evaluate();
    return ask;
  }

  snoozeAsk(askId: string, minutes: number): Ask {
    const current = this.getAsk(askId);
    if (current.status !== 'open') throw new CueError(`ask ${askId} is already ${current.status}`, 409);
    const ask = this.store.snoozeAsk(askId, this.now() + minutes * MINUTE)!;
    this.store.addEvent({ type: 'ask.snoozed', sessionId: ask.sessionId, subjectType: 'ask', subjectId: ask.id, summary: `Snoozed for ${formatDuration(minutes * MINUTE)}: ${truncate(ask.summary, 120)}` });
    this.evaluate();
    return ask;
  }

  // ------------------------------------------------------------- progress

  reportProgress(summary: string, item: string | undefined, caller: Caller): { eventId: number; sessionId: string } {
    const sessionId = this.resolveSession(caller, { required: true })!;
    const session = this.store.getSession(sessionId)!;
    this.store.setSessionState(sessionId, session.state === 'waiting' ? 'waiting' : 'working', truncate(summary, 200));
    const eventId = this.store.addEvent({
      type: 'progress',
      sessionId,
      subjectType: item ? 'item' : null,
      subjectId: item ?? null,
      summary: item ? `${item}: ${summary}` : summary,
    });
    return { eventId, sessionId };
  }

  // --------------------------------------------------------------- claims

  claim(resourceId: string, reason: string, minutes: number, caller: Caller) {
    const sessionId = this.resolveSession(caller, { required: true })!;
    const r = this.store.claimResource(resourceId, sessionId, reason, minutes);
    this.evaluate();
    return r;
  }

  release(resourceId: string, caller: Caller, opts: { force?: boolean } = {}) {
    const fromHuman = caller.via === 'ui';
    const sessionId = fromHuman ? null : this.resolveSession(caller, { required: true });
    const r = this.store.releaseResource(resourceId, sessionId, { force: fromHuman || opts.force, by: fromHuman ? 'you' : undefined });
    this.evaluate();
    return r;
  }

  listResources() {
    const claims = this.store.liveClaims();
    return this.store.listResources().map((r) => {
      const c: Claim | undefined = claims.find((x) => x.resourceId === r.id);
      return {
        ...r,
        holder: c
          ? {
              sessionId: c.sessionId,
              label: this.store.sessionLabel(c.sessionId),
              reason: c.reason,
              since: iso(c.claimedAt),
              expiresAt: iso(c.expiresAt),
            }
          : null,
      };
    });
  }

  // -------------------------------------------------------------- signals

  listSignals(status: 'live' | 'open' | 'all' = 'live') {
    return this.store.listSignals({ status }).map((s) => ({
      ...s,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      resolvedAt: iso(s.resolvedAt),
      snoozedUntil: iso(s.snoozedUntil),
    }));
  }

  dismissSignal(id: string) {
    const s = this.store.getSignal(id);
    if (!s) throw new CueError(`no signal with id ${id}`, 404);
    if (s.status !== 'open') throw new CueError(`signal ${id} is already ${s.status}`, 409);
    const out = this.store.dismissSignal(id)!;
    this.store.addEvent({ type: 'signal.dismissed', subjectType: s.subjectType, subjectId: s.subjectId, summary: `You dismissed: ${truncate(s.title, 140)}` });
    return out;
  }

  snoozeSignal(id: string, minutes: number) {
    const s = this.store.getSignal(id);
    if (!s) throw new CueError(`no signal with id ${id}`, 404);
    if (s.status !== 'open') throw new CueError(`signal ${id} is already ${s.status}`, 409);
    return this.store.snoozeSignal(id, this.now() + minutes * MINUTE)!;
  }

  // ---------------------------------------------------------------- views

  whatsNext(): WhatsNext {
    return whatsNext(this.store, this.config);
  }

  since(ts: number): Brief {
    return buildBrief(this.store, ts);
  }

  board() {
    const now = this.now();
    const stale = new Map<string, { severity: string; title: string }>();
    for (const s of this.store.listSignals({ status: 'live' })) {
      if (s.subjectType === 'item') stale.set(s.subjectId, { severity: s.severity, title: s.title });
    }
    return this.store.listItems().map((i) => ({
      key: `${i.source}:${i.id}`,
      source: i.source,
      id: i.id,
      title: i.title,
      status: i.status,
      stage: i.stage,
      url: i.url,
      assignee: i.assignee,
      updatedAt: iso(i.updatedAt),
      idleFor: formatDuration(now - i.updatedAt),
      idleMs: now - i.updatedAt,
      stale: stale.get(`${i.source}:${i.id}`) ?? null,
    }));
  }

  /** Everything the UI shows, in one response. */
  state() {
    return {
      project: this.config.project,
      preset: this.config.preset,
      now: iso(this.now()),
      whatsNext: this.whatsNext(),
      sessions: this.listSessions(),
      resources: this.listResources(),
      board: this.board(),
      sources: [...this.sourceStatus.values()],
      rules: this.config.rules.map((r) => ({ id: r.id, severity: r.severity, describe: r.describe })),
    };
  }
}
