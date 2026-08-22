// src/services/announcement.service.js
"use strict";

import api             from "./api";
import { getDatabase } from "../db/database";
import NetInfo         from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";

// ─────────────────────────────────────────────────────────────────────────────
// TABLE INIT CACHE
// ─────────────────────────────────────────────────────────────────────────────

let tableReady = false;

const ensureTable = async (db) => {
  if (tableReady) return;

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS announcements (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      author_id       TEXT,
      author_name     TEXT,
      author_role     TEXT,
      school_id       TEXT,
      audience        TEXT DEFAULT 'all',
      target_classes  TEXT DEFAULT '[]',
      priority        TEXT DEFAULT 'normal',
      is_pinned       INTEGER DEFAULT 0,
      is_read         INTEGER DEFAULT 0,
      is_acknowledged INTEGER DEFAULT 0,
      is_active       INTEGER DEFAULT 1,
      version         INTEGER DEFAULT 1,
      publish_at      TEXT,
      expires_at      TEXT,
      deleted_at      TEXT,
      _synced         INTEGER DEFAULT 0,
      _synced_at      TEXT,
      _operation      TEXT,
      _read_pending   INTEGER DEFAULT 0,
      _ack_pending    INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_announcements_school
      ON announcements(school_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_audience
      ON announcements(audience);
    CREATE INDEX IF NOT EXISTS idx_announcements_author
      ON announcements(author_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_pinned
      ON announcements(is_pinned DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_announcements_synced
      ON announcements(_synced);
    CREATE INDEX IF NOT EXISTS idx_announcements_active
      ON announcements(is_active, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_announcements_read
      ON announcements(is_read);
  `);

  // ✅ Safe migrations — silently ignored if column already exists
  const migrations = [
    `ALTER TABLE announcements ADD COLUMN _read_pending INTEGER DEFAULT 0`,
    `ALTER TABLE announcements ADD COLUMN _ack_pending  INTEGER DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { await db.execAsync(sql); } catch { /* already exists — safe to ignore */ }
  }

  tableReady = true;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const isOnline = async () => {
  try {
    const net = await NetInfo.fetch();
    return net.isConnected === true;
  } catch {
    return false;
  }
};

const generateId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

const hasValidToken = async () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const token = useAuthStore.getState()?.token;
    if (token && token !== "offline_mode") return true;
    const stored = await SecureStore.getItemAsync("auth_token");
    return !!(stored && stored !== "offline_mode");
  } catch {
    return false;
  }
};

const getCurrentUser = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    return useAuthStore.getState()?.user || null;
  } catch {
    return null;
  }
};

const canSync = async () =>
  (await isOnline()) && (await hasValidToken());

const safeJsonParse = (str, fallback = []) => {
  try { return JSON.parse(str) ?? fallback; }
  catch { return fallback; }
};

// ─────────────────────────────────────────────────────────────────────────────
// ROLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const isAdmin   = (u) =>
  u?.role === "super_admin" ||
  u?.role === "school_admin" ||
  u?.role === "admin";

const isTeacher = (u) => u?.role === "teacher";
const isStudent = (u) => u?.role === "student";

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

const getPullEndpoint = (user) => {
  if (isAdmin(user) || isTeacher(user)) return "/announcements";
  if (isStudent(user))                  return "/students/announcements";
  return null;
};

const getPushEndpoint = (user) => {
  if (isAdmin(user) || isTeacher(user)) return "/announcements";
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT CLASS ID — local-only fast resolver
// ─────────────────────────────────────────────────────────────────────────────

const resolveStudentClassIdLocal = async (userId) => {
  if (!userId) return null;
  try {
    const db  = await getDatabase();
    const row = await db
      .getFirstAsync(
        `SELECT COALESCE(class_id, classId) AS cid
         FROM   students
         WHERE  user_id = ? OR id = ?
         LIMIT  1`,
        [userId, userId]
      )
      .catch(() => null);
    return row?.cid || null;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER CLASS RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

const getTeacherClassIds = async (teacherId, schoolId) => {
  if (!teacherId) return [];
  try {
    const db      = await getDatabase();
    const cols    = await db
      .getAllAsync(`PRAGMA table_info(teacher_assignments)`, [])
      .catch(() => []);
    const colNames = new Set(cols.map((c) => c.name));

    const tidCol = colNames.has("teacherId")  ? "teacherId"  :
                   colNames.has("teacher_id") ? "teacher_id" : null;
    const sidCol = colNames.has("schoolId")   ? "schoolId"   :
                   colNames.has("school_id")  ? "school_id"  : null;
    const clsCol = colNames.has("classId")    ? "classId"    :
                   colNames.has("class_id")   ? "class_id"   : null;
    const delCol = colNames.has("deleted_at");

    if (!tidCol || !clsCol) return [];

    const sidFilter = sidCol ? `AND ${sidCol} = ?` : "";
    const delFilter = delCol ? `AND (deleted_at IS NULL OR deleted_at = '')` : "";
    const params    = sidCol ? [teacherId, schoolId] : [teacherId];

    const rows = await db
      .getAllAsync(
        `SELECT DISTINCT ${clsCol} AS classId
         FROM teacher_assignments
         WHERE ${tidCol} = ? ${sidFilter} ${delFilter}`,
        params
      )
      .catch(() => []);

    return rows.map((r) => r.classId).filter(Boolean);
  } catch (err) {
    console.warn("getTeacherClassIds failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT CLASS RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

const getStudentClassIds = async (student) => {
  if (!student) return [];

  const studentId = String(
    student._id || student.id || student.userId || ""
  );

  // ── Strategy 1: direct fields on the user object ──────────────────────────
  const directIds = [
    student.classId,
    student.class_id,
    student.currentClass?.id,
    student.currentClass?._id,
    student.class?.id,
    student.class?._id,
    student.studentClass?.id,
    student.studentClass?._id,
  ].filter(Boolean).map(String);

  if (Array.isArray(student.classes)) {
    for (const c of student.classes) {
      if (typeof c === "string" || typeof c === "number") {
        directIds.push(String(c));
      } else if (c?.id || c?._id) {
        directIds.push(String(c.id || c._id));
      }
    }
  }
  if (Array.isArray(student.classIds)) {
    student.classIds.forEach((id) => directIds.push(String(id)));
  }

  if (directIds.length > 0) {
    return [...new Set(directIds.filter(Boolean))];
  }

  if (!studentId) return [];

  try {
    const db = await getDatabase();

    // ── Strategy 2: students table ────────────────────────────────────────
    const studentCols = await db
      .getAllAsync(`PRAGMA table_info(students)`, [])
      .catch(() => []);

    if (studentCols.length > 0) {
      const sColNames = new Set(studentCols.map((c) => c.name));

      const userIdCol =
        sColNames.has("user_id") ? "user_id" :
        sColNames.has("userId")  ? "userId"  : null;

      const classColCandidates = [
        "classId", "class_id", "class",
        "currentClassId", "current_class_id",
      ].filter((col) => sColNames.has(col));

      if (classColCandidates.length > 0) {
        const whereExtra = userIdCol ? `OR ${userIdCol} = ?` : "";
        const rowParams  = userIdCol
          ? [studentId, studentId]
          : [studentId];

        const rawRow = await db
          .getFirstAsync(
            `SELECT * FROM students WHERE (id = ? ${whereExtra}) LIMIT 1`,
            rowParams
          )
          .catch(() => null);

        if (rawRow) {
          for (const col of classColCandidates) {
            const val = rawRow[col];
            if (val != null && String(val).trim() !== "") {
              return [String(val)];
            }
          }
        }
      }
    }

    // ── Strategy 3: student_classes junction table ────────────────────────
    const junctionCols = await db
      .getAllAsync(`PRAGMA table_info(student_classes)`, [])
      .catch(() => []);

    if (junctionCols.length > 0) {
      const jColNames = new Set(junctionCols.map((c) => c.name));
      const sidJCol   =
        jColNames.has("studentId")  ? "studentId"  :
        jColNames.has("student_id") ? "student_id" :
        jColNames.has("userId")     ? "userId"     :
        jColNames.has("user_id")    ? "user_id"    : null;
      const cidJCol   =
        jColNames.has("classId")  ? "classId"  :
        jColNames.has("class_id") ? "class_id" : null;

      if (sidJCol && cidJCol) {
        const hasDeleted = jColNames.has("deleted_at");
        const rows = await db
          .getAllAsync(
            `SELECT ${cidJCol} AS classId
             FROM   student_classes
             WHERE  ${sidJCol} = ?
             ${hasDeleted
               ? "AND (deleted_at IS NULL OR deleted_at = '')"
               : ""}`,
            [studentId]
          )
          .catch(() => []);

        const ids = rows.map((r) => String(r.classId)).filter(Boolean);
        if (ids.length > 0) return [...new Set(ids)];
      }
    }
  } catch (err) {
    console.warn("[getStudentClassIds] DB error:", err.message);
  }

  return [];
};

// ─────────────────────────────────────────────────────────────────────────────
// ROW MAPPER
// ─────────────────────────────────────────────────────────────────────────────

const mapRowToAnnouncement = (row) => ({
  id:             row.id,
  _id:            row.id,
  title:          row.title,
  body:           row.body,
  authorId:       row.author_id,
  authorName:     row.author_name,
  authorRole:     row.author_role,
  schoolId:       row.school_id,
  audience:       row.audience,
  targetClasses:  safeJsonParse(row.target_classes, []),
  priority:       row.priority        || "normal",
  isPinned:       row.is_pinned       === 1,
  isRead:         row.is_read         === 1,
  isAcknowledged: row.is_acknowledged === 1,
  isActive:       row.is_active       === 1,
  version:        row.version         || 1,
  publishAt:      row.publish_at,
  expiresAt:      row.expires_at,
  createdAt:      row.created_at,
  updatedAt:      row.updated_at,
  _synced:        row._synced         === 1,
  _readPending:   row._read_pending   === 1,
  _ackPending:    row._ack_pending    === 1,
});

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP STALE
// ─────────────────────────────────────────────────────────────────────────────

const cleanupStaleAnnouncements = async (db, serverIds) => {
  if (!serverIds?.length) return;
  try {
    const localRows = await db.getAllAsync(
      `SELECT id FROM announcements
       WHERE  _synced       = 1
         AND  (_operation IS NULL OR _operation = '')
         AND  _read_pending = 0
         AND  _ack_pending  = 0`
    );
    const serverIdSet = new Set(serverIds);
    const stale       = localRows.filter((r) => !serverIdSet.has(r.id));
    for (const row of stale) {
      await db.runAsync(`DELETE FROM announcements WHERE id = ?`, [row.id]);
    }
  } catch (err) {
    console.warn("[cleanupStale] failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT LOCAL
// ─────────────────────────────────────────────────────────────────────────────

const upsertLocal = async (db, announcement) => {
  const id = announcement._id || announcement.id;
  if (!id) return;

  const existing = await db.getFirstAsync(
    `SELECT _synced, is_read, is_acknowledged, _read_pending, _ack_pending
     FROM   announcements WHERE id = ?`,
    [id]
  );

  // ✅ Never overwrite a locally-dirty record with server data
  if (existing && existing._synced === 0) return;

  const serverIsRead = (announcement.isRead || announcement.is_read) ? 1 : 0;
  const serverIsAck  = (announcement.isAcknowledged || announcement.is_acknowledged) ? 1 : 0;

  // ✅ Always keep the higher value — if locally marked read, don't revert
  const finalIsRead = Math.max(existing?.is_read ?? 0, serverIsRead);
  const finalIsAck  = Math.max(existing?.is_acknowledged ?? 0, serverIsAck);

  // ✅ Preserve any pending sync flags
  const keepReadPending = existing?._read_pending ?? 0;
  const keepAckPending  = existing?._ack_pending  ?? 0;

  await db.runAsync(
    `INSERT OR REPLACE INTO announcements
       (id, title, body, author_id, author_name, author_role, school_id,
        audience, target_classes, priority, is_pinned, is_active, version,
        publish_at, expires_at, is_read, is_acknowledged,
        _read_pending, _ack_pending, _synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      announcement.title                                                                 || "",
      announcement.body           || announcement.content                                || "",
      announcement.author?._id   || announcement.authorId    || announcement.author_id   || "",
      announcement.authorName    || announcement.author_name || announcement.author?.name || "",
      announcement.authorRole    || announcement.author_role || announcement.author?.role || "",
      announcement.schoolId      || announcement.school_id                               || "",
      announcement.audience                                                              || "all",
      JSON.stringify(announcement.targetClasses || announcement.target_classes           || []),
      announcement.priority                                                              || "normal",
      (announcement.isPinned     || announcement.is_pinned)                              ? 1 : 0,
      announcement.isActive      !== false                                               ? 1 : 0,
      announcement.version                                                               || 1,
      announcement.publishAt     || announcement.publish_at                              || null,
      announcement.expiresAt     || announcement.expires_at                              || null,
      finalIsRead,
      finalIsAck,
      keepReadPending,
      keepAckPending,
      announcement.createdAt     || announcement.created_at  || new Date().toISOString(),
      announcement.updatedAt     || announcement.updated_at  || new Date().toISOString(),
    ]
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BUILD WHERE CLAUSES
// ─────────────────────────────────────────────────────────────────────────────

const buildStudentWhereClause = async (user) => {
  const studentClassIds = await getStudentClassIds(user);
  const params = [];

  let clause = `AND (
    audience = 'all'
    OR audience = 'students'`;

  if (studentClassIds.length > 0) {
    const likes = studentClassIds.map(() => `target_classes LIKE ?`).join(" OR ");
    clause += ` OR (audience = 'class' AND (${likes}))`;
    studentClassIds.forEach((cid) => params.push(`%"${cid}"%`));
  }

  clause += `\n  )`;
  return { clause, params };
};

const buildTeacherWhereClause = async (user) => {
  const teacherId       = user?._id || user?.id;
  const teacherClassIds = await getTeacherClassIds(teacherId, user?.schoolId);
  const params          = [teacherId];

  let clause = `AND (
    audience = 'all'
    OR audience = 'teachers'
    OR author_id = ?`;

  if (teacherClassIds.length > 0) {
    const likes = teacherClassIds.map(() => `target_classes LIKE ?`).join(" OR ");
    clause += ` OR (audience = 'class' AND (${likes}))`;
    teacherClassIds.forEach((cid) => params.push(`%"${cid}"%`));
  }

  clause += `\n  )`;
  return { clause, params };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL ANNOUNCEMENTS
// ─────────────────────────────────────────────────────────────────────────────

export const getAnnouncements = async (filters = {}) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  try {
    let where    = "WHERE is_active = 1 AND (deleted_at IS NULL OR deleted_at = '')";
    const params = [];

    if (filters.audience && filters.audience !== "all") {
      where += " AND audience = ?";
      params.push(filters.audience);
    }
    if (filters.authorId) {
      where += " AND author_id = ?";
      params.push(filters.authorId);
    }
    if (filters.priority) {
      where += " AND priority = ?";
      params.push(filters.priority);
    }
    if (filters.unreadOnly) {
      where += " AND is_read = 0";
    }

    if (user && isTeacher(user)) {
      const { clause, params: rParams } = await buildTeacherWhereClause(user);
      where += ` ${clause}`;
      params.push(...rParams);
    } else if (user && isStudent(user)) {
      const { clause, params: rParams } = await buildStudentWhereClause(user);
      where += ` ${clause}`;
      params.push(...rParams);
    }

    const limit = filters.limit || 100;
    params.push(limit);

    const rows = await db.getAllAsync(
      `SELECT * FROM announcements ${where}
       ORDER BY is_pinned DESC, created_at DESC LIMIT ?`,
      params
    );

    const local = (rows || []).map(mapRowToAnnouncement);

    // ✅ Kick off a background refresh without blocking the return
    if (await canSync()) {
      _backgroundRefresh(db, user, filters).catch((err) =>
        console.warn("[getAnnouncements] Background refresh failed:", err.message)
      );
    }

    if (local.length > 0) {
      console.log(`📋 Announcements from SQLite: ${local.length}`);
      return local;
    }

    // ── Cold start — nothing local, fetch from server ─────────────────────
    if (!(await canSync())) return [];

    try {
      const endpoint = getPullEndpoint(user);
      if (!endpoint) return [];

      const response = await api.get(endpoint, {
        params: { audience: filters.audience, limit },
      });
      const data =
        response.data?.announcements ||
        response.data?.data          ||
        (Array.isArray(response.data) ? response.data : []);

      for (const a of data) await upsertLocal(db, a);
      console.log(`📡 Announcements from API (cold start): ${data.length}`);
      return data.map(mapRowToAnnouncement);
    } catch (err) {
      console.warn("[getAnnouncements] API cold-start fetch failed:", err.message);
      return [];
    }
  } catch (err) {
    console.error("[getAnnouncements] error:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND REFRESH
// ─────────────────────────────────────────────────────────────────────────────

const _backgroundRefresh = async (db, user, filters = {}) => {
  const endpoint = getPullEndpoint(user);
  if (!endpoint) return;

  try {
    const response = await api.get(endpoint, {
      params: {
        audience: filters.audience,
        limit:    filters.limit || 100,
      },
    });
    const data =
      response.data?.announcements ||
      response.data?.data          ||
      (Array.isArray(response.data) ? response.data : []);

    const serverIds = data.map((a) => a._id || a.id).filter(Boolean);
    if (serverIds.length > 0) await cleanupStaleAnnouncements(db, serverIds);

    for (const a of data) await upsertLocal(db, a);
    console.log(`🔄 Background refresh: ${data.length} announcements updated`);
  } catch (err) {
    console.warn("[_backgroundRefresh] failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE
// ─────────────────────────────────────────────────────────────────────────────

export const getAnnouncementById = async (id) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  try {
    const row = await db.getFirstAsync(
      "SELECT * FROM announcements WHERE id = ?",
      [id]
    );
    if (row) return mapRowToAnnouncement(row);

    if (!(await canSync())) return null;

    const endpoint = getPullEndpoint(user);
    if (!endpoint) return null;

    const response = await api.get(`${endpoint}/${id}`);
    const data =
      response.data?.announcement ||
      response.data?.data         ||
      response.data;

    if (data) {
      await upsertLocal(db, data);
      return mapRowToAnnouncement({ ...data, _synced: 1 });
    }
    return null;
  } catch (err) {
    console.error("[getAnnouncementById] error:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────

export const createAnnouncement = async ({
  title,
  body,
  audience      = "all",
  targetClasses = [],
  priority      = "normal",
  isPinned      = false,
  publishAt     = null,
  expiresAt     = null,
}) => {
  if (!title?.trim()) throw new Error("Title is required");
  if (!body?.trim())  throw new Error("Body is required");

  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  if (!user || isStudent(user)) {
    throw new Error("Students cannot create announcements");
  }
  const endpoint = getPushEndpoint(user);
  if (!endpoint) throw new Error("You do not have permission to create announcements");

  let finalAudience      = audience;
  let finalTargetClasses = targetClasses;

  if (isTeacher(user)) {
    const teacherId       = user._id || user.id;
    const teacherClassIds = await getTeacherClassIds(teacherId, user.schoolId);
    if (!teacherClassIds.length) {
      throw new Error(
        "You are not assigned to any classes. Contact your administrator."
      );
    }
    finalAudience = "students";
    if (!finalTargetClasses.length) {
      finalTargetClasses = teacherClassIds;
    } else {
      finalTargetClasses = finalTargetClasses.filter((cid) =>
        teacherClassIds.includes(cid)
      );
      if (!finalTargetClasses.length) {
        throw new Error(
          "You can only send to classes you are assigned to teach."
        );
      }
    }
    isPinned = false;
  }

  const id  = generateId();
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO announcements
       (id, title, body, author_id, author_name, author_role, school_id,
        audience, target_classes, priority, is_pinned, is_read, is_acknowledged,
        publish_at, expires_at, _synced, _operation, _read_pending, _ack_pending,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 'create', 0, 0, ?, ?)`,
    [
      id,
      title.trim(),
      body.trim(),
      user?.id    || user?._id   || "unknown",
      user?.name  || "Unknown",
      user?.role  || "teacher",
      user?.schoolId             || "",
      finalAudience,
      JSON.stringify(finalTargetClasses),
      priority,
      isPinned ? 1 : 0,
      publishAt,
      expiresAt,
      now,
      now,
    ]
  );

  console.log(`✅ Announcement saved locally: "${title}"`);

  if (await canSync()) {
    try {
      const response = await api.post(endpoint, {
        id,
        title:         title.trim(),
        body:          body.trim(),
        audience:      finalAudience,
        targetClasses: finalTargetClasses,
        priority,
        isPinned,
        publishAt,
        expiresAt,
      });

      if (
        response.data?.success ||
        response.data?.announcement ||
        response.data?.data
      ) {
        await db.runAsync(
          `UPDATE announcements
           SET _synced = 1, _synced_at = ?, _operation = NULL
           WHERE id = ?`,
          [now, id]
        );
        console.log("📡 Announcement synced to server");
      }
    } catch (apiErr) {
      if (apiErr?.response?.status === 409) {
        // Already exists on server — mark synced
        await db.runAsync(
          "UPDATE announcements SET _synced = 1 WHERE id = ?",
          [id]
        );
      } else {
        console.warn(
          "API sync failed — queued for later:",
          apiErr.message
        );
      }
    }
  }

  return {
    id,
    _id:           id,
    title:         title.trim(),
    body:          body.trim(),
    audience:      finalAudience,
    targetClasses: finalTargetClasses,
    priority,
    isPinned,
    isRead:         false,
    isAcknowledged: false,
    authorName:    user?.name  || "Unknown",
    authorRole:    user?.role  || "teacher",
    createdAt:     now,
    updatedAt:     now,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────

export const updateAnnouncement = async (id, updates) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  if (isTeacher(user)) {
    const row    = await db.getFirstAsync(
      "SELECT author_id FROM announcements WHERE id = ?",
      [id]
    );
    const userId = user._id || user.id;
    if (row && row.author_id !== userId) {
      throw new Error("You can only edit your own announcements");
    }
    if (updates.audience && updates.audience !== "students") {
      throw new Error("Teachers can only send to students");
    }
    if (updates.targetClasses?.length) {
      const teacherClassIds = await getTeacherClassIds(userId, user.schoolId);
      updates.targetClasses = updates.targetClasses.filter((cid) =>
        teacherClassIds.includes(cid)
      );
    }
    if (updates.isPinned !== undefined) delete updates.isPinned;
  }

  const now      = new Date().toISOString();
  const setParts = ["updated_at = ?", "_synced = 0", "_operation = 'update'"];
  const params   = [now];

  if (updates.title         !== undefined) { setParts.push("title = ?");          params.push(updates.title.trim()); }
  if (updates.body          !== undefined) { setParts.push("body = ?");            params.push(updates.body.trim()); }
  if (updates.audience      !== undefined) { setParts.push("audience = ?");        params.push(updates.audience); }
  if (updates.targetClasses !== undefined) { setParts.push("target_classes = ?"); params.push(JSON.stringify(updates.targetClasses)); }
  if (updates.priority      !== undefined) { setParts.push("priority = ?");        params.push(updates.priority); }
  if (updates.isPinned      !== undefined) { setParts.push("is_pinned = ?");       params.push(updates.isPinned ? 1 : 0); }
  if (updates.isActive      !== undefined) { setParts.push("is_active = ?");       params.push(updates.isActive ? 1 : 0); }
  if (updates.expiresAt     !== undefined) { setParts.push("expires_at = ?");      params.push(updates.expiresAt); }

  params.push(id);
  await db.runAsync(
    `UPDATE announcements SET ${setParts.join(", ")} WHERE id = ?`,
    params
  );

  if (await canSync()) {
    try {
      const endpoint = getPushEndpoint(user);
      if (endpoint) {
        await api.put(`${endpoint}/${id}`, updates);
        await db.runAsync(
          `UPDATE announcements
           SET _synced = 1, _synced_at = ?, _operation = NULL
           WHERE id = ?`,
          [now, id]
        );
      }
    } catch (err) {
      console.warn("[updateAnnouncement] sync failed:", err.message);
    }
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

export const deleteAnnouncement = async (id) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  if (isTeacher(user)) {
    const row    = await db.getFirstAsync(
      "SELECT author_id FROM announcements WHERE id = ?",
      [id]
    );
    const userId = user._id || user.id;
    if (row && row.author_id !== userId) {
      throw new Error("You can only delete your own announcements");
    }
  }

  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE announcements
     SET deleted_at = ?, is_active = 0, _synced = 0,
         _operation = 'delete', updated_at = ?
     WHERE id = ?`,
    [now, now, id]
  );

  if (await canSync()) {
    try {
      const endpoint = getPushEndpoint(user);
      if (endpoint) {
        await api.delete(`${endpoint}/${id}`);
        await db.runAsync(
          "UPDATE announcements SET _synced = 1, _synced_at = ? WHERE id = ?",
          [now, id]
        );
      }
    } catch (err) {
      if (err?.response?.status === 404) {
        // Already gone on server — mark synced
        await db.runAsync(
          "UPDATE announcements SET _synced = 1 WHERE id = ?",
          [id]
        );
      } else {
        console.warn("[deleteAnnouncement] sync failed:", err.message);
      }
    }
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK AS READ
// ─────────────────────────────────────────────────────────────────────────────

export const markAsRead = async (id) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  const existing = await db.getFirstAsync(
    "SELECT is_read, _read_pending FROM announcements WHERE id = ?",
    [id]
  );

  // ✅ FIX: skip only when BOTH read AND no pending sync — not just is_read.
  //    If _read_pending=1 and is_read=1 we still need to attempt the API call.
  if (existing?.is_read === 1 && existing?._read_pending === 0) return;

  const now = new Date().toISOString();

  // ✅ Optimistic local update first — UI stays responsive
  await db.runAsync(
    `UPDATE announcements
     SET is_read = 1, _read_pending = 1, updated_at = ?
     WHERE id = ?`,
    [now, id]
  );

  if (!(await canSync())) return; // queued — pushUnsyncedAnnouncements will retry

  // ✅ FIX: role-aware endpoint
  const endpoint = isStudent(user)
    ? `/students/announcements/${id}/read`
    : `/announcements/${id}/read`;

  try {
    await api.post(endpoint);
    await db.runAsync(
      "UPDATE announcements SET _read_pending = 0 WHERE id = ?",
      [id]
    );
  } catch (err) {
    const status = err?.response?.status;

    if (status === 404) {
      // Deleted on server — remove locally
      await db.runAsync("DELETE FROM announcements WHERE id = ?", [id]);
      return;
    }

    if (status === 401 || status === 403) {
      // Auth error — don't keep retrying, clear pending
      console.warn("[markAsRead] auth error — clearing pending:", status);
      await db.runAsync(
        "UPDATE announcements SET _read_pending = 0 WHERE id = ?",
        [id]
      );
      return;
    }

    // 5xx / network error — leave _read_pending = 1 so retry picks it up
    console.warn("[markAsRead] API call failed — queued for retry:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ACKNOWLEDGE
// ─────────────────────────────────────────────────────────────────────────────

export const acknowledgeAnnouncement = async (id) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  const existing = await db.getFirstAsync(
    "SELECT is_acknowledged, _ack_pending FROM announcements WHERE id = ?",
    [id]
  );

  // ✅ FIX: skip only when BOTH acked AND no pending sync
  if (existing?.is_acknowledged === 1 && existing?._ack_pending === 0) return;

  const now = new Date().toISOString();

  await db.runAsync(
    `UPDATE announcements
     SET is_acknowledged = 1,
         is_read         = 1,
         _ack_pending    = 1,
         _read_pending   = 0,
         updated_at      = ?
     WHERE id = ?`,
    [now, id]
  );

  if (!(await canSync())) return;

  const endpoint = isStudent(user)
    ? `/students/announcements/${id}/acknowledge`
    : `/announcements/${id}/acknowledge`;

  try {
    await api.post(endpoint);
    await db.runAsync(
      "UPDATE announcements SET _ack_pending = 0 WHERE id = ?",
      [id]
    );
  } catch (err) {
    const status = err?.response?.status;

    if (status === 404) {
      await db.runAsync("DELETE FROM announcements WHERE id = ?", [id]);
      return;
    }

    if (status === 409) {
      // Server already has it — we're in sync
      await db.runAsync(
        "UPDATE announcements SET _ack_pending = 0 WHERE id = ?",
        [id]
      );
      return;
    }

    if (status === 401 || status === 403) {
      console.warn("[acknowledge] auth error — clearing pending:", status);
      await db.runAsync(
        "UPDATE announcements SET _ack_pending = 0 WHERE id = ?",
        [id]
      );
      return;
    }

    // 5xx / network — leave _ack_pending = 1 for retry
    console.warn("[acknowledge] API failed — queued for retry:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE PIN
// ─────────────────────────────────────────────────────────────────────────────

export const togglePin = async (id) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  if (!isAdmin(user)) {
    throw new Error("Only administrators can pin announcements");
  }

  const row    = await db.getFirstAsync(
    "SELECT is_pinned FROM announcements WHERE id = ?",
    [id]
  );
  const newVal = row?.is_pinned ? 0 : 1;
  const now    = new Date().toISOString();

  await db.runAsync(
    `UPDATE announcements
     SET is_pinned = ?, _synced = 0, _operation = 'update', updated_at = ?
     WHERE id = ?`,
    [newVal, now, id]
  );

  if (await canSync()) {
    api.post(`/announcements/${id}/pin`).catch((err) =>
      console.warn("[togglePin] sync failed:", err.message)
    );
  }

  return newVal === 1;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET STATS
// Excludes teacher's own announcements so they don't appear as unread
// notifications in the teacher's own dashboard.
// ─────────────────────────────────────────────────────────────────────────────

export const getAnnouncementStats = async (filters = {}) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  try {
    let where    = "WHERE is_active = 1 AND (deleted_at IS NULL OR deleted_at = '')";
    const params = [];

    if (user && isTeacher(user)) {
      // ✅ Exclude own authored announcements — matches fetchInbox filter
      const userId = String(
        user?._id || user?.id || user?.userId || ""
      ).trim();
      if (userId) {
        where  += ` AND (author_id IS NULL OR TRIM(LOWER(author_id)) != ?)`;
        params.push(userId.toLowerCase());
      }
      const { clause, params: rParams } = await buildTeacherWhereClause(user);
      where += ` ${clause}`;
      params.push(...rParams);
    } else if (user && isStudent(user)) {
      const { clause, params: rParams } = await buildStudentWhereClause(user);
      where += ` ${clause}`;
      params.push(...rParams);
    }

    const stats = await db.getFirstAsync(
      `SELECT
         COUNT(*)                                                            AS total,
         SUM(CASE WHEN is_read        = 0 THEN 1 ELSE 0 END)               AS unread,
         SUM(CASE WHEN priority IN ('urgent','high')
                   AND is_acknowledged = 0 THEN 1 ELSE 0 END)              AS urgentUnack,
         SUM(CASE WHEN is_pinned      = 1 THEN 1 ELSE 0 END)               AS pinned,
         SUM(CASE WHEN author_role    = 'teacher' THEN 1 ELSE 0 END)       AS fromTeachers
       FROM announcements ${where}`,
      params
    );

    return {
      total:        stats?.total        || 0,
      unread:       stats?.unread       || 0,
      urgentUnack:  stats?.urgentUnack  || 0,
      pinned:       stats?.pinned       || 0,
      fromTeachers: stats?.fromTeachers || 0,
    };
  } catch (err) {
    console.warn("[getAnnouncementStats] error:", err.message);
    return { total: 0, unread: 0, urgentUnack: 0, pinned: 0, fromTeachers: 0 };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TEACHER CLASSES
// ─────────────────────────────────────────────────────────────────────────────

export const getTeacherAnnouncementClasses = async () => {
  const user = getCurrentUser();
  if (!isTeacher(user)) return [];

  const teacherId = user._id || user.id;
  const schoolId  = user.schoolId;

  try {
    const db       = await getDatabase();
    const cols     = await db
      .getAllAsync(`PRAGMA table_info(teacher_assignments)`, [])
      .catch(() => []);
    const colNames = new Set(cols.map((c) => c.name));

    const tidCol = colNames.has("teacherId")  ? "teacherId"  :
                   colNames.has("teacher_id") ? "teacher_id" : null;
    const sidCol = colNames.has("schoolId")   ? "schoolId"   :
                   colNames.has("school_id")  ? "school_id"  : null;
    const clsCol = colNames.has("classId")    ? "classId"    :
                   colNames.has("class_id")   ? "class_id"   : null;
    const delCol = colNames.has("deleted_at");

    if (!tidCol || !clsCol) return [];

    const sidFilter = sidCol ? `AND ta.${sidCol} = ?` : "";
    const delFilter = delCol
      ? `AND (ta.deleted_at IS NULL OR ta.deleted_at = '')`
      : "";
    const params = sidCol ? [teacherId, schoolId] : [teacherId];

    return await db
      .getAllAsync(
        `SELECT DISTINCT c.id, c.name, c.level, c.section
         FROM teacher_assignments ta
         JOIN classes c ON c.id = ta.${clsCol}
         WHERE ta.${tidCol} = ? ${sidFilter} ${delFilter}
           AND c.deleted_at IS NULL AND c.is_active = 1
         ORDER BY c.name ASC`,
        params
      )
      .catch(() => []);
  } catch (err) {
    console.warn("[getTeacherAnnouncementClasses] failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUSH UNSYNCED
// Retries pending reads, acks, and create/update/delete operations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queues every pending announcement change, then lets the shared outbox
 * send it.
 *
 * This used to POST/PUT/DELETE the dirty rows itself and flush read and
 * acknowledge receipts inline, each with its own ad-hoc status handling.
 * That was a parallel write path with retry rules of its own. The backfill
 * sweep now produces the same mutations — receipts marked `silent`, so a
 * failed read-receipt never surfaces as "your work didn't save" — and
 * MutationQueue sends them.
 */
export const pushUnsyncedAnnouncements = async () => {
  if (!(await canSync())) return;

  try {
    const { backfillOutbox } = require("./syncBackfill.service");
    const { MutationQueue }  = require("./mutationQueue.service");
    await backfillOutbox();
    await MutationQueue.drain({ includeUploads: false });
  } catch (err) {
    console.warn("[announcements] pushUnsyncedAnnouncements failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PULL FROM SERVER
// ─────────────────────────────────────────────────────────────────────────────

export const pullAnnouncements = async (lastSync) => {
  const db   = await getDatabase();
  await ensureTable(db);
  const user = getCurrentUser();

  const endpoint = getPullEndpoint(user);
  if (!endpoint) {
    console.log(
      `[pullAnnouncements] no endpoint for role "${user?.role}" — skipping`
    );
    return 0;
  }

  // ✅ Resolve classId locally and include in request params so the server
  //    returns class-targeted announcements for this student.
  let studentClassId = null;
  if (isStudent(user)) {
    const userId = user?._id || user?.id || user?.userId;
    studentClassId = await resolveStudentClassIdLocal(userId);
  }

  const params = {
    since:    lastSync || "1970-01-01T00:00:00Z",
    limit:    500,
    schoolId: user?.schoolId || undefined,
  };
  if (studentClassId) params.classId = studentClassId;

  let announcements = [];

  try {
    const response = await api.get(endpoint, { params });
    announcements =
      response.data?.announcements ||
      response.data?.data          ||
      (Array.isArray(response.data) ? response.data : []);
    console.log(
      `📥 Announcements pulled from ${endpoint}: ${announcements.length}`
    );
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      console.log(`[pullAnnouncements] ${endpoint} → 404`);
      return 0;
    }
    if (status === 403) {
      console.log(`[pullAnnouncements] ${endpoint} → 403`);
      return 0;
    }
    console.warn(`[pullAnnouncements] ${endpoint} failed — ${err.message}`);
    return 0;
  }

  const serverIds = announcements.map((a) => a._id || a.id).filter(Boolean);
  if (serverIds.length > 0) await cleanupStaleAnnouncements(db, serverIds);
  if (!announcements.length) return 0;

  const now   = new Date().toISOString();
  let   count = 0;

  for (const a of announcements) {
    try {
      const id = a._id || a.id;
      if (!id) continue;

      // Soft-deleted on server
      if (a.deletedAt || a.deleted_at) {
        await db.runAsync(
          `UPDATE announcements
           SET is_active = 0, deleted_at = ?, _synced = 1
           WHERE id = ?`,
          [a.deletedAt || a.deleted_at, String(id)]
        );
        continue;
      }

      const existing = await db.getFirstAsync(
        `SELECT is_read, is_acknowledged, _read_pending, _ack_pending
         FROM   announcements WHERE id = ?`,
        [String(id)]
      );

      const serverIsRead = (a.isRead || a.is_read) ? 1 : 0;
      const serverIsAck  = (a.isAcknowledged || a.is_acknowledged) ? 1 : 0;
      const finalIsRead  = Math.max(existing?.is_read         ?? 0, serverIsRead);
      const finalIsAck   = Math.max(existing?.is_acknowledged ?? 0, serverIsAck);
      const keepReadPending = existing?._read_pending ?? 0;
      const keepAckPending  = existing?._ack_pending  ?? 0;

      await db.runAsync(
        `INSERT INTO announcements
           (id, title, body, author_id, author_name, author_role,
            school_id, audience, target_classes, priority,
            is_pinned, is_active, version, is_read, is_acknowledged,
            publish_at, expires_at, deleted_at,
            _synced, _synced_at, _read_pending, _ack_pending,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title           = excluded.title,
           body            = excluded.body,
           author_name     = excluded.author_name,
           author_role     = excluded.author_role,
           audience        = excluded.audience,
           target_classes  = excluded.target_classes,
           priority        = excluded.priority,
           is_pinned       = excluded.is_pinned,
           is_active       = 1,
           version         = excluded.version,
           deleted_at      = NULL,
           is_read         = MAX(COALESCE(announcements.is_read,         0), excluded.is_read),
           is_acknowledged = MAX(COALESCE(announcements.is_acknowledged, 0), excluded.is_acknowledged),
           _read_pending   = excluded._read_pending,
           _ack_pending    = excluded._ack_pending,
           _synced         = 1,
           _synced_at      = excluded._synced_at,
           updated_at      = excluded.updated_at`,
        [
          String(id),
          a.title       || "",
          a.body        || a.content || "",
          a.author_id   || a.authorId    || null,
          a.author_name || a.authorName  || null,
          a.author_role || a.authorRole  || null,
          a.school_id   || a.schoolId    || user?.schoolId || null,
          a.audience    || "all",
          JSON.stringify(a.target_classes || a.targetClasses || []),
          a.priority    || "normal",
          (a.is_pinned  || a.isPinned)   ? 1 : 0,
          a.version     || 1,
          finalIsRead,
          finalIsAck,
          a.publish_at  || a.publishAt   || null,
          a.expires_at  || a.expiresAt   || null,
          now,
          keepReadPending,
          keepAckPending,
          a.createdAt   || a.created_at  || now,
          a.updatedAt   || a.updated_at  || now,
        ]
      );
      count++;
    } catch (err) {
      console.warn(
        `[pullAnnouncements] failed to upsert ${a._id || a.id}:`,
        err.message
      );
    }
  }

  console.log(`📥 Pulled ${count} announcement(s) from server`);
  return count;
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default {
  getAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  markAsRead,
  acknowledgeAnnouncement,
  togglePin,
  getAnnouncementStats,
  getTeacherAnnouncementClasses,
  pushUnsyncedAnnouncements,
  pullAnnouncements,
};