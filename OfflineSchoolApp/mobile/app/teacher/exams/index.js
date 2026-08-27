// app/teacher/exams/index.js
"use strict";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, ScrollView,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import api              from "../../../src/services/api";
import { getDatabase }  from "../../../src/db/database";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const COLORS = {
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
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

const STATUS_META = {
  pending:   { color: COLORS.warning, bg: COLORS.warningBg, labelKey: "results.pending",   icon: "time-outline"             },
  submitted: { color: COLORS.primary, bg: COLORS.primaryBg, labelKey: "results.submitted", icon: "cloud-upload-outline"     },
  approved:  { color: COLORS.success, bg: COLORS.successBg, labelKey: "results.approved",  icon: "checkmark-circle-outline" },
  rejected:  { color: COLORS.error,   bg: COLORS.errorBg,   labelKey: "results.rejected",  icon: "close-circle-outline"     },
};

const FILTERS = [
  { id: "all",           labelKey: "teacherExams.tabAll",   icon: "apps-outline"             },
  { id: "pending-marks", labelKey: "teacherExams.needsMarks", icon: "create-outline"           },
  { id: "rejected",      labelKey: "results.rejected",    icon: "close-circle-outline"     },
  { id: "submitted",     labelKey: "results.submitted",   icon: "cloud-upload-outline"     },
  { id: "approved",      labelKey: "results.approved",    icon: "checkmark-circle-outline" },
];

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const toStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v._id || v.id || "").trim();
  return String(v).trim();
};

const extractTeacherId = (sub) =>
  toStr(sub.teacherId) ||
  toStr(sub.teacher)   ||
  toStr(sub.createdBy) ||
  "";

// ─────────────────────────────────────────────────────────
// Fetch submissions OR scores for an exam.
// Tries /submissions first, falls back to /scores.
// ─────────────────────────────────────────────────────────

const fetchExamSubmissions = async (examId, schoolId) => {
  try {
    const res  = await api.get(`/exams/${examId}/submissions`, {
      params: { schoolId },
    });
    const data = res.data;
    const list =
      Array.isArray(data?.submissions) ? data.submissions :
      Array.isArray(data?.data)        ? data.data        :
      Array.isArray(data)              ? data             : null;

    if (list !== null) {
      console.log(`[fetchExamSubs] ${examId} → submissions: ${list.length} rows`);
      return list;
    }
  } catch (err) {
    console.log(
      `[fetchExamSubs] ${examId} → submissions ${err.response?.status ?? "ERR"}, trying scores…`
    );
  }

  try {
    const res  = await api.get(`/exams/${examId}/scores`, {
      params: { schoolId },
    });
    const data = res.data;
    const list =
      Array.isArray(data?.scores)      ? data.scores      :
      Array.isArray(data?.submissions) ? data.submissions  :
      Array.isArray(data?.data)        ? data.data        :
      Array.isArray(data)              ? data             : [];

    console.log(`[fetchExamSubs] ${examId} → scores: ${list.length} rows`);
    return list;
  } catch (err) {
    console.log(`[fetchExamSubs] ${examId} → scores also failed:`, err.response?.status);
    return [];
  }
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TeacherExamsScreen() {
  const { t } = useTranslation();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId;
  const teacherId = toStr(user?._id || user?.id);

  const { filter: initialFilter } = useLocalSearchParams();

  const [displayList,  setDisplayList]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState(null);
  const [debugInfo,    setDebugInfo]    = useState(null);
  const [activeFilter, setActiveFilter] = useState(
    typeof initialFilter === "string" ? initialFilter : "all"
  );

  useEffect(() => {
    if (typeof initialFilter === "string" && initialFilter !== activeFilter) {
      setActiveFilter(initialFilter);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFilter]);

  // ── Load assigned subjects from SQLite ──────────────────
  const loadAssignedSubjectIds = useCallback(async () => {
    try {
      const db   = await getDatabase();
      const rows = await db.getAllAsync(
        `SELECT DISTINCT subjectId
         FROM teacher_assignments
         WHERE teacherId = ?
           AND (deleted_at IS NULL OR deleted_at = '')`,
        [teacherId]
      ).catch(() => []);

      const ids = new Set(
        rows.map((r) => String(r.subjectId)).filter(Boolean)
      );
      console.log(`[TeacherExams] assigned subjects: ${ids.size}`);
      return ids;
    } catch (err) {
      console.warn("[TeacherExams] SQLite error:", err.message);
      return null; // null = skip subject filter entirely
    }
  }, [teacherId]);

  // ── Main data loader ────────────────────────────────────
  const loadData = useCallback(async (isRefresh = false) => {
    if (!teacherId) {
      console.warn("[TeacherExams] no teacherId — aborting");
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const assignedSubjectIds = await loadAssignedSubjectIds();

      // ── 1. Fetch all exams ─────────────────────────────
      const examRes  = await api.get("/exams", {
        params: { schoolId, limit: 100 },
      });
      const rawExams =
        examRes.data?.exams ||
        examRes.data?.data  ||
        [];

      console.log(`[TeacherExams] fetched ${rawExams.length} total exams`);

      if (!rawExams.length) {
        setDisplayList([]);
        setDebugInfo({ exams: 0 });
        return;
      }

      // ── 2. Process each exam ───────────────────────────
      const debugRows = [];

      const results = await Promise.all(
        rawExams.map(async (exam) => {
          const examId = toStr(exam._id || exam.id);
          if (!examId) return null;

          const allSubs = await fetchExamSubmissions(examId, schoolId);

          if (__DEV__ && allSubs.length) {
            const sample      = allSubs[0];
            const extractedId = extractTeacherId(sample);
            debugRows.push({
              examId,
              examName:      exam.name,
              totalSubs:     allSubs.length,
              sampleTeacher: extractedId,
              myTeacherId:   teacherId,
              match:         extractedId === teacherId,
            });
          }

          // Filter by teacherId
          const byTeacher = allSubs.filter(
            (s) => extractTeacherId(s) === teacherId
          );

          // Filter by assigned subjects
          const mySubs = (() => {
            if (!assignedSubjectIds || assignedSubjectIds.size === 0) {
              return byTeacher;
            }
            const filtered = byTeacher.filter((s) => {
              const sId = toStr(s.subjectId);
              if (!sId) return true;
              return assignedSubjectIds.has(sId);
            });
            return filtered.length > 0 ? filtered : byTeacher;
          })();

          if (!mySubs.length) return null;

          // Deduplicate by subjectId + classId
          const seen    = new Set();
          const deduped = [];
          for (const s of mySubs) {
            const key = `${toStr(s.subjectId)}::${toStr(s.classId)}`;
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(s);
            }
          }

          const counts = deduped.reduce(
            (acc, s) => {
              const st = s.submissionStatus || s.status || "pending";
              acc[st]  = (acc[st] || 0) + 1;
              return acc;
            },
            { pending: 0, submitted: 0, approved: 0, rejected: 0 }
          );

          return {
            exam,
            examId,
            subjects:  deduped,
            total:     deduped.length,
            pending:   counts.pending   || 0,
            submitted: counts.submitted || 0,
            approved:  counts.approved  || 0,
            rejected:  counts.rejected  || 0,
          };
        })
      );

      const filtered = results.filter(Boolean);
      console.log(`[TeacherExams] exams with my subjects: ${filtered.length}`);

      if (__DEV__ && debugRows.length) {
        console.log(
          "[TeacherExams] DEBUG sample submissions:",
          JSON.stringify(debugRows.slice(0, 3), null, 2)
        );
      }

      setDebugInfo({ exams: rawExams.length, matched: filtered.length, debugRows });
      setDisplayList(filtered);

    } catch (err) {
      console.error("[TeacherExams] load error:", err.message);
      setError(errorText(t, err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, schoolId, loadAssignedSubjectIds]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtering ───────────────────────────────────────────
  const filteredList = useMemo(() => {
    if (activeFilter === "all") return displayList;
    return displayList.filter((item) => {
      switch (activeFilter) {
        case "pending-marks": return item.pending   > 0 || item.rejected > 0;
        case "rejected":      return item.rejected  > 0;
        case "submitted":     return item.submitted > 0;
        case "approved":      return item.approved === item.total && item.total > 0;
        default:              return true;
      }
    });
  }, [displayList, activeFilter]);

  const filterCounts = useMemo(() => ({
    "all":           displayList.length,
    "pending-marks": displayList.filter((i) => i.pending > 0 || i.rejected > 0).length,
    "rejected":      displayList.filter((i) => i.rejected > 0).length,
    "submitted":     displayList.filter((i) => i.submitted > 0).length,
    "approved":      displayList.filter((i) => i.approved === i.total && i.total > 0).length,
  }), [displayList]);

  const activeFilterMeta = FILTERS.find((f) => f.id === activeFilter);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>{t("teacherExams.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("teacherExams.title")}</Text>
          <Text style={styles.headerSub}>
            {activeFilter === "all"
              ? `${displayList.length} exam${displayList.length !== 1 ? "s" : ""} with your subjects`
              : `${filteredList.length} of ${displayList.length} · ${activeFilterMeta?.label || ""}`
            }
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => loadData(true)}
          style={styles.refreshBtn}
          disabled={refreshing}
        >
          <Ionicons
            name={refreshing ? "hourglass-outline" : "refresh"}
            size={22}
            color={COLORS.primary}
          />
        </TouchableOpacity>
      </View>

      {/* Filter chips */}
      <View style={styles.filterBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScrollContent}
        >
          {FILTERS.map((f) => {
            const isActive = activeFilter === f.id;
            const count    = filterCounts[f.id] ?? 0;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.filterChip, isActive && styles.filterChipActive]}
                onPress={() => setActiveFilter(f.id)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={f.icon}
                  size={13}
                  color={isActive ? COLORS.white : COLORS.gray500}
                />
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                  {t(f.labelKey)}
                </Text>
                {count > 0 && (
                  <View style={[styles.filterChipBadge, isActive && styles.filterChipBadgeActive]}>
                    <Text style={[styles.filterChipBadgeText, isActive && styles.filterChipBadgeTextActive]}>
                      {count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* DEV debug banner */}
      {__DEV__ && debugInfo && displayList.length === 0 && (
        <View style={styles.debugBanner}>
          <Text style={styles.debugText}>
            🔍 DEV: {debugInfo.exams} exams fetched, {debugInfo.matched ?? 0} matched.
            {"\n"}teacherId = {teacherId}
            {debugInfo.debugRows?.length > 0
              ? `\nFirst submission teacherId = "${debugInfo.debugRows[0].sampleTeacher}"`
              : "\nNo submissions found in any exam"}
            {debugInfo.debugRows?.[0]?.match === false
              ? "\n⚠️  IDs do NOT match — check extractTeacherId()"
              : ""}
          </Text>
        </View>
      )}

      {/* Error banner */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadData()}>
            <Text style={styles.retryText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      <FlatList
        data={filteredList}
        keyExtractor={(item) => item.examId}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name={activeFilter === "all" ? "document-outline" : "funnel-outline"}
              size={56}
              color={COLORS.gray200}
            />
            <Text style={styles.emptyTitle}>
              {activeFilter === "all" ? t("teacherExams.emptyTitle") : t("teacherExams.noMatch")}
            </Text>
            <Text style={styles.emptyText}>
              {activeFilter === "all"
                ? t("teacherExams.emptySub")
                : `No exams match the "${activeFilterMeta?.label}" filter`}
            </Text>
            {activeFilter !== "all" && (
              <TouchableOpacity
                style={styles.emptyBtn}
                onPress={() => setActiveFilter("all")}
              >
                <Text style={styles.emptyBtnText}>{t("teacherExams.showAll")}</Text>
              </TouchableOpacity>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <ExamCard
            item={item}
            onPress={() =>
              router.push({
                pathname: "/teacher/exams/subjects",
                params: {
                  examId:   item.examId,
                  examName: item.exam.name,
                },
              })
            }
          />
        )}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// EXAM CARD
// ─────────────────────────────────────────────────────────

function ExamCard({ item, onPress }) {
  const { t } = useTranslation();
  const { exam, total, pending, submitted, approved, rejected } = item;
  const allApproved = approved === total && total > 0;
  const hasRejected = rejected > 0;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        hasRejected && styles.cardRejected,
        allApproved && styles.cardApproved,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardIconBg}>
          <Ionicons name="document-text-outline" size={20} color={COLORS.primary} />
        </View>
        <View style={styles.cardHeaderText}>
          <Text style={styles.cardName} numberOfLines={1}>{exam.name}</Text>
          <Text style={styles.cardMeta}>
            {[exam.academicYear, exam.term, exam.className]
              .filter(Boolean).join("  ·  ")}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={COLORS.gray400} />
      </View>

      <View style={styles.statusRow}>
        {pending   > 0 && <StatusPill count={pending}   label={t("results.pending")}   status="pending"   />}
        {submitted > 0 && <StatusPill count={submitted} label={t("results.submitted")} status="submitted" />}
        {approved  > 0 && <StatusPill count={approved}  label={t("results.approved")}  status="approved"  />}
        {rejected  > 0 && <StatusPill count={rejected}  label={t("results.rejected")}  status="rejected"  />}
      </View>

      {hasRejected && (
        <View style={styles.actionHint}>
          <Ionicons name="alert-circle" size={13} color={COLORS.error} />
          <Text style={styles.actionHintText}>
            {rejected} submission{rejected > 1 ? "s" : ""} rejected — re-enter marks
          </Text>
        </View>
      )}
      {pending > 0 && !hasRejected && (
        <View style={styles.actionHint}>
          <Ionicons name="create-outline" size={13} color={COLORS.warning} />
          <Text style={[styles.actionHintText, { color: COLORS.warning }]}>
            {pending} subject{pending > 1 ? "s" : ""} need{pending === 1 ? "s" : ""} marks
          </Text>
        </View>
      )}
      {allApproved && (
        <View style={styles.actionHint}>
          <Ionicons name="checkmark-circle" size={13} color={COLORS.success} />
          <Text style={[styles.actionHintText, { color: COLORS.success }]}>
            {t("teacherExams.allApproved")}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────
// STATUS PILL
// ─────────────────────────────────────────────────────────

function StatusPill({ count, label, status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  return (
    <View style={[styles.pill, { backgroundColor: meta.bg }]}>
      <Ionicons name={meta.icon} size={11} color={meta.color} />
      <Text style={[styles.pillText, { color: meta.color }]}>
        {count} {label}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: COLORS.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
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
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: COLORS.gray100,
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: COLORS.gray900 },
  headerSub:    { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  refreshBtn:   { padding: 8 },

  filterBar: {
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
  },
  filterScrollContent: {
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
  },
  filterChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    backgroundColor: COLORS.gray100,
    borderWidth: 1, borderColor: COLORS.gray200,
  },
  filterChipActive:          { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterChipText:            { fontSize: 12, fontWeight: "600", color: COLORS.gray700 },
  filterChipTextActive:      { color: COLORS.white },
  filterChipBadge: {
    backgroundColor: COLORS.white, borderRadius: 10,
    minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, alignItems: "center",
  },
  filterChipBadgeActive:     { backgroundColor: "rgba(255,255,255,0.25)" },
  filterChipBadgeText:       { fontSize: 10, fontWeight: "700", color: COLORS.gray700 },
  filterChipBadgeTextActive: { color: COLORS.white },

  debugBanner: {
    margin: 12, padding: 12,
    backgroundColor: "#FFF3CD", borderRadius: 8,
    borderWidth: 1, borderColor: "#FFC107",
  },
  debugText: { fontSize: 11, color: "#856404", fontFamily: "monospace" },

  errorBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    margin: 16, padding: 12,
    backgroundColor: COLORS.errorBg, borderRadius: 10,
    borderWidth: 1, borderColor: "#FECACA",
  },
  errorText: { flex: 1, fontSize: 13, color: COLORS.error },
  retryText: { fontSize: 13, fontWeight: "700", color: COLORS.primary },

  list:  { padding: 16, gap: 12 },
  empty: { alignItems: "center", paddingTop: 80, paddingHorizontal: 32, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: COLORS.gray700 },
  emptyText:  { fontSize: 13, color: COLORS.gray500, textAlign: "center" },
  emptyBtn: {
    marginTop: 8, backgroundColor: COLORS.primary,
    paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10,
  },
  emptyBtnText: { color: COLORS.white, fontSize: 13, fontWeight: "700" },

  card: {
    backgroundColor: COLORS.white, borderRadius: 16,
    padding: 16, gap: 12,
    borderWidth: 1, borderColor: COLORS.gray200,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  cardRejected: { borderColor: "#FECACA", borderWidth: 1.5 },
  cardApproved: { borderColor: "#A7F3D0", borderWidth: 1.5 },
  cardHeader:   { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIconBg: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: COLORS.primaryBg,
    alignItems: "center", justifyContent: "center",
  },
  cardHeaderText: { flex: 1 },
  cardName:       { fontSize: 15, fontWeight: "700", color: COLORS.gray900 },
  cardMeta:       { fontSize: 12, color: COLORS.gray500, marginTop: 2 },

  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
  },
  pillText: { fontSize: 11, fontWeight: "700" },

  actionHint: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.gray100,
  },
  actionHintText: { fontSize: 12, color: COLORS.error, fontWeight: "500" },
});