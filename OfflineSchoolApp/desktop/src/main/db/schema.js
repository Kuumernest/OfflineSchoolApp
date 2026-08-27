// desktop/src/main/db/schema.js
"use strict";

/**
 * The local database, and how it gets from one version to the next.
 *
 * ── Why one table instead of sixty ────────────────────────────────────────
 *
 * The server has around sixty Mongoose models. Mirroring each as a SQLite table
 * would mean sixty schemas kept in step with sixty others by hand, and every
 * backend field addition becoming a desktop migration — a maintenance debt that
 * comes due on the day somebody forgets, which is silently, as a missing column
 * in one screen.
 *
 * So documents are stored as they arrive: JSON, keyed by (collection, id), with
 * the handful of fields the app FILTERS by lifted into real columns and
 * expression indexes for the rest. SQLite's JSON1 functions query inside the
 * payload, so a new backend field needs no migration here at all — it simply
 * arrives and is readable.
 *
 * The cost is honest: no foreign keys between documents, and no column-level
 * type checking. Neither is a loss, because the server owns validation and this
 * database is a MIRROR — it must be able to hold whatever the server sends,
 * including shapes written by a newer version of the server than this desktop
 * build knows about. A stricter local schema would reject exactly that, and
 * refusing to store a record you have been given is a worse failure than
 * storing one you do not fully understand.
 *
 * ── Why these pragmas ────────────────────────────────────────────────────
 *
 * WAL, so a long read (an arrears report over the whole school) does not block
 * a write (the bursar taking the next payment at the counter).
 *
 * synchronous=FULL, which is slower than the usual advice and correct here.
 * With WAL and synchronous=NORMAL, SQLite may not have flushed the last commits
 * when the machine loses power — and the machine losing power is not a rare
 * event in the schools this is for. FULL means a payment the bursar was told was
 * recorded is on the disk before they are told. The cost is a few milliseconds
 * per transaction, against a receipt the school cannot reproduce.
 */

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous  = FULL",
  "PRAGMA foreign_keys = ON",
  // A blocked write waits rather than throwing SQLITE_BUSY at the UI. Five
  // seconds is far longer than any transaction here takes, so hitting it means
  // something is genuinely wrong rather than merely contended.
  "PRAGMA busy_timeout = 5000",
];

/**
 * Migrations, in order. Append only; never edit one that has shipped.
 *
 * Each is applied inside a transaction and recorded, so a half-applied
 * migration cannot exist — the school's data is not somewhere to discover that
 * a schema change stopped halfway.
 */
const MIGRATIONS = [
  {
    version: 1,
    name:    "documents, sync cursors and the outbox",
    up: `
      -- ── The mirror ────────────────────────────────────────────────────────
      CREATE TABLE docs (
        collection  TEXT NOT NULL,
        id          TEXT NOT NULL,

        -- Lifted out of the JSON because they are what sync and every query
        -- filter on, and because an index on a real column is cheaper to reason
        -- about than one on an expression.
        school_id   TEXT,
        updated_at  TEXT,          -- ISO 8601, as the server sends it
        deleted_at  TEXT,          -- soft delete, matching the server's model

        -- What the server sent, unaltered. The reason a newer server can add a
        -- field without this build needing to change.
        json        TEXT NOT NULL,

        -- Set when this row was written locally and has not yet been confirmed
        -- by the server. The UI shows these as pending rather than settled.
        pending     INTEGER NOT NULL DEFAULT 0,

        PRIMARY KEY (collection, id)
      );

      CREATE INDEX idx_docs_school   ON docs(collection, school_id) WHERE deleted_at IS NULL;
      CREATE INDEX idx_docs_updated  ON docs(collection, updated_at);
      CREATE INDEX idx_docs_pending  ON docs(pending) WHERE pending = 1;

      -- ── Where each collection has been synced up to ───────────────────────
      --
      -- Per collection rather than one global cursor: they are pulled
      -- independently, a large one may be interrupted, and a single cursor
      -- would either re-pull everything or skip what it never received.
      CREATE TABLE sync_state (
        collection   TEXT PRIMARY KEY,
        cursor       TEXT,            -- highest updated_at successfully stored
        last_pull_at TEXT,
        last_error   TEXT
      );

      -- ── Writes waiting to reach the server ────────────────────────────────
      --
      -- Queued HTTP REQUESTS, not a bespoke mutation format. That is the load
      -- bearing decision in this whole design: replaying the exact request the
      -- UI made means every server-side guard, validation rule, capability
      -- check and approval threshold runs the same way it would have online.
      -- A custom mutation format would need its own server endpoint, and that
      -- endpoint would be a second, weaker door into the same data.
      CREATE TABLE outbox (
        -- Strict FIFO. A payment that references a student created moments
        -- earlier has to arrive after it.
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,

        -- The client-generated id inside the request body, which is what makes
        -- a replay idempotent server-side. Unique so the same intent cannot be
        -- queued twice by a double-click.
        idem_key    TEXT NOT NULL UNIQUE,

        method      TEXT NOT NULL,
        path        TEXT NOT NULL,
        body        TEXT,

        -- Which document this request created or changed, so the mirror row can
        -- be reconciled with the server's answer when it lands.
        collection  TEXT,
        doc_id      TEXT,

        created_at  TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        next_try_at TEXT,
        last_error  TEXT,
        last_status INTEGER,

        -- pending  → waiting its turn
        -- blocked  → the server refused it in a way retrying will not fix.
        --            The queue STOPS here rather than reordering around it.
        status      TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE INDEX idx_outbox_status ON outbox(status, seq);

      -- ── This installation ─────────────────────────────────────────────────
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
];

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

module.exports = { PRAGMAS, MIGRATIONS, SCHEMA_VERSION };
