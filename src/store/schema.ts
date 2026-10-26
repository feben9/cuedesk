// SQLite schema. Times are epoch milliseconds (INTEGER). Bump SCHEMA_VERSION and
// add a step to MIGRATIONS when the schema changes.

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      source          TEXT NOT NULL,
      cwd             TEXT,
      transcript_path TEXT,
      state           TEXT NOT NULL DEFAULT 'working'
                      CHECK (state IN ('working','waiting','idle','ended')),
      activity        TEXT,
      first_seen      INTEGER NOT NULL,
      last_seen       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asks (
      id            TEXT PRIMARY KEY,
      session_id    TEXT,
      kind          TEXT NOT NULL CHECK (kind IN ('answer','approve','action')),
      summary       TEXT NOT NULL,
      details       TEXT,
      asked_by      TEXT NOT NULL,
      origin        TEXT NOT NULL,
      tags          TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      due_at        INTEGER,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
      answer        TEXT,
      answered_at   INTEGER,
      snoozed_until INTEGER
    );
    CREATE INDEX IF NOT EXISTS asks_status ON asks (status);
    CREATE INDEX IF NOT EXISTS asks_session ON asks (session_id, status);

    CREATE TABLE IF NOT EXISTS items (
      source      TEXT NOT NULL,
      id          TEXT NOT NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL,
      stage       TEXT NOT NULL CHECK (stage IN ('todo','active','review','blocked','done')),
      url         TEXT,
      assignee    TEXT,
      updated_at  INTEGER NOT NULL,
      stage_since INTEGER NOT NULL,
      first_seen  INTEGER NOT NULL,
      last_synced INTEGER NOT NULL,
      gone        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, id)
    );

    CREATE TABLE IF NOT EXISTS resources (
      id    TEXT PRIMARY KEY,
      kind  TEXT NOT NULL,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id    TEXT NOT NULL REFERENCES resources(id),
      session_id     TEXT NOT NULL,
      reason         TEXT NOT NULL,
      claimed_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      released_at    INTEGER,
      release_reason TEXT
    );
    -- At most one live claim per resource.
    CREATE UNIQUE INDEX IF NOT EXISTS claims_one_live ON claims (resource_id) WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS signals (
      id            TEXT PRIMARY KEY,
      rule_id       TEXT NOT NULL,
      key           TEXT NOT NULL,
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      severity      TEXT NOT NULL CHECK (severity IN ('info','warn','urgent')),
      title         TEXT NOT NULL,
      detail        TEXT,
      link          TEXT,
      source        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      resolved_at   INTEGER,
      snoozed_until INTEGER
    );
    -- De-duplication: one unresolved signal per rule and subject.
    CREATE UNIQUE INDEX IF NOT EXISTS signals_one_live ON signals (key) WHERE status != 'resolved';

    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      type         TEXT NOT NULL,
      session_id   TEXT,
      subject_type TEXT,
      subject_id   TEXT,
      summary      TEXT NOT NULL,
      data         TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
  `,
};
