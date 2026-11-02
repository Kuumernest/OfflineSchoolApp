// mobile/src/services/pickerData.service.js
"use strict";

/**
 * What the admin pickers offer — classes, teachers, the subjects of a class —
 * read so that they work offline.
 *
 * The exam wizard and the attendance register used to ask the server only
 * (api.get("/admin/classes") and friends), so with no network the picker was
 * empty or showed "could not load classes" — and the offline paths behind
 * them (ExamService.createExam's queue, AttendanceService's marks) could never
 * be reached. These read the server when it answers and the phone's SQLite
 * mirror when it does not; the mirror is filled by the sync and by
 * ClassService's own refresh.
 *
 * Read-only. Nothing here writes a row the sync owns.
 */

import api from "./api";
import { getDatabase } from "../db/database";
import { getCurrentAuth } from "../utils/authHelpers";
import { tableExists, getTableColumns } from "../db/dbHelpers";
import { ClassService } from "./class.service";

const SERVER_TIMEOUT_MS = 15_000;

const notDeleted = (cols, alias) =>
  cols.includes("deleted_at")
    ? `AND (${alias}.deleted_at IS NULL OR ${alias}.deleted_at = '' OR ${alias}.deleted_at NOT LIKE '20%')`
    : "";

const pickCol = (cols, ...names) => names.find((n) => cols.includes(n)) ?? null;

/**
 * The row's school, whichever spelling holds it (the mirror has carried both).
 * NULL when neither does — such a row is the signed-in school's, since the
 * mirror only holds that one school.
 */
const schoolExpr = (cols, alias) => {
  const present = ["school_id", "schoolId"].filter((c) => cols.includes(c));
  if (!present.length) return null;
  return `COALESCE(${present.map((c) => `NULLIF(${alias}.${c}, '')`).join(", ")}, NULL)`;
};

const listFrom = (data, key) =>
  Array.isArray(data) ? data : (data?.[key] || data?.data || []);

/** Active classes of this school, by name. ClassService is local-first already. */
export const getPickerClasses = async () => {
  const rows = await ClassService.getAll(false);
  return (rows ?? []).filter((c) => c.isActive !== false);
};

/** Teachers of this school from the phone's users mirror. */
export const getLocalPickerTeachers = async () => {
  const db = await getDatabase();
  const { schoolId } = getCurrentAuth();
  if (!(await tableExists(db, "users"))) return [];

  const cols   = await getTableColumns(db, "users");
  const params = [];
  let where = `WHERE LOWER(u.role) = 'teacher' ${notDeleted(cols, "u")}`;
  if (cols.includes("is_active")) where += " AND (u.is_active = 1 OR u.is_active IS NULL)";
  const sch = schoolExpr(cols, "u");
  if (schoolId && sch) {
    where += ` AND (${sch} IS NULL OR ${sch} = ?)`;
    params.push(String(schoolId));
  }

  const rows = await db.getAllAsync(
    `SELECT u.id, u.name, u.email FROM users u ${where} ORDER BY LOWER(u.name) ASC, u.id ASC`,
    params
  ).catch(() => []);
  return (rows ?? []).map((r) => ({ ...r, _id: String(r.id), id: String(r.id) }));
};

/** Server first (it is the fresher list); the phone's copy when it cannot answer. */
export const getPickerTeachers = async () => {
  const { schoolId } = getCurrentAuth();
  try {
    const res = await api.get("/admin/teachers", { params: { schoolId }, timeout: SERVER_TIMEOUT_MS });
    return listFrom(res.data, "teachers");
  } catch (err) {
    console.warn("[pickerData] teachers from the phone:", err?.message);
    return getLocalPickerTeachers();
  }
};

/**
 * The subjects of one class from the phone's subjects mirror — with the
 * coefficient the sync keeps, so an exam drafted offline starts each subject
 * at its own coefficient, as it does online.
 */
export const getLocalPickerSubjects = async (classId) => {
  if (!classId) return [];
  const db = await getDatabase();
  const { schoolId } = getCurrentAuth();
  if (!(await tableExists(db, "subjects"))) return [];

  const cols   = await getTableColumns(db, "subjects");
  const cls    = [pickCol(cols, "class_id"), pickCol(cols, "classId")].filter(Boolean);
  if (!cls.length) return [];

  const params = [];
  let where = `WHERE (${cls.map((c) => `s.${c} = ?`).join(" OR ")}) ${notDeleted(cols, "s")}`;
  cls.forEach(() => params.push(String(classId)));
  if (cols.includes("is_active")) where += " AND (s.is_active = 1 OR s.is_active IS NULL)";
  const sch = schoolExpr(cols, "s");
  if (schoolId && sch) {
    where += ` AND (${sch} IS NULL OR ${sch} = ?)`;
    params.push(String(schoolId));
  }

  const coeff = cols.includes("coefficient") ? "s.coefficient" : "NULL";
  const code  = cols.includes("code") ? "s.code" : "NULL";
  const rows = await db.getAllAsync(
    `SELECT s.id, s.name, ${code} AS code, ${coeff} AS coefficient
     FROM subjects s ${where}
     ORDER BY LOWER(s.name) ASC, s.id ASC`,
    params
  ).catch(() => []);
  return (rows ?? []).map((r) => ({
    ...r,
    _id: String(r.id),
    id: String(r.id),
    classId: String(classId),
    class_id: String(classId),
  }));
};

/** Server first; the phone's copy when it cannot answer. */
export const getPickerSubjects = async (classId) => {
  if (!classId) return [];
  const { schoolId } = getCurrentAuth();
  try {
    const res = await api.get("/admin/subjects", {
      params: { schoolId, classId }, timeout: SERVER_TIMEOUT_MS,
    });
    let subs = listFrom(res.data, "subjects");
    // The route has answered for the whole school before; keep this class's.
    const own = subs.filter(
      (s) => String(s.class_id || s.classId || s.class?._id || s.class || "") === String(classId)
    );
    if (own.length > 0) subs = own;
    return subs;
  } catch (err) {
    console.warn("[pickerData] subjects from the phone:", err?.message);
    return getLocalPickerSubjects(classId);
  }
};

export const PickerData = {
  getPickerClasses,
  getPickerTeachers,
  getLocalPickerTeachers,
  getPickerSubjects,
  getLocalPickerSubjects,
};

export default PickerData;
