// src/services/student.content.service.js
"use strict";

import api from "./api";
import { getDatabase } from "../db/database";

const CONTENT_TYPES = [
  "syllabus", "notes", "video", "audio", "document", "image",
];

export const resolveTypeFromItem = ({ type, mimeType, fileName, fileUrl } = {}) => {
  const explicit = (type || "").toLowerCase().trim();
  if (explicit && CONTENT_TYPES.includes(explicit)) return explicit;
  if (explicit && explicit !== "other" && explicit !== "") return explicit;

  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("video/"))       return "video";
  if (mime.startsWith("image/"))       return "image";
  if (mime.startsWith("audio/"))       return "audio";
  if (mime === "application/pdf")      return "document";
  if (mime.startsWith("application/")) return "document";
  if (mime.startsWith("text/"))        return "notes";

  const src = (fileName || fileUrl || "").toLowerCase();
  const ext = src.split(".").pop() || "";
  if (["mp4","mov","avi","mkv","webm","m4v"].includes(ext))                     return "video";
  if (["mp3","wav","aac","m4a","ogg"].includes(ext))                            return "audio";
  if (["jpg","jpeg","png","gif","webp","svg","bmp"].includes(ext))              return "image";
  if (["pdf","doc","docx","ppt","pptx","xls","xlsx","txt","csv"].includes(ext)) return "document";

  return "notes";
};

export const normaliseContentItem = (item) => {
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

  const fileUrl =
    item.fileUrl         ||
    item.resolvedFileUrl ||
    item.file_url        ||
    item.url             ||
    null;

  const resolvedType = resolveTypeFromItem({
    type:     item.type     || item.content_type,
    mimeType: item.mimeType || item.mime_type,
    fileName: item.fileName || item.file_name || item.title,
    fileUrl,
  });

  return {
    _id:           String(item._id || item.id || ""),
    id:            String(item._id || item.id || ""),
    title:         item.title       || item.file_name || item.fileName || "Untitled",
    description:   item.description || "",
    type:          resolvedType,
    fileUrl,
    fileName:      item.fileName    || item.file_name || item.title || null,
    fileSize:      Number(item.fileSize || item.file_size || item.size || 0),
    mimeType:      item.mimeType    || item.mime_type  || null,
    thumbnail:     item.thumbnail   || null,
    subjectId:     subjectId ? String(subjectId) : null,
    subjectName:   subjectName || null,
    classIds,
    classNames,
    teacherId:     String(item.teacherId    || item.teacher_id    || ""),
    uploaderName:  item.uploaderName || item.uploader_name || null,
    status:        item.status       || "active",
    viewCount:     Number(item.viewCount     || item.view_count     || 0),
    downloadCount: Number(item.downloadCount || item.download_count || 0),
    createdAt:     item.createdAt    || item.created_at  || null,
    updatedAt:     item.updatedAt    || item.updated_at  || null,
    _table:        item._table       || null,
  };
};

const buildSummary = (items = []) => {
  const s = {
    total: 0, syllabus: 0, notes: 0,
    video: 0, audio:    0, document: 0, image: 0,
  };
  s.total = items.length;
  items.forEach((item) => {
    const t = item.type;
    if (t && Object.hasOwn(s, t)) s[t]++;
  });
  return s;
};

const safeFetch = async (url) => {
  try {
    const res = await api.get(url);
    return res.data ?? null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404 || !status) return null;
    console.warn(
      `[safeFetch] ${status} ← ${url}:`,
      err.response?.data?.message || err.message
    );
    return null;
  }
};

const CANDIDATE_TABLES = [
  "subject_content",
  "subject_contents",
  "subject_materials",
  "subject_resources",
  "lesson_materials",
  "content",
  "contents",
  "materials",
  "resources",
  "class_content",
];

export const loadContentFromSQLite = async (subjectId, classId = null) => {
  if (!subjectId) return [];

  try {
    const db = await getDatabase();

    const existingRows = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .catch(() => []);
    const existingTables = new Set(existingRows.map((r) => r.name));

    let userMap = {};
    if (existingTables.has("users")) {
      const users = await db
        .getAllAsync(`SELECT id, name FROM users`)
        .catch(() => []);
      userMap = Object.fromEntries(users.map((u) => [String(u.id), u.name]));
    }

    const all = [];

    for (const tableName of CANDIDATE_TABLES) {
      if (!existingTables.has(tableName)) continue;

      try {
        const cols   = await db
          .getAllAsync(`PRAGMA table_info(${tableName})`)
          .catch(() => []);
        const colSet = new Set(cols.map((c) => c.name));

        const subjCol =
          colSet.has("subject_id") ? "subject_id" :
          colSet.has("subjectId")  ? "subjectId"  : null;
        if (!subjCol) continue;

        const classCol =
          colSet.has("class_id") ? "class_id" :
          colSet.has("classId")  ? "classId"  : null;

        const idCol       = colSet.has("id")           ? "id"           : "rowid";
        const titleCol    = colSet.has("title")        ? "title"        : colSet.has("name")          ? "name"          : "NULL";
        const descCol     = colSet.has("description")  ? "description"  : colSet.has("body")          ? "body"          : colSet.has("content")      ? "content"      : "NULL";
        const typeCol     = colSet.has("type")         ? "type"         : colSet.has("content_type")  ? "content_type"  : colSet.has("contentType")   ? "contentType"   : colSet.has("file_type")    ? "file_type"    : "NULL";
        const urlCol      = colSet.has("fileUrl")      ? "fileUrl"      : colSet.has("file_url")      ? "file_url"      : colSet.has("url")           ? "url"           : colSet.has("file_path")    ? "file_path"    : "NULL";
        const mimeCol     = colSet.has("mimeType")     ? "mimeType"     : colSet.has("mime_type")     ? "mime_type"     : "NULL";
        const sizeCol     = colSet.has("fileSize")     ? "fileSize"     : colSet.has("file_size")     ? "file_size"     : colSet.has("size")          ? "size"          : "NULL";
        const fileNameCol = colSet.has("fileName")     ? "fileName"     : colSet.has("file_name")     ? "file_name"     : colSet.has("original_name") ? "original_name" : "NULL";
        const createdCol  = colSet.has("createdAt")    ? "createdAt"    : colSet.has("created_at")    ? "created_at"    : colSet.has("uploaded_at")   ? "uploaded_at"   : "NULL";
        const uploaderCol = colSet.has("teacherId")    ? "teacherId"    : colSet.has("uploaded_by")   ? "uploaded_by"   : colSet.has("uploadedBy")    ? "uploadedBy"    : colSet.has("teacher_id")   ? "teacher_id"   : colSet.has("created_by")   ? "created_by"   : "NULL";
        const statusCol   = colSet.has("status")       ? "status"       : "NULL";
        const deletedCol  = colSet.has("deletedAt")    ? "deletedAt"    : colSet.has("deleted_at")    ? "deleted_at"    : null;

        const deletedFilter = deletedCol
          ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
          : "";

        let whereClause = `WHERE (${subjCol} = ? OR ${subjCol} = ?) ${deletedFilter}`;
        let queryParams = [subjectId, String(subjectId)];

        if (classId && classCol) {
          whereClause += ` AND (${classCol} = ? OR ${classCol} = ?)`;
          queryParams  = [...queryParams, classId, String(classId)];
        }

        const orderBy = createdCol !== "NULL" ? createdCol : idCol;

        const rows = await db.getAllAsync(
          `SELECT
             ${idCol}        AS id,
             '${tableName}' AS _table,
             ${subjCol}     AS subject_id,
             ${titleCol}    AS title,
             ${descCol}     AS description,
             ${typeCol}     AS content_type,
             ${urlCol}      AS url,
             ${mimeCol}     AS mime_type,
             ${sizeCol}     AS file_size,
             ${fileNameCol} AS file_name,
             ${createdCol}  AS created_at,
             ${uploaderCol} AS uploaded_by,
             ${statusCol}   AS status
           FROM ${tableName}
           ${whereClause}
           ORDER BY ${orderBy} DESC`,
          queryParams
        ).catch(() => []);

        rows.forEach((row) => {
          all.push(
            normaliseContentItem({
              _id:          row.id,
              id:           row.id,
              _table:       row._table,
              title:        row.title,
              description:  row.description,
              type:         row.content_type,
              fileUrl:      row.url,
              mimeType:     row.mime_type,
              fileSize:     row.file_size,
              fileName:     row.file_name,
              createdAt:    row.created_at,
              teacherId:    row.uploaded_by,
              uploaderName: userMap[String(row.uploaded_by)] || null,
              status:       row.status,
              subjectId,
            })
          );
        });
      } catch (tableErr) {
        console.warn(`[SQLite content] table ${tableName}:`, tableErr.message);
      }
    }

    const seen   = new Set();
    const unique = all.filter((item) => {
      const key = `${item._table}::${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => {
      const da  = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const db_ = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return db_ - da;
    });

    return unique;
  } catch (err) {
    console.warn("[loadContentFromSQLite] fatal:", err.message);
    return [];
  }
};

export const getSubjectContentForStudent = async ({
  subjectId,
  classId = null,
  type    = "all",
  search  = "",
} = {}) => {
  if (!subjectId) {
    return {
      success: false,
      source:  "none",
      items:   [],
      summary: buildSummary([]),
      error:   "subjectId is required",
    };
  }

  const params = new URLSearchParams({ subjectId });
  if (classId)                params.append("classId", classId);
  if (type && type !== "all") params.append("type",    type.toLowerCase());
  if (search?.trim())         params.append("search",  search.trim());
  const qs = `?${params.toString()}`;

  const extractItems = (data) => {
    if (!data) return null;
    const raw = (
      data.items     ||
      data.content   ||
      data.data      ||
      data.materials ||
      data.resources ||
      []
    );
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map(normaliseContentItem).filter(Boolean);
  };

  const API_ROUTES = [
    `/student/subject-content${qs}`,
    `/students/subject-content${qs}`,
  ];

  for (const route of API_ROUTES) {
    const data  = await safeFetch(route);
    const items = extractItems(data);
    if (items) {
      const summary = data?.summary
        ? { ...buildSummary([]), ...data.summary }
        : buildSummary(items);
      return { success: true, source: "api", items, summary };
    }
  }

  try {
    let items = await loadContentFromSQLite(subjectId, classId);

    if (type && type !== "all") {
      items = items.filter((i) => i.type === type.toLowerCase());
    }
    if (search?.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.title?.toLowerCase().includes(q)       ||
          i.description?.toLowerCase().includes(q) ||
          i.fileName?.toLowerCase().includes(q)
      );
    }

    return {
      success: true,
      source:  items.length > 0 ? "sqlite" : "none",
      items,
      summary: buildSummary(items),
    };
  } catch (sqlErr) {
    console.warn("[getSubjectContentForStudent] SQLite failed:", sqlErr.message);
    return {
      success: false,
      source:  "none",
      items:   [],
      summary: buildSummary([]),
      error:   sqlErr.message,
    };
  }
};

export const getSubjectAnnouncementsForStudent = async (subjectId) => {
  if (!subjectId) return [];

  const routes = [
    `/student/announcements?subjectId=${subjectId}`,
    `/students/announcements?subjectId=${subjectId}`,
  ];

  for (const route of routes) {
    const data = await safeFetch(route);
    if (data) {
      const items = data.items || data.announcements || data.data || [];
      if (Array.isArray(items) && items.length > 0) {
        console.log(`[getSubjectAnnouncementsForStudent] ${items.length} notice(s) from ${route}`);
        return items;
      }
    }
  }

  try {
    const db    = await getDatabase();
    const check = await db
      .getFirstAsync(
        `SELECT COUNT(*) AS cnt FROM sqlite_master
         WHERE type = 'table' AND name = 'announcements'`
      )
      .catch(() => null);
    if (!check?.cnt) return [];

    const cols   = await db.getAllAsync(`PRAGMA table_info(announcements)`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const subjCol =
      colSet.has("subject_id") ? "subject_id" :
      colSet.has("subjectId")  ? "subjectId"  : null;

    if (!subjCol) {
      console.info(
        "[getSubjectAnnouncementsForStudent] SQLite announcements table " +
        "has no subjectId column yet — waiting for sync."
      );
      return [];
    }

    const deletedCol    = colSet.has("deleted_at") ? "deleted_at" : null;
    const deletedFilter = deletedCol
      ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
      : "";

    const authorCol  = colSet.has("author_name") ? "a.author_name" :
                       colSet.has("authorName")  ? "a.authorName"  : "NULL";
    const createdCol = colSet.has("created_at")  ? "a.created_at"  :
                       colSet.has("createdAt")   ? "a.createdAt"   : "NULL";

    const rows = await db.getAllAsync(
      `SELECT
         a.id, a.title, a.body,
         ${createdCol} AS created_at,
         ${authorCol}  AS authorName
       FROM announcements a
       WHERE (${subjCol} = ? OR ${subjCol} = ?)
         AND (a.is_active = 1 OR a.isActive = 1 OR a.is_active IS NULL)
         ${deletedFilter}
       ORDER BY ${createdCol !== "NULL" ? createdCol : "a.id"} DESC
       LIMIT 20`,
      [subjectId, String(subjectId)]
    ).catch(() => []);

    console.log(`[getSubjectAnnouncementsForStudent] SQLite: ${rows.length} notice(s)`);
    return rows;
  } catch (err) {
    console.warn("[getSubjectAnnouncementsForStudent] SQLite error:", err.message);
    return [];
  }
};

export default {
  getSubjectContentForStudent,
  getSubjectAnnouncementsForStudent,
  loadContentFromSQLite,
  normaliseContentItem,
  resolveTypeFromItem,
};