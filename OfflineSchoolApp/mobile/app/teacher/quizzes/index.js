// app/teacher/quizzes/index.js

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
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Alert,
  Modal,
  FlatList,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { useTranslation } from "../../../src/i18n/useTranslation";
import {
  getQuizzes,
  deleteQuiz,
  publishQuiz,
  unpublishQuiz,
  getQuestions,
  deleteQuestion,
  getCategories,
  getQuizAnalytics,
  getQuizAttemptsByQuizId,
} from "../../../src/services/quiz.service";
import {
  fetchTeacherScope,
  allTeacherSubjects,
} from "../../../src/services/teacherScope.service";
import { COLORS, ACCENT, SEMANTIC, statusBadge, accentBadge, categoryAccent } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "quizzes",   labelKey: "quizzes",   icon: "help-circle-outline" },
  { id: "questions", labelKey: "questions", icon: "list-outline"         },
  { id: "analytics", labelKey: "analytics", icon: "bar-chart-outline"    },
];

const DIFFICULTY_COLORS = {
  easy:   statusBadge("success"),
  medium: statusBadge("warning"),
  hard:   statusBadge("error"),
};

/** Question type → translation key under `quizList.questionType`. */
const QUESTION_TYPE_KEYS = {
  multiple_choice:   "mcq",
  multiple_select:   "multi",
  true_false:        "trueFalse",
  fill_in_the_blank: "fill",
  matching:          "matching",
};

const DIFFICULTIES = ["easy", "medium", "hard"];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

const formatDate = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month:  "short",
    day:    "numeric",
    hour:   "numeric",
    minute: "2-digit",
  });
};

const formatDuration = (secs) => {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

// ─────────────────────────────────────────────────────────────
// SMALL PURE COMPONENTS
// ─────────────────────────────────────────────────────────────

const TabBar = memo(({ active, onChange }) => {
  const { t } = useTranslation();

  return (
    <View style={styles.tabBar}>
      {TABS.map((tab) => (
        <TouchableOpacity
          key={tab.id}
          style={[styles.tab, active === tab.id && styles.tabActive]}
          onPress={() => onChange(tab.id)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={tab.icon}
            size={16}
            color={active === tab.id ? ACCENT.indigo.solid : COLORS.textSecondary}
          />
          <Text
            style={[
              styles.tabLabel,
              active === tab.id && styles.tabLabelActive,
            ]}
          >
            {t(`quizList.tabs.${tab.labelKey}`)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
});

const SearchBar = memo(({ value, onChange, placeholder }) => (
  <View style={styles.searchBar}>
    <Ionicons name="search-outline" size={18} color="#9CA3AF" />
    <TextInput
      style={styles.searchInput}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor="#9CA3AF"
    />
    {value.length > 0 && (
      <TouchableOpacity onPress={() => onChange("")}>
        <Ionicons name="close-circle" size={18} color="#9CA3AF" />
      </TouchableOpacity>
    )}
  </View>
));

const EmptyState = memo(({ icon, title, subtitle, action, actionLabel }) => (
  <View style={styles.emptyState}>
    <IconSquare icon={icon} accent="indigo" size={56} radius={16} />
    <Text style={styles.emptyTitle}>{title}</Text>
    {subtitle && <Text style={styles.emptySubtitle}>{subtitle}</Text>}
    {action && (
      <TouchableOpacity style={styles.emptyAction} onPress={action}>
        <Text style={styles.emptyActionText}>{actionLabel}</Text>
      </TouchableOpacity>
    )}
  </View>
));

// ─────────────────────────────────────────────────────────────
// QUIZ CARD
// ─────────────────────────────────────────────────────────────

const QuizCard = memo(({
  quiz,
  onEdit,
  onResponses,
  onAnalytics,
  onDelete,
  onTogglePublish,
}) => {
  const { t } = useTranslation();

  return (
  <View style={styles.quizCard}>
    <View style={styles.quizCardHeader}>
      <IconSquare icon="help-circle" accent="indigo" size={36} />
      <View style={{ flex: 1 }}>
        <Text style={styles.quizTitle} numberOfLines={1}>
          {quiz.title}
        </Text>
        <Text style={styles.quizMeta}>
          {quiz.class_name   ? `${quiz.class_name}  · ` : ""}
          {quiz.subject_name ? quiz.subject_name          : ""}
        </Text>
        {!quiz.class_id && (
          <Text style={styles.quizMissingClass}>
            {t("quizList.card.noClass")}
          </Text>
        )}
      </View>

      <TouchableOpacity
        style={[
          styles.publishBadge,
          quiz.is_published ? styles.publishBadgeOn : styles.publishBadgeOff,
        ]}
        onPress={() => onTogglePublish(quiz)}
        activeOpacity={0.7}
      >
        <View
          style={[
            styles.publishDot,
            { backgroundColor: quiz.is_published ? SEMANTIC.success.icon : SEMANTIC.warning.icon },
          ]}
        />
        <Text
          style={[
            styles.publishBadgeText,
            { color: quiz.is_published ? SEMANTIC.success.text : SEMANTIC.warning.text },
          ]}
        >
          {quiz.is_published
            ? t("quizList.card.live")
            : t("quizList.card.draft")}
        </Text>
      </TouchableOpacity>
    </View>

    <View style={styles.quizStats}>
      {[
        {
          id:    "questions",
          icon:  "help-circle-outline",
          value: quiz.question_count ?? 0,
          label: t("quizList.card.statQuestions"),
        },
        {
          id:    "time",
          icon:  "time-outline",
          value: quiz.time_limit_minutes
            ? `${quiz.time_limit_minutes}m`
            : "—",
          label: t("quizList.card.statTime"),
        },
        {
          id:    "responses",
          icon:  "people-outline",
          value: quiz.total_attempts ?? 0,
          label: t("quizList.card.statResponses"),
        },
        {
          id:    "avgScore",
          icon:  "stats-chart-outline",
          value: quiz.avg_score ? `${quiz.avg_score}%` : "—",
          label: t("quizList.card.statAvgScore"),
        },
      ].map((stat) => (
        <View key={stat.id} style={styles.quizStat}>
          <Ionicons name={stat.icon} size={13} color={ACCENT.indigo.solid} />
          <Text style={styles.quizStatValue}>{stat.value}</Text>
          <Text style={styles.quizStatLabel}>{stat.label}</Text>
        </View>
      ))}
    </View>

    <View style={styles.quizActionsGrid}>
      <View style={styles.quizActionsRow}>
        <TouchableOpacity
          style={styles.quizActionBtn}
          onPress={() => onEdit(quiz)}
        >
          <Ionicons name="create-outline" size={15} color={ACCENT.indigo.deep} />
          <Text style={[styles.quizActionText, { color: ACCENT.indigo.deep }]}>
            {t("common.edit")}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.quizActionBtn, { backgroundColor: ACCENT.violet.wash }]}
          onPress={() => onResponses(quiz)}
        >
          <Ionicons name="people-outline" size={15} color={ACCENT.violet.deep} />
          <Text style={[styles.quizActionText, { color: ACCENT.violet.deep }]}>
            {(quiz.total_attempts ?? 0) > 0
              ? t("quizList.card.responsesCount", {
                  count: quiz.total_attempts,
                })
              : t("quizList.card.responses")}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.quizActionsRow}>
        <TouchableOpacity
          style={styles.quizActionBtn}
          onPress={() => onAnalytics(quiz)}
        >
          <Ionicons name="bar-chart-outline" size={15} color={ACCENT.green.deep} />
          <Text style={[styles.quizActionText, { color: ACCENT.green.deep }]}>
            {t("quizList.card.analytics")}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.quizActionBtn}
          onPress={() => onDelete(quiz)}
        >
          <Ionicons name="trash-outline" size={15} color={ACCENT.red.deep} />
          <Text style={[styles.quizActionText, { color: ACCENT.red.deep }]}>
            {t("common.delete")}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  </View>
  );
});

// ─────────────────────────────────────────────────────────────
// QUESTION CARD
// ─────────────────────────────────────────────────────────────

const QuestionCard = memo(({ question: q, onEdit, onDelete }) => {
  const { t }  = useTranslation();
  const diff   = DIFFICULTY_COLORS[q.difficulty] || DIFFICULTY_COLORS.medium;
  const typeKey = QUESTION_TYPE_KEYS[q.question_type];
  const tLabel = typeKey
    ? t(`quizList.questionType.${typeKey}`)
    : q.question_type;
  const diffLabel = DIFFICULTIES.includes(q.difficulty)
    ? t(`quizList.difficulty.${q.difficulty}`)
    : q.difficulty;

  return (
    <View style={styles.questionCard}>
      <View style={styles.questionBadges}>
        <View style={[styles.typeBadge, { backgroundColor: accentBadge(categoryAccent(q.question_type)).bg, borderColor: accentBadge(categoryAccent(q.question_type)).border }]}>
          <Text style={[styles.typeBadgeText, { color: accentBadge(categoryAccent(q.question_type)).text }]}>
            {tLabel}
          </Text>
        </View>
        <View style={[styles.typeBadge, { backgroundColor: diff.bg, borderColor: diff.border }]}>
          <Text style={[styles.typeBadgeText, { color: diff.text }]}>
            {diffLabel}
          </Text>
        </View>
        {q.category_name && (
          <View style={[styles.typeBadge, { backgroundColor: accentBadge(categoryAccent(q.category_name)).bg, borderColor: accentBadge(categoryAccent(q.category_name)).border }]}>
            <Text style={[styles.typeBadgeText, { color: accentBadge(categoryAccent(q.category_name)).text }]}>
              {q.category_name}
            </Text>
          </View>
        )}
      </View>

      <Text style={styles.questionText} numberOfLines={2}>
        {q.question_text}
      </Text>

      {q.options?.slice(0, 3).map((opt, i) => (
        <View key={i} style={styles.optionPreview}>
          <Ionicons
            name={opt.is_correct ? "checkmark-circle" : "ellipse-outline"}
            size={14}
            color={opt.is_correct ? SEMANTIC.success.icon : COLORS.textSecondary}
          />
          <Text
            style={[
              styles.optionPreviewText,
              opt.is_correct && { color: SEMANTIC.success.text, fontWeight: "600" },
            ]}
            numberOfLines={1}
          >
            {opt.option_text}
          </Text>
        </View>
      ))}
      {(q.options?.length || 0) > 3 && (
        <Text style={styles.moreOptions}>
          {t("quizList.card.moreOptions", { count: q.options.length - 3 })}
        </Text>
      )}

      <View style={styles.questionActions}>
        <View style={styles.questionPoints}>
          <Ionicons name="star-outline" size={13} color={ACCENT.amber.solid} />
          <Text style={styles.questionPointsText}>
            {t("quizList.card.points", { count: q.points ?? 1 })}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.questionActionBtn}
          onPress={() => onEdit(q)}
        >
          <Ionicons name="create-outline" size={15} color={ACCENT.indigo.deep} />
          <Text style={[styles.questionActionText, { color: ACCENT.indigo.deep }]}>
            {t("common.edit")}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.questionActionBtn}
          onPress={() => onDelete(q)}
        >
          <Ionicons name="trash-outline" size={15} color={ACCENT.red.deep} />
          <Text style={[styles.questionActionText, { color: ACCENT.red.deep }]}>
            {t("common.delete")}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

// ─────────────────────────────────────────────────────────────
// RESPONSES MODAL
// ─────────────────────────────────────────────────────────────

const ResponsesModal = memo(({ quiz, onClose }) => {
  const { t } = useTranslation();
  const [attempts, setAttempts] = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!quiz) return;

    let cancelled = false;
    setLoading(true);
    setAttempts([]);

    getQuizAttemptsByQuizId(quiz.id)
      .then((data) => {
        if (!cancelled) setAttempts(data || []);
      })
      .catch(() => {
        if (!cancelled) setAttempts([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [quiz]);

  const passCount = useMemo(
    () => attempts.filter((a) => a.is_passed).length,
    [attempts]
  );

  const avgScore = useMemo(
    () =>
      attempts.length > 0
        ? Math.round(
            attempts.reduce((sum, a) => sum + (a.percentage || 0), 0) /
              attempts.length
          )
        : null,
    [attempts]
  );

  return (
    <Modal
      visible={!!quiz}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {quiz?.title}
            </Text>
            <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>
              {t("quizList.responses.count", { count: attempts.length })}
              {avgScore != null
                ? `  ·  ${t("quizList.avgScoreInline", { score: avgScore })}`
                : ""}
              {attempts.length > 0
                ? `  ·  ${t("quizList.responses.passed", {
                    count: passCount,
                  })}`
                : ""}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#4F46E5" />
            <Text style={styles.loadingText}>
              {t("quizList.responses.loading")}
            </Text>
          </View>
        ) : attempts.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title={t("quizList.responses.emptyTitle")}
            subtitle={t("quizList.responses.emptySubtitle")}
          />
        ) : (
          <FlatList
            data={attempts}
            keyExtractor={(item, index) =>
              item.id ? String(item.id) : `attempt-${index}`
            }
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
            renderItem={({ item: attempt }) => (
              <View style={responsesStyles.card}>
                <View style={responsesStyles.studentRow}>
                  <View style={responsesStyles.avatar}>
                    <Text style={responsesStyles.avatarText}>
                      {(attempt.student_name || "?").charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text
                      style={responsesStyles.studentName}
                      numberOfLines={1}
                    >
                      {attempt.student_name ||
                        t("quizList.responses.unknownStudent")}
                    </Text>
                    <Text
                      style={responsesStyles.studentMeta}
                      numberOfLines={1}
                    >
                      {[
                        attempt.student_email,
                        attempt.student_class,
                        t("quizList.responses.attempt", {
                          number: attempt.attempt_number || 1,
                        }),
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </Text>
                  </View>

                  <View
                    style={[
                      responsesStyles.scoreBadge,
                      {
                        backgroundColor: attempt.is_passed
                          ? SEMANTIC.success.bg
                          : SEMANTIC.error.bg,
                        borderColor: attempt.is_passed
                          ? SEMANTIC.success.box
                          : SEMANTIC.error.box,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        responsesStyles.scoreText,
                        {
                          color: attempt.is_passed ? SEMANTIC.success.text : SEMANTIC.error.text,
                        },
                      ]}
                    >
                      {Math.round(attempt.percentage || 0)}%
                    </Text>
                  </View>
                </View>

                <View style={responsesStyles.detailsRow}>
                  <View style={responsesStyles.detailChip}>
                    <Ionicons
                      name="checkmark-circle-outline"
                      size={12}
                      color={ACCENT.blue.solid}
                    />
                    <Text style={responsesStyles.detailText}>
                      {attempt.raw_score ?? 0}/{attempt.max_score ?? 0}
                    </Text>
                  </View>

                  <View style={responsesStyles.detailChip}>
                    <Ionicons name="time-outline" size={12} color={ACCENT.blue.solid} />
                    <Text style={responsesStyles.detailText}>
                      {formatDuration(attempt.time_taken_secs)}
                    </Text>
                  </View>

                  <View style={responsesStyles.detailChip}>
                    <Ionicons
                      name="calendar-outline"
                      size={12}
                      color={ACCENT.blue.solid}
                    />
                    <Text style={responsesStyles.detailText}>
                      {formatDate(attempt.submitted_at)}
                    </Text>
                  </View>

                  <View
                    style={[
                      responsesStyles.statusChip,
                      {
                        backgroundColor: attempt.is_passed
                          ? SEMANTIC.success.bg
                          : SEMANTIC.error.bg,
                        borderColor: attempt.is_passed
                          ? SEMANTIC.success.box
                          : SEMANTIC.error.box,
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize:   10,
                        fontWeight: "700",
                        color:      attempt.is_passed ? SEMANTIC.success.text : SEMANTIC.error.text,
                      }}
                    >
                      {attempt.is_passed
                        ? t("quizList.responses.passedBadge")
                        : t("quizList.responses.failedBadge")}
                    </Text>
                  </View>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
});

// ─────────────────────────────────────────────────────────────
// ANALYTICS MODAL
// ─────────────────────────────────────────────────────────────

const AnalyticsModal = memo(({ quiz, onClose }) => {
  const { t } = useTranslation();
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!quiz) return;

    let cancelled = false;
    setLoading(true);
    setData(null);

    getQuizAnalytics(quiz.id)
      .then((result) => { if (!cancelled) setData(result); })
      .catch(()      => { if (!cancelled) setData(null); })
      .finally(()    => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [quiz]);

  return (
    <Modal
      visible={!!quiz}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle} numberOfLines={1}>
            {quiz?.title}
          </Text>
          <TouchableOpacity onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#4F46E5" />
          </View>
        ) : !data ? (
          <EmptyState
            icon="bar-chart-outline"
            title={t("quizList.analytics.emptyTitle")}
            subtitle={t("quizList.analytics.emptySubtitle")}
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.modalScroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.analyticsGrid}>
              {[
                {
                  id:    "totalAttempts",
                  label: t("quizList.analytics.totalAttempts"),
                  value: data.summary?.total_attempts ?? 0,
                  icon:  "people-outline",
                  color: ACCENT.indigo.deep,
                  bg:    ACCENT.indigo.wash,
                  base:  ACCENT.indigo.base,
                },
                {
                  id:    "passRate",
                  label: t("quizList.analytics.passRate"),
                  value:
                    data.summary?.total_completions > 0
                      ? `${Math.round(
                          (data.summary.total_passes /
                            data.summary.total_completions) *
                            100
                        )}%`
                      : "—",
                  icon:  "checkmark-circle-outline",
                  color: ACCENT.green.deep,
                  bg:    ACCENT.green.wash,
                  base:  ACCENT.green.base,
                },
                {
                  id:    "avgScore",
                  label: t("quizList.analytics.avgScore"),
                  value: data.summary?.avg_score
                    ? `${data.summary.avg_score}%`
                    : "—",
                  icon:  "stats-chart-outline",
                  color: ACCENT.amber.deep,
                  bg:    ACCENT.amber.wash,
                  base:  ACCENT.amber.base,
                },
                {
                  id:    "avgTime",
                  label: t("quizList.analytics.avgTime"),
                  value: data.summary?.avg_time_secs
                    ? `${Math.round(data.summary.avg_time_secs / 60)}m`
                    : "—",
                  icon:  "time-outline",
                  color: ACCENT.teal.deep,
                  bg:    ACCENT.teal.wash,
                  base:  ACCENT.teal.base,
                },
              ].map((card) => (
                <View
                  key={card.id}
                  style={[styles.analyticsCard, { backgroundColor: card.bg, borderTopColor: card.base }]}
                >
                  <Ionicons name={card.icon} size={20} color={card.base} />
                  <Text
                    style={[styles.analyticsValue, { color: card.color }]}
                  >
                    {card.value}
                  </Text>
                  <Text style={styles.analyticsLabel}>{card.label}</Text>
                </View>
              ))}
            </View>

            {data.summary?.highest_score !== undefined && (
              <View style={styles.scoreRange}>
                <View style={styles.scoreRangeItem}>
                  <Text style={styles.scoreRangeLabel}>
                    {t("quizList.analytics.highest")}
                  </Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: SEMANTIC.success.text }]}
                  >
                    {data.summary.highest_score}%
                  </Text>
                </View>
                <View style={styles.scoreRangeDivider} />
                <View style={styles.scoreRangeItem}>
                  <Text style={styles.scoreRangeLabel}>
                    {t("quizList.analytics.lowest")}
                  </Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: SEMANTIC.error.text }]}
                  >
                    {data.summary.lowest_score}%
                  </Text>
                </View>
                <View style={styles.scoreRangeDivider} />
                <View style={styles.scoreRangeItem}>
                  <Text style={styles.scoreRangeLabel}>
                    {t("quizList.analytics.passing")}
                  </Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: ACCENT.indigo.deep }]}
                  >
                    {data.summary.passing_score}%
                  </Text>
                </View>
              </View>
            )}

            {data.hardestQuestions?.length > 0 && (
              <View style={styles.hardestSection}>
                <Text style={styles.hardestTitle}>
                  {t("quizList.analytics.hardestTitle")}
                </Text>
                {data.hardestQuestions.map((q, i) => (
                  <View key={i} style={styles.hardestCard}>
                    <View style={styles.hardestRank}>
                      <Text style={styles.hardestRankText}>{i + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={styles.hardestQuestion}
                        numberOfLines={2}
                      >
                        {q.question_text}
                      </Text>
                      <View style={styles.hardestMeta}>
                        <Text style={styles.hardestStat}>
                          {t("quizList.analytics.seen", {
                            count: q.times_shown,
                          })}
                        </Text>
                        <Text style={styles.hardestStat}>
                          {t("quizList.analytics.correct", {
                            count: q.times_correct,
                          })}
                        </Text>
                        <Text
                          style={[styles.hardestStat, { color: SEMANTIC.error.text }]}
                        >
                          {t("quizList.analytics.missRate", {
                            rate: Math.round(
                              (1 - (q.difficulty_score || 0)) * 100
                            ),
                          })}
                        </Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
});

// ─────────────────────────────────────────────────────────────
// CUSTOM HOOK — useQuizData
// ─────────────────────────────────────────────────────────────

function useQuizData(schoolId, teacherId, subjectId = null) {
  const { t } = useTranslation();
  const [quizzes,    setQuizzes]    = useState([]);
  const [questions,  setQuestions]  = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = useCallback(
    async (isRefresh = false) => {
      if (!schoolId || !teacherId) {
        setLoading(false);
        Alert.alert(
          t("quizList.alerts.sessionErrorTitle"),
          t("quizList.alerts.sessionErrorBody")
        );
        return;
      }

      try {
        if (isRefresh) setRefreshing(true);
        else           setLoading(true);

        const [quizData, questionData, categoryData] = await Promise.all([
          getQuizzes({
            schoolId:   schoolId.toString(),
            created_by: teacherId.toString(),
          }),
          // This teacher's questions, and — when a subject chip is chosen —
          // only that subject's. Filtered in the database, not here.
          getQuestions({
            schoolId:   schoolId.toString(),
            created_by: teacherId.toString(),
            subject_id: subjectId || null,
            limit:      100,
          }),
          getCategories(schoolId.toString()),
        ]);

        setQuizzes(quizData       || []);
        setQuestions(questionData || []);
        setCategories(categoryData || []);
      } catch (err) {
        console.warn("Failed to load quiz data:", err?.message);
        Alert.alert(
          t("quizList.alerts.errorTitle"),
          t("quizList.alerts.loadFailed")
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // `t` is intentionally not a dependency: i18n.t() reads the live locale at
    // call time, so a stale identity still translates correctly — and listing
    // it here would refetch every quiz on a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schoolId, teacherId, subjectId]
  );

  useEffect(() => { loadAll(); }, [loadAll]);

  return {
    quizzes,
    questions,
    categories,
    loading,
    refreshing,
    loadAll,
    setQuizzes,
    setQuestions,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function TeacherQuizzesScreen() {
  const router = useRouter();
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);

  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;

  // The subject chips over the question bank: every subject this teacher is
  // assigned, from the same source the quiz screen's pickers use.
  const [filterSubject,  setFilterSubject]  = useState(null);
  const [subjectOptions, setSubjectOptions] = useState([]);
  useEffect(() => {
    let alive = true;
    if (!teacherId) return undefined;
    fetchTeacherScope({ teacherId, schoolId })
      .then((scope) => { if (alive) setSubjectOptions(allTeacherSubjects(scope)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [teacherId, schoolId]);

  const {
    quizzes,
    questions,
    categories,
    loading,
    refreshing,
    loadAll,
    setQuizzes,
    setQuestions,
  } = useQuizData(schoolId, teacherId, filterSubject);

  const [activeTab,      setActiveTab]      = useState("quizzes");
  const [quizSearch,     setQuizSearch]     = useState("");
  const [questionSearch, setQuestionSearch] = useState("");
  const [selectedQuiz,   setSelectedQuiz]   = useState(null);
  const [responsesQuiz,  setResponsesQuiz]  = useState(null);
  const [filterType,     setFilterType]     = useState(null);
  const [filterDiff,     setFilterDiff]     = useState(null);

  const filteredQuizzes = useMemo(
    () =>
      quizzes.filter((q) =>
        q.title.toLowerCase().includes(quizSearch.toLowerCase())
      ),
    [quizzes, quizSearch]
  );

  const filteredQuestions = useMemo(
    () =>
      questions.filter((q) => {
        const matchSearch = q.question_text
          .toLowerCase()
          .includes(questionSearch.toLowerCase());
        const matchType = !filterType || q.question_type === filterType;
        const matchDiff = !filterDiff || q.difficulty   === filterDiff;
        return matchSearch && matchType && matchDiff;
      }),
    [questions, questionSearch, filterType, filterDiff]
  );

  const brokenQuizzes = useMemo(
    () =>
      quizzes.filter(
        (q) => !q.class_id && (q._synced === 0 || q._synced === null)
      ),
    [quizzes]
  );

  const quizzesWithAttempts = useMemo(
    () => quizzes.filter((q) => (q.total_attempts ?? 0) > 0),
    [quizzes]
  );

  const handleTogglePublish = useCallback(
    async (quiz) => {
      const newPublished = quiz.is_published ? 0 : 1;

      setQuizzes((prev) =>
        prev.map((q) =>
          q.id === quiz.id ? { ...q, is_published: newPublished } : q
        )
      );

      try {
        if (quiz.is_published) {
          await unpublishQuiz(quiz.id);
        } else {
          await publishQuiz(quiz.id);
        }
      } catch {
        setQuizzes((prev) =>
          prev.map((q) =>
            q.id === quiz.id
              ? { ...q, is_published: quiz.is_published }
              : q
          )
        );
        Alert.alert(
          t("quizList.alerts.errorTitle"),
          t("quizList.alerts.statusFailed")
        );
      }
    },
    [setQuizzes, t]
  );

  const handleEditQuiz = useCallback(
    (quiz) => {
      router.push({
        pathname: "/teacher/quizzes/create",
        params:   { quizId: quiz.id },
      });
    },
    [router]
  );

  const handleDeleteQuiz = useCallback(
    (quiz) => {
      Alert.alert(
        t("quizList.alerts.deleteQuizTitle"),
        t("quizList.alerts.deleteQuizBody", { title: quiz.title }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text:  t("common.delete"),
            style: "destructive",
            onPress: async () => {
              try {
                await deleteQuiz(quiz.id);
                setQuizzes((prev) =>
                  prev.filter((q) => q.id !== quiz.id)
                );
              } catch {
                Alert.alert(
                  t("quizList.alerts.errorTitle"),
                  t("quizList.alerts.deleteQuizFailed")
                );
              }
            },
          },
        ]
      );
    },
    [setQuizzes, t]
  );

  const handleEditQuestion = useCallback(
    (question) => {
      router.push({
        pathname: "/teacher/quizzes/create",
        params:   { tab: "question", questionId: question.id },
      });
    },
    [router]
  );

  const handleDeleteQuestion = useCallback(
    (question) => {
      Alert.alert(
        t("quizList.alerts.deleteQuestionTitle"),
        t("quizList.alerts.deleteQuestionBody"),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text:  t("common.delete"),
            style: "destructive",
            onPress: async () => {
              try {
                await deleteQuestion(question.id);
                setQuestions((prev) =>
                  prev.filter((q) => q.id !== question.id)
                );
              } catch {
                Alert.alert(
                  t("quizList.alerts.errorTitle"),
                  t("quizList.alerts.deleteQuestionFailed")
                );
              }
            },
          },
        ]
      );
    },
    [setQuestions, t]
  );

  const renderQuizItem = useCallback(
    ({ item }) => (
      <QuizCard
        quiz={item}
        onEdit={handleEditQuiz}
        onResponses={setResponsesQuiz}
        onAnalytics={setSelectedQuiz}
        onDelete={handleDeleteQuiz}
        onTogglePublish={handleTogglePublish}
      />
    ),
    [handleEditQuiz, handleDeleteQuiz, handleTogglePublish]
  );

  const renderQuestionItem = useCallback(
    ({ item }) => (
      <QuestionCard
        question={item}
        onEdit={handleEditQuestion}
        onDelete={handleDeleteQuestion}
      />
    ),
    [handleEditQuestion, handleDeleteQuestion]
  );

  const renderAnalyticsItem = useCallback(
    ({ item: quiz }) => (
      <TouchableOpacity
        style={styles.analyticsListCard}
        onPress={() => setSelectedQuiz(quiz)}
        activeOpacity={0.7}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.analyticsListTitle} numberOfLines={1}>
            {quiz.title}
          </Text>
          <Text style={styles.analyticsListMeta}>
            {t("quizList.attemptCount", { count: quiz.total_attempts })}
            {quiz.avg_score
              ? `  ·  ${t("quizList.avgScoreInline", {
                  score: quiz.avg_score,
                })}`
              : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setResponsesQuiz(quiz)}
          style={styles.analyticsResponsesBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="people-outline" size={16} color={ACCENT.violet.deep} />
        </TouchableOpacity>
        <Ionicons name="chevron-forward" size={16} color={COLORS.textSecondary} />
      </TouchableOpacity>
    ),
    [t]
  );

  const renderQuizzesTab = () => (
    <View style={{ flex: 1 }}>
      <SearchBar
        value={quizSearch}
        onChange={setQuizSearch}
        placeholder={t("quizList.searchQuizzes")}
      />

      {brokenQuizzes.length > 0 && (
        <TouchableOpacity
          style={styles.warningBanner}
          onPress={() =>
            router.push({
              pathname: "/teacher/quizzes/create",
              params:   { quizId: brokenQuizzes[0].id, tab: "details" },
            })
          }
          activeOpacity={0.8}
        >
          <Ionicons name="warning-outline" size={16} color={SEMANTIC.warning.icon} />
          <Text style={styles.warningText}>
            {brokenQuizzes.length === 1
              ? t("quizList.warnOne", { title: brokenQuizzes[0].title })
              : t("quizList.warnMany", { count: brokenQuizzes.length })}
            <Text style={{ fontWeight: "700" }}>
              {t("quizList.warnFix")}
            </Text>
          </Text>
        </TouchableOpacity>
      )}

      {filteredQuizzes.length === 0 ? (
        <EmptyState
          icon="help-circle-outline"
          title={t("quizList.empty.quizzesTitle")}
          subtitle={t("quizList.empty.quizzesSubtitle")}
          action={() => router.push("/teacher/quizzes/create")}
          actionLabel={t("quizList.empty.quizzesAction")}
        />
      ) : (
        <FlatList
          data={filteredQuizzes}
          keyExtractor={(item) => String(item.id)}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderItem={renderQuizItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAll(true)}
              tintColor="#4F46E5"
            />
          }
        />
      )}
    </View>
  );

  const renderQuestionsTab = () => (
    <View style={{ flex: 1 }}>
      <SearchBar
        value={questionSearch}
        onChange={setQuestionSearch}
        placeholder={t("quizList.searchQuestions")}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterChips}
      >
        {subjectOptions.length > 0 && (
          <>
            <TouchableOpacity
              style={[styles.chip, !filterSubject && styles.chipActive]}
              onPress={() => setFilterSubject(null)}
            >
              <Text style={[styles.chipText, !filterSubject && styles.chipTextActive]}>
                {t("quizList.allSubjects")}
              </Text>
            </TouchableOpacity>
            {subjectOptions.map((subj) => (
              <TouchableOpacity
                key={subj.id}
                style={[styles.chip, filterSubject === subj.id && styles.chipActive]}
                onPress={() =>
                  setFilterSubject((prev) => (prev === subj.id ? null : subj.id))
                }
              >
                <Text
                  style={[
                    styles.chipText,
                    filterSubject === subj.id && styles.chipTextActive,
                  ]}
                >
                  {subj.name}
                </Text>
              </TouchableOpacity>
            ))}
            <View style={styles.chipDivider} />
          </>
        )}

        {Object.entries(QUESTION_TYPE_KEYS).map(([type, labelKey]) => (
          <TouchableOpacity
            key={type}
            style={[styles.chip, filterType === type && styles.chipActive]}
            onPress={() =>
              setFilterType((prev) => (prev === type ? null : type))
            }
          >
            <Text
              style={[
                styles.chipText,
                filterType === type && styles.chipTextActive,
              ]}
            >
              {t(`quizList.questionType.${labelKey}`)}
            </Text>
          </TouchableOpacity>
        ))}

        <View style={styles.chipDivider} />

        {DIFFICULTIES.map((diff) => (
          <TouchableOpacity
            key={diff}
            style={[
              styles.chip,
              filterDiff === diff && {
                backgroundColor: DIFFICULTY_COLORS[diff].bg,
                borderColor:     DIFFICULTY_COLORS[diff].border,
              },
            ]}
            onPress={() =>
              setFilterDiff((prev) => (prev === diff ? null : diff))
            }
          >
            <Text
              style={[
                styles.chipText,
                filterDiff === diff && {
                  color:      DIFFICULTY_COLORS[diff].text,
                  fontWeight: "700",
                },
              ]}
            >
              {t(`quizList.difficulty.${diff}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {filteredQuestions.length === 0 ? (
        <EmptyState
          icon="list-outline"
          title={t("quizList.empty.questionsTitle")}
          subtitle={t("quizList.empty.questionsSubtitle")}
          action={() =>
            router.push({
              pathname: "/teacher/quizzes/create",
              params:   { tab: "question" },
            })
          }
          actionLabel={t("quizList.empty.questionsAction")}
        />
      ) : (
        <FlatList
          data={filteredQuestions}
          keyExtractor={(item, index) =>
            item.id ? String(item.id) : `question-${index}`
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          renderItem={renderQuestionItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadAll(true)}
              tintColor="#4F46E5"
            />
          }
        />
      )}
    </View>
  );

  const renderAnalyticsTab = () => (
    <FlatList
      data={quizzesWithAttempts}
      keyExtractor={(item) => String(item.id)}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => loadAll(true)}
          tintColor="#4F46E5"
        />
      }
      ListEmptyComponent={
        <EmptyState
          icon="bar-chart-outline"
          title={t("quizList.empty.analyticsTitle")}
          subtitle={t("quizList.empty.analyticsSubtitle")}
        />
      }
      renderItem={renderAnalyticsItem}
    />
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("quizList.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("quizList.title")}</Text>
          <Text style={styles.headerSub}>
            {t("quizList.quizCount", { count: quizzes.length })}
            {" · "}
            {t("quizList.questionCount", { count: questions.length })}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => router.push("/teacher/quizzes/create")}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={20} color="#FFF" />
          <Text style={styles.createBtnText}>{t("quizList.new")}</Text>
        </TouchableOpacity>
      </View>

      <TabBar active={activeTab} onChange={setActiveTab} />

      <View style={{ flex: 1 }}>
        {activeTab === "quizzes"   && renderQuizzesTab()}
        {activeTab === "questions" && renderQuestionsTab()}
        {activeTab === "analytics" && renderAnalyticsTab()}
      </View>

      <AnalyticsModal
        quiz={selectedQuiz}
        onClose={() => setSelectedQuiz(null)}
      />

      <ResponsesModal
        quiz={responsesQuiz}
        onClose={() => setResponsesQuiz(null)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// RESPONSES MODAL STYLES
// ─────────────────────────────────────────────────────────────

const responsesStyles = StyleSheet.create({
  card: {
    backgroundColor: ACCENT.blue.wash,
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.blue.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    4,
    elevation:       2,
  },
  studentRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
    marginBottom:  10,
  },
  avatar: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: COLORS.surface,
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     2,
    borderColor:     ACCENT.blue.base + "4D",
  },
  avatarText: {
    fontSize:   18,
    fontWeight: "800",
    color:      ACCENT.blue.deep,
  },
  studentName: {
    fontSize:   15,
    fontWeight: "700",
    color:      COLORS.text,
  },
  studentMeta: {
    fontSize:  11,
    color:     COLORS.textSecondary,
    marginTop: 2,
  },
  scoreBadge: {
    width:          52,
    height:         52,
    borderRadius:   16,
    alignItems:     "center",
    justifyContent: "center",
    borderWidth:    1,
  },
  scoreText: {
    fontSize:   17,
    fontWeight: "800",
  },
  detailsRow: {
    flexDirection:  "row",
    flexWrap:       "wrap",
    gap:            6,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop:     10,
  },
  detailChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   COLORS.surface,
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
  detailText: {
    fontSize:   11,
    color:      COLORS.textSecondary,
    fontWeight: "500",
  },
  statusChip: {
    borderWidth:       1,
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
});

// ─────────────────────────────────────────────────────────────
// MAIN STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: COLORS.page,
  },
  loadingText: {
    marginTop:  12,
    fontSize:   14,
    color:      COLORS.textSecondary,
    fontWeight: "500",
  },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               10,
  },
  backButton: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:  { marginRight: 0 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  createBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   8,
    gap:               4,
  },
  createBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  tabBar: {
    flexDirection:     "row",
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tab: {
    flex:              1,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   12,
    gap:               5,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive:      { borderBottomColor: ACCENT.indigo.base },
  tabLabel:       { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  tabLabelActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  warningBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    backgroundColor:   SEMANTIC.warning.bg,
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   10,
    marginHorizontal:  16,
    marginBottom:      8,
    borderWidth:       1,
    borderColor:       SEMANTIC.warning.box,
  },
  warningText: { flex: 1, fontSize: 13, color: SEMANTIC.warning.text },

  searchBar: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#FFF",
    marginHorizontal:  16,
    marginVertical:    12,
    paddingHorizontal: 12,
    paddingVertical:   10,
    borderRadius:      12,
    gap:               8,
    shadowColor:       "#000",
    shadowOpacity:     0.04,
    shadowRadius:      3,
    elevation:         2,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827", padding: 0 },

  filterChips: {
    paddingHorizontal: 16,
    paddingBottom:     12,
    gap:               8,
    flexDirection:     "row",
    alignItems:        "center",
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      20,
    backgroundColor:   COLORS.surface,
    borderWidth:       1,
    borderColor:       COLORS.border,
  },
  chipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  chipText:       { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },
  chipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },
  chipDivider: {
    width:            1,
    height:           20,
    backgroundColor:  "#E5E7EB",
    marginHorizontal: 4,
  },

  listContent: { paddingHorizontal: 16, paddingBottom: 24 },

  quizCard: {
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.indigo.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    4,
    elevation:       2,
  },
  quizCardHeader: {
    flexDirection: "row",
    alignItems:    "flex-start",
    marginBottom:  10,
    gap:           10,
  },
  quizTitle:        { fontSize: 15, fontWeight: "700", color: COLORS.text },
  quizMeta:         { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  quizMissingClass: {
    fontSize:   11,
    color:      SEMANTIC.warning.text,
    marginTop:  3,
    fontWeight: "600",
  },
  publishBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      20,
    gap:               5,
    borderWidth:       1,
  },
  publishBadgeOn:   { backgroundColor: statusBadge("success").bg, borderColor: statusBadge("success").border },
  publishBadgeOff:  { backgroundColor: statusBadge("warning").bg, borderColor: statusBadge("warning").border },
  publishDot:       { width: 6, height: 6, borderRadius: 3 },
  publishBadgeText: { fontSize: 12, fontWeight: "600" },

  quizStats: {
    flexDirection:  "row",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop:     10,
    marginBottom:   10,
  },
  quizStat:      { flex: 1, alignItems: "center", gap: 2 },
  quizStatValue: { fontSize: 13, fontWeight: "700", color: ACCENT.indigo.deep },
  quizStatLabel: { fontSize: 10, color: COLORS.textSecondary },

  quizActionsGrid: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop:     10,
    gap:            6,
  },
  quizActionsRow: { flexDirection: "row", gap: 8 },
  quizActionBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 7,
    borderRadius:    8,
    backgroundColor: COLORS.surface,
    gap:             4,
  },
  quizActionText: { fontSize: 12, fontWeight: "600" },

  questionCard: {
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.indigo.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    4,
    elevation:       2,
  },
  questionBadges: {
    flexDirection: "row",
    gap:           6,
    marginBottom:  8,
    flexWrap:      "wrap",
  },
  typeBadge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  typeBadgeText: { fontSize: 11, fontWeight: "700" },

  questionText: {
    fontSize:     14,
    fontWeight:   "600",
    color:        COLORS.text,
    marginBottom: 8,
    lineHeight:   20,
  },
  optionPreview: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             6,
    paddingVertical: 2,
  },
  optionPreviewText: { fontSize: 13, color: COLORS.textSecondary, flex: 1 },
  moreOptions:       { fontSize: 11, color: COLORS.textSecondary, marginTop: 4 },

  questionActions: {
    flexDirection:  "row",
    alignItems:     "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop:     10,
    marginTop:      8,
    gap:            8,
  },
  questionPoints: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           3,
    flex:          1,
  },
  questionPointsText: { fontSize: 12, color: ACCENT.amber.deep, fontWeight: "600" },
  questionActionBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   COLORS.surface,
    gap:               4,
  },
  questionActionText: { fontSize: 12, fontWeight: "600" },

  analyticsListCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    12,
    padding:         14,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.indigo.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.03,
    shadowRadius:    2,
    elevation:       1,
    gap:             8,
  },
  analyticsListTitle: { fontSize: 14, fontWeight: "600", color: COLORS.text },
  analyticsListMeta:  { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  analyticsResponsesBtn: {
    padding:         4,
    borderRadius:    8,
    backgroundColor: COLORS.surface,
  },

  modalContainer: { flex: 1, backgroundColor: COLORS.page },
  modalHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               10,
  },
  modalTitle: { flex: 1, fontSize: 18, fontWeight: "700", color: COLORS.text },
  modalClose: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  modalScroll: { padding: 16 },

  analyticsGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           10,
    marginBottom:  12,
  },
  analyticsCard: {
    flex:         1,
    minWidth:     "45%",
    maxWidth:     "50%",
    borderRadius: 14,
    padding:      16,
    alignItems:   "center",
    gap:          6,
    borderWidth:  1,
    borderColor:  COLORS.border,
    borderTopWidth: 3,
  },
  analyticsValue: { fontSize: 22, fontWeight: "800" },
  analyticsLabel: { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },

  scoreRange: {
    flexDirection:   "row",
    backgroundColor: COLORS.surface,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
  },
  scoreRangeItem:    { flex: 1, alignItems: "center" },
  scoreRangeLabel:   { fontSize: 12, color: COLORS.textSecondary },
  scoreRangeValue:   { fontSize: 20, fontWeight: "800", marginTop: 4 },
  scoreRangeDivider: { width: 1, backgroundColor: COLORS.border },

  hardestSection: { marginTop: 4 },
  hardestTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        COLORS.text,
    marginBottom: 10,
  },
  hardestCard: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: COLORS.surface,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.red.base,
    borderRadius:    12,
    padding:         12,
    marginBottom:    8,
    gap:             10,
  },
  hardestRank: {
    width:           28,
    height:          28,
    borderRadius:    14,
    backgroundColor: SEMANTIC.error.box,
    alignItems:      "center",
    justifyContent:  "center",
  },
  hardestRankText: { fontSize: 13, fontWeight: "700", color: SEMANTIC.error.text },
  hardestQuestion: {
    fontSize:   13,
    fontWeight: "600",
    color:      COLORS.text,
    lineHeight: 18,
  },
  hardestMeta: { flexDirection: "row", gap: 10, marginTop: 4 },
  hardestStat: { fontSize: 11, color: COLORS.textSecondary },

  emptyState: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   48,
    paddingHorizontal: 24,
    gap:               8,
  },
  emptyTitle:     { fontSize: 16, fontWeight: "700", color: COLORS.text },
  emptySubtitle:  { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
  emptyAction: {
    marginTop:         8,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
  },
  emptyActionText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});