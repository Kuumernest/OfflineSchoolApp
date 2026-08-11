// src/services/content.service.js
"use strict";

import api          from "./api";
import { getDatabase } from "../db/database";
import NetInfo      from "@react-native-community/netinfo";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  "syllabus", "notes", "video", "audio", "document", "image",
];

const SUMMARY_DEFAULTS = {
  total: 0, syllabus: 0, notes: 0, video: 0, audio: 0, document: 0, image: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const generateId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const nowStr = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

const normaliseContentItem = (item) => {
  if (!item || typeof item !== "object") return null;

  const subjectId   = item.subjectId?._id  || item.subjectId  || null;
  const subjectName = item.subjectId?.name || item.subjectName || null;
  const classId     = item.classId?._id    || item.classId    || null;
  const className   = item.classId?.name   || item.className  || null;

  const classIds = Array.isArray(item.classIds) && item.classIds.length
    ? item.classIds.map(String)
    : classId ? [String(classId)] : [];

  const classNames = Array.isArray(item.classNames) && item.classNames.length
    ? item.classNames.map(String)
    : className ? [String(className)] : [];

  const fileUrl = item.fileUrl || item.url || null;

  return {
    _id:           String(item._id || item.id || ""),
    id:            String(item._id || item.id || ""),
    title:         item.title               || "Untitled",
    description:   item.description         || "",
    type:          item.type?.toLowerCase() || "document",
    fileUrl,
    fileName:      item.fileName            || item.title || null,
    fileSize:      Number(item.fileSize     || item.size  || 0),
    mimeType:      item.mimeType            || null,
    thumbnail:     item.thumbnail           || null,
    subjectId:     subjectId  ? String(subjectId)  : null,
    subjectName:   subjectName              || null,
    classIds,
    classNames,
    teacherId:     String(item.teacherId    || ""),
    status:        item.status              || "active",
    viewCount:     Number(item.viewCount    || 0),
    downloadCount: Number(item.downloadCount|| 0),
    createdAt:     item.createdAt           || null,
    updatedAt:     item.updatedAt           || null,
    // Queue-specific fields
    _queued:       item._queued             || false,
    _queueId:      item._queueId            || null,
    _queueStatus:  item._queueStatus        || null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY BUILDER
// ─────────────────────────────────────────────────────────────────────────────

const buildSummaryFromItems = (items = []) => {
  const summary = { ...SUMMARY_DEFAULTS };
  summary.total = items.length;
  items.forEach((item) => {
    const t = item.type?.toLowerCase();
    if (t && Object.hasOwn(summary, t)) summary[t]++;
  });
  return summary;
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const validateUploadFields = ({ title, subjectId, classId, contentType }) => {
  const errors = [];
  if (!title?.trim())       errors.push("title is required");
  if (!subjectId?.trim())   errors.push("subjectId is required");
  if (!classId?.trim())     errors.push("classId is required");
  if (!contentType?.trim()) errors.push("contentType (type) is required");
  if (contentType && !CONTENT_TYPES.includes(contentType.toLowerCase()))
    errors.push(`contentType must be one of: ${CONTENT_TYPES.join(", ")}`);
  return errors;
};

// ─────────────────────────────────────────────────────────────────────────────
// SQLITE — ensure upload_queue table exists
// ─────────────────────────────────────────────────────────────────────────────

const ensureUploadQueue = async (db) => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS upload_queue (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL DEFAULT 'content',
      status        TEXT NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 5,
      last_error    TEXT,
      payload       TEXT NOT NULL,
      file_uri      TEXT,
      file_name     TEXT,
      file_size     INTEGER,
      mime_type     TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT,
      synced_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_uq_status
      ON upload_queue(status);
    CREATE INDEX IF NOT EXISTS idx_uq_type_status
      ON upload_queue(type, status);
  `).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — save a pending upload to SQLite
// ─────────────────────────────────────────────────────────────────────────────

const queueUpload = async ({
  title,
  description,
  subjectId,
  subjectName,
  classId,
  className,
  classIds,
  classNames,
  contentType,
  teacherId,
  url,
  file,
}) => {
  const db = await getDatabase();
  await ensureUploadQueue(db);

  const id  = generateId();
  const now = nowStr();

  const payload = JSON.stringify({
    title,
    description,
    subjectId,
    subjectName,
    classId,
    className,
    classIds,
    classNames,
    contentType,
    teacherId,
    url: url || null,
  });

  await db.runAsync(
    `INSERT INTO upload_queue
       (id, type, status, attempts, max_attempts,
        payload, file_uri, file_name, file_size, mime_type,
        created_at, updated_at)
     VALUES (?, 'content', 'pending', 0, 5,
             ?, ?, ?, ?, ?,
             ?, ?)`,
    [
      id,
      payload,
      file?.uri      || null,
      file?.name     || title || null,
      file?.size     || null,
      file?.mimeType || null,
      now,
      now,
    ]
  );

  console.log(`[uploadQueue] queued upload id=${id} title="${title}"`);

  return {
    _queueId:     id,
    _queued:      true,
    _queueStatus: "pending",
    id,
    title,
    description:  description || "",
    type:         contentType?.toLowerCase() || "document",
    subjectId,
    subjectName:  subjectName || null,
    classId,
    className:    className   || null,
    classIds:     classIds    || [classId],
    classNames:   classNames  || [],
    teacherId,
    status:       "draft",   // draft until synced
    fileUrl:      file?.uri  || url || null,
    fileName:     file?.name || null,
    fileSize:     file?.size || 0,
    mimeType:     file?.mimeType || null,
    createdAt:    now,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — get all pending uploads
// ─────────────────────────────────────────────────────────────────────────────

export const getPendingUploads = async () => {
  try {
    const db = await getDatabase();
    await ensureUploadQueue(db);

    const rows = await db.getAllAsync(
      `SELECT * FROM upload_queue
       WHERE type = 'content'
         AND status IN ('pending', 'failed')
         AND attempts < max_attempts
       ORDER BY created_at ASC`
    ).catch(() => []);

    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload || "{}"),
    }));
  } catch (err) {
    console.warn("[getPendingUploads] failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — get queue status counts
// ─────────────────────────────────────────────────────────────────────────────

export const getUploadQueueStats = async () => {
  try {
    const db = await getDatabase();
    await ensureUploadQueue(db);

    const rows = await db.getAllAsync(
      `SELECT status, COUNT(*) AS count
       FROM upload_queue
       WHERE type = 'content'
       GROUP BY status`
    ).catch(() => []);

    const stats = { pending: 0, uploading: 0, failed: 0, done: 0, total: 0 };
    rows.forEach((r) => {
      const s = r.status?.toLowerCase();
      if (s in stats) stats[s] = r.count;
      stats.total += r.count;
    });
    return stats;
  } catch {
    return { pending: 0, uploading: 0, failed: 0, done: 0, total: 0 };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — process one queued upload
// ─────────────────────────────────────────────────────────────────────────────

const processQueuedUpload = async (row, onProgress) => {
  const db  = await getDatabase();
  const now = nowStr();

  // Mark as uploading
  await db.runAsync(
    `UPDATE upload_queue
     SET status = 'uploading', attempts = attempts + 1, updated_at = ?
     WHERE id = ?`,
    [now, row.id]
  );

  const payload = typeof row.payload === "string"
    ? JSON.parse(row.payload)
    : row.payload;

  const {
    title, description, subjectId, classId, contentType,
    teacherId, url,
  } = payload;

  const type = (contentType || "document").toLowerCase();

  try {
    let response;

    if (row.file_uri) {
      // ── File upload ─────────────────────────────────────────────────────
      const formData = new FormData();
      formData.append("file", {
        uri:  row.file_uri,
        name: row.file_name     || `upload_${Date.now()}`,
        type: row.mime_type     || "application/octet-stream",
      });
      formData.append("type",        type);
      formData.append("title",       title.trim());
      formData.append("description", (description || "").trim());
      formData.append("subjectId",   subjectId.trim());
      formData.append("classId",     classId.trim());
      if (row.file_name) formData.append("fileName", row.file_name);
      if (row.file_size) formData.append("fileSize", String(row.file_size));
      if (row.mime_type) formData.append("mimeType", row.mime_type);

      response = await api.post("/teacher/content", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (evt) => {
          if (onProgress && evt.total) {
            onProgress(row.id, Math.round((evt.loaded * 100) / evt.total));
          }
        },
        timeout: 180_000,
      });
    } else {
      // ── Link / metadata only ─────────────────────────────────────────────
      response = await api.post("/teacher/content", {
        title:       title.trim(),
        description: (description || "").trim(),
        type,
        subjectId:   subjectId.trim(),
        classId:     classId.trim(),
        url:         url || null,
      });
    }

    // ── Success ───────────────────────────────────────────────────────────
    await db.runAsync(
      `UPDATE upload_queue
       SET status = 'done', synced_at = ?, updated_at = ?, last_error = NULL
       WHERE id = ?`,
      [now, now, row.id]
    );

    console.log(`[processQueuedUpload] ✅ id=${row.id} title="${title}"`);
    return { success: true, queueId: row.id, data: response.data };

  } catch (err) {
    const message = err.response?.data?.error
      || err.response?.data?.message
      || err.message
      || "Upload failed";

    // ── Check if permanently failed ────────────────────────────────────────
    const newAttempts = (row.attempts || 0) + 1;
    const maxAttempts = row.max_attempts || 5;
    const isFinal     = newAttempts >= maxAttempts;

    await db.runAsync(
      `UPDATE upload_queue
       SET status     = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
      [isFinal ? "failed" : "pending", message, now, row.id]
    );

    console.warn(
      `[processQueuedUpload] ❌ id=${row.id} attempt=${newAttempts}/${maxAttempts}:`,
      message
    );

    return { success: false, queueId: row.id, error: message, isFinal };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — process ALL pending uploads
// Call this when the app comes online or on app resume
// ─────────────────────────────────────────────────────────────────────────────

export const processPendingUploads = async ({
  onProgress,
  onItemSuccess,
  onItemError,
  onComplete,
} = {}) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    console.log("[processPendingUploads] offline — skipping");
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const pending = await getPendingUploads();

  if (pending.length === 0) {
    console.log("[processPendingUploads] queue empty");
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`[processPendingUploads] processing ${pending.length} item(s)…`);

  let succeeded = 0;
  let failed    = 0;

  for (const row of pending) {
    const result = await processQueuedUpload(row, onProgress);

    if (result.success) {
      succeeded++;
      onItemSuccess?.(result);
    } else {
      failed++;
      onItemError?.(result);
    }
  }

  const summary = { processed: pending.length, succeeded, failed };
  console.log(`[processPendingUploads] done:`, summary);
  onComplete?.(summary);
  return summary;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — delete a queued item (user cancels it)
// ─────────────────────────────────────────────────────────────────────────────

export const cancelQueuedUpload = async (queueId) => {
  try {
    const db = await getDatabase();
    await db.runAsync(
      `DELETE FROM upload_queue WHERE id = ? AND status != 'uploading'`,
      [queueId]
    );
    console.log(`[cancelQueuedUpload] cancelled id=${queueId}`);
    return true;
  } catch (err) {
    console.warn("[cancelQueuedUpload] failed:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE — retry a failed item
// ─────────────────────────────────────────────────────────────────────────────

export const retryFailedUpload = async (queueId) => {
  try {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE upload_queue
       SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'`,
      [nowStr(), queueId]
    );
    console.log(`[retryFailedUpload] reset id=${queueId}`);
    return true;
  } catch (err) {
    console.warn("[retryFailedUpload] failed:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SQLITE READ — load teacher's content from local cache
// ─────────────────────────────────────────────────────────────────────────────

const loadTeacherContentFromSQLite = async (teacherId, filters = {}) => {
  if (!teacherId) return [];

  try {
    const db       = await getDatabase();
    const tables   = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type='table'`)
      .catch(() => []);
    const tableSet = new Set(tables.map((t) => t.name));

    const tableName =
      tableSet.has("contents") ? "contents" :
      tableSet.has("content")  ? "content"  : null;

    if (!tableName) return [];

    const cols   = await db.getAllAsync(`PRAGMA table_info(${tableName})`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const teacherCol =
      colSet.has("teacherId")  ? "teacherId"  :
      colSet.has("teacher_id") ? "teacher_id" : null;

    if (!teacherCol) return [];

    const subjectCol  =
      colSet.has("subjectId")  ? "subjectId"  :
      colSet.has("subject_id") ? "subject_id" : null;
    const classCol    =
      colSet.has("classId")    ? "classId"    :
      colSet.has("class_id")   ? "class_id"   : null;
    const urlCol      =
      colSet.has("fileUrl")    ? "fileUrl"    :
      colSet.has("file_url")   ? "file_url"   :
      colSet.has("url")        ? "url"        : null;
    const fileNameCol =
      colSet.has("fileName")   ? "fileName"   :
      colSet.has("file_name")  ? "file_name"  : null;
    const fileSizeCol =
      colSet.has("fileSize")   ? "fileSize"   :
      colSet.has("file_size")  ? "file_size"  : null;
    const mimeCol     =
      colSet.has("mimeType")   ? "mimeType"   :
      colSet.has("mime_type")  ? "mime_type"  : null;
    const createdCol  =
      colSet.has("createdAt")  ? "createdAt"  :
      colSet.has("created_at") ? "created_at" : null;
    const deletedCol  =
      colSet.has("deletedAt")  ? "deletedAt"  :
      colSet.has("deleted_at") ? "deleted_at" : null;

    const deletedFilter = deletedCol
      ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
      : "";

    let q    = `SELECT * FROM ${tableName}
                WHERE (${teacherCol} = ? OR ${teacherCol} = ?)
                  ${deletedFilter}`;
    const args = [teacherId, String(teacherId)];

    if (filters.type && filters.type !== "all") {
      q += ` AND type = ?`;
      args.push(filters.type.toLowerCase());
    }
    if (filters.subject && subjectCol) {
      q += ` AND ${subjectCol} = ?`;
      args.push(filters.subject);
    }
    if (filters.classId && classCol) {
      q += ` AND ${classCol} = ?`;
      args.push(filters.classId);
    }

    q += ` ORDER BY ${createdCol || "rowid"} DESC`;

    let rows = await db.getAllAsync(q, args).catch(() => []);

    if (filters.search?.trim()) {
      const sq = filters.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.title       || "").toLowerCase().includes(sq) ||
          (r.description || "").toLowerCase().includes(sq)
      );
    }

    return rows.map((r) => normaliseContentItem({
      _id:         r.id || r._id,
      id:          r.id || r._id,
      title:       r.title,
      description: r.description,
      type:        r.type,
      fileUrl:     urlCol      ? r[urlCol]      : null,
      fileName:    fileNameCol ? r[fileNameCol] : null,
      fileSize:    fileSizeCol ? r[fileSizeCol] : 0,
      mimeType:    mimeCol     ? r[mimeCol]     : null,
      subjectId:   subjectCol  ? r[subjectCol]  : null,
      subjectName: r.subjectName || r.subject_name || null,
      classId:     classCol    ? r[classCol]    : null,
      className:   r.className || r.class_name  || null,
      teacherId,
      status:      r.status    || "active",
      createdAt:   createdCol  ? r[createdCol]  : null,
    })).filter(Boolean);

  } catch (err) {
    console.warn("[loadTeacherContentFromSQLite] failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TEACHER CONTENT  —  API first, SQLite fallback
// ─────────────────────────────────────────────────────────────────────────────

export const getTeacherContent = async (teacherId = null, filters = {}) => {
  try {
    const params = new URLSearchParams();
    if (teacherId)
      params.append("teacherId", teacherId);
    if (filters.type && filters.type !== "all")
      params.append("type",      filters.type.toLowerCase());
    if (filters.subject)
      params.append("subjectId", filters.subject);
    if (filters.classId)
      params.append("classId",   filters.classId);
    if (filters.search?.trim())
      params.append("search",    filters.search.trim());

    const query    = params.toString() ? `?${params.toString()}` : "";
    const response = await api.get(`/teacher/my-content${query}`);
    const data     = response.data ?? {};

    const rawItems = data.items || data.content || [];
    const summary  = data.summary
      ? { ...SUMMARY_DEFAULTS, ...data.summary }
      : buildSummaryFromItems(rawItems);

    const items = rawItems.map(normaliseContentItem).filter(Boolean);
    return { success: true, summary, items, source: "api" };

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error
      || err.response?.data?.message
      || err.message
      || "Unknown error";

    console.warn(`[getTeacherContent] ${status ?? "NETWORK"} — ${message}`);

    // ── SQLite fallback ────────────────────────────────────────────────────
    try {
      // Load synced content from server
      const syncedItems = await loadTeacherContentFromSQLite(teacherId, filters);

      // Also merge in any queued (pending/failed) uploads so teacher
      // can see what's waiting to be uploaded
      const db         = await getDatabase();
      await ensureUploadQueue(db);

      const queuedRows = await db.getAllAsync(
        `SELECT * FROM upload_queue
         WHERE type = 'content'
           AND status IN ('pending', 'failed', 'uploading')
         ORDER BY created_at DESC`
      ).catch(() => []);

      const queuedItems = queuedRows.map((r) => {
        const p = JSON.parse(r.payload || "{}");
        return normaliseContentItem({
          _id:          r.id,
          id:           r.id,
          title:        p.title,
          description:  p.description,
          type:         p.contentType?.toLowerCase() || "document",
          fileUrl:      r.file_uri || p.url || null,
          fileName:     r.file_name,
          fileSize:     r.file_size,
          mimeType:     r.mime_type,
          subjectId:    p.subjectId,
          subjectName:  p.subjectName,
          classId:      p.classId,
          className:    p.className,
          teacherId:    p.teacherId,
          status:       "draft",
          createdAt:    r.created_at,
          _queued:      true,
          _queueId:     r.id,
          _queueStatus: r.status,
          _lastError:   r.last_error,
          _attempts:    r.attempts,
        });
      }).filter(Boolean);

      // Queued items appear at the top
      const allItems = [...queuedItems, ...syncedItems];
      const summary  = buildSummaryFromItems(syncedItems); // summary from synced only

      console.info(
        `[getTeacherContent] SQLite fallback → ` +
        `${syncedItems.length} synced + ${queuedItems.length} queued`
      );

      return {
        success: true,
        summary,
        items:   allItems,
        source:  "sqlite",
        offline: true,
      };
    } catch (sqlErr) {
      console.warn("[getTeacherContent] SQLite fallback failed:", sqlErr.message);
    }

    return {
      success: false,
      summary: { ...SUMMARY_DEFAULTS },
      items:   [],
      source:  "none",
      error:   message,
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TEACHER SUBJECTS
// ─────────────────────────────────────────────────────────────────────────────

export const getTeacherSubjectsForContent = async (teacherId = null) => {
  try {
    const response = await api.get("/teacher/subjects-classes");
    const data     = response.data;
    if (Array.isArray(data) && data.length > 0) return data;
    if (Array.isArray(data)) return data;
    throw new Error("Unexpected response shape from /teacher/subjects-classes");
  } catch (primaryErr) {
    console.warn(
      "[getTeacherSubjectsForContent] primary route failed — trying fallback:",
      primaryErr.message
    );
  }

  try {
    const response        = await api.get("/teacher/my-subjects?grouped=true");
    const subjectsByClass = response.data?.subjectsByClass ?? [];
    const subjectMap      = new Map();

    subjectsByClass.forEach((group) => {
      const { classId, className, subjects = [] } = group;
      subjects.forEach((sub) => {
        const subId = String(sub._id || sub.subjectId || "");
        if (!subId) return;
        if (!subjectMap.has(subId)) {
          subjectMap.set(subId, {
            subjectId:   subId,
            subjectName: sub.name || sub.subjectName || "Unknown",
            classes:     [],
          });
        }
        if (classId) {
          const entry  = subjectMap.get(subId);
          const exists = entry.classes.some((c) => c.classId === String(classId));
          if (!exists) {
            entry.classes.push({
              classId:   String(classId),
              className: className || "Unknown Class",
            });
          }
        }
      });
    });

    return Array.from(subjectMap.values());
  } catch (fallbackErr) {
    console.warn(
      "[getTeacherSubjectsForContent] fallback also failed:",
      fallbackErr.message
    );
    return [];
  }
};

export const getTeacherSubjectsForUpload = getTeacherSubjectsForContent;

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD CONTENT  —  online: direct upload | offline: queue it
// ─────────────────────────────────────────────────────────────────────────────

export const uploadContent = async ({
  file,
  title,
  description  = "",
  subjectId,
  subjectName  = "",
  classIds,
  classNames   = [],
  contentType,
  teacherId,
  url          = "",
  onProgress,
}) => {
  const classId = Array.isArray(classIds)
    ? (classIds[0] || "")
    : (classIds    || "");

  const className = Array.isArray(classNames)
    ? (classNames[0] || "")
    : (classNames    || "");

  // ── Validate ───────────────────────────────────────────────────────────────
  const errors = validateUploadFields({ title, subjectId, classId, contentType });
  if (errors.length) {
    throw new Error(`Validation failed: ${errors.join("; ")}`);
  }

  const type = contentType.toLowerCase();

  // ── Check connectivity ─────────────────────────────────────────────────────
  const net = await NetInfo.fetch();

  if (!net.isConnected) {
    // ── OFFLINE — queue the upload ───────────────────────────────────────────
    console.log(`[uploadContent] offline — queuing "${title}"`);

    const queued = await queueUpload({
      title,
      description,
      subjectId,
      subjectName,
      classId,
      className,
      classIds:    Array.isArray(classIds) ? classIds : [classId],
      classNames:  Array.isArray(classNames) ? classNames : [className],
      contentType: type,
      teacherId,
      url,
      file,
    });

    return {
      success:  true,
      queued:   true,
      offline:  true,
      message:  "Upload queued — will upload automatically when online.",
      content:  queued,
      data:     queued,
    };
  }

  // ── ONLINE — upload now ────────────────────────────────────────────────────
  if (file?.uri) {
    const formData = new FormData();
    formData.append("file", {
      uri:  file.uri,
      name: file.name     || `upload_${Date.now()}`,
      type: file.mimeType || "application/octet-stream",
    });
    formData.append("type",        type);
    formData.append("title",       title.trim());
    formData.append("description", description.trim());
    formData.append("subjectId",   subjectId.trim());
    formData.append("classId",     classId.trim());
    if (file.name)     formData.append("fileName", file.name);
    if (file.size)     formData.append("fileSize", String(file.size));
    if (file.mimeType) formData.append("mimeType", file.mimeType);

    try {
      const response = await api.post("/teacher/content", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (evt) => {
          if (onProgress && evt.total) {
            onProgress(Math.round((evt.loaded * 100) / evt.total));
          }
        },
        timeout: 180_000,
      });

      const data = response.data ?? {};
      return {
        success:  true,
        queued:   false,
        offline:  false,
        content:  data.content ? normaliseContentItem(data.content) : null,
        data:     data.data    ? normaliseContentItem(data.data)    : null,
      };
    } catch (err) {
      const status  = err.response?.status;
      const message = err.response?.data?.error
        || err.response?.data?.message
        || err.message
        || "Upload failed";

      // ── If network dropped mid-upload → queue it ─────────────────────────
      if (!err.response || err.code === "ECONNABORTED") {
        console.warn(`[uploadContent] network lost mid-upload — queuing "${title}"`);
        const queued = await queueUpload({
          title, description, subjectId, subjectName,
          classId, className,
          classIds:   Array.isArray(classIds) ? classIds : [classId],
          classNames: Array.isArray(classNames) ? classNames : [className],
          contentType: type, teacherId, url, file,
        });
        return {
          success: true,
          queued:  true,
          offline: true,
          message: "Network lost — upload queued and will retry when online.",
          content: queued,
          data:    queued,
        };
      }

      console.error(`[uploadContent] multipart ${status ?? "NETWORK"} — ${message}`);
      throw new Error(message);
    }
  }

  // ── Link / metadata only ───────────────────────────────────────────────────
  try {
    const body = {
      title:       title.trim(),
      description: description.trim(),
      type,
      subjectId:   subjectId.trim(),
      classId:     classId.trim(),
      url:         url || file?.url || null,
    };

    const response = await api.post("/teacher/content", body);
    const data     = response.data ?? {};
    return {
      success:  true,
      queued:   false,
      offline:  false,
      content:  data.content ? normaliseContentItem(data.content) : null,
      data:     data.data    ? normaliseContentItem(data.data)    : null,
    };
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error
      || err.response?.data?.message
      || err.message
      || "Upload failed";

    // Queue on network failure
    if (!err.response) {
      console.warn(`[uploadContent] json upload failed — queuing "${title}"`);
      const queued = await queueUpload({
        title, description, subjectId, subjectName,
        classId, className,
        classIds:   Array.isArray(classIds) ? classIds : [classId],
        classNames: Array.isArray(classNames) ? classNames : [className],
        contentType: type, teacherId, url, file: null,
      });
      return {
        success: true,
        queued:  true,
        offline: true,
        message: "Upload queued — will upload automatically when online.",
        content: queued,
        data:    queued,
      };
    }

    console.error(`[uploadContent] json ${status ?? "NETWORK"} — ${message}`);
    throw new Error(message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE CONTENT
// ─────────────────────────────────────────────────────────────────────────────

export const deleteContent = async (contentId) => {
  if (!contentId) throw new Error("contentId is required");

  // ── If it's a queued item (not yet on server) — remove from queue ──────────
  if (contentId.includes("-") && contentId.length < 40) {
    try {
      const db = await getDatabase();
      const queued = await db.getFirstAsync(
        `SELECT id FROM upload_queue WHERE id = ?`, [contentId]
      ).catch(() => null);

      if (queued) {
        await db.runAsync(
          `DELETE FROM upload_queue WHERE id = ?`, [contentId]
        );
        console.log(`[deleteContent] removed from queue: ${contentId}`);
        return { success: true, queued: true };
      }
    } catch { /* fall through to API */ }
  }

  try {
    const response = await api.delete(`/teacher/content/${contentId}`);
    return response.data;
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error
      || err.response?.data?.message
      || err.message
      || "Delete failed";
    console.error(`[deleteContent] ${status ?? "NETWORK"} — ${message}`);
    throw new Error(message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE STATUS
// ─────────────────────────────────────────────────────────────────────────────

export const updateContentStatus = async (contentId, status) => {
  if (!contentId) throw new Error("contentId is required");

  const ALLOWED = ["active", "draft", "archived"];
  if (!ALLOWED.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${ALLOWED.join(", ")}`);
  }

  try {
    const response = await api.patch(`/teacher/content/${contentId}/status`, { status });
    return response.data;
  } catch (err) {
    const errStatus = err.response?.status;
    const message   = err.response?.data?.error
      || err.response?.data?.message
      || err.message
      || "Status update failed";
    console.error(`[updateContentStatus] ${errStatus ?? "NETWORK"} — ${message}`);
    throw new Error(message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default {
  getTeacherContent,
  getTeacherSubjectsForContent,
  getTeacherSubjectsForUpload,
  uploadContent,
  deleteContent,
  updateContentStatus,
  getPendingUploads,
  getUploadQueueStats,
  processPendingUploads,
  cancelQueuedUpload,
  retryFailedUpload,
  normaliseContentItem,
  buildSummaryFromItems,
};