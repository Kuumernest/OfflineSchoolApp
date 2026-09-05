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
import { useTranslation } from "../../../src/i18n/useTranslation";

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

/**
 * Fetch all published exams for this school, then for each exam
 * try to get this student's result using your existing service pattern:
 *   GET /results/:examId/student/:studentId
 *
 * This matches your results.service.js → getStudentResult()
 */
const fetchMyResults = async (userId, schoolId) => {
  // One request, server-scoped to this pupil.
  //
  // What was here walked every published exam and, for each, tried every id
  // this account might answer to — a request per exam per candidate. All of
  // them 403'd, because a student holds neither exams.view nor results.view,
  // and the loop treated 403 as "not this one" and carried on. So the screen
  // reported no results rather than no permission, which is the hardest kind
  // of bug to be told about.
  const { results, isStale } = await ExamService.getMyResults(schoolId);

  return {
    results,
    source: isStale ? "cache" : "api",
    isStale,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// RESULT CARD
// ─────────────────────────────────────────────────────────────────────────────

const ResultPreviewCard = ({ item, onPress }) => {
  const { t } = useTranslation();
  const isPassing = item.isPassing ?? (item.percentage >= 50);
  const passColor = isPassing ? COLORS.success : COLORS.error;
  const passBg    = isPassing ? COLORS.successBg : COLORS.errorBg;
  const pct       = typeof item.percentage === "number" ? item.percentage : 0;

  return (
    <TouchableOpacity style={rc.card} onPress={onPress} activeOpacity={0.7}>
      <View style={[rc.accent, { backgroundColor: passColor }]} />

      <View style={rc.body}>
        <Text style={rc.examName} numberOfLines={1}>
          {item.examName || t("results.my.examFallback")}
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
            <Text style={rc.statLbl}>{t("results.my.scoreStat")}</Text>
          </View>

          <View style={rc.statItem}>
            <Text style={[rc.statVal, { color: COLORS.primary }]}>
              {item.overallGrade || "—"}
            </Text>
            <Text style={rc.statLbl}>{t("results.my.gradeStat")}</Text>
          </View>

          {item.classPosition != null && (
            <View style={rc.statItem}>
              <Text style={[rc.statVal, { color: COLORS.warning }]}>
                #{item.classPosition}
                {item.totalInClass ? `/${item.totalInClass}` : ""}
              </Text>
              <Text style={rc.statLbl}>{t("results.my.positionStat")}</Text>
            </View>
          )}

          <View style={[rc.passPill, { backgroundColor: passBg }]}>
            <Text style={[rc.passText, { color: passColor }]}>
              {isPassing ? t("results.my.passPill") : t("results.my.failPill")}
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
  const { t }     = useTranslation();

  const [results,    setResults]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [source,     setSource]     = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!userId) {
      setError(t("results.my.accountError"));
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
      setError(t("results.my.loadError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, schoolId, t]);

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
        <Text style={styles.loadingText}>{t("results.my.loadingList")}</Text>
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
          <Text style={styles.headerTitle}>{t("results.my.myResults")}</Text>
          <Text style={styles.headerSub}>
            {results.length > 0
              ? results.length === 1
                ? t("results.my.oneExamResult")
                : t("results.my.manyExamResults", { count: results.length })
              : t("results.my.noPublished")}
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
              <Text style={styles.emptyTitle}>{t("results.noneCompleted")}</Text>
              <Text style={styles.emptySub}>
                {t("results.my.noPublished")}
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