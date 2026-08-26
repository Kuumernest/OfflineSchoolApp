"use strict";

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  SectionList,
} from "react-native";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api              from "../../../src/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

const CLASS_COLORS = [
  { bg: "#EEF2FF", color: "#4F46E5", icon: "school-outline"  },
  { bg: "#ECFDF5", color: "#059669", icon: "book-outline"    },
  { bg: "#FEF3C7", color: "#D97706", icon: "library-outline" },
  { bg: "#FEF2F2", color: "#DC2626", icon: "reader-outline"  },
  { bg: "#F0F9FF", color: "#0284C7", icon: "school-outline"  },
  { bg: "#FDF4FF", color: "#A855F7", icon: "book-outline"    },
  { bg: "#FFF7ED", color: "#EA580C", icon: "library-outline" },
  { bg: "#F0FDF4", color: "#16A34A", icon: "reader-outline"  },
];

// ─────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Run a SELECT and return rows array.
 * Never throws — returns [] on any error.
 */
const dbQuery = async (sql, params = []) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(sql, params);
    return rows ?? [];
  } catch (err) {
    console.warn("[dbQuery] failed:", err.message, "\nSQL:", sql.slice(0, 120));
    return [];
  }
};

/**
 * Return Set of column names for a table.
 * Returns empty Set if table doesn't exist.
 */
const getColumns = async (table) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(`PRAGMA table_info(${table})`, []);
    return new Set((rows ?? []).map((r) => r.name));
  } catch {
    return new Set();
  }
};

/**
 * Return Set of all table names in the database.
 */
const getTables = async () => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      []
    );
    return new Set((rows ?? []).map((r) => r.name));
  } catch {
    return new Set();
  }
};

/**
 * Pick the first matching column name from a set of candidates.
 * Returns null if none found.
 */
const pickCol = (cols, ...candidates) => {
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
};

// ─────────────────────────────────────────────────────────
// NORMALIZE API ASSIGNMENTS → { classId, subjectId }
// ─────────────────────────────────────────────────────────

const toStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v._id || v.id || "").trim();
  return String(v).trim();
};

/**
 * Try several API endpoints to get teacher assignments.
 * Returns array of { classId, subjectId } or null if all fail.
 */
const fetchAssignmentsFromAPI = async (teacherId, schoolId) => {
  const endpoints = [
    `/teacher/my-assignments`,
    `/teacher/assignments`,
    `/assignments/teacher/${teacherId}`,
    `/teacher/subjects`,
  ];

  for (const ep of endpoints) {
    try {
      const res  = await api.get(ep, { params: { schoolId } });
      const data = res.data;

      const list =
        Array.isArray(data?.assignments) ? data.assignments :
        Array.isArray(data?.subjects)    ? data.subjects    :
        Array.isArray(data?.data)        ? data.data        :
        Array.isArray(data)              ? data             : null;

      if (list && list.length > 0) {
        console.log(`[SubjectsAPI] ✅ ${ep} → ${list.length} rows`);
        return list.map((item) => ({
          classId:     toStr(item.classId   || item.class_id   || item.class),
          subjectId:   toStr(item.subjectId || item.subject_id || item.subject),
          className:   item.className   || item.class_name  || "",
          subjectName: item.subjectName || item.subject_name || item.name || "",
          subjectCode: item.subjectCode || item.code        || "",
        })).filter((a) => a.classId && a.subjectId);
      }
    } catch (err) {
      const status = err.response?.status;
      console.log(`[SubjectsAPI] ${ep} → ${status ?? "ERR"}`);
    }
  }

  return null;
};

// ─────────────────────────────────────────────────────────
// LOAD ASSIGNMENTS FROM SQLITE
// ─────────────────────────────────────────────────────────

const loadAssignmentsFromSQLite = async (teacherId, schoolId, tables) => {

  // ── Strategy A: teacher_assignments ─────────────────────
  if (tables.has("teacher_assignments")) {
    const cols  = await getColumns("teacher_assignments");
    const tidC  = pickCol(cols, "teacherId",  "teacher_id");
    const sidC  = pickCol(cols, "schoolId",   "school_id");
    const clsC  = pickCol(cols, "classId",    "class_id");
    const subC  = pickCol(cols, "subjectId",  "subject_id");
    const delC  = cols.has("deleted_at");

    if (tidC && clsC && subC) {
      const delFilter = delC
        ? "AND (deleted_at IS NULL OR deleted_at = '')"
        : "";
      const sidFilter = sidC ? `AND ${sidC} = ?` : "";
      const params    = sidC ? [teacherId, schoolId] : [teacherId];

      const rows = await dbQuery(
        `SELECT ${clsC} AS classId, ${subC} AS subjectId
         FROM teacher_assignments
         WHERE ${tidC} = ?
           ${sidFilter}
           AND (${subC} IS NOT NULL AND ${subC} != '')
           ${delFilter}
         GROUP BY ${clsC}, ${subC}`,
        params
      );

      console.log(`[SQLite] teacher_assignments → ${rows.length} rows`);

      if (__DEV__ && rows.length === 0) {
        const sample = await dbQuery(
          `SELECT * FROM teacher_assignments LIMIT 3`, []
        );
        console.log("[SQLite] sample rows:", JSON.stringify(sample, null, 2));
      }

      if (rows.length > 0) return rows;
    }
  }

  // ── Strategy B: subject_assignments ─────────────────────
  if (tables.has("subject_assignments")) {
    const cols = await getColumns("subject_assignments");
    const tidC = pickCol(cols, "teacherId",  "teacher_id");
    const sidC = pickCol(cols, "schoolId",   "school_id");
    const clsC = pickCol(cols, "classId",    "class_id");
    const subC = pickCol(cols, "subjectId",  "subject_id");
    const delC = cols.has("deleted_at");

    if (tidC && clsC && subC) {
      const delFilter = delC ? "AND (deleted_at IS NULL OR deleted_at = '')" : "";
      const sidFilter = sidC ? `AND ${sidC} = ?` : "";
      const params    = sidC ? [teacherId, schoolId] : [teacherId];

      const rows = await dbQuery(
        `SELECT ${clsC} AS classId, ${subC} AS subjectId
         FROM subject_assignments
         WHERE ${tidC} = ?
           ${sidFilter}
           AND (${subC} IS NOT NULL AND ${subC} != '')
           ${delFilter}
         GROUP BY ${clsC}, ${subC}`,
        params
      );
      console.log(`[SQLite] subject_assignments → ${rows.length} rows`);
      if (rows.length > 0) return rows;
    }
  }

  // ── Strategy C: teacher_subjects ────────────────────────
  if (tables.has("teacher_subjects")) {
    const cols = await getColumns("teacher_subjects");
    const tidC = pickCol(cols, "teacherId",  "teacher_id");
    const sidC = pickCol(cols, "schoolId",   "school_id");
    const clsC = pickCol(cols, "classId",    "class_id");
    const subC = pickCol(cols, "subjectId",  "subject_id");
    const delC = cols.has("deleted_at");

    if (tidC && clsC && subC) {
      const delFilter = delC ? "AND (deleted_at IS NULL OR deleted_at = '')" : "";
      const sidFilter = sidC ? `AND ${sidC} = ?` : "";
      const params    = sidC ? [teacherId, schoolId] : [teacherId];

      const rows = await dbQuery(
        `SELECT ${clsC} AS classId, ${subC} AS subjectId
         FROM teacher_subjects
         WHERE ${tidC} = ?
           ${sidFilter}
           ${delFilter}
         GROUP BY ${clsC}, ${subC}`,
        params
      );
      console.log(`[SQLite] teacher_subjects → ${rows.length} rows`);
      if (rows.length > 0) return rows;
    }
  }

  // ── Strategy D: subjects.teacherId ──────────────────────
  if (tables.has("subjects")) {
    const cols = await getColumns("subjects");
    const tidC = pickCol(cols, "teacherId",  "teacher_id");
    const sidC = pickCol(cols, "schoolId",   "school_id");
    const clsC = pickCol(cols, "classId",    "class_id");
    const delC = cols.has("deleted_at");

    if (tidC && clsC) {
      const delFilter = delC ? "AND (deleted_at IS NULL OR deleted_at = '')" : "";
      const sidFilter = sidC ? `AND ${sidC} = ?` : "";
      const params    = sidC ? [teacherId, schoolId] : [teacherId];

      const rows = await dbQuery(
        `SELECT ${clsC} AS classId, id AS subjectId
         FROM subjects
         WHERE ${tidC} = ?
           ${sidFilter}
           ${delFilter}`,
        params
      );
      console.log(`[SQLite] subjects.teacherId → ${rows.length} rows`);
      if (rows.length > 0) return rows;
    }
  }

  return [];
};

// ─────────────────────────────────────────────────────────
// LOOKUP HELPERS
// ─────────────────────────────────────────────────────────

const loadClassNames = async (schoolId, tables) => {
  const map = {};
  if (!tables.has("classes")) return map;

  const cols = await getColumns("classes");
  const sidC = pickCol(cols, "schoolId", "school_id");
  const delC = cols.has("deleted_at");

  const sidFilter = sidC ? `WHERE ${sidC} = ?` : "";
  const delFilter = delC
    ? `${sidFilter ? "AND" : "WHERE"} (deleted_at IS NULL OR deleted_at = '')`
    : "";
  const params = sidC ? [schoolId] : [];

  const rows = await dbQuery(
    `SELECT id, name FROM classes ${sidFilter} ${delFilter}`,
    params
  );
  for (const r of rows) map[String(r.id)] = r.name;
  return map;
};

const loadSubjectNames = async (schoolId, tables) => {
  const map = {};
  if (!tables.has("subjects")) return map;

  const cols = await getColumns("subjects");
  const sidC = pickCol(cols, "schoolId", "school_id");
  const delC = cols.has("deleted_at");

  const sidFilter = sidC ? `WHERE ${sidC} = ?` : "";
  const delFilter = delC
    ? `${sidFilter ? "AND" : "WHERE"} (deleted_at IS NULL OR deleted_at = '')`
    : "";
  const params = sidC ? [schoolId] : [];

  const rows = await dbQuery(
    `SELECT id, name, code FROM subjects ${sidFilter} ${delFilter}`,
    params
  );
  for (const r of rows) map[String(r.id)] = { name: r.name, code: r.code };
  return map;
};

const loadStudentCounts = async (schoolId, tables) => {
  const map = {};
  if (!tables.has("students")) return map;

  const cols = await getColumns("students");
  const clsC = pickCol(cols, "classId", "class_id", "class");
  const sidC = pickCol(cols, "schoolId", "school_id");
  const delC = cols.has("deleted_at");

  if (!clsC) {
    console.warn("[loadStudentCounts] no class column found in students table");
    return map;
  }

  const sidFilter = sidC ? `AND ${sidC} = ?` : "";
  const delFilter = delC ? "AND (deleted_at IS NULL OR deleted_at = '')" : "";
  const params    = sidC ? [schoolId] : [];

  const rows = await dbQuery(
    `SELECT ${clsC} AS classId, COUNT(*) AS cnt
     FROM students
     WHERE 1=1 ${sidFilter} ${delFilter}
     GROUP BY ${clsC}`,
    params
  );

  for (const r of rows) {
    if (r.classId) map[String(r.classId)] = Number(r.cnt) || 0;
  }

  console.log(`[loadStudentCounts] classId col="${clsC}", ${rows.length} classes`);
  return map;
};

// ─────────────────────────────────────────────────────────
// BUILD SECTIONS
// ─────────────────────────────────────────────────────────

const buildSections = ({
  assignments,
  classNameMap,
  subjectNameMap,
  studentCountMap,
  apiHints = [],
}) => {
  // Build quick lookup from API hints
  const apiClassNames   = {};
  const apiSubjectNames = {};
  const apiSubjectCodes = {};
  for (const h of apiHints) {
    if (h.classId   && h.className)   apiClassNames[h.classId]     = h.className;
    if (h.subjectId && h.subjectName) apiSubjectNames[h.subjectId] = h.subjectName;
    if (h.subjectId && h.subjectCode) apiSubjectCodes[h.subjectId] = h.subjectCode;
  }

  const classMap   = {};
  const globalSeen = new Set();

  for (const a of assignments) {
    const cid   = String(a.classId   || "").trim();
    const subId = String(a.subjectId || "").trim();
    if (!cid || !subId) continue;

    const key = `${cid}::${subId}`;
    if (globalSeen.has(key)) continue;
    globalSeen.add(key);

    const subMeta = subjectNameMap[subId] || {};

    const className =
      classNameMap[cid]  ||
      apiClassNames[cid] ||
      `Class ${cid.slice(-6)}`;

    const subjectName =
      subMeta.name           ||
      apiSubjectNames[subId] ||
      `Subject ${subId.slice(-6)}`;

    const subjectCode =
      subMeta.code           ||
      apiSubjectCodes[subId] ||
      "";

    if (!classMap[cid]) {
      classMap[cid] = {
        classId:      cid,
        className,
        studentCount: studentCountMap[cid] || 0,
        subjects:     [],
      };
    }

    classMap[cid].subjects.push({ subjectId: subId, subjectName, subjectCode });
  }

  return Object.values(classMap)
    .sort((a, b) => a.className.localeCompare(b.className))
    .map((cls) => ({
      title:        cls.className,
      classId:      cls.classId,
      studentCount: cls.studentCount,
      data: cls.subjects.sort((a, b) =>
        a.subjectName.localeCompare(b.subjectName)
      ),
    }));
};

// ─────────────────────────────────────────────────────────
// PERSIST API ASSIGNMENTS → SQLITE
// ─────────────────────────────────────────────────────────

const persistAssignmentsToSQLite = async (
  assignments, teacherId, schoolId, tables
) => {
  if (!tables.has("teacher_assignments")) return;

  try {
    const cols  = await getColumns("teacher_assignments");
    const tidC  = pickCol(cols, "teacherId",  "teacher_id");
    const sidC  = pickCol(cols, "schoolId",   "school_id");
    const clsC  = pickCol(cols, "classId",    "class_id");
    const subC  = pickCol(cols, "subjectId",  "subject_id");
    const syncC = cols.has("_synced");

    if (!tidC || !clsC || !subC) return;

    const db = await getDatabase();

    for (const a of assignments) {
      const id       = `api_${a.classId}_${a.subjectId}`;
      const sidPart  = sidC  ? `, ${sidC}`  : "";
      const syncPart = syncC ? `, _synced`  : "";
      const sidVal   = sidC  ? `, ?`        : "";
      const syncVal  = syncC ? `, 1`        : "";
      const params   = sidC
        ? [id, teacherId, a.classId, a.subjectId, schoolId]
        : [id, teacherId, a.classId, a.subjectId];

      await db.runAsync(
        `INSERT OR IGNORE INTO teacher_assignments
         (id, ${tidC}, ${clsC}, ${subC}${sidPart}${syncPart})
         VALUES (?, ?, ?, ?${sidVal}${syncVal})`,
        params
      ).catch((e) => {
        console.warn("[persistAssignments] insert failed:", e.message);
      });
    }

    console.log(`[persistAssignments] wrote ${assignments.length} rows`);
  } catch (err) {
    console.warn("[persistAssignments] failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────
// SUMMARY CARD
// ─────────────────────────────────────────────────────────

function SummaryCard({ icon, count, label, color, bg }) {
  return (
    <View style={[sc2.card, { borderColor: color + "25" }]}>
      <View style={[sc2.iconBg, { backgroundColor: bg }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={[sc2.count, { color }]}>{count}</Text>
      <Text style={sc2.label}>{label}</Text>
    </View>
  );
}

const sc2 = StyleSheet.create({
  card: {
    flex: 1, alignItems: "center",
    backgroundColor: C.white, borderRadius: 14,
    paddingVertical: 14, borderWidth: 1, gap: 4,
  },
  iconBg: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: "center", justifyContent: "center", marginBottom: 2,
  },
  count: { fontSize: 22, fontWeight: "800" },
  label: { fontSize: 10, fontWeight: "600", color: C.gray500 },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TeacherSubjectsScreen() {
  const { t } = useTranslation();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = toStr(user?.schoolId);
  const teacherId = toStr(user?._id || user?.id);

  const [sections,   setSections]   = useState([]);
  const [stats,      setStats]      = useState({ classes: 0, subjects: 0, students: 0 });
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [source,     setSource]     = useState("");
  const [debugInfo,  setDebugInfo]  = useState(null);

  const loadData = useCallback(async (isRefresh = false) => {
    if (!teacherId) {
      console.warn("[TeacherSubjects] no teacherId");
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const tables = await getTables();
      console.log("[TeacherSubjects] tables:", [...tables].join(", "));

      // ── 1. Try SQLite first ──────────────────────────────
      let rawAssignments = await loadAssignmentsFromSQLite(
        teacherId, schoolId, tables
      );

      let apiHints    = [];
      let dataSource  = "sqlite";

      // ── 2. Fall back to API if SQLite empty ─────────────
      if (rawAssignments.length === 0) {
        console.log("[TeacherSubjects] SQLite empty → trying API…");
        const apiData = await fetchAssignmentsFromAPI(teacherId, schoolId);

        if (apiData && apiData.length > 0) {
          rawAssignments = apiData;
          apiHints       = apiData;
          dataSource     = "api";
          console.log(`[TeacherSubjects] API gave ${rawAssignments.length} assignments`);

          await persistAssignmentsToSQLite(
            rawAssignments, teacherId, schoolId, tables
          );
        }
      }

      if (rawAssignments.length === 0) {
        console.warn("[TeacherSubjects] no assignments from SQLite or API");
        setDebugInfo({ tables: [...tables], teacherId, schoolId });
        setSections([]);
        setStats({ classes: 0, subjects: 0, students: 0 });
        setSource("");
        return;
      }

      // ── 3. Load lookup maps ──────────────────────────────
      const [classNameMap, subjectNameMap, studentCountMap] = await Promise.all([
        loadClassNames(schoolId, tables),
        loadSubjectNames(schoolId, tables),
        loadStudentCounts(schoolId, tables),
      ]);

      // ── 4. Build sections ────────────────────────────────
      const sectionList = buildSections({
        assignments:    rawAssignments,
        classNameMap,
        subjectNameMap,
        studentCountMap,
        apiHints,
      });

      console.log(
        "[TeacherSubjects] ✅ sections:",
        sectionList.map((s) => `${s.title}(${s.data.length})`).join(", ")
      );

      setSections(sectionList);
      setSource(dataSource);

      const totalSubjects = sectionList.reduce((s, sec) => s + sec.data.length, 0);
      const totalStudents = sectionList.reduce((s, sec) => s + (sec.studentCount || 0), 0);
      setStats({
        classes:  sectionList.length,
        subjects: totalSubjects,
        students: totalStudents,
      });

    } catch (err) {
      console.error("[TeacherSubjects] load error:", err);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, schoolId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Loading ──────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={s.loadingText}>{t("teacherSubjects.loading")}</Text>
      </View>
    );
  }

  // ── Main render ──────────────────────────────────────────
  return (
    <View style={s.screen}>

      {/* ── HEADER ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>{t("teacherSubjects.title")}</Text>
          <Text style={s.headerSub}>
            {user?.name || t("teacherSubjects.teacher")}
            {user?.staffId ? ` · ${user.staffId}` : ""}
            {source === "api" ? "  ·  synced from server" : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => loadData(true)}
          style={s.refreshBtn}
          disabled={refreshing}
        >
          <Ionicons
            name={refreshing ? "hourglass-outline" : "refresh"}
            size={22}
            color={C.primary}
          />
        </TouchableOpacity>
      </View>

      {/* ── SUMMARY CARDS ── */}
      <View style={s.summaryRow}>
        <SummaryCard
          icon="school-outline"
          count={stats.classes}
          label={t("teacherSubjects.classes")}
          color={C.primary}
          bg={C.primaryBg}
        />
        <SummaryCard
          icon="book-outline"
          count={stats.subjects}
          label={t("teacherSubjects.subjects")}
          color={C.success}
          bg={C.successBg}
        />
        <SummaryCard
          icon="people-outline"
          count={stats.students}
          label={t("teacherSubjects.students")}
          color={C.warning}
          bg={C.warningBg}
        />
      </View>

      {/* ── ERROR ── */}
      {!!error && (
        <View style={s.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={C.error} />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadData()}>
            <Text style={s.retryText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── DEV DEBUG — only shows when empty ── */}
      {__DEV__ && debugInfo && sections.length === 0 && (
        <View style={s.debugBanner}>
          <Text style={s.debugText}>
            🔍 teacherId: {debugInfo.teacherId}{"\n"}
            🏫 schoolId:  {debugInfo.schoolId}{"\n"}
            📋 tables: {debugInfo.tables.join(", ")}
          </Text>
        </View>
      )}

      {/* ── EMPTY STATE ── */}
      {sections.length === 0 ? (
        <View style={s.empty}>
          <View style={s.emptyIconBg}>
            <Ionicons name="school-outline" size={48} color={C.gray300} />
          </View>
          <Text style={s.emptyTitle}>{t("teacherSubjects.emptyTitle")}</Text>
          <Text style={s.emptyText}>
            You haven't been assigned to any classes or subjects yet.
            {t("teacherSubjects.emptyHint")}
          </Text>
          <TouchableOpacity
            style={s.emptyRetryBtn}
            onPress={() => loadData(true)}
          >
            <Ionicons name="refresh" size={16} color={C.white} />
            <Text style={s.emptyRetryText}>{t("common.refresh")}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, idx) => `${item.subjectId}-${idx}`}
          contentContainerStyle={s.list}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadData(true)}
              tintColor={C.primary}
              colors={[C.primary]}
            />
          }

          // ── SECTION HEADER ── (class card)
          renderSectionHeader={({ section }) => {
            const idx = sections.findIndex(
              (sec) => sec.classId === section.classId
            ) % CLASS_COLORS.length;
            const cls = CLASS_COLORS[Math.max(0, idx)];

            return (
              <View style={s.sectionHeader}>
                <View style={[s.sectionIconBg, { backgroundColor: cls.bg }]}>
                  <Ionicons name={cls.icon} size={18} color={cls.color} />
                </View>
                <View style={s.sectionHeaderText}>
                  <Text style={s.sectionTitle}>{section.title}</Text>
                  <Text style={s.sectionMeta}>
                    {section.data.length} subject{section.data.length !== 1 ? "s" : ""}
                    {section.studentCount > 0
                      ? `  ·  ${section.studentCount} student${section.studentCount !== 1 ? "s" : ""}`
                      : ""}
                  </Text>
                </View>
                {/* Student count badge */}
                <View style={[s.sectionBadge, { backgroundColor: cls.bg }]}>
                  <Text style={[s.sectionBadgeText, { color: cls.color }]}>
                    {section.data.length}
                  </Text>
                </View>
              </View>
            );
          }}

          // ── SUBJECT ROW ──
          renderItem={({ item, index, section }) => {
            const isLast     = index === section.data.length - 1;
            const colorIdx   = sections.findIndex(
              (sec) => sec.classId === section.classId
            ) % CLASS_COLORS.length;
            const cls        = CLASS_COLORS[Math.max(0, colorIdx)];
            const accentColor = cls.color;

            return (
              <View style={[s.subjectCard, isLast && s.subjectCardLast]}>
                {/* Colour accent bar */}
                <View style={[s.subjectAccent, { backgroundColor: accentColor }]} />

                <View style={s.subjectContent}>
                  {/* Subject name & meta */}
                  <View style={s.subjectHeader}>
                    <View style={[s.subjectIconBg, { backgroundColor: cls.bg }]}>
                      <Ionicons name="book-outline" size={16} color={accentColor} />
                    </View>
                    <View style={s.subjectInfo}>
                      <Text style={s.subjectName} numberOfLines={1}>
                        {item.subjectName}
                      </Text>
                      <View style={s.subjectMetaRow}>
                        {!!item.subjectCode && (
                          <Text style={s.subjectCode}>{item.subjectCode}</Text>
                        )}
                        {section.studentCount > 0 && (
                          <View style={s.studentRow}>
                            <Ionicons name="people-outline" size={11} color={C.gray400} />
                            <Text style={s.studentText}>
                              {section.studentCount}{" "}
                              student{section.studentCount !== 1 ? "s" : ""}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>

                  {/* Action chips */}
                  <View style={s.subjectActions}>
                    {/* Exams */}
                    <TouchableOpacity
                      style={[s.actionChip, {
                        borderColor:     accentColor,
                        backgroundColor: cls.bg,
                      }]}
                      onPress={() => router.push("/teacher/exams")}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="document-text-outline"
                        size={13}
                        color={accentColor}
                      />
                      <Text style={[s.actionChipText, { color: accentColor }]}>
                        {t("teacherSubjects.exams")}
                      </Text>
                    </TouchableOpacity>

                    {/* Students */}
                    <TouchableOpacity
                      style={[s.actionChip, {
                        borderColor:     C.success,
                        backgroundColor: C.successBg,
                      }]}
                      onPress={() => router.push({
                        pathname: "/teacher/students",
                        params: {
                          classId:     section.classId,
                          className:   section.title,
                          subjectId:   item.subjectId,
                          subjectName: item.subjectName,
                        },
                      })}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="people-outline"
                        size={13}
                        color={C.success}
                      />
                      <Text style={[s.actionChipText, { color: C.success }]}>
                        {t("teacherSubjects.students")}
                      </Text>
                    </TouchableOpacity>

                    {/* Results */}
                    <TouchableOpacity
                      style={[s.actionChip, {
                        borderColor:     C.primary,
                        backgroundColor: C.primaryBg,
                      }]}
                      onPress={() => router.push({
                        pathname: "/teacher/results",
                        params: {
                          classId:     section.classId,
                          subjectId:   item.subjectId,
                          subjectName: item.subjectName,
                        },
                      })}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="bar-chart-outline"
                        size={13}
                        color={C.primary}
                      />
                      <Text style={[s.actionChipText, { color: C.primary }]}>
                        {t("teacherSubjects.results")}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          }}

          renderSectionFooter={() => <View style={s.sectionSpacer} />}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },

  // ── Header ───────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  refreshBtn:   { padding: 8 },

  // ── Summary row ──────────────────────────────────────────
  summaryRow: {
    flexDirection:     "row",
    gap:               10,
    paddingHorizontal: 16,
    paddingVertical:   14,
    backgroundColor:   C.gray50,
  },

  // ── Error banner ─────────────────────────────────────────
  errorBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              8,
    marginHorizontal: 16,
    marginBottom:     8,
    padding:          12,
    backgroundColor:  C.errorBg,
    borderRadius:     10,
    borderWidth:      1,
    borderColor:      "#FECACA",
  },
  errorText: { flex: 1, fontSize: 13, color: C.error },
  retryText: { fontSize: 13, fontWeight: "700", color: C.primary },

  // ── Debug banner ─────────────────────────────────────────
  debugBanner: {
    marginHorizontal: 16,
    marginBottom:     8,
    padding:          10,
    backgroundColor:  "#FFFBEB",
    borderRadius:     8,
    borderWidth:      1,
    borderColor:      "#FDE68A",
  },
  debugText: {
    fontSize:    11,
    color:       C.warning,
    fontFamily:  "monospace",
    marginBottom: 4,
  },

  // ── Empty state ───────────────────────────────────────────
  empty: {
    flex:              1,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 40,
    gap:               16,
  },
  emptyIconBg: {
    width:           88,
    height:          88,
    borderRadius:    24,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  emptyTitle:     { fontSize: 18, fontWeight: "700", color: C.gray700 },
  emptyText:      {
    fontSize:   14,
    color:      C.gray500,
    textAlign:  "center",
    lineHeight: 22,
  },
  emptyRetryBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   C.primary,
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
    marginTop:         8,
  },
  emptyRetryText: { fontSize: 14, fontWeight: "700", color: C.white },

  // ── List ─────────────────────────────────────────────────
  list: { padding: 16, paddingBottom: 40 },

  // ── Section header (class card) ───────────────────────────
  sectionHeader: {
    flexDirection:          "row",
    alignItems:             "center",
    gap:                    10,
    backgroundColor:        C.white,
    borderRadius:           14,
    borderBottomLeftRadius:  0,
    borderBottomRightRadius: 0,
    padding:                14,
    borderWidth:            1,
    borderBottomWidth:      0,
    borderColor:            C.gray200,
    shadowColor:            "#000",
    shadowOpacity:          0.03,
    shadowRadius:           4,
    elevation:              1,
  },
  sectionIconBg: {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  sectionHeaderText: { flex: 1 },
  sectionTitle:      { fontSize: 16, fontWeight: "700", color: C.gray900 },
  sectionMeta:       { fontSize: 11, color: C.gray500, marginTop: 2 },
  sectionBadge: {
    width:          28,
    height:         28,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },
  sectionBadgeText: { fontSize: 13, fontWeight: "800" },
  sectionSpacer:    { height: 16 },

  // ── Subject card ─────────────────────────────────────────
  subjectCard: {
    flexDirection:    "row",
    backgroundColor:  C.white,
    borderLeftWidth:  1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor:      C.gray200,
    overflow:         "hidden",
  },
  subjectCardLast: {
    borderBottomLeftRadius:  14,
    borderBottomRightRadius: 14,
    shadowColor:             "#000",
    shadowOpacity:           0.03,
    shadowRadius:            4,
    elevation:               1,
  },
  subjectAccent:  { width: 4 },
  subjectContent: { flex: 1, padding: 14, gap: 10 },
  subjectHeader:  { flexDirection: "row", alignItems: "center", gap: 10 },
  subjectIconBg: {
    width:          32,
    height:         32,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },
  subjectInfo:    { flex: 1 },
  subjectName:    { fontSize: 14, fontWeight: "600", color: C.gray900 },
  subjectMetaRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginTop:     3,
  },
  subjectCode: {
    fontSize:          10,
    fontWeight:        "700",
    color:             C.gray400,
    backgroundColor:   C.gray100,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      4,
  },
  studentRow:  { flexDirection: "row", alignItems: "center", gap: 4 },
  studentText: { fontSize: 11, color: C.gray400 },

  // ── Action chips ──────────────────────────────────────────
  subjectActions: { flexDirection: "row", gap: 8, paddingLeft: 42 },
  actionChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderRadius:      8,
    borderWidth:       1,
  },
  actionChipText: { fontSize: 11, fontWeight: "700" },
});