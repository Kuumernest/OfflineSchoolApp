// desktop/src/main/db/store.js
"use strict";

/**
 * The local mirror of the school's data.
 *
 * ── What this is and is not ───────────────────────────────────────────────
 *
 * It is the source of truth FOR THE SCREEN. Every read the desktop UI makes is
 * answered from here, whether or not there is internet, and that is what makes
 * the app feel the same on a dead connection as on a good one — no spinner that
 * resolves differently depending on the weather.
 *
 * It is NOT the source of truth for the school. The server is. This holds a
 * copy, plus the writes that have not reached the server yet, and it is always
 * prepared to be told it was wrong.
 *
 * ── Reads are synchronous, deliberately ───────────────────────────────────
 *
 * node:sqlite's DatabaseSync is synchronous, and against a local file that is
 * the right shape: a query here takes tens of microseconds, so wrapping it in a
 * promise buys nothing and costs a tick of latency on every keystroke in a
 * search box. The main process is not serving other clients — it is serving one
 * window — so there is nothing for it to be blocking.
 */

const fs   = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID }   = require("crypto");

const { PRAGMAS, MIGRATIONS, SCHEMA_VERSION } = require("./schema");

// ─────────────────────────────────────────────────────────────────────────────
// OPENING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open (creating if needed) and bring the schema up to date.
 *
 * @param {string} file  Path to the database. ":memory:" for tests.
 */
const open = (file) => {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  for (const p of PRAGMAS) {
    // journal_mode returns a row; the rest do not. exec() handles both, but
    // WAL has to be read back to know it took — it silently stays in the old
    // mode on a filesystem that cannot support it, and a network drive is
    // exactly where a school would put "the shared folder".
    try { db.exec(p); } catch (err) {
      throw new Error(`Could not apply "${p}": ${err.message}`);
    }
  }

  if (file !== ":memory:") {
    const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (String(mode).toLowerCase() !== "wal") {
      // Not fatal, but the durability argument for synchronous=FULL assumed
      // WAL. Worth saying out loud rather than discovering after a power cut.
      console.warn(
        `[db] journal_mode is "${mode}", not WAL. If the database is on a ` +
        "network share, move it to a local disk — WAL needs real file locking."
      );
    }
  }

  // Closed before rethrowing, always.
  //
  // A migration failure or a version refusal used to leave the handle open,
  // which on Windows keeps a lock on the file — so a launch that failed to
  // migrate could not be retried without ending the process, and the error the
  // user saw on the second attempt was about a locked file rather than about
  // the real problem. Found by a test whose own cleanup could not delete the
  // database afterwards.
  try {
    migrate(db);
  } catch (err) {
    try { db.close(); } catch { /* already gone; the original error is what matters */ }
    throw err;
  }

  return db;
};

/**
 * Apply whatever migrations this database has not seen.
 *
 * Each runs inside a transaction WITH its version bump, so a migration cannot
 * be half-applied. A school's data is not the place to find out that a schema
 * change stopped in the middle.
 */
const migrate = (db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

  const current = db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v ?? 0;

  if (current > SCHEMA_VERSION) {
    // An older build opening a database a newer build has upgraded. Refusing is
    // the only safe move: this code does not know what the newer one changed,
    // and writing to it with old assumptions is how a mirror becomes wrong in
    // ways nobody notices until it is being reconciled.
    throw new Error(
      `This database is at schema version ${current} and this build understands ` +
      `${SCHEMA_VERSION}. Update the application rather than downgrading it.`
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
      console.log(`[db] migrated to ${m.version} — ${m.name}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The document store, bound to one open database.
 *
 * Filters are a deliberately small language rather than anything resembling
 * Mongo's. Every operator here exists because a screen needed it, and a filter
 * this layer cannot express is a signal to write the SQL in the handler where
 * the intent is visible — not to grow a query engine nobody can review.
 *
 *   { schoolId: "s1" }                     equality
 *   { status: { in: ["a", "b"] } }         membership
 *   { deletedAt: null }                    IS NULL
 *   { voidedAt: { not: null } }            IS NOT NULL
 *   { amount: { gt: 0 } }                  gt | gte | lt | lte
 */
const documents = (db) => {
  // ── Reading ──────────────────────────────────────────────────────────────

  /** Turns one field's condition into SQL plus its parameters. */
  const clause = (field, cond) => {
    // school_id, updated_at and deleted_at are real columns; everything else
    // lives inside the JSON. Callers write camelCase field names either way and
    // do not need to know which is which.
    const col =
      field === "schoolId"  ? "school_id"  :
      field === "updatedAt" ? "updated_at" :
      field === "deletedAt" ? "deleted_at" :
      null;
    const ref = col ?? `json_extract(json, '$.${field}')`;

    if (cond === null)      return { sql: `${ref} IS NULL`,     params: [] };
    if (cond === undefined) return { sql: "1=1",                params: [] };

    if (typeof cond !== "object") return { sql: `${ref} = ?`, params: [cond] };

    if ("in" in cond) {
      const list = cond.in ?? [];
      // An empty IN () is not valid SQL and, more importantly, means "nothing
      // matches" — which has to be said explicitly or SQLite would error.
      if (!list.length) return { sql: "1=0", params: [] };
      return { sql: `${ref} IN (${list.map(() => "?").join(",")})`, params: list };
    }
    if ("not" in cond) {
      return cond.not === null
        ? { sql: `${ref} IS NOT NULL`, params: [] }
        : { sql: `${ref} <> ?`,        params: [cond.not] };
    }
    for (const [op, sql] of [["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="]]) {
      if (op in cond) return { sql: `${ref} ${sql} ?`, params: [cond[op]] };
    }

    throw new Error(`Unsupported filter on "${field}": ${JSON.stringify(cond)}`);
  };

  const build = (collection, filter = {}) => {
    const parts  = ["collection = ?"];
    const params = [collection];
    for (const [field, cond] of Object.entries(filter)) {
      const c = clause(field, cond);
      parts.push(c.sql);
      params.push(...c.params);
    }
    return { where: parts.join(" AND "), params };
  };

  /** The stored document, with the local pending flag attached. */
  const hydrate = (row) =>
    row ? { ...JSON.parse(row.json), _pending: row.pending === 1 } : null;

  return {
    // ── Writing ────────────────────────────────────────────────────────────

    /**
     * Store one document.
     *
     * Upsert, never insert: the sync puller re-delivers rows it has already
     * sent whenever a cursor overlaps, and a duplicate-key error there would
     * turn an ordinary overlap into a failed sync.
     */
    put(collection, doc, { pending = false } = {}) {
      const id = String(doc._id ?? doc.id ?? "");
      if (!id) throw new Error(`Cannot store a ${collection} with no _id`);

      db.prepare(`
        INSERT INTO docs (collection, id, school_id, updated_at, deleted_at, json, pending)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
          school_id  = excluded.school_id,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          json       = excluded.json,
          pending    = excluded.pending
      `).run(
        collection, id,
        doc.schoolId ?? null,
        doc.updatedAt ?? null,
        doc.deletedAt ?? null,
        JSON.stringify(doc),
        pending ? 1 : 0
      );
      return id;
    },

    /**
     * Store many, in one transaction.
     *
     * One transaction rather than one each: 5000 individual commits with
     * synchronous=FULL means 5000 disk flushes, which is the difference between
     * a sync taking half a second and taking a minute.
     */
    putMany(collection, docs, opts) {
      if (!docs.length) return 0;
      db.exec("BEGIN");
      try {
        for (const d of docs) this.put(collection, d, opts);
        db.exec("COMMIT");
        return docs.length;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    /** Mark a locally-written row as confirmed by the server. */
    settle(collection, id) {
      db.prepare("UPDATE docs SET pending = 0 WHERE collection = ? AND id = ?")
        .run(collection, id);
    },

    /**
     * Remove a row outright.
     *
     * For undoing a local write the server rejected — NOT for deletions, which
     * are soft everywhere in this system and arrive as a deletedAt.
     */
    forget(collection, id) {
      db.prepare("DELETE FROM docs WHERE collection = ? AND id = ?").run(collection, id);
    },

    // ── Reading ────────────────────────────────────────────────────────────

    get(collection, id) {
      return hydrate(
        db.prepare("SELECT json, pending FROM docs WHERE collection = ? AND id = ?")
          .get(collection, id)
      );
    },

    find(collection, filter = {}, { order, dir = "ASC", limit, offset } = {}) {
      const { where, params } = build(collection, filter);

      // Ordering by a JSON field is legitimate and common (by receivedAt, by
      // name), so it goes through the same column-or-JSON resolution as filters
      // rather than being restricted to the real columns.
      const orderSql = order
        ? ` ORDER BY ${
            order === "updatedAt" ? "updated_at" : `json_extract(json, '$.${order}')`
          } ${dir === "DESC" ? "DESC" : "ASC"}`
        : "";

      const limitSql = limit ? ` LIMIT ${Number(limit)}` : "";
      const offsetSql = offset ? ` OFFSET ${Number(offset)}` : "";

      return db.prepare(
        `SELECT json, pending FROM docs WHERE ${where}${orderSql}${limitSql}${offsetSql}`
      ).all(...params).map(hydrate);
    },

    count(collection, filter = {}) {
      const { where, params } = build(collection, filter);
      return db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE ${where}`).get(...params).n;
    },

    /**
     * Raw SQL, for the aggregates.
     *
     * Balances and arrears are sums and group-bys, and expressing those through
     * a filter language would be less clear than the SQL itself. Handlers use
     * this; it is not a hole in the abstraction so much as the abstraction
     * admitting what it is for.
     */
    sql(query, ...params) {
      return db.prepare(query).all(...params);
    },

    /** Everything pending, so the UI can show what has not been sent. */
    pending() {
      return db.prepare(
        "SELECT collection, id FROM docs WHERE pending = 1 ORDER BY collection, id"
      ).all();
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC CURSORS AND INSTALLATION FACTS
// ─────────────────────────────────────────────────────────────────────────────

const state = (db) => ({
  /** Where a collection has been pulled up to, or null for never. */
  cursorFor(collection) {
    return db.prepare("SELECT cursor FROM sync_state WHERE collection = ?")
      .get(collection)?.cursor ?? null;
  },

  setCursor(collection, cursor, { error = null } = {}) {
    db.prepare(`
      INSERT INTO sync_state (collection, cursor, last_pull_at, last_error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(collection) DO UPDATE SET
        cursor       = COALESCE(excluded.cursor, sync_state.cursor),
        last_pull_at = excluded.last_pull_at,
        last_error   = excluded.last_error
    `).run(collection, cursor, new Date().toISOString(), error);
  },

  all() {
    return db.prepare("SELECT * FROM sync_state ORDER BY collection").all();
  },
});

const meta = (db) => {
  const get = (key) =>
    db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;

  const set = (key, value) => {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
    return value;
  };

  return {
    get, set,

    /**
     * A short, stable code for this installation.
     *
     * It exists for receipt numbers. The server issues those from an atomic
     * counter (RCT-2026-2027-0041), which two machines working offline cannot
     * share — they would both issue 0041 and a school would have two different
     * receipts with one number, which is an accounting problem rather than a
     * software one. An offline receipt is prefixed with this instead, so it is
     * unique by construction and visibly issued away from the server.
     *
     * Four hex characters: enough that two installations colliding is not worth
     * planning for, short enough to read off a printed receipt over the phone.
     */
    deviceCode() {
      return get("deviceCode") ??
        set("deviceCode", randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase());
    },
  };
};

module.exports = { open, migrate, documents, state, meta, SCHEMA_VERSION };
