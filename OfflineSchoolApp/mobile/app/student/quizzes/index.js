// app/student/quizzes/index.js

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Alert,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import {
  getQuizzes,
  getUserAttempts,
  checkAttemptEligibility,
} from "../../../src/services/quiz.service";
import {
  resolveStudentClassId,
} from "../../../src/services/student.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// A status pill's colours: a status tone or an entity accent, never grey.
const toneOf = (tone) => {
  const b = statusBadge(tone);
  return { color: b.text, bg: b.bg, border: b.border };
};
const accentOf = (accent) => {
  const b = accentBadge(accent);
  return { color: b.text, bg: b.bg, border: b.border };
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatTime = (minutes, t) => {
  if (!minutes) return t("studentQuiz.noLimit");
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month:  "short",
    day:    "numeric",
    hour:   "numeric",
    minute: "2-digit",
  });
};

// ✅ Normalise IDs — handles UUID vs ObjectId mismatches
const sameId = (a, b) =>
  a && b &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ─────────────────────────────────────────────────────────────
// GET QUIZ STATUS
// ✅ Shows results for attempted quizzes regardless of
//    is_published status or availability window expiry
// ─────────────────────────────────────────────────────────────

const getQuizStatus = (quiz, attempts = [], t) => {
  const now          = new Date();
  const qId          = quiz.id || quiz._id;
  const quizAttempts = attempts.filter((a) => sameId(a.quiz_id, qId));

  const submitted = quizAttempts.filter(
    (a) => a.status === "submitted" || a.status === "timed_out"
  );

  // ✅ If student has a submitted attempt, always show results
  // regardless of is_published or availability window
  if (submitted.length > 0 && !quiz.is_published) {
    const best   = Math.max(...submitted.map((a) => a.percentage || 0));
    const passed = submitted.some((a) => a.is_passed);
    return {
      label:    `Completed · ${best.toFixed(1)}%`,
      ...toneOf(passed ? "success" : "error"),
      canStart: false,
      best,
      attempts: submitted.length,
    };
  }

  if (!quiz.is_published) {
    return {
      label:    t("studentHome.quizUnavailable"),
      ...toneOf("info"),
      canStart: false,
      attempts: 0,
    };
  }

  if (quiz.available_from && now < new Date(quiz.available_from)) {
    return {
      label:    `Opens ${formatDate(quiz.available_from)}`,
      ...toneOf("warning"),
      canStart: false,
      attempts: 0,
    };
  }

  if (quiz.available_until && now > new Date(quiz.available_until)) {
    // ✅ Expired but student has attempts — show results
    if (submitted.length > 0) {
      const best   = Math.max(...submitted.map((a) => a.percentage || 0));
      const passed = submitted.some((a) => a.is_passed);
      return {
        label:    `Completed · ${best.toFixed(1)}%`,
        ...toneOf(passed ? "success" : "error"),
        canStart: false,
        best,
        attempts: submitted.length,
      };
    }
    return {
      label:    t("studentHome.quizClosed"),
      ...toneOf("error"),
      canStart: false,
      attempts: 0,
    };
  }

  // ✅ Check max attempts BEFORE in-progress
  if (quiz.max_attempts != null && submitted.length >= quiz.max_attempts) {
    const best   = submitted.length > 0
      ? Math.max(...submitted.map((a) => a.percentage || 0))
      : 0;
    const passed = submitted.some((a) => a.is_passed);
    return {
      label:    `Completed · ${best.toFixed(1)}%`,
      ...toneOf(passed ? "success" : "error"),
      canStart: false,
      best,
      attempts: submitted.length,
    };
  }

  const inProgress = quizAttempts.find((a) => a.status === "in_progress");
  if (inProgress) {
    return {
      label:    t("studentHome.quizInProgress"),
      ...toneOf("info"),
      canStart: true,
      resumeId: inProgress.id || inProgress._id,
      attempts: submitted.length,
    };
  }

  if (submitted.length > 0) {
    const best      = Math.max(...submitted.map((a) => a.percentage || 0));
    const remaining = quiz.max_attempts != null
      ? quiz.max_attempts - submitted.length
      : null;
    return {
      label:    remaining != null
        ? t("studentQuiz.attemptsLeft", { count: remaining })
        : t("studentHome.quizRetake"),
      ...accentOf("indigo"),
      canStart: true,
      best,
      attempts: submitted.length,
    };
  }

  return {
    label:    t("studentHome.quizNotStarted"),
    ...toneOf("success"),
    canStart: true,
    attempts: 0,
  };
};

// ─────────────────────────────────────────────────────────────
// START MODAL
// ─────────────────────────────────────────────────────────────

const StartModal = ({ quiz, attempts, onStart, onClose, starting }) => {
  const { t } = useTranslation();
  if (!quiz) return null;

  const qId    = quiz.id || quiz._id;
  const status = getQuizStatus(quiz, attempts, t);

  const submitted = attempts.filter(
    (a) =>
      sameId(a.quiz_id, qId) &&
      (a.status === "submitted" || a.status === "timed_out")
  );

  return (
    <Modal
      visible={!!quiz}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>

        {/* Header */}
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.modalHeaderTitle}>{t("studentQuiz.detailsTitle")}</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.modalScroll}
        >
          <Text style={styles.modalQuizTitle}>{quiz.title}</Text>

          {quiz.description ? (
            <Text style={styles.modalQuizDesc}>{quiz.description}</Text>
          ) : null}

          {/* Info grid */}
          <View style={styles.infoGrid}>
            {[
              {
                icon:  "help-circle-outline",
                label: t("studentQuiz.questions"),
                value: quiz.question_count ?? (quiz.questions?.length ?? 0),
                accent: ACCENT.indigo,
              },
              {
                icon:  "time-outline",
                label: t("studentQuiz.timeLimit"),
                value: formatTime(quiz.time_limit_minutes, t),
                accent: ACCENT.amber,
              },
              {
                icon:  "refresh-outline",
                label: t("studentQuiz.attempts"),
                value: quiz.max_attempts ?? "∞",
                accent: ACCENT.green,
              },
              {
                icon:  "ribbon-outline",
                label: t("studentQuiz.passMark"),
                value: `${quiz.passing_score ?? 70}%`,
                accent: ACCENT.violet,
              },
            ].map((item) => (
              <View
                key={item.label}
                style={[styles.infoCard, { backgroundColor: item.accent.wash, borderTopColor: item.accent.base }]}
              >
                <Ionicons name={item.icon} size={20} color={item.accent.solid} />
                <Text style={[styles.infoCardValue, { color: item.accent.deep }]}>
                  {item.value}
                </Text>
                <Text style={styles.infoCardLabel}>{item.label}</Text>
              </View>
            ))}
          </View>

          {/* Instructions */}
          {quiz.instructions ? (
            <View style={styles.instructionsBox}>
              <View style={styles.instructionsHeader}>
                <Ionicons
                  name="information-circle-outline"
                  size={18}
                  color={ACCENT.indigo.solid}
                />
                <Text style={styles.instructionsTitle}>{t("studentQuiz.instructions")}</Text>
              </View>
              <Text style={styles.instructionsText}>{quiz.instructions}</Text>
            </View>
          ) : null}

          {/* Settings */}
          <View style={styles.settingsBox}>
            {[
              {
                icon:  quiz.shuffle_questions
                  ? "shuffle-outline"
                  : "list-outline",
                label: t("studentQuiz.questions"),
                value: quiz.shuffle_questions
                  ? t("studentQuiz.shuffled")
                  : t("studentQuiz.fixedOrder"),
              },
              {
                icon:  "eye-outline",
                label: t("studentQuiz.answersShown"),
                value:
                  quiz.show_answers_after === "immediately"
                    ? t("quizCreate.feedbackImmediately")
                    : quiz.show_answers_after === "on_completion"
                    ? t("quizCreate.feedbackOnCompletion")
                    : quiz.show_answers_after === "after_deadline"
                    ? t("quizCreate.feedbackAfterDeadline")
                    : t("studentQuiz.notShown"),
              },
              {
                icon:  quiz.allow_backtrack
                  ? "arrow-back-circle-outline"
                  : "lock-closed-outline",
                label: t("studentQuiz.navigation"),
                value: quiz.allow_backtrack ? t("studentQuiz.canGoBack") : t("studentQuiz.forwardOnly"),
              },
            ].map((item) => (
              <View key={item.label} style={styles.settingRow}>
                <Ionicons name={item.icon} size={16} color={ACCENT.indigo.solid} />
                <Text style={styles.settingLabel}>{item.label}</Text>
                <Text style={styles.settingValue}>{item.value}</Text>
              </View>
            ))}
          </View>

          {/* Previous attempts */}
          {submitted.length > 0 && (
            <View style={styles.prevSection}>
              <Text style={styles.prevTitle}>{t("studentQuiz.prevAttempts")}</Text>
              {submitted.map((a, i) => {
                               return (
                <View key={a.id || i} style={[styles.prevCard, { borderLeftColor: a.is_passed ? SEMANTIC.success.icon : SEMANTIC.error.icon }]}>
                  <View style={styles.prevCardLeft}>
                    <Text style={styles.prevAttemptNum}>
                      {t("studentQuiz.attemptN", { n: a.attempt_number || i + 1 })}
                    </Text>
                    <Text style={styles.prevAttemptDate}>
                      {formatDate(a.submitted_at || a.started_at) ?? "—"}
                    </Text>
                  </View>
                  <View style={styles.prevCardRight}>
                    <Text
                      style={[
                        styles.prevScore,
                        { color: a.is_passed ? SEMANTIC.success.text : SEMANTIC.error.text },
                      ]}
                    >
                      {a.percentage != null
                        ? `${Number(a.percentage).toFixed(1)}%`
                        : "—"}
                    </Text>
                    <Text
                      style={[
                        styles.prevBadge,
                        {
                          color:           statusBadge(a.is_passed ? "success" : "error").text,
                          backgroundColor: statusBadge(a.is_passed ? "success" : "error").bg,
                          borderColor:     statusBadge(a.is_passed ? "success" : "error").border,
                        },
                      ]}
                    >
                      {a.is_passed ? t("studentQuiz.passed") : t("studentQuiz.failed")}
                    </Text>
                  </View>
                </View>
              );
                             })}
            </View>
          )}

          {/* Current status */}
          <View
            style={[styles.currentStatusBox, { backgroundColor: status.bg, borderColor: status.border }]}
          >
            <Ionicons
              name={
                status.canStart
                  ? status.resumeId
                    ? "play-circle-outline"
                    : "rocket-outline"
                  : "information-circle-outline"
              }
              size={18}
              color={status.color}
            />
            <Text style={[styles.currentStatusText, { color: status.color }]}>
              {status.label}
            </Text>
          </View>
        </ScrollView>

        {/* CTA */}
        <View style={styles.modalFooter}>
          {status.canStart ? (
            <TouchableOpacity
              style={[
                styles.startBtn,
                starting && styles.startBtnDisabled,
              ]}
              onPress={() => onStart(quiz, status.resumeId || null)}
              disabled={starting}
              activeOpacity={0.8}
            >
              {starting ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name={
                      status.resumeId
                        ? "play-circle-outline"
                        : "rocket-outline"
                    }
                    size={20}
                    color="#FFF"
                  />
                  <Text style={styles.startBtnText}>
                    {status.resumeId ? t("studentQuiz.resumeCta") : t("studentQuiz.startCta")}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <View style={styles.closedBtn}>
              <Ionicons
                name={
                  (status.attempts ?? 0) > 0
                    ? "checkmark-circle-outline"
                    : "lock-closed-outline"
                }
                size={18}
                color={COLORS.textSecondary}
              />
              <Text style={styles.closedBtnText}>{status.label}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function StudentQuizzesScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  // ✅ Select primitives directly — stable across renders
  const schoolId = useAuthStore((s) => s.user?.schoolId);
  const userId   = useAuthStore(
    (s) => s.user?._id || s.user?.id || s.user?.userId
  );

  const [quizzes,      setQuizzes]      = useState([]);
  const [attempts,     setAttempts]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const [starting,     setStarting]     = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ── Load data ─────────────────────────────────────────────

  const loadData = useCallback(
    async (isRefresh = false) => {
      if (!schoolId || !userId) {
        setLoading(false);
        return;
      }

      try {
        if (isRefresh) setRefreshing(true);
        else           setLoading(true);

        // ✅ Pass both userId AND schoolId — correct signature
        const classId = await resolveStudentClassId(userId, schoolId);

        console.log(
          `[StudentQuizzes] loading —`,
          `userId="${userId}"`,
          `schoolId="${schoolId}"`,
          `classId="${classId}"`
        );

        const [quizData, attemptData] = await Promise.all([
          getQuizzes({
            schoolId,
            student_id: userId,
            class_id:   classId,
          }),
          getUserAttempts(userId),
        ]);

        console.log(
          `[StudentQuizzes] loaded ${quizData?.length ?? 0} quizzes,`,
          `${attemptData?.length ?? 0} attempts`
        );

        if (isMounted.current) {
          setQuizzes(quizData    ?? []);
          setAttempts(attemptData ?? []);
        }
      } catch (err) {
        console.warn("[StudentQuizzes] load error:", err.message);
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [schoolId, userId]
  );

  useEffect(() => { loadData(); }, [loadData]);

  // ── Pre-compute statuses ──────────────────────────────────

  const quizzesWithStatus = quizzes.map((quiz) => ({
    quiz,
    status: getQuizStatus(quiz, attempts, t),
  }));

  // ✅ Completed = any quiz with at least 1 submission
  const counts = {
    all:       quizzesWithStatus.length,
    available: quizzesWithStatus.filter((q) =>  q.status.canStart).length,
    completed: quizzesWithStatus.filter((q) => (q.status.attempts ?? 0) > 0).length,
  };

  const filteredQuizzes = quizzesWithStatus.filter(({ quiz, status }) => {
    if (activeFilter === "available") return status.canStart;
    if (activeFilter === "completed") return (status.attempts ?? 0) > 0;
    return true;
  });

  // ── Start / resume ────────────────────────────────────────

  const handleStart = async (quiz, resumeAttemptId = null) => {
    setStarting(true);
    try {
      if (resumeAttemptId) {
        setSelectedQuiz(null);
        router.push({
          pathname: "/student/quizzes/attempt",
          params:   {
            attemptId: resumeAttemptId,
            quizId:    quiz.id || quiz._id,
          },
        });
        return;
      }

      const { canAttempt, reason } = await checkAttemptEligibility(
        quiz.id || quiz._id,
        userId
      );

      if (!canAttempt) {
        Alert.alert(t("studentQuiz.cannotStart"), reason || t("studentQuiz.cannotStartBody"));
        return;
      }

      setSelectedQuiz(null);
      router.push({
        pathname: "/student/quizzes/attempt",
        params:   { quizId: quiz.id || quiz._id },
      });
    } catch (err) {
      console.warn("[StudentQuizzes] start error:", err.message);
      Alert.alert(t("studentQuiz.errTitle"), t("studentQuiz.startFailedRetry"));
    } finally {
      setStarting(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.indigo.solid} />
        <Text style={styles.loadingText}>{t("studentQuiz.loading")}</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={{ marginRight: 0 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("studentQuiz.listTitle")}</Text>
          <Text style={styles.headerSub}>
            {counts.all} quiz{counts.all !== 1 ? "zes" : ""} available
          </Text>
        </View>
      </View>

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {[
          { id: "all",       label: `All (${counts.all})`             },
          { id: "available", label: `Available (${counts.available})` },
          { id: "completed", label: `Completed (${counts.completed})` },
        ].map((f) => (
          <TouchableOpacity
            key={f.id}
            style={[
              styles.filterChip,
              activeFilter === f.id && styles.filterChipActive,
            ]}
            onPress={() => setActiveFilter(f.id)}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFilter === f.id && styles.filterChipTextActive,
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor={ACCENT.indigo.solid}
            colors={[ACCENT.indigo.solid]}
          />
        }
      >
        {filteredQuizzes.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSquare icon="help-circle-outline" accent="indigo" size={56} radius={16} />
            <Text style={styles.emptyTitle}>
              {activeFilter === "completed"
                ? t("studentQuiz.emptyDone")
                : activeFilter === "available"
                ? t("studentQuiz.emptyAvail")
                : t("studentQuiz.emptyNone")}
            </Text>
            <Text style={styles.emptySubtitle}>
              {activeFilter === "completed"
                ? t("studentQuiz.emptyDoneSub")
                : t("studentQuiz.emptyAvailSub")}
            </Text>
          </View>
        ) : (
          filteredQuizzes.map(({ quiz, status }) => {
                                return (
            <TouchableOpacity
              key={quiz.id || quiz._id}
              style={styles.quizCard}
              onPress={() => setSelectedQuiz(quiz)}
              activeOpacity={0.7}
            >
              {/* Top row */}
              <View style={styles.quizCardTop}>
                <View style={styles.quizIconWrap}>
                  <Ionicons
                    name={
                      (status.attempts ?? 0) > 0
                        ? status.canStart
                          ? "refresh-circle"
                          : "checkmark-circle"
                        : "help-circle"
                    }
                    size={24}
                    color={COLORS.onPrimary}
                  />
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={styles.quizTitle} numberOfLines={1}>
                    {quiz.title}
                  </Text>
                  {(quiz.subject_name || quiz.class_name) ? (
                    <Text style={styles.quizMeta}>
                      {[quiz.subject_name, quiz.class_name]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </Text>
                  ) : null}
                </View>

                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: status.bg, borderColor: status.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusBadgeText,
                      { color: status.color },
                    ]}
                  >
                    {status.label}
                  </Text>
                </View>
              </View>

              {/* Bottom row */}
              <View style={styles.quizCardBottom}>
                {[
                  {
                    icon:  "help-circle-outline",
                    label: `${quiz.question_count ?? (quiz.questions?.length ?? 0)} Qs`,
                  },
                  {
                    icon:  "time-outline",
                    label: formatTime(quiz.time_limit_minutes, t),
                  },
                  {
                    icon:  "ribbon-outline",
                    label: `Pass: ${quiz.passing_score ?? 70}%`,
                  },
                ].map((item) => (
                  <View key={item.label} style={styles.quizInfoChip}>
                    <Ionicons name={item.icon} size={13} color={ACCENT.indigo.solid} />
                    <Text style={styles.quizInfoChipText}>{item.label}</Text>
                  </View>
                ))}

                {/* Attempts chip */}
                {(status.attempts ?? 0) > 0 && (
                  <View
                    style={[
                      styles.quizInfoChip,
                      { backgroundColor: accentBadge("indigo").bg, borderColor: accentBadge("indigo").border },
                    ]}
                  >
                    <Ionicons
                      name="refresh-outline"
                      size={13}
                      color={ACCENT.indigo.deep}
                    />
                    <Text
                      style={[
                        styles.quizInfoChipText,
                        { color: ACCENT.indigo.deep },
                      ]}
                    >
                      {t("quizList.attemptCount", { count: status.attempts })}
                    </Text>
                  </View>
                )}

                {/* Best score chip */}
                {status.best !== undefined && (
                  <View
                    style={[
                      styles.bestScoreBadge,
                      {
                        backgroundColor:
                          status.best >= (quiz.passing_score ?? 70)
                            ? SEMANTIC.success.bg
                            : SEMANTIC.error.bg,
                        borderColor:
                          status.best >= (quiz.passing_score ?? 70)
                            ? statusBadge("success").border
                            : statusBadge("error").border,
                      },
                    ]}
                  >
                    <Ionicons
                      name="stats-chart"
                      size={11}
                      color={
                        status.best >= (quiz.passing_score ?? 70)
                          ? SEMANTIC.success.text
                          : SEMANTIC.error.text
                      }
                    />
                    <Text
                      style={[
                        styles.bestScoreText,
                        {
                          color:
                            status.best >= (quiz.passing_score ?? 70)
                              ? SEMANTIC.success.text
                              : SEMANTIC.error.text,
                        },
                      ]}
                    >
                      {t("studentQuiz.best", { value: status.best.toFixed(1) })}
                    </Text>
                  </View>
                )}
              </View>

              {/* Tap hint */}
              <View style={styles.quizCardFooter}>
                <Text style={styles.tapHint}>
                  {status.canStart
                    ? status.resumeId
                      ? t("studentQuiz.tapResume")
                      : (status.attempts ?? 0) > 0
                      ? t("studentQuiz.tapRetake")
                      : t("studentQuiz.tapDetails")
                    : (status.attempts ?? 0) > 0
                    ? t("studentQuiz.tapResults")
                    : ""}
                </Text>
              </View>
            </TouchableOpacity>
          );
                              })
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Start Modal */}
      <StartModal
        quiz={selectedQuiz}
        attempts={attempts}
        onStart={handleStart}
        onClose={() => setSelectedQuiz(null)}
        starting={starting}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
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
  backButton: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: ACCENT.slate.wash,
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },

  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  filterChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  filterChipText:       { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  filterChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  listContent: { padding: 16 },

  quizCard: {
    backgroundColor: ACCENT.indigo.wash, borderRadius: 16,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.border,
    borderTopWidth: 3, borderTopColor: ACCENT.indigo.base,
    shadowColor: COLORS.shadow, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  quizCardTop: {
    flexDirection: "row", alignItems: "flex-start",
    gap: 10, marginBottom: 10,
  },
  quizIconWrap: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: ACCENT.indigo.solid,
    alignItems: "center", justifyContent: "center",
  },
  quizTitle:  { fontSize: 15, fontWeight: "700", color: COLORS.text },
  quizMeta:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  statusBadge: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, alignSelf: "flex-start", borderWidth: 1,
  },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },

  quizCardBottom: {
    flexDirection: "row", alignItems: "center",
    flexWrap: "wrap", gap: 6,
    paddingTop: 10,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  quizInfoChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    backgroundColor: COLORS.surface, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  quizInfoChipText: { fontSize: 11, color: COLORS.textSecondary, fontWeight: "500" },

  bestScoreBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1,
  },
  bestScoreText: { fontSize: 11, fontWeight: "700" },

  quizCardFooter: { marginTop: 8 },
  tapHint:        { fontSize: 11, color: COLORS.textSecondary, fontStyle: "italic" },

  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 24, gap: 10,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: COLORS.text },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },

  // ── Modal ─────────────────────────────────────────────────
  modalContainer: { flex: 1, backgroundColor: COLORS.page },
  modalHeader: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  modalClose: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: ACCENT.slate.wash,
    alignItems: "center", justifyContent: "center",
  },
  modalHeaderTitle: { fontSize: 17, fontWeight: "700", color: COLORS.text },
  modalScroll:      { padding: 16, paddingBottom: 32 },
  modalQuizTitle:   { fontSize: 22, fontWeight: "800", color: COLORS.text, marginBottom: 6 },
  modalQuizDesc:    { fontSize: 14, color: COLORS.textSecondary, lineHeight: 20, marginBottom: 16 },

  infoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  infoCard: {
    width: "48%", borderRadius: 14,
    padding: 14, alignItems: "center", gap: 6,
    borderWidth: 1, borderColor: COLORS.border, borderTopWidth: 3,
  },
  infoCardValue: { fontSize: 20, fontWeight: "800" },
  infoCardLabel: { fontSize: 12, color: COLORS.textSecondary },

  instructionsBox: {
    backgroundColor: ACCENT.indigo.wash, borderRadius: 12,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.border, borderLeftWidth: 3, borderLeftColor: ACCENT.indigo.base,
  },
  instructionsHeader: {
    flexDirection: "row", alignItems: "center",
    gap: 6, marginBottom: 6,
  },
  instructionsTitle: { fontSize: 14, fontWeight: "700", color: ACCENT.indigo.deep },
  instructionsText:  { fontSize: 13, color: COLORS.text, lineHeight: 20 },

  settingsBox: {
    backgroundColor: COLORS.surface, borderRadius: 12,
    padding: 14, marginBottom: 16, gap: 10,
    borderWidth: 1, borderColor: COLORS.border,
  },
  settingRow:   { flexDirection: "row", alignItems: "center", gap: 8 },
  settingLabel: { fontSize: 13, color: COLORS.textSecondary, flex: 1 },
  settingValue: { fontSize: 13, fontWeight: "600", color: COLORS.text },

  currentStatusBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 12, padding: 12, marginTop: 4, borderWidth: 1,
  },
  currentStatusText: { fontSize: 14, fontWeight: "600" },

  prevSection:     { marginBottom: 16 },
  prevTitle:       { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 8 },
  prevCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: COLORS.surface, borderRadius: 10,
    padding: 12, marginBottom: 6,
    borderWidth: 1, borderColor: COLORS.border, borderLeftWidth: 3,
  },
  prevCardLeft:    { flex: 1 },
  prevAttemptNum:  { fontSize: 13, fontWeight: "600", color: COLORS.text },
  prevAttemptDate: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  prevCardRight:   { alignItems: "flex-end", gap: 4 },
  prevScore:       { fontSize: 18, fontWeight: "800" },
  prevBadge: {
    fontSize: 10, fontWeight: "700",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1,
  },

  modalFooter: {
    padding: 16, backgroundColor: COLORS.surface,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  startBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: ACCENT.indigo.solid, borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  startBtnDisabled: { opacity: 0.6 },
  startBtnText:     { color: COLORS.onPrimary, fontWeight: "800", fontSize: 16 },
  closedBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: ACCENT.slate.wash, borderRadius: 14,
    paddingVertical: 16, gap: 8,
  },
  closedBtnText: { color: COLORS.textSecondary, fontWeight: "600", fontSize: 15 },
});