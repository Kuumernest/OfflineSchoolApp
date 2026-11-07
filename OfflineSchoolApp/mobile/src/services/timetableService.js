// src/services/timetableService.js
"use strict";

import NetInfo             from "@react-native-community/netinfo";
import { getDatabase }     from "../db/database";
import { ensureTableSchema, resetTableSchema } from "../db/schemaManager";
import {
  withFkOff,
  withTransaction,
  NOT_DELETED,
  IS_DELETED,
  safeAddColumn,
  tableExists,
  getTableColumns,
}                          from "../db/dbHelpers";
import {
  isServerGeneratedId,
  generateLocalId,
}                          from "../utils/idHelpers";
import {
  getCurrentAuth,
  hasRole,
}                          from "../utils/authHelpers";
import { API }             from "./apiEndpoints";
import api                 from "./api";
import {
  canonicalDay,
  VALID_DAYS,
}                          from "../utils/timetableMappers";
import { appError }        from "../utils/appError";
import { getAllAssignments } from "./assignment.service";
import { PeriodsService }  from "./periods.service";

// The conflict detector the server and desktop run. Pure CommonJS from the
// repo's shared/ folder (metro.config.js watches it), so the list a phone
// shows offline is built by the same rules as the one it shows online.
const TTConflicts = require("../../../shared/timetableConflicts");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

const TABLE = "timetable";

// DAY_SORT_EXPR contains no user input — safe to interpolate.
// Handles all formats that may be stored: Title-case, lowercase, 3-letter codes.
const DAY_SORT_EXPR = `
  CASE LOWER(TRIM(day_of_week))
    WHEN 'monday'    THEN 1
    WHEN 'tuesday'   THEN 2
    WHEN 'wednesday' THEN 3
    WHEN 'thursday'  THEN 4
    WHEN 'friday'    THEN 5
    WHEN 'saturday'  THEN 6
    WHEN 'sunday'    THEN 7
    ELSE 99
  END
`;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ROLE-AWARE ENDPOINT RESOLUTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The timetable endpoint this session is allowed to read.
 *
 * The `|| API.admin.timetable.list` fallbacks are gone for students. Falling
 * back to a staff-only route does not degrade gracefully — it produces a 403 on
 * every open and an empty screen — so a missing student endpoint now returns
 * null and the caller skips the fetch instead of guaranteeing a failure.
 */
const getTimetableEndpoint = () => {
  if (hasRole(["super_admin", "school_admin"])) return API.admin.timetable.list;
  if (hasRole("teacher")) return API.teacher?.timetable || API.admin.timetable.list;
  return API.student?.timetable || null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — SCHEMA SETUP
// ═════════════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    TABLE,
    async (db) => {
      const exists = await tableExists(db, TABLE);

      if (!exists) {
        await db.execAsync(`
          CREATE TABLE ${TABLE} (
            _id         TEXT PRIMARY KEY,
            school_id   TEXT,
            class_id    TEXT,
            subject_id  TEXT,
            teacher_id  TEXT,
            day_of_week TEXT,
            period_id   TEXT,
            room        TEXT,
            version     INTEGER DEFAULT 1,
            deleted_at  TEXT,
            _synced     INTEGER DEFAULT 0,
            _synced_at  TEXT,
            created_at  TEXT,
            updated_at  TEXT
          )
        `);

        await db.execAsync(
          `CREATE INDEX IF NOT EXISTS idx_tt_class
             ON ${TABLE}(class_id, deleted_at)`
        );
        await db.execAsync(
          `CREATE INDEX IF NOT EXISTS idx_tt_teacher
             ON ${TABLE}(teacher_id, day_of_week, period_id)`
        );
        await db.execAsync(
          `CREATE INDEX IF NOT EXISTS idx_tt_synced
             ON ${TABLE}(_synced)`
        );

        console.log("[timetable] Table created fresh");
        return;
      }

      const cols     = await getTableColumns(db, TABLE);
      const has_id   = cols.includes("_id");
      const hasOldId = cols.includes("id");

      if (!has_id && hasOldId) {
        console.log("[timetable] Migrating schema: id → _id …");
        await migrateOldTable(db, cols);
      } else if (!has_id && !hasOldId) {
        console.warn("[timetable] No PK column found — dropping and recreating");
        await db.execAsync(`DROP TABLE IF EXISTS ${TABLE}`);
        resetTableSchema(TABLE);
        await ensureSchema(db);
        return;
      }

      await safeAddColumn(db, TABLE, "_synced",    "INTEGER DEFAULT 0");
      await safeAddColumn(db, TABLE, "_synced_at", "TEXT");
      await safeAddColumn(db, TABLE, "school_id",  "TEXT");
      await safeAddColumn(db, TABLE, "deleted_at", "TEXT");
      await safeAddColumn(db, TABLE, "created_at", "TEXT");
      await safeAddColumn(db, TABLE, "updated_at", "TEXT");
      await safeAddColumn(db, TABLE, "version",    "INTEGER DEFAULT 1");

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_tt_class
           ON ${TABLE}(class_id, deleted_at)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_tt_teacher
           ON ${TABLE}(teacher_id, day_of_week, period_id)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_tt_synced
           ON ${TABLE}(_synced)`
      ).catch(() => {});

      console.log("[timetable] Schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SCHEMA MIGRATION  (id → _id)
// ═════════════════════════════════════════════════════════════════════════════

async function migrateOldTable(db, existingCols = []) {
  const has = (col) => existingCols.includes(col);

  try {
    await withTransaction(db, async () => {
      await db.execAsync(`ALTER TABLE ${TABLE} RENAME TO ${TABLE}_backup`);

      await db.execAsync(`
        CREATE TABLE ${TABLE} (
          _id         TEXT PRIMARY KEY,
          school_id   TEXT,
          class_id    TEXT,
          subject_id  TEXT,
          teacher_id  TEXT,
          day_of_week TEXT,
          period_id   TEXT,
          room        TEXT,
          version     INTEGER DEFAULT 1,
          deleted_at  TEXT,
          _synced     INTEGER DEFAULT 0,
          _synced_at  TEXT,
          created_at  TEXT,
          updated_at  TEXT
        )
      `);

      await db.execAsync(`
        INSERT INTO ${TABLE} (
          _id, school_id, class_id, subject_id, teacher_id,
          day_of_week, period_id, room, version,
          deleted_at, created_at, updated_at
        )
        SELECT
          ${has("id")          ? "id"          : "CAST(rowid AS TEXT)"},
          ${has("school_id")   ? "school_id"   : "NULL"},
          ${has("class_id")    ? "class_id"    : "NULL"},
          ${has("subject_id")  ? "subject_id"  : "NULL"},
          ${has("teacher_id")  ? "teacher_id"  : "NULL"},
          ${has("day_of_week") ? "day_of_week" : "NULL"},
          ${has("period_id")   ? "period_id"   : "NULL"},
          ${has("room")        ? "room"        : "NULL"},
          COALESCE(${has("version")    ? "version"    : "NULL"}, 1),
          ${has("deleted_at")  ? "deleted_at"  : "NULL"},
          COALESCE(${has("created_at") ? "created_at" : "NULL"}, CURRENT_TIMESTAMP),
          COALESCE(${has("updated_at") ? "updated_at" : "NULL"}, CURRENT_TIMESTAMP)
        FROM ${TABLE}_backup
      `);

      await db.execAsync(`DROP TABLE ${TABLE}_backup`);
    });

    console.log("[timetable] Migration id → _id complete");
  } catch (err) {
    console.error("[timetable] migrateOldTable failed:", err.message);
    await db
      .execAsync(`ALTER TABLE ${TABLE}_backup RENAME TO ${TABLE}`)
      .catch(() => {});
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — REPAIR LEGACY DAY NAMES IN SQLITE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Canonicalises every day_of_week value in SQLite that does not already match
 * a VALID_DAYS entry (Title-case: "Monday", "Tuesday" …).
 *
 * This handles all three legacy formats:
 *   "MON" / "TUE"        → "Monday" / "Tuesday"   (old 3-letter codes)
 *   "monday" / "tuesday" → "Monday" / "Tuesday"   (previous fix attempt)
 *
 * Runs before every push so stale rows are always corrected before being sent.
 */

const repairLegacyDayNames = async (db) => {
  try {
    // Select rows whose day_of_week is NOT already a valid uppercase 3-letter code.
    // VALID_DAYS = ["MON","TUE","WED","THU","FRI","SAT","SUN"]
    const placeholders = VALID_DAYS.map(() => "?").join(",");
    const rows = await db.getAllAsync(
      `SELECT _id, day_of_week FROM ${TABLE}
       WHERE day_of_week IS NOT NULL
         AND TRIM(day_of_week) NOT IN (${placeholders})`,
      VALID_DAYS                         // ✅ ["MON","TUE","WED","THU","FRI","SAT","SUN"]
    );

    if (!rows?.length) return;

    console.log(
      `[timetable] repairLegacyDayNames: fixing ${rows.length} row(s)…`
    );

    await withTransaction(db, async () => {
      for (const row of rows) {
        const fixed = canonicalDay(row.day_of_week);  // now returns "MON","TUE" etc.

        if (!fixed || !VALID_DAYS.includes(fixed)) {
          console.warn(
            `[timetable] repairLegacyDayNames: cannot resolve ` +
            `"${row.day_of_week}" for _id=${row._id} — skipping`
          );
          continue;
        }

        console.log(
          `[timetable] repairLegacyDayNames: ` +
          `"${row.day_of_week}" → "${fixed}" (_id=${row._id})`
        );

        await db.runAsync(
          `UPDATE ${TABLE} SET day_of_week = ? WHERE _id = ?`,
          [fixed, row._id]
        );
      }
    });
  } catch (err) {
    console.warn("[timetable] repairLegacyDayNames failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — NORMALISE SERVER → LOCAL
// ═════════════════════════════════════════════════════════════════════════════

const resolveRef = (field, ...fallbacks) => {
  if (field && typeof field === "string") return field;
  if (field && typeof field === "object") {
    const id = field._id || field.id;
    if (id) return String(id);
  }
  for (const f of fallbacks) {
    if (f && typeof f === "string") return f;
    if (f && typeof f === "object") {
      const id = f._id || f.id;
      if (id) return String(id);
    }
  }
  return null;
};

const normaliseServerSlot = (raw, fallbackSchoolId) => {
  if (!raw) return null;

  const id = String(raw._id || raw.id || "").trim();
  if (!id) return null;

  const rawDay = raw.dayOfWeek || raw.day_of_week || null;
  const day    = rawDay ? canonicalDay(rawDay) : null;

  return {
    id,
    school_id:   resolveRef(raw.school,  raw.schoolId,  raw.school_id)  || fallbackSchoolId || null,
    class_id:    resolveRef(raw.class,   raw.classId,   raw.class_id)   || null,
    subject_id:  resolveRef(raw.subject, raw.subjectId, raw.subject_id) || null,
    teacher_id:  resolveRef(raw.teacher, raw.teacherId, raw.teacher_id) || null,
    period_id:   resolveRef(raw.period,  raw.periodId,  raw.period_id)  || null,
    day_of_week: day,               // Title-case e.g. "Monday"
    room:        raw.room      || null,
    version:     raw.version   || 1,
    deleted_at:  raw.deletedAt || raw.deleted_at || null,
    created_at:  raw.createdAt || raw.created_at || null,
    updated_at:  raw.updatedAt || raw.updated_at || null,
  };
};

const normaliseLocalSlot = (row) => ({
  id:        row._id,
  _id:       row._id,
  schoolId:  row.school_id   || null,
  classId:   row.class_id    || null,
  subjectId: row.subject_id  || null,
  teacherId: row.teacher_id  || null,
  dayOfWeek: row.day_of_week ? canonicalDay(row.day_of_week) : null,
  periodId:  row.period_id   || null,
  room:      row.room        || null,
  version:   row.version     || 1,
  _synced:   row._synced     ?? 0,
  createdAt: row.created_at  || null,
  updatedAt: row.updated_at  || null,
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — LOCAL PERSISTENCE
// ═════════════════════════════════════════════════════════════════════════════

const persistSlotsLocally = async (db, slots, timestamp) => {
  if (!slots?.length) return 0;
  const ts = timestamp ?? new Date().toISOString();
  let count = 0;

  await withFkOff(db, () =>
    withTransaction(db, async () => {
      for (const slot of slots) {
        if (slot.deleted_at) {
          await db.runAsync(
            `UPDATE ${TABLE}
             SET deleted_at = ?, _synced = 1, updated_at = ?
             WHERE _id = ?`,
            [slot.deleted_at, ts, slot.id]
          ).catch(() => {});
        } else {
          await db.runAsync(
            `INSERT INTO ${TABLE}
               (_id, school_id, class_id, subject_id, teacher_id,
                day_of_week, period_id, room, version,
                _synced, _synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(_id) DO UPDATE SET
               class_id    = excluded.class_id,
               subject_id  = excluded.subject_id,
               teacher_id  = excluded.teacher_id,
               day_of_week = excluded.day_of_week,
               period_id   = excluded.period_id,
               room        = excluded.room,
               version     = excluded.version,
               deleted_at  = excluded.deleted_at,
               _synced     = 1,
               _synced_at  = excluded._synced_at,
               updated_at  = excluded.updated_at`,
            [
              slot.id,
              slot.school_id,
              slot.class_id,
              slot.subject_id,
              slot.teacher_id,
              slot.day_of_week,
              slot.period_id,
              slot.room,
              slot.version,
              ts,
              slot.created_at || ts,
              slot.updated_at || ts,
            ]
          );
        }
        count++;
      }
    })
  );

  return count;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — SYNC: PULL FROM SERVER
// ═════════════════════════════════════════════════════════════════════════════

export const syncTimetableFromServer = async (filterClassId = null) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    console.log("[timetable] Offline — skipping pull");
    return 0;
  }

  const db           = await getDatabase();
  const { schoolId } = getCurrentAuth();
  await ensureSchema(db);

  try {
    const params = {};
    if (schoolId)      params.schoolId = schoolId;
    if (filterClassId) params.classId  = filterClassId;

    console.log("[timetable] Pulling from server with params:", params);

    const endpoint = getTimetableEndpoint();
    if (!endpoint) {
      console.log("[timetable] No endpoint for this role — skipping pull");
      return 0;
    }

    const response = await api.get(endpoint, {
      params,
      timeout: 20_000,
    });

    const raw =
      response.data?.slots     ||
      response.data?.timetable ||
      response.data?.data      ||
      (Array.isArray(response.data) ? response.data : null);

    if (!raw?.length) {
      console.log("[timetable] No slots returned from server");
      return 0;
    }

    const ts    = new Date().toISOString();
    const slots = raw
      .map((s) => normaliseServerSlot(s, schoolId))
      .filter(Boolean);

    console.log(`[timetable] Normalised ${slots.length} slot(s) from server`);
    if (slots.length > 0) {
      // ✅ This log will confirm what format the server actually returns
      console.log(
        "[timetable] sample from server — raw dayOfWeek:",
        raw[0]?.dayOfWeek ?? raw[0]?.day_of_week,
        "→ canonical:", slots[0].day_of_week
      );
    }

    const synced = await persistSlotsLocally(db, slots, ts);
    console.log(`[timetable] Persisted ${synced}/${slots.length} slot(s) locally`);
    return synced;
  } catch (err) {
    console.warn("[timetable] syncTimetableFromServer failed:", err.message);
    return 0;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — SYNC: PUSH TO SERVER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Queues every pending timetable change, then lets the shared outbox send it.
 *
 * This used to do the sending itself — PUT/POST/DELETE per row, with its own
 * id reconciliation and its own 409 handling. That made it a second sender
 * beside the outbox, with retry rules that differed from everything else in
 * the app. The reconciliation moved to a registered reconciler; the legacy
 * day-name repair still runs first so no row is queued with a day the server
 * would reject.
 *
 * Screens call this for an immediate push after an edit, so it drains as well
 * as enqueues. Attachments are skipped: a timetable slot has none.
 */
export const pushUnsyncedTimetableSlots = async () => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    console.log("[timetable] Offline — changes stay queued");
    return;
  }

  const db = await getDatabase();
  await ensureSchema(db);
  await repairLegacyDayNames(db);

  try {
    const { backfillOutbox } = require("./syncBackfill.service");
    const { MutationQueue }  = require("./mutationQueue.service");
    await backfillOutbox();
    const result = await MutationQueue.drain({ includeUploads: false });
    if (result.synced || result.failed) console.log("[timetable] Push:", result);
  } catch (err) {
    console.warn("[timetable] pushUnsyncedTimetableSlots failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — CONFLICT CHECKS
// ═════════════════════════════════════════════════════════════════════════════

const assertNoConflict = async (db, slot, excludeId = null) => {
  const { classId, teacherId, periodId } = slot;
  const dayOfWeek                        = canonicalDay(slot.dayOfWeek);
  const excludeClause                    = excludeId ? "AND _id != ?" : "";

  const classParams = [classId, dayOfWeek, periodId];
  if (excludeId) classParams.push(excludeId);

  const classConflict = await db.getFirstAsync(
    `SELECT _id FROM ${TABLE}
     WHERE class_id              = ?
       AND LOWER(TRIM(day_of_week)) = LOWER(TRIM(?))
       AND period_id             = ?
       AND ${NOT_DELETED}
       ${excludeClause}
     LIMIT 1`,
    classParams
  );
  if (classConflict) throw appError("svcErr.classSlotConflict", "This class already has a lesson in this period");

  const teacherParams = [teacherId, dayOfWeek, periodId];
  if (excludeId) teacherParams.push(excludeId);

  const teacherConflict = await db.getFirstAsync(
    `SELECT _id FROM ${TABLE}
     WHERE teacher_id               = ?
       AND LOWER(TRIM(day_of_week)) = LOWER(TRIM(?))
       AND period_id                = ?
       AND ${NOT_DELETED}
       ${excludeClause}
     LIMIT 1`,
    teacherParams
  );
  if (teacherConflict) throw appError("svcErr.teacherSlotConflict", "This teacher is already teaching in this period");

  // A room, when one is given, holds one class at a time. Case and spacing
  // are ignored, as the server's detector ignores them.
  const room = String(slot.room ?? "").trim().toLowerCase();
  if (!room) return;
  const roomParams = [room, dayOfWeek, periodId, classId];
  if (excludeId) roomParams.push(excludeId);
  const roomConflict = await db.getFirstAsync(
    `SELECT _id FROM ${TABLE}
     WHERE LOWER(TRIM(room))           = ?
       AND LOWER(TRIM(day_of_week))    = LOWER(TRIM(?))
       AND period_id                   = ?
       AND class_id                   != ?
       AND ${NOT_DELETED}
       ${excludeClause}
     LIMIT 1`,
    roomParams
  );
  if (roomConflict) throw appError("svcErr.roomSlotConflict", "This room is already booked in this period");
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10b — CONFLICT DETAIL, CHECKS AND FIXES
//
// Online these come from the server, which sees every device's lessons.
// Offline (or when the request fails) the same shared detector runs against
// the rows on this phone, so the screen still says which lessons clash and
// how to fix them — possibly a sync behind, which `source` reports.
// ═════════════════════════════════════════════════════════════════════════════

const isAdminSession = () => hasRole(["super_admin", "school_admin"]);

const isOnline = async () => {
  try { return Boolean((await NetInfo.fetch()).isConnected); } catch { return false; }
};

const safeRows = async (db, table) =>
  (await tableExists(db, table))
    ? (await db.getAllAsync(`SELECT * FROM ${table}`).catch(() => [])) ?? []
    : [];

const notDeletedRow = (r) => !(r.deleted_at || r.deletedAt || r.deletedat);

/** The detector's context, built from this phone's own tables. */
const loadLocalConflictContext = async () => {
  const db = await getDatabase();
  await ensureSchema(db);

  const [slots, periods, assignments, classRows, subjectRows, userRows] = await Promise.all([
    timetableService.getAll(),
    PeriodsService.getAllFromSQLite(false).catch(() => []),
    getAllAssignments().catch(() => []),
    safeRows(db, "classes"),
    safeRows(db, "subjects"),
    safeRows(db, "users"),
  ]);

  const rowId = (r) => r._id ?? r.id;
  const teachers = new Map();
  for (const u of userRows.filter(notDeletedRow)) teachers.set(String(rowId(u)), { _id: rowId(u), name: u.name });
  for (const a of assignments) {
    if (a.teacher?._id && a.teacher?.name && !teachers.has(String(a.teacher._id))) {
      teachers.set(String(a.teacher._id), { _id: a.teacher._id, name: a.teacher.name });
    }
  }

  return TTConflicts.buildContext({
    slots,
    periods: periods.map((p) => ({ ...p, _id: p.id })),
    classes: classRows.filter(notDeletedRow).map((c) => ({ _id: rowId(c), name: c.name, section: c.section })),
    subjects: subjectRows.filter(notDeletedRow).map((x) => ({ _id: rowId(x), name: x.name })),
    teachers: [...teachers.values()],
    assignments: assignments.map((a) => ({
      teacher: a.teacher?._id, class: a.class?._id, subject: a.subject?._id,
      isActive: a.isActive === 0 || a.isActive === false ? false : true,
    })),
  });
};

const localise = (list, lang) =>
  lang === "fr"
    ? list.map((c) => ({ ...c, message: TTConflicts.conflictMessage(c, "fr") }))
    : list;

/** The local conflict count — what the dashboard shows when it is offline. */
export const countLocalConflicts = async () =>
  TTConflicts.detectConflicts(await loadLocalConflictContext()).length;

/**
 * Every conflict in the school. `{ conflicts, source: "server" | "local" }`.
 */
export const getConflicts = async (lang = "en") => {
  if (await isOnline()) {
    try {
      const res = await api.get(API.admin.timetable.conflicts, { params: { lang }, timeout: 20_000 });
      if (Array.isArray(res.data?.conflicts)) {
        return { conflicts: res.data.conflicts, source: "server" };
      }
    } catch (err) {
      console.warn("[timetable] getConflicts server failed — using local:", err.message);
    }
  }
  const ctx = await loadLocalConflictContext();
  return { conflicts: localise(TTConflicts.detectConflicts(ctx), lang), source: "local" };
};

/**
 * The fixes on offer for one entry: { freePeriods, freeTeachers, swaps }.
 */
export const getResolutionOptions = async (entryId) => {
  if (await isOnline()) {
    try {
      const res = await api.get(API.admin.timetable.options(entryId), { timeout: 20_000 });
      if (res.data?.success) {
        const { freePeriods = [], freeTeachers = [], swaps = [] } = res.data;
        return { freePeriods, freeTeachers, swaps };
      }
    } catch (err) {
      console.warn("[timetable] getResolutionOptions server failed — using local:", err.message);
    }
  }
  return TTConflicts.resolutionOptions(await loadLocalConflictContext(), entryId);
};

/**
 * The conflicts a slot would be part of if saved as given (with `_id` when
 * editing). `{ conflicts, canForce }` — canForce only for administrators.
 */
export const checkSlot = async (candidate, lang = "en") => {
  const body = { ...candidate, dayOfWeek: canonicalDay(candidate?.dayOfWeek) };
  if (await isOnline()) {
    try {
      const res = await api.post(API.admin.timetable.check, body, { params: { lang }, timeout: 15_000 });
      if (Array.isArray(res.data?.conflicts)) {
        return { conflicts: res.data.conflicts, canForce: Boolean(res.data.canForce) };
      }
    } catch (err) {
      console.warn("[timetable] checkSlot server failed — using local:", err.message);
    }
  }
  const ctx = await loadLocalConflictContext();
  return {
    conflicts: localise(TTConflicts.checkSlot(ctx, body), lang),
    canForce:  isAdminSession(),
  };
};

/**
 * Quick fixes for a lesson that is not saved yet (or is being edited): the
 * free periods for its class and teacher, and the free teachers of its
 * subject. Worked out on this phone's rows — the editor's suggestions — and
 * the save itself is still checked in full before it is accepted.
 */
export const suggestFixes = async (candidate) => {
  const ctx  = await loadLocalConflictContext();
  const cand = TTConflicts.buildContext({ slots: [candidate] }).slots[0];
  if (!cand) return { freePeriods: [], freeTeachers: [] };
  const candId = cand._id || "__candidate__";
  const next = { ...ctx, slots: [...ctx.slots.filter((x) => x._id !== candId), { ...cand, _id: candId }] };
  return {
    freePeriods:  TTConflicts.freePeriods(next, candId),
    freeTeachers: TTConflicts.freeTeachers(next, candId),
  };
};

/**
 * The error a save throws when the server refuses it with a conflict. Carries
 * the server's full list so the editor can show it inline.
 */
const conflictError = (err) => {
  const data = err?.response?.data;
  const e = new Error(data?.error || "This lesson conflicts with another one");
  e.conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
  e.canForce  = Boolean(data?.canForce);
  e.isConflict = true;
  return e;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — PUBLIC SERVICE OBJECT
// ═════════════════════════════════════════════════════════════════════════════

export const timetableService = {

  async getByClass(classId) {
    if (!classId) return [];
    const db = await getDatabase();
    await ensureSchema(db);

    try {
      await syncTimetableFromServer(classId);
    } catch (err) {
      console.warn("[timetable] getByClass server sync failed:", err.message);
    }

    try {
      const rows = await db.getAllAsync(
        `SELECT * FROM ${TABLE}
         WHERE class_id = ? AND ${NOT_DELETED}
         ORDER BY ${DAY_SORT_EXPR}, period_id`,
        [classId]
      );
      return (rows ?? []).map(normaliseLocalSlot);
    } catch (err) {
      console.error("[timetable] getByClass local query error:", err.message);
      return [];
    }
  },

  async getAll(overrideSchoolId = null) {
    const db               = await getDatabase();
    await ensureSchema(db);
    const { schoolId }     = getCurrentAuth();
    const resolvedSchoolId = overrideSchoolId || schoolId;

    try {
      const params = [];
      let   where  = `WHERE ${NOT_DELETED}`;

      if (resolvedSchoolId) {
        where += " AND (school_id = ? OR school_id IS NULL OR school_id = '')";
        params.push(resolvedSchoolId);
      }

      const rows = await db.getAllAsync(
        `SELECT * FROM ${TABLE} ${where}
         ORDER BY class_id, ${DAY_SORT_EXPR}, period_id`,
        params
      );
      return (rows ?? []).map(normaliseLocalSlot);
    } catch (err) {
      console.error("[timetable] getAll error:", err.message);
      return [];
    }
  },

  /**
   * `force` ("Save anyway") skips the conflict check — honoured for
   * administrators only, here and on the server.
   */
  async createSlot({
    classId, subjectId, teacherId, dayOfWeek, periodId, room, schoolId, force = false,
  }) {
    if (!classId || !subjectId || !teacherId || !dayOfWeek || !periodId) {
      throw new Error(
        "[timetable] classId, subjectId, teacherId, dayOfWeek, and periodId are required"
      );
    }

    const db                         = await getDatabase();
    await ensureSchema(db);
    const { schoolId: authSchoolId } = getCurrentAuth();
    const resolvedSchoolId           = schoolId || authSchoolId;
    const normalisedDay              = canonicalDay(dayOfWeek);
    const ts                         = new Date().toISOString();

    if (!normalisedDay || !VALID_DAYS.includes(normalisedDay)) {
      throw new Error(
        `[timetable] Invalid dayOfWeek: "${dayOfWeek}" ` +
        `(resolved to "${normalisedDay}"). ` +
        `Expected one of: ${VALID_DAYS.join(", ")}`
      );
    }

    const forced = force === true && isAdminSession();
    if (!forced) {
      await assertNoConflict(db, { classId, teacherId, dayOfWeek: normalisedDay, periodId, room });
    }

    const localId = generateLocalId();

    await withFkOff(db, async () => {
      await db.runAsync(
        `INSERT INTO ${TABLE}
           (_id, school_id, class_id, subject_id, teacher_id,
            day_of_week, period_id, room, version, _synced, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        [
          localId, resolvedSchoolId, classId, subjectId, teacherId,
          normalisedDay, periodId, room?.trim() || null, ts, ts,
        ]
      );
    });

    console.log(`[timetable] Slot saved locally: ${localId} (${normalisedDay})`);

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[timetable] Offline — slot queued for sync");
      return localId;
    }

    try {
      const response = await api.post(API.admin.timetable.list, {
        schoolId:  resolvedSchoolId,
        classId,
        subjectId,
        teacherId,
        dayOfWeek: normalisedDay,    // ✅ Title-case
        periodId,
        room:      room?.trim() || null,
        ...(forced ? { force: true } : {}),
      });

      const serverSlot = response.data?.slot || response.data?.data;
      const serverId   = serverSlot?._id
        ? String(serverSlot._id)
        : serverSlot?.id ? String(serverSlot.id) : null;

      if (serverId && serverId !== localId) {
        await withFkOff(db, async () => {
          await db.runAsync(`DELETE FROM ${TABLE} WHERE _id = ?`, [localId]);
          await db.runAsync(
            `INSERT OR REPLACE INTO ${TABLE}
               (_id, school_id, class_id, subject_id, teacher_id,
                day_of_week, period_id, room, version,
                _synced, _synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
            [
              serverId, resolvedSchoolId, classId, subjectId, teacherId,
              normalisedDay, periodId, room?.trim() || null, ts, ts, ts,
            ]
          );
        });
        console.log(`[timetable] Slot synced: ${localId} → ${serverId}`);
        return serverId;
      }

      await db.runAsync(
        `UPDATE ${TABLE}
         SET _synced = 1, _synced_at = ?, updated_at = ?
         WHERE _id = ?`,
        [ts, ts, localId]
      );
      return localId;
    } catch (err) {
      if (err?.response?.status === 409 && err.response.data?.conflicts) {
        // The server sees lessons this phone has not synced yet. The slot
        // was refused, so it must not stay behind locally as if it existed.
        await db.runAsync(`DELETE FROM ${TABLE} WHERE _id = ?`, [localId]);
        throw conflictError(err);
      } else if (err?.response?.status === 409) {
        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE _id = ?`,
          [ts, localId]
        );
        console.log(`[timetable] Conflict — slot already on server: ${localId}`);
      } else {
        console.warn(`[timetable] Server push failed — slot queued: ${err.message}`);
      }
      return localId;
    }
  },

  async updateSlot(id, { subjectId, teacherId, classId, dayOfWeek, periodId, room, force = false }) {
    if (!id) throw new Error("[timetable] Slot ID is required");

    const db = await getDatabase();
    await ensureSchema(db);

    const current = await db.getFirstAsync(
      `SELECT * FROM ${TABLE} WHERE _id = ? LIMIT 1`, [id]
    );
    if (!current) throw new Error("[timetable] Slot not found");

    const normalisedDay = canonicalDay(dayOfWeek ?? current.day_of_week);

    if (!normalisedDay || !VALID_DAYS.includes(normalisedDay)) {
      throw new Error(
        `[timetable] Invalid dayOfWeek: "${dayOfWeek}" ` +
        `(resolved to "${normalisedDay}"). ` +
        `Expected one of: ${VALID_DAYS.join(", ")}`
      );
    }

    const resolved = {
      classId:   classId   || current.class_id,
      teacherId: teacherId || current.teacher_id,
      dayOfWeek: normalisedDay,
      periodId:  periodId  || current.period_id,
      room:      room === undefined ? current.room : room,
    };

    const forced = force === true && isAdminSession();
    if (!forced) await assertNoConflict(db, resolved, id);

    const ts          = new Date().toISOString();
    const resolvedRoom = room === undefined
      ? current.room
      : (room?.trim() || null);

    await withFkOff(db, async () => {
      await db.runAsync(
        `UPDATE ${TABLE}
         SET subject_id  = COALESCE(?, subject_id),
             teacher_id  = COALESCE(?, teacher_id),
             class_id    = COALESCE(?, class_id),
             day_of_week = ?,
             period_id   = COALESCE(?, period_id),
             room        = ?,
             updated_at  = ?,
             _synced     = 0,
             version     = version + 1
         WHERE _id = ?`,
        [
          subjectId  || null,
          teacherId  || null,
          classId    || null,
          normalisedDay,
          periodId   || null,
          resolvedRoom,
          ts,
          id,
        ]
      );
    });

    console.log(`[timetable] Slot updated locally: ${id} (${normalisedDay})`);

    if (!isServerGeneratedId(id)) {
      console.log("[timetable] Local-only ID — will sync on next push");
      return true;
    }

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[timetable] Offline — update queued for sync");
      return true;
    }

    try {
      await api.put(API.admin.timetable.detail(id), {
        subjectId: subjectId || current.subject_id,
        teacherId: teacherId || current.teacher_id,
        classId:   classId   || current.class_id,
        dayOfWeek: normalisedDay,    // ✅ Title-case
        periodId:  periodId  || current.period_id,
        room:      resolvedRoom,
        ...(forced ? { force: true } : {}),
      });

      await db.runAsync(
        `UPDATE ${TABLE}
         SET _synced = 1, _synced_at = ?, updated_at = ?
         WHERE _id = ?`,
        [ts, ts, id]
      );
      console.log(`[timetable] Update synced: ${id}`);
    } catch (err) {
      if (err?.response?.status === 404) {
        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE _id = ?`,
          [ts, id]
        );
      } else if (err?.response?.status === 409 && err.response.data?.conflicts) {
        // Refused for a conflict this phone could not see: put the row back
        // as the server still has it, so the local copy does not drift.
        await db.runAsync(
          `UPDATE ${TABLE}
           SET subject_id = ?, teacher_id = ?, class_id = ?, day_of_week = ?,
               period_id = ?, room = ?, version = ?, updated_at = ?, _synced = 1
           WHERE _id = ?`,
          [
            current.subject_id, current.teacher_id, current.class_id, current.day_of_week,
            current.period_id, current.room, current.version, current.updated_at, id,
          ]
        );
        throw conflictError(err);
      } else {
        console.warn(`[timetable] Update push failed: ${err.message}`);
      }
    }

    return true;
  },

  async deleteSlot(id) {
    if (!id) throw new Error("[timetable] Slot ID is required");

    const db = await getDatabase();
    await ensureSchema(db);
    const ts = new Date().toISOString();

    if (!isServerGeneratedId(id)) {
      await db.runAsync(`DELETE FROM ${TABLE} WHERE _id = ?`, [id]);
      console.log(`[timetable] Local-only slot hard-deleted: ${id}`);
      return true;
    }

    await db.runAsync(
      `UPDATE ${TABLE}
       SET deleted_at = ?, updated_at = ?, _synced = 0
       WHERE _id = ?`,
      [ts, ts, id]
    );
    console.log(`[timetable] Slot soft-deleted locally: ${id}`);

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[timetable] Offline — delete queued for sync");
      return true;
    }

    try {
      await api.delete(API.admin.timetable.detail(id));
      await db.runAsync(`DELETE FROM ${TABLE} WHERE _id = ?`, [id]);
      console.log(`[timetable] Delete synced: ${id}`);
    } catch (err) {
      if (err?.response?.status === 404) {
        await db.runAsync(`DELETE FROM ${TABLE} WHERE _id = ?`, [id]);
        console.log(`[timetable] Slot already absent on server: ${id}`);
      } else {
        console.warn(
          `[timetable] Delete push failed — will retry on next sync: ${err.message}`
        );
      }
    }

    return true;
  },

  async fullSync(classId = null) {
    await pushUnsyncedTimetableSlots();
    const pulled = await syncTimetableFromServer(classId);
    return { pulled };
  },
};

export default timetableService;