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
import { StatTile, tileShell } from "../../../../../src/components/Tiles";
import { COLORS as THEME, ACCENT, SEMANTIC } from "../../../../../src/theme/colors";
import { HeaderIcon, IconSquare, EmptyState } from "../../../../../src/components/Tinted";
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
                />
                <QuickStatCard
                  icon="checkmark-circle"
                  label={t("examResults.passed")}
                  tone="success"
                  value={stats.passed ?? 0}
                />
                <QuickStatCard
                  icon="close-circle"
                  label={t("examResults.failed")}
                  tone="error"
                  value={stats.failed ?? 0}
                />
                <QuickStatCard
                  icon="trending-up"
                  label={t("examResults.passPct")}
                  value={`${stats.passRate ?? 0}%`}
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
              <EmptyState
                icon="bar-chart-outline"
                accent="slate"
                title={t("exams.noResultsYet")}
                message={t("examResults.emptySubtitle")}
                style={styles.emptyState}
              />
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
          <Ionicons name="arrow-back" size={24} color={THEME.text} />
        </TouchableOpacity>

        <HeaderIcon icon="stats-chart" accent="slate" />
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
          <Ionicons name="alert-circle-outline" size={16} color={SEMANTIC.error.icon} />
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

// Total and pass rate are plain results cards; Passed and Failed keep the
// status colour that is their meaning.
function QuickStatCard({ icon, label, value, tone }) {
  return <StatTile kind="results" tone={tone} icon={icon} value={value} label={label} />;
}

/** A mark out of twenty, as every analytics figure is printed. */
const on20 = (v) => (v == null ? "—" : `${Number(v).toFixed(2)}/20`);

function StatsView({ stats }) {
  const { t, language } = useTranslation();

  if (!stats) {
    return (
      <EmptyState
        icon="analytics-outline"
        accent="slate"
        title={t("examResults.noStats")}
        message={t("examResults.noStatsSub")}
        style={styles.emptyStats}
      />
    );
  }

  return (
    <View style={{ gap: 16 }}>

      {/* Performance overview */}
      <View style={styles.statsSection}>
        <View style={styles.sectionTitleRow}>
          <IconSquare icon="speedometer" accent="slate" size={28} />
          <Text style={styles.sectionTitle}>
            {t("examResults.performanceOverview")}
          </Text>
        </View>
        <View style={styles.statsGrid}>
          <StatBox label={t("examResults.students")} value={stats.totalStudents} />
          <StatBox label={t("examResults.passed")} value={stats.passed}  color={SEMANTIC.success.text} />
          <StatBox label={t("examResults.failed")} value={stats.failed}  color={SEMANTIC.error.text}   />
          <StatBox
            label={t("exams.passRate")}
            value={`${stats.passRate?.toFixed(1) ?? 0}%`}
            color={(stats.passRate ?? 0) >= 50 ? SEMANTIC.success.text : SEMANTIC.error.text}
          />
          {/* On /20 (shared/examAnalytics on the server) — no percentages, no GPA. */}
          <StatBox label={t("results.average")} value={on20(stats.average)} />
          <StatBox label={t("results.highest")} value={on20(stats.highest)} color={SEMANTIC.success.text} />
          <StatBox label={t("results.lowest")}  value={on20(stats.lowest)}  color={SEMANTIC.error.text}   />
        </View>
      </View>

      {/* Pupils per band of the school's own remark scale, highest first */}
      {(stats.remarkDistribution ?? []).some((b) => b.count > 0) && (
          <View style={styles.statsSection}>
            <View style={styles.sectionTitleRow}>
              <IconSquare icon="podium" accent="slate" size={28} />
              <Text style={styles.sectionTitle}>
                {t("results.remarkDistribution")}
              </Text>
            </View>
            <View style={styles.gradeDistContainer}>
              {stats.remarkDistribution
                .map((band) => {
                  const countNum   = Number(band.count) || 0;
                  const total      = stats.totalStudents || 1;
                  const pct        = countNum > 0 ? Math.max((countNum / total) * 100, 4) : 0;
                  const widthStyle = `${pct}%`;
                  const label      = (String(language).startsWith("fr") ? band.remarkFr : band.remark) || band.remark || "—";

                  return (
                    <View key={`${band.minMark}-${band.maxMark}`} style={styles.gradeDistRow}>
                      <Text style={[styles.gradeDistLabel, { width: 110 }]} numberOfLines={1}>{label}</Text>
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
          <View style={styles.sectionTitleRow}>
            <IconSquare icon="book" accent="slate" size={28} />
            <Text style={styles.sectionTitle}>{t("results.bySubject")}</Text>
          </View>
          {stats.subjectStats.map((sub) => (
            <View
              key={sub.subjectId ?? sub.subjectName}
              style={styles.subjectStatRow}
            >
              <Text style={styles.subjectStatName} numberOfLines={1}>
                {sub.subjectName}
              </Text>
              <Text style={styles.subjectStatAvg}>
                {on20(sub.average)}
              </Text>
              <Text
                style={[
                  styles.subjectStatPass,
                  {
                    color:
                      (sub.passRate ?? 0) >= 50
                        ? SEMANTIC.success.text
                        : SEMANTIC.error.text,
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
  screen: { flex: 1, backgroundColor: THEME.page },

  // Header
  screenHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: THEME.page,
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     8,
  },
  screenTitle: {
    flex:       1,
    fontSize:   20,
    fontWeight: "700",
    color:      THEME.text,
  },
  refreshBtn: { padding: 8 },

  // Error banner
  errorBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   SEMANTIC.error.bg,
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.error.box,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text },
  retryText: { fontSize: 13, fontWeight: "700", color: SEMANTIC.error.text },

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
  loadingText:      { fontSize: 14, color: THEME.textSecondary },

  // Empty state
  emptyState: {
    alignItems:        "center",
    paddingVertical:   48,
    gap:               12,
  },

  // Quick stat cards
  quickStats: {
    flexDirection:  "row",
    justifyContent: "space-between",
    gap:            8,
  },

  // Stats section
  statsSection: {
    backgroundColor: THEME.surface,
    borderRadius:    16,
    padding:         16,
    borderWidth:     1,
    borderColor:     THEME.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.slate.base,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sectionTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        THEME.text,
  },
  statsGrid:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statBox: {
    width:           "30%",
    borderWidth:     1,
    ...tileShell("results"),
    borderRadius:    10,
    padding:         12,
    alignItems:      "center",
  },
  statBoxValue: { fontSize: 18, fontWeight: "800", color: ACCENT.slate.deep },
  statBoxLabel: {
    fontSize:  11,
    color:     THEME.textSecondary,
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
    color:      THEME.text,
    textAlign:  "center",
  },
  gradeDistBarBg: {
    flex:            1,
    height:          24,
    backgroundColor: ACCENT.slate.wash,
    borderRadius:    6,
    overflow:        "hidden",
  },
  gradeDistBar: {
    height:          "100%",
    backgroundColor: ACCENT.slate.solid,
    borderRadius:    6,
    minWidth:        20,
  },
  gradeDistCount: {
    width:      30,
    fontSize:   14,
    fontWeight: "600",
    color:      ACCENT.slate.deep,
    textAlign:  "right",
  },

  // Subject performance
  subjectStatRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  subjectStatName: { flex: 1, fontSize: 13, color: THEME.text },
  subjectStatAvg: {
    fontSize:    13,
    fontWeight:  "700",
    color:       ACCENT.slate.deep,
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
});