// app/admin/reports/index.js
"use strict";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import api from "../../../src/services/api";
import { getDatabase } from "../../../src/db/database";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

const STATUS_META = {
  completed: { color: "#059669", bg: "#ECFDF5", label: "Completed" },
  published: { color: "#7C3AED", bg: "#F5F3FF", label: "Published" },
  approved:  { color: "#059669", bg: "#ECFDF5", label: "Approved"  },
  ongoing:   { color: "#D97706", bg: "#FEF3C7", label: "Ongoing"   },
  scheduled: { color: "#4F46E5", bg: "#EEF2FF", label: "Scheduled" },
  draft:     { color: "#6B7280", bg: "#F3F4F6", label: "Draft"     },
  archived:  { color: "#9CA3AF", bg: "#F9FAFB", label: "Archived"  },
};

const REPORTABLE_STATUSES = new Set(["completed", "published", "approved", "ongoing"]);

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const formatDate = (dateStr) => {
  if (!dateStr) return "No date";
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return dateStr; }
};

// ─────────────────────────────────────────────────────────
// LOCAL DB FALLBACK
// ─────────────────────────────────────────────────────────

const loadExamsFromSQLite = async (schoolId) => {
  try {
    const db = await getDatabase();

    const tableCheck = await db
      .getFirstAsync(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='exams'`
      )
      .catch(() => null);

    if (!tableCheck) {
      console.log("[ExamReports] No exams table in SQLite");
      return [];
    }

    const cols   = await db.getAllAsync(`PRAGMA table_info(exams)`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const schoolCol  = colSet.has("schoolId")  ? "schoolId"  : colSet.has("school_id") ? "school_id" : null;
    const deletedCol = colSet.has("deleted_at") ? "deleted_at": colSet.has("deletedAt") ? "deletedAt" : null;
    const createdCol = colSet.has("created_at") ? "created_at": colSet.has("createdAt") ? "createdAt" : "rowid";

    const classTableCheck = await db
      .getFirstAsync(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='classes'`
      )
      .catch(() => null);

    let query;
    const params = [];

    if (classTableCheck) {
      const classIdCol = colSet.has("classId") ? "e.classId" : colSet.has("class_id") ? "e.class_id" : null;
      if (classIdCol) {
        query = `
          SELECT e.*, c.name AS className
          FROM exams e
          LEFT JOIN classes c ON c.id = ${classIdCol}
          WHERE 1=1
          ${schoolCol  ? `AND e.${schoolCol} = ?` : ""}
          ${deletedCol ? `AND (e.${deletedCol} IS NULL OR e.${deletedCol} = '')` : ""}
          ORDER BY e.${createdCol} DESC
          LIMIT 100
        `;
      } else {
        query = `
          SELECT e.*
          FROM exams e
          WHERE 1=1
          ${schoolCol  ? `AND e.${schoolCol} = ?` : ""}
          ${deletedCol ? `AND (e.${deletedCol} IS NULL OR e.${deletedCol} = '')` : ""}
          ORDER BY e.${createdCol} DESC
          LIMIT 100
        `;
      }
    } else {
      query = `
        SELECT *
        FROM exams
        WHERE 1=1
        ${schoolCol  ? `AND ${schoolCol} = ?` : ""}
        ${deletedCol ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')` : ""}
        ORDER BY ${createdCol} DESC
        LIMIT 100
      `;
    }

    if (schoolCol && schoolId) params.push(schoolId);

    const rows = await db.getAllAsync(query, params).catch((err) => {
      console.warn("[ExamReports] SQLite query error:", err.message);
      return [];
    });

    console.log(`[ExamReports] SQLite → ${rows.length} exam(s)`);
    return rows;
  } catch (err) {
    console.warn("[ExamReports] SQLite fallback error:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────
// EXAM CARD
// ─────────────────────────────────────────────────────────

const ExamCard = ({ item, onViewResults, onGenerateReports }) => {
  const statusKey  = (item.status || "completed").toLowerCase();
  const statusMeta = STATUS_META[statusKey] ?? STATUS_META.completed;
  const examId     = item._id || item.id;

  const metaParts = [
    item.academicYear,
    item.term,
    item.className,
  ].filter(Boolean);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardIconBg}>
          <Ionicons name="document-text-outline" size={18} color={COLORS.primary} />
        </View>
        <View style={styles.cardHeaderText}>
          <Text style={styles.examName} numberOfLines={1}>{item.name}</Text>
          {metaParts.length > 0 && (
            <Text style={styles.examMeta} numberOfLines={1}>
              {metaParts.join("  ·  ")}
            </Text>
          )}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusMeta.bg }]}>
          <Text style={[styles.statusText, { color: statusMeta.color }]}>
            {statusMeta.label}
          </Text>
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{item.totalMarks ?? 100}</Text>
          <Text style={styles.statLabel}>Total Marks</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{item.passMark ?? 50}</Text>
          <Text style={styles.statLabel}>Pass Mark</Text>
        </View>
        {item.totalStudents != null && (
          <>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{item.totalStudents}</Text>
              <Text style={styles.statLabel}>Students</Text>
            </View>
          </>
        )}
        {item.passRate != null && (
          <>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={[styles.statValue, {
                color: item.passRate >= 70 ? COLORS.success : COLORS.warning,
              }]}>
                {item.passRate}%
              </Text>
              <Text style={styles.statLabel}>Pass Rate</Text>
            </View>
          </>
        )}
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.footerStat}>
          <Ionicons name="calendar-outline" size={12} color={COLORS.gray500} />
          <Text style={styles.footerStatText}>{formatDate(item.startDate)}</Text>
        </View>
        <View style={styles.footerActions}>
          <TouchableOpacity
            style={styles.generateChip}
            onPress={() => onGenerateReports(item)}
            activeOpacity={0.7}
          >
            <Ionicons name="print-outline" size={12} color={COLORS.success} />
            <Text style={styles.generateChipText}>Report Cards</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewBtn}
            onPress={() => onViewResults(item)}
            activeOpacity={0.7}
          >
            <Text style={styles.viewBtnText}>Results</Text>
            <Ionicons name="chevron-forward" size={14} color={COLORS.primary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// FILTER BAR
// ─────────────────────────────────────────────────────────

const FILTERS = [
  { key: "all",       label: "All"       },
  { key: "published", label: "Published" },
  { key: "completed", label: "Completed" },
  { key: "ongoing",   label: "Ongoing"   },
];

const FilterBar = ({ active, onChange }) => (
  <View style={styles.filterBar}>
    {FILTERS.map((f) => (
      <TouchableOpacity
        key={f.key}
        style={[styles.filterBtn, active === f.key && styles.filterBtnActive]}
        onPress={() => onChange(f.key)}
        activeOpacity={0.7}
      >
        <Text style={[styles.filterText, active === f.key && styles.filterTextActive]}>
          {f.label}
        </Text>
      </TouchableOpacity>
    ))}
  </View>
);

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ExamReportsScreen() {
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [allExams,   setAllExams]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [source,     setSource]     = useState(null);
  const [filter,     setFilter]     = useState("all");

  const exams = useMemo(() => {
    if (filter === "all") return allExams;
    return allExams.filter(
      (e) => (e.status || "").toLowerCase() === filter
    );
  }, [allExams, filter]);

  const fetchReports = useCallback(async (isRefresh = false) => {
    try {
      setError(null);
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      let examList = [];
      let src      = null;

      // Strategy 1: API
      try {
        const { data } = await api.get("/exams", {
          params:  { schoolId, limit: 100 },
          timeout: 10000,
        });
        const raw = data?.exams || data?.data || (Array.isArray(data) ? data : []);
        if (raw.length > 0) {
          examList = raw;
          src      = "api";
          console.log(`[ExamReports] API → ${examList.length} exam(s)`);
        }
      } catch (apiErr) {
        console.warn("[ExamReports] API failed:", apiErr.message);
      }

      // Strategy 2: SQLite fallback
      if (examList.length === 0) {
        examList = await loadExamsFromSQLite(schoolId);
        src      = examList.length > 0 ? "sqlite" : "none";
      }

      const reportable = examList.filter((e) =>
        REPORTABLE_STATUSES.has((e.status || "").toLowerCase())
      );

      setAllExams(reportable.length > 0 ? reportable : examList);
      setSource(src);
    } catch (err) {
      console.error("[ExamReports] fetchReports error:", err.message);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const handleViewResults = useCallback((item) => {
    const examId = item._id || item.id;
    router.push({
      pathname: "/admin/exams/results/[examId]",
      params:   { examId },
    });
  }, []);

  const handleGenerateReports = useCallback((item) => {
    const examId = item._id || item.id;
    router.push({
      pathname: "/admin/reports/generate",
      params: {
        examId,
        examName:     item.name         || "",
        term:         item.term         || "",
        academicYear: item.academicYear || "",
      },
    });
  }, []);

  if (loading) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Exam Reports</Text>
        </View>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>Loading reports…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>Exam Reports</Text>
          {source === "sqlite" && (
            <Text style={styles.headerSourceBadge}>Cached</Text>
          )}
        </View>
        <TouchableOpacity
          onPress={() => fetchReports(true)}
          style={styles.refreshBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {/* Filter bar */}
      <FilterBar active={filter} onChange={setFilter} />

      {/* Count + action bar */}
      {allExams.length > 0 && (
        <View style={styles.countBar}>
          <Text style={styles.countText}>
            {exams.length} of {allExams.length} exam{allExams.length !== 1 ? "s" : ""}
          </Text>
          <TouchableOpacity
            style={styles.countBarAction}
            onPress={() => router.push("/admin/reports/generate")}
            activeOpacity={0.7}
          >
            <Ionicons name="print-outline" size={14} color={COLORS.primary} />
            <Text style={styles.countBarActionText}>Generate Report Cards</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Error banner */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color="#DC2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => fetchReports()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <FlatList
        data={exams}
        keyExtractor={(item) => String(item._id || item.id)}
        renderItem={({ item }) => (
          <ExamCard
            item={item}
            onViewResults={handleViewResults}
            onGenerateReports={handleGenerateReports}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchReports(true)}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="document-outline" size={56} color={COLORS.gray200} />
            <Text style={styles.emptyTitle}>
              {filter !== "all" ? `No ${filter} exams` : "No Exam Reports Yet"}
            </Text>
            <Text style={styles.emptyText}>
              {filter !== "all"
                ? `Try switching to "All" to see all exams`
                : "Completed and published exams will appear here"}
            </Text>
            {filter === "all" ? (
              <TouchableOpacity
                style={styles.emptyAction}
                onPress={() => router.push("/admin/reports/generate")}
                activeOpacity={0.7}
              >
                <Ionicons name="print-outline" size={16} color={COLORS.white} />
                <Text style={styles.emptyActionText}>Generate Report Cards</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.emptyAction, { backgroundColor: COLORS.gray500 }]}
                onPress={() => setFilter("all")}
                activeOpacity={0.7}
              >
                <Text style={styles.emptyActionText}>Show All Exams</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: COLORS.gray50 },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { fontSize: 14, color: COLORS.gray500 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTextWrap: {
    flex:          1,
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.gray900 },
  headerSourceBadge: {
    fontSize:          10,
    fontWeight:        "700",
    color:             COLORS.warning,
    backgroundColor:   "#FEF3C7",
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      6,
  },
  refreshBtn: { padding: 8 },
  filterBar: {
    flexDirection:     "row",
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  filterBtn:       { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: COLORS.gray100 },
  filterBtnActive: { backgroundColor: COLORS.primaryBg },
  filterText:      { fontSize: 13, fontWeight: "600", color: COLORS.gray500 },
  filterTextActive:{ color: COLORS.primary },
  countBar: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  countText:          { fontSize: 13, color: COLORS.gray500, fontWeight: "500" },
  countBarAction:     { flexDirection: "row", alignItems: "center", gap: 5 },
  countBarActionText: { fontSize: 13, fontWeight: "600", color: COLORS.primary },
  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    margin:          16,
    padding:         12,
    backgroundColor: "#FEF2F2",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     "#FECACA",
  },
  errorText: { flex: 1, fontSize: 13, color: "#DC2626" },
  retryText: { fontSize: 13, fontWeight: "700", color: COLORS.primary },
  list:      { padding: 16, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: COLORS.white,
    borderRadius:    16,
    padding:         16,
    borderWidth:     1,
    borderColor:     COLORS.gray200,
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.05,
    shadowRadius:    6,
    elevation:       2,
    gap:             12,
  },
  cardHeader:     { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIconBg: {
    width:           40,
    height:          40,
    borderRadius:    10,
    backgroundColor: COLORS.primaryBg,
    alignItems:      "center",
    justifyContent:  "center",
  },
  cardHeaderText: { flex: 1 },
  examName:       { fontSize: 15, fontWeight: "700", color: COLORS.gray900 },
  examMeta:       { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  statusBadge: {
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
  statusText: { fontSize: 11, fontWeight: "700" },
  statsRow: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: COLORS.gray50,
    borderRadius:    10,
    padding:         10,
  },
  statItem:   { flex: 1, alignItems: "center" },
  statValue:  { fontSize: 16, fontWeight: "800", color: COLORS.gray900 },
  statLabel:  { fontSize: 9, fontWeight: "600", color: COLORS.gray400, textTransform: "uppercase", marginTop: 2 },
  statDivider:{ width: 1, height: 30, backgroundColor: COLORS.gray200 },
  cardFooter: {
    flexDirection:  "row",
    alignItems:     "center",
    paddingTop:     12,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray100,
  },
  footerStat:    { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  footerStatText:{ fontSize: 11, color: COLORS.gray500 },
  footerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  generateChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   5,
    borderRadius:      6,
    backgroundColor:   COLORS.successBg,
    borderWidth:       1,
    borderColor:       "#A7F3D0",
  },
  generateChipText: { fontSize: 11, fontWeight: "700", color: COLORS.success },
  viewBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderRadius:      6,
    backgroundColor:   COLORS.primaryBg,
  },
  viewBtnText: { fontSize: 12, fontWeight: "700", color: COLORS.primary },
  empty: {
    alignItems:        "center",
    paddingTop:        80,
    paddingBottom:     40,
    gap:               14,
    paddingHorizontal: 32,
  },
  emptyTitle:  { fontSize: 17, fontWeight: "700", color: COLORS.gray700 },
  emptyText:   { fontSize: 13, color: COLORS.gray500, textAlign: "center", lineHeight: 20 },
  emptyAction: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    backgroundColor:   COLORS.primary,
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
    marginTop:         8,
  },
  emptyActionText: { fontSize: 14, fontWeight: "700", color: COLORS.white },
});