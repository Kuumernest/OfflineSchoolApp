// app/admin/exams/monitor/index.js
"use strict";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, TextInput,
  ScrollView, Modal,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../../src/store/auth.store";
import api              from "../../../../src/services/api";
import { ExamService }  from "../../../../src/services/exam.service";
import { COLORS, ACCENT, SEMANTIC } from "../../../../src/theme/colors";
import { HeaderIcon, Badge, EmptyState } from "../../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
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
  pending: {
    tone: "warning", accent: "amber",
    labelKey: "results.pending",   icon: "time-outline",
  },
  submitted: {
    tone: "info", accent: "blue",
    labelKey: "results.submitted", icon: "cloud-upload-outline",
  },
  approved: {
    tone: "success", accent: "green",
    labelKey: "results.approved",  icon: "checkmark-circle-outline",
  },
  rejected: {
    tone: "error", accent: "red",
    labelKey: "results.rejected",  icon: "close-circle-outline",
  },
};

const FILTERS = [
  { key: "all",       labelKey: "examMonitor.filterAll" },
  { key: "pending",   labelKey: "results.pending"   },
  { key: "submitted", labelKey: "results.submitted" },
  { key: "approved",  labelKey: "results.approved"  },
  { key: "rejected",  labelKey: "results.rejected"  },
];

// ─────────────────────────────────────────────────────────
// REJECT MODAL
// ─────────────────────────────────────────────────────────

function RejectModal({ visible, subject, onConfirm, onCancel, loading }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (visible) setReason("");
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={rm.overlay}>
        <View style={rm.box}>
          <Text style={rm.title}>{t("examMonitor.rejectTitle")}</Text>
          {!!subject?.subjectName && (
            <Text style={rm.sub}>
              {subject.subjectName}
              {subject.teacherName ? ` — ${subject.teacherName}` : ""}
            </Text>
          )}
          <TextInput
            style={rm.input}
            placeholder={t("examMonitor.reasonPh")}
            placeholderTextColor={C.gray400}
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={3}
            autoFocus
          />
          <View style={rm.actions}>
            <TouchableOpacity
              style={rm.cancelBtn}
              onPress={onCancel}
              disabled={loading}
            >
              <Text style={rm.cancelText}>{t("common.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[rm.rejectBtn, (!reason.trim() || loading) && { opacity: 0.4 }]}
              onPress={() => {
                if (!reason.trim()) {
                  Alert.alert(t("examMonitor.requiredTitle"), t("examMonitor.reasonRequired"));
                  return;
                }
                onConfirm(reason.trim());
              }}
              disabled={!reason.trim() || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color={C.white} />
                : <Text style={rm.rejectText}>{t("examMonitor.reject")}</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const rm = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent:  "center",
    alignItems:      "center",
    padding:         24,
  },
  box: {
    backgroundColor: C.white,
    borderRadius:    20,
    padding:         24,
    width:           "100%",
    gap:             12,
  },
  title:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  sub:    { fontSize: 13, color: C.gray500 },
  input: {
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      10,
    padding:           12,
    fontSize:          14,
    color:             C.gray900,
    backgroundColor:   C.gray50,
    minHeight:         80,
    textAlignVertical: "top",
  },
  actions:   { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    10,
    alignItems:      "center",
    backgroundColor: C.gray100,
  },
  cancelText: { fontSize: 14, fontWeight: "600", color: C.gray700 },
  rejectBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    10,
    alignItems:      "center",
    backgroundColor: C.error,
  },
  rejectText: { fontSize: 14, fontWeight: "700", color: C.white },
});

// ─────────────────────────────────────────────────────────
// META CHIP
// ─────────────────────────────────────────────────────────

function MetaChip({ icon, label, color = COLORS.textSecondary }) {
  return (
    <View style={mc.chip}>
      <Ionicons name={icon} size={11} color={color} />
      <Text style={[mc.text, { color }]}>{label}</Text>
    </View>
  );
}

const mc = StyleSheet.create({
  chip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   COLORS.surface,
    borderRadius:      6,
    paddingHorizontal: 7,
    paddingVertical:   3,
  },
  text: { fontSize: 10, fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function SubmissionMonitorScreen() {
  const { t } = useTranslation();
  const { examId, examName } = useLocalSearchParams();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [exams,         setExams]         = useState([]);
  const [selectedExam,  setSelectedExam]  = useState(
    examId ? { _id: examId, name: examName || t("academic.exam") } : null
  );
  const [submissions,   setSubmissions]   = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [filter,        setFilter]        = useState("all");
  const [rejectModal,   setRejectModal]   = useState(null);
  const [rejectLoading, setRejectLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  // ── Load exam list ─────────────────────────────────────
  const loadExams = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get("/exams", {
        params: { schoolId, limit: 100 },
      });
      setExams(res.data?.exams || []);
    } catch (err) {
      console.error("loadExams error:", err.message);
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  // ── Load submissions ───────────────────────────────────
  const loadSubmissions = useCallback(async (isRefresh = false) => {
    if (!selectedExam) return;
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const res = await api.get(
        `/exams/${selectedExam._id}/submissions`,
        { params: { schoolId } }
      );
      setSubmissions(res.data?.submissions || []);
    } catch (err) {
      console.error("loadSubmissions error:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedExam, schoolId]);

  useEffect(() => {
    if (selectedExam) loadSubmissions();
    else              loadExams();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExam]);

  const counts = useMemo(() => ({
    total:     submissions.length,
    pending:   submissions.filter((s) => s.submissionStatus === "pending").length,
    submitted: submissions.filter((s) => s.submissionStatus === "submitted").length,
    approved:  submissions.filter((s) => s.submissionStatus === "approved").length,
    rejected:  submissions.filter((s) => s.submissionStatus === "rejected").length,
  }), [submissions]);

  const filtered = useMemo(() =>
    filter === "all"
      ? submissions
      : submissions.filter((s) => s.submissionStatus === filter),
    [submissions, filter]
  );

  // ── Approve ────────────────────────────────────────────
  const handleApprove = useCallback(async (subject) => {
    Alert.alert(
      t("examMonitor.approveTitle"),
      t("examMonitor.approveBody", { subject: subject.subjectName }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:    t("examMonitor.approve"),
          onPress: async () => {
            try {
              setActionLoading(subject._id);
              await ExamService.approveSubmission({
                examId:        selectedExam._id,
                examSubjectId: subject._id,
                schoolId,
              });
              await loadSubmissions(true);
            } catch (err) {
              Alert.alert(t("examMonitor.errTitle"), errorText(t, err));
            } finally {
              setActionLoading(null);
            }
          },
        },
      ]
    );
  // selectedExam?._id, not selectedExam._id.
  //
  // This screen opens with no exam when it is reached from the menu rather
  // than from a specific exam — useState starts it at null on line 219 and
  // there is a picker behind the `if (!selectedExam)` guard further down.
  // But a dependency array is evaluated DURING render, so this ran before
  // that guard and threw on `_id` of null. The callback bodies below read
  // selectedExam._id unguarded quite safely: they only run once an exam has
  // been chosen.
  }, [t, selectedExam?._id, schoolId, loadSubmissions]);

  // ── Reject ─────────────────────────────────────────────
  const handleRejectConfirm = useCallback(async (reason) => {
    if (!rejectModal) return;
    try {
      setRejectLoading(true);
      await ExamService.rejectSubmission({
        examId:        selectedExam._id,
        examSubjectId: rejectModal._id,
        reason,
        schoolId,
      });
      setRejectModal(null);
      await loadSubmissions(true);
    } catch (err) {
      Alert.alert(t("examMonitor.errTitle"), errorText(t, err));
    } finally {
      setRejectLoading(false);
    }
  }, [rejectModal, selectedExam?._id, schoolId, loadSubmissions, t]);

  // ── View scores ────────────────────────────────────────
  const handleViewScores = useCallback((subject) => {
    router.push({
      pathname: "/admin/exams/marks",
      params: {
        examId:        selectedExam._id,
        examName:      selectedExam.name,
        classId:       String(subject.classId  || ""),
        subjectId:     String(subject.subjectId),
        subjectName:   subject.subjectName     || "",
        examSubjectId: String(subject._id      || subject.id),
        maxScore:      String(subject.maxScore ?? 100),
        passMark:      String(subject.passMark ?? 50),
      },
    });
  }, [selectedExam]);

  // ─────────────────────────────────────────────────────────
  // RENDER — Exam picker
  // ─────────────────────────────────────────────────────────

  if (!selectedExam) {
    return (
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <HeaderIcon style={s.headerIcon} />
          <Text style={s.headerTitle}>{t("examMonitor.title")}</Text>
        </View>

        {loading ? (
          <View style={s.centered}>
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={s.loadingText}>{t("examMonitor.loadingExams")}</Text>
          </View>
        ) : (
          <FlatList
            data={exams}
            keyExtractor={(item) => String(item._id || item.id)}
            contentContainerStyle={s.list}
            ListHeaderComponent={
              <Text style={s.listHint}>
                {t("examMonitor.pickExam")}
              </Text>
            }
            ListEmptyComponent={
              <EmptyState
                icon="document-text"
                accent="amber"
                title={t("examMonitor.noExams")}
                message={t("examMonitor.createFirst")}
                style={s.empty}
              />
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={s.examCard}
                onPress={() => setSelectedExam({
                  _id:  String(item._id || item.id),
                  name: item.name,
                })}
                activeOpacity={0.7}
              >
                <View style={s.examCardIcon}>
                  <Ionicons name="document-text-outline" size={20} color={COLORS.onPrimary} />
                </View>
                <View style={s.examCardInfo}>
                  <Text style={s.examCardName} numberOfLines={1}>{item.name}</Text>
                  <Text style={s.examCardMeta}>
                    {[item.academicYear, item.term, item.className]
                      .filter(Boolean).join("  ·  ")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
              </TouchableOpacity>
            )}
          />
        )}
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — Submissions list
  // ─────────────────────────────────────────────────────────

  return (
    <View style={s.screen}>
      <RejectModal
        visible={!!rejectModal}
        subject={rejectModal}
        loading={rejectLoading}
        onConfirm={handleRejectConfirm}
        onCancel={() => setRejectModal(null)}
      />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => setSelectedExam(null)}
          style={s.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={s.headerIcon} />
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>{t("examMonitor.title")}</Text>
          <Text style={s.headerSub} numberOfLines={1}>{selectedExam.name}</Text>
        </View>
        <TouchableOpacity
          onPress={() => loadSubmissions(true)}
          style={s.refreshBtn}
        >
          <Ionicons name="refresh" size={22} color={C.primary} />
        </TouchableOpacity>
      </View>

      {/* Summary row */}
      <View style={s.summaryRow}>
        {[
          { labelKey: "common.total",     count: counts.total,     accent: "amber" },
          { labelKey: "results.pending",   count: counts.pending,   accent: "amber" },
          { labelKey: "results.submitted", count: counts.submitted, accent: "blue"  },
          { labelKey: "results.approved",  count: counts.approved,  accent: "green" },
          { labelKey: "results.rejected",  count: counts.rejected,  accent: "red"   },
        ].map((item) => (
          <View
            key={item.labelKey}
            style={[s.summaryChip, { backgroundColor: ACCENT[item.accent].wash, borderColor: ACCENT[item.accent].base + "4D" }]}
          >
            <Text style={[s.summaryCount, { color: ACCENT[item.accent].deep }]}>
              {item.count}
            </Text>
            <Text style={s.summaryLabel}>{t(item.labelKey)}</Text>
          </View>
        ))}
      </View>

      {/* Body */}
      <View style={s.bodyContainer}>
        {/* Filter bar */}
        <View style={s.filterBarWrapper}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.filterBar}
            contentContainerStyle={s.filterBarContent}
          >
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[s.filterChip, filter === f.key && s.filterChipActive]}
                onPress={() => setFilter(f.key)}
                activeOpacity={0.7}
              >
                <Text style={[
                  s.filterChipText,
                  filter === f.key && s.filterChipTextActive,
                ]}>
                  {t(f.labelKey)}
                  {f.key !== "all" && counts[f.key] > 0
                    ? ` (${counts[f.key]})`
                    : ""}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* List */}
        {loading && !refreshing ? (
          <View style={s.centered}>
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={s.loadingText}>{t("examMonitor.loadingSubs")}</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => String(item._id || item.id)}
            contentContainerStyle={s.list}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => loadSubmissions(true)}
                tintColor={C.primary}
                colors={[C.primary]}
              />
            }
            ListEmptyComponent={
              <EmptyState
                icon="cloud-upload"
                accent="amber"
                title={filter === "all" ? t("examMonitor.noneYet") : t("examMonitor.noneForFilter")}
                message={filter === "all"
                  ? t("examMonitor.noneYetHint")
                  : t("examMonitor.tryFilter")}
                style={s.empty}
              />
            }
            renderItem={({ item }) => {
              const meta        = STATUS_META[item.submissionStatus] || STATUS_META.pending;
              const isSubmitted = item.submissionStatus === "submitted";
              const isLoading   = actionLoading === item._id;

              return (
                <View style={[
                  s.card,
                  { backgroundColor: ACCENT[meta.accent].wash, borderLeftColor: ACCENT[meta.accent].base },
                  isSubmitted                          && s.cardHighlight,
                  item.submissionStatus === "rejected" && s.cardRejected,
                  item.submissionStatus === "approved" && s.cardApproved,
                ]}>
                  <View style={s.cardHeader}>
                    <View style={[s.cardIconBg, { backgroundColor: ACCENT[meta.accent].solid }]}>
                      <Ionicons name={meta.icon} size={20} color={COLORS.onPrimary} />
                    </View>
                    <View style={s.cardHeaderText}>
                      <Text style={s.subjectName} numberOfLines={1}>
                        {item.subjectName || t("examMonitor.unknownSubject")}
                      </Text>
                      <Text style={s.teacherName}>
                        {item.teacherName || t("examMonitor.noTeacher")}
                      </Text>
                    </View>
                    <Badge
                      label={t(meta.labelKey)}
                      tone={meta.tone}
                      style={s.statusBadge}
                      textStyle={s.statusText}
                    />
                  </View>

                  <View style={s.metaRow}>
                    <MetaChip icon="trophy-outline"          label={`Max: ${item.maxScore}`} />
                    <MetaChip icon="checkmark-circle-outline" label={`Pass: ${item.passMark}`} />
                    <MetaChip
                      icon="create-outline"
                      label={`${item.totalScoresEntered ?? 0} entered`}
                      color={(item.totalScoresEntered ?? 0) > 0 ? ACCENT.green.deep : COLORS.textSecondary}
                    />
                  </View>

                  {item.submissionStatus === "rejected" && item.rejectReason && (
                    <View style={s.rejectBox}>
                      <Ionicons name="alert-circle-outline" size={14} color={SEMANTIC.error.icon} />
                      <Text style={s.rejectBoxText}>
                        {t("examMonitor.reasonLabel", { reason: item.rejectReason })}
                      </Text>
                    </View>
                  )}

                  {item.submittedAt && (
                    <Text style={s.timestamp}>
                      {t("examMonitor.submittedAt", {
                        date: new Date(item.submittedAt).toLocaleDateString("en-GB", {
                          day: "numeric", month: "short", year: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        }),
                      })}
                    </Text>
                  )}

                  <View style={s.actionRow}>
                    <TouchableOpacity
                      style={s.viewBtn}
                      onPress={() => handleViewScores(item)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="eye-outline" size={15} color={C.primary} />
                      <Text style={s.viewBtnText}>{t("examMonitor.viewScores")}</Text>
                    </TouchableOpacity>

                    {isSubmitted && (
                      <>
                        <TouchableOpacity
                          style={[s.approveBtn, isLoading && { opacity: 0.6 }]}
                          onPress={() => handleApprove(item)}
                          disabled={isLoading}
                          activeOpacity={0.8}
                        >
                          {isLoading
                            ? <ActivityIndicator size="small" color={C.white} />
                            : <>
                                <Ionicons name="checkmark-circle-outline" size={15} color={C.white} />
                                <Text style={s.approveBtnText}>{t("examMonitor.approve")}</Text>
                              </>
                          }
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.rejectBtn, isLoading && { opacity: 0.6 }]}
                          onPress={() => setRejectModal(item)}
                          disabled={isLoading}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="close-circle-outline" size={15} color={C.white} />
                          <Text style={s.rejectBtnText}>{t("examMonitor.reject")}</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:   { marginRight: 0 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  refreshBtn:   { padding: 8 },
  summaryRow: {
    flexDirection:     "row",
    paddingHorizontal: 16,
    paddingVertical:   12,
    gap:               8,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    flexShrink:        0,
  },
  summaryChip: {
    flex:            1,
    alignItems:      "center",
    borderRadius:    10,
    borderWidth:     1,
    paddingVertical: 8,
  },
  summaryCount: { fontSize: 18, fontWeight: "800" },
  summaryLabel: { fontSize: 9, color: COLORS.textSecondary, marginTop: 2, fontWeight: "600" },
  bodyContainer: { flex: 1 },
  filterBarWrapper: {
    height:            46,
    flexShrink:        0,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  filterBar:        { flex: 1 },
  filterBarContent: { paddingHorizontal: 16, gap: 8, paddingVertical: 8, alignItems: "center" },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical:   6,
    borderRadius:      20,
    backgroundColor:   COLORS.surface,
    borderWidth:       1,
    borderColor:       COLORS.border,
  },
  filterChipActive:     { backgroundColor: ACCENT.amber.wash, borderColor: ACCENT.amber.base },
  filterChipText:       { fontSize: 12, fontWeight: "600", color: COLORS.textSecondary },
  filterChipTextActive: { color: ACCENT.amber.deep },
  list:     { padding: 16, gap: 12 },
  listHint: { fontSize: 13, color: COLORS.textSecondary, marginBottom: 8 },
  empty: {
    paddingTop:        60,
    paddingHorizontal: 32,
  },
  examCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: ACCENT.amber.wash,
    borderRadius:    14,
    padding:         16,
    gap:             12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.amber.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  examCardIcon: {
    width:           44,
    height:          44,
    borderRadius:    12,
    backgroundColor: ACCENT.amber.solid,
    alignItems:      "center",
    justifyContent:  "center",
  },
  examCardInfo: { flex: 1 },
  examCardName: { fontSize: 15, fontWeight: "700", color: COLORS.text },
  examCardMeta: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  card: {
    backgroundColor: ACCENT.amber.wash,
    borderRadius:    16,
    padding:         16,
    gap:             10,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.amber.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardHighlight: { borderColor: ACCENT.blue.base, borderWidth: 1.5, borderLeftWidth: 4, borderLeftColor: ACCENT.blue.base },
  cardRejected:  { borderLeftWidth: 4, borderLeftColor: ACCENT.red.base, borderColor: SEMANTIC.error.box },
  cardApproved:  { borderLeftWidth: 4, borderLeftColor: ACCENT.green.base, borderColor: SEMANTIC.success.box },
  cardHeader:    { flexDirection: "row", alignItems: "center", gap: 10 },
  cardIconBg: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  cardHeaderText: { flex: 1 },
  subjectName:    { fontSize: 15, fontWeight: "700", color: COLORS.text },
  teacherName:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  statusBadge:    { alignSelf: "auto", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusText:     { fontSize: 11, fontWeight: "700" },
  metaRow:        { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  rejectBox: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             6,
    backgroundColor: SEMANTIC.error.box,
    borderRadius:    8,
    padding:         10,
  },
  rejectBoxText: { flex: 1, fontSize: 12, color: SEMANTIC.error.text, lineHeight: 18 },
  timestamp:     { fontSize: 11, color: COLORS.textSecondary, fontStyle: "italic" },
  actionRow:     { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  viewBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderRadius:      8,
    borderWidth:       1.5,
    borderColor:       C.primary,
    backgroundColor:   C.primaryBg,
  },
  viewBtnText: { fontSize: 12, fontWeight: "700", color: C.primary },
  approveBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             5,
    paddingVertical: 10,
    borderRadius:    8,
    backgroundColor: C.success,
  },
  approveBtnText: { fontSize: 13, fontWeight: "700", color: C.white },
  rejectBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             5,
    paddingVertical: 10,
    borderRadius:    8,
    backgroundColor: C.error,
  },
  rejectBtnText: { fontSize: 13, fontWeight: "700", color: C.white },
});
import { useTranslation } from "../../../../src/i18n/useTranslation";
import { errorText } from "../../../../src/utils/appError";