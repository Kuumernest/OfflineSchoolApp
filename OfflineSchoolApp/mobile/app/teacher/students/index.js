// app/teacher/students/index.js
"use strict";

/**
 * Teacher Students Screen
 *
 * Fixed issues:
 *  #M1 — local tableExists() replaced with import from dbHelpers
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, FlatList, TextInput,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api              from "../../../src/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { tableExists as _tableExists } from "../../../src/db/dbHelpers";

/**
 * One-argument wrapper — preserves the existing call signature.
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
const tableExists = async (tableName) => {
  try {
    const db = await getDatabase();
    return _tableExists(db, tableName);
  } catch {
    return false;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DESIGN TOKENS
// ═════════════════════════════════════════════════════════════════════════════

const C = {
  primary:   "#4F46E5", primaryBg: "#EEF2FF",
  success:   "#059669", successBg: "#ECFDF5",
  warning:   "#D97706", warningBg: "#FEF3C7",
  error:     "#DC2626", errorBg:   "#FEF2F2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB", gray100: "#F3F4F6", gray200: "#E5E7EB",
  gray300:   "#D1D5DB", gray400: "#9CA3AF", gray500: "#6B7280",
  gray600:   "#4B5563", gray700: "#374151", gray900: "#111827",
};

const AVATAR_COLORS = [
  { bg: "#EEF2FF", text: "#4F46E5" }, { bg: "#ECFDF5", text: "#059669" },
  { bg: "#FEF3C7", text: "#D97706" }, { bg: "#FEF2F2", text: "#DC2626" },
  { bg: "#F0F9FF", text: "#0284C7" }, { bg: "#FDF4FF", text: "#A855F7" },
  { bg: "#FFF7ED", text: "#EA580C" }, { bg: "#F0FDF4", text: "#16A34A" },
];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — LOCAL DB HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const dbQuery = async (sql, params = []) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(sql, params);
    return rows ?? [];
  } catch { return []; }
};

const getColumns = async (table) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(`PRAGMA table_info(${table})`, []);
    return new Set((rows ?? []).map((r) => r.name));
  } catch { return new Set(); }
};

const pickCol = (cols, ...candidates) => {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — DEDUPLICATION
// ═════════════════════════════════════════════════════════════════════════════

const deduplicateStudents = (students) => {
  const seenIds   = new Set();
  const seenNames = new Set();
  const result    = [];

  for (const s of students) {
    const id   = String(s.id   || "").trim();
    const name = String(s.name || "").toLowerCase().trim();
    const adm  = String(s.admissionNumber || "").toLowerCase().trim();

    if (id && !id.startsWith("tmp_")) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    if (name && name !== "unknown student") {
      const nameKey = adm ? `${name}::${adm}` : name;
      if (seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
    }

    result.push(s);
  }

  return result;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SQLITE DATA SOURCE
// ═════════════════════════════════════════════════════════════════════════════

const loadStudentsFromSQLite = async (classId) => {
  try {
    if (!(await tableExists("students"))) return [];

    const sCols    = await getColumns("students");
    const hasUsers = await tableExists("users");

    const hasSnake = sCols.has("class_id");
    const hasCamel = sCols.has("classId");
    if (!hasSnake && !hasCamel) return [];

    let classWhere, classParams;
    if (hasSnake && hasCamel) {
      classWhere  = "(s.class_id = ? OR s.classId = ?)";
      classParams = [classId, classId];
    } else if (hasSnake) {
      classWhere  = "s.class_id = ?";
      classParams = [classId];
    } else {
      classWhere  = "s.classId = ?";
      classParams = [classId];
    }

    const delFilter = sCols.has("deleted_at")
      ? "AND (s.deleted_at IS NULL OR s.deleted_at = '')"
      : "";

    const hasUserJoin = hasUsers && sCols.has("user_id");

    const nameExpr = hasUserJoin
      ? `COALESCE(
          NULLIF(TRIM(s.name), ''),
          NULLIF(TRIM(COALESCE(s.firstName,'') ||
            CASE WHEN s.firstName IS NOT NULL AND s.lastName IS NOT NULL THEN ' ' ELSE '' END ||
            COALESCE(s.lastName,'')), ''),
          NULLIF(TRIM(u.name), ''), 'Unknown Student')`
      : `COALESCE(
          NULLIF(TRIM(s.name), ''),
          NULLIF(TRIM(COALESCE(s.firstName,'') ||
            CASE WHEN s.firstName IS NOT NULL AND s.lastName IS NOT NULL THEN ' ' ELSE '' END ||
            COALESCE(s.lastName,'')), ''),
          'Unknown Student')`;

    const admCols = [
      "admissionNumber", "admissionNo", "admNo",
      "admission_number", "studentId", "rollNo",
    ].filter((c) => sCols.has(c));

    const admExpr    = admCols.length > 0
      ? `COALESCE(${admCols.map((c) => `NULLIF(TRIM(s.${c}), '')`).join(", ")}, '—')`
      : `'—'`;
    const genExpr    = sCols.has("gender") ? "s.gender" : "NULL";
    const emailExpr  = hasUserJoin
      ? "COALESCE(NULLIF(TRIM(s.email),''), NULLIF(TRIM(u.email),''))"
      : sCols.has("email") ? "NULLIF(TRIM(s.email), '')" : "NULL";
    const statExpr   = sCols.has("status") ? "s.status" : "NULL";
    const joinClause = hasUserJoin ? "LEFT JOIN users u ON u.id = s.user_id" : "";

    const rows = await dbQuery(
      `SELECT s.id,
         ${nameExpr}  AS name,
         ${admExpr}   AS admissionNumber,
         ${genExpr}   AS gender,
         ${emailExpr} AS email,
         ${statExpr}  AS status
       FROM students s ${joinClause}
       WHERE ${classWhere} ${delFilter}
       GROUP BY s.id
       ORDER BY name ASC`,
      classParams
    );

    return deduplicateStudents(rows.map((r) => sanitiseStudent(r, classId)));
  } catch { return []; }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — API DATA SOURCE
// ═════════════════════════════════════════════════════════════════════════════

const loadStudentsFromAPI = async (classId, schoolId) => {
  const endpoints = [
    { url: "/teacher/students",    params: { classId,           schoolId } },
    { url: "/teacher/my-students", params: { classId,           schoolId } },
    { url: "/teacher/students",    params: { class_id: classId, schoolId } },
  ];

  for (const ep of endpoints) {
    try {
      const res  = await api.get(ep.url, { params: ep.params, timeout: 6_000 });
      const data = res.data;
      const list =
        Array.isArray(data?.students)       ? data.students       :
        Array.isArray(data?.data?.students) ? data.data.students  :
        Array.isArray(data?.data)           ? data.data           :
        Array.isArray(data)                 ? data                : [];

      if (!list.length) continue;

      const matching = list.filter((s) => {
        const sClass = String(s.classId || s.class_id || s.class?._id || s.class?.id || "").trim();
        return sClass === classId;
      });

      if (matching.length > 0) {
        const sanitised = matching.map((s) =>
          sanitiseStudent({
            id:              s._id || s.id || "",
            name:            s.name || s.full_name || s.fullName || s.studentName || _buildNameFromParts(s) || null,
            admissionNumber: s.admissionNumber || s.admission_number || s.admNo || s.admissionNo || s.rollNo || null,
            gender:          s.gender || s.sex || null,
            email:           s.email  || null,
            status:          s.status || null,
          }, classId)
        );
        return deduplicateStudents(sanitised);
      }
      return [];
    } catch { /* Try next endpoint */ }
  }
  return [];
};

const _buildNameFromParts = (obj) => {
  if (!obj) return null;
  const first = obj.firstName || obj.first_name || "";
  const last  = obj.lastName  || obj.last_name  || "";
  return [first, last].filter(Boolean).join(" ").trim() || null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SANITISE
// ═════════════════════════════════════════════════════════════════════════════

const sanitiseStudent = (raw, classId) => {
  if (!raw) return {
    id: `tmp_${Math.random()}`, name: "Unknown Student",
    admissionNumber: "—", gender: null, email: null, status: null, classId: classId || "",
  };
  const rawName = raw.name ?? raw.full_name ?? raw.fullName ?? raw.studentName ?? null;
  return {
    id:              String(raw.id              ?? "").trim() || `tmp_${Math.random()}`,
    name:            String(rawName             ?? "").trim() || "Unknown Student",
    admissionNumber: String(raw.admissionNumber ?? "").trim() || "—",
    gender:          raw.gender != null ? String(raw.gender).trim() : null,
    email:           raw.email  != null ? String(raw.email).trim()  : null,
    status:          raw.status != null ? String(raw.status).trim() : null,
    classId:         String(raw.classId ?? classId ?? "").trim(),
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — SQLITE PERSIST
// ═════════════════════════════════════════════════════════════════════════════

const persistStudentsToSQLite = async (students, classId, schoolId) => {
  try {
    if (!(await tableExists("students")) || !students.length) return;
    const cols  = await getColumns("students");
    const clsC  = pickCol(cols, "class_id", "classId");
    const nameC = pickCol(cols, "name", "full_name", "fullName");
    const sidC  = pickCol(cols, "schoolId", "school_id");
    const admC  = pickCol(cols, "admissionNumber", "admissionNo", "admNo");
    if (!clsC || !nameC) return;

    const db = await getDatabase();
    for (const s of students) {
      if (!s.id || s.id.startsWith("tmp_")) continue;
      const parts   = ["id", nameC, clsC];
      const vals    = [s.id, s.name, classId];
      const updates = [`${nameC}=excluded.${nameC}`];
      if (sidC && schoolId) { parts.push(sidC); vals.push(schoolId); }
      if (admC && s.admissionNumber !== "—") {
        parts.push(admC); vals.push(s.admissionNumber);
        updates.push(`${admC}=excluded.${admC}`);
      }
      await db.runAsync(
        `INSERT INTO students (${parts.join(",")}) VALUES (${parts.map(() => "?").join(",")})
         ON CONFLICT(id) DO UPDATE SET ${updates.join(",")}`,
        vals
      ).catch(() => {});
    }
  } catch { /* Non-fatal */ }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — FORMATTERS
// ═════════════════════════════════════════════════════════════════════════════

const getInitials = (name) => {
  const safe = String(name ?? "").trim();
  if (!safe || safe.startsWith("Unknown") || safe.startsWith("Student ")) return "?";
  const parts = safe.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const getAvatarColor = (id) => {
  const key = String(id ?? "");
  let hash  = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const genderIcon = (g) => {
  const val = String(g || "").toLowerCase();
  if (val.startsWith("m")) return { icon: "male",   color: "#0284C7" };
  if (val.startsWith("f")) return { icon: "female", color: "#DB2777" };
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — MAIN SCREEN
// ═════════════════════════════════════════════════════════════════════════════

export default function TeacherStudentsScreen() {
  const { classId, className } = useLocalSearchParams();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId || user?.school_id;
  const { t } = useTranslation();

  const [students,   setStudents]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");
  const [error,      setError]      = useState(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Load ─────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false) => {
    if (!classId) {
      setError("No class specified");
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else            setLoading(true);
      setError(null);

      // 1) Try SQLite first (offline-first)
      let list = await loadStudentsFromSQLite(classId);

      // 2) Fall back to API if empty
      if (!list.length) {
        list = await loadStudentsFromAPI(classId, schoolId);
        if (list.length > 0) {
          await persistStudentsToSQLite(list, classId, schoolId);
        }
      }

      if (mountedRef.current) setStudents(list);
    } catch (err) {
      if (mountedRef.current) setError(err.message || "Failed to load students");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [classId, schoolId]);

  useEffect(() => { load(); }, [load]);

  // ── Search filter ────────────────────────────────────────
  const filtered = students.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return (
      String(s.name || "").toLowerCase().includes(q) ||
      String(s.admissionNumber || "").toLowerCase().includes(q) ||
      String(s.email || "").toLowerCase().includes(q)
    );
  });

  // ── Stats ────────────────────────────────────────────────
  const stats = {
    total:  students.length,
    male:   students.filter((s) => String(s.gender || "").toLowerCase().startsWith("m")).length,
    female: students.filter((s) => String(s.gender || "").toLowerCase().startsWith("f")).length,
  };

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.screen}>
                <Header title={className || t("teacher.students.title")} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={styles.loadingText}>{t("common.loading")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Header title={className || t("teacher.students.title")} count={students.length} />

      {/* ── Stats Bar ── */}
      {students.length > 0 && (
        <View style={styles.statsBar}>
                    <StatChip label={t("teacher.students.total")} value={stats.total}  color={C.primary} />
          <StatChip label={t("teacher.students.male")} value={stats.male}   color="#0284C7" />
          <StatChip label={t("teacher.students.female")} value={stats.female} color="#DB2777" />
        </View>
      )}

      {/* ── Search ── */}
      {students.length > 0 && (
        <View style={styles.searchWrap}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={C.gray400} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
                    placeholder={t("teacher.students.searchPlaceholder")}
              placeholderTextColor={C.gray400}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={C.gray400} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* ── Error banner ── */}
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={C.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* ── List ── */}
      <FlatList
        data={filtered}
        keyExtractor={(item, i) => String(item.id || `s_${i}`)}
        renderItem={({ item }) => <StudentRow student={item} />}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          <EmptyState
            hasSearch={search.length > 0}
            onClear={() => setSearch("")}
          />
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            colors={[C.primary]}
            tintColor={C.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — SUB-COMPONENTS
// ═════════════════════════════════════════════════════════════════════════════

function Header({ title, count }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => router.back()}
        style={styles.backBtn}
        activeOpacity={0.7}
      >
        <Ionicons name="arrow-back" size={24} color={C.gray900} />
      </TouchableOpacity>
      <View style={styles.headerCenter}>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        {count != null && (
          <Text style={styles.headerSub}>
            {count} student{count !== 1 ? "s" : ""}
          </Text>
        )}
      </View>
    </View>
  );
}

function StatChip({ label, value, color }) {
  return (
    <View style={styles.statChip}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function StudentRow({ student }) {
  const initials = getInitials(student.name);
  const avatar   = getAvatarColor(student.id);
  const gender   = genderIcon(student.gender);

  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.7}
      onPress={() =>
        router.push({
          pathname: "/teacher/students/[id]",
          params:   { id: student.id, name: student.name },
        })
      }
    >
      <View style={[styles.avatar, { backgroundColor: avatar.bg }]}>
        <Text style={[styles.avatarText, { color: avatar.text }]}>
          {initials}
        </Text>
      </View>

      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {student.name}
          </Text>
          {gender && (
            <Ionicons name={gender.icon} size={13} color={gender.color} />
          )}
        </View>
        <View style={styles.rowBottom}>
          <View style={styles.metaChip}>
            <Ionicons name="id-card-outline" size={11} color={C.gray500} />
            <Text style={styles.metaText}>{student.admissionNumber}</Text>
          </View>
          {student.email && (
            <View style={styles.metaChip}>
              <Ionicons name="mail-outline" size={11} color={C.gray500} />
              <Text style={styles.metaText} numberOfLines={1}>
                {student.email}
              </Text>
            </View>
          )}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={18} color={C.gray300} />
    </TouchableOpacity>
  );
}

function EmptyState({ hasSearch, onClear }) {
  // Its own hook: this is a sibling of the screen component, not a child, so
  // the screen's `t` was never in scope here. Every render of the empty state
  // threw "t is not defined" before this.
  const { t } = useTranslation();

  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons
          name={hasSearch ? "search-outline" : "people-outline"}
          size={44}
          color={C.gray300}
        />
      </View>
      <Text style={styles.emptyTitle}>
        {hasSearch ? t("teacher.students.noMatches") : t("teacher.students.noResults")}
      </Text>
      <Text style={styles.emptyBody}>
        {hasSearch
          ? t("teacher.students.noMatchesHint")
          : t("teacher.students.noneEnrolledHint")}
      </Text>
      {hasSearch && (
        <TouchableOpacity
          style={styles.emptyBtn}
          onPress={onClear}
          activeOpacity={0.8}
        >
          <Ionicons name="close-circle-outline" size={16} color={C.white} />
          <Text style={styles.emptyBtnText}>{t("teacher.students.clearSearch")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — STYLES
// ═════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: C.gray50 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },

  // ── Header ──────────────────────────────────────────────
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56,
    paddingBottom: 14, backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
    gap: 10,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: C.gray100,
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 17, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },

  // ── Stats bar ───────────────────────────────────────────
  statsBar: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  statChip: {
    flex: 1, alignItems: "center",
    paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.gray50,
    borderWidth: 1, borderColor: C.gray100,
  },
  statValue: { fontSize: 18, fontWeight: "800" },
  statLabel: {
    fontSize: 10, color: C.gray500,
    fontWeight: "600", marginTop: 2,
    textTransform: "uppercase", letterSpacing: 0.5,
  },

  // ── Search ──────────────────────────────────────────────
  searchWrap: {
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  searchBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: C.gray100, borderRadius: 10,
  },
  searchInput: {
    flex: 1, fontSize: 14,
    color: C.gray900, padding: 0,
  },

  // ── Error banner ────────────────────────────────────────
  errorBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.errorBg, padding: 12,
    marginHorizontal: 16, marginTop: 12,
    borderRadius: 8, borderWidth: 1, borderColor: C.error + "30",
  },
  errorText: { flex: 1, fontSize: 12, color: C.error, fontWeight: "600" },

  // ── List ────────────────────────────────────────────────
  list: { padding: 16, paddingBottom: 40 },

  // ── Row ─────────────────────────────────────────────────
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: C.white, borderRadius: 12,
    padding: 12, borderWidth: 1, borderColor: C.gray100,
    shadowColor: "#000", shadowOpacity: 0.03,
    shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 15, fontWeight: "700" },
  rowBody:    { flex: 1, gap: 4 },
  rowTop: {
    flexDirection: "row", alignItems: "center", gap: 6,
  },
  rowName: {
    flex: 1, fontSize: 14, fontWeight: "700",
    color: C.gray900,
  },
  rowBottom: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
  },
  metaChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 5, backgroundColor: C.gray50,
    maxWidth: "60%",
  },
  metaText: {
    fontSize: 11, color: C.gray500,
    fontWeight: "600",
  },

  // ── Empty ───────────────────────────────────────────────
  empty: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 32, gap: 10,
  },
  emptyIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: C.gray100,
    alignItems: "center", justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: C.gray700 },
  emptyBody: {
    fontSize: 13, color: C.gray500,
    textAlign: "center", lineHeight: 19,
  },
  emptyBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: C.primary, borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 10, marginTop: 8,
  },
  emptyBtnText: { fontSize: 13, fontWeight: "700", color: C.white },
});