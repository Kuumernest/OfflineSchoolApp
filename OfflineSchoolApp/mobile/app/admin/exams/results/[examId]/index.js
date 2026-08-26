// app/admin/exams/results/[examId]/index.js
"use strict";

import React, {
  useEffect,
  useState,
  useCallback,
} from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons }                     from "@expo/vector-icons";

import { useResultsStore }   from "../../../../../src/store/results.store";
import { useAuthStore }      from "../../../../../src/store/auth.store";
import { useTranslation }    from "../../../../../src/i18n/useTranslation";
import ResultsProcessingCard from "../../../components/ResultsProcessingCard";
import RankingsTable         from "../../../components/RankingsTable";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  warning:   "#D97706",
  error:     "#DC2626",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

const TABS = [
  { key: "overview", labelKey: "examResults.tabs.overview", icon: "grid-outline"      },
  { key: "class",    labelKey: "examResults.tabs.class",    icon: "people-outline"    },
  { key: "grade",    labelKey: "examResults.tabs.grade",    icon: "school-outline"    },
  { key: "school",   labelKey: "examResults.tabs.school",   icon: "trophy-outline"    },
  { key: "stats",    labelKey: "examResults.tabs.stats",    icon: "bar-chart-outline" },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function ExamResultsScreen() {
  const { examId } = useLocalSearchParams();
  const { t }      = useTranslation();

  const schoolId = useAuthStore((s) => s.user?.schoolId ?? null);

  const results      = useResultsStore((s) => s.results);
  const rankings     = useResultsStore((s) => s.rankings);
  const stats        = useResultsStore((s) => s.stats);
  const loading      = useResultsStore((s) => s.loading);
  const error        = useResultsStore((s) => s.error);
  const fetchResults = useResultsStore((s) => s.fetchResults);
  const clearResults = useResultsStore((s) => s.clearResults);

  const [activeTab,  setActiveTab]  = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!examId) return;
    await fetchResults(examId, { schoolId });
  }, [examId, schoolId, fetchResults]);

  useEffect(() => {
    fetchData();
    return () => { clearResults(); };
  }, [fetchData, clearResults]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  // ── Navigate to student report card ──────────────────────────────────────
  const handleStudentPress = useCallback(
    (student) => {
      const sid =
        student?.studentId   ||
        student?._id         ||
        student?.id          ||
        student?.student?._id;

      if (!sid) {
        console.warn("[ExamResults] No studentId found on:", student);
        return;
      }

      router.push({
        pathname: "/admin/exams/results/[examId]/student/[studentId]",
        params:   { examId, studentId: sid },
      });
    },
    [examId]
  );

  const handleProcessed = useCallback(() => fetchData(), [fetchData]);

  // ─────────────────────────────────────────────────────────────────────────
  // TAB CONTENT
  // ─────────────────────────────────────────────────────────────────────────

  const renderContent = () => {
    switch (activeTab) {

      case "overview":
        return (
          <View style={{ gap: 16 }}>
            <ResultsProcessingCard
              examId={examId}
              onProcessed={handleProcessed}
            />

            {stats && (
              <View style={styles.quickStats}>
                <QuickStatCard
                  icon="people"
                  label={t("common.total")}
                  value={stats.totalStudents ?? 0}
                  color={COLORS.primary}
                />
                <QuickStatCard
                  icon="checkmark-circle"
                  label={t("examResults.passed")}
                  value={stats.passed ?? 0}
                  color={COLORS.success}
                />
                <QuickStatCard
                  icon="close-circle"
                  label={t("examResults.failed")}
                  value={stats.failed ?? 0}
                  color={COLORS.error}
                />
                <QuickStatCard
                  icon="trending-up"
                  label={t("examResults.passPct")}
                  value={`${stats.passRate ?? 0}%`}
                  color={COLORS.warning}
                />
              </View>
            )}

            {rankings.class?.length > 0 && (
              <RankingsTable
                title={t("examResults.top5Class")}
                rankings={rankings.class.slice(0, 5)}
                scope="class"
                onStudentPress={handleStudentPress}
              />
            )}

            {!loading && results.length === 0 && (
              <View style={styles.emptyState}>
                <Ionicons
                  name="bar-chart-outline"
                  size={48}
                  color={COLORS.gray200}
                />
                <Text style={styles.emptyTitle}>
                  {t("exams.noResultsYet")}
                </Text>
                <Text style={styles.emptySubtitle}>
                  {t("examResults.emptySubtitle")}
                </Text>
              </View>
            )}
          </View>
        );

      case "class":
        return (
          <RankingsTable
            title={t("examResults.classRankings")}
            rankings={rankings.class ?? []}
            scope="class"
            onStudentPress={handleStudentPress}
          />
        );

      case "grade":
        return (
          <RankingsTable
            title={t("examResults.gradeRankings")}
            rankings={rankings.grade ?? []}
            scope="grade"
            onStudentPress={handleStudentPress}
          />
        );

      case "school":
        return (
          <RankingsTable
            title={t("examResults.schoolRankings")}
            rankings={rankings.school ?? []}
            scope="school"
            onStudentPress={handleStudentPress}
          />
        );

      case "stats":
        return <StatsView stats={stats} />;

      default:
        return null;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.screen}>

      {/* ── Header ── */}
      <View style={styles.screenHeader}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
        </TouchableOpacity>

        <Text style={styles.screenTitle}>{t("examResults.title")}</Text>

        <TouchableOpacity
          onPress={onRefresh}
          style={styles.refreshBtn}
          disabled={refreshing}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={COLORS.primary} />
          ) : (
            <Ionicons name="refresh" size={22} color={COLORS.primary} />
          )}
        </TouchableOpacity>
      </View>

      {/* ── Error banner ── */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
          <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
          <TouchableOpacity onPress={fetchData}>
            <Text style={styles.retryText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Tab bar ── */}
      <View style={styles.tabBarWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.activeTab]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={tab.icon}
                size={16}
                color={activeTab === tab.key ? COLORS.primary : COLORS.gray500}
              />
              <Text
                style={[
                  styles.tabLabel,
                  activeTab === tab.key && styles.activeTabLabel,
                ]}
              >
                {t(tab.labelKey)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* ── Main content ── */}
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
      >
        {loading && !refreshing ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>{t("examResults.loading")}</Text>
          </View>
        ) : (
          renderContent()
        )}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function QuickStatCard({ icon, label, value, color }) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconBg, { backgroundColor: color + "18" }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={styles.statCardValue}>{value}</Text>
      <Text style={styles.statCardLabel}>{label}</Text>
    </View>
  );
}

function StatsView({ stats }) {
  const { t } = useTranslation();

  if (!stats) {
    return (
      <View style={styles.emptyStats}>
        <Ionicons name="analytics-outline" size={48} color={COLORS.gray200} />
        <Text style={styles.emptyText}>{t("examResults.noStats")}</Text>
        <Text style={styles.emptySubtitle}>
          {t("examResults.noStatsSub")}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>

      {/* Performance overview */}
      <View style={styles.statsSection}>
        <Text style={styles.sectionTitle}>
          {t("examResults.performanceOverview")}
        </Text>
        <View style={styles.statsGrid}>
          <StatBox label={t("examResults.students")} value={stats.totalStudents} />
          <StatBox label={t("examResults.passed")} value={stats.passed}  color={COLORS.success} />
          <StatBox label={t("examResults.failed")} value={stats.failed}  color={COLORS.error}   />
          <StatBox
            label={t("exams.passRate")}
            value={`${stats.passRate?.toFixed(1) ?? 0}%`}
            color={(stats.passRate ?? 0) >= 50 ? COLORS.success : COLORS.error}
          />
          <StatBox label={t("results.average")} value={`${stats.average?.toFixed(1) ?? 0}%`} />
          <StatBox label={t("results.highest")} value={`${stats.highest?.toFixed(1) ?? 0}%`} color={COLORS.success} />
          <StatBox label={t("results.lowest")}  value={`${stats.lowest?.toFixed(1)  ?? 0}%`} color={COLORS.error}   />
          <StatBox label={t("examResults.avgGpa")} value={stats.averageGpa?.toFixed(2)  ?? "—"} />
        </View>
      </View>

      {/* Grade distribution */}
      {stats.gradeDistribution &&
        Object.keys(stats.gradeDistribution).length > 0 && (
          <View style={styles.statsSection}>
            <Text style={styles.sectionTitle}>
              {t("results.gradeDistribution")}
            </Text>
            <View style={styles.gradeDistContainer}>
              {Object.entries(stats.gradeDistribution)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([grade, count]) => {
                  // ✅ FIX: removed `count as number` TypeScript cast —
                  //    this is a plain JS file. `count` is already a number
                  //    from Object.entries(); no cast needed.
                  const countNum   = Number(count) || 0;
                  const total      = stats.totalStudents || 1;
                  const pct        = Math.max((countNum / total) * 100, 4);
                  const widthStyle = `${pct}%`;

                  return (
                    <View key={grade} style={styles.gradeDistRow}>
                      <Text style={styles.gradeDistLabel}>{grade}</Text>
                      <View style={styles.gradeDistBarBg}>
                        <View
                          style={[
                            styles.gradeDistBar,
                            { width: widthStyle },
                          ]}
                        />
                      </View>
                      <Text style={styles.gradeDistCount}>{countNum}</Text>
                    </View>
                  );
                })}
            </View>
          </View>
        )}

      {/* Subject performance */}
      {stats.subjectStats?.length > 0 && (
        <View style={styles.statsSection}>
          <Text style={styles.sectionTitle}>{t("results.bySubject")}</Text>
          {stats.subjectStats.map((sub) => (
            <View
              key={sub.subjectId ?? sub.subjectName}
              style={styles.subjectStatRow}
            >
              <Text style={styles.subjectStatName} numberOfLines={1}>
                {sub.subjectName}
              </Text>
              <Text style={styles.subjectStatAvg}>
                {sub.average?.toFixed(1)}%
              </Text>
              <Text
                style={[
                  styles.subjectStatPass,
                  {
                    color:
                      (sub.passRate ?? 0) >= 50
                        ? COLORS.success
                        : COLORS.error,
                  },
                ]}
              >
                {t("examResults.pctPass", { pct: sub.passRate?.toFixed(0) })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function StatBox({ label, value, color }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statBoxValue, color ? { color } : null]}>
        {value ?? "—"}
      </Text>
      <Text style={styles.statBoxLabel}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.gray50 },

  // Header
  screenHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.gray100,
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     8,
  },
  screenTitle: {
    flex:       1,
    fontSize:   20,
    fontWeight: "700",
    color:      COLORS.gray900,
  },
  refreshBtn: { padding: 8 },

  // Error banner
  errorBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#FEF2F2",
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
    borderBottomWidth: 1,
    borderBottomColor: "#FECACA",
  },
  errorText: { flex: 1, fontSize: 13, color: COLORS.error },
  retryText: { fontSize: 13, fontWeight: "700", color: COLORS.error },

  // Tab bar
  tabBarWrapper: {
    height:            48,
    flexShrink:        0,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  tabBarContent: {
    paddingHorizontal: 12,
    gap:               4,
    alignItems:        "center",
    height:            48,
  },
  tab: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 14,
    paddingVertical:   10,
    borderRadius:      8,
    gap:               6,
  },
  activeTab:      { backgroundColor: COLORS.primaryBg },
  tabLabel:       { fontSize: 13, fontWeight: "500", color: COLORS.gray500 },
  activeTabLabel: { fontSize: 13, fontWeight: "600", color: COLORS.primary },

  // Content
  content:          { flex: 1 },
  contentContainer: { padding: 16, gap: 16, paddingBottom: 40 },

  loadingContainer: { alignItems: "center", paddingTop: 60, gap: 12 },
  loadingText:      { fontSize: 14, color: COLORS.gray500 },

  // Empty state
  emptyState: {
    alignItems:        "center",
    paddingVertical:   48,
    gap:               12,
  },
  emptyTitle: {
    fontSize:   17,
    fontWeight: "600",
    color:      COLORS.gray700,
  },
  emptySubtitle: {
    fontSize:          14,
    color:             COLORS.gray500,
    textAlign:         "center",
    paddingHorizontal: 32,
  },

  // Quick stat cards
  quickStats: {
    flexDirection:  "row",
    justifyContent: "space-between",
    gap:            8,
  },
  statCard: {
    flex:            1,
    backgroundColor: COLORS.white,
    borderRadius:    12,
    padding:         12,
    alignItems:      "center",
    elevation:       1,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    4,
  },
  statIconBg: {
    width:          32,
    height:         32,
    borderRadius:   8,
    justifyContent: "center",
    alignItems:     "center",
    marginBottom:   6,
  },
  statCardValue: { fontSize: 18, fontWeight: "800", color: COLORS.gray900 },
  statCardLabel: { fontSize: 11, color: COLORS.gray500, marginTop: 2 },

  // Stats section
  statsSection: {
    backgroundColor: COLORS.white,
    borderRadius:    16,
    padding:         16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  sectionTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        COLORS.gray900,
    marginBottom: 12,
  },
  statsGrid:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statBox: {
    width:           "30%",
    backgroundColor: COLORS.gray50,
    borderRadius:    10,
    padding:         12,
    alignItems:      "center",
  },
  statBoxValue: { fontSize: 18, fontWeight: "800", color: COLORS.gray900 },
  statBoxLabel: {
    fontSize:  11,
    color:     COLORS.gray500,
    marginTop: 4,
    textAlign: "center",
  },

  // Grade distribution
  gradeDistContainer: { gap: 8 },
  gradeDistRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
  },
  gradeDistLabel: {
    width:      30,
    fontSize:   14,
    fontWeight: "700",
    color:      COLORS.gray700,
    textAlign:  "center",
  },
  gradeDistBarBg: {
    flex:            1,
    height:          24,
    backgroundColor: COLORS.gray100,
    borderRadius:    6,
    overflow:        "hidden",
  },
  gradeDistBar: {
    height:          "100%",
    backgroundColor: COLORS.primary,
    borderRadius:    6,
    minWidth:        20,
  },
  gradeDistCount: {
    width:      30,
    fontSize:   14,
    fontWeight: "600",
    color:      COLORS.gray700,
    textAlign:  "right",
  },

  // Subject performance
  subjectStatRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  subjectStatName: { flex: 1, fontSize: 13, color: COLORS.gray900 },
  subjectStatAvg: {
    fontSize:    13,
    fontWeight:  "700",
    color:       COLORS.gray700,
    marginRight: 12,
  },
  subjectStatPass: {
    fontSize:   12,
    fontWeight: "600",
    width:      60,
    textAlign:  "right",
  },

  // Empty stats
  emptyStats: { alignItems: "center", paddingTop: 60, gap: 12 },
  emptyText:  { fontSize: 15, color: COLORS.gray500 },
});