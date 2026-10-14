// mobile/src/services/teacherScope.service.js

import api from "./api";
import { getDatabase } from "../db/database";

/**
 * Which classes a teacher teaches, and which subjects in each — from the one
 * place that knows: the server's TeacherAssignment rows, through
 * GET /teacher/my-subjects?grouped=true.
 *
 * ── Why the quiz screen showed no classes ───────────────────────────────────
 *
 * The quiz screen used to read teacher_assignments ⋈ classes ⋈ subjects out of
 * the phone's own SQLite. Those three tables are a MIRROR, and a teacher's
 * mirror does not contain them: the sync feed excludes class, subject and
 * teacherAssignment for the teacher role (backend config/syncFeed.js,
 * KNOWN_GAPS), and the full assignment pull in syncManager runs for admins
 * only. So the join ran over empty tables and answered [] — while the
 * dashboard, which asks the server, said "7 classes, 19 subjects". Every other
 * teacher screen (exams, marks, content) already asks /api/teacher/* for this;
 * the quiz screen was the odd one out.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 *
 * The source of truth stays on the server. This module asks it, keeps the
 * answer in one small local table so the screen works offline, and — when the
 * mirror's classes/subjects tables lack a row the answer names — seeds the
 * name, so the joins that render a quiz's class and subject resolve. INSERT OR
 * IGNORE only: a row the mirror already has is never overwritten. The old
 * local join is kept as the last resort for a phone that has never been
 * online since this shipped.
 *
 * Authorisation is not done here. The server refuses a quiz or a question for
 * a subject the teacher is not assigned to; this decides what the pickers
 * OFFER.
 */

const CACHE_TABLE = "teacher_scope";
const MEMO_MS     = 60_000;

/** teacherId → { at, scope } — the pickers ask several times per screen. */
const memo = new Map();

const EMPTY = Object.freeze({ classes: [], subjectsByClassId: {}, source: "none", fetchedAt: null });

const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

const ensureCacheTable = (db) =>
  db.execAsync(
    `CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
       teacher_id TEXT PRIMARY KEY,
       school_id  TEXT,
       payload    TEXT NOT NULL,
       fetched_at TEXT
     )`
  ).catch(() => {});

/** The server's grouped answer, as the pickers want it. */
export const normaliseGrouped = (subjectsByClass = []) => {
  const classes = [];
  const subjectsByClassId = {};
  const seen = new Set();

  for (const g of Array.isArray(subjectsByClass) ? subjectsByClass : []) {
    const classId = g?.classId ? String(g.classId) : null;
    if (!classId || g.isActive === false) continue;

    if (!seen.has(classId)) {
      seen.add(classId);
      classes.push({
        id:      classId,
        name:    g.className ?? g.name ?? null,
        level:   g.level     ?? null,
        section: g.section   ?? null,
      });
    }

    const list = subjectsByClassId[classId] ?? (subjectsByClassId[classId] = []);
    for (const s of g.subjects ?? []) {
      const id = String(s?._id || s?.id || s?.subjectId || "");
      if (!id || list.some((x) => x.id === id)) continue;
      list.push({ id, name: s.name || s.subjectName || null, code: s.code ?? null });
    }
  }

  classes.sort(byName);
  for (const list of Object.values(subjectsByClassId)) list.sort(byName);
  return { classes, subjectsByClassId };
};

/**
 * The names the mirror lacks, filled in so joins resolve. INSERT OR IGNORE:
 * never overwrites a synced row.
 */
const seedMirrorRows = async (db, scope, schoolId) => {
  const sid = schoolId ? String(schoolId) : null;
  for (const c of scope.classes) {
    if (!c.name) continue;
    await db.runAsync(
      `INSERT OR IGNORE INTO classes (id, name, level, section, schoolId, school_id, is_active, _synced)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
      [c.id, c.name, c.level ?? null, c.section ?? null, sid, sid]
    ).catch(() => {});
    for (const s of scope.subjectsByClassId[c.id] ?? []) {
      if (!s.name) continue;
      await db.runAsync(
        `INSERT OR IGNORE INTO subjects (id, name, code, class_id, school_id, _synced)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [s.id, s.name, s.code ?? null, c.id, sid]
      ).catch(() => {});
    }
  }
};

/**
 * The last resort: the mirror's own tables, for a phone that has never been
 * online since this shipped. Column names are probed because the
 * teacher_assignments table has carried both spellings over its life.
 */
const readLocalScope = async (db, teacherId, schoolId) => {
  const cols = await db.getAllAsync("PRAGMA table_info(teacher_assignments)", []).catch(() => []);
  const has  = new Set((cols ?? []).map((c) => c.name));
  const pick = (...names) => names.find((n) => has.has(n)) ?? null;

  const tid = pick("teacherId", "teacher_id");
  const cid = pick("classId",   "class_id");
  const sub = pick("subjectId", "subject_id");
  const sch = pick("schoolId",  "school_id");
  if (!tid || !cid || !sub) return { classes: [], subjectsByClassId: {} };

  const delFilter = has.has("deleted_at") ? `AND (ta.deleted_at IS NULL OR ta.deleted_at = '')` : "";
  const sidFilter = sch && schoolId ? `AND ta."${sch}" = ?` : "";
  const params    = sch && schoolId ? [String(teacherId), String(schoolId)] : [String(teacherId)];

  const rows = await db.getAllAsync(
    `SELECT DISTINCT c.id AS class_id, c.name AS class_name, c.level, c.section,
            s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
     FROM   teacher_assignments ta
     JOIN   classes  c ON c.id = ta."${cid}"
     JOIN   subjects s ON s.id = ta."${sub}"
     WHERE  ta."${tid}" = ? ${sidFilter} ${delFilter}
       AND  c.deleted_at IS NULL AND (c.is_active IS NULL OR c.is_active = 1)
       AND  s.deleted_at IS NULL`,
    params
  ).catch(() => []);

  const groups = new Map();
  for (const r of rows ?? []) {
    const g = groups.get(r.class_id) ?? groups.set(r.class_id, {
      classId: r.class_id, className: r.class_name, level: r.level, section: r.section, subjects: [],
    }).get(r.class_id);
    g.subjects.push({ _id: r.subject_id, name: r.subject_name, code: r.subject_code });
  }
  return normaliseGrouped([...groups.values()]);
};

/**
 * @param {{teacherId:string, schoolId?:string, force?:boolean}} args
 * @returns {Promise<{classes:Array, subjectsByClassId:Object, source:string, fetchedAt:string|null}>}
 */
export const fetchTeacherScope = async ({ teacherId, schoolId = null, force = false } = {}) => {
  if (!teacherId) return EMPTY;
  const key = String(teacherId);

  const hit = memo.get(key);
  if (!force && hit && Date.now() - hit.at < MEMO_MS) return hit.scope;

  const db = await getDatabase();
  await ensureCacheTable(db);

  let scope = null;
  try {
    const { data } = await api.get("/teacher/my-subjects", {
      params:  { grouped: "true", ...(schoolId ? { schoolId: String(schoolId) } : {}) },
      timeout: 8_000,
    });
    const fetchedAt = new Date().toISOString();
    scope = { ...normaliseGrouped(data?.subjectsByClass ?? []), source: "api", fetchedAt };
    await db.runAsync(
      `INSERT OR REPLACE INTO ${CACHE_TABLE} (teacher_id, school_id, payload, fetched_at)
       VALUES (?, ?, ?, ?)`,
      [key, schoolId ? String(schoolId) : null,
       JSON.stringify({ classes: scope.classes, subjectsByClassId: scope.subjectsByClassId }),
       fetchedAt]
    ).catch(() => {});
    await seedMirrorRows(db, scope, schoolId);
  } catch (err) {
    const row = await db.getFirstAsync(
      `SELECT payload, fetched_at FROM ${CACHE_TABLE} WHERE teacher_id = ?`, [key]
    ).catch(() => null);
    if (row?.payload) {
      try {
        const parsed = JSON.parse(row.payload);
        scope = {
          classes:           Array.isArray(parsed.classes) ? parsed.classes : [],
          subjectsByClassId: parsed.subjectsByClassId ?? {},
          source:            "cache",
          fetchedAt:         row.fetched_at ?? null,
        };
      } catch { /* a corrupt cache is no cache */ }
    }
    if (!scope) {
      scope = { ...(await readLocalScope(db, key, schoolId)), source: "local", fetchedAt: null };
    }
    if (scope.source !== "api") {
      console.log(`[teacherScope] offline (${err?.message ?? "no network"}) — using ${scope.source}`);
    }
  }

  memo.set(key, { at: Date.now(), scope });
  return scope;
};

export const getTeacherClasses = async (teacherId, schoolId = null) =>
  (await fetchTeacherScope({ teacherId, schoolId })).classes;

export const getTeacherSubjectsForClass = async (teacherId, classId, schoolId = null) => {
  if (!teacherId || !classId) return [];
  const scope = await fetchTeacherScope({ teacherId, schoolId });
  return scope.subjectsByClassId[String(classId)] ?? [];
};

/** Every subject the teacher teaches anywhere, once each, by name. */
export const allTeacherSubjects = (scope) => {
  const seen = new Map();
  for (const list of Object.values(scope?.subjectsByClassId ?? {})) {
    for (const s of list) if (!seen.has(s.id)) seen.set(s.id, s);
  }
  return [...seen.values()].sort(byName);
};

export const clearTeacherScopeMemo = () => { memo.clear(); };

export default {
  fetchTeacherScope, getTeacherClasses, getTeacherSubjectsForClass,
  allTeacherSubjects, normaliseGrouped, clearTeacherScopeMemo,
};
