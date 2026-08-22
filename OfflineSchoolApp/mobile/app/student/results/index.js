// app/student/results/index.js
import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import ExamService      from "../../../src/services/exam.service";

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
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

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve all student IDs from local SQLite.
 * Your attendance records use Student._id, not User._id.
 */
const resolveAllStudentIds = async (userId) => {
  const ids = new Set([String(userId)]);
  try {
    const db     = await getDatabase();
    const tables = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type='table'`)
      .catch(() => []);
    const tableSet = new Set(tables.map((t) => t.name));
    const tbl      = ["students", "student"].find((t) => tableSet.has(t));
    if (!tbl) return ids;

    const cols   = await db.getAllAsync(`PRAGMA table_info(${tbl})`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));
    const userCol =
      colSet.has("user_id") ? "user_id" :
      colSet.has("userId")  ? "userId"  : null;
    if (!userCol) return ids;

    const rows = await db
      .getAllAsync(
        `SELECT * FROM ${tbl} WHERE ${userCol} = ? OR ${userCol} = ?`,
        [userId, String(userId)]
      )
      .catch(() => []);

    for (const row of rows) {
      ["id", "_id", "studentId", "student_id"].forEach((k) => {
        if (row[k]) ids.add(String(row[k]));
      });
    }
  } catch (e) {
    console.warn("[resolveAllStudentIds]", e.message);
  }
  return ids;
};

/**
 * Fetch all published exams for this school, then for each exam
 * try to get this student's result using your existing service pattern:
 *   GET /results/:examId/student/:studentId
 *
 * This matches your results.service.js → getStudentResult()
 */
const fetchMyResults = async (userId, schoolId) => {
  const studentIds = await resolveAllStudentIds(userId);
  const idList     = [...studentIds];

  console.log(`[fetchMyResults] trying ids: [${idList.join(", ")}]`);

  // ── Step 1: Get list of published exams for this school ──────────────────
  //
  // ExamService is network-first with a SQLite fallback, so a result the
  // student has already opened stays readable with no signal.
  let exams   = [];
  let isStale = false;
  try {
    const res = await ExamService.getExams({ schoolId, status: "published" });
    exams   = res.exams   || [];
    isStale = res.isStale || false;
    console.log(
      `[fetchMyResults] found ${exams.length} published exam(s)` +
      (isStale ? " (from cache)" : "")
    );
  } catch (err) {
    console.warn("[fetchMyResults] exam list failed:", err.message);
  }

  if (exams.length === 0) {
    return { results: [], source: "no-exams", isStale };
  }

  // ── Step 2: For each exam, try each student ID ────────────────────────────
  const results = [];

  for (const exam of exams) {
    const examId = exam._id || exam.id;
    if (!examId) continue;

    let found = false;

    for (const studentId of idList) {
      if (found) break;
      try {
        // Network-first, SQLite fallback (ExamService.getStudentResult).
        const data = await ExamService.getStudentResult(examId, studentId, schoolId);

        // Backend returns { success, data: { summary, scores } }; the cached
        // copy is already the unwrapped result object.
        const resultData = data?.data || data?.result || data;
        if (data?.isStale) isStale = true;

        if (resultData && (resultData.summary || resultData.percentage != null)) {
          // Normalise into a flat shape for the UI
          const summary = resultData.summary || resultData;
          results.push({
            // IDs
            _id:          summary._id        || `${examId}_${studentId}`,
            examId,
            studentId,

            // Exam info
            examName:     exam.name          || exam.title       || "Examination",
            academicYear: exam.academicYear  || exam.academic_year || null,
            term:         exam.term          || exam.semester    || null,
            className:    summary.className  || exam.className   || null,

            // Scores
            percentage:   summary.percentage ?? summary.totalPercentage ?? 0,
            overallGrade: summary.overallGrade || summary.grade || "—",
            average:      summary.average      || 0,
            totalScore:   summary.totalScore   || summary.total  || 0,
            maxTotalScore:summary.maxTotalScore || exam.totalMarks || 0,

            // Rankings
            classPosition:  summary.classPosition  || summary.position || null,
            totalInClass:   summary.totalInClass   || null,

            // Status
            isPassing:       summary.isPassing ?? (summary.percentage >= 50),
            promotionStatus: summary.promotionStatus || null,
            overallRemark:   summary.overallRemark  || summary.remark || null,

            // Subject breakdown (for detail screen)
            subjectBreakdown: resultData.scores || summary.subjectBreakdown || [],

            // Raw data (for detail screen)
            _raw: resultData,
          });
          found = true;
        }
      } catch (err) {
        const status = err.response?.status;
        if (status === 404) continue; // No result for this studentId, try next
        if (status === 403) continue; // Unauthorized for this ID
        if (err.code === "OFFLINE_NO_CACHE") {
          isStale = true;
          continue; // Offline and this one was never cached — skip quietly
        }
        console.warn(
          `[fetchMyResults] result ${examId}/${studentId}:`,
          err.message
        );
      }
    }
  }

  console.log(`[fetchMyResults] → ${results.length} result(s) found`);
  return { results, source: isStale ? "cache" : "api", isStale };
};

// ─────────────────────────────────────────────────────────────────────────────
// RESULT CARD
// ─────────────────────────────────────────────────────────────────────────────

const ResultPreviewCard = ({ item, onPress }) => {
  const isPassing = item.isPassing ?? (item.percentage >= 50);
  const passColor = isPassing ? COLORS.success : COLORS.error;
  const passBg    = isPassing ? COLORS.successBg : COLORS.errorBg;
  const pct       = typeof item.percentage === "number" ? item.percentage : 0;

  return (
    <TouchableOpacity style={rc.card} onPress={onPress} activeOpacity={0.7}>
      <View style={[rc.accent, { backgroundColor: passColor }]} />

      <View style={rc.body}>
        <Text style={rc.examName} numberOfLines={1}>
          {item.examName || "Examination"}
        </Text>

        {/* Meta chips */}
        <View style={rc.metaRow}>
          {!!item.className && (
            <View style={rc.metaChip}>
              <Ionicons name="school-outline" size={11} color={COLORS.gray500} />
              <Text style={rc.metaText}>{item.className}</Text>
            </View>
          )}
          {!!item.academicYear && (
            <View style={rc.metaChip}>
              <Ionicons name="calendar-outline" size={11} color={COLORS.gray500} />
              <Text style={rc.metaText}>{item.academicYear}</Text>
            </View>
          )}
          {!!item.term && (
            <View style={rc.metaChip}>
              <Ionicons name="layers-outline" size={11} color={COLORS.gray500} />
              <Text style={rc.metaText}>{item.term}</Text>
            </View>
          )}
        </View>

        {/* Stats */}
        <View style={rc.statsRow}>
          <View style={rc.statItem}>
            <Text style={[rc.statVal, { color: passColor }]}>
              {pct.toFixed(1)}%
            </Text>
            <Text style={rc.statLbl}>Score</Text>
          </View>

          <View style={rc.statItem}>
            <Text style={[rc.statVal, { color: COLORS.primary }]}>
              {item.overallGrade || "—"}
            </Text>
            <Text style={rc.statLbl}>Grade</Text>
          </View>

          {item.classPosition != null && (
            <View style={rc.statItem}>
              <Text style={[rc.statVal, { color: COLORS.warning }]}>
                #{item.classPosition}
                {item.totalInClass ? `/${item.totalInClass}` : ""}
              </Text>
              <Text style={rc.statLbl}>Position</Text>
            </View>
          )}

          <View style={[rc.passPill, { backgroundColor: passBg }]}>
            <Text style={[rc.passText, { color: passColor }]}>
              {isPassing ? "PASS" : "FAIL"}
            </Text>
          </View>
        </View>
      </View>

      <Ionicons name="chevron-forward" size={18} color={COLORS.gray400} />
    </TouchableOpacity>
  );
};

const rc = StyleSheet.create({
  card: {
    flexDirection:  "row",
    alignItems:     "center",
    backgroundColor: COLORS.white,
    borderRadius:   14,
    marginBottom:   10,
    borderWidth:    1,
    borderColor:    COLORS.gray200,
    overflow:       "hidden",
    shadowColor:    "#000",
    shadowOpacity:  0.04,
    shadowRadius:   6,
    elevation:      2,
  },
  accent:   { width: 4, alignSelf: "stretch" },
  body:     { flex: 1, padding: 14 },
  examName: {
    fontSize:     15,
    fontWeight:   "700",
    color:        COLORS.gray900,
    marginBottom: 6,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           6,
    marginBottom:  10,
  },
  metaChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   COLORS.gray50,
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  metaText: { fontSize: 11, color: COLORS.gray500 },
  statsRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           14,
    flexWrap:      "wrap",
  },
  statItem: { alignItems: "center" },
  statVal:  { fontSize: 16, fontWeight: "800" },
  statLbl:  {
    fontSize:      9,
    color:         COLORS.gray400,
    fontWeight:    "600",
    textTransform: "uppercase",
  },
  passPill: {
    marginLeft:        "auto",
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  passText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentResultsListScreen() {
  const user      = useAuthStore((s) => s.user);
  const userId    = user?._id || user?.id || user?.userId;
  const schoolId  = user?.schoolId;

  const [results,    setResults]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [source,     setSource]     = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!userId) {
      setError("Could not identify your account");
      setLoading(false);
      return;
    }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const { results: data, source: src } = await fetchMyResults(userId, schoolId);
      setResults(data);
      setSource(src);
    } catch (err) {
      console.error("[StudentResults] load error:", err.message);
      setError("Failed to load results. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, schoolId]);

  useEffect(() => { load(); }, [load]);

  const goToDetail = useCallback((item) => {
    router.push({
      pathname: `/student/results/${item.examId}`,
      params:   { studentId: item.studentId },
    });
  }, []);

  // ── Loading ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading your results…</Text>
      </View>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>My Results</Text>
          <Text style={styles.headerSub}>
            {results.length > 0
              ? `${results.length} exam result${results.length !== 1 ? "s" : ""}`
              : "No published results yet"}
          </Text>
        </View>
      </View>

      {/* Error */}
      {!!error && (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => load()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <FlatList
        data={results}
        keyExtractor={(item, i) => String(item._id || item.examId || i)}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
        ListEmptyComponent={
          !error ? (
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={56} color={COLORS.gray200} />
              <Text style={styles.emptyTitle}>No Results Yet</Text>
              <Text style={styles.emptySub}>
                Your results will appear here once your teacher publishes them.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ResultPreviewCard item={item} onPress={() => goToDetail(item)} />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.gray50 },
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: COLORS.gray50,
    gap:             12,
  },
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
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: COLORS.gray900 },
  headerSub:    { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  errorBox: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    backgroundColor: "#FEF2F2",
    margin:          16,
    borderRadius:    10,
    padding:         12,
  },
  errorText: { flex: 1, fontSize: 13, color: COLORS.error },
  retryText: { fontSize: 13, fontWeight: "700", color: COLORS.primary },
  list:  { padding: 16, paddingBottom: 40 },
  empty: {
    alignItems:      "center",
    paddingTop:      60,
    gap:             10,
    paddingHorizontal: 24,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: COLORS.gray700 },
  emptySub: {
    fontSize:   13,
    color:      COLORS.gray400,
    textAlign:  "center",
    lineHeight: 20,
  },
});