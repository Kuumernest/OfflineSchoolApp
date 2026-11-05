// app/student/quizzes/attempt.js

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import {
  startAttempt,
  saveAnswer,
  submitAttempt,
  timeoutAttempt,
  getAttemptResult,
  toggleFlag,
  getAttemptProgress,
} from "../../../src/services/quiz.service";

import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatSeconds = (secs) => {
  if (!secs && secs !== 0) return "--:--";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const QUESTION_TYPE_KEYS = {
  multiple_choice:   "studentQuiz.typeSingle",
  multiple_select:   "studentQuiz.typeMultiple",
  true_false:        "quizCreate.typeTrueFalse",
  fill_in_the_blank: "quizCreate.typeFillBlank",
  matching:          "studentQuiz.typeMatching",
};

// ─────────────────────────────────────────────────────────────
// TIMER COMPONENT
// ─────────────────────────────────────────────────────────────

const Timer = ({ totalSeconds, onExpire, paused }) => {
  const [remaining, setRemaining] = useState(totalSeconds);
  const intervalRef               = useRef(null);
  const pulseAnim                 = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (paused) return;
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(intervalRef.current);
          onExpire();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [paused]);

  // Pulse animation when < 60 seconds
  useEffect(() => {
    if (remaining < 60 && remaining > 0) {
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue:  1.05,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue:  1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [remaining]);

  const isWarning  = remaining < 300; // < 5 min
  const isDanger   = remaining < 60;  // < 1 min
  const percentage = totalSeconds > 0 ? remaining / totalSeconds : 1;

  return (
    <Animated.View
      style={[
        styles.timer,
        isWarning && styles.timerWarning,
        isDanger  && styles.timerDanger,
        { transform: [{ scale: pulseAnim }] },
      ]}
    >
      <Ionicons
        name="time-outline"
        size={14}
        color={isDanger ? SEMANTIC.error.icon : isWarning ? SEMANTIC.warning.icon : ACCENT.indigo.solid}
      />
      <Text
        style={[
          styles.timerText,
          isWarning && styles.timerTextWarning,
          isDanger  && styles.timerTextDanger,
        ]}
      >
        {formatSeconds(remaining)}
      </Text>
    </Animated.View>
  );
};

// ─────────────────────────────────────────────────────────────
// PROGRESS BAR
// ─────────────────────────────────────────────────────────────

const ProgressBar = ({ current, total }) => {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <View style={styles.progressBar}>
      <View style={[styles.progressFill, { width: `${pct}%` }]} />
    </View>
  );
};

// ─────────────────────────────────────────────────────────────
// QUESTION NAV GRID
// ─────────────────────────────────────────────────────────────

const QuestionNavGrid = ({
  questions,
  currentIndex,
  answers,
  flagged,
  onJump,
  onClose,
}) => {
                          const { t } = useTranslation();
                          return (
  <View style={styles.navGrid}>
    <View style={styles.navGridHeader}>
      <Text style={styles.navGridTitle}>{t("studentQuiz.jumpTo")}</Text>
      <TouchableOpacity onPress={onClose} style={styles.navGridClose}>
        <Ionicons name="close" size={20} color={COLORS.text} />
      </TouchableOpacity>
    </View>

    {/* Legend */}
    <View style={styles.navLegend}>
      {[
        { color: ACCENT.indigo.solid,  labelKey: "studentQuiz.current"  },
        { color: SEMANTIC.success.icon, labelKey: "studentQuiz.answered" },
        { color: ACCENT.amber.base,    labelKey: "studentQuiz.flagged"  },
        { color: COLORS.border,        labelKey: "studentQuiz.skipped"  },
      ].map((l) => (
        <View key={l.label} style={styles.navLegendItem}>
          <View style={[styles.navLegendDot, { backgroundColor: l.color }]} />
          <Text style={styles.navLegendText}>{l.label}</Text>
        </View>
      ))}
    </View>

    <View style={styles.navGridButtons}>
      {questions.map((q, i) => {
        const qId       = q.id || q._id;
        const isAnswered= !!answers[qId];
        const isFlagged = flagged.has(qId);
        const isCurrent = i === currentIndex;

        let bg    = ACCENT.slate.wash;
        let color = COLORS.text;
        if (isCurrent)  { bg = ACCENT.indigo.solid; color = COLORS.onPrimary; }
        else if (isFlagged)  { bg = SEMANTIC.warning.box; color = SEMANTIC.warning.text; }
        else if (isAnswered) { bg = SEMANTIC.success.box; color = SEMANTIC.success.text; }

        return (
          <TouchableOpacity
            key={i}
            style={[styles.navGridBtn, { backgroundColor: bg }]}
            onPress={() => {
              onJump(i);
              onClose();
            }}
          >
            <Text style={[styles.navGridBtnText, { color }]}>
              {i + 1}
            </Text>
            {isFlagged && (
              <View style={styles.navFlagDot} />
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  </View>
);
                        };

// ─────────────────────────────────────────────────────────────
// RESULT SCREEN
// ─────────────────────────────────────────────────────────────

const ResultScreen = ({ result, quiz, onClose }) => {
  const { t } = useTranslation();
  const [showAnswers, setShowAnswers] = useState(false);

  const attempt  = result?.attempt;
  const isPassed = attempt?.is_passed;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.resultScroll}
      >
        {/* Pass / Fail banner */}
        <View
          style={[
            styles.resultBanner,
            { backgroundColor: isPassed ? ACCENT.green.solid : ACCENT.red.solid },
          ]}
        >
          <Ionicons
            name={isPassed ? "checkmark-circle" : "close-circle"}
            size={56}
            color={COLORS.onPrimary}
          />
          <Text style={styles.resultBannerTitle}>
            {isPassed ? t("studentQuiz.passedTitle") : t("studentQuiz.failedTitle")}
          </Text>
          <Text style={styles.resultBannerSub}>
            {isPassed ? t("studentQuiz.passedSub") : t("studentQuiz.failedSub")}
          </Text>
        </View>

        {/* Score */}
        {attempt?.show_score !== false && (
          <View style={styles.scoreCard}>
            <Text style={styles.scoreLabel}>{t("studentQuiz.yourScore")}</Text>
            <Text
              style={[
                styles.scoreValue,
                { color: isPassed ? SEMANTIC.success.text : SEMANTIC.error.text },
              ]}
            >
              {attempt?.percentage?.toFixed(1) ?? "0"}%
            </Text>
            <Text style={styles.scoreDetail}>
              {attempt?.raw_score?.toFixed(1) ?? 0} /{" "}
              {attempt?.max_score?.toFixed(1) ?? 0} points
            </Text>
            <View style={styles.scorePassMark}>
              <Text style={styles.scorePassMarkText}>
                {t("studentQuiz.passMarkValue", { value: quiz?.passing_score ?? 70 })}
              </Text>
            </View>
          </View>
        )}

        {/* Stats */}
        <View style={styles.resultStats}>
          {[
            {
              icon:  "time-outline",
              labelKey: "studentQuiz.timeTaken",
              value: attempt?.time_taken_secs
                ? formatSeconds(attempt.time_taken_secs)
                : "—",
              accent: ACCENT.indigo,
            },
            {
              icon:  "help-circle-outline",
              labelKey: "studentQuiz.questions",
              value: attempt?.answers?.length ?? 0,
              accent: ACCENT.amber,
            },
            {
              icon:  "checkmark-circle-outline",
              labelKey: "studentQuiz.correct",
              value: (attempt?.answers || []).filter((a) => a.is_correct).length,
              accent: ACCENT.green,
            },
            {
              icon:  "close-circle-outline",
              labelKey: "studentQuiz.incorrect",
              value: (attempt?.answers || []).filter(
                (a) => a.is_correct === false
              ).length,
              accent: ACCENT.red,
            },
          ].map((s) => (
            <View
              key={s.label}
              style={[styles.resultStatCard, { backgroundColor: s.accent.wash, borderTopColor: s.accent.base }]}
            >
              <Ionicons name={s.icon} size={20} color={s.accent.solid} />
              <Text style={[styles.resultStatValue, { color: s.accent.deep }]}>
                {s.value}
              </Text>
              <Text style={styles.resultStatLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Answer review */}
        {attempt?.show_answers_after !== "never" && (
          <TouchableOpacity
            style={styles.reviewToggle}
            onPress={() => setShowAnswers((v) => !v)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={showAnswers ? "chevron-up" : "chevron-down"}
              size={18}
              color={ACCENT.indigo.deep}
            />
            <Text style={styles.reviewToggleText}>
              {showAnswers ? t("studentQuiz.hideAnswers") : t("studentQuiz.reviewAnswers")}
            </Text>
          </TouchableOpacity>
        )}

        {showAnswers &&
          (attempt?.answers || []).map((answer, i) => {
            const question = answer.question;
            if (!question) return null;

            return (
              <View key={i} style={[styles.reviewCard, { borderLeftColor: answer.is_correct ? SEMANTIC.success.icon : SEMANTIC.error.icon }]}>
                {/* Question header */}
                <View style={styles.reviewCardHeader}>
                  <View
                    style={[
                      styles.reviewCorrectIcon,
                      {
                        backgroundColor:
                          answer.is_correct ? SEMANTIC.success.box : SEMANTIC.error.box,
                      },
                    ]}
                  >
                    <Ionicons
                      name={
                        answer.is_correct
                          ? "checkmark-circle"
                          : "close-circle"
                      }
                      size={18}
                      color={answer.is_correct ? SEMANTIC.success.icon : SEMANTIC.error.icon}
                    />
                  </View>
                  <Text style={styles.reviewQNum}>Q{i + 1}</Text>
                  <Text style={styles.reviewPoints}>
                    {answer.points_earned?.toFixed(1) ?? 0} /{" "}
                    {answer.points_possible?.toFixed(1) ?? 0} pts
                  </Text>
                </View>

                <Text style={styles.reviewQText}>
                  {question.question_text}
                </Text>

                {/* Options */}
                {(question.options || []).map((opt, j) => {
                  const optId       = String(opt._id || opt.id || j);
                  const wasSelected =
                    String(answer.selected_option_id) === optId ||
                    (answer.selections || []).some(
                      (s) => String(s.selected_option_id) === optId
                    );

                  return (
                    <View
                      key={j}
                      style={[
                        styles.reviewOption,
                        opt.is_correct && styles.reviewOptionCorrect,
                        wasSelected && !opt.is_correct && styles.reviewOptionWrong,
                      ]}
                    >
                      <Ionicons
                        name={
                          opt.is_correct
                            ? "checkmark-circle"
                            : wasSelected
                            ? "close-circle"
                            : "ellipse-outline"
                        }
                        size={16}
                        color={
                          opt.is_correct
                            ? SEMANTIC.success.icon
                            : wasSelected
                            ? SEMANTIC.error.icon
                            : COLORS.textMuted
                        }
                      />
                      <Text
                        style={[
                          styles.reviewOptionText,
                          opt.is_correct && { color: SEMANTIC.success.text, fontWeight: "600" },
                          wasSelected && !opt.is_correct && { color: SEMANTIC.error.text },
                        ]}
                      >
                        {opt.option_text}
                      </Text>
                    </View>
                  );
                })}

                {/* Fill in blank answer */}
                {question.question_type === "fill_in_the_blank" &&
                  answer.text_answer && (
                    <View style={styles.fillAnswerRow}>
                      <Text style={styles.fillAnswerLabel}>{t("studentQuiz.yourAnswerColon")}</Text>
                      <Text
                        style={[
                          styles.fillAnswerText,
                          {
                            color: answer.is_correct
                              ? SEMANTIC.success.text
                              : SEMANTIC.error.text,
                          },
                        ]}
                      >
                        {answer.text_answer}
                      </Text>
                    </View>
                  )}

                {/* Explanation */}
                {attempt.show_explanation !== false &&
                  question.explanation && (
                    <View style={styles.explanationBox}>
                      <Text style={styles.explanationLabel}>
                        💡 Explanation
                      </Text>
                      <Text style={styles.explanationText}>
                        {question.explanation}
                      </Text>
                    </View>
                  )}
              </View>
            );
          })}

        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Footer */}
      <View style={styles.resultFooter}>
        <TouchableOpacity
          style={styles.doneBtn}
          onPress={onClose}
          activeOpacity={0.8}
        >
          <Ionicons name="home-outline" size={18} color={COLORS.onPrimary} />
          <Text style={styles.doneBtnText}>{t("common.done")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function AttemptScreen() {
  const { t } = useTranslation();
  const router  = useRouter();
  const params  = useLocalSearchParams();
  const user    = useAuthStore((s) => s.user);

  const userId  = user?._id || user?.id || user?.userId;
  const quizId  = params?.quizId     || null;
  const initAttemptId = params?.attemptId || null;

  // ── State ────────────────────────────────────────────────
  const [phase,         setPhase]         = useState("loading");
  // phases: loading | quiz | result

  const [session,       setSession]       = useState(null);
  const [attemptId,     setAttemptId]     = useState(initAttemptId);
  const [currentIndex,  setCurrentIndex]  = useState(0);
  const [answers,       setAnswers]       = useState({});
  const [flagged,       setFlagged]       = useState(new Set());
  const [showNav,       setShowNav]       = useState(false);
  const [submitting,    setSubmitting]    = useState(false);
  const [result,        setResult]        = useState(null);
  const [timerPaused,   setTimerPaused]   = useState(false);
  const [questionStart, setQuestionStart] = useState(Date.now());

  const scrollRef = useRef(null);

  // ── Start or resume attempt ──────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        // Resume existing attempt
        if (initAttemptId) {
          const progress = await getAttemptProgress(initAttemptId);
          if (progress?.attempt?.status === "submitted") {
            const res = await getAttemptResult(initAttemptId);
            setResult(res);
            setPhase("result");
            return;
          }
          // Re-fetch session data for resume
          // (In a real app you'd store session locally)
        }

        // Start new attempt
        const newSession = await startAttempt(quizId, userId);
        setSession(newSession);
        setAttemptId(newSession.attemptId);
        setPhase("quiz");
      } catch (err) {
        console.warn("Failed to init attempt:", err.message);
        Alert.alert(
          t("studentQuiz.errTitle"),
          errorText(t, err, "studentQuiz.startFailed"),
          [{ text: t("common.goBack"), onPress: () => router.back() }]
        );
      }
    };

    init();
  }, []);

  // ── Track app state (tab switches) ──────────────────────
  useEffect(() => {
    if (phase !== "quiz") return;

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        setTimerPaused(false); // Timer keeps running even if app backgrounds
        // In production: log tab_switch to attempt
      }
    });

    return () => sub.remove();
  }, [phase]);

  // ── Derived ──────────────────────────────────────────────
  const questions    = session?.questions || [];
  const currentQ     = questions[currentIndex] || null;
  const currentQId   = currentQ ? (currentQ.id || currentQ._id) : null;
  const currentAnswer= currentQId ? answers[currentQId] : null;

  const answeredCount = Object.keys(answers).length;
  const totalQ        = questions.length;

  // ── Save answer locally ──────────────────────────────────
  const handleSelectOption = useCallback(
    async (optionId) => {
      if (!currentQId || !attemptId) return;

      const type = currentQ.question_type;

      let newAnswer;

      if (type === "multiple_select") {
        const existing = answers[currentQId]?.selected_option_ids || [];
        const updated  = existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId];
        newAnswer = { selected_option_ids: updated };
      } else {
        newAnswer = { selected_option_id: optionId };
      }

      setAnswers((prev) => ({ ...prev, [currentQId]: newAnswer }));

      // Save to local DB
      try {
        await saveAnswer({
          attemptId,
          questionId:          currentQId,
          selected_option_id:  newAnswer.selected_option_id  || null,
          selected_option_ids: newAnswer.selected_option_ids || [],
          time_spent_secs:     Math.round((Date.now() - questionStart) / 1000),
          is_flagged:          flagged.has(currentQId),
        });
      } catch (err) {
        console.warn("saveAnswer failed:", err.message);
      }
    },
    [currentQId, currentQ, answers, attemptId, questionStart, flagged]
  );

  const handleTextAnswer = useCallback(
    async (text) => {
      if (!currentQId || !attemptId) return;
      setAnswers((prev) => ({
        ...prev,
        [currentQId]: { text_answer: text },
      }));
      try {
        await saveAnswer({
          attemptId,
          questionId:  currentQId,
          text_answer: text,
          time_spent_secs: Math.round((Date.now() - questionStart) / 1000),
          is_flagged:  flagged.has(currentQId),
        });
      } catch (err) {
        console.warn("saveAnswer (text) failed:", err.message);
      }
    },
    [currentQId, attemptId, questionStart, flagged]
  );

  // ── Flag toggle ───────────────────────────────────────────
  const handleToggleFlag = useCallback(async () => {
    if (!currentQId || !attemptId) return;

    setFlagged((prev) => {
      const next = new Set(prev);
      next.has(currentQId) ? next.delete(currentQId) : next.add(currentQId);
      return next;
    });

    try {
      await toggleFlag(attemptId, currentQId);
    } catch (err) {
      console.warn("toggleFlag failed:", err.message);
    }
  }, [currentQId, attemptId]);

  // ── Navigation ────────────────────────────────────────────
  const goTo = useCallback(
    (index) => {
      if (index < 0 || index >= totalQ) return;
      setCurrentIndex(index);
      setQuestionStart(Date.now());
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    [totalQ]
  );

  const goNext = () => goTo(currentIndex + 1);
  const goPrev = () => goTo(currentIndex - 1);

  // ── Submit ────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const unanswered = totalQ - answeredCount;

    const doSubmit = async () => {
      setSubmitting(true);
      try {
        await submitAttempt(attemptId);
        const res = await getAttemptResult(attemptId);
        setResult(res);
        setPhase("result");
      } catch (err) {
        Alert.alert(t("studentQuiz.errTitle"), t("studentQuiz.submitFailed"));
        console.warn("submitAttempt failed:", err.message);
      } finally {
        setSubmitting(false);
      }
    };

    if (unanswered > 0) {
      Alert.alert(
        t("studentQuiz.submitTitle"),
        t("studentQuiz.unansweredConfirm", { count: unanswered }),
        [
          { text: t("studentQuiz.keepGoing"), style: "cancel" },
          { text: t("studentQuiz.submit"),     style: "destructive", onPress: doSubmit },
        ]
      );
    } else {
      Alert.alert(
        t("studentQuiz.submitCta"),
        t("studentQuiz.submitBody"),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("studentQuiz.submit"), onPress: doSubmit },
        ]
      );
    }
  }, [totalQ, answeredCount, attemptId, t]);

  // ── Timer expire ──────────────────────────────────────────
  const handleTimerExpire = useCallback(async () => {
    try {
      setSubmitting(true);
      await timeoutAttempt(attemptId);
      const res = await getAttemptResult(attemptId);
      setResult(res);
      setPhase("result");
    } catch (err) {
      console.warn("timeoutAttempt failed:", err.message);
    } finally {
      setSubmitting(false);
    }
  }, [attemptId]);

  // ── Loading ───────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.indigo.solid} />
        <Text style={styles.loadingText}>{t("studentQuiz.starting")}</Text>
      </View>
    );
  }

  // ── Result ────────────────────────────────────────────────
  if (phase === "result") {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />
        <View style={styles.resultHeader}>
          <Text style={styles.resultHeaderTitle}>{t("studentQuiz.complete")}</Text>
        </View>
        <ResultScreen
          result={result}
          quiz={session?.quiz}
          onClose={() => router.back()}
        />
      </View>
    );
  }

  // ── Quiz player ───────────────────────────────────────────
  if (!currentQ) return null;

  const isMultiSelect  = currentQ.question_type === "multiple_select";
  const isFillInBlank  = currentQ.question_type === "fill_in_the_blank";
  const isFlagged      = flagged.has(currentQId);
  const timeLimitSecs  = session?.quiz?.time_limit_minutes
    ? session.quiz.time_limit_minutes * 60
    : null;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      {/* ── TOP BAR ── */}
      <View style={styles.topBar}>
        {/* Left: Exit */}
        <TouchableOpacity
          style={styles.topBarBtn}
          onPress={() => {
                     return Alert.alert(
              t("studentQuiz.exitTitle"),
              t("studentQuiz.exitBody"),
              [
                { text: t("studentQuiz.stay"),        style: "cancel" },
                { text: t("studentQuiz.exit"),        onPress: () => router.back() },
              ]
            );
                   }
          }
        >
          <Ionicons name="close" size={20} color={COLORS.text} />
        </TouchableOpacity>

        {/* Center: Question count + Timer */}
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarCount}>
            {currentIndex + 1} / {totalQ}
          </Text>
          {timeLimitSecs && (
            <Timer
              totalSeconds={timeLimitSecs}
              onExpire={handleTimerExpire}
              paused={timerPaused || submitting}
            />
          )}
        </View>

        {/* Right: Nav grid */}
        <TouchableOpacity
          style={styles.topBarBtn}
          onPress={() => setShowNav(true)}
        >
          <Ionicons name="grid-outline" size={20} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      {/* Progress bar */}
      <ProgressBar current={answeredCount} total={totalQ} />

      {/* ── QUESTION ── */}
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.questionScroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Question meta */}
        <View style={styles.questionMeta}>
          <View style={styles.questionTypeBadge}>
            <Text style={styles.questionTypeText}>
              {(QUESTION_TYPE_KEYS[currentQ.question_type]
                ? t(QUESTION_TYPE_KEYS[currentQ.question_type])
                : null) ||
                currentQ.question_type}
            </Text>
          </View>

          {(currentQ.points_override ?? currentQ.points) && (
            <View style={styles.pointsBadge}>
              <Ionicons name="star" size={11} color={SEMANTIC.warning.text} />
              <Text style={styles.pointsBadgeText}>
                {t("studentQuiz.pointCount", { count: currentQ.points_override ?? currentQ.points })}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.flagBtn,
              isFlagged && styles.flagBtnActive,
            ]}
            onPress={handleToggleFlag}
          >
            <Ionicons
              name={isFlagged ? "flag" : "flag-outline"}
              size={16}
              color={isFlagged ? SEMANTIC.warning.icon : COLORS.textSubtle}
            />
          </TouchableOpacity>
        </View>

        {/* Question text */}
        <Text style={styles.questionText}>
          {currentQ.question_text}
        </Text>

        {/* Hint for multi-select */}
        {isMultiSelect && (
          <Text style={styles.multiSelectHint}>
            {t("studentQuiz.selectAllApply")}
          </Text>
        )}

        {/* ── OPTIONS ── */}
        {!isFillInBlank && (
          <View style={styles.optionsContainer}>
            {(currentQ.options || []).map((opt, i) => {
              const optId      = String(opt._id || opt.id || i);
              const isSelected =
                isMultiSelect
                  ? (currentAnswer?.selected_option_ids || []).includes(optId)
                  : currentAnswer?.selected_option_id === optId;

              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.optionBtn,
                    isSelected && styles.optionBtnSelected,
                  ]}
                  onPress={() => handleSelectOption(optId)}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      isMultiSelect
                        ? styles.optionCheckbox
                        : styles.optionRadio,
                      isSelected && (isMultiSelect
                        ? styles.optionCheckboxSelected
                        : styles.optionRadioSelected),
                    ]}
                  >
                    {isSelected && (
                      <Ionicons
                        name={isMultiSelect ? "checkmark" : "ellipse"}
                        size={isMultiSelect ? 14 : 8}
                        color={COLORS.onPrimary}
                      />
                    )}
                  </View>
                  <Text
                    style={[
                      styles.optionText,
                      isSelected && styles.optionTextSelected,
                    ]}
                  >
                    {opt.option_text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* ── FILL IN BLANK ── */}
        {isFillInBlank && (
          <View style={styles.fillBlankContainer}>
            <Text style={styles.fillBlankLabel}>{t("studentQuiz.yourAnswer")}</Text>
            <View style={styles.fillBlankInput}>
              <Text
                style={[
                  styles.fillBlankText,
                  !currentAnswer?.text_answer && styles.fillBlankPlaceholder,
                ]}
                onPress={() => {
                  Alert.prompt(
                    t("studentQuiz.yourAnswer"),
                    "",
                    (text) => handleTextAnswer(text),
                    "plain-text",
                    currentAnswer?.text_answer || ""
                  );
                }}
              >
                {currentAnswer?.text_answer || t("studentQuiz.typeAnswerPh")}
              </Text>
            </View>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* ── NAVIGATION FOOTER ── */}
      <View style={styles.navFooter}>
        {/* Previous */}
        <TouchableOpacity
          style={[
            styles.navBtn,
            currentIndex === 0 && styles.navBtnDisabled,
          ]}
          onPress={goPrev}
          disabled={
            currentIndex === 0 ||
            session?.quiz?.allow_backtrack === false
          }
        >
          <Ionicons
            name="arrow-back"
            size={18}
            color={currentIndex === 0 ? COLORS.textMuted : COLORS.text}
          />
          <Text
            style={[
              styles.navBtnText,
              currentIndex === 0 && styles.navBtnTextDisabled,
            ]}
          >
            {t("studentQuiz.previous")}
          </Text>
        </TouchableOpacity>

        {/* Submit (on last question) or Next */}
        {currentIndex === totalQ - 1 ? (
          <TouchableOpacity
            style={[
              styles.submitBtn,
              submitting && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={COLORS.onPrimary} />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={18} color={COLORS.onPrimary} />
                <Text style={styles.submitBtnText}>{t("studentQuiz.submit")}</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.nextBtn}
            onPress={goNext}
            activeOpacity={0.8}
          >
            <Text style={styles.nextBtnText}>{t("studentQuiz.next")}</Text>
            <Ionicons name="arrow-forward" size={18} color={COLORS.onPrimary} />
          </TouchableOpacity>
        )}
      </View>

      {/* ── QUESTION NAV GRID (overlay) ── */}
      {showNav && (
        <View style={styles.navGridOverlay}>
          <TouchableOpacity
            style={styles.navGridBackdrop}
            onPress={() => setShowNav(false)}
            activeOpacity={1}
          />
          <QuestionNavGrid
            questions={questions}
            currentIndex={currentIndex}
            answers={answers}
            flagged={flagged}
            onJump={goTo}
            onClose={() => setShowNav(false)}
          />
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: COLORS.page },
  centered:     {
    flex:           1,
    justifyContent: "center",
    alignItems:     "center",
    backgroundColor:COLORS.page,
  },
  loadingText: {
    marginTop:  12,
    fontSize:   14,
    color:      COLORS.textSecondary,
    fontWeight: "500",
  },

  // ── Top bar ───────────────────────────────────────────────
  topBar: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     12,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  topBarBtn: {
    width:          36,
    height:         36,
    borderRadius:   10,
    backgroundColor:ACCENT.slate.wash,
    alignItems:     "center",
    justifyContent: "center",
  },
  topBarCenter: {
    flex:           1,
    alignItems:     "center",
    gap:            6,
  },
  topBarCount: {
    fontSize:   15,
    fontWeight: "700",
    color:      COLORS.text,
  },

  // ── Timer ─────────────────────────────────────────────────
  timer: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   ACCENT.indigo.wash,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      20,
    gap:               4,
  },
  timerWarning: { backgroundColor: SEMANTIC.warning.box },
  timerDanger:  { backgroundColor: SEMANTIC.error.box },
  timerText: {
    fontSize:   13,
    fontWeight: "700",
    color:      ACCENT.indigo.deep,
  },
  timerTextWarning: { color: SEMANTIC.warning.text },
  timerTextDanger:  { color: SEMANTIC.error.text },

  // ── Progress bar ──────────────────────────────────────────
  progressBar: {
    height:          4,
    backgroundColor: ACCENT.indigo.wash,
  },
  progressFill: {
    height:          4,
    backgroundColor: ACCENT.indigo.base,
    borderRadius:    2,
  },

  // ── Question scroll ───────────────────────────────────────
  questionScroll: { padding: 16 },

  questionMeta: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  12,
  },
  questionTypeBadge: {
    flex:              1,
    backgroundColor:   accentBadge("indigo").bg,
    borderWidth:       1,
    borderColor:       accentBadge("indigo").border,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      8,
    alignSelf:         "flex-start",
  },
  questionTypeText: {
    fontSize:   11,
    fontWeight: "700",
    color:      accentBadge("indigo").text,
  },
  pointsBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   statusBadge("warning").bg,
    borderWidth:       1,
    borderColor:       statusBadge("warning").border,
    paddingHorizontal: 8,
    paddingVertical:   4,
    borderRadius:      8,
  },
  pointsBadgeText: {
    fontSize:   11,
    fontWeight: "700",
    color:      statusBadge("warning").text,
  },
  flagBtn: {
    width:          32,
    height:         32,
    borderRadius:   8,
    backgroundColor:ACCENT.slate.wash,
    alignItems:     "center",
    justifyContent: "center",
  },
  flagBtnActive: { backgroundColor: SEMANTIC.warning.box },

  questionText: {
    fontSize:     18,
    fontWeight:   "700",
    color:        COLORS.text,
    lineHeight:   26,
    marginBottom: 16,
  },

  multiSelectHint: {
    fontSize:     12,
    color:        COLORS.textSecondary,
    fontStyle:    "italic",
    marginBottom: 12,
  },

  // ── Options ───────────────────────────────────────────────
  optionsContainer: { gap: 10 },
  optionBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         14,
    borderWidth:     2,
    borderColor:     COLORS.border,
    gap:             12,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.03,
    shadowRadius:    2,
    elevation:       1,
  },
  optionBtnSelected: {
    borderColor:     ACCENT.indigo.base,
    backgroundColor: ACCENT.indigo.wash,
  },

  // Radio button
  optionRadio: {
    width:          22,
    height:         22,
    borderRadius:   11,
    borderWidth:    2,
    borderColor:    COLORS.textMuted,
    alignItems:     "center",
    justifyContent: "center",
  },
  optionRadioSelected: {
    borderColor:     ACCENT.indigo.base,
    backgroundColor: ACCENT.indigo.solid,
  },

  // Checkbox
  optionCheckbox: {
    width:          22,
    height:         22,
    borderRadius:   6,
    borderWidth:    2,
    borderColor:    COLORS.textMuted,
    alignItems:     "center",
    justifyContent: "center",
  },
  optionCheckboxSelected: {
    borderColor:     ACCENT.indigo.base,
    backgroundColor: ACCENT.indigo.solid,
  },

  optionText: {
    flex:       1,
    fontSize:   15,
    color:      COLORS.text,
    lineHeight: 22,
  },
  optionTextSelected: {
    color:      ACCENT.indigo.deep,
    fontWeight: "600",
  },

  // ── Fill in blank ─────────────────────────────────────────
  fillBlankContainer: { marginTop: 8 },
  fillBlankLabel: {
    fontSize:     13,
    fontWeight:   "600",
    color:        COLORS.text,
    marginBottom: 8,
  },
  fillBlankInput: {
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         16,
    borderWidth:     2,
    borderColor:     COLORS.border,
    minHeight:       80,
  },
  fillBlankText: {
    fontSize:  15,
    color:     COLORS.text,
    lineHeight:22,
  },
  fillBlankPlaceholder: { color: COLORS.textSubtle },

  // ── Nav footer ────────────────────────────────────────────
  navFooter: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   12,
    paddingBottom:     32,
    backgroundColor:   COLORS.surface,
    borderTopWidth:    1,
    borderTopColor:    COLORS.border,
    gap:               10,
  },
  navBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderRadius:      12,
    backgroundColor:   ACCENT.slate.wash,
    gap:               6,
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: {
    fontSize:   14,
    fontWeight: "600",
    color:      COLORS.text,
  },
  navBtnTextDisabled: { color: COLORS.textMuted },

  nextBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: ACCENT.indigo.solid,
    borderRadius:    12,
    paddingVertical: 12,
    gap:             6,
  },
  nextBtnText: {
    color:      COLORS.onPrimary,
    fontWeight: "700",
    fontSize:   15,
  },

  submitBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: ACCENT.green.solid,
    borderRadius:    12,
    paddingVertical: 12,
    gap:             6,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: {
    color:      COLORS.onPrimary,
    fontWeight: "700",
    fontSize:   15,
  },

  // ── Nav grid overlay ──────────────────────────────────────
  navGridOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  navGridBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  navGrid: {
    position:        "absolute",
    bottom:          0,
    left:            0,
    right:           0,
    backgroundColor: COLORS.surface,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    padding:         20,
    paddingBottom:   40,
    maxHeight:       "70%",
  },
  navGridHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   12,
  },
  navGridTitle: { fontSize: 16, fontWeight: "700", color: COLORS.text },
  navGridClose: {
    width:          32,
    height:         32,
    borderRadius:   8,
    backgroundColor:ACCENT.slate.wash,
    alignItems:     "center",
    justifyContent: "center",
  },
  navLegend: {
    flexDirection: "row",
    gap:           14,
    marginBottom:  14,
  },
  navLegendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  navLegendDot: {
    width:        10,
    height:       10,
    borderRadius: 5,
  },
  navLegendText: { fontSize: 11, color: COLORS.textSecondary },

  navGridButtons: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           8,
  },
  navGridBtn: {
    width:          44,
    height:         44,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  navGridBtnText: { fontSize: 14, fontWeight: "700" },
  navFlagDot: {
    position:        "absolute",
    top:             4,
    right:           4,
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: ACCENT.amber.base,
  },

  // ── Result ────────────────────────────────────────────────
  resultHeader: {
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    alignItems:        "center",
  },
  resultHeaderTitle: {
    fontSize:   20,
    fontWeight: "700",
    color:      COLORS.text,
  },
  resultScroll: { padding: 16 },

  resultBanner: {
    borderRadius:   20,
    padding:        28,
    alignItems:     "center",
    marginBottom:   16,
    gap:            8,
  },
  resultBannerTitle: {
    fontSize:   22,
    fontWeight: "800",
    color:      COLORS.onPrimary,
  },
  resultBannerSub: {
    fontSize: 14,
    color:    "rgba(255,255,255,0.85)",
  },

  scoreCard: {
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    padding:         24,
    alignItems:      "center",
    marginBottom:    12,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    4,
    elevation:       2,
  },
  scoreLabel:   { fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },
  scoreValue: {
    fontSize:   56,
    fontWeight: "900",
    marginVertical: 4,
  },
  scoreDetail: { fontSize: 14, color: COLORS.textSubtle },
  scorePassMark: {
    marginTop:         8,
    backgroundColor:   ACCENT.indigo.wash,
    paddingHorizontal: 12,
    paddingVertical:   4,
    borderRadius:      8,
  },
  scorePassMarkText: { fontSize: 12, color: ACCENT.indigo.deep },

  resultStats: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           10,
    marginBottom:  16,
  },
  resultStatCard: {
    width:          "48%",
    borderRadius:   14,
    padding:        14,
    alignItems:     "center",
    gap:            5,
    borderWidth:    1,
    borderColor:    COLORS.border,
    borderTopWidth: 3,
  },
  resultStatValue: { fontSize: 22, fontWeight: "800" },
  resultStatLabel: { fontSize: 12, color: COLORS.textSecondary },

  reviewToggle: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    12,
    paddingVertical: 12,
    marginBottom:    12,
    gap:             6,
  },
  reviewToggleText: {
    fontSize:   14,
    fontWeight: "700",
    color:      ACCENT.indigo.deep,
  },

  reviewCard: {
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.03,
    shadowRadius:    2,
    elevation:       1,
  },
  reviewCardHeader: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  10,
  },
  reviewCorrectIcon: {
    width:          28,
    height:         28,
    borderRadius:   14,
    alignItems:     "center",
    justifyContent: "center",
  },
  reviewQNum: {
    flex:       1,
    fontSize:   13,
    fontWeight: "700",
    color:      COLORS.text,
  },
  reviewPoints: { fontSize: 12, color: COLORS.textSubtle },
  reviewQText: {
    fontSize:     14,
    fontWeight:   "600",
    color:        COLORS.text,
    lineHeight:   20,
    marginBottom: 10,
  },
  reviewOption: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    paddingVertical:6,
    paddingHorizontal:10,
    borderRadius:  8,
    marginBottom:  4,
  },
  reviewOptionCorrect: { backgroundColor: SEMANTIC.success.bg },
  reviewOptionWrong:   { backgroundColor: SEMANTIC.error.bg },
  reviewOptionText: {
    fontSize:  13,
    color:     COLORS.textSecondary,
    flex:      1,
    lineHeight:18,
  },

  fillAnswerRow: {
    flexDirection: "row",
    marginTop:     8,
    gap:           4,
  },
  fillAnswerLabel: { fontSize: 13, color: COLORS.textSecondary },
  fillAnswerText:  { fontSize: 13, fontWeight: "700" },

  explanationBox: {
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    10,
    padding:         12,
    marginTop:       10,
  },
  explanationLabel: {
    fontSize:     12,
    fontWeight:   "700",
    color:        ACCENT.indigo.deep,
    marginBottom: 4,
  },
  explanationText: {
    fontSize:  13,
    color:     COLORS.text,
    lineHeight:18,
  },

  // ── Result footer ─────────────────────────────────────────
  resultFooter: {
    padding:         16,
    paddingBottom:   32,
    backgroundColor: COLORS.surface,
    borderTopWidth:  1,
    borderTopColor:  COLORS.border,
  },
  doneBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: ACCENT.indigo.solid,
    borderRadius:    14,
    paddingVertical: 16,
    gap:             8,
  },
  doneBtnText: {
    color:      COLORS.onPrimary,
    fontWeight: "800",
    fontSize:   16,
  },
});