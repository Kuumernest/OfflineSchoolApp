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

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "quizzes",   label: "Quizzes",   icon: "help-circle-outline" },
  { id: "questions", label: "Questions", icon: "list-outline"         },
  { id: "analytics", label: "Analytics", icon: "bar-chart-outline"    },
];

const DIFFICULTY_COLORS = {
  easy:   { bg: "#ECFDF5", text: "#059669" },
  medium: { bg: "#FEF3C7", text: "#D97706" },
  hard:   { bg: "#FEE2E2", text: "#DC2626" },
};

const QUESTION_TYPE_LABELS = {
  multiple_choice:   "MCQ",
  multiple_select:   "Multi",
  true_false:        "T/F",
  fill_in_the_blank: "Fill",
  matching:          "Match",
};

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

const TabBar = memo(({ active, onChange }) => (
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
          color={active === tab.id ? "#4F46E5" : "#9CA3AF"}
        />
        <Text
          style={[
            styles.tabLabel,
            active === tab.id && styles.tabLabelActive,
          ]}
        >
          {tab.label}
        </Text>
      </TouchableOpacity>
    ))}
  </View>
));

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
    <Ionicons name={icon} size={48} color="#D1D5DB" />
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
}) => (
  <View style={styles.quizCard}>
    <View style={styles.quizCardHeader}>
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
            ⚠ No class assigned — tap Edit to fix
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
            { backgroundColor: quiz.is_published ? "#059669" : "#9CA3AF" },
          ]}
        />
        <Text
          style={[
            styles.publishBadgeText,
            { color: quiz.is_published ? "#059669" : "#6B7280" },
          ]}
        >
          {quiz.is_published ? "Live" : "Draft"}
        </Text>
      </TouchableOpacity>
    </View>

    <View style={styles.quizStats}>
      {[
        {
          icon:  "help-circle-outline",
          value: quiz.question_count ?? 0,
          label: "Questions",
        },
        {
          icon:  "time-outline",
          value: quiz.time_limit_minutes
            ? `${quiz.time_limit_minutes}m`
            : "—",
          label: "Time",
        },
        {
          icon:  "people-outline",
          value: quiz.total_attempts ?? 0,
          label: "Responses",
        },
        {
          icon:  "stats-chart-outline",
          value: quiz.avg_score ? `${quiz.avg_score}%` : "—",
          label: "Avg Score",
        },
      ].map((stat) => (
        <View key={stat.label} style={styles.quizStat}>
          <Ionicons name={stat.icon} size={13} color="#9CA3AF" />
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
          <Ionicons name="create-outline" size={15} color="#4F46E5" />
          <Text style={[styles.quizActionText, { color: "#4F46E5" }]}>
            Edit
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.quizActionBtn, { backgroundColor: "#F5F3FF" }]}
          onPress={() => onResponses(quiz)}
        >
          <Ionicons name="people-outline" size={15} color="#7C3AED" />
          <Text style={[styles.quizActionText, { color: "#7C3AED" }]}>
            Responses
            {(quiz.total_attempts ?? 0) > 0
              ? ` (${quiz.total_attempts})`
              : ""}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.quizActionsRow}>
        <TouchableOpacity
          style={styles.quizActionBtn}
          onPress={() => onAnalytics(quiz)}
        >
          <Ionicons name="bar-chart-outline" size={15} color="#059669" />
          <Text style={[styles.quizActionText, { color: "#059669" }]}>
            Analytics
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.quizActionBtn}
          onPress={() => onDelete(quiz)}
        >
          <Ionicons name="trash-outline" size={15} color="#DC2626" />
          <Text style={[styles.quizActionText, { color: "#DC2626" }]}>
            Delete
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  </View>
));

// ─────────────────────────────────────────────────────────────
// QUESTION CARD
// ─────────────────────────────────────────────────────────────

const QuestionCard = memo(({ question: q, onEdit, onDelete }) => {
  const diff   = DIFFICULTY_COLORS[q.difficulty] || DIFFICULTY_COLORS.medium;
  const tLabel = QUESTION_TYPE_LABELS[q.question_type] || q.question_type;

  return (
    <View style={styles.questionCard}>
      <View style={styles.questionBadges}>
        <View style={[styles.typeBadge, { backgroundColor: "#EEF2FF" }]}>
          <Text style={[styles.typeBadgeText, { color: "#4F46E5" }]}>
            {tLabel}
          </Text>
        </View>
        <View style={[styles.typeBadge, { backgroundColor: diff.bg }]}>
          <Text style={[styles.typeBadgeText, { color: diff.text }]}>
            {q.difficulty}
          </Text>
        </View>
        {q.category_name && (
          <View style={[styles.typeBadge, { backgroundColor: "#F3F4F6" }]}>
            <Text style={[styles.typeBadgeText, { color: "#6B7280" }]}>
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
            color={opt.is_correct ? "#059669" : "#D1D5DB"}
          />
          <Text
            style={[
              styles.optionPreviewText,
              opt.is_correct && { color: "#059669", fontWeight: "600" },
            ]}
            numberOfLines={1}
          >
            {opt.option_text}
          </Text>
        </View>
      ))}
      {(q.options?.length || 0) > 3 && (
        <Text style={styles.moreOptions}>
          +{q.options.length - 3} more options
        </Text>
      )}

      <View style={styles.questionActions}>
        <View style={styles.questionPoints}>
          <Ionicons name="star-outline" size={13} color="#D97706" />
          <Text style={styles.questionPointsText}>
            {q.points ?? 1} pt{(q.points ?? 1) !== 1 ? "s" : ""}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.questionActionBtn}
          onPress={() => onEdit(q)}
        >
          <Ionicons name="create-outline" size={15} color="#4F46E5" />
          <Text style={[styles.questionActionText, { color: "#4F46E5" }]}>
            Edit
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.questionActionBtn}
          onPress={() => onDelete(q)}
        >
          <Ionicons name="trash-outline" size={15} color="#DC2626" />
          <Text style={[styles.questionActionText, { color: "#DC2626" }]}>
            Delete
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
            <Text style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>
              {attempts.length} response{attempts.length !== 1 ? "s" : ""}
              {avgScore != null ? `  ·  avg ${avgScore}%` : ""}
              {attempts.length > 0 ? `  ·  ${passCount} passed` : ""}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close" size={22} color="#374151" />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#4F46E5" />
            <Text style={styles.loadingText}>Loading responses…</Text>
          </View>
        ) : attempts.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="No responses yet"
            subtitle="Students haven't submitted this quiz yet"
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
                      {attempt.student_name || "Unknown Student"}
                    </Text>
                    <Text
                      style={responsesStyles.studentMeta}
                      numberOfLines={1}
                    >
                      {[
                        attempt.student_email,
                        attempt.student_class,
                        `Attempt ${attempt.attempt_number || 1}`,
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
                          ? "#ECFDF5"
                          : "#FEF2F2",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        responsesStyles.scoreText,
                        {
                          color: attempt.is_passed ? "#059669" : "#DC2626",
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
                      color="#6B7280"
                    />
                    <Text style={responsesStyles.detailText}>
                      {attempt.raw_score ?? 0}/{attempt.max_score ?? 0}
                    </Text>
                  </View>

                  <View style={responsesStyles.detailChip}>
                    <Ionicons name="time-outline" size={12} color="#6B7280" />
                    <Text style={responsesStyles.detailText}>
                      {formatDuration(attempt.time_taken_secs)}
                    </Text>
                  </View>

                  <View style={responsesStyles.detailChip}>
                    <Ionicons
                      name="calendar-outline"
                      size={12}
                      color="#6B7280"
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
                          ? "#ECFDF5"
                          : "#FEF2F2",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        fontSize:   10,
                        fontWeight: "700",
                        color:      attempt.is_passed ? "#059669" : "#DC2626",
                      }}
                    >
                      {attempt.is_passed ? "PASSED" : "FAILED"}
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
            <Ionicons name="close" size={22} color="#374151" />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#4F46E5" />
          </View>
        ) : !data ? (
          <EmptyState
            icon="bar-chart-outline"
            title="No analytics yet"
            subtitle="Analytics will appear once students start taking this quiz"
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.modalScroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.analyticsGrid}>
              {[
                {
                  label: "Total Attempts",
                  value: data.summary?.total_attempts ?? 0,
                  icon:  "people-outline",
                  color: "#4F46E5",
                  bg:    "#EEF2FF",
                },
                {
                  label: "Pass Rate",
                  value:
                    data.summary?.total_completions > 0
                      ? `${Math.round(
                          (data.summary.total_passes /
                            data.summary.total_completions) *
                            100
                        )}%`
                      : "—",
                  icon:  "checkmark-circle-outline",
                  color: "#059669",
                  bg:    "#ECFDF5",
                },
                {
                  label: "Avg Score",
                  value: data.summary?.avg_score
                    ? `${data.summary.avg_score}%`
                    : "—",
                  icon:  "stats-chart-outline",
                  color: "#D97706",
                  bg:    "#FEF3C7",
                },
                {
                  label: "Avg Time",
                  value: data.summary?.avg_time_secs
                    ? `${Math.round(data.summary.avg_time_secs / 60)}m`
                    : "—",
                  icon:  "time-outline",
                  color: "#DB2777",
                  bg:    "#FDF2F8",
                },
              ].map((card) => (
                <View
                  key={card.label}
                  style={[styles.analyticsCard, { backgroundColor: card.bg }]}
                >
                  <Ionicons name={card.icon} size={20} color={card.color} />
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
                  <Text style={styles.scoreRangeLabel}>Highest</Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: "#059669" }]}
                  >
                    {data.summary.highest_score}%
                  </Text>
                </View>
                <View style={styles.scoreRangeDivider} />
                <View style={styles.scoreRangeItem}>
                  <Text style={styles.scoreRangeLabel}>Lowest</Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: "#DC2626" }]}
                  >
                    {data.summary.lowest_score}%
                  </Text>
                </View>
                <View style={styles.scoreRangeDivider} />
                <View style={styles.scoreRangeItem}>
                  <Text style={styles.scoreRangeLabel}>Passing</Text>
                  <Text
                    style={[styles.scoreRangeValue, { color: "#4F46E5" }]}
                  >
                    {data.summary.passing_score}%
                  </Text>
                </View>
              </View>
            )}

            {data.hardestQuestions?.length > 0 && (
              <View style={styles.hardestSection}>
                <Text style={styles.hardestTitle}>Hardest Questions</Text>
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
                          {q.times_shown} seen
                        </Text>
                        <Text style={styles.hardestStat}>
                          {q.times_correct} correct
                        </Text>
                        <Text
                          style={[styles.hardestStat, { color: "#DC2626" }]}
                        >
                          {Math.round(
                            (1 - (q.difficulty_score || 0)) * 100
                          )}% miss rate
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

function useQuizData(schoolId, teacherId) {
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
          "Session Error",
          "Could not identify your account. Please log out and back in."
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
          getQuestions({
            schoolId: schoolId.toString(),
            limit:    100,
          }),
          getCategories(schoolId.toString()),
        ]);

        setQuizzes(quizData       || []);
        setQuestions(questionData || []);
        setCategories(categoryData || []);
      } catch (err) {
        console.warn("Failed to load quiz data:", err?.message);
        Alert.alert("Error", "Could not load data. Pull to refresh.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [schoolId, teacherId]
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
  const user   = useAuthStore((s) => s.user);

  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;

  const {
    quizzes,
    questions,
    categories,
    loading,
    refreshing,
    loadAll,
    setQuizzes,
    setQuestions,
  } = useQuizData(schoolId, teacherId);

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
        Alert.alert("Error", "Could not update quiz status");
      }
    },
    [setQuizzes]
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
        "Delete Quiz",
        `Are you sure you want to delete "${quiz.title}"?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text:  "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await deleteQuiz(quiz.id);
                setQuizzes((prev) =>
                  prev.filter((q) => q.id !== quiz.id)
                );
              } catch {
                Alert.alert("Error", "Could not delete quiz");
              }
            },
          },
        ]
      );
    },
    [setQuizzes]
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
        "Delete Question",
        "Are you sure you want to delete this question?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text:  "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await deleteQuestion(question.id);
                setQuestions((prev) =>
                  prev.filter((q) => q.id !== question.id)
                );
              } catch {
                Alert.alert("Error", "Could not delete question");
              }
            },
          },
        ]
      );
    },
    [setQuestions]
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
            {quiz.total_attempts} attempt
            {quiz.total_attempts !== 1 ? "s" : ""}
            {quiz.avg_score ? `  ·  avg ${quiz.avg_score}%` : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setResponsesQuiz(quiz)}
          style={styles.analyticsResponsesBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="people-outline" size={16} color="#7C3AED" />
        </TouchableOpacity>
        <Ionicons name="chevron-forward" size={16} color="#D1D5DB" />
      </TouchableOpacity>
    ),
    []
  );

  const renderQuizzesTab = () => (
    <View style={{ flex: 1 }}>
      <SearchBar
        value={quizSearch}
        onChange={setQuizSearch}
        placeholder="Search quizzes..."
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
          <Ionicons name="warning-outline" size={16} color="#D97706" />
          <Text style={styles.warningText}>
            {brokenQuizzes.length === 1
              ? `"${brokenQuizzes[0].title}" needs a class assigned. `
              : `${brokenQuizzes.length} quizzes need a class assigned. `}
            <Text style={{ fontWeight: "700" }}>Tap to fix →</Text>
          </Text>
        </TouchableOpacity>
      )}

      {filteredQuizzes.length === 0 ? (
        <EmptyState
          icon="help-circle-outline"
          title="No quizzes yet"
          subtitle="Create your first quiz to get started"
          action={() => router.push("/teacher/quizzes/create")}
          actionLabel="Create Quiz"
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
        placeholder="Search questions..."
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterChips}
      >
        {Object.entries(QUESTION_TYPE_LABELS).map(([type, label]) => (
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
              {label}
            </Text>
          </TouchableOpacity>
        ))}

        <View style={styles.chipDivider} />

        {["easy", "medium", "hard"].map((diff) => (
          <TouchableOpacity
            key={diff}
            style={[
              styles.chip,
              filterDiff === diff && {
                backgroundColor: DIFFICULTY_COLORS[diff].bg,
                borderColor:     DIFFICULTY_COLORS[diff].text,
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
              {diff.charAt(0).toUpperCase() + diff.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {filteredQuestions.length === 0 ? (
        <EmptyState
          icon="list-outline"
          title="No questions yet"
          subtitle="Build your question bank"
          action={() =>
            router.push({
              pathname: "/teacher/quizzes/create",
              params:   { tab: "question" },
            })
          }
          actionLabel="Add Question"
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
          title="No data yet"
          subtitle="Analytics will appear once students complete quizzes"
        />
      }
      renderItem={renderAnalyticsItem}
    />
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading quizzes…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Quizzes</Text>
          <Text style={styles.headerSub}>
            {quizzes.length} quiz{quizzes.length !== 1 ? "zes" : ""}
            {" · "}
            {questions.length} question{questions.length !== 1 ? "s" : ""}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => router.push("/teacher/quizzes/create")}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={20} color="#FFF" />
          <Text style={styles.createBtnText}>New</Text>
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
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    shadowColor:     "#000",
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
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     2,
    borderColor:     "#C7D2FE",
  },
  avatarText: {
    fontSize:   18,
    fontWeight: "800",
    color:      "#4F46E5",
  },
  studentName: {
    fontSize:   15,
    fontWeight: "700",
    color:      "#111827",
  },
  studentMeta: {
    fontSize:  11,
    color:     "#9CA3AF",
    marginTop: 2,
  },
  scoreBadge: {
    width:          52,
    height:         52,
    borderRadius:   16,
    alignItems:     "center",
    justifyContent: "center",
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
    borderTopColor: "#F3F4F6",
    paddingTop:     10,
  },
  detailChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   "#F3F4F6",
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
  detailText: {
    fontSize:   11,
    color:      "#6B7280",
    fontWeight: "500",
  },
  statusChip: {
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
});

// ─────────────────────────────────────────────────────────────
// MAIN STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F3F4F6",
  },
  loadingText: {
    marginTop:  12,
    fontSize:   14,
    color:      "#6B7280",
    fontWeight: "500",
  },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
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
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
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
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
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
  tabActive:      { borderBottomColor: "#4F46E5" },
  tabLabel:       { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },
  tabLabelActive: { color: "#4F46E5", fontWeight: "700" },

  warningBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    backgroundColor:   "#FEF3C7",
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   10,
    marginHorizontal:  16,
    marginBottom:      8,
    borderWidth:       1,
    borderColor:       "#FDE68A",
  },
  warningText: { flex: 1, fontSize: 13, color: "#92400E" },

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
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "transparent",
  },
  chipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  chipText:       { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  chipTextActive: { color: "#4F46E5", fontWeight: "700" },
  chipDivider: {
    width:            1,
    height:           20,
    backgroundColor:  "#E5E7EB",
    marginHorizontal: 4,
  },

  listContent: { paddingHorizontal: 16, paddingBottom: 24 },

  quizCard: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    shadowColor:     "#000",
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
  quizTitle:        { fontSize: 15, fontWeight: "700", color: "#111827" },
  quizMeta:         { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  quizMissingClass: {
    fontSize:   11,
    color:      "#D97706",
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
  publishBadgeOn:   { backgroundColor: "#ECFDF5", borderColor: "#059669" },
  publishBadgeOff:  { backgroundColor: "#F9FAFB", borderColor: "#E5E7EB" },
  publishDot:       { width: 6, height: 6, borderRadius: 3 },
  publishBadgeText: { fontSize: 12, fontWeight: "600" },

  quizStats: {
    flexDirection:  "row",
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
    paddingTop:     10,
    marginBottom:   10,
  },
  quizStat:      { flex: 1, alignItems: "center", gap: 2 },
  quizStatValue: { fontSize: 13, fontWeight: "700", color: "#111827" },
  quizStatLabel: { fontSize: 10, color: "#9CA3AF" },

  quizActionsGrid: {
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
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
    backgroundColor: "#F9FAFB",
    gap:             4,
  },
  quizActionText: { fontSize: 12, fontWeight: "600" },

  questionCard: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    shadowColor:     "#000",
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
  typeBadge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeBadgeText: { fontSize: 11, fontWeight: "700" },

  questionText: {
    fontSize:     14,
    fontWeight:   "600",
    color:        "#111827",
    marginBottom: 8,
    lineHeight:   20,
  },
  optionPreview: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             6,
    paddingVertical: 2,
  },
  optionPreviewText: { fontSize: 13, color: "#6B7280", flex: 1 },
  moreOptions:       { fontSize: 11, color: "#9CA3AF", marginTop: 4 },

  questionActions: {
    flexDirection:  "row",
    alignItems:     "center",
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
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
  questionPointsText: { fontSize: 12, color: "#D97706", fontWeight: "600" },
  questionActionBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   "#F9FAFB",
    gap:               4,
  },
  questionActionText: { fontSize: 12, fontWeight: "600" },

  analyticsListCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         14,
    marginBottom:    8,
    shadowColor:     "#000",
    shadowOpacity:   0.03,
    shadowRadius:    2,
    elevation:       1,
    gap:             8,
  },
  analyticsListTitle: { fontSize: 14, fontWeight: "600", color: "#111827" },
  analyticsListMeta:  { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  analyticsResponsesBtn: {
    padding:         4,
    borderRadius:    8,
    backgroundColor: "#F5F3FF",
  },

  modalContainer: { flex: 1, backgroundColor: "#F3F4F6" },
  modalHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               10,
  },
  modalTitle: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111827" },
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
  },
  analyticsValue: { fontSize: 22, fontWeight: "800" },
  analyticsLabel: { fontSize: 12, color: "#6B7280", fontWeight: "500" },

  scoreRange: {
    flexDirection:   "row",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
  },
  scoreRangeItem:    { flex: 1, alignItems: "center" },
  scoreRangeLabel:   { fontSize: 12, color: "#9CA3AF" },
  scoreRangeValue:   { fontSize: 20, fontWeight: "800", marginTop: 4 },
  scoreRangeDivider: { width: 1, backgroundColor: "#F3F4F6" },

  hardestSection: { marginTop: 4 },
  hardestTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 10,
  },
  hardestCard: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    marginBottom:    8,
    gap:             10,
  },
  hardestRank: {
    width:           28,
    height:          28,
    borderRadius:    14,
    backgroundColor: "#FEE2E2",
    alignItems:      "center",
    justifyContent:  "center",
  },
  hardestRankText: { fontSize: 13, fontWeight: "700", color: "#DC2626" },
  hardestQuestion: {
    fontSize:   13,
    fontWeight: "600",
    color:      "#111827",
    lineHeight: 18,
  },
  hardestMeta: { flexDirection: "row", gap: 10, marginTop: 4 },
  hardestStat: { fontSize: 11, color: "#9CA3AF" },

  emptyState: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   48,
    paddingHorizontal: 24,
    gap:               8,
  },
  emptyTitle:     { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySubtitle:  { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
  emptyAction: {
    marginTop:         8,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
  },
  emptyActionText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});