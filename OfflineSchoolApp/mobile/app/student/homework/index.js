// app/student/homework/index.js

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  memo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Alert,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import {
  getStudentHomework,
  submitHomework,
  ensureHomeworkTables,
} from "../../../src/services/homework.service";
import {
  resolveStudentClassId,
} from "../../../src/services/student.service";

import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
  });
};

const formatTime = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", {
    hour:   "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const formatDateTime = (dateStr) => {
  if (!dateStr) return "—";
  const date = formatDate(dateStr);
  const time = formatTime(dateStr);
  return date && time ? `${date} at ${time}` : date || time || "—";
};

const getDueStatus = (dueDateStr, submittedAt = null, t) => {
  if (!dueDateStr) {
    return { label: t("studentHome.dueNoDeadline"), color: "#6B7280", bg: "#F3F4F6", urgent: false };
  }

  const due  = new Date(dueDateStr);
  const now  = new Date();
  const diff = due - now;

  if (submittedAt) {
    const wasLate = new Date(submittedAt) > due;
    return wasLate
      ? { label: t("studentHome.dueSubmittedLate"),    color: "#D97706", bg: "#FEF3C7", urgent: false }
      : { label: t("studentHome.dueSubmittedOnTime"), color: "#059669", bg: "#ECFDF5", urgent: false };
  }

  if (diff < 0) {
    const hoursAgo = Math.floor(Math.abs(diff) / 3600000);
    const daysAgo  = Math.floor(Math.abs(diff) / 86400000);
    return {
      label:  daysAgo > 0 ? `${daysAgo}d overdue` : `${hoursAgo}h overdue`,
      color:  "#DC2626",
      bg:     "#FEE2E2",
      urgent: true,
      isPast: true,
    };
  }

  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (hours < 6)  return { label: `${hours}h left`,  color: "#DC2626", bg: "#FEE2E2", urgent: true  };
  if (hours < 24) return { label: t("studentHome.dueToday"),        color: "#D97706", bg: "#FEF3C7", urgent: true  };
  if (days === 1) return { label: t("studentHome.dueTomorrow"),     color: "#D97706", bg: "#FEF3C7", urgent: false };
  if (days < 7)   return { label: `${days}d left`,   color: "#059669", bg: "#ECFDF5", urgent: false };

  const weeks = Math.floor(days / 7);
  return { label: `${weeks}w left`, color: "#059669", bg: "#ECFDF5", urgent: false };
};

const getSubmissionStatus = (hw, t) => {
  const hasSubmission = !!hw.submission_id;
  const isGraded      = hasSubmission && hw.submission_score != null;

  if (isGraded) {
    const pct = hw.max_score > 0
      ? Math.round((hw.submission_score / hw.max_score) * 100)
      : 0;
    return {
      type:  "graded",
      label: `Graded: ${hw.submission_score}/${hw.max_score} (${pct}%)`,
      color: pct >= 70 ? "#059669" : "#DC2626",
      bg:    pct >= 70 ? "#ECFDF5" : "#FEE2E2",
      icon:  "ribbon-outline",
    };
  }

  if (hasSubmission) {
    return {
      type:  "submitted",
      label: t("studentHw.awaitingGrade"),
      color: "#4F46E5",
      bg:    "#EEF2FF",
      icon:  "checkmark-circle-outline",
    };
  }

  const due    = hw.due_date ? new Date(hw.due_date) : null;
  const isPast = due && new Date() > due;
  const noLate = !hw.allow_late;

  if (isPast && noLate) {
    return {
      type:  "closed",
      label: t("studentHw.deadlinePassed"),
      color: "#DC2626",
      bg:    "#FEE2E2",
      icon:  "lock-closed-outline",
    };
  }

  return {
    type:  "pending",
    label: isPast ? t("studentHw.notSubmittedLate") : t("studentHw.notSubmitted"),
    color: isPast ? "#D97706" : "#6B7280",
    bg:    isPast ? "#FEF3C7" : "#F3F4F6",
    icon:  "document-outline",
  };
};

// ─────────────────────────────────────────────────────────────
// SUBMIT MODAL
// ─────────────────────────────────────────────────────────────

const SubmitModal = memo(({
  homework,
  userId,
  onClose,
  onSubmitted,
}) => {
  const { t } = useTranslation();
  const [text,       setText]       = useState(homework?.submission_text || "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setText(homework?.submission_text || "");
  }, [homework?.id]);

  if (!homework) return null;

  const isResubmit = !!homework.submission_id;
  const subStatus  = getSubmissionStatus(homework, t);
  const due        = getDueStatus(homework.due_date, homework.submission_submitted_at, t);
  const isGraded   = subStatus.type === "graded";
  const isClosed   = subStatus.type === "closed";

  const handleSubmit = async () => {
    if (!text.trim()) {
      Alert.alert(t("studentHw.requiredTitle"), t("studentHw.writeFirst"));
      return;
    }

    Alert.alert(
      isResubmit ? t("studentHw.resubmitTitle") : t("studentHw.submitTitle"),
      isResubmit
        ? t("studentHw.resubmitBody")
        : t("studentHw.submitBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:    isResubmit ? t("studentHw.resubmit") : t("studentHw.submit"),
          style:   "default",
          onPress: async () => {
            setSubmitting(true);
            try {
              await submitHomework({
                homeworkId:      homework.id,
                studentId:       userId,
                submission_text: text.trim(),
              });
              onSubmitted(homework.id, text.trim());
              onClose();
              Alert.alert(t("studentHw.submittedTitle"), t("studentHw.submittedBody"));
            } catch (err) {
              Alert.alert(t("studentHw.errTitle"), errorText(t, err, "studentHw.submitFailed"));
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={!!homework}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={modalStyles.container}>

          {/* Header */}
          <View style={modalStyles.header}>
            <TouchableOpacity onPress={onClose} style={modalStyles.closeBtn}>
              <Ionicons name="close" size={22} color="#374151" />
            </TouchableOpacity>
            <Text style={modalStyles.headerTitle} numberOfLines={1}>
              {homework.title}
            </Text>
            <View style={{ width: 36 }} />
          </View>

          <ScrollView
            contentContainerStyle={modalStyles.content}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Info grid */}
            <View style={modalStyles.infoGrid}>
              {[
                {
                  icon:  "school-outline",
                  label: t("studentHw.subject"),
                  value: homework.subject_name || "—",
                  color: "#4F46E5", bg: "#EEF2FF",
                },
                {
                  icon:  "star-outline",
                  label: t("studentHw.maxScore"),
                  value: homework.max_score ?? 100,
                  color: "#D97706", bg: "#FEF3C7",
                },
                {
                  icon:  "calendar-outline",
                  label: t("studentHw.dueDate"),
                  value: homework.due_date ? formatDate(homework.due_date) : t("studentHome.dueNoDeadline"),
                  color: due.color, bg: due.bg,
                },
                {
                  icon:  "time-outline",
                  label: t("studentHw.dueTime"),
                  value: homework.due_date ? formatTime(homework.due_date) : "—",
                  color: due.color, bg: due.bg,
                },
              ].map((item) => (
                <View
                  key={item.label}
                  style={[modalStyles.infoCard, { backgroundColor: item.bg }]}
                >
                  <Ionicons name={item.icon} size={18} color={item.color} />
                  <Text
                    style={[modalStyles.infoValue, { color: item.color }]}
                    numberOfLines={1}
                  >
                    {item.value}
                  </Text>
                  <Text style={modalStyles.infoLabel}>{item.label}</Text>
                </View>
              ))}
            </View>

            {/* Description */}
            {homework.description ? (
              <View style={modalStyles.descBox}>
                <Text style={modalStyles.descLabel}>{t("common.description")}</Text>
                <Text style={modalStyles.descText}>{homework.description}</Text>
              </View>
            ) : null}

            {/* Instructions */}
            {homework.instructions ? (
              <View style={modalStyles.instructBox}>
                <View style={modalStyles.instructHeader}>
                  <Ionicons name="information-circle-outline" size={16} color="#4F46E5" />
                  <Text style={modalStyles.instructTitle}>{t("studentHw.instructions")}</Text>
                </View>
                <Text style={modalStyles.instructText}>{homework.instructions}</Text>
              </View>
            ) : null}

            {/* Submission status */}
            <View style={[modalStyles.statusBox, { backgroundColor: subStatus.bg }]}>
              <Ionicons name={subStatus.icon} size={18} color={subStatus.color} />
              <Text style={[modalStyles.statusText, { color: subStatus.color }]}>
                {subStatus.label}
              </Text>
            </View>

            {/* Grade + feedback */}
            {isGraded && (
              <View style={modalStyles.gradeBox}>
                <View style={modalStyles.gradeRow}>
                  <Ionicons name="ribbon" size={22} color="#059669" />
                  <Text style={modalStyles.gradeScore}>
                    {homework.submission_score} / {homework.max_score ?? 100}
                  </Text>
                  <Text style={modalStyles.gradePct}>
                    ({Math.round((homework.submission_score / (homework.max_score ?? 100)) * 100)}%)
                  </Text>
                </View>
                {homework.submission_feedback ? (
                  <View style={modalStyles.feedbackBox}>
                    <View style={modalStyles.feedbackHeader}>
                      <Ionicons name="chatbubble-outline" size={14} color="#059669" />
                      <Text style={modalStyles.feedbackTitle}>{t("studentHw.feedback")}</Text>
                    </View>
                    <Text style={modalStyles.feedbackText}>
                      {homework.submission_feedback}
                    </Text>
                  </View>
                ) : null}
              </View>
            )}

            {/* Previous submission */}
            {homework.submission_text && !isGraded ? (
              <View style={modalStyles.prevSubmission}>
                <Text style={modalStyles.prevSubmissionLabel}>
                  {t("studentHw.prevResponse")}
                </Text>
                <Text style={modalStyles.prevSubmissionText}>
                  {homework.submission_text}
                </Text>
                {homework.submission_submitted_at && (
                  <Text style={modalStyles.prevSubmissionDate}>
                    Submitted {formatDateTime(homework.submission_submitted_at)}
                    {homework.submission_is_late ? "  · Late" : ""}
                  </Text>
                )}
              </View>
            ) : null}

            {/* Response input */}
            {!isGraded && !isClosed && (
              <View style={modalStyles.responseSection}>
                <Text style={modalStyles.responseLabel}>
                  {isResubmit ? t("studentHw.updatePh") : t("studentHw.yourResponse")}
                  <Text style={{ color: "#DC2626" }}> *</Text>
                </Text>

                {due.urgent && !due.isPast && (
                  <View style={modalStyles.warnBanner}>
                    <Ionicons name="warning-outline" size={14} color="#DC2626" />
                    <Text style={modalStyles.warnText}>{t("studentHw.soonWarn")}</Text>
                  </View>
                )}

                {due.isPast && homework.allow_late && (
                  <View style={[modalStyles.warnBanner, { backgroundColor: "#FEF3C7", borderColor: "#FDE68A" }]}>
                    <Ionicons name="warning-outline" size={14} color="#D97706" />
                    <Text style={[modalStyles.warnText, { color: "#92400E" }]}>
                      {t("studentHw.lateWarn")}
                    </Text>
                  </View>
                )}

                <TextInput
                  style={modalStyles.responseInput}
                  value={text}
                  onChangeText={setText}
                  placeholder={t("studentHw.answerPh")}
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={8}
                  textAlignVertical="top"
                />
                <Text style={modalStyles.charCount}>
                  {text.length} character{text.length !== 1 ? "s" : ""}
                </Text>
              </View>
            )}
          </ScrollView>

          {/* Footer */}
          {!isGraded && !isClosed && (
            <View style={modalStyles.footer}>
              <TouchableOpacity
                style={[
                  modalStyles.submitBtn,
                  submitting && modalStyles.submitBtnDisabled,
                ]}
                onPress={handleSubmit}
                disabled={submitting}
                activeOpacity={0.8}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <>
                    <Ionicons
                      name={isResubmit ? "refresh-outline" : "send-outline"}
                      size={20}
                      color="#FFF"
                    />
                    <Text style={modalStyles.submitBtnText}>
                      {isResubmit ? t("studentHw.updateCta") : t("studentHw.submitTitle")}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {isGraded && (
            <View style={modalStyles.footer}>
              <View style={modalStyles.gradedFooter}>
                <Ionicons name="ribbon" size={20} color="#059669" />
                <Text style={modalStyles.gradedFooterText}>
                  {t("studentHw.gradedNote")}
                </Text>
              </View>
            </View>
          )}

          {isClosed && (
            <View style={modalStyles.footer}>
              <View style={[modalStyles.gradedFooter, { backgroundColor: "#FEE2E2" }]}>
                <Ionicons name="lock-closed-outline" size={20} color="#DC2626" />
                <Text style={[modalStyles.gradedFooterText, { color: "#DC2626" }]}>
                  Deadline has passed — no submissions accepted
                </Text>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

// ─────────────────────────────────────────────────────────────
// HOMEWORK CARD
// ─────────────────────────────────────────────────────────────

const HomeworkCard = memo(
  ({ item, onPress }) => {
    const { t } = useTranslation();
    const subStatus = getSubmissionStatus(item, t);
    const due       = getDueStatus(item.due_date, item.submission_submitted_at, t);

    return (
      <TouchableOpacity
        style={[
          styles.card,
          due.urgent && subStatus.type === "pending" && styles.cardUrgent,
        ]}
        onPress={() => onPress(item)}
        activeOpacity={0.7}
      >
        {/* Top row */}
        <View style={styles.cardTop}>
          <View style={[styles.subjectIcon, { backgroundColor: subStatus.bg }]}>
            <Ionicons name={subStatus.icon} size={20} color={subStatus.color} />
          </View>

          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.cardMeta}>
              {[item.subject_name, item.class_name].filter(Boolean).join("  ·  ")}
            </Text>
          </View>

          <View style={[styles.dueBadge, { backgroundColor: due.bg }]}>
            <Text style={[styles.dueBadgeText, { color: due.color }]}>
              {due.label}
            </Text>
          </View>
        </View>

        {/* Description preview */}
        {item.description ? (
          <Text style={styles.cardDesc} numberOfLines={1}>{item.description}</Text>
        ) : null}

        {/* Bottom chips */}
        <View style={styles.cardBottom}>
          <View style={styles.bottomChip}>
            <Ionicons name="star-outline" size={12} color="#6B7280" />
            <Text style={styles.bottomChipText}>{item.max_score ?? 100} pts</Text>
          </View>

          {item.due_date && (
            <View style={styles.bottomChip}>
              <Ionicons name="calendar-outline" size={12} color="#6B7280" />
              <Text style={styles.bottomChipText}>{formatDate(item.due_date)}</Text>
            </View>
          )}

          {item.allow_late ? (
            <View style={[styles.bottomChip, { backgroundColor: "#F0FDF4" }]}>
              <Ionicons name="checkmark-outline" size={12} color="#059669" />
              <Text style={[styles.bottomChipText, { color: "#059669" }]}>{t("studentHw.lateOk")}</Text>
            </View>
          ) : (
            <View style={[styles.bottomChip, { backgroundColor: "#FEF2F2" }]}>
              <Ionicons name="close-outline" size={12} color="#DC2626" />
              <Text style={[styles.bottomChipText, { color: "#DC2626" }]}>{t("studentHw.noLate")}</Text>
            </View>
          )}

          <View style={[styles.bottomChip, { backgroundColor: subStatus.bg }]}>
            <Ionicons name={subStatus.icon} size={12} color={subStatus.color} />
            <Text style={[styles.bottomChipText, { color: subStatus.color }]}>
              {subStatus.type === "graded"
                ? `${item.submission_score}/${item.max_score ?? 100}`
                : subStatus.type === "submitted"
                ? t("studentHome.hwSubmitted")
                : subStatus.type === "closed"
                ? t("studentHw.closed")
                : t("studentHome.hwPending")}
            </Text>
          </View>
        </View>

        {/* Tap hint */}
        <Text style={styles.tapHint}>
          {subStatus.type === "graded"
            ? t("studentHw.tapGrade")
            : subStatus.type === "submitted"
            ? t("studentHw.tapUpdate")
            : subStatus.type === "closed"
            ? t("studentHw.tapClosed")
            : t("studentHw.tapSubmit")}
        </Text>
      </TouchableOpacity>
    );
  },
  (prev, next) =>
    prev.item.id                      === next.item.id &&
    prev.item.submission_id           === next.item.submission_id &&
    prev.item.submission_score        === next.item.submission_score &&
    prev.item.submission_status       === next.item.submission_status &&
    prev.item.submission_submitted_at === next.item.submission_submitted_at
);

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function StudentHomeworkScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  const schoolId = useAuthStore((s) => s.user?.schoolId);
  const userId   = useAuthStore(
    (s) => s.user?._id || s.user?.id || s.user?.userId
  );

  const [homework,     setHomework]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [selectedHW,   setSelectedHW]   = useState(null);
  const [activeFilter, setActiveFilter] = useState("all");
  const [search,       setSearch]       = useState("");

  const hasLoaded = React.useRef(false);
  const isMounted = React.useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const loadData = useCallback(
    async (isRefresh = false) => {
      if (!schoolId || !userId) {
        console.warn("[StudentHomework] missing schoolId or userId — aborting load");
        setLoading(false);
        return;
      }

      try {
        if (isRefresh) setRefreshing(true);
        else if (!hasLoaded.current) setLoading(true);

        await ensureHomeworkTables();

        let resolvedClassId = null;
        try {
          resolvedClassId = await resolveStudentClassId(userId, schoolId);
        } catch (err) {
          console.warn("[StudentHomework] could not resolve classId:", err.message);
        }

        console.log(
          `[StudentHomework] loading —`,
          `userId="${userId}"`,
          `schoolId="${schoolId}"`,
          `classId="${resolvedClassId}"`
        );

        const data = await getStudentHomework({
          schoolId:  String(schoolId),
          studentId: String(userId),
          classId:   resolvedClassId ?? undefined,
        });

        console.log(`[StudentHomework] loaded ${data.length} items`);

        if (isMounted.current) {
          setHomework(data ?? []);
          hasLoaded.current = true;
        }
      } catch (err) {
        console.warn("[StudentHomework] load error:", err.message);
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [schoolId, userId]
  );

  useEffect(() => {
    if (schoolId && userId) {
      loadData();
    }
  }, [loadData]);

  const handleSubmitted = useCallback((homeworkId, text) => {
    const now = new Date().toISOString();

    const applyUpdate = (hw) =>
      hw.id === homeworkId
        ? {
            ...hw,
            submission_id:           hw.submission_id || "local",
            submission_status:       "submitted",
            submission_text:         text,
            submission_submitted_at: now,
            submission_score:        null,
          }
        : hw;

    setHomework((prev) => prev.map(applyUpdate));
    setSelectedHW((prev) => prev?.id === homeworkId ? applyUpdate(prev) : prev);
  }, []);

  const stats = useMemo(() => {
    const submitted = homework.filter((h) => !!h.submission_id).length;
    const graded    = homework.filter((h) => h.submission_score != null).length;
    const pending   = homework.filter((h) => getSubmissionStatus(h, t).type === "pending").length;
    const urgent    = homework.filter((h) => {
      const due = getDueStatus(h.due_date, h.submission_submitted_at, t);
      return due.urgent && getSubmissionStatus(h, t).type === "pending";
    }).length;
    return { total: homework.length, submitted, graded, pending, urgent };
  }, [homework, t]);

  const sorted = useMemo(() => {
    const lowerSearch = search.toLowerCase();

    const filtered = homework.filter((hw) => {
      const sub = getSubmissionStatus(hw, t);

      const matchSearch =
        !search ||
        hw.title.toLowerCase().includes(lowerSearch) ||
        (hw.subject_name ?? "").toLowerCase().includes(lowerSearch);

      const matchFilter =
        activeFilter === "all"       ? true :
        activeFilter === "pending"   ? sub.type === "pending"   :
        activeFilter === "submitted" ? sub.type === "submitted"  :
        activeFilter === "graded"    ? sub.type === "graded"     :
        activeFilter === "urgent"    ?
          getDueStatus(hw.due_date, null, t).urgent && sub.type === "pending" :
        true;

      return matchSearch && matchFilter;
    });

    return [...filtered].sort((a, b) => {
      const aUrgent = getDueStatus(a.due_date, null, t).urgent && !a.submission_id;
      const bUrgent = getDueStatus(b.due_date, null, t).urgent && !b.submission_id;
      if (aUrgent && !bUrgent) return -1;
      if (!aUrgent && bUrgent) return  1;
      if (!a.due_date && b.due_date) return  1;
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && !b.due_date) return 0;
      return new Date(a.due_date) - new Date(b.due_date);
    });
  }, [search, homework, t, activeFilter]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("studentHw.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("studentHw.listTitle")}</Text>
          <Text style={styles.headerSub}>
            {stats.pending > 0
              ? `${stats.pending} pending · ${stats.submitted} submitted`
              : `${stats.total} assignment${stats.total !== 1 ? "s" : ""}`}
          </Text>
        </View>
      </View>

      {/* Urgent banner */}
      {stats.urgent > 0 && (
        <TouchableOpacity
          style={styles.urgentBanner}
          onPress={() => setActiveFilter("urgent")}
          activeOpacity={0.8}
        >
          <Ionicons name="warning" size={18} color="#DC2626" />
          <Text style={styles.urgentBannerText}>
            {stats.urgent} assignment{stats.urgent !== 1 ? "s" : ""} due very soon!
          </Text>
          <Text style={styles.urgentBannerLink}>{t("studentHw.viewArrow")}</Text>
        </TouchableOpacity>
      )}

      {/* Stats row */}
      <View style={styles.statsRow}>
        {[
          { label: t("common.total"),     value: stats.total,     color: "#4F46E5", bg: "#EEF2FF" },
          { label: t("studentHome.hwPending"),   value: stats.pending,   color: "#D97706", bg: "#FEF3C7" },
          { label: t("studentHome.hwSubmitted"), value: stats.submitted, color: "#059669", bg: "#ECFDF5" },
          { label: t("studentHw.graded"),    value: stats.graded,    color: "#7C3AED", bg: "#F5F3FF" },
        ].map((s) => (
          <View key={s.label} style={[styles.statCard, { backgroundColor: s.bg }]}>
            <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
            <Text style={styles.statLabel}>{s.label}</Text>
          </View>
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#9CA3AF" />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={t("studentHw.searchPh")}
          placeholderTextColor="#9CA3AF"
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {[
          { id: "all",       label: `All (${stats.total})`            },
          { id: "pending",   label: `Pending (${stats.pending})`      },
          { id: "urgent",    label: `⚡ Urgent (${stats.urgent})`     },
          { id: "submitted", label: `Submitted (${stats.submitted})`  },
          { id: "graded",    label: `Graded (${stats.graded})`        },
        ].map((f) => (
          <TouchableOpacity
            key={f.id}
            style={[
              styles.filterChip,
              activeFilter === f.id && styles.filterChipActive,
              f.id === "urgent" && stats.urgent > 0 && styles.filterChipUrgent,
            ]}
            onPress={() => setActiveFilter(f.id)}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFilter === f.id  && styles.filterChipTextActive,
                f.id === "urgent" && stats.urgent > 0 && styles.filterChipTextUrgent,
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* List */}
      <FlatList
        data={sorted}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        maxToRenderPerBatch={8}
        windowSize={10}
        removeClippedSubviews={Platform.OS === "android"}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        renderItem={({ item }) => (
          <HomeworkCard item={item} onPress={setSelectedHW} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={56} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>
              {activeFilter === "all"
                ? "No homework yet"
                : `No ${activeFilter} homework`}
            </Text>
            <Text style={styles.emptySubtitle}>
              {activeFilter === "all"
                ? t("studentHw.emptySub")
                : t("studentHw.emptyFilterSub")}
            </Text>
          </View>
        }
      />

      {/* Submit Modal */}
      <SubmitModal
        homework={selectedHW}
        userId={userId}
        onClose={() => setSelectedHW(null)}
        onSubmitted={handleSubmitted}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// MODAL STYLES
// ─────────────────────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  headerTitle: {
    flex: 1, fontSize: 17, fontWeight: "700", color: "#111827",
    textAlign: "center", marginHorizontal: 8,
  },
  content: { padding: 16, paddingBottom: 32 },
  infoGrid:  { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  infoCard: {
    width: "48%", borderRadius: 12,
    padding: 12, alignItems: "center", gap: 4,
  },
  infoValue: { fontSize: 13, fontWeight: "700", textAlign: "center" },
  infoLabel: { fontSize: 10, color: "#6B7280" },
  descBox: {
    backgroundColor: "#FFF", borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  descLabel: { fontSize: 11, fontWeight: "600", color: "#9CA3AF", marginBottom: 4 },
  descText:  { fontSize: 14, color: "#374151", lineHeight: 20 },
  instructBox: {
    backgroundColor: "#EEF2FF", borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  instructHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  instructTitle:  { fontSize: 13, fontWeight: "700", color: "#4F46E5" },
  instructText:   { fontSize: 13, color: "#374151", lineHeight: 20 },
  statusBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 12, padding: 12, marginBottom: 10,
  },
  statusText: { fontSize: 14, fontWeight: "600" },
  gradeBox: {
    backgroundColor: "#ECFDF5", borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  gradeRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8,
  },
  gradeScore: { fontSize: 22, fontWeight: "800", color: "#059669" },
  gradePct:   { fontSize: 14, color: "#059669", fontWeight: "500" },
  feedbackBox: {
    backgroundColor: "#F0FDF4", borderRadius: 10, padding: 12,
  },
  feedbackHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  feedbackTitle:  { fontSize: 12, fontWeight: "700", color: "#059669" },
  feedbackText:   { fontSize: 13, color: "#374151", lineHeight: 20 },
  prevSubmission: {
    backgroundColor: "#F9FAFB", borderRadius: 12,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  prevSubmissionLabel: { fontSize: 11, fontWeight: "600", color: "#9CA3AF", marginBottom: 6 },
  prevSubmissionText:  { fontSize: 13, color: "#374151", lineHeight: 20 },
  prevSubmissionDate:  { fontSize: 11, color: "#9CA3AF", marginTop: 6, fontStyle: "italic" },
  responseSection: { marginBottom: 8 },
  responseLabel:   { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },
  warnBanner: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#FEE2E2", borderRadius: 8,
    padding: 8, marginBottom: 8,
    borderWidth: 1, borderColor: "#FECACA",
  },
  warnText: { flex: 1, fontSize: 12, color: "#DC2626", fontWeight: "500" },
  responseInput: {
    backgroundColor: "#FFF", borderRadius: 12,
    padding: 14, fontSize: 14, color: "#111827",
    borderWidth: 1, borderColor: "#E5E7EB",
    height: 160, textAlignVertical: "top",
  },
  charCount: { fontSize: 11, color: "#9CA3AF", textAlign: "right", marginTop: 4 },
  footer: {
    padding: 16, backgroundColor: "#FFF",
    borderTopWidth: 1, borderTopColor: "#F3F4F6",
  },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: "#FFF", fontWeight: "800", fontSize: 16 },
  gradedFooter: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#ECFDF5", borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  gradedFooterText: { fontSize: 15, fontWeight: "600", color: "#059669" },
});

// ─────────────────────────────────────────────────────────────
// MAIN STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F3F4F6" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  urgentBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#FEE2E2", paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: "#FECACA",
  },
  urgentBannerText: { flex: 1, fontSize: 13, color: "#DC2626", fontWeight: "600" },
  urgentBannerLink: { fontSize: 13, color: "#DC2626", fontWeight: "700" },
  statsRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  statCard: {
    flex: 1, borderRadius: 10,
    paddingVertical: 10, alignItems: "center", gap: 2,
  },
  statValue: { fontSize: 18, fontWeight: "800" },
  statLabel: { fontSize: 10, color: "#6B7280", fontWeight: "500" },
  searchBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF",
    marginHorizontal: 16, marginTop: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 12, gap: 8,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827", padding: 0 },
  filterRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 20, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "transparent",
  },
  filterChipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  filterChipUrgent:     { backgroundColor: "#FEE2E2", borderColor: "#FECACA" },
  filterChipText:       { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  filterChipTextActive: { color: "#4F46E5", fontWeight: "700" },
  filterChipTextUrgent: { color: "#DC2626", fontWeight: "700" },
  listContent: { padding: 16, paddingBottom: 32 },
  card: {
    backgroundColor: "#FFF", borderRadius: 16,
    padding: 14, marginBottom: 12,
    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  cardUrgent: { borderWidth: 1, borderColor: "#FECACA", backgroundColor: "#FFFAFA" },
  cardTop: {
    flexDirection: "row", alignItems: "flex-start",
    gap: 10, marginBottom: 8,
  },
  subjectIcon: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#111827" },
  cardMeta:  { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  cardDesc:  { fontSize: 12, color: "#6B7280", marginBottom: 8 },
  dueBadge: {
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 8, alignSelf: "flex-start",
  },
  dueBadgeText: { fontSize: 11, fontWeight: "700" },
  cardBottom: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: "#F3F4F6",
    marginBottom: 6,
  },
  bottomChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#F3F4F6", borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  bottomChipText: { fontSize: 11, color: "#6B7280", fontWeight: "500" },
  tapHint: { fontSize: 11, color: "#9CA3AF", fontStyle: "italic" },
  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});