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
import { StatTile } from "../../../src/components/Tiles";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// A pill's colours: a status tone or the homework's indigo, never grey.
const toneOf = (tone) => {
  const b = statusBadge(tone);
  return { color: b.text, bg: b.bg, border: b.border };
};
const INDIGO_PILL = (() => {
  const b = accentBadge("indigo");
  return { color: b.text, bg: b.bg, border: b.border };
})();

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
    return { label: t("studentHome.dueNoDeadline"), ...INDIGO_PILL, urgent: false };
  }

  const due  = new Date(dueDateStr);
  const now  = new Date();
  const diff = due - now;

  if (submittedAt) {
    const wasLate = new Date(submittedAt) > due;
    return wasLate
      ? { label: t("studentHome.dueSubmittedLate"),    ...toneOf("warning"), urgent: false }
      : { label: t("studentHome.dueSubmittedOnTime"), ...toneOf("success"), urgent: false };
  }

  if (diff < 0) {
    const hoursAgo = Math.floor(Math.abs(diff) / 3600000);
    const daysAgo  = Math.floor(Math.abs(diff) / 86400000);
    return {
      label:  daysAgo > 0 ? `${daysAgo}d overdue` : `${hoursAgo}h overdue`,
      ...toneOf("error"),
      urgent: true,
      isPast: true,
    };
  }

  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (hours < 6)  return { label: `${hours}h left`,  ...toneOf("warning"), urgent: true  };
  if (hours < 24) return { label: t("studentHome.dueToday"),        ...toneOf("warning"), urgent: true  };
  if (days === 1) return { label: t("studentHome.dueTomorrow"),     ...toneOf("warning"), urgent: false };
  if (days < 7)   return { label: `${days}d left`,   ...INDIGO_PILL, urgent: false };

  const weeks = Math.floor(days / 7);
  return { label: `${weeks}w left`, ...INDIGO_PILL, urgent: false };
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
      ...toneOf(pct >= 70 ? "success" : "error"),
      icon:  "ribbon-outline",
    };
  }

  if (hasSubmission) {
    return {
      type:  "submitted",
      label: t("studentHw.awaitingGrade"),
      ...toneOf("success"),
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
      ...toneOf("error"),
      icon:  "lock-closed-outline",
    };
  }

  return {
    type:  "pending",
    label: isPast ? t("studentHw.notSubmittedLate") : t("studentHw.notSubmitted"),
    ...(isPast ? toneOf("warning") : INDIGO_PILL),
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
        behavior="padding"
      >
        <View style={modalStyles.container}>

          {/* Header */}
          <View style={modalStyles.header}>
            <TouchableOpacity onPress={onClose} style={modalStyles.closeBtn}>
              <Ionicons name="close" size={22} color={COLORS.text} />
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
                  color: ACCENT.indigo.deep, bg: ACCENT.indigo.wash,
                },
                {
                  icon:  "star-outline",
                  label: t("studentHw.maxScore"),
                  value: homework.max_score ?? 100,
                  color: ACCENT.amber.deep, bg: ACCENT.amber.wash,
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
                  <Ionicons name="information-circle-outline" size={16} color={ACCENT.indigo.solid} />
                  <Text style={modalStyles.instructTitle}>{t("studentHw.instructions")}</Text>
                </View>
                <Text style={modalStyles.instructText}>{homework.instructions}</Text>
              </View>
            ) : null}

            {/* Submission status */}
            <View style={[modalStyles.statusBox, { backgroundColor: subStatus.bg, borderWidth: 1, borderColor: subStatus.border }]}>
              <Ionicons name={subStatus.icon} size={18} color={subStatus.color} />
              <Text style={[modalStyles.statusText, { color: subStatus.color }]}>
                {subStatus.label}
              </Text>
            </View>

            {/* Grade + feedback */}
            {isGraded && (
              <View style={modalStyles.gradeBox}>
                <View style={modalStyles.gradeRow}>
                  <Ionicons name="ribbon" size={22} color={SEMANTIC.success.icon} />
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
                      <Ionicons name="chatbubble-outline" size={14} color={SEMANTIC.success.icon} />
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
                    {t("studentHw.submittedOn", { date: formatDateTime(homework.submission_submitted_at) })}
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
                  <Text style={{ color: SEMANTIC.error.text }}> *</Text>
                </Text>

                {due.urgent && !due.isPast && (
                  <View style={modalStyles.warnBanner}>
                    <Ionicons name="warning-outline" size={14} color={SEMANTIC.error.icon} />
                    <Text style={modalStyles.warnText}>{t("studentHw.soonWarn")}</Text>
                  </View>
                )}

                {due.isPast && homework.allow_late && (
                  <View style={[modalStyles.warnBanner, { backgroundColor: SEMANTIC.warning.bg, borderColor: SEMANTIC.warning.box }]}>
                    <Ionicons name="warning-outline" size={14} color={SEMANTIC.warning.icon} />
                    <Text style={[modalStyles.warnText, { color: SEMANTIC.warning.text }]}>
                      {t("studentHw.lateWarn")}
                    </Text>
                  </View>
                )}

                <TextInput
                  style={modalStyles.responseInput}
                  value={text}
                  onChangeText={setText}
                  placeholder={t("studentHw.answerPh")}
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  numberOfLines={8}
                  textAlignVertical="top"
                />
                <Text style={modalStyles.charCount}>
                  {t("studentHw.charCount", { count: text.length })}
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
                  <ActivityIndicator size="small" color={COLORS.onPrimary} />
                ) : (
                  <>
                    <Ionicons
                      name={isResubmit ? "refresh-outline" : "send-outline"}
                      size={20}
                      color={COLORS.onPrimary}
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
                <Ionicons name="ribbon" size={20} color={SEMANTIC.success.icon} />
                <Text style={modalStyles.gradedFooterText}>
                  {t("studentHw.gradedNote")}
                </Text>
              </View>
            </View>
          )}

          {isClosed && (
            <View style={modalStyles.footer}>
              <View style={[modalStyles.gradedFooter, { backgroundColor: SEMANTIC.error.bg }]}>
                <Ionicons name="lock-closed-outline" size={20} color={SEMANTIC.error.icon} />
                <Text style={[modalStyles.gradedFooterText, { color: SEMANTIC.error.text }]}>
                  {t("studentHw.closedNote")}
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
          <View style={styles.subjectIcon}>
            <Ionicons name={subStatus.icon} size={20} color={COLORS.onPrimary} />
          </View>

          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.cardMeta}>
              {[item.subject_name, item.class_name].filter(Boolean).join("  ·  ")}
            </Text>
          </View>

          <View style={[styles.dueBadge, { backgroundColor: due.bg, borderColor: due.border }]}>
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
            <Ionicons name="star-outline" size={12} color={ACCENT.indigo.solid} />
            <Text style={styles.bottomChipText}>{item.max_score ?? 100} pts</Text>
          </View>

          {item.due_date && (
            <View style={styles.bottomChip}>
              <Ionicons name="calendar-outline" size={12} color={ACCENT.indigo.solid} />
              <Text style={styles.bottomChipText}>{formatDate(item.due_date)}</Text>
            </View>
          )}

          {item.allow_late ? (
            <View style={[styles.bottomChip, { backgroundColor: statusBadge("success").bg, borderColor: statusBadge("success").border }]}>
              <Ionicons name="checkmark-outline" size={12} color={SEMANTIC.success.text} />
              <Text style={[styles.bottomChipText, { color: SEMANTIC.success.text }]}>{t("studentHw.lateOk")}</Text>
            </View>
          ) : (
            <View style={[styles.bottomChip, { backgroundColor: statusBadge("error").bg, borderColor: statusBadge("error").border }]}>
              <Ionicons name="close-outline" size={12} color={SEMANTIC.error.text} />
              <Text style={[styles.bottomChipText, { color: SEMANTIC.error.text }]}>{t("studentHw.noLate")}</Text>
            </View>
          )}

          <View style={[styles.bottomChip, { backgroundColor: subStatus.bg, borderColor: subStatus.border }]}>
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
        <ActivityIndicator size="large" color={ACCENT.indigo.solid} />
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
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={{ marginRight: 0 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("studentHw.listTitle")}</Text>
          <Text style={styles.headerSub}>
            {stats.pending > 0
              ? t("studentHw.pendingSubmitted", { pending: stats.pending, submitted: stats.submitted })
              : t("studentHw.assignmentCount", { count: stats.total })}
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
          <Ionicons name="warning" size={18} color={SEMANTIC.error.icon} />
          <Text style={styles.urgentBannerText}>
            {t("studentHome.urgentHomework", { count: stats.urgent })}
          </Text>
          <Text style={styles.urgentBannerLink}>{t("studentHw.viewArrow")}</Text>
        </TouchableOpacity>
      )}

      {/* Stats row */}
      <View style={styles.statsRow}>
        {[
          { label: t("common.total"),     value: stats.total, },
          { label: t("studentHome.hwPending"),   value: stats.pending, },
          { label: t("studentHome.hwSubmitted"), value: stats.submitted, },
          { label: t("studentHw.graded"),    value: stats.graded, },
        ].map((s) => (
          <StatTile key={s.label} kind="homework" value={s.value} label={s.label} />
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color={COLORS.textSubtle} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={t("studentHw.searchPh")}
          placeholderTextColor={COLORS.textMuted}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color={COLORS.textSubtle} />
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
            tintColor={ACCENT.indigo.solid}
            colors={[ACCENT.indigo.solid]}
          />
        }
        renderItem={({ item }) => (
          <HomeworkCard item={item} onPress={setSelectedHW} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <IconSquare icon="document-text-outline" accent="indigo" size={56} radius={16} />
            <Text style={styles.emptyTitle}>
              {activeFilter === "all"
                ? t("studentHw.emptyNone")
                : t("studentHw.emptyFiltered")}
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
  container: { flex: 1, backgroundColor: COLORS.page },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: ACCENT.slate.wash, alignItems: "center", justifyContent: "center",
  },
  headerTitle: {
    flex: 1, fontSize: 17, fontWeight: "700", color: COLORS.text,
    textAlign: "center", marginHorizontal: 8,
  },
  content: { padding: 16, paddingBottom: 32 },
  infoGrid:  { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  infoCard: {
    width: "48%", borderRadius: 12,
    padding: 12, alignItems: "center", gap: 4,
  },
  infoValue: { fontSize: 13, fontWeight: "700", textAlign: "center" },
  infoLabel: { fontSize: 10, color: COLORS.textSecondary },
  descBox: {
    backgroundColor: COLORS.surface, borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  descLabel: { fontSize: 11, fontWeight: "600", color: COLORS.textSecondary, marginBottom: 4 },
  descText:  { fontSize: 14, color: COLORS.text, lineHeight: 20 },
  instructBox: {
    backgroundColor: ACCENT.indigo.wash, borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  instructHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  instructTitle:  { fontSize: 13, fontWeight: "700", color: ACCENT.indigo.deep },
  instructText:   { fontSize: 13, color: COLORS.text, lineHeight: 20 },
  statusBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 12, padding: 12, marginBottom: 10,
  },
  statusText: { fontSize: 14, fontWeight: "600" },
  gradeBox: {
    backgroundColor: SEMANTIC.success.bg, borderRadius: 12,
    padding: 14, marginBottom: 10,
  },
  gradeRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8,
  },
  gradeScore: { fontSize: 22, fontWeight: "800", color: SEMANTIC.success.text },
  gradePct:   { fontSize: 14, color: SEMANTIC.success.text, fontWeight: "500" },
  feedbackBox: {
    backgroundColor: COLORS.surface, borderRadius: 10, padding: 12,
  },
  feedbackHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  feedbackTitle:  { fontSize: 12, fontWeight: "700", color: SEMANTIC.success.text },
  feedbackText:   { fontSize: 13, color: COLORS.text, lineHeight: 20 },
  prevSubmission: {
    backgroundColor: COLORS.page, borderRadius: 12,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: COLORS.border,
  },
  prevSubmissionLabel: { fontSize: 11, fontWeight: "600", color: COLORS.textSecondary, marginBottom: 6 },
  prevSubmissionText:  { fontSize: 13, color: COLORS.text, lineHeight: 20 },
  prevSubmissionDate:  { fontSize: 11, color: COLORS.textSecondary, marginTop: 6, fontStyle: "italic" },
  responseSection: { marginBottom: 8 },
  responseLabel:   { fontSize: 13, fontWeight: "600", color: COLORS.text, marginBottom: 6 },
  warnBanner: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: SEMANTIC.error.bg, borderRadius: 8,
    padding: 8, marginBottom: 8,
    borderWidth: 1, borderColor: SEMANTIC.error.box,
  },
  warnText: { flex: 1, fontSize: 12, color: SEMANTIC.error.text, fontWeight: "500" },
  responseInput: {
    backgroundColor: COLORS.surface, borderRadius: 12,
    padding: 14, fontSize: 14, color: COLORS.text,
    borderWidth: 1, borderColor: COLORS.border,
    height: 160, textAlignVertical: "top",
  },
  charCount: { fontSize: 11, color: COLORS.textSecondary, textAlign: "right", marginTop: 4 },
  footer: {
    padding: 16, backgroundColor: COLORS.surface,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: ACCENT.indigo.solid, borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: COLORS.onPrimary, fontWeight: "800", fontSize: 16 },
  gradedFooter: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: SEMANTIC.success.bg, borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  gradedFooterText: { fontSize: 15, fontWeight: "600", color: SEMANTIC.success.text },
});

// ─────────────────────────────────────────────────────────────
// MAIN STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: COLORS.page },
  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: ACCENT.slate.wash, alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  urgentBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: SEMANTIC.error.bg, paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: SEMANTIC.error.box,
  },
  urgentBannerText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text, fontWeight: "600" },
  urgentBannerLink: { fontSize: 13, color: SEMANTIC.error.text, fontWeight: "700" },
  statsRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  searchBar: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: COLORS.surface,
    marginHorizontal: 16, marginTop: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 12, gap: 8,
    shadowColor: COLORS.shadow, shadowOpacity: 0.04, shadowRadius: 3, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },
  filterRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 20, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  filterChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  filterChipUrgent:     { backgroundColor: SEMANTIC.error.bg, borderColor: SEMANTIC.error.box },
  filterChipText:       { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },
  filterChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },
  filterChipTextUrgent: { color: SEMANTIC.error.text, fontWeight: "700" },
  listContent: { padding: 16, paddingBottom: 32 },
  card: {
    backgroundColor: ACCENT.indigo.wash, borderRadius: 16,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.border,
    borderTopWidth: 3, borderTopColor: ACCENT.indigo.base,
    shadowColor: COLORS.shadow, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  cardUrgent: { borderColor: SEMANTIC.error.box, borderTopColor: ACCENT.red.base, backgroundColor: ACCENT.red.wash },
  cardTop: {
    flexDirection: "row", alignItems: "flex-start",
    gap: 10, marginBottom: 8,
  },
  subjectIcon: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: ACCENT.indigo.solid,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: COLORS.text },
  cardMeta:  { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  cardDesc:  { fontSize: 12, color: COLORS.textSecondary, marginBottom: 8 },
  dueBadge: {
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 8, alignSelf: "flex-start", borderWidth: 1,
  },
  dueBadgeText: { fontSize: 11, fontWeight: "700" },
  cardBottom: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.border,
    marginBottom: 6,
  },
  bottomChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: COLORS.surface, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  bottomChipText: { fontSize: 11, color: COLORS.textSecondary, fontWeight: "500" },
  tapHint: { fontSize: 11, color: COLORS.textSecondary, fontStyle: "italic" },
  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: COLORS.text },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
});