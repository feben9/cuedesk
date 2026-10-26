import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';
import type { Ask, AskKind, Claim, CueEvent, Item, Resource, Session, SessionState, Severity, Signal, Stage } from './types.ts';
import { systemClock, type Clock, MINUTE } from '../util/time.ts';
import { newId } from '../util/misc.ts';

export * from './types.ts';

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toSession(r: Row): Session {
  return {
    id: String(r.id),
    label: String(r.label),
    source: String(r.source),
    cwd: strOrNull(r.cwd),
    transcriptPath: strOrNull(r.transcript_path),
    state: r.state as SessionState,
    activity: strOrNull(r.activity),
    firstSeen: num(r.first_seen),
    lastSeen: num(r.last_seen),
  };
}

function toAsk(r: Row): Ask {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(r.tags ?? '[]'));
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  return {
    id: String(r.id),
    sessionId: strOrNull(r.session_id),
    kind: r.kind as AskKind,
    summary: String(r.summary),
    details: strOrNull(r.details),
    askedBy: String(r.asked_by),
    origin: String(r.origin),
    tags,
    createdAt: num(r.created_at),
    dueAt: numOrNull(r.due_at),
    status: r.status as Ask['status'],
    answer: strOrNull(r.answer),
    answeredAt: numOrNull(r.answered_at),
    snoozedUntil: numOrNull(r.snoozed_until),
  };
}

function toItem(r: Row): Item {
  return {
    source: String(r.source),
    id: String(r.id),
    title: String(r.title),
    status: String(r.status),
    stage: r.stage as Stage,
    url: strOrNull(r.url),
    assignee: strOrNull(r.assignee),
    updatedAt: num(r.updated_at),
    stageSince: num(r.stage_since),
    firstSeen: num(r.first_seen),
    lastSynced: num(r.last_synced),
    gone: num(r.gone) === 1,
  };
}

function toClaim(r: Row): Claim {
  return {
    id: num(r.id),
    resourceId: String(r.resource_id),
    sessionId: String(r.session_id),
    reason: String(r.reason),
    claimedAt: num(r.claimed_at),
    expiresAt: num(r.expires_at),
    releasedAt: numOrNull(r.released_at),
    releaseReason: strOrNull(r.release_reason),
  };
}

function toSignal(r: Row): Signal {
  return {
    id: String(r.id),
    ruleId: String(r.rule_id),
    key: String(r.key),
    subjectType: r.subject_type as Signal['subjectType'],
    subjectId: String(r.subject_id),
    severity: r.severity as Severity,
    title: String(r.title),
    detail: strOrNull(r.detail),
    link: strOrNull(r.link),
    source: String(r.source),
    status: r.status as Signal['status'],
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    resolvedAt: numOrNull(r.resolved_at),
    snoozedUntil: numOrNull(r.snoozed_until),
  };
}

function toEvent(r: Row): CueEvent {
  let data: Record<string, unknown> | null = null;
  if (r.data) {
    try {
      data = JSON.parse(String(r.data));
    } catch {
      data = null;
    }
  }
  return {
    id: num(r.id),
    ts: num(r.ts),
    type: String(r.type),
    sessionId: strOrNull(r.session_id),
    subjectType: strOrNull(r.subject_type),
    subjectId: strOrNull(r.subject_id),
    summary: String(r.summary),
    data,
  };
}

export interface NewEvent {
  type: string;
  summary: string;
  sessionId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  data?: Record<string, unknown> | null;
  ts?: number;
}

export interface NewAsk {
  summary: string;
  details?: string | null;
  kind?: AskKind;
  sessionId?: string | null;
  askedBy: string;
  origin: string;
  tags?: string[];
  dueMinutes?: number | null;
  createdAt?: number;
}

export interface SourceItemInput {
  id: string;
  title: string;
  status: string;
  stage: Stage;
  url?: string | null;
  assignee?: string | null;
  /** Null when the tracker gives no update time; Cue then counts from when it saw the change. */
  updatedAt: number | null;
}

export interface ItemChanges {
  added: Item[];
  moved: { item: Item; from: Stage; to: Stage }[];
  gone: Item[];
}

export type ClaimResult =
  | { ok: true; claim: Claim; renewed: boolean }
  | { ok: false; holder: Claim; holderLabel: string; message: string };

export type ReleaseResult =
  | { ok: true; claim: Claim }
  | { ok: false; message: string; holder?: Claim };

export class UnknownResourceError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown resource "${id}". Known resources: ${known.length ? known.join(', ') : '(none configured)'}`);
    this.name = 'UnknownResourceError';
  }
}

/**
 * All persistent state lives here, in one SQLite file. Every method is
 * synchronous; a fresh process can rebuild its whole view from the file.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly now: Clock;

  constructor(path = ':memory:', clock: Clock = systemClock) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = clock;
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema v${current} is newer than this Cue (v${SCHEMA_VERSION}); upgrade Cue`);
    }
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // ---------------------------------------------------------------- events

  addEvent(e: NewEvent): number {
    const res = this.run(
      'INSERT INTO events (ts, type, session_id, subject_type, subject_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.ts ?? this.now(),
      e.type,
      e.sessionId ?? null,
      e.subjectType ?? null,
      e.subjectId ?? null,
      e.summary,
      e.data ? JSON.stringify(e.data) : null,
    );
    return Number(res.lastInsertRowid);
  }

  eventsSince(ts: number, limit = 500): CueEvent[] {
    return this.all('SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC, id ASC LIMIT ?', ts, limit).map(toEvent);
  }

  countEventsSince(ts: number): number {
    return num(this.get('SELECT COUNT(*) AS n FROM events WHERE ts >= ?', ts)!.n);
  }

  // -------------------------------------------------------------- sessions

  getSession(id: string): Session | null {
    const r = this.get('SELECT * FROM sessions WHERE id = ?', id);
    return r ? toSession(r) : null;
  }

  /**
   * Creates the session on first sight and marks it as seen now. Returns the
   * session and whether it was new.
   */
  touchSession(input: {
    id: string;
    source: string;
    label?: string | null;
    cwd?: string | null;
    transcriptPath?: string | null;
    state?: SessionState;
    activity?: string | null;
    at?: number;
  }): { session: Session; created: boolean } {
    const at = input.at ?? this.now();
    const existing = this.getSession(input.id);
    if (!existing) {
      this.run(
        `INSERT INTO sessions (id, label, source, cwd, transcript_path, state, activity, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.label?.trim() || input.id,
        input.source,
        input.cwd ?? null,
        input.transcriptPath ?? null,
        input.state ?? 'working',
        input.activity ?? null,
        at,
        at,
      );
      return { session: this.getSession(input.id)!, created: true };
    }
    this.run(
      `UPDATE sessions SET
         label = COALESCE(?, label),
         cwd = COALESCE(?, cwd),
         transcript_path = COALESCE(?, transcript_path),
         state = COALESCE(?, state),
         activity = COALESCE(?, activity),
         last_seen = MAX(last_seen, ?)
       WHERE id = ?`,
      input.label?.trim() || null,
      input.cwd ?? null,
      input.transcriptPath ?? null,
      input.state ?? null,
      input.activity ?? null,
      at,
      input.id,
    );
    return { session: this.getSession(input.id)!, created: false };
  }

  setSessionState(id: string, state: SessionState, activity?: string | null): void {
    if (activity === undefined) this.run('UPDATE sessions SET state = ? WHERE id = ?', state, id);
    else this.run('UPDATE sessions SET state = ?, activity = ? WHERE id = ?', state, activity, id);
  }

  listSessions(opts: { includeEnded?: boolean } = {}): Session[] {
    const sql = opts.includeEnded
      ? 'SELECT * FROM sessions ORDER BY last_seen DESC'
      : "SELECT * FROM sessions WHERE state != 'ended' ORDER BY last_seen DESC";
    return this.all(sql).map(toSession);
  }

  sessionLabel(id: string | null): string {
    if (!id) return 'someone';
    return this.getSession(id)?.label ?? id;
  }

  // ------------------------------------------------------------------ asks

  createAsk(input: NewAsk): Ask {
    const id = newId('ask');
    const createdAt = input.createdAt ?? this.now();
    const dueAt = input.dueMinutes ? createdAt + input.dueMinutes * MINUTE : null;
    this.run(
      `INSERT INTO asks (id, session_id, kind, summary, details, asked_by, origin, tags, created_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId ?? null,
      input.kind ?? 'answer',
      input.summary.trim(),
      input.details ?? null,
      input.askedBy,
      input.origin,
      JSON.stringify(input.tags ?? []),
      createdAt,
      dueAt,
    );
    return this.getAsk(id)!;
  }

  getAsk(id: string): Ask | null {
    const r = this.get('SELECT * FROM asks WHERE id = ?', id);
    return r ? toAsk(r) : null;
  }

  listAsks(opts: { status?: Ask['status'] | 'all'; sessionId?: string; limit?: number } = {}): Ask[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.status && opts.status !== 'all') {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(opts.sessionId);
    }
    const sql = `SELECT * FROM asks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`;
    return this.all(sql, ...params, opts.limit ?? 1000).map(toAsk);
  }

  /** Sets the final status of an open ask. Returns null when it was not open. */
  closeAsk(id: string, status: 'answered' | 'dismissed', answer: string | null): Ask | null {
    const res = this.run(
      "UPDATE asks SET status = ?, answer = ?, answered_at = ?, snoozed_until = NULL WHERE id = ? AND status = 'open'",
      status,
      answer,
      this.now(),
      id,
    );
    return res.changes ? this.getAsk(id) : null;
  }

  snoozeAsk(id: string, until: number): Ask | null {
    const res = this.run("UPDATE asks SET snoozed_until = ? WHERE id = ? AND status = 'open'", until, id);
    return res.changes ? this.getAsk(id) : null;
  }

  // ----------------------------------------------------------------- items

  getItem(source: string, id: string): Item | null {
    const r = this.get('SELECT * FROM items WHERE source = ? AND id = ?', source, id);
    return r ? toItem(r) : null;
  }

  listItems(opts: { includeGone?: boolean; stage?: Stage; source?: string } = {}): Item[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (!opts.includeGone) where.push('gone = 0');
    if (opts.stage) {
      where.push('stage = ?');
      params.push(opts.stage);
    }
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    const sql = `SELECT * FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at ASC`;
    return this.all(sql, ...params).map(toItem);
  }

  /**
   * Replaces the view of one source with a fresh fetch. Items missing from the
   * fetch are marked gone (closed, or no longer matched by the query).
   */
  syncItems(source: string, fetched: SourceItemInput[]): ItemChanges {
    const now = this.now();
    const changes: ItemChanges = { added: [], moved: [], gone: [] };
    this.tx(() => {
      const seen = new Set<string>();
      for (const f of fetched) {
        seen.add(f.id);
        const existing = this.getItem(source, f.id);
        if (!existing) {
          this.run(
            `INSERT INTO items (source, id, title, status, stage, url, assignee, updated_at, stage_since, first_seen, last_synced, gone)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            source, f.id, f.title, f.status, f.stage, f.url ?? null, f.assignee ?? null, f.updatedAt ?? now, f.updatedAt ?? now, now, now,
          );
          changes.added.push(this.getItem(source, f.id)!);
          continue;
        }
        const stageChanged = existing.stage !== f.stage;
        const changed = stageChanged || existing.status !== f.status || existing.title !== f.title;
        const updatedAt = f.updatedAt ?? (changed ? now : existing.updatedAt);
        this.run(
          `UPDATE items SET title = ?, status = ?, stage = ?, url = ?, assignee = ?, updated_at = ?,
             stage_since = ?, last_synced = ?, gone = 0 WHERE source = ? AND id = ?`,
          f.title, f.status, f.stage, f.url ?? null, f.assignee ?? null, updatedAt,
          stageChanged ? updatedAt : existing.stageSince, now, source, f.id,
        );
        if (stageChanged) changes.moved.push({ item: this.getItem(source, f.id)!, from: existing.stage, to: f.stage });
      }
      for (const item of this.listItems({ source })) {
        if (!seen.has(item.id)) {
          this.run('UPDATE items SET gone = 1, last_synced = ? WHERE source = ? AND id = ?', now, source, item.id);
          changes.gone.push({ ...item, gone: true });
        }
      }
    });
    return changes;
  }

  // ------------------------------------------------------------- resources

  upsertResource(r: { id: string; kind?: string; label?: string }): void {
    this.run(
      `INSERT INTO resources (id, kind, label) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label`,
      r.id,
      r.kind ?? 'resource',
      r.label ?? r.id,
    );
  }

  listResources(): Resource[] {
    return this.all('SELECT * FROM resources ORDER BY id').map((r) => ({ id: String(r.id), kind: String(r.kind), label: String(r.label) }));
  }

  getResource(id: string): Resource | null {
    const r = this.get('SELECT * FROM resources WHERE id = ?', id);
    return r ? { id: String(r.id), kind: String(r.kind), label: String(r.label) } : null;
  }

  // ---------------------------------------------------------------- claims

  /** Marks claims past their expiry as released. Returns the ones it expired. */
  expireClaims(): Claim[] {
    const now = this.now();
    const expired = this.all('SELECT * FROM claims WHERE released_at IS NULL AND expires_at <= ?', now).map(toClaim);
    for (const c of expired) {
      this.run("UPDATE claims SET released_at = expires_at, release_reason = 'expired' WHERE id = ?", c.id);
      this.addEvent({
        type: 'claim.expired',
        sessionId: c.sessionId,
        subjectType: 'resource',
        subjectId: c.resourceId,
        summary: `${this.sessionLabel(c.sessionId)}'s claim on ${c.resourceId} expired`,
        ts: c.expiresAt,
      });
    }
    return expired;
  }

  liveClaims(): Claim[] {
    this.expireClaims();
    return this.all('SELECT * FROM claims WHERE released_at IS NULL ORDER BY claimed_at').map(toClaim);
  }

  liveClaim(resourceId: string): Claim | null {
    this.expireClaims();
    const r = this.get('SELECT * FROM claims WHERE resource_id = ? AND released_at IS NULL', resourceId);
    return r ? toClaim(r) : null;
  }

  claimsHeldBy(sessionId: string): Claim[] {
    this.expireClaims();
    return this.all('SELECT * FROM claims WHERE session_id = ? AND released_at IS NULL', sessionId).map(toClaim);
  }

  describeHolder(c: Claim): string {
    const label = this.sessionLabel(c.sessionId);
    const who = label === c.sessionId ? label : `${label} (session ${c.sessionId})`;
    return `${c.resourceId} is held by ${who} for "${c.reason}" since ${new Date(c.claimedAt).toISOString()}, until ${new Date(c.expiresAt).toISOString()}`;
  }

  claimResource(resourceId: string, sessionId: string, reason: string, minutes: number): ClaimResult {
    if (!this.getResource(resourceId)) throw new UnknownResourceError(resourceId, this.listResources().map((r) => r.id));
    const now = this.now();
    const current = this.liveClaim(resourceId);
    if (current && current.sessionId !== sessionId) {
      const message = `Refused: ${this.describeHolder(current)}.`;
      this.addEvent({
        type: 'claim.refused',
        sessionId,
        subjectType: 'resource',
        subjectId: resourceId,
        summary: `${this.sessionLabel(sessionId)} asked for ${resourceId}, held by ${this.sessionLabel(current.sessionId)}`,
      });
      return { ok: false, holder: current, holderLabel: this.sessionLabel(current.sessionId), message };
    }
    const expiresAt = now + minutes * MINUTE;
    if (current) {
      this.run('UPDATE claims SET reason = ?, expires_at = ? WHERE id = ?', reason, expiresAt, current.id);
      this.addEvent({
        type: 'claim.renewed',
        sessionId,
        subjectType: 'resource',
        subjectId: resourceId,
        summary: `${this.sessionLabel(sessionId)} renewed ${resourceId} for ${minutes} min`,
      });
      return { ok: true, claim: toClaim(this.get('SELECT * FROM claims WHERE id = ?', current.id)!), renewed: true };
    }
    const res = this.run(
      'INSERT INTO claims (resource_id, session_id, reason, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      resourceId,
      sessionId,
      reason,
      now,
      expiresAt,
    );
    this.addEvent({
      type: 'claim.granted',
      sessionId,
      subjectType: 'resource',
      subjectId: resourceId,
      summary: `${this.sessionLabel(sessionId)} claimed ${resourceId}: ${reason}`,
      data: { minutes },
    });
    return { ok: true, claim: toClaim(this.get('SELECT * FROM claims WHERE id = ?', Number(res.lastInsertRowid))!), renewed: false };
  }

  /**
   * Releases a live claim. Only the holder may release unless `force` is set
   * (the human in the UI, or a session ending).
   */
  releaseResource(resourceId: string, sessionId: string | null, opts: { force?: boolean; reason?: string; by?: string } = {}): ReleaseResult {
    if (!this.getResource(resourceId)) throw new UnknownResourceError(resourceId, this.listResources().map((r) => r.id));
    const current = this.liveClaim(resourceId);
    if (!current) return { ok: false, message: `${resourceId} is not claimed by anyone` };
    if (!opts.force && current.sessionId !== sessionId) {
      return { ok: false, message: `Not released: ${this.describeHolder(current)}. Only the holder can release it.`, holder: current };
    }
    const reason = opts.reason ?? 'released';
    this.run('UPDATE claims SET released_at = ?, release_reason = ? WHERE id = ?', this.now(), reason, current.id);
    const by = opts.by ?? this.sessionLabel(sessionId);
    this.addEvent({
      type: 'claim.released',
      sessionId: current.sessionId,
      subjectType: 'resource',
      subjectId: resourceId,
      summary:
        by === this.sessionLabel(current.sessionId)
          ? `${by} released ${resourceId}`
          : `${by} released ${resourceId} (held by ${this.sessionLabel(current.sessionId)})`,
      data: { reason },
    });
    return { ok: true, claim: toClaim(this.get('SELECT * FROM claims WHERE id = ?', current.id)!) };
  }

  // --------------------------------------------------------------- signals

  liveSignalByKey(key: string): Signal | null {
    const r = this.get("SELECT * FROM signals WHERE key = ? AND status != 'resolved'", key);
    return r ? toSignal(r) : null;
  }

  getSignal(id: string): Signal | null {
    const r = this.get('SELECT * FROM signals WHERE id = ?', id);
    return r ? toSignal(r) : null;
  }

  insertSignal(s: Omit<Signal, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'snoozedUntil'>): Signal {
    const id = newId('sig');
    const now = this.now();
    this.run(
      `INSERT INTO signals (id, rule_id, key, subject_type, subject_id, severity, title, detail, link, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id, s.ruleId, s.key, s.subjectType, s.subjectId, s.severity, s.title, s.detail, s.link, s.source, now, now,
    );
    return this.getSignal(id)!;
  }

  refreshSignal(id: string, s: { severity: Severity; title: string; detail: string | null; link: string | null }): void {
    this.run(
      'UPDATE signals SET severity = ?, title = ?, detail = ?, link = ?, updated_at = ? WHERE id = ?',
      s.severity, s.title, s.detail, s.link, this.now(), id,
    );
  }

  resolveSignal(id: string): void {
    const now = this.now();
    this.run("UPDATE signals SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ? AND status != 'resolved'", now, now, id);
  }

  dismissSignal(id: string): Signal | null {
    const res = this.run("UPDATE signals SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'open'", this.now(), id);
    return res.changes ? this.getSignal(id) : null;
  }

  snoozeSignal(id: string, until: number): Signal | null {
    const res = this.run("UPDATE signals SET snoozed_until = ? WHERE id = ? AND status = 'open'", until, id);
    return res.changes ? this.getSignal(id) : null;
  }

  listSignals(opts: { status?: 'live' | 'open' | 'all' } = {}): Signal[] {
    const status = opts.status ?? 'live';
    const sql =
      status === 'all'
        ? 'SELECT * FROM signals ORDER BY created_at DESC LIMIT 500'
        : status === 'open'
          ? "SELECT * FROM signals WHERE status = 'open' ORDER BY created_at ASC"
          : "SELECT * FROM signals WHERE status != 'resolved' ORDER BY created_at ASC";
    return this.all(sql).map(toSignal);
  }
}
