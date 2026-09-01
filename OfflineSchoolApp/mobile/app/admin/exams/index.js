// app/admin/exams/index.js
"use strict";

import React, {
  useState, useEffect, useCallback, useMemo,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar, Alert,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { ExamService }  from "../../../src/services/exam.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

// Object keys are the stored status/type values and must not change - only the
// labels are localised.
const STATUS_META = {
  draft:     { color: "#6B7280", bg: "#F3F4F6", labelKey: "examStatus.draft"     },
  scheduled: { color: "#4F46E5", bg: "#EEF2FF", labelKey: "examStatus.scheduled" },
  ongoing:   { color: "#D97706", bg: "#FEF3C7", labelKey: "examStatus.ongoing"   },
  completed: { color: "#059669", bg: "#ECFDF5", labelKey: "examStatus.completed" },
  published: { color: "#7C3AED", bg: "#F5F3FF", labelKey: "examStatus.published" },
  archived:  { color: "#9CA3AF", bg: "#F9FAFB", labelKey: "examStatus.archived"  },
};

const EXAM_TYPE_KEYS = {
  test:               "examType.test",
  practical:          "examType.practical",
  promotion_exam:     "examType.promotion_exam",
};

/** Localised exam-type label, falling back to the raw stored value. */
const examTypeLabel = (t, type) =>
  EXAM_TYPE_KEYS[type] ? t(EXAM_TYPE_KEYS[type]) : (type || "");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const safe = (val, fallback = "") => {
  if (val == null)              return fallback;
  if (typeof val === "boolean") return fallback;
  if (typeof val === "object")  return fallback;
  const s = String(val).trim();
  return s || fallback;
};

const joinMeta = (parts, sep = " · ") =>
  parts.map((p) => safe(p)).filter(Boolean).join(sep);

// ─────────────────────────────────────────────────────────
// STAT CARD
// ─────────────────────────────────────────────────────────

const StatCard = ({ label, value, color, icon, onPress }) => (
  <TouchableOpacity
    style={[sc.card, { borderLeftColor: color, borderLeftWidth: 3 }]}
    onPress={onPress}
    activeOpacity={onPress ? 0.7 : 1}
  >
    <View style={[sc.iconBox, { backgroundColor: color + "15" }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={[sc.value, { color }]}>{safe(value, "0")}</Text>
    <Text style={sc.label}>{label}</Text>
  </TouchableOpacity>
);

const sc = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    alignItems:      "center",
    gap:             6,
    flex:            1,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  iconBox: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  value: { fontSize: 22, fontWeight: "800" },
  label: {
    fontSize:      10,
    color:         "#6B7280",
    fontWeight:    "600",
    textTransform: "uppercase",
    textAlign:     "center",
  },
});

// ─────────────────────────────────────────────────────────
// EXAM CARD
// ─────────────────────────────────────────────────────────

const ExamCard = ({ exam, onPress, onStatusChange, onViewResults }) => {
  const { t }     = useTranslation();
  const status    = safe(exam.status, "draft");
  const meta      = STATUS_META[status] || STATUS_META.draft;
  const typeLabel = safe(examTypeLabel(t, exam.type));
  const examName  = safe(exam.name, t("examsDash.untitledExam"));
  const className = safe(exam.className || exam.class_name);
  const startDate = safe(exam.startDate || exam.start_date);
  const endDate   = safe(exam.endDate   || exam.end_date);
  const hasResults = status === "completed" || status === "published";

  const subLine = joinMeta([
    typeLabel,
    exam.academicYear || exam.academic_year,
    exam.term,
  ]);

  const hasDate  = startDate || endDate;
  const dateLine = hasDate
    ? `${startDate || "—"} → ${endDate || "—"}`
    : null;

  return (
    <TouchableOpacity
      style={ec.card}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={ec.top}>
        <View style={ec.info}>
          <Text style={ec.name} numberOfLines={1}>{examName}</Text>
          {!!subLine  && <Text style={ec.sub} numberOfLines={1}>{subLine}</Text>}
          {!!className && <Text style={ec.cls} numberOfLines={1}>{className}</Text>}
        </View>
        <View style={[ec.badge, { backgroundColor: meta.bg }]}>
          <Text style={[ec.badgeText, { color: meta.color }]}>{t(meta.labelKey)}</Text>
        </View>
      </View>

      {!!dateLine && (
        <View style={ec.dateRow}>
          <Ionicons name="calendar-outline" size={12} color="#9CA3AF" />
          <Text style={ec.dateText}>{dateLine}</Text>
        </View>
      )}

      {!!exam.resultsPublished && (
        <View style={ec.publishedBadge}>
          <Ionicons name="checkmark-circle" size={12} color="#7C3AED" />
          <Text style={ec.publishedText}>{t("examsDash.resultsPublished")}</Text>
        </View>
      )}

      <View style={ec.actions}>
        <TouchableOpacity
          style={ec.actionBtn}
          onPress={() => onStatusChange(exam)}
          activeOpacity={0.7}
        >
          <Ionicons name="swap-horizontal-outline" size={14} color="#4F46E5" />
          <Text style={ec.actionText}>{t("common.status")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={ec.actionBtn}
          onPress={onPress}
          activeOpacity={0.7}
        >
          <Ionicons name="eye-outline" size={14} color="#059669" />
          <Text style={[ec.actionText, { color: "#059669" }]}>{t("common.view")}</Text>
        </TouchableOpacity>

        {hasResults && (
          <TouchableOpacity
            style={[ec.actionBtn, ec.resultsBtn]}
            onPress={() => onViewResults(exam)}
            activeOpacity={0.7}
          >
            <Ionicons name="trophy-outline" size={14} color="#2563EB" />
            <Text style={[ec.actionText, { color: "#2563EB" }]}>{t("examsDash.rankings")}</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
};

const ec = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  top:       { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  info:      { flex: 1, marginRight: 10 },
  name:      { fontSize: 15, fontWeight: "700", color: "#111827" },
  sub:       { fontSize: 12, color: "#6B7280", marginTop: 3 },
  cls:       { fontSize: 12, color: "#4F46E5", fontWeight: "600", marginTop: 2 },
  badge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  dateRow:   { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  dateText:  { fontSize: 12, color: "#9CA3AF" },
  publishedBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   "#F5F3FF",
    alignSelf:         "flex-start",
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
    marginBottom:      8,
  },
  publishedText: { fontSize: 10, fontWeight: "600", color: "#7C3AED" },
  actions: {
    flexDirection:  "row",
    gap:            12,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
    paddingTop:     10,
    alignItems:     "center",
  },
  actionBtn:  { flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { fontSize: 12, color: "#4F46E5", fontWeight: "600" },
  resultsBtn: {
    marginLeft:        "auto",
    backgroundColor:   "#EFF6FF",
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      8,
  },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ExamsDashboardScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [dashboard,  setDashboard]  = useState(null);
  const [exams,      setExams]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab,  setActiveTab]  = useState("all");

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const [dashRes, examRes] = await Promise.all([
        ExamService.getDashboard(schoolId),
        ExamService.getExams({ schoolId }),
      ]);

      setDashboard(dashRes?.dashboard || null);

      const raw  = examRes?.exams || examRes?.data || [];
      const list = Array.isArray(raw) ? raw : [];
      setExams(list);
    } catch (err) {
      console.error("ExamsDashboard load failed:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = useMemo(() =>
    activeTab === "all"
      ? exams
      : exams.filter((e) => (e.status || "draft") === activeTab),
    [exams, activeTab]
  );

  const counts = useMemo(() => ({
    completedOrPublished: exams.filter(
      (e) => e.status === "completed" || e.status === "published"
    ).length,
    pendingResults: exams.filter(
      (e) => e.status === "completed" && !e.resultsPublished
    ).length,
  }), [exams]);

  const handleStatusChange = useCallback((exam) => {
    const currentStatus = safe(exam.status, "draft");
    const currentLabel = STATUS_META[currentStatus]?.labelKey
      ? t(STATUS_META[currentStatus].labelKey)
      : currentStatus;
    Alert.alert(
      t("examsDash.changeStatus"),
      t("examsDash.currentStatus", { status: currentLabel }),
      [
        ...Object.entries(STATUS_META)
          .filter(([s]) => s !== currentStatus)
          .map(([s, m]) => ({
            text:    t(m.labelKey),
            onPress: async () => {
              try {
                await ExamService.updateExamStatus(exam._id || exam.id, s, schoolId);
                loadData(true);
              } catch (err) {
                Alert.alert(t("examsDash.errTitle"), errorText(t, err, "examsDash.errStatusUpdate"));
              }
            },
          })),
        { text: t("common.cancel"), style: "cancel" },
      ]
    );
  }, [schoolId, loadData, t]);

  const handleViewResults = useCallback((exam) => {
    router.push({
      pathname: "/admin/exams/results/[examId]",
      params:   { examId: String(exam._id || exam.id) },
    });
  }, [router]);

  const handleResultsQuickAction = useCallback(() => {
    router.push("/admin/reports");
  }, [router]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("examsDash.loading")}</Text>
      </View>
    );
  }

  const d = dashboard?.exams || {};

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("examsDash.title")}</Text>
          <Text style={styles.headerSub}>
            {safe(d.total, "0")} exam{d.total !== 1 ? "s" : ""} total
          </Text>
        </View>
        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => router.push("/admin/exams/create")}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={20} color="#FFF" />
          <Text style={styles.createBtnText}>{t("examsDash.new")}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statsRow}>
            <StatCard label={t("examStatus.draft")}     value={d.draft     ?? 0} color="#6B7280" icon="document-outline"          onPress={() => setActiveTab("draft")}     />
            <StatCard label={t("examStatus.scheduled")} value={d.scheduled ?? 0} color="#4F46E5" icon="calendar-outline"          onPress={() => setActiveTab("scheduled")} />
            <StatCard label={t("examStatus.ongoing")}   value={d.ongoing   ?? 0} color="#D97706" icon="time-outline"              onPress={() => setActiveTab("ongoing")}   />
          </View>
          <View style={styles.statsRow}>
            <StatCard label={t("examStatus.completed")} value={d.completed ?? 0} color="#059669" icon="checkmark-circle-outline"  onPress={() => setActiveTab("completed")} />
            <StatCard label={t("examStatus.published")} value={d.published ?? 0} color="#7C3AED" icon="megaphone-outline"         onPress={() => setActiveTab("published")} />
            <StatCard label={t("common.total")}     value={d.total     ?? 0} color="#111827" icon="list-outline"              onPress={() => setActiveTab("all")}       />
          </View>
        </View>

        {/* Results overview */}
        {!!dashboard?.results && (
          <View style={styles.resultsCard}>
            <View style={styles.resultsCardHeader}>
              <Text style={styles.sectionTitle}>{t("examsDash.resultsOverview")}</Text>
              {counts.completedOrPublished > 0 && (
                <TouchableOpacity
                  style={styles.viewAllBtn}
                  onPress={() => router.push("/admin/reports")}
                  activeOpacity={0.7}
                >
                  <Text style={styles.viewAllText}>{t("examsDash.viewReports")}</Text>
                  <Ionicons name="chevron-forward" size={14} color="#2563EB" />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.resultsPills}>
              {[
                { label: "Published", val: dashboard.results.published,          color: "#7C3AED" },
                { id: "pending",  label: t("common.pending"),          val: dashboard.results.pending,       color: "#D97706" },
                { id: "missing",  label: t("examsDash.missing"),       val: dashboard.results.missingGrades, color: "#DC2626" },
                { id: "avg",      label: t("examsDash.avgScore"),      val: `${dashboard.results.averagePerformance ?? 0}%`, color: "#059669" },
                { id: "passRate", label: t("examsDash.passRate"),      val: `${dashboard.results.passRate ?? 0}%`,           color: "#4F46E5" },
              ].map((p) => (
                <View
                  key={p.id}
                  style={[styles.pill, { backgroundColor: p.color + "10" }]}
                >
                  <Text style={[styles.pillVal, { color: p.color }]}>
                    {safe(p.val, "—")}
                  </Text>
                  <Text style={styles.pillLbl}>{p.label}</Text>
                </View>
              ))}
            </View>

            {counts.pendingResults > 0 && (
              <TouchableOpacity
                style={styles.pendingAlert}
                onPress={() => setActiveTab("completed")}
                activeOpacity={0.7}
              >
                <Ionicons name="alert-circle-outline" size={16} color="#D97706" />
                <Text style={styles.pendingAlertText}>
                  {counts.pendingResults} completed exam
                  {counts.pendingResults > 1 ? "s" : ""} with unpublished results
                </Text>
                <Ionicons name="chevron-forward" size={14} color="#D97706" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Quick Actions */}
        <View style={styles.quickActions}>
          <Text style={styles.sectionTitle}>{t("examsDash.quickActions")}</Text>
          {[
            {
              id:      "createExam",
              label:   t("examsDash.qaCreate"),
              sub:     t("examsDash.qaCreateSub"),
              icon:    "add-circle-outline",
              color:   "#4F46E5",
              onPress: () => router.push("/admin/exams/create"),
              badge:   null,
            },
            {
              id:      "markEntry",
              label:   t("examsDash.qaMarks"),
              sub:     t("examsDash.qaMarksSub"),
              icon:    "create-outline",
              color:   "#059669",
              onPress: () => router.push("/admin/exams/marks"),
              badge:   null,
            },
            {
              id:      "results",
              label:   t("examsDash.qaResults"),
              sub:     t("examsDash.qaResultsSub"),
              icon:    "trophy-outline",
              color:   "#2563EB",
              onPress: handleResultsQuickAction,
              badge:   counts.completedOrPublished > 0 ? counts.completedOrPublished : null,
            },
            {
              id:      "reportCards",
              label:   t("examsDash.qaReportCards"),
              sub:     t("examsDash.qaReportCardsSub"),
              icon:    "document-text-outline",
              color:   "#D97706",
              onPress: () => router.push("/admin/reports/generate"),
              badge:   null,
            },
            {
              id:      "submissions",
              label:   t("examsDash.qaSubmissions"),
              sub:     t("examsDash.qaSubmissionsSub"),
              icon:    "cloud-upload-outline",
              color:   "#DC2626",
              onPress: () => router.push("/admin/exams/monitor"),
              badge:   null,
            },
          ].map((a) => (
            <TouchableOpacity
              key={a.id}
              style={styles.actionRow}
              onPress={a.onPress}
              activeOpacity={0.7}
            >
              <View style={[styles.actionIcon, { backgroundColor: a.color + "15" }]}>
                <Ionicons name={a.icon} size={20} color={a.color} />
              </View>
              <View style={styles.actionInfo}>
                <Text style={styles.actionLabel}>{a.label}</Text>
                <Text style={styles.actionSub}>{a.sub}</Text>
              </View>
              {a.badge != null && (
                <View style={[styles.actionBadge, { backgroundColor: a.color }]}>
                  <Text style={styles.actionBadgeText}>{safe(a.badge, "")}</Text>
                </View>
              )}
              <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab filter */}
        <View style={styles.tabsRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {[
              { key: "all",       labelKey: "examsDash.tabAll"      },
              { key: "draft",     labelKey: "examStatus.draft"     },
              { key: "scheduled", labelKey: "examStatus.scheduled" },
              { key: "ongoing",   labelKey: "examStatus.ongoing"   },
              { key: "completed", labelKey: "examStatus.completed" },
              { key: "published", labelKey: "examStatus.published" },
            ].map((tab) => (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, activeTab === tab.key && styles.tabActive]}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.tabText,
                  activeTab === tab.key && styles.tabTextActive,
                ]}>
                  {t(tab.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Exam list */}
        <View style={styles.examList}>
          <Text style={styles.sectionTitle}>
            {activeTab === "all"
              ? t("examsDash.allExams")
              : t("examsDash.statusExams", {
                  status: STATUS_META[activeTab]?.labelKey
                    ? t(STATUS_META[activeTab].labelKey)
                    : activeTab,
                })}
            {filtered.length > 0 ? (
              <Text style={styles.count}>{`  (${filtered.length})`}</Text>
            ) : null}
          </Text>

          {filtered.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="document-outline" size={48} color="#D1D5DB" />
              <Text style={styles.emptyTitle}>{t("examsDash.noneFound")}</Text>
              <Text style={styles.emptySub}>{t("examsDash.noneFoundHint")}</Text>
              <TouchableOpacity
                style={styles.emptyBtn}
                onPress={() => router.push("/admin/exams/create")}
                activeOpacity={0.7}
              >
                <Text style={styles.emptyBtnText}>{t("examsDash.qaCreate")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            filtered.map((exam) => (
              <ExamCard
                key={String(exam._id || exam.id)}
                exam={exam}
                onPress={() =>
                  router.push({
                    pathname: "/admin/exams/[id]",
                    params:   { id: String(exam._id || exam.id) },
                  })
                }
                onStatusChange={handleStatusChange}
                onViewResults={handleViewResults}
              />
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
    gap:             12,
  },
  loadingText: { color: "#6B7280", fontSize: 14 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:  { flex: 1, marginLeft: 12 },
  headerTitle:   { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:     { fontSize: 12, color: "#6B7280", marginTop: 2 },
  createBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   8,
    paddingHorizontal: 14,
  },
  createBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
  scroll:        { padding: 16 },
  statsGrid:     { gap: 8, marginBottom: 16 },
  statsRow:      { flexDirection: "row", gap: 8 },
  resultsCard: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  resultsCardHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   8,
  },
  viewAllBtn:  { flexDirection: "row", alignItems: "center", gap: 2 },
  viewAllText: { fontSize: 12, fontWeight: "600", color: "#2563EB" },
  resultsPills: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  pill: {
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
    alignItems:        "center",
    minWidth:          60,
  },
  pillVal: { fontSize: 14, fontWeight: "800" },
  pillLbl: {
    fontSize:      9,
    color:         "#6B7280",
    fontWeight:    "600",
    textTransform: "uppercase",
  },
  pendingAlert: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    backgroundColor: "#FEF3C7",
    borderRadius:    8,
    padding:         10,
    marginTop:       12,
  },
  pendingAlertText: { fontSize: 12, color: "#D97706", fontWeight: "500", flex: 1 },
  quickActions: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  actionRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
    gap:               12,
  },
  actionIcon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  actionInfo:      { flex: 1 },
  actionLabel:     { fontSize: 14, fontWeight: "600", color: "#111827" },
  actionSub:       { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  actionBadge: {
    borderRadius:      10,
    paddingHorizontal: 8,
    paddingVertical:   2,
    marginRight:       4,
  },
  actionBadgeText: { fontSize: 11, fontWeight: "700", color: "#FFF" },
  tabsRow:         { marginBottom: 12 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      20,
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    marginRight:       8,
  },
  tabActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  tabText:       { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  tabTextActive: { color: "#FFF" },
  examList:      { gap: 0 },
  sectionTitle: {
    fontSize:     15,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 12,
  },
  count: { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },
  empty: { alignItems: "center", paddingVertical: 60, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#374151" },
  emptySub:   { fontSize: 13, color: "#9CA3AF" },
  emptyBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         8,
  },
  emptyBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});