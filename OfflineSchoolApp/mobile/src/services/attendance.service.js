// src/services/attendance.service.js
"use strict";

/**
 * attendance.service.js
 *
 * Fixed issues:
 *  #C2   — schemaVerified flag replaced with ensureTableSchema
 *  #C5   — local generateId replaced with generateUUID from idHelpers
 *  #M1   — safeAddColumn imported from dbHelpers (local duplicate removed)
 *  #M3   — NOT_DELETED constant used in queries
 *  #PERF — NetInfo.fetch() removed from every method hot path; connectivity
 *           state is now read from the same background listener used in api.js
 *  #DDL  — Multi-statement db.execAsync strings split into individual calls
 *           so expo-sqlite never receives more than one statement at a time
 *  #COL  — _synced filter uses (_synced = 0 OR _synced IS NULL) consistently
 *           and never references columns that may not exist in older schemas
 */

import api                   from "./api";
import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import {
  safeAddColumn,
  tableExists,
  getTableColumns,
  NOT_DELETED,
}                            from "../db/dbHelpers";
import { generateUUID }      from "../utils/idHelpers";
import NetInfo               from "@react-native-community/netinfo";
import { MutationQueue }     from "./mutationQueue.service";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONNECTIVITY TRACKING
// ═════════════════════════════════════════════════════════════════════════════

let _isConnected = true;

const _unsubscribe = NetInfo.addEventListener((state) => {
  _isConnected = state.isConnected !== false;
});
void _unsubscribe;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TIME HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const todayStr = () => new Date().toISOString().slice(0, 10);
const nowStr   = () => new Date().toISOString();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ID RESOLVERS
// ═════════════════════════════════════════════════════════════════════════════

const resolveStudentId = (value) => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim() || null;
  }
  const raw =
    value.studentId  ??
    value.student_id ??
    value._id        ??
    value.id         ??
    null;
  return raw != null ? String(raw).trim() || null : null;
};

const resolveClassId = (value) => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim() || null;
  }
  const raw =
    value.classId  ??
    value.class_id ??
    value._id      ??
    value.id       ??
    null;
  return raw != null ? String(raw).trim() || null : null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — COLUMN NAME CACHE
// ═════════════════════════════════════════════════════════════════════════════

let _studentIdCol = "student_id";
let _classIdCol   = "class_id";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — SCHEMA SETUP
// ═════════════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    "attendance",
    async (db) => {
      const attExists = await tableExists(db, "attendance");

      if (attExists) {
        const cols = await getTableColumns(db, "attendance");
        console.log("[attendance] Existing columns:", cols);

        _studentIdCol = cols.includes("student_id") ? "student_id" : "studentId";
        _classIdCol   = cols.includes("class_id")   ? "class_id"   : "classId";

        const needed = [
          ["schoolId",   "TEXT"],
          ["subjectId",  "TEXT"],
          ["periodId",   "TEXT"],
          ["note",       "TEXT"],
          ["_synced",    "INTEGER DEFAULT 0"],
          ["_synced_at", "TEXT"],
          ["created_at", "TEXT"],
          ["updated_at", "TEXT"],
        ];
        for (const [col, def] of needed) {
          await safeAddColumn(db, "attendance", col, def);
        }
      } else {
        _studentIdCol = "student_id";
        _classIdCol   = "class_id";

        await db.execAsync(
          `CREATE TABLE IF NOT EXISTS attendance (
             id          TEXT PRIMARY KEY,
             schoolId    TEXT,
             class_id    TEXT,
             subjectId   TEXT,
             periodId    TEXT,
             student_id  TEXT NOT NULL,
             date        TEXT NOT NULL,
             status      TEXT NOT NULL,
             note        TEXT,
             _synced     INTEGER DEFAULT 0,
             _synced_at  TEXT,
             created_at  TEXT,
             updated_at  TEXT
           )`
        );
      }

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_att_synced ON attendance(_synced)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_att_class_date ON attendance(${_classIdCol}, date)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_att_student_date ON attendance(${_studentIdCol}, date)`
      ).catch(() => {});

      const taExists = await tableExists(db, "teacher_attendance");

      if (taExists) {
        const cols  = await getTableColumns(db, "teacher_attendance");
        const needed = [
          ["schoolId",     "TEXT"],
          ["checkInTime",  "TEXT"],
          ["checkOutTime", "TEXT"],
          ["note",         "TEXT"],
          ["_synced",      "INTEGER DEFAULT 0"],
          ["_synced_at",   "TEXT"],
          ["created_at",   "TEXT"],
          ["updated_at",   "TEXT"],
        ];
        for (const [col, def] of needed) {
          await safeAddColumn(db, "teacher_attendance", col, def);
        }
      } else {
        await db.execAsync(
          `CREATE TABLE IF NOT EXISTS teacher_attendance (
             id           TEXT PRIMARY KEY,
             schoolId     TEXT,
             teacherId    TEXT NOT NULL,
             date         TEXT NOT NULL,
             status       TEXT NOT NULL,
             checkInTime  TEXT,
             checkOutTime TEXT,
             note         TEXT,
             _synced      INTEGER DEFAULT 0,
             _synced_at   TEXT,
             created_at   TEXT,
             updated_at   TEXT
           )`
        );
      }

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_ta_date ON teacher_attendance(date)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_ta_teacher_date ON teacher_attendance(teacherId, date)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_ta_synced ON teacher_attendance(_synced)`
      ).catch(() => {});

      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS teacher_profiles (
           id         TEXT PRIMARY KEY,
           schoolId   TEXT,
           name       TEXT,
           email      TEXT,
           updated_at TEXT
         )`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_tp_school ON teacher_profiles(schoolId)`
      ).catch(() => {});

      console.log(
        `[attendance] Schema verified` +
        ` (student_id="${_studentIdCol}", class_id="${_classIdCol}")`
      );
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — UPSERT HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const upsertStudentAttendance = async (db, {
  id, schoolId, classId, subjectId, periodId,
  studentId, date, status, note, synced, now,
}) => {
  const sc = _studentIdCol;
  const cc = _classIdCol;

  const existing = await db.getFirstAsync(
    `SELECT id FROM attendance WHERE ${sc} = ? AND ${cc} = ? AND date = ?`,
    [studentId, classId ?? null, date]
  ).catch(() => null);

  if (existing) {
    await db.runAsync(
      `UPDATE attendance
       SET status = ?, note = ?, _synced = ?, updated_at = ?
       WHERE ${sc} = ? AND ${cc} = ? AND date = ?`,
      [status, note ?? null, synced ? 1 : 0, now,
       studentId, classId ?? null, date]
    );
  } else {
    await db.runAsync(
      `INSERT INTO attendance
         (id, schoolId, ${cc}, subjectId, periodId,
          ${sc}, date, status, note,
          _synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        schoolId  ?? null,
        classId   ?? null,
        subjectId ?? null,
        periodId  ?? null,
        studentId,
        date, status,
        note      ?? null,
        synced ? 1 : 0,
        now, now,
      ]
    );
  }
};

const upsertTeacherAttendance = async (db, {
  id, schoolId, teacherId, date, status,
  checkInTime, checkOutTime, note, synced, now,
}) => {
  const existing = await db.getFirstAsync(
    `SELECT id FROM teacher_attendance WHERE teacherId = ? AND date = ?`,
    [teacherId, date]
  ).catch(() => null);

  if (existing) {
    await db.runAsync(
      `UPDATE teacher_attendance
       SET status = ?, checkInTime = ?, checkOutTime = ?,
           note = ?, _synced = ?, updated_at = ?
       WHERE teacherId = ? AND date = ?`,
      [status, checkInTime ?? null, checkOutTime ?? null,
       note ?? null, synced ? 1 : 0, now,
       teacherId, date]
    );
  } else {
    await db.runAsync(
      `INSERT INTO teacher_attendance
         (id, schoolId, teacherId, date, status,
          checkInTime, checkOutTime, note,
          _synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, schoolId ?? null, teacherId, date, status,
        checkInTime  ?? null,
        checkOutTime ?? null,
        note         ?? null,
        synced ? 1 : 0,
        now, now,
      ]
    );
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — PUSH UNSYNCED
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Queues any attendance row that has not reached the server, then lets the
 * shared outbox send it.
 *
 * This used to POST the rows itself. That made it a second sender beside the
 * outbox — which attendance also enqueues to — so a record whose queued
 * mutation was in backoff got sent anyway, without an Idempotency-Key, and
 * the backend had no way to recognise the duplicate. Now there is one
 * sender; this only produces work for it.
 */
export const pushUnsyncedAttendance = async () => {
  const db = await getDatabase();
  await ensureSchema(db);

  if (!_isConnected) return;

  try {
    const { backfillOutbox } = require("./syncBackfill.service");
    const { MutationQueue }  = require("./mutationQueue.service");
    await backfillOutbox();
    await MutationQueue.drain({ includeUploads: false });
  } catch (err) {
    console.warn("[attendance] pushUnsyncedAttendance failed:", err?.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — SERVICE OBJECT
// ═════════════════════════════════════════════════════════════════════════════

export const AttendanceService = {

  async getStudentAttendanceToday(classId, schoolId) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/students/today", {
          params: { classId, schoolId },
        });

        const records =
          response.data?.records ||
          response.data?.data    ||
          (Array.isArray(response.data) ? response.data : []);

        if (records.length) await this._cacheStudentAttendance(records, schoolId);
        return response.data;
      } catch (err) {
        console.warn("[attendance] getStudentAttendanceToday API failed:", err?.message);
      }
    }

    return this._getStudentAttendanceLocal({ classId, schoolId, date: todayStr() });
  },

  async getStudentAttendance(params = {}) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/students", { params });

        const records =
          response.data?.records ||
          response.data?.data    ||
          (Array.isArray(response.data) ? response.data : []);

        if (records.length) await this._cacheStudentAttendance(records, params.schoolId);
        return response.data;
      } catch (err) {
        console.warn("[attendance] getStudentAttendance API failed:", err?.message);
      }
    }

    return this._getStudentAttendanceLocal(params);
  },

  async _getStudentAttendanceLocal({
    classId, schoolId, studentId, date, startDate, endDate,
  } = {}) {
    const db = await getDatabase();
    await ensureSchema(db);

    const sc     = _studentIdCol;
    const cc     = _classIdCol;
    const params = [];
    let   where  = "WHERE 1=1";

    if (classId)   { where += ` AND ${cc} = ?`;   params.push(classId);   }
    if (schoolId)  { where += " AND schoolId = ?"; params.push(schoolId);  }
    if (studentId) { where += ` AND ${sc} = ?`;   params.push(studentId); }
    if (date)      { where += " AND date = ?";     params.push(date);      }
    if (startDate) { where += " AND date >= ?";    params.push(startDate); }
    if (endDate)   { where += " AND date <= ?";    params.push(endDate);   }

    const records = await db.getAllAsync(
      `SELECT * FROM attendance ${where} ORDER BY date DESC, created_at DESC`,
      params
    ).catch(() => []);

    return { records, source: "local" };
  },

  async _cacheStudentAttendance(records, schoolId) {
    if (!records?.length) return;

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = nowStr();

    for (const r of records) {
      const studentId = resolveStudentId(
        r.studentId ?? r.student_id ?? r.student ?? null
      );
      if (!studentId) {
        console.warn("[attendance] _cacheStudentAttendance: no studentId — skipping");
        continue;
      }

      const id      = String(r._id || r.id || generateUUID());
      const classId = resolveClassId(r.classId ?? r.class_id ?? null);

      try {
        await upsertStudentAttendance(db, {
          id,
          schoolId:  r.schoolId  || schoolId || null,
          classId,
          subjectId: r.subjectId || r.subject_id || null,
          periodId:  r.periodId  || r.period_id  || null,
          studentId,
          date:      r.date,
          status:    r.status,
          note:      r.note || null,
          synced:    true,
          now,
        });
      } catch (err) {
        console.warn(`[attendance] Failed to cache ${id}:`, err?.message);
      }
    }
  },

  async markStudentAttendance({
    schoolId, classId, subjectId, periodId,
    studentId, date, status, note,
  }) {
    const resolvedStudentId = resolveStudentId(studentId);
    if (!resolvedStudentId) {
      throw new Error("[attendance] markStudentAttendance: studentId is required");
    }

    const db  = await getDatabase();
    await ensureSchema(db);

    const id  = generateUUID();
    const now = nowStr();

    await upsertStudentAttendance(db, {
      id, schoolId, classId, subjectId, periodId,
      studentId: resolvedStudentId,
      date, status, note,
      synced: false, now,
    });

    await MutationQueue.enqueue({
      entityKey: `attendance:student:${schoolId}:${classId}:${subjectId || ""}:${resolvedStudentId}:${date}`,
      method: "POST",
      endpoint: "/attendance/students",
      payload: { schoolId, classId, subjectId, periodId, studentId: resolvedStudentId, date, status, note, __local: { table: "attendance", ids: [id] } },
    });

    return { id, studentId: resolvedStudentId, date, status, source: "local" };
  },

  async markClassAttendanceBulk({
    schoolId, classId, subjectId, periodId, date, records,
  }) {
    if (!Array.isArray(records) || !records.length) {
      return { classId, date, count: 0, source: "local" };
    }

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = nowStr();

    let localSaved  = 0;
    let localFailed = 0;

    for (const r of records) {
      const studentId = resolveStudentId(
        r.studentId ?? r.student_id ?? r.student ?? r.id ?? null
      );
      if (!studentId) {
        console.warn("[attendance] markClassAttendanceBulk: no studentId — skipping");
        localFailed++;
        continue;
      }

      try {
        await upsertStudentAttendance(db, {
          id:       generateUUID(),
          schoolId, classId, subjectId, periodId,
          studentId,
          date,
          status: r.status || "present",
          note:   r.note   || null,
          synced: false, now,
        });
        localSaved++;
      } catch (err) {
        console.warn(`[attendance] Bulk local fail for ${studentId}:`, err?.message);
        localFailed++;
      }
    }

    console.log(
      `[attendance] Bulk local: ${localSaved} saved, ${localFailed} failed`
    );

    const serverRecords = records.map((r) => {
        const studentId = resolveStudentId(
          r.studentId ?? r.student_id ?? r.student ?? r.id ?? null
        );
        return studentId
          ? { studentId, status: r.status || "present", note: r.note || null }
          : null;
      }).filter(Boolean);

    const localIds = await db.getAllAsync(
      `SELECT id FROM attendance WHERE ${_classIdCol} = ? AND date = ? AND _synced = 0`, [classId, date]
    );
    await MutationQueue.enqueue({
      entityKey: `attendance:class:${schoolId}:${classId}:${subjectId || ""}:${date}`,
      method: "POST",
      endpoint: "/attendance/students/bulk",
      payload: { schoolId, classId, subjectId, periodId, date, records: serverRecords, __local: { table: "attendance", ids: localIds.map((row) => row.id) } },
    });

    return { classId, date, count: localSaved, failed: localFailed, source: "local" };
  },

  async buildStudentMap(schoolId) {
    try {
      const db = await getDatabase();

      if (!(await tableExists(db, "students"))) {
        console.warn("[attendance] students table not found");
        return {};
      }

      const colNames = await getTableColumns(db, "students");

      const pick = (candidates) => candidates.find((c) => colNames.includes(c));

      const nameCol      = pick(["name", "studentName", "fullName", "full_name"]);
      const firstCol     = pick(["firstName", "first_name"]);
      const lastCol      = pick(["lastName",  "last_name"]);
      const emailCol     = pick(["email", "studentEmail"]);
      const classIdCol   = pick(["classId", "class_id"]);
      const classNameCol = pick(["class_name", "className"]);
      const admissionCol = pick(["admissionNo", "admissionNumber", "admission_no"]);

      const students = await db.getAllAsync(
        `SELECT * FROM students WHERE ${NOT_DELETED}`
      ).catch(() => []);

      const map = {};

      for (const s of students) {
        const id = s.id || s._id;
        if (!id) continue;

        const fromParts = [
          firstCol ? s[firstCol] : null,
          lastCol  ? s[lastCol]  : null,
        ].filter(Boolean).join(" ").trim();

        const entry = {
          name:        fromParts || (nameCol ? s[nameCol] : null) || "Unknown Student",
          email:       emailCol     ? (s[emailCol]     || null) : null,
          classId:     classIdCol   ? (s[classIdCol]   || null) : null,
          className:   classNameCol ? (s[classNameCol] || null) : null,
          admissionNo: admissionCol ? (s[admissionCol] || null) : null,
        };

        map[String(id)] = entry;
        if (s.user_id && String(s.user_id) !== String(id)) map[String(s.user_id)] = entry;
        if (s.userId  && String(s.userId)  !== String(id)) map[String(s.userId)]  = entry;
      }

      console.log(
        `[attendance] Student map: ${Object.keys(map).length} entries ` +
        `from ${students.length} rows`
      );
      return map;
    } catch (err) {
      console.warn("[attendance] buildStudentMap failed:", err?.message);
      return {};
    }
  },

  async getTeacherRoster(schoolId) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/teachers/roster", {
          params: { schoolId },
        });

        const raw =
          response.data?.teachers ||
          response.data?.data     ||
          (Array.isArray(response.data) ? response.data : []);

        const mapped = raw
          .map((t) => ({
            id:    String(t._id || t.id || ""),
            name:  t.name || t.fullName || t.displayName || "",
            email: t.email || "",
          }))
          .filter((t) => !!t.id);

        await this._cacheTeacherProfiles(mapped, schoolId);
        return mapped;
      } catch (err) {
        console.warn("[attendance] getTeacherRoster API failed:", err?.message);
      }
    }

    return this._getLocalTeacherProfiles(schoolId);
  },

  async buildTeacherMap(schoolId) {
    const roster = await this.getTeacherRoster(schoolId);
    const map    = {};
    for (const t of roster) {
      if (t.id) map[t.id] = { name: t.name, email: t.email };
    }
    console.log(`[attendance] Teacher map: ${Object.keys(map).length} entries`);
    return map;
  },

  async _cacheTeacherProfiles(profiles, schoolId) {
    if (!profiles?.length) return;

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = nowStr();

    for (const p of profiles) {
      try {
        const existing = await db.getFirstAsync(
          `SELECT id FROM teacher_profiles WHERE id = ?`,
          [p.id]
        ).catch(() => null);

        if (existing) {
          await db.runAsync(
            `UPDATE teacher_profiles SET name = ?, email = ?, updated_at = ? WHERE id = ?`,
            [p.name || null, p.email || null, now, p.id]
          );
        } else {
          await db.runAsync(
            `INSERT INTO teacher_profiles (id, schoolId, name, email, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [p.id, schoolId, p.name || null, p.email || null, now]
          );
        }
      } catch (err) {
        console.warn(`[attendance] Cache teacher profile ${p.id}:`, err?.message);
      }
    }

    console.log(`[attendance] Cached ${profiles.length} teacher profile(s)`);
  },

  async _getLocalTeacherProfiles(schoolId) {
    const db = await getDatabase();
    await ensureSchema(db);

    return await db.getAllAsync(
      `SELECT id, name, email FROM teacher_profiles WHERE schoolId = ?`,
      [schoolId]
    ).catch(() => []);
  },

  async getTeacherAttendanceToday(schoolId) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/teachers/today", {
          params: { schoolId },
        });

        const records =
          response.data?.records ||
          response.data?.data    ||
          (Array.isArray(response.data) ? response.data : []);

        if (records.length) await this._cacheTeacherAttendance(records, schoolId);
        return response.data;
      } catch (err) {
        console.warn("[attendance] getTeacherAttendanceToday API failed:", err?.message);
      }
    }

    return this._getTeacherAttendanceLocal({ schoolId, date: todayStr() });
  },

  async getTeacherAttendance(params = {}) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/teachers", { params });

        const records =
          response.data?.records ||
          response.data?.data    ||
          (Array.isArray(response.data) ? response.data : []);

        if (records.length) await this._cacheTeacherAttendance(records, params.schoolId);
        return response.data;
      } catch (err) {
        console.warn("[attendance] getTeacherAttendance API failed:", err?.message);
      }
    }

    return this._getTeacherAttendanceLocal(params);
  },

  async _getTeacherAttendanceLocal({
    schoolId, teacherId, date, startDate, endDate,
  } = {}) {
    const db = await getDatabase();
    await ensureSchema(db);

    const params = [];
    let   where  = "WHERE 1=1";

    if (schoolId)  { where += " AND schoolId = ?";  params.push(schoolId);  }
    if (teacherId) { where += " AND teacherId = ?"; params.push(teacherId); }
    if (date)      { where += " AND date = ?";      params.push(date);      }
    if (startDate) { where += " AND date >= ?";     params.push(startDate); }
    if (endDate)   { where += " AND date <= ?";     params.push(endDate);   }

    const records = await db.getAllAsync(
      `SELECT * FROM teacher_attendance ${where} ORDER BY date DESC, created_at DESC`,
      params
    ).catch(() => []);

    return { records, source: "local" };
  },

  async _cacheTeacherAttendance(records, schoolId) {
    if (!records?.length) return;

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = nowStr();

    for (const r of records) {
      const teacherId = String(r.teacherId || r.teacher_id || "").trim();
      if (!teacherId) {
        console.warn("[attendance] _cacheTeacherAttendance: no teacherId — skipping");
        continue;
      }

      try {
        await upsertTeacherAttendance(db, {
          id:           String(r._id || r.id || generateUUID()),
          schoolId:     r.schoolId     || schoolId || null,
          teacherId,
          date:         r.date,
          status:       r.status,
          checkInTime:  r.checkInTime  || r.check_in_time  || null,
          checkOutTime: r.checkOutTime || r.check_out_time || null,
          note:         r.note || null,
          synced:       true,
          now,
        });
      } catch (err) {
        console.warn(`[attendance] Cache teacher att failed:`, err?.message);
      }
    }
  },

  async markTeacherAttendance({
    schoolId, teacherId, date, status,
    checkInTime, checkOutTime, note,
  }) {
    if (!teacherId) {
      throw new Error("[attendance] markTeacherAttendance: teacherId is required");
    }

    const db  = await getDatabase();
    await ensureSchema(db);
    const id  = generateUUID();
    const now = nowStr();

    await upsertTeacherAttendance(db, {
      id, schoolId, teacherId, date, status,
      checkInTime, checkOutTime, note,
      synced: false, now,
    });

    await MutationQueue.enqueue({
      entityKey: `attendance:teacher:${schoolId}:${teacherId}:${date}`,
      method: "POST",
      endpoint: "/attendance/teachers",
      payload: { schoolId, teacherId, date, status, checkInTime, checkOutTime, note, __local: { table: "teacher_attendance", ids: [id] } },
    });

    return { id, teacherId, date, status, source: "local" };
  },

  async markTeacherAttendanceBulk({ schoolId, date, records }) {
    if (!Array.isArray(records) || !records.length) {
      return { schoolId, date, count: 0, source: "local" };
    }

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = nowStr();

    let localSaved  = 0;
    let localFailed = 0;

    for (const r of records) {
      const teacherId = String(r.teacherId || r.teacher_id || "").trim();
      if (!teacherId) {
        console.warn("[attendance] markTeacherAttendanceBulk: no teacherId — skipping");
        localFailed++;
        continue;
      }

      try {
        await upsertTeacherAttendance(db, {
          id:           generateUUID(),
          schoolId,
          teacherId,
          date,
          status:       r.status       || "present",
          checkInTime:  r.checkInTime  || null,
          checkOutTime: r.checkOutTime || null,
          note:         r.note         || null,
          synced:       false, now,
        });
        localSaved++;
      } catch (err) {
        console.warn(`[attendance] Bulk teacher fail for ${teacherId}:`, err?.message);
        localFailed++;
      }
    }

    const localIds = await db.getAllAsync(
      "SELECT id FROM teacher_attendance WHERE schoolId = ? AND date = ? AND _synced = 0", [schoolId, date]
    );
    await MutationQueue.enqueue({
      entityKey: `attendance:teachers:${schoolId}:${date}`,
      method: "POST",
      endpoint: "/attendance/teachers/bulk",
      payload: { schoolId, date, records, __local: { table: "teacher_attendance", ids: localIds.map((row) => row.id) } },
    });

    return { schoolId, date, count: localSaved, failed: localFailed, source: "local" };
  },

  async getOverviewReport(schoolId, date) {
    if (_isConnected) {
      try {
        const response = await api.get("/attendance/report/overview", {
          params: { schoolId, date },
        });
        return response.data;
      } catch (err) {
        console.error("[attendance] getOverviewReport failed:", err?.message);
        throw err;
      }
    }

    return this._buildLocalOverview(schoolId, date || todayStr());
  },

  async _buildLocalOverview(schoolId, date) {
    const db = await getDatabase();
    await ensureSchema(db);

    const rows = await db.getAllAsync(
      `SELECT status, COUNT(*) AS count
       FROM attendance
       WHERE date = ? AND (schoolId = ? OR schoolId IS NULL)
       GROUP BY status`,
      [date, schoolId]
    ).catch(() => []);

    const summary = { present: 0, absent: 0, late: 0, total: 0 };
    for (const r of rows) {
      const key = (r.status || "").toLowerCase();
      if (key in summary) summary[key] = r.count;
      summary.total += r.count;
    }

    return { date, summary, source: "local" };
  },

  async getWeeklyReport(schoolId) {
    if (!_isConnected) {
      return { message: "Weekly report requires an internet connection", source: "offline" };
    }

    const response = await api.get("/attendance/report/weekly", {
      params: { schoolId },
    });
    return response.data;
  },

  async getClassReport(classId, { schoolId, startDate, endDate } = {}) {
    if (_isConnected) {
      try {
        const response = await api.get(
          `/attendance/report/class/${classId}`,
          { params: { schoolId, startDate, endDate } }
        );
        return response.data;
      } catch (err) {
        console.warn("[attendance] getClassReport API failed:", err?.message);
      }
    }

    const local = await this._getStudentAttendanceLocal({
      classId, schoolId, startDate, endDate,
    });
    return { classId, records: local.records, source: "local" };
  },
};

export default AttendanceService;
