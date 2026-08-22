// src/services/adminStats.service.js
"use strict";

import api                        from "./api";
import { getDatabase }            from "../db/database";
import { syncTeacherAssignments } from "./syncAssignments.service";
import { TeacherService }         from "./teacher.service";

// ─────────────────────────────────────────────────────────
// EMPTY STATS SHAPE
// ─────────────────────────────────────────────────────────

const EMPTY_STATS = {
  pendingApplications:      0,
  approvedStudents:         0,
  totalTeachers:            0,
  unassignedTeachers:       0,
  totalClasses:             0,
  totalSubjects:            0,
  assignedSubjects:         0,
  incompleteTimetableSlots: 0,
  activeAnnouncements:      0,
  classesWithoutSubjects:   0,
  timetableConflicts:       0,
  stalePendingApps:         0,
  totalPeriods:             0,
};

// ─────────────────────────────────────────────────────────
// SCHEMA HELPERS
// ─────────────────────────────────────────────────────────

const safeCount = async (db, query, params = []) => {
  try {
    const result = await db.getFirstAsync(query, params);
    return result?.count ?? 0;
  } catch (err) {
    console.warn(`safeCount failed:\n  ${query}\n  ${err.message}`);
    return 0;
  }
};

const tableExists = async (db, tableName) => {
  try {
    const result = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
      [tableName]
    );
    return (result?.count ?? 0) > 0;
  } catch {
    return false;
  }
};

const getColumns = async (db, tableName) => {
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(${tableName})`);
    return cols.map((c) => c.name);
  } catch {
    return [];
  }
};

const pickColumn = (columns, candidates) => {
  const names = Array.isArray(columns)
    ? columns.map((c) => (typeof c === "string" ? c : c.name))
    : [];
  for (const c of candidates) {
    if (names.includes(c)) return c;
  }
  return null;
};

const qCol = (col, alias = "") =>
  col ? (alias ? `${alias}.${col}` : col) : "";

const notDeletedClause = (deletedCol, alias = "") => {
  if (!deletedCol) return "";
  const col = qCol(deletedCol, alias);
  return ` AND (${col} IS NULL OR ${col} = '')`;
};

const activeClause = (activeCol, alias = "") => {
  if (!activeCol) return "";
  const col = qCol(activeCol, alias);
  return ` AND (${col} = 1 OR ${col} IS NULL)`;
};

const schoolFilter = (columns, schoolId, alias = "") => {
  if (!schoolId) return { clause: "", params: [] };
  const names = Array.isArray(columns)
    ? columns.map((c) => (typeof c === "string" ? c : c.name))
    : [];
  const col = pickColumn(names, ["schoolId", "school_id"]);
  if (!col) return { clause: "", params: [] };
  const fullCol = qCol(col, alias);
  return {
    clause: ` AND (${fullCol} = ? OR ${fullCol} IS NULL OR ${fullCol} = '')`,
    params: [schoolId],
  };
};

// ─────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────

const getSchoolId = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const state = useAuthStore.getState();
    return (
      state?.user?.schoolId  ??
      state?.user?.school_id ??
      state?.schoolId        ??
      null
    );
  } catch {
    return null;
  }
};

const isAuthenticated = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const state = useAuthStore.getState();
    const user  = state?.user;
    const token = state?.token;
    // ✅ Allow offline_mode — the user is still logged in, just offline.
    //    Local stats should still be computed from the SQLite cache.
    return !!(user && token);
  } catch {
    return false;
  }
};

const resolveAssignmentTable = async (db) => {
  for (const name of ["teacher_assignments", "subject_assignments"]) {
    if (!(await tableExists(db, name))) continue;
    const cols = await getColumns(db, name);
    return {
      table:      name,
      teacherCol: pickColumn(cols, ["teacherId", "teacher_id"]) || "teacherId",
      classCol:   pickColumn(cols, ["classId",   "class_id"])   || "classId",
      subjectCol: pickColumn(cols, ["subjectId", "subject_id"]) || "subjectId",
      columns:    cols,
    };
  }
  return {
    table:      null,
    teacherCol: "",
    classCol:   "",
    subjectCol: "",
    columns:    [],
  };
};

// ─────────────────────────────────────────────────────────
// SERVER FETCH  (primary path)
// ─────────────────────────────────────────────────────────

const fetchAdminStatsFromServer = async () => {
  if (!isAuthenticated()) {
    console.log("⏭️ fetchAdminStatsFromServer: not authenticated — skipping");
    return { ...EMPTY_STATS };
  }

  const schoolId = getSchoolId();

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!isAuthenticated()) {
      console.log("⏭️ fetchAdminStatsFromServer: logged out mid-retry — aborting");
      return { ...EMPTY_STATS };
    }

    try {
      if (typeof api?.get !== "function") {
        throw new Error("api.get is not a function");
      }

      console.log(
        `📊 Fetching admin stats from server` +
        (attempt > 1 ? ` (attempt ${attempt})` : "") + `…`
      );

      const response = await api.get("/admin/stats", {
        timeout: 60_000,
        params:  schoolId ? { schoolId } : undefined,
      });

      if (response?.data?.success && response?.data?.stats) {
        console.log("✅ Server stats received");
        const raw = response.data.stats;
        console.log("🔍 RAW SERVER STATS:", JSON.stringify(raw, null, 2));

        const serverStats = {
          pendingApplications:      raw.pendingApplications      ?? 0,
          approvedStudents:         raw.approvedStudents         ?? 0,
          totalTeachers:            raw.totalTeachers            ?? 0,
          unassignedTeachers:       raw.unassignedTeachers       ?? 0,
          totalClasses:             raw.totalClasses             ?? 0,
          totalSubjects:            raw.totalSubjects            ?? 0,
          assignedSubjects:
          raw.totalAssignments           ?? raw.assignedSubjects ?? 0,
          incompleteTimetableSlots: raw.incompleteTimetableSlots ?? 0,
          activeAnnouncements:      raw.activeAnnouncements      ?? 0,
          classesWithoutSubjects:   raw.classesWithoutSubjects   ?? 0,
          timetableConflicts:       raw.timetableConflicts       ?? 0,
          stalePendingApps:         raw.stalePendingApps         ?? 0,
          totalPeriods:             raw.totalPeriods             ?? 0,
        };

        // ── Consistency guard: server vs local teacher counts ──
        try {
          const localCounts = await TeacherService.getCounts();
          const serverIsBlind =
            serverStats.totalTeachers === 0 && localCounts.total > 0;

          if (serverIsBlind) {
            console.warn(
              `⚠️ Server returned 0 teachers but local has ` +
              `${localCounts.total}. Using local counts.`
            );
            serverStats.totalTeachers      = localCounts.total;
            serverStats.unassignedTeachers = localCounts.unassigned;
          } else {
            console.log(
              `✅ Teacher counts — server: ${serverStats.totalTeachers}, ` +
              `local after sync: ${localCounts.total}`
            );
          }
        } catch (guardErr) {
          console.warn("Consistency guard failed:", guardErr.message);
        }

        return serverStats;
      }

      console.warn("⚠️ Invalid server stats response — falling back to local");
      break;

    } catch (error) {
      console.warn(`⚠️ Server stats attempt ${attempt} failed:`, error.message);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }

  if (!isAuthenticated()) {
    console.log(
      "⏭️ fetchAdminStatsFromServer: logged out — skipping local fallback"
    );
    return { ...EMPTY_STATS };
  }

  console.log("📱 Falling back to local stats calculation");
  return getAdminStatsLocal();
};

// ─────────────────────────────────────────────────────────
// LOCAL CALCULATION  (offline fallback)
// ─────────────────────────────────────────────────────────

const getAdminStatsLocal = async () => {
  if (!isAuthenticated()) {
    console.log("⏭️ getAdminStatsLocal: not authenticated — skipping");
    return { ...EMPTY_STATS };
  }

  try {
    const db       = await getDatabase();
    const schoolId = getSchoolId();

    console.log(
      "📊 Local stats — schoolId:",
      schoolId ?? "⚠️  none (counts may be inflated)"
    );

    // Sync assignments so local counts are fresh
    await syncTeacherAssignments(true);

    if (!isAuthenticated()) {
      console.log(
        "⏭️ getAdminStatsLocal: logged out after sync — aborting"
      );
      return { ...EMPTY_STATS };
    }

    // ── Resolve table presence ────────────────────────────
    const assign            = await resolveAssignmentTable(db);
    const hasStudents       = await tableExists(db, "students");
    const hasStudentApps    = await tableExists(db, "student_applications");
    const hasClasses        = await tableExists(db, "classes");
    const hasSubjects       = await tableExists(db, "subjects");
    const hasTimetable      = await tableExists(db, "timetable");
    const hasTimetableSlots = await tableExists(db, "timetable_slots");
    const hasAnnouncements  = await tableExists(db, "announcements");
    const hasPeriods        = await tableExists(db, "periods");

    if (assign.table) {
      const rawCount = await safeCount(
        db,
        `SELECT COUNT(*) AS count FROM ${assign.table}
         WHERE (deleted_at IS NULL OR deleted_at = '')`
      );
      console.log(`📊 ${assign.table} live rows: ${rawCount}`);
    }

    // ── Column introspection ──────────────────────────────
    const classCols = hasClasses  ? await getColumns(db, "classes")  : [];
    const subjCols  = hasSubjects ? await getColumns(db, "subjects") : [];

    const classesDeletedCol = pickColumn(classCols, ["deleted_at",  "deletedAt"]);
    const classesActiveCol  = pickColumn(classCols, ["is_active",   "isActive"]);

    // Only use columns that actually exist in SQLite subjects table
    const subjectsClassCol   = pickColumn(subjCols, ["class_id",   "classId"]);
    const subjectsTeacherCol = pickColumn(subjCols, ["teacher_id", "teacherId"]);
    const subjDeletedCol     = pickColumn(subjCols, ["deleted_at", "deletedAt"]);

    const sfClass = schoolFilter(classCols, schoolId);
    const sfSubj  = schoolFilter(subjCols,  schoolId);

    const queries = [];

    // ── [0] Pending applications ──────────────────────────
    if (hasStudentApps) {
      const appCols    = await getColumns(db, "student_applications");
      const statusCol  = pickColumn(appCols, ["status"]);
      const deletedCol = pickColumn(appCols, ["deleted_at", "deletedAt"]);
      const sfApp      = schoolFilter(appCols, schoolId);
      if (statusCol) {
        let q   = `SELECT COUNT(*) AS count FROM student_applications WHERE ${statusCol} = 'pending'`;
        const p = [...sfApp.params];
        q += sfApp.clause + notDeletedClause(deletedCol);
        queries.push(safeCount(db, q, p));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else if (hasStudents) {
      const stuCols    = await getColumns(db, "students");
      const statusCol  = pickColumn(stuCols, ["status"]);
      const deletedCol = pickColumn(stuCols, ["deleted_at", "deletedAt"]);
      const sfStu      = schoolFilter(stuCols, schoolId);
      if (statusCol) {
        let q   = `SELECT COUNT(*) AS count FROM students WHERE ${statusCol} = 'pending'`;
        const p = [...sfStu.params];
        q += sfStu.clause + notDeletedClause(deletedCol);
        queries.push(safeCount(db, q, p));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [1] Approved students ─────────────────────────────
    if (hasStudents) {
      const stuCols     = await getColumns(db, "students");
      const statusCol   = pickColumn(stuCols, ["status"]);
      const isActiveCol = pickColumn(stuCols, ["is_active", "isActive"]);
      const deletedCol  = pickColumn(stuCols, ["deleted_at", "deletedAt"]);
      const sfStu       = schoolFilter(stuCols, schoolId);
      let q   = `SELECT COUNT(*) AS count FROM students WHERE 1=1`;
      const p = [...sfStu.params];
      q += sfStu.clause;
      if (statusCol)        q += ` AND ${statusCol} = 'approved'`;
      else if (isActiveCol) q += ` AND (${isActiveCol} = 1 OR ${isActiveCol} IS NULL)`;
      q += notDeletedClause(deletedCol);
      queries.push(safeCount(db, q, p));
    } else if (hasStudentApps) {
      const appCols    = await getColumns(db, "student_applications");
      const statusCol  = pickColumn(appCols, ["status"]);
      const deletedCol = pickColumn(appCols, ["deleted_at", "deletedAt"]);
      const sfApp      = schoolFilter(appCols, schoolId);
      if (statusCol) {
        let q   = `SELECT COUNT(*) AS count FROM student_applications WHERE ${statusCol} = 'approved'`;
        const p = [...sfApp.params];
        q += sfApp.clause + notDeletedClause(deletedCol);
        queries.push(safeCount(db, q, p));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [2] + [3] Teacher counts ──────────────────────────
    const teacherCounts = await TeacherService.getCounts().catch(() => ({
      total:      0,
      unassigned: 0,
    }));
    queries.push(Promise.resolve(teacherCounts.total));
    queries.push(Promise.resolve(teacherCounts.unassigned));

    // ── [4] Total active classes ──────────────────────────
    if (hasClasses) {
      let q   = `SELECT COUNT(*) AS count FROM classes WHERE 1=1`;
      const p = [...sfClass.params];
      q += sfClass.clause
        + notDeletedClause(classesDeletedCol)
        + activeClause(classesActiveCol);
      queries.push(safeCount(db, q, p));
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [5] Total subjects ────────────────────────────────
    if (hasSubjects) {
      let q   = `SELECT COUNT(*) AS count FROM subjects WHERE 1=1`;
      const p = [...sfSubj.params];
      q += sfSubj.clause + notDeletedClause(subjDeletedCol);
      queries.push(safeCount(db, q, p));
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [6] Assigned subjects ─────────────────────────────
if (assign.table) {
  const assignDeletedCol = pickColumn(
    assign.columns, ["deleted_at", "deletedAt"]
  );
  const sfA = schoolFilter(assign.columns, schoolId, "ta");
  const q = `
    SELECT COUNT(DISTINCT ta.${assign.subjectCol}) AS count
    FROM   ${assign.table} ta
    WHERE  ta.${assign.subjectCol} IS NOT NULL
      AND  ta.${assign.subjectCol} != ''
      AND  ta.${assign.teacherCol} IS NOT NULL
      AND  ta.${assign.teacherCol} != ''
      ${sfA.clause}
      ${notDeletedClause(assignDeletedCol, "ta")}`;

  // 🔍 DEBUG
  console.log("[assignedSubjects] Using table:", assign.table);
  console.log("[assignedSubjects] Query:", q);
  console.log("[assignedSubjects] Params:", sfA.params);

  queries.push(safeCount(db, q, sfA.params));
} else if (hasSubjects && subjectsTeacherCol) {
  console.log("[assignedSubjects] ⚠️ Falling back to subjects table");
  let q   = `
    SELECT COUNT(*) AS count FROM subjects
    WHERE  ${subjectsTeacherCol} IS NOT NULL
      AND  ${subjectsTeacherCol} != ''`;
  const p = [...sfSubj.params];
  q += sfSubj.clause + notDeletedClause(subjDeletedCol);
  queries.push(safeCount(db, q, p));
} else {
  console.log("[assignedSubjects] ⚠️ No table found — returning 0");
  queries.push(Promise.resolve(0));
}

    // ── [7] Classes without timetable ─────────────────────
    if (hasClasses) {
      const sfCA = schoolFilter(classCols, schoolId, "c");
      let q = `SELECT COUNT(DISTINCT c.id) AS count FROM classes c WHERE 1=1`;
      let p = [...sfCA.params];
      q += sfCA.clause
        + notDeletedClause(classesDeletedCol, "c")
        + activeClause(classesActiveCol, "c");

      if (hasTimetable) {
        const ttCols       = await getColumns(db, "timetable");
        const ttClassCol   =
          pickColumn(ttCols, ["class_id", "classId"]) || "class_id";
        const ttDeletedCol = pickColumn(ttCols, ["deleted_at", "deletedAt"]);
        q += `
          AND NOT EXISTS (
            SELECT 1 FROM timetable t
            WHERE  t.${ttClassCol} = c.id
            ${notDeletedClause(ttDeletedCol, "t")}
          )`;
        queries.push(safeCount(db, q, p));
      } else if (hasTimetableSlots) {
        const ttsCols       = await getColumns(db, "timetable_slots");
        const ttsClassCol   =
          pickColumn(ttsCols, ["class_id", "classId"]) || "classId";
        const ttsDeletedCol =
          pickColumn(ttsCols, ["deleted_at", "deletedAt", "deletedat"]);
        q += `
          AND NOT EXISTS (
            SELECT 1 FROM timetable_slots ts
            WHERE  ts.${ttsClassCol} = c.id
            ${notDeletedClause(ttsDeletedCol, "ts")}
          )`;
        queries.push(safeCount(db, q, p));
      } else {
        // No timetable at all — every class is "without timetable"
        let cq = `SELECT COUNT(*) AS count FROM classes WHERE 1=1`;
        const cp = [...sfClass.params];
        cq += sfClass.clause
          + notDeletedClause(classesDeletedCol)
          + activeClause(classesActiveCol);
        queries.push(safeCount(db, cq, cp));
      }
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [8] Active announcements ──────────────────────────
    if (hasAnnouncements) {
      const annCols       = await getColumns(db, "announcements");
      const annActiveCol  = pickColumn(annCols, ["is_active",  "isActive"]);
      const annDeletedCol = pickColumn(annCols, ["deleted_at", "deletedAt"]);
      const annExpiresCol = pickColumn(annCols, ["expires_at", "expiresAt"]);
      const sfAnn         = schoolFilter(annCols, schoolId);
      let q   = `SELECT COUNT(*) AS count FROM announcements WHERE 1=1`;
      const p = [...sfAnn.params];
      if (annActiveCol)  q += ` AND ${annActiveCol} = 1`;
      q += notDeletedClause(annDeletedCol);
      if (annExpiresCol) {
        q += ` AND (${annExpiresCol} IS NULL OR ${annExpiresCol} = ''
                    OR  ${annExpiresCol} > datetime('now'))`;
      }
      q += sfAnn.clause;
      queries.push(safeCount(db, q, p));
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [9] Classes without subjects ─────────────────────
    // Only use real SQLite column names — never MongoDB field names
    if (hasClasses && hasSubjects && subjectsClassCol) {
      const sfCA = schoolFilter(classCols, schoolId, "c");
      const sfSA = schoolFilter(subjCols,  schoolId, "s");
      let q = `SELECT COUNT(*) AS count FROM classes c WHERE 1=1`;
      let p = [...sfCA.params];
      q += sfCA.clause
        + notDeletedClause(classesDeletedCol, "c")
        + activeClause(classesActiveCol, "c");

      // Build class-match clause from only verified columns
      const subjClassCols = subjCols
        .filter((c) =>
          ["class_id", "classId"].includes(
            typeof c === "string" ? c : c.name
          )
        )
        .map((c) => (typeof c === "string" ? c : c.name));

      const classMatchParts = subjClassCols.map((col) => `s.${col} = c.id`);

      // Ensure the primary picked column is always represented
      if (
        classMatchParts.length === 0 ||
        !classMatchParts.some((part) => part.includes(subjectsClassCol))
      ) {
        classMatchParts.unshift(`s.${subjectsClassCol} = c.id`);
      }

      const classMatchClause = classMatchParts.join("\n                  OR ");

      q += `
        AND NOT EXISTS (
          SELECT 1 FROM subjects s
          WHERE  (${classMatchClause})
          ${sfSA.clause}
          ${notDeletedClause(subjDeletedCol, "s")}
        )`;
      p = [...p, ...sfSA.params];
      queries.push(safeCount(db, q, p));
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [10] Timetable conflicts ──────────────────────────
    if (hasTimetable) {
      const ttCols       = await getColumns(db, "timetable");
      const teacherCol   = pickColumn(ttCols, ["teacher_id",  "teacherId"]);
      const periodCol    = pickColumn(ttCols, ["period_id",   "periodId"]);
      const dayCol       = pickColumn(ttCols, ["day_of_week", "dayOfWeek", "day"]);
      const ttDeletedCol = pickColumn(ttCols, ["deleted_at",  "deletedAt"]);
      const sfTT         = schoolFilter(ttCols, schoolId);
      if (teacherCol && periodCol && dayCol) {
        const q = `
          SELECT COUNT(*) AS count FROM (
            SELECT ${teacherCol}, ${dayCol}, ${periodCol}
            FROM   timetable
            WHERE  1=1
            ${sfTT.clause}
            ${notDeletedClause(ttDeletedCol)}
            GROUP  BY ${teacherCol}, ${dayCol}, ${periodCol}
            HAVING COUNT(*) > 1
          )`;
        queries.push(safeCount(db, q, sfTT.params));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [11] Stale pending applications (> 3 days) ───────
    if (hasStudentApps) {
      const appCols    = await getColumns(db, "student_applications");
      const statusCol  = pickColumn(appCols, ["status"]);
      const createdCol = pickColumn(appCols, ["created_at", "createdAt"]);
      const deletedCol = pickColumn(appCols, ["deleted_at", "deletedAt"]);
      const sfApp      = schoolFilter(appCols, schoolId);
      if (statusCol && createdCol) {
        let q = `
          SELECT COUNT(*) AS count FROM student_applications
          WHERE  ${statusCol} = 'pending'
            AND  ${createdCol} < datetime('now', '-3 days')`;
        const p = [...sfApp.params];
        q += sfApp.clause + notDeletedClause(deletedCol);
        queries.push(safeCount(db, q, p));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else if (hasStudents) {
      const stuCols    = await getColumns(db, "students");
      const statusCol  = pickColumn(stuCols, ["status"]);
      const createdCol = pickColumn(stuCols, ["created_at", "createdAt"]);
      const deletedCol = pickColumn(stuCols, ["deleted_at", "deletedAt"]);
      const sfStu      = schoolFilter(stuCols, schoolId);
      if (statusCol && createdCol) {
        let q = `
          SELECT COUNT(*) AS count FROM students
          WHERE  ${statusCol} = 'pending'
            AND  ${createdCol} < datetime('now', '-3 days')`;
        const p = [...sfStu.params];
        q += sfStu.clause + notDeletedClause(deletedCol);
        queries.push(safeCount(db, q, p));
      } else {
        queries.push(Promise.resolve(0));
      }
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── [12] Total active periods ─────────────────────────
    if (hasPeriods) {
      const periodCols  = await getColumns(db, "periods");
      const isActiveCol = pickColumn(
        periodCols, ["isactive", "is_active", "isActive"]
      );
      const deletedCol  = pickColumn(
        periodCols, ["deletedat", "deleted_at", "deletedAt"]
      );
      const sfPeriod = schoolFilter(periodCols, schoolId);
      let q   = `SELECT COUNT(*) AS count FROM periods WHERE 1=1`;
      const p = [...sfPeriod.params];
      q += sfPeriod.clause;
      if (isActiveCol) q += ` AND ${isActiveCol} = 1`;
      q += notDeletedClause(deletedCol);
      queries.push(safeCount(db, q, p));
    } else {
      queries.push(Promise.resolve(0));
    }

    // ── Resolve all 13 queries in parallel ───────────────
    const [
      pendingApplications,
      approvedStudents,
      totalTeachers,
      unassignedTeachers,
      totalClasses,
      totalSubjects,
      assignedSubjects,
      incompleteTimetableSlots,
      activeAnnouncements,
      classesWithoutSubjects,
      timetableConflicts,
      stalePendingApps,
      totalPeriods,
    ] = await Promise.all(queries);

    const stats = {
      pendingApplications,
      approvedStudents,
      totalTeachers,
      unassignedTeachers,
      totalClasses,
      totalSubjects,
      assignedSubjects,
      incompleteTimetableSlots,
      activeAnnouncements,
      classesWithoutSubjects,
      timetableConflicts,
      stalePendingApps,
      totalPeriods,
    };

    console.log("📊 Local admin stats:", JSON.stringify(stats, null, 2));
    return stats;

  } catch (error) {
    console.error("Fatal admin stats error:", error);
    return { ...EMPTY_STATS };
  }
};

// ─────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────

/**
 * Dashboard counts, read from the local database.
 *
 * This used to return fetchAdminStatsFromServer(), which made the dashboard
 * the only screen in the app displaying server-side numbers. Every feature
 * screen counts its own rows out of SQLite, so the two disagreed constantly —
 * a student created offline showed up in the students list but not in the
 * dashboard tile, and anything the device had not pulled yet showed the
 * opposite way round.
 *
 * In an offline-first app there can only be one display source of truth, and
 * it has to be the local database: it is the only one that is always
 * available and the only one that includes changes not yet pushed. The server
 * is authoritative for *reconciliation* — sync pulls its data into SQLite —
 * but it is not what the UI counts.
 *
 * Pass { refresh: true } to pull from the server into SQLite first.
 */
export const getAdminStats = async ({ refresh = false } = {}) => {
  if (!isAuthenticated()) {
    console.log("⏭️ getAdminStats: not authenticated — skipping");
    return { ...EMPTY_STATS };
  }

  if (refresh) {
    try {
      const { SyncManager } = require("./syncManager");
      // force: an explicit refresh must not be swallowed by the rate-limit gap.
      await SyncManager.syncAll({ force: true });
    } catch (err) {
      console.log("getAdminStats: refresh failed, using local data:", err.message);
    }
  }

  return getAdminStatsLocal();
};

export { getAdminStatsLocal, fetchAdminStatsFromServer };

// ─────────────────────────────────────────────────────────
// DEBUG UTILITY
// ─────────────────────────────────────────────────────────

export const debugDatabaseSchema = async () => {
  const db       = await getDatabase();
  const schoolId = getSchoolId();

  try {
    console.log("═══════════════════════════════════════");
    console.log("🔍 DATABASE SCHEMA DEBUG");
    console.log(`   schoolId in use: ${schoolId ?? "none"}`);
    console.log("═══════════════════════════════════════");

    const tables = await db.getAllAsync(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    );
    console.log("📋 All tables:", tables.map((t) => t.name));

    const important = [
      "users",
      "classes",
      "subjects",
      "teacher_assignments",
      "subject_assignments",
      "timetable",
      "timetable_slots",
      "periods",
      "announcements",
      "students",
      "student_applications",
    ];

    for (const tableName of important) {
      const exists = tables.some((t) => t.name === tableName);
      if (!exists) {
        console.log(`\n❌ "${tableName}" does not exist`);
        continue;
      }

      const cols  = await db.getAllAsync(`PRAGMA table_info(${tableName})`);
      const count = await db.getFirstAsync(
        `SELECT COUNT(*) AS count FROM ${tableName}`
      );
      const colNames = cols.map((c) => c.name);
      const sf       = schoolFilter(colNames, schoolId);

      const filteredRow =
        schoolId && sf.clause
          ? await db.getFirstAsync(
              `SELECT COUNT(*) AS count FROM ${tableName} WHERE 1=1${sf.clause}`,
              sf.params
            )
          : null;

      console.log(`\n✅ Table: ${tableName}`);
      console.log(`   Columns  : ${colNames.join(", ")}`);
      console.log(`   All rows : ${count?.count ?? 0}`);
      if (filteredRow !== null) {
        console.log(`   My school: ${filteredRow?.count ?? 0}`);
      }

      if (
        [
          "users",
          "classes",
          "subjects",
          "teacher_assignments",
          "subject_assignments",
          "student_applications",
          "students",
        ].includes(tableName)
      ) {
        const sample = await db.getAllAsync(
          `SELECT * FROM ${tableName} LIMIT 3`
        );
        if (sample.length > 0) {
          console.log("   Sample:", JSON.stringify(sample, null, 2));
        }
      }
    }

    console.log("\n═══════════════════════════════════════");
  } catch (err) {
    console.error("debugDatabaseSchema error:", err);
  }
};