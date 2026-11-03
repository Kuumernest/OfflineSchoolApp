// mobile/src/services/perUserData.service.js
"use strict";

/**
 * Per-user local data on a shared phone — the migration and the switch
 * (docs/40-per-user-local-data.md §8, decisions D1–D7).
 *
 * ── Shape ──────────────────────────────────────────────────────────────────
 *
 *   schoolapp.db            the legacy shared file. Untouched in meaning until
 *                           the D3 gate: unflipped accounts keep reading and
 *                           writing it exactly as before.
 *   schoolapp.u_<id>.db     one per account, created on that account's first
 *                           ONLINE sign-in with the school's switch on, filled
 *                           by a full sync of its own (D1), and used only once
 *                           that sync has completed.
 *   device.db               credentials, the store list, the journal, the
 *                           attribution decisions, placements and the review
 *                           store (db/deviceDb.js).
 *
 * ── Rules this file is built around ────────────────────────────────────────
 *
 *   OFF = TODAY. With the school's switch off on a phone that never had it on,
 *     nothing here opens a file, writes a byte, or changes a read.
 *   NO EMPTY APP. An account reads the legacy file until its own store has
 *     completed a full sync. The sync runs behind a "preparing" screen (no
 *     screen is mounted to read a half-filled store); if it does not complete
 *     — offline, a failed pull, the person taps "use the app now" — the
 *     account goes back to the legacy file, exactly as before, and it is tried
 *     again at the next online sign-in. An offline upgrade changes nothing.
 *   COPY → VERIFY → THEN REMOVE. A legacy outbox row is inserted into the
 *     owner's store, read back and compared by content hash, and only then
 *     archived inside the legacy file and removed from its live outbox (one
 *     legacy transaction). Ids and Idempotency-Keys are kept, so a re-send of
 *     anything that already went is deduplicated by the server (45-day TTL).
 *     A legacy dirty row is copied into the owner's store and verified; the
 *     legacy row is never changed — a placement record says it has gone, so
 *     nothing in this build sends it from the legacy file again.
 *   NOTHING DROPPED. A change with no evidence of whose it is (D2), and every
 *     outbox row with no recorded owner (D4), is copied in full into the review
 *     store and held. Only a person acts on it (assign to an account, send as
 *     me after a confirmation, save a copy). There is no discard.
 *   RESUMABLE. Every step is journalled in device.db and idempotent; each
 *     cross-file move is ordered so a kill between any two statements leaves
 *     either "not done" or "done", and the next run finishes it.
 */

import * as SecureStore from "expo-secure-store";
import {
  getDatabase, openDatabaseFile, setActiveDatabase, activeDatabaseName,
  closeDatabaseFile, deleteDatabaseFile, LEGACY_DB_NAME,
} from "../db/database";
import Dev from "../db/deviceDb";
import { hashRow } from "../db/rowHash";
import { isLegacyValue, replaceLegacyCredential, flushWal, compactDeviceDb } from "../db/credentialCache";

export const MAX_STORES = 5;
export const LEGACY_RETENTION_DAYS = 30;
const SWITCH_KEY = "peruser_switch";
const ARCHIVE = "mutation_outbox_migrated";
const OUTBOX = "mutation_outbox";
const REVIEWER_ROLES = new Set(["school_admin", "super_admin", "admin"]);

/** Columns that make an outbox row the same request wherever it sits. */
export const OUTBOX_IDENTITY = Object.freeze([
  "id", "entity_key", "method", "endpoint", "payload", "base_version",
  "created_at", "idem_key", "silent",
]);

/** Author columns usable as evidence (docs/40 §1, evidence table). */
export const AUTHOR_COLUMNS = Object.freeze({
  announcements: ["author_id"],
  quizzes:       ["created_by"],
  questions:     ["created_by"],
  exams:         ["updatedBy", "createdBy"],
  quiz_attempts: ["user_id"],
});

/** Child rows that travel with a dirty parent (the backfill hydrates them). */
const CHILDREN = Object.freeze({
  questions:     [{ table: "question_options", fk: "question_id" }],
  quizzes:       [{ table: "quiz_questions", fk: "quiz_id" }],
  quiz_attempts: [{ table: "attempt_answers", fk: "attempt_id",
                    children: [{ table: "attempt_answer_selections", fk: "attempt_answer_id" }] }],
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST HOOKS — a crash after any step, a stand-in for the network sync, a clock
// ═════════════════════════════════════════════════════════════════════════════

const hooks = { afterStep: null, prime: null, now: null, skipQuiesce: false };
export const __setTestHooks = (h = {}) => {
  hooks.afterStep = h.afterStep ?? null;
  hooks.prime = h.prime ?? null;
  hooks.now = h.now ?? null;
  hooks.skipQuiesce = !!h.skipQuiesce;
};
const now = () => (hooks.now ? hooks.now() : new Date());
const nowIso = () => now().toISOString();
const reached = async (name) => { if (hooks.afterStep) await hooks.afterStep(name); };

// ═════════════════════════════════════════════════════════════════════════════
// SMALL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const idOf = (user) => {
  const id = user?._id ?? user?.id ?? null;
  return id ? String(id) : null;
};
const parse = (s, fb = {}) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const signedInUser = () => {
  try { return require("../utils/authHelpers").getCurrentAuth()?.user ?? null; } catch { return null; }
};

export const storeFileFor = (userId) => {
  const safe = String(userId).replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = safe === String(userId) ? "" : `_${hashRow({ id: String(userId) }).slice(0, 8)}`;
  return `schoolapp.u_${safe}${suffix}.db`;
};

const tableExists = async (db, table) =>
  !!(await db.getFirstAsync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]
  ).catch(() => null));

const columnsOf = async (db, table) =>
  ((await db.getAllAsync(`PRAGMA table_info(${q(table)})`).catch(() => [])) ?? []);

/** BEGIN … COMMIT on one file; ROLLBACK on any throw (a kill does the same). */
const tx = async (db, fn) => {
  await db.execAsync("BEGIN IMMEDIATE");
  try {
    const out = await fn();
    await db.execAsync("COMMIT");
    return out;
  } catch (err) {
    await db.execAsync("ROLLBACK").catch(() => {});
    throw err;
  }
};

/** INSERT OR REPLACE `row` into `table` of `db`, using the columns both have. */
const copyRowInto = async (db, table, row, overrides = {}) => {
  const cols = new Set((await columnsOf(db, table)).map((c) => c.name));
  if (!cols.size) throw new Error(`no table ${table} in the destination`);
  const data = { ...row, ...overrides };
  const keys = Object.keys(data).filter((k) => cols.has(k));
  await db.runAsync(
    `INSERT OR REPLACE INTO ${q(table)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    keys.map((k) => (data[k] === undefined ? null : data[k]))
  );
  return keys;
};

export const outboxHash = (row) => hashRow(row, { columns: OUTBOX_IDENTITY });
export const dirtyHash = (row) => hashRow(row, { exclude: ["_owner_id"] });

// ═════════════════════════════════════════════════════════════════════════════
// THE SCHOOL'S SWITCH (D7) — learnt at sign-in / refresh, remembered per school
// ═════════════════════════════════════════════════════════════════════════════

const readSwitches = async () => {
  try { return parse(await SecureStore.getItemAsync(SWITCH_KEY), {}); } catch { return {}; }
};

export const rememberSchoolSwitch = async (schoolId, on) => {
  if (!schoolId) return;
  const map = await readSwitches();
  if (map[String(schoolId)] === !!on) return;
  // Off and never on: write nothing at all (switch off = today, byte for byte).
  if (!on && !(String(schoolId) in map)) return;
  map[String(schoolId)] = !!on;
  try { await SecureStore.setItemAsync(SWITCH_KEY, JSON.stringify(map)); } catch { /* best effort */ }
};

export const schoolSwitchOn = async (schoolId) =>
  !!schoolId && (await readSwitches())[String(schoolId)] === true;

/** Per-user mode applies to this account. super_admin stays on the legacy file. */
export const enabledFor = async (user) =>
  !!idOf(user) && user?.role !== "super_admin" && (await schoolSwitchOn(user?.schoolId ?? user?.school_id));

// ═════════════════════════════════════════════════════════════════════════════
// SCHEMA PARITY — a store has every table and column the legacy file has
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Services create some tables lazily and remember, per process, that they
 * did. A store opened later must not lack one of those tables, so a store is
 * given every table, column and index the source has (no rows).
 */
export const syncSchema = async (from, to) => {
  if (!from || !to || from === to) return;
  const objects = await from.getAllAsync(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')`
  ).catch(() => []);
  for (const o of objects.filter((x) => x.type === "table")) {
    if (o.name === ARCHIVE) continue;
    if (!(await tableExists(to, o.name))) {
      await to.execAsync(o.sql).catch(() => {});
      continue;
    }
    const have = new Set((await columnsOf(to, o.name)).map((c) => c.name));
    for (const c of await columnsOf(from, o.name)) {
      if (have.has(c.name)) continue;
      const def = c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : "";
      await to.execAsync(`ALTER TABLE ${q(o.name)} ADD COLUMN ${q(c.name)} ${c.type || ""}${def}`).catch(() => {});
    }
  }
  for (const o of objects.filter((x) => x.type === "index")) {
    if (o.tbl_name === ARCHIVE) continue;
    const exists = await to.getFirstAsync(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [o.name]
    ).catch(() => null);
    if (!exists) await to.execAsync(o.sql).catch(() => {});
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SWITCHING THE ACTIVE FILE
// ═════════════════════════════════════════════════════════════════════════════

/** Stop the sync engine and wait until nothing is writing through the handle. */
export const quiesceSync = async () => {
  if (hooks.skipQuiesce) return;
  let SyncManager = null;
  let MutationQueue = null;
  try { ({ SyncManager } = require("./syncManager")); } catch { /* not loaded */ }
  try { ({ MutationQueue } = require("./mutationQueue.service")); } catch { /* not loaded */ }
  SyncManager?.destroy?.();
  const busy = () =>
    !!(SyncManager?.isSyncing || SyncManager?._pushing || MutationQueue?.isDraining?.());
  // The in-flight request has its own timeout; a reconciler that runs after
  // the switch would write into the wrong file, so there is no give-up here.
  while (busy()) await new Promise((r) => setTimeout(r, 50));
};

const resetPerFileCaches = () => {
  try { require("../db/schemaManager").resetAllSchemas(); } catch { /* optional */ }
  try {
    const { SyncManager } = require("./syncManager");
    SyncManager._migrationsDone = false;
    SyncManager._listPulledAt?.clear?.();
    SyncManager._classIdsRepaired = false;
    SyncManager._staleSubjectsCleared = false;
    SyncManager._repairsDone = false;
  } catch { /* optional */ }
  try { require("./school.service").clearSchoolCache?.(); } catch { /* optional */ }
};

/** Make `name` the file every getDatabase() answers. */
export const activate = async (name) => {
  if (activeDatabaseName() === name) return getDatabase();
  await quiesceSync();
  const legacy = await openDatabaseFile(LEGACY_DB_NAME);
  const prev = await getDatabase();
  const next = await openDatabaseFile(name);
  if (name !== LEGACY_DB_NAME) {
    await syncSchema(legacy, next);
    if (prev !== legacy) await syncSchema(prev, next);
  }
  await setActiveDatabase(name);
  resetPerFileCaches();
  console.log(`[perUser] active local data: ${name}`);
  return next;
};

export const ensureLegacyActive = () => activate(LEGACY_DB_NAME);

// ═════════════════════════════════════════════════════════════════════════════
// INVENTORY — what in a file is a real unsent change (the backfill's filters)
// ═════════════════════════════════════════════════════════════════════════════

const selectors = () => require("./syncBackfill.service").dirtySelectors();

/**
 * Every row a backfill spec would send, by (table, id). Uses the specs' own
 * `where` and `skip` — never `_synced = 0` alone, which over-counts caches
 * (docs/40 §1 caution). Role filters are NOT applied: a row is a change
 * whoever could send it.
 */
export const dirtyInventory = async (db) => {
  const out = new Map();
  const keyToTable = new Map();
  for (const sel of selectors()) {
    keyToTable.set(sel.key, sel.table);
    if (!(await tableExists(db, sel.table))) continue;
    const rows = await db.getAllAsync(`SELECT * FROM ${q(sel.table)} WHERE ${sel.where}`).catch(() => []);
    for (const row of rows ?? []) {
      if (sel.skip) { try { if (sel.skip(row)) continue; } catch { continue; } }
      // The offline sign-in cache writes a `users` row per account with the
      // column's default _synced = 0 (auth.store.js). It carries a password
      // hash, which no change made on a screen ever does: it is a credential,
      // not somebody's unsent work (docs/40 §1 caution).
      if (sel.table === "users" && row.passwordHash) continue;
      const id = row[sel.idColumn];
      if (id == null || id === "") continue;
      const k = `${sel.table}\u0000${id}`;
      const item = out.get(k) ?? { tbl: sel.table, id: String(id), idColumn: sel.idColumn, row, keys: new Set() };
      item.keys.add(sel.key);
      out.set(k, item);
    }
  }
  out.keyToTable = keyToTable;
  return out;
};

/** Unsent changes in one file: outbox rows not synced + inventory rows. */
export const unsentWork = async (db) => {
  let outbox = 0;
  if (await tableExists(db, OUTBOX)) {
    outbox = Number((await db.getFirstAsync(
      `SELECT COUNT(*) AS n FROM ${OUTBOX} WHERE status != 'synced'`
    ).catch(() => null))?.n ?? 0);
  }
  return outbox + (await dirtyInventory(db)).size;
};

const readChildren = async (db, specs, parentId) => {
  const out = [];
  for (const s of specs ?? []) {
    if (!(await tableExists(db, s.table))) continue;
    const rows = await db.getAllAsync(`SELECT * FROM ${q(s.table)} WHERE ${q(s.fk)} = ?`, [parentId]).catch(() => []);
    for (const r of rows ?? []) {
      out.push({ table: s.table, row: r });
      if (s.children && r.id != null) out.push(...(await readChildren(db, s.children, r.id)));
    }
  }
  return out;
};

/** Evidence from outbox rows (any status, owner known): (table,id) → Set(owner). */
const outboxEvidence = async (db, keyToTable) => {
  const ev = new Map();
  const add = (tbl, id, owner) => {
    if (!tbl || id == null || !owner) return;
    const k = `${tbl}\u0000${id}`;
    if (!ev.has(k)) ev.set(k, new Set());
    ev.get(k).add(String(owner));
  };
  const scan = async (table) => {
    if (!(await tableExists(db, table))) return;
    const rows = await db.getAllAsync(
      `SELECT entity_key, payload, owner_id FROM ${table} WHERE owner_id IS NOT NULL`
    ).catch(() => []);
    for (const r of rows ?? []) {
      const p = parse(r.payload);
      const tbl = p?.__local?.table ?? p?.__reconcile?.table ?? null;
      for (const id of p?.__local?.ids ?? []) add(tbl, id, r.owner_id);
      if (p?.__reconcile?.localId && tbl) add(tbl, p.__reconcile.localId, r.owner_id);
      const [key, ...rest] = String(r.entity_key ?? "").split(":");
      const t = keyToTable.get(key);
      if (t && rest.length) add(t, rest.join(":"), r.owner_id);
    }
  };
  await scan(OUTBOX);
  await scan(ARCHIVE);
  return ev;
};

/**
 * D2's evidence chain for one row, in the decided order:
 *   1. an outbox row naming it, with a recorded owner (conflicting owners: hold)
 *   2. its author column, if that account is known on this phone
 *   3. its _owner_id stamp
 *   4. nothing → hold
 */
export const decideOwner = (item, { evidence, knownUsers }) => {
  const ev = evidence.get(`${item.tbl}\u0000${item.id}`);
  if (ev?.size === 1) return { owner: [...ev][0], evidence: "outbox" };
  if (ev?.size > 1) return { owner: null, evidence: "conflicting-outbox" };
  for (const col of AUTHOR_COLUMNS[item.tbl] ?? []) {
    const v = item.row?.[col];
    if (v && knownUsers.has(String(v))) return { owner: String(v), evidence: `author:${col}` };
  }
  if (item.row?._owner_id) return { owner: String(item.row._owner_id), evidence: "owner-stamp" };
  return { owner: null, evidence: "none" };
};

/** A row dirtied after the migration started: its stamp is the writer. */
const liveOwner = (item, ctx, decided) => {
  if (decided) return { owner: decided.owner_id ?? null, evidence: decided.evidence };
  if (item.row?._owner_id) return { owner: String(item.row._owner_id), evidence: "owner-stamp" };
  return decideOwner(item, ctx);
};

const summaryOf = (row) => {
  for (const k of ["title", "name", "question_text", "studentName", "label", "description", "entity_key", "endpoint"]) {
    if (row?.[k]) return String(row[k]).slice(0, 120);
  }
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SETUP (once per phone, local only, offline-safe)
// ═════════════════════════════════════════════════════════════════════════════

const runStep = async (dev, step, fn) => {
  if (await Dev.stepDone(dev, step)) return;
  await Dev.stepStart(dev, step);
  const detail = await fn();
  await Dev.stepFinish(dev, step, detail ?? null);
  await reached(step);
};

/** Offline credentials, copied (never moved) out of the shared `users` table. */
export const copyCredentials = async (legacy, dev) => {
  if (!(await tableExists(legacy, "users"))) return { copied: 0 };
  const rows = await legacy.getAllAsync(
    `SELECT * FROM users WHERE passwordHash IS NOT NULL AND passwordHash != '' AND passwordSalt IS NOT NULL`
  ).catch(() => []);
  let copied = 0;
  for (const r of rows ?? []) {
    const { passwordSalt, passwordHash, ...profile } = r;
    await dev.runAsync(
      `INSERT INTO credentials (user_id, email, enrollment_no, role, school_id, name,
         password_salt, password_hash, profile, updated_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')
       ON CONFLICT(user_id) DO UPDATE SET
         email = excluded.email, enrollment_no = excluded.enrollment_no, role = excluded.role,
         school_id = excluded.school_id, name = excluded.name,
         password_salt = excluded.password_salt, password_hash = excluded.password_hash,
         profile = excluded.profile, updated_at = excluded.updated_at
       WHERE credentials.updated_at IS NULL OR excluded.updated_at > credentials.updated_at`,
      [String(r.id), r.email ?? null, r.enrollmentNo ?? null, r.role ?? null,
       r.schoolId ?? r.school_id ?? null, r.name ?? null, passwordSalt, passwordHash,
       JSON.stringify(profile), r.updated_at ?? null]
    );
    copied++;
  }
  return { copied };
};

/**
 * An online sign-in's credentials, for offline sign-in later (per-user mode).
 * Replaces whatever this account had here — an old clear-text value too
 * (setup:credentials copies `users` as it finds it), with the file compacted
 * after so no freed copy of that value survives (db/credentialCache.js).
 */
export const saveCredentials = async (user, { salt, hash }) => {
  if (!(await Dev.deviceDbExists()) && !(await enabledFor(user))) return false;
  const dev = await Dev.openDeviceDb();
  const profile = {
    id: idOf(user), name: user.name ?? null, email: user.email ?? null,
    enrollmentNo: user.enrollmentNo ?? null, role: user.role ?? null, schoolId: user.schoolId ?? null,
  };
  const prior = await dev.getFirstAsync("SELECT password_hash FROM credentials WHERE user_id = ?", [idOf(user)]).catch(() => null);
  await dev.execAsync("PRAGMA secure_delete = ON;").catch(() => {});
  await dev.runAsync(
    `INSERT OR REPLACE INTO credentials (user_id, email, enrollment_no, role, school_id, name,
       password_salt, password_hash, profile, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'login')`,
    [idOf(user), profile.email, profile.enrollmentNo, profile.role, profile.schoolId,
     profile.name, salt, hash, JSON.stringify(profile), nowIso()]
  );
  if (isLegacyValue(prior?.password_hash)) await compactDeviceDb(dev);
  return true;
};

/**
 * After an online sign-in: no copy of this account's old clear-text value
 * may stay anywhere on the phone (docs/14). device.db's copy is handled by
 * saveCredentials; this covers every `users` table — the shared file, the
 * active file, every account's own store — replacing the value with `cred`
 * (the new one; null if it could not be made: then removed). Each file that
 * held one is compacted. Never throws.
 * @returns {Promise<string[]>} the files where a clear-text value was replaced
 */
export const replaceLegacyCredentialCopies = async (user, cred) => {
  const uid = idOf(user);
  if (!uid) return [];
  const names = new Set([LEGACY_DB_NAME, activeDatabaseName()]);
  try {
    if (await Dev.deviceDbExists()) {
      const dev = await Dev.openDeviceDb();
      for (const s of (await dev.getAllAsync("SELECT file FROM stores WHERE evicted_at IS NULL").catch(() => [])) ?? []) {
        if (s?.file) names.add(s.file);
      }
      // device.db itself, when saveCredentials did not run for this account
      // (its school's switch is off now, but device.db was made earlier).
      const row = await dev.getFirstAsync("SELECT password_hash FROM credentials WHERE user_id = ?", [uid]).catch(() => null);
      if (isLegacyValue(row?.password_hash)) {
        await dev.execAsync("PRAGMA secure_delete = ON;").catch(() => {});
        await dev.runAsync(
          "UPDATE credentials SET password_salt = ?, password_hash = ?, updated_at = ? WHERE user_id = ?",
          [cred?.salt ?? null, cred?.hash ?? null, nowIso(), uid]
        );
        await compactDeviceDb(dev);
      }
    }
  } catch (err) {
    console.warn("[peruser] device credentials:", err?.message);
  }
  const replaced = [];
  for (const name of names) {
    try {
      const db = await openDatabaseFile(name);
      if (await replaceLegacyCredential(db, uid, cred)) {
        replaced.push(name);
        await flushWal(db);
      }
    } catch (err) {
      console.warn(`[peruser] credentials in ${name}:`, err?.message);
    }
  }
  return replaced;
};

/** Offline sign-in lookup. Null when device.db does not exist (caller uses `users`). */
export const findCredentials = async ({ email, enrollmentNo }) => {
  if (!(await Dev.deviceDbExists())) return null;
  const dev = await Dev.openDeviceDb();
  const r = email
    ? await dev.getFirstAsync("SELECT * FROM credentials WHERE email = ? LIMIT 1", [email])
    : await dev.getFirstAsync("SELECT * FROM credentials WHERE enrollment_no = ? LIMIT 1", [enrollmentNo]);
  if (!r) return null;
  return {
    ...parse(r.profile, {}), id: r.user_id,
    passwordSalt: r.password_salt, passwordHash: r.password_hash,
  };
};

const knownUsersOf = async (dev) =>
  new Set(((await dev.getAllAsync("SELECT user_id FROM credentials").catch(() => [])) ?? []).map((r) => String(r.user_id)));

const holdForReview = async (dev, { kind, tbl, rowId, content, children = null, hash, reason, summary }) => {
  await dev.runAsync(
    `INSERT INTO review_items (id, kind, tbl, row_id, content, children, hash, reason, summary, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, children = excluded.children,
       hash = excluded.hash, summary = excluded.summary
     WHERE review_items.status = 'held' AND review_items.hash != excluded.hash`,
    [`${kind}:${tbl}:${rowId}`, kind, tbl, String(rowId), JSON.stringify(content),
     children ? JSON.stringify(children) : null, hash, reason, summary ?? null, nowIso()]
  );
};

/**
 * Decide an owner for every existing dirty row (persisted, D2), and copy into
 * the review store every row with no evidence and every ownerless outbox row.
 * Re-runnable: decisions are INSERT OR IGNORE, review copies upsert by id.
 */
export const attributeLegacy = async (legacy, dev, { persist = true } = {}) => {
  const inv = await dirtyInventory(legacy);
  const ctx = { evidence: await outboxEvidence(legacy, inv.keyToTable), knownUsers: await knownUsersOf(dev) };
  let decided = 0, held = 0;
  for (const item of inv.values()) {
    const existing = await dev.getFirstAsync(
      "SELECT * FROM attribution WHERE tbl = ? AND row_id = ?", [item.tbl, item.id]
    );
    const d = persist && !existing ? decideOwner(item, ctx) : liveOwner(item, ctx, existing);
    if (persist && !existing) {
      await dev.runAsync(
        "INSERT OR IGNORE INTO attribution (tbl, row_id, owner_id, evidence, decided_at) VALUES (?, ?, ?, ?, ?)",
        [item.tbl, item.id, d.owner, d.evidence, nowIso()]
      );
      decided++;
    }
    if (!d.owner) {
      const placed = await dev.getFirstAsync(
        "SELECT 1 AS x FROM placements WHERE kind = 'dirty' AND tbl = ? AND row_id = ? AND hash = ?",
        [item.tbl, item.id, dirtyHash(item.row)]
      );
      if (!placed) {
        await holdForReview(dev, {
          kind: "dirty", tbl: item.tbl, rowId: item.id, content: item.row,
          children: await readChildren(legacy, CHILDREN[item.tbl], item.id),
          hash: dirtyHash(item.row), reason: d.evidence, summary: summaryOf(item.row),
        });
        held++;
      }
    }
  }
  if (await tableExists(legacy, OUTBOX)) {
    const rows = await legacy.getAllAsync(
      `SELECT * FROM ${OUTBOX} WHERE owner_id IS NULL AND status != 'synced'`
    ).catch(() => []);
    for (const r of rows ?? []) {
      await holdForReview(dev, {
        kind: "outbox", tbl: OUTBOX, rowId: r.id, content: r, hash: outboxHash(r),
        reason: "no-owner-recorded", summary: summaryOf(r),
      });
      held++;
    }
  }
  return { decided, held };
};

/** Once per phone, before any account is moved. Local only. */
export const ensureSetup = async () => {
  const dev = await Dev.openDeviceDb();
  const legacy = await openDatabaseFile(LEGACY_DB_NAME);
  await runStep(dev, "setup:meta", async () => {
    if (!(await Dev.getMeta(dev, "migration_started_at"))) await Dev.setMeta(dev, "migration_started_at", nowIso());
    return null;
  });
  await runStep(dev, "setup:credentials", () => copyCredentials(legacy, dev));
  await runStep(dev, "setup:attribution", () => attributeLegacy(legacy, dev));
  return dev;
};

// ═════════════════════════════════════════════════════════════════════════════
// STORES — creation, the cap of five, eviction (D6)
// ═════════════════════════════════════════════════════════════════════════════

export const storeRow = async (dev, uid) =>
  dev.getFirstAsync("SELECT * FROM stores WHERE user_id = ?", [uid]);

export const liveStores = async (dev) =>
  (await dev.getAllAsync("SELECT * FROM stores WHERE evicted_at IS NULL ORDER BY last_used_at ASC").catch(() => [])) ?? [];

/**
 * May this account have a store on this phone? At most MAX_STORES live; the
 * least recently used store with NO unsent work is evicted to make room; if
 * every one of them holds unsent work the answer is no (never evict work).
 */
export const admit = async (uid) => {
  if (!(await Dev.deviceDbExists())) return { ok: true };
  const dev = await Dev.openDeviceDb();
  const mine = await storeRow(dev, uid);
  if (mine && !mine.evicted_at) return { ok: true };
  const live = await liveStores(dev);
  if (live.length < MAX_STORES) return { ok: true };
  const active = activeDatabaseName();
  for (const s of live) {
    if (s.file === active) continue;
    const h = await openDatabaseFile(s.file);
    if ((await unsentWork(h)) > 0) continue;
    await closeDatabaseFile(s.file);
    await deleteDatabaseFile(s.file);
    await tx(dev, async () => {
      await dev.runAsync(
        "UPDATE stores SET evicted_at = ?, primed_at = NULL, switched_at = NULL WHERE user_id = ?",
        [nowIso(), s.user_id]
      );
      await Dev.stepReset(dev, `flip:${s.user_id}:`);
    });
    console.log(`[perUser] evicted the store of ${s.user_id} (no unsent work) to make room`);
    return { ok: true, evicted: s.user_id };
  }
  return { ok: false, reason: "deviceFull" };
};

/**
 * At an online sign-in, before the session is stored: may this account sign
 * in on this phone? Only refuses when a new store would be needed and every
 * one of the five holds unsent work (D6). Off/legacy accounts: always yes.
 */
export const admitForSignIn = async (user) => {
  try {
    if (!(await enabledFor(user))) return { ok: true };
    return await admit(idOf(user));
  } catch (err) {
    console.warn("[perUser] admit check failed — allowing the sign-in:", err?.message);
    return { ok: true };
  }
};

const createStore = async (dev, uid, user) => {
  const file = storeFileFor(uid);
  await dev.runAsync(
    `INSERT INTO stores (user_id, file, school_id, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET evicted_at = NULL, last_used_at = excluded.last_used_at`,
    [uid, file, user?.schoolId ?? null, nowIso(), nowIso()]
  );
  return storeRow(dev, uid);
};

const touch = (dev, uid) =>
  dev.runAsync("UPDATE stores SET last_used_at = ? WHERE user_id = ?", [nowIso(), uid]);

// ═════════════════════════════════════════════════════════════════════════════
// PLACEMENT — legacy rows into their owner's store (copy → verify → mark)
// ═════════════════════════════════════════════════════════════════════════════

const ensureArchive = async (legacy) => {
  await legacy.execAsync(
    `CREATE TABLE IF NOT EXISTS ${ARCHIVE} (id TEXT PRIMARY KEY, migrated_dest TEXT, migrated_at TEXT)`
  );
  const have = new Set((await columnsOf(legacy, ARCHIVE)).map((c) => c.name));
  for (const c of await columnsOf(legacy, OUTBOX)) {
    if (!have.has(c.name)) await legacy.execAsync(`ALTER TABLE ${ARCHIVE} ADD COLUMN ${q(c.name)} ${c.type || ""}`);
  }
};

const recordPlacement = (dev, kind, tbl, rowId, hash, dest) =>
  dev.runAsync(
    "INSERT OR IGNORE INTO placements (kind, tbl, row_id, hash, dest, placed_at) VALUES (?, ?, ?, ?, ?, ?)",
    [kind, tbl, String(rowId), hash, dest, nowIso()]
  );

/**
 * One outbox row into `store`: insert (if absent) → read back → compare
 * identity hash and owner → archive + delete in the legacy file (one
 * transaction) → placement record. A kill between any two of these is
 * finished by the next run: the store copy is found and verified, the legacy
 * row is still there or already archived.
 */
const placeOutboxRow = async ({ legacy, store, dev, row, owner, dest }) => {
  const h = outboxHash(row);
  let there = await store.getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [row.id]);
  if (!there) {
    await copyRowInto(store, OUTBOX, row, { owner_id: owner });
    there = await store.getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [row.id]);
  }
  if (!there || outboxHash(there) !== h || String(there.owner_id) !== String(owner)) {
    console.warn(`[perUser] outbox ${row.id}: copy did not verify — left in the shared file`);
    return false;
  }
  await reached("outbox:copied");
  await ensureArchive(legacy);
  const cols = (await columnsOf(legacy, OUTBOX)).map((c) => c.name);
  await tx(legacy, async () => {
    await legacy.runAsync(
      `INSERT OR REPLACE INTO ${ARCHIVE} (${cols.map(q).join(", ")}, migrated_dest, migrated_at)
       SELECT ${cols.map(q).join(", ")}, ?, ? FROM ${OUTBOX} WHERE id = ?`,
      [dest, nowIso(), row.id]
    );
    const archived = await legacy.getFirstAsync(`SELECT id FROM ${ARCHIVE} WHERE id = ?`, [row.id]);
    if (!archived) throw new Error("archive copy missing");
    await legacy.runAsync(`DELETE FROM ${OUTBOX} WHERE id = ?`, [row.id]);
  });
  await reached("outbox:archived");
  await recordPlacement(dev, "outbox", OUTBOX, row.id, h, dest);
  return true;
};

/** Archived rows whose placement record a kill prevented: verify and record. */
const repairOutboxRecords = async (legacy, dev) => {
  if (!(await tableExists(legacy, ARCHIVE))) return;
  const rows = await legacy.getAllAsync(`SELECT * FROM ${ARCHIVE}`).catch(() => []);
  for (const r of rows ?? []) {
    const h = outboxHash(r);
    const has = await dev.getFirstAsync(
      "SELECT 1 AS x FROM placements WHERE kind = 'outbox' AND row_id = ? AND hash = ?", [r.id, h]
    );
    if (has) continue;
    const file = String(r.migrated_dest ?? "").replace(/^store:/, "");
    const s = await storeRow(dev, file);
    if (!s) continue;
    const there = await (await openDatabaseFile(s.file)).getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [r.id]).catch(() => null);
    if (there && outboxHash(there) === h) await recordPlacement(dev, "outbox", OUTBOX, r.id, h, r.migrated_dest);
  }
};

export const placeOutbox = async ({ legacy, store, dev, uid }) => {
  await repairOutboxRecords(legacy, dev);
  if (!(await tableExists(legacy, OUTBOX))) return { placed: 0 };
  const rows = await legacy.getAllAsync(
    `SELECT * FROM ${OUTBOX} WHERE owner_id = ? AND status != 'synced' ORDER BY created_at ASC, rowid ASC`, [uid]
  ).catch(() => []);
  let placed = 0;
  for (const row of rows ?? []) {
    if (await placeOutboxRow({ legacy, store, dev, row, owner: uid, dest: `store:${uid}` })) placed++;
  }
  return { placed };
};

/** One dirty row (+ children) into `store`, verified, then recorded. Legacy untouched. */
const placeDirtyRow = async ({ store, dev, tbl, row, children, owner, dest }) => {
  const h = dirtyHash(row);
  const idCol = tbl === "timetable" ? "_id" : "id";
  await tx(store, async () => {
    await copyRowInto(store, tbl, row, { _owner_id: owner });
    for (const c of children ?? []) await copyRowInto(store, c.table, c.row).catch(() => {});
  });
  const back = await store.getFirstAsync(`SELECT * FROM ${q(tbl)} WHERE ${q(idCol)} = ?`, [row[idCol]]);
  const cols = Object.keys(row).filter((k) => k !== "_owner_id" && back && k in back);
  if (!back || hashRow(back, { columns: cols }) !== hashRow(row, { columns: cols })) {
    console.warn(`[perUser] ${tbl} ${row[idCol]}: copy did not verify`);
    return false;
  }
  await reached("dirty:copied");
  await recordPlacement(dev, "dirty", tbl, row[idCol], h, dest);
  return true;
};

export const placeDirty = async ({ legacy, store, dev, uid }) => {
  const inv = await dirtyInventory(legacy);
  const ctx = { evidence: await outboxEvidence(legacy, inv.keyToTable), knownUsers: await knownUsersOf(dev) };
  let placed = 0;
  for (const item of inv.values()) {
    const h = dirtyHash(item.row);
    const done = await dev.getFirstAsync(
      "SELECT 1 AS x FROM placements WHERE kind = 'dirty' AND tbl = ? AND row_id = ? AND hash = ?", [item.tbl, item.id, h]
    );
    if (done) continue;
    const decided = await dev.getFirstAsync("SELECT * FROM attribution WHERE tbl = ? AND row_id = ?", [item.tbl, item.id]);
    if (liveOwner(item, ctx, decided).owner !== uid) continue;
    const children = await readChildren(legacy, CHILDREN[item.tbl], item.id);
    if (await placeDirtyRow({ store, dev, tbl: item.tbl, row: item.row, children, owner: uid, dest: `store:${uid}` })) placed++;
  }
  return { placed };
};

/** Review items a person assigned to `uid`: into uid's store. */
export const placeAssigned = async ({ legacy, store, dev, uid }) => {
  const items = await dev.getAllAsync(
    "SELECT * FROM review_items WHERE status = 'assigned' AND assigned_to = ?", [uid]
  ).catch(() => []);
  let placed = 0;
  for (const it of items ?? []) {
    const content = parse(it.content, null);
    if (!content) continue;
    let ok = false;
    if (it.kind === "outbox") {
      const live = (await tableExists(legacy, OUTBOX))
        ? await legacy.getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [it.row_id])
        : null;
      if (live && outboxHash(live) === it.hash) {
        ok = await placeOutboxRow({ legacy, store, dev, row: live, owner: uid, dest: `store:${uid}` });
      } else {
        // Already archived by an earlier, interrupted run: the store copy decides.
        const there = await store.getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [it.row_id]);
        if (!there) await copyRowInto(store, OUTBOX, content, { owner_id: uid });
        const back = await store.getFirstAsync(`SELECT * FROM ${OUTBOX} WHERE id = ?`, [it.row_id]);
        ok = !!back && outboxHash(back) === it.hash;
        if (ok) await recordPlacement(dev, "outbox", OUTBOX, it.row_id, it.hash, `store:${uid}`);
      }
    } else {
      ok = await placeDirtyRow({
        store, dev, tbl: it.tbl, row: content, children: parse(it.children, []),
        owner: uid, dest: `store:${uid}`,
      });
    }
    if (ok) {
      await dev.runAsync("UPDATE review_items SET status = 'placed', placed_at = ? WHERE id = ?", [nowIso(), it.id]);
    }
    if (ok) placed++;
  }
  return { placed };
};

/** Everything of uid's still in the legacy file, into uid's store. Local only. */
export const sweepFor = async (uid) => {
  const dev = await Dev.openDeviceDb();
  const legacy = await openDatabaseFile(LEGACY_DB_NAME);
  const s = await storeRow(dev, uid);
  const store = await openDatabaseFile(s.file);
  await syncSchema(legacy, store);
  const a = await placeOutbox({ legacy, store, dev, uid });
  const b = await placeDirty({ legacy, store, dev, uid });
  const c = await placeAssigned({ legacy, store, dev, uid });
  // New ownerless changes made on the legacy file since setup are held too.
  await attributeLegacy(legacy, dev, { persist: false });
  return { outbox: a.placed, dirty: b.placed, review: c.placed };
};

const copyIdMap = async (legacy, store) => {
  if (!(await tableExists(legacy, "sync_id_map"))) return 0;
  await syncSchema(legacy, store);
  const rows = await legacy.getAllAsync("SELECT * FROM sync_id_map").catch(() => []);
  for (const r of rows ?? []) {
    await store.runAsync(
      "INSERT OR IGNORE INTO sync_id_map (local_id, server_id, entity, created_at) VALUES (?, ?, ?, ?)",
      [r.local_id, r.server_id, r.entity ?? null, r.created_at ?? null]
    );
  }
  return rows?.length ?? 0;
};

// ═════════════════════════════════════════════════════════════════════════════
// THE SESSION — which file this account reads, and its first-time flip
// ═════════════════════════════════════════════════════════════════════════════

let _cancelRequested = false;
export const requestCancelPreparing = () => {
  _cancelRequested = true;
  try { require("./syncManager").SyncManager.destroy(); } catch { /* not loaded */ }
};

const prime = async () => {
  if (hooks.prime) return hooks.prime();
  const { SyncManager } = require("./syncManager");
  return SyncManager.primeOnce();
};

/**
 * Would prepareSession() need the network-bound first sync for this account?
 * The caller shows the preparing screen for exactly these sessions.
 */
export const needsPriming = async (user, { online = true } = {}) => {
  if (!online || !(await enabledFor(user))) return false;
  if (!(await Dev.deviceDbExists())) return true;
  const dev = await Dev.openDeviceDb();
  const s = await storeRow(dev, idOf(user));
  return !(s && !s.evicted_at && s.primed_at);
};

/**
 * Point the app at the right file for `user`, flipping the account to its own
 * store when it can. Never throws to the caller: any failure leaves the legacy
 * file active, which is today's behaviour.
 *
 * @returns {Promise<{mode: "legacy"|"store", reason: string}>}
 */
export const prepareSession = async (user, { online = true } = {}) => {
  const uid = idOf(user);
  _cancelRequested = false;
  try {
    const enabled = await enabledFor(user);
    const exists = await Dev.deviceDbExists();

    if (!enabled && !exists) {
      await ensureLegacyActive();
      return { mode: "legacy", reason: "switch-off" };
    }

    if (!enabled) {
      // The phone migrated once; this account's school is off (now, or never
      // was on). A store with unsent work stays in use until it is sent.
      const dev = await Dev.openDeviceDb();
      const s = uid ? await storeRow(dev, uid) : null;
      if (s?.switched_at && !s.evicted_at) {
        const h = await openDatabaseFile(s.file);
        if ((await unsentWork(h)) > 0) {
          await activate(s.file);
          await touch(dev, uid);
          return { mode: "store", reason: "switch-off-unsent-work" };
        }
        await dev.runAsync("UPDATE stores SET switched_at = NULL WHERE user_id = ?", [uid]);
      }
      await ensureLegacyActive();
      return { mode: "legacy", reason: "switch-off" };
    }

    const dev = await ensureSetup();
    let s = await storeRow(dev, uid);

    if (s && !s.evicted_at && s.primed_at) {
      // Primed before: everything left is local (an offline launch included).
      return await finishFlip(dev, uid);
    }

    if (!online) {
      await ensureLegacyActive();
      return { mode: "legacy", reason: "not-primed-offline" };
    }

    const room = await admit(uid);
    if (!room.ok) {
      await ensureLegacyActive();
      return { mode: "legacy", reason: room.reason };
    }

    s = await createStore(dev, uid, user);
    await runStep(dev, `flip:${uid}:store`, async () => {
      const legacy = await openDatabaseFile(LEGACY_DB_NAME);
      const store = await openDatabaseFile(s.file);
      await syncSchema(legacy, store);
      return { idMap: await copyIdMap(legacy, store) };
    });

    await activate(s.file);
    const outcome = _cancelRequested ? "cancelled" : await prime();
    if (outcome !== "completed" || _cancelRequested) {
      await ensureLegacyActive();
      return { mode: "legacy", reason: `prime-${_cancelRequested ? "cancelled" : outcome ?? "aborted"}` };
    }
    await dev.runAsync("UPDATE stores SET primed_at = ? WHERE user_id = ?", [nowIso(), uid]);
    await Dev.stepStart(dev, `flip:${uid}:primed`);
    await Dev.stepFinish(dev, `flip:${uid}:primed`);
    await reached(`flip:${uid}:primed`);
    return await finishFlip(dev, uid);
  } catch (err) {
    if (err?.__testCrash) throw err;
    console.warn("[perUser] prepareSession failed — staying on the shared file:", err?.message);
    await ensureLegacyActive().catch(() => {});
    return { mode: "legacy", reason: "error" };
  }
};

/** Placement (local only) and the switch, once a store is primed. */
const finishFlip = async (dev, uid) => {
  const legacy = await openDatabaseFile(LEGACY_DB_NAME);
  const s = await storeRow(dev, uid);
  const store = await openDatabaseFile(s.file);
  await syncSchema(legacy, store);
  // Each placement is idempotent row by row, so these run on every session
  // (new rows attributed to this account, review items assigned to it); the
  // journal records the first complete pass.
  const outbox = await placeOutbox({ legacy, store, dev, uid });
  await runStep(dev, `flip:${uid}:outbox`, async () => outbox);
  const dirty = await placeDirty({ legacy, store, dev, uid });
  await runStep(dev, `flip:${uid}:dirty`, async () => dirty);
  const review = await placeAssigned({ legacy, store, dev, uid });
  await runStep(dev, `flip:${uid}:review`, async () => review);
  await attributeLegacy(legacy, dev, { persist: false });
  await runStep(dev, `flip:${uid}:switched`, async () => {
    await dev.runAsync("UPDATE stores SET switched_at = COALESCE(switched_at, ?) WHERE user_id = ?", [nowIso(), uid]);
    return null;
  });
  await activate(s.file);
  await touch(dev, uid);
  return { mode: "store", reason: "switched" };
};

/** Sign-out: back to the legacy file, so the next person starts from today's state. */
export const endSession = async () => {
  if (activeDatabaseName() === LEGACY_DB_NAME) return;
  await ensureLegacyActive();
};

// ═════════════════════════════════════════════════════════════════════════════
// THE LEGACY BACKFILL GATE — what an unflipped account may send from the
// shared file once the migration has started
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Null (no gate: today's behaviour) unless the legacy file is active and the
 * migration has started on this phone. Otherwise a function (table, row) →
 * may the signed-in account send this row: only its own, never a held row,
 * never a row already placed in somebody's store.
 */
export const legacyBackfillGate = async (db) => {
  if (activeDatabaseName() !== LEGACY_DB_NAME) return null;
  if (!(await Dev.deviceDbExists())) return null;
  const me = idOf(signedInUser());
  const dev = await Dev.openDeviceDb();
  const decided = new Map(
    ((await dev.getAllAsync("SELECT * FROM attribution").catch(() => [])) ?? [])
      .map((r) => [`${r.tbl}\u0000${r.row_id}`, r])
  );
  const placed = new Set(
    ((await dev.getAllAsync("SELECT tbl, row_id, hash FROM placements WHERE kind = 'dirty'").catch(() => [])) ?? [])
      .map((r) => `${r.tbl}\u0000${r.row_id}\u0000${r.hash}`)
  );
  const held = new Set(
    ((await dev.getAllAsync("SELECT tbl, row_id FROM review_items WHERE kind = 'dirty' AND status IN ('held', 'assigned')").catch(() => [])) ?? [])
      .map((r) => `${r.tbl}\u0000${r.row_id}`)
  );
  const ctx = { evidence: await outboxEvidence(db, new Map(selectors().map((s) => [s.key, s.table]))), knownUsers: await knownUsersOf(dev) };
  return (table, row, idColumn = "id") => {
    if (!me) return false;
    const id = String(row?.[idColumn] ?? row?.id ?? row?._id ?? "");
    const k = `${table}\u0000${id}`;
    if (placed.has(`${k}\u0000${dirtyHash(row)}`)) return false;
    if (held.has(k)) return false;
    return liveOwner({ tbl: table, id, row }, ctx, decided.get(k)).owner === me;
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// ACCOUNTING — every legacy dirty and outbox row, and where it is
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Classifies every unsent row of the legacy file:
 *   placed          copied into an account's store and verified (record +,
 *                   with verifyFiles, the copy still present or sent)
 *   review          held in the review store, content hash equal
 *   waiting-owner   owned by an account that has not flipped yet; the legacy
 *                   file is still where it lives and is sent from
 *   unplaced        none of the above — what the D3 gate refuses on
 * plus pending legacy uploads (upload_queue), which have no owner and are sent
 * from the legacy file as before; they also block D3.
 */
export const accountLegacy = async ({ verifyFiles = false } = {}) => {
  const legacy = await openDatabaseFile(LEGACY_DB_NAME);
  const exists = await Dev.deviceDbExists();
  const dev = exists ? await Dev.openDeviceDb() : null;
  const items = [];
  const switched = new Set(
    dev ? ((await dev.getAllAsync("SELECT user_id FROM stores WHERE switched_at IS NOT NULL").catch(() => [])) ?? []).map((r) => String(r.user_id)) : []
  );
  const review = new Map(
    dev ? ((await dev.getAllAsync("SELECT * FROM review_items").catch(() => [])) ?? []).map((r) => [r.id, r]) : []
  );
  const placement = async (kind, tbl, id, hash) =>
    dev ? dev.getFirstAsync(
      "SELECT * FROM placements WHERE kind = ? AND tbl = ? AND row_id = ? AND hash = ?", [kind, tbl, String(id), hash]
    ) : null;
  const inStore = async (dest, table, idCol, id) => {
    const s = dev ? await storeRow(dev, String(dest).replace(/^store:/, "")) : null;
    if (!s) return false;
    if (s.evicted_at) return true;   // evicted only when it held no unsent work: it was sent
    const h = await openDatabaseFile(s.file);
    const present = (v) => h.getFirstAsync(`SELECT 1 AS x FROM ${q(table)} WHERE ${q(idCol)} = ?`, [v]).catch(() => null);
    if (await present(id)) return true;
    // Sent since, and re-keyed to the id the server gave it (the reconciler
    // records local → server in sync_id_map): the row is there under that id.
    const mapped = await h.getFirstAsync("SELECT server_id FROM sync_id_map WHERE local_id = ?", [id]).catch(() => null);
    if (mapped?.server_id && (await present(mapped.server_id))) return true;
    // Or sent by a request this store records as delivered.
    const sent = await h.getAllAsync(`SELECT payload FROM ${OUTBOX} WHERE status = 'synced'`).catch(() => []);
    return (sent ?? []).some((r) => {
      const p = parse(r.payload);
      return (p?.__local?.ids ?? []).map(String).includes(String(id)) || String(p?.__reconcile?.localId ?? "") === String(id);
    });
  };

  if (await tableExists(legacy, OUTBOX)) {
    for (const r of (await legacy.getAllAsync(`SELECT * FROM ${OUTBOX} WHERE status != 'synced'`)) ?? []) {
      const h = outboxHash(r);
      let state;
      if (!r.owner_id) state = review.get(`outbox:${OUTBOX}:${r.id}`)?.hash === h ? "review" : "unplaced";
      else state = switched.has(String(r.owner_id)) ? "unplaced" : "waiting-owner";
      items.push({ kind: "outbox", tbl: OUTBOX, id: r.id, hash: h, owner: r.owner_id ?? null, state });
    }
  }
  if (await tableExists(legacy, ARCHIVE)) {
    for (const r of (await legacy.getAllAsync(`SELECT * FROM ${ARCHIVE}`)) ?? []) {
      const h = outboxHash(r);
      const p = await placement("outbox", OUTBOX, r.id, h);
      let ok = !!p;
      if (ok && verifyFiles) ok = await inStore(p.dest, OUTBOX, "id", r.id);
      items.push({ kind: "outbox", tbl: OUTBOX, id: r.id, hash: h, owner: r.owner_id ?? null, state: ok ? "placed" : "unplaced", dest: p?.dest ?? null });
    }
  }
  const inv = await dirtyInventory(legacy);
  const ctx = dev ? { evidence: await outboxEvidence(legacy, inv.keyToTable), knownUsers: await knownUsersOf(dev) } : null;
  for (const item of inv.values()) {
    const h = dirtyHash(item.row);
    const p = await placement("dirty", item.tbl, item.id, h);
    let state;
    if (p) {
      state = !verifyFiles || (await inStore(p.dest, item.tbl, item.idColumn, item.id)) ? "placed" : "unplaced";
    } else if (["held", "assigned"].includes(review.get(`dirty:${item.tbl}:${item.id}`)?.status)
               && review.get(`dirty:${item.tbl}:${item.id}`)?.hash === h) {
      state = "review";
    } else if (ctx) {
      const decided = await dev.getFirstAsync("SELECT * FROM attribution WHERE tbl = ? AND row_id = ?", [item.tbl, item.id]);
      const owner = liveOwner(item, ctx, decided).owner;
      state = owner && !switched.has(owner) ? "waiting-owner" : "unplaced";
    } else {
      state = "unplaced";
    }
    items.push({ kind: "dirty", tbl: item.tbl, id: item.id, hash: h, state, dest: p?.dest ?? null });
  }
  let uploads = 0;
  if (await tableExists(legacy, "upload_queue")) {
    uploads = Number((await legacy.getFirstAsync(
      "SELECT COUNT(*) AS n FROM upload_queue WHERE status IN ('pending', 'failed', 'uploading')"
    ).catch(() => null))?.n ?? 0);
  }
  const totals = { placed: 0, review: 0, "waiting-owner": 0, unplaced: 0 };
  for (const it of items) totals[it.state]++;
  return { items, totals, uploadsPending: uploads };
};

// ═════════════════════════════════════════════════════════════════════════════
// D3 — deleting the legacy file
// ═════════════════════════════════════════════════════════════════════════════

/** Every reason the legacy file may not be deleted yet; ok when there are none. */
export const legacyDeletionGate = async () => {
  const reasons = [];
  if (!(await Dev.deviceDbExists())) return { ok: false, reasons: ["notMigrated"] };
  const dev = await Dev.openDeviceDb();
  const started = await Dev.getMeta(dev, "migration_started_at");
  const days = started ? (now().getTime() - new Date(started).getTime()) / 86_400_000 : 0;
  if (!started || days < LEGACY_RETENTION_DAYS) reasons.push("tooSoon");
  if (await Dev.getMeta(dev, "legacy_deleted_at")) reasons.push("alreadyDeleted");
  const acc = await accountLegacy({ verifyFiles: true });
  if (acc.totals.unplaced) reasons.push("unplaced");
  if (acc.totals["waiting-owner"]) reasons.push("waitingOwner");
  if (acc.uploadsPending) reasons.push("uploadsPending");
  if (activeDatabaseName() === LEGACY_DB_NAME) reasons.push("inUse");
  return { ok: reasons.length === 0, reasons, days: Math.floor(days), totals: acc.totals };
};

/** Explicit, by a reviewer, after a confirmation. Re-checks the gate first. Never automatic. */
export const deleteLegacyFile = async ({ by } = {}) => {
  if (!canReview(by)) return { ok: false, reasons: ["notAllowed"] };
  const gate = await legacyDeletionGate();
  if (!gate.ok) return gate;
  const dev = await Dev.openDeviceDb();
  await closeDatabaseFile(LEGACY_DB_NAME);
  await deleteDatabaseFile(LEGACY_DB_NAME);
  await Dev.setMeta(dev, "legacy_deleted_at", nowIso());
  await Dev.setMeta(dev, "legacy_deleted_by", idOf(by));
  return { ok: true, reasons: [] };
};

// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW LIST (D2/D4) — visible to everyone, actionable by an admin
// ═════════════════════════════════════════════════════════════════════════════

export const canReview = (user) => REVIEWER_ROLES.has(String(user?.role ?? ""));

export const listReview = async () => {
  if (!(await Dev.deviceDbExists())) return [];
  const dev = await Dev.openDeviceDb();
  const rows = await dev.getAllAsync(
    "SELECT id, kind, tbl, row_id, reason, summary, created_at, status, assigned_to, decided_by, decided_at, action, placed_at FROM review_items ORDER BY created_at ASC, id ASC"
  ).catch(() => []);
  return rows ?? [];
};

export const reviewCounts = async () => {
  const items = await listReview();
  return {
    held: items.filter((i) => i.status === "held").length,
    assigned: items.filter((i) => i.status === "assigned").length,
    placed: items.filter((i) => i.status === "placed").length,
  };
};

/** Accounts known on this phone (have signed in here), for "assign to". */
export const knownAccounts = async () => {
  if (!(await Dev.deviceDbExists())) return [];
  const dev = await Dev.openDeviceDb();
  return ((await dev.getAllAsync("SELECT user_id, name, email, role FROM credentials ORDER BY name").catch(() => [])) ?? []);
};

/**
 * Give a held change to an account (D2). by = the signed-in reviewer.
 * If that account's store is already in use on this phone it is placed now;
 * otherwise at that account's next sign-in here.
 */
export const assignReviewItem = async (itemId, toUserId, { by, action = "assign" } = {}) => {
  if (!canReview(by)) return { ok: false, reason: "notAllowed" };
  const dev = await Dev.openDeviceDb();
  const item = await dev.getFirstAsync("SELECT * FROM review_items WHERE id = ?", [itemId]);
  if (!item || item.status !== "held") return { ok: false, reason: "notHeld" };
  const known = await dev.getFirstAsync("SELECT user_id FROM credentials WHERE user_id = ?", [String(toUserId)]);
  if (!known) return { ok: false, reason: "unknownAccount" };
  await dev.runAsync(
    `UPDATE review_items SET status = 'assigned', assigned_to = ?, decided_by = ?, decided_at = ?, action = ?
     WHERE id = ? AND status = 'held'`,
    [String(toUserId), idOf(by), nowIso(), action, itemId]
  );
  const s = await storeRow(dev, String(toUserId));
  if (s?.switched_at && !s.evicted_at) {
    const legacy = await openDatabaseFile(LEGACY_DB_NAME);
    const store = await openDatabaseFile(s.file);
    await syncSchema(legacy, store);
    await placeAssigned({ legacy, store, dev, uid: String(toUserId) });
  }
  return { ok: true };
};

/** "Send as me": the reviewer takes the change as their own, after confirming. */
export const sendReviewItemAsMe = (itemId, { by, confirmed } = {}) => {
  if (!confirmed) return Promise.resolve({ ok: false, reason: "notConfirmed" });
  return assignReviewItem(itemId, idOf(by), { by, action: "send-as-me" });
};

/** A full copy of a held change (and its children), as text to save or share. */
export const exportReviewItem = async (itemId) => {
  const dev = await Dev.openDeviceDb();
  const item = await dev.getFirstAsync("SELECT * FROM review_items WHERE id = ?", [itemId]);
  if (!item) return null;
  return JSON.stringify({
    id: item.id, kind: item.kind, table: item.tbl, rowId: item.row_id, reason: item.reason,
    heldSince: item.created_at, content: parse(item.content, null), children: parse(item.children, []),
  }, null, 2);
};

export default {
  rememberSchoolSwitch, schoolSwitchOn, enabledFor, prepareSession, needsPriming, endSession,
  requestCancelPreparing, admit, saveCredentials, replaceLegacyCredentialCopies, findCredentials, legacyBackfillGate,
  accountLegacy, legacyDeletionGate, deleteLegacyFile, listReview, reviewCounts, knownAccounts,
  assignReviewItem, sendReviewItemAsMe, exportReviewItem, canReview, MAX_STORES,
};
