// mobile/src/services/gate.service.js
"use strict";

/**
 * The school gate, on a phone.
 *
 * A scan is written locally FIRST and queued for the server, exactly like a fee
 * payment. A gate with no signal must still let a queue of children through at
 * the same speed — a scanner that pauses for the network is worse than a paper
 * register, because at least the register never spins.
 *
 * Direction is decided here rather than by the server, because offline the
 * server cannot know it: the phone holds today's scans and derives in/out from
 * them. The server accepts the direction a device sends for that reason, and
 * derives its own only when none is given.
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { generateUUID }      from "../utils/idHelpers";
import { MutationQueue }     from "./mutationQueue.service";
import api                   from "./api";
// Loaded when first used, not at import: it brings in expo-file-system, and
// a service many modules import (and the Node checks load) should not.
const photoCache = () => require("./photoCache.service");
import {
  findByToken as snapshotByToken, verifyLocal, canVerify,
} from "./gateSnapshot.service";

const EVENTS = "gate_events";

/** A repeat scan inside this window is the same event — matches the server. */
const DEBOUNCE_SECONDS = 90;

const ensureSchema = async (db) => {
  await ensureTableSchema(EVENTS, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${EVENTS} (
      id           TEXT PRIMARY KEY,
      school_id    TEXT,
      student_id   TEXT,
      student_name TEXT,
      token        TEXT,
      direction    TEXT NOT NULL,
      date         TEXT NOT NULL,
      at           TEXT NOT NULL,
      station      TEXT,
      _synced      INTEGER NOT NULL DEFAULT 0,
      _synced_at   TEXT
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_gate_events_day ON ${EVENTS}(date, at)`
    ).catch(() => {});
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_gate_events_student ON ${EVENTS}(student_id, date)`
    ).catch(() => {});
    // How the pupil was identified (card / manual) and the fee status the
    // operator was shown, so today's list can say both. Additive: a phone
    // with scans from before these existed reads them as a card with no
    // status, which is what they were.
    await database.execAsync(`ALTER TABLE ${EVENTS} ADD COLUMN method TEXT`).catch(() => {});
    await database.execAsync(`ALTER TABLE ${EVENTS} ADD COLUMN verification_status TEXT`).catch(() => {});
    await database.execAsync(`ALTER TABLE ${EVENTS} ADD COLUMN verification_source TEXT`).catch(() => {});
  }, db);
};

/** YYYY-MM-DD in the device's own day — the school's day, not UTC. */
export const dayKey = (d = new Date()) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * The roster this device can recognise offline.
 *
 * Pulled while there is signal and kept locally, because a gate at 07:30 with
 * no bars still has to turn a QR token into a child's name. Without it the
 * screen could record a scan but not show who it was, which is the one thing
 * the operator needs to see.
 */
export const syncRoster = async ({ schoolId }) => {
  const { data } = await api.get("/gate/roster", { params: { schoolId } });
  const rows = data?.data ?? [];

  const db = await getDatabase();
  await ensureTableSchema("gate_roster", async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS gate_roster (
      token        TEXT PRIMARY KEY,
      student_id   TEXT NOT NULL,
      student_name TEXT,
      admission_no TEXT,
      class_name   TEXT,
      school_id    TEXT
    )`);
    // The photo path the roster already sends, so an operator without
    // gate.verify (no snapshot) still sees the face. Additive.
    await database.execAsync(`ALTER TABLE gate_roster ADD COLUMN photo_url TEXT`).catch(() => {});
  }, db);

  await db.runAsync(`DELETE FROM gate_roster`).catch(() => {});
  for (const r of rows) {
    await db.runAsync(
      `INSERT OR REPLACE INTO gate_roster
         (token, student_id, student_name, admission_no, class_name, school_id, photo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.token, r.studentId, r.name ?? null, r.enrollmentNo ?? null,
       r.className ?? null, schoolId, r.photoUrl ?? null]
    ).catch(() => {});
  }

  // Faces for offline, in the background — never awaited by the screen.
  const urls = rows.map((r) => r.photoUrl).filter(Boolean);
  if (urls.length) Promise.resolve().then(() => photoCache().warmPhotos(urls)).catch(() => {});

  return rows.length;
};

/**
 * A gate token is crypto.randomBytes(12).toString("base64url") — always
 * exactly 16 base64url characters. Checking the shape before anything else
 * is what stops the camera treating every QR code in the world as a possible
 * card: a poster, a drinks can, another school's card. Each of those used to
 * be queued as a scan, and each came back 404 UNKNOWN_CARD — which the outbox
 * classifies as permanent, so it sat in the failed count until cleared by
 * hand. A card this school never issued is now refused on the device.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16}$/;

// Scoped by school as well as token. syncRoster clears the whole table
// before refilling it, so today a device only ever holds one school's
// cards — but the column is stored and a lookup that ignores it would
// resolve another school's card the moment that stops being true.
const rosterLookup = async (db, token, schoolId) =>
  db.getFirstAsync(
    `SELECT * FROM gate_roster
      WHERE token = ? AND (school_id = ? OR school_id IS NULL)`,
    [token, schoolId ?? null]
  ).catch(() => null);

/**
 * A token, resolved from the card roster and the verification snapshot
 * together. The roster is what older code paths read and stays the first
 * answer; the snapshot (gate.verify holders only) fills in what it lacks —
 * a photo, a class — and recognises a card the roster missed because it was
 * pulled at a different moment. Either alone is enough to name the child.
 */
const lookup = async (db, token, schoolId) => {
  const roster = await rosterLookup(db, token, schoolId);
  const snap   = await snapshotByToken(token, schoolId).catch(() => null);
  if (!roster && !snap) return null;
  if (!roster) return snap;
  if (!snap || snap.student_id !== roster.student_id) return roster;
  return {
    ...roster,
    student_name: roster.student_name ?? snap.student_name,
    admission_no: roster.admission_no ?? snap.admission_no,
    class_name:   roster.class_name ?? snap.class_name,
    photo_url:    roster.photo_url ?? snap.photo_url,
  };
};

/**
 * Unknown tokens already queued this session, so an operator holding an
 * unrecognised card to the camera queues one scan, not one per re-arm. Kept in
 * memory rather than in gate_events: an unknown scan has no student to hang a
 * row on, and a guessed direction written locally would be asserted to the
 * server by the backfill as though this device had derived it.
 */
const unknownQueuedAt = new Map();

/**
 * Push what was just queued, without making the operator wait for it.
 *
 * The outbox is otherwise drained only by SyncManager's periodic tick, which
 * is minutes apart — deliberately, because it is a safety net for a device
 * that may have no signal. A gate is the opposite case: it is a fixed
 * position on the school's own network, an operator is watching the screen,
 * and the pending count sitting there through a queue of arriving children
 * reads as a scanner that is not working.
 *
 * Deliberately not awaited by the caller — the scan result is already known
 * locally and the next child should not wait on a round trip. Errors are
 * swallowed: the row stays queued and the periodic drain will retry it, which
 * is exactly the behaviour without this.
 *
 * One at a time. Two concurrent drains can select the same pending row
 * before either marks it retrying; the Idempotency-Key means the server
 * would dedupe it, but there is no reason to send it twice.
 */
let _pushInFlight = null;

const pushQueuedScans = () => {
  if (_pushInFlight) return _pushInFlight;
  _pushInFlight = MutationQueue.drain({ includeUploads: false })
    .catch(() => {})
    .finally(() => { _pushInFlight = null; });
  return _pushInFlight;
};

/**
 * Record a scan.
 *
 * @returns {Promise<{ok, student, direction, at, duplicate, reason}>}
 */
export const scan = async ({ schoolId, token, station = null }) => {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, reason: "empty" };

  // Refused, not queued: the server can only answer 404 for a token it never
  // issued, and that answer is permanent.
  if (!TOKEN_SHAPE.test(value)) {
    return { ok: false, reason: "not_a_card", queued: false };
  }

  const db = await getDatabase();
  await ensureSchema(db);

  const known = await lookup(db, value, schoolId);
  if (!known) {
    // Not refused outright: a card issued after this device last synced is
    // unknown here but valid at the server. The scan is queued and sent —
    // with no direction, so the server derives it from the history this
    // device could not see — and the screen says the name is unavailable
    // rather than turning the child away.
    const lastQueued = unknownQueuedAt.get(value);
    if (lastQueued && Date.now() - lastQueued < DEBOUNCE_SECONDS * 1000) {
      return { ok: false, reason: "unknown", queued: true, token: value };
    }
    unknownQueuedAt.set(value, Date.now());

    const id = generateUUID();
    await MutationQueue.enqueue({
      entityKey: `gateScan:${id}`,
      method:    "POST",
      endpoint:  "/gate/scan",
      payload:   { _id: id, schoolId, token: value, at: new Date().toISOString(), station },
    });
    pushQueuedScans();
    return { ok: false, reason: "unknown", queued: true, token: value };
  }

  return recordPassage(db, { schoolId, student: known, token: value, method: "card", station });
};

/**
 * A pupil found by name or admission number — a forgotten card. The same
 * passage as a scan (debounce, direction, outbox), sent with the pupil's id
 * instead of a token; the server records it with method "manual".
 *
 * @param {{schoolId, student: {student_id, student_name?, admission_no?, class_name?, photo_url?}, station?, verification?}} p
 */
export const recordManual = async ({ schoolId, student, station = null, verification }) => {
  if (!student?.student_id) return { ok: false, reason: "empty" };
  const db = await getDatabase();
  await ensureSchema(db);
  return recordPassage(db, { schoolId, student, token: null, method: "manual", station, verification });
};

/**
 * What recording a passage for this pupil now would do — the same rule
 * recordPassage applies (last event today flips the direction; one inside the
 * debounce window is the same event), read without writing, so the manual
 * card can label its button "Record arrival" / "Record departure" truthfully.
 *
 * @returns {Promise<{direction: "in"|"out", duplicate: boolean}>}
 */
export const nextDirection = async (studentId) => {
  try {
    const db = await getDatabase();
    await ensureSchema(db);
    const last = await db.getFirstAsync(
      `SELECT direction, at FROM ${EVENTS} WHERE student_id = ? AND date = ? ORDER BY at DESC LIMIT 1`,
      [String(studentId), dayKey()]
    ).catch(() => null);
    const duplicate = Boolean(last && Math.abs(Date.now() - new Date(last.at)) < DEBOUNCE_SECONDS * 1000);
    if (duplicate) return { direction: last.direction, duplicate: true };
    return { direction: last?.direction === "in" ? "out" : "in", duplicate: false };
  } catch {
    return { direction: "in", duplicate: false };
  }
};

/**
 * The fee status to record with a passage: what the card will show. Computed
 * on the device from the snapshot — the scan is queued before any network
 * call, so the server's answer cannot be what was shown at the moment of the
 * decision. Null without gate.verify (the operator sees no fees at all) or
 * for a pupil the snapshot does not hold.
 */
const deviceVerification = async (studentId) => {
  if (!canVerify()) return null;
  return verifyLocal(studentId).catch(() => null);
};

/**
 * One passage through the gate, card or manual: debounced, its direction
 * derived from today's scans on this device, written locally, queued.
 *
 * `verification` may be passed by a caller that has already shown one (the
 * manual card); otherwise it is computed here. Undefined → compute; null →
 * none.
 */
const recordPassage = async (db, { schoolId, student: known, token, method, station, verification }) => {
  const now  = new Date();
  const date = dayKey(now);

  const last = await db.getFirstAsync(
    `SELECT * FROM ${EVENTS} WHERE student_id = ? AND date = ? ORDER BY at DESC LIMIT 1`,
    [known.student_id, date]
  ).catch(() => null);

  const shown = verification === undefined ? await deviceVerification(known.student_id) : verification;

  if (last && Math.abs(now - new Date(last.at)) < DEBOUNCE_SECONDS * 1000) {
    return {
      ok: true, duplicate: true, method,
      student: known, direction: last.direction, at: last.at, verification: shown,
    };
  }

  const direction = last?.direction === "in" ? "out" : "in";
  const id = generateUUID();
  const at = now.toISOString();

  await db.runAsync(
    `INSERT INTO ${EVENTS}
       (id, school_id, student_id, student_name, token, direction, date, at, station, _synced,
        method, verification_status, verification_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, schoolId, known.student_id, known.student_name ?? null, token,
     direction, date, at, station, method, shown?.status ?? null, shown ? (shown.source ?? "device") : null]
  );

  await MutationQueue.enqueue({
    // One key per scan. Coalescing by student would drop an arrival when a
    // departure followed before either had synced.
    entityKey: `gateScan:${id}`,
    method:    "POST",
    endpoint:  "/gate/scan",
    payload: {
      _id: id,
      schoolId, at, station,
      // A card scan sends its token (the server resolves the card); a manual
      // lookup sends no token, and the pupil's id is what the server finds
      // them by. The id rides along on a card scan too: the server ignores it
      // when a token is present, and it makes the queued row readable.
      ...(token ? { token } : {}),
      studentId: known.student_id,
      method,
      // Sent so the server does not re-derive it from state this device could
      // not see while offline.
      direction,
      // What the operator was shown, for the audit beside the server's own
      // answer. The server keeps it only from a gate.verify holder.
      ...(shown ? { verification: shown } : {}),
      __reconcile: { kind: "gateScan", localId: id },
    },
  });

  pushQueuedScans();

  return { ok: true, duplicate: false, method, student: known, direction, at, verification: shown };
};

/**
 * Synced scans from earlier days, removed. Only today's scans are ever read
 * on the phone (the debounce, the direction, the list), and the server holds
 * every scan once synced; a gate phone otherwise keeps every scan of the year
 * (about 400,000 for 1,200 pupils). Unsynced scans stay, whatever their day.
 */
export const pruneOldScans = async (db) => {
  const result = await db.runAsync(
    `DELETE FROM ${EVENTS} WHERE _synced = 1 AND date < ?`, [dayKey()]
  ).catch(() => null);
  return result?.changes ?? 0;
};

/** Today's scans on this device, newest first. */
export const todayLocal = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  await pruneOldScans(db);

  const rows = await db.getAllAsync(
    `SELECT * FROM ${EVENTS} WHERE date = ? ORDER BY at DESC`, [dayKey()]
  );

  const events = (rows ?? []).map((r) => ({
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    direction: r.direction,
    at: r.at,
    isSynced: r._synced === 1,
    method: r.method || "card",
    verificationStatus: r.verification_status ?? null,
  }));

  // Who is on site according to this device: last event of the day was an
  // arrival. Only ever this gate's view — a second gate has its own.
  const seen = new Set();
  let onSite = 0;
  for (const e of events) {
    if (seen.has(e.studentId)) continue;
    seen.add(e.studentId);
    if (e.direction === "in") onSite += 1;
  }

  return { date: dayKey(), events, onSite, pending: events.filter((e) => !e.isSynced).length };
};

export default { syncRoster, scan, recordManual, nextDirection, todayLocal, dayKey, pruneOldScans, DEBOUNCE_SECONDS };
