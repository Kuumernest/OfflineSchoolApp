// app/teacher/quizzes/create.js

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
  FlatList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  TextInput,
  Alert,
  Switch,
  KeyboardAvoidingView,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { useTranslation } from "../../../src/i18n/useTranslation";
import {
  createQuiz,
  updateQuiz,
  getQuizById,
  createQuestion,
  updateQuestion,
  updateQuestionOptions,
  getQuestionById,
  getCategories,
  addQuestionToQuiz,
  removeQuestionFromQuiz,
  getQuestionBank,
  publishQuiz,
  getTeacherClasses,
  getTeacherSubjectsForClass,
} from "../../../src/services/quiz.service";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, categoryAccent, levelAccent } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "details",   icon: "information-circle-outline" },
  { id: "questions", icon: "list-outline"               },
  { id: "settings",  icon: "settings-outline"           },
];

const QUESTION_TYPES = [
  { value: "multiple_choice",   icon: "radio-button-on-outline" },
  { value: "multiple_select",   icon: "checkbox-outline"        },
  { value: "true_false",        icon: "swap-horizontal-outline" },
  { value: "fill_in_the_blank", icon: "create-outline"          },
];

const DIFFICULTIES = ["easy", "medium", "hard"];
const DIFFICULTY_TONE = { easy: "success", medium: "warning", hard: "error" };

const FEEDBACK_OPTIONS = [
  { value: "immediately"    },
  { value: "on_completion"  },
  { value: "after_deadline" },
  { value: "never"          },
];

const DEFAULT_QUIZ = {
  title:              "",
  description:        "",
  instructions:       "",
  class_id:           null,
  subject_id:         null,
  time_limit_minutes: "",
  shuffle_questions:  false,
  shuffle_options:    false,
  questions_per_page: 1,
  allow_backtrack:    true,
  max_attempts:       "1",
  passing_score:      "70",
  show_answers_after: "on_completion",
  show_score:         true,
  show_explanation:   true,
};

const DEFAULT_QUESTION = {
  question_text: "",
  question_type: "multiple_choice",
  difficulty:    "medium",
  points:        "1",
  explanation:   "",
  category_id:   null,
  options: [
    { option_text: "", is_correct: false },
    { option_text: "", is_correct: false },
    { option_text: "", is_correct: true  },
    { option_text: "", is_correct: false },
  ],
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Screen labels for the question-type enum. The enum values never change. */
const questionTypeLabels = (t) => ({
  multiple_choice:   t("quizCreate.typeMultipleChoice"),
  multiple_select:   t("quizCreate.typeMultipleSelect"),
  true_false:        t("quizCreate.typeTrueFalse"),
  fill_in_the_blank: t("quizCreate.typeFillBlank"),
});

/** Screen labels for the difficulty enum. */
const difficultyLabels = (t) => ({
  easy:   t("quizCreate.diffEasy"),
  medium: t("quizCreate.diffMedium"),
  hard:   t("quizCreate.diffHard"),
});

const normaliseQuestionForForm = (q) => {
  if (!q) return { ...DEFAULT_QUESTION };

  let options = Array.isArray(q.options) && q.options.length > 0
    ? q.options.map((o) => ({
        id:          o.id          ?? undefined,
        option_text: o.option_text ?? "",
        is_correct:  Boolean(o.is_correct),
      }))
    : [...DEFAULT_QUESTION.options];

  if (
    q.question_type !== "fill_in_the_blank" &&
    !options.some((o) => o.is_correct)
  ) {
    options[0] = { ...options[0], is_correct: true };
  }

  return {
    question_text: q.question_text ?? "",
    question_type: q.question_type ?? "multiple_choice",
    difficulty:    q.difficulty    ?? "medium",
    points:        String(q.points ?? 1),
    explanation:   q.explanation   ?? "",
    category_id:   q.category_id   ?? null,
    options,
  };
};

// ─────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────

const TabBar = ({ active, onChange, tabs }) => {
  const { t } = useTranslation();

  const tabLabels = {
    details:   t("quizCreate.tabDetails"),
    questions: t("quizCreate.tabQuestions"),
    settings:  t("quizCreate.tabSettings"),
  };

  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => (
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
          <Text style={[styles.tabLabel, active === tab.id && styles.tabLabelActive]}>
            {tabLabels[tab.id]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
};

const Field = ({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  keyboardType,
  required,
  editable = true,
}) => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>
      {label}
      {required && <Text style={{ color: SEMANTIC.error.text }}> *</Text>}
    </Text>
    <TextInput
      style={[
        styles.fieldInput,
        multiline  && styles.fieldInputMulti,
        !editable  && styles.fieldInputDisabled,
      ]}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor="#9CA3AF"
      multiline={multiline}
      keyboardType={keyboardType || "default"}
      numberOfLines={multiline ? 3 : 1}
      editable={editable}
    />
  </View>
);

const ToggleRow = ({ label, subtitle, value, onChange }) => (
  <View style={styles.toggleRow}>
    <View style={{ flex: 1 }}>
      <Text style={styles.toggleLabel}>{label}</Text>
      {subtitle && <Text style={styles.toggleSubtitle}>{subtitle}</Text>}
    </View>
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ false: COLORS.border, true: ACCENT.indigo.base + "66" }}
      thumbColor={value ? ACCENT.indigo.solid : COLORS.textMuted}
    />
  </View>
);

const SectionHeader = ({ title, icon = "list" }) => (
  <View style={styles.sectionHeaderRow}>
    <IconSquare icon={icon} accent="indigo" size={28} />
    <Text style={styles.sectionHeader}>{title}</Text>
  </View>
);

// ─────────────────────────────────────────────────────────────
// QUESTION FORM
// ─────────────────────────────────────────────────────────────

const QuestionForm = ({ initial, categories, onSave, onCancel, saving }) => {
  const { t }      = useTranslation();
  const typeLabels = questionTypeLabels(t);
  const diffLabels = difficultyLabels(t);

  const [form, setForm] = useState(() => normaliseQuestionForForm(initial));

  useEffect(() => {
    setForm(normaliseQuestionForForm(initial));
  }, [initial]);

  const set = useCallback(
    (key, val) => setForm((prev) => ({ ...prev, [key]: val })),
    []
  );

  const setOption = useCallback((index, key, val) => {
    setForm((prev) => {
      const opts = prev.options.map((o, i) => {
        if (i !== index) {
          if (
            key === "is_correct" &&
            val === true &&
            prev.question_type === "multiple_choice"
          ) {
            return { ...o, is_correct: false };
          }
          return o;
        }
        return { ...o, [key]: val };
      });
      return { ...prev, options: opts };
    });
  }, []);

  const addOption = useCallback(() => {
    setForm((prev) => {
      if (prev.options.length >= 6) return prev;
      return {
        ...prev,
        options: [...prev.options, { option_text: "", is_correct: false }],
      };
    });
  }, []);

  const removeOption = useCallback((index) => {
    setForm((prev) => {
      if (prev.options.length <= 2) return prev;
      return { ...prev, options: prev.options.filter((_, i) => i !== index) };
    });
  }, []);

  const prevTypeRef = useRef(form.question_type);
  useEffect(() => {
    if (
      form.question_type === "true_false" &&
      prevTypeRef.current !== "true_false"
    ) {
      set("options", [
        { option_text: "True",  is_correct: true  },
        { option_text: "False", is_correct: false },
      ]);
    }
    prevTypeRef.current = form.question_type;
  }, [form.question_type, set]);

  const handleSave = useCallback(() => {
    if (!form.question_text.trim()) {
      Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errQuestionText"));
      return;
    }
    if (form.question_type === "fill_in_the_blank") {
      if (!form.options[0]?.option_text?.trim()) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errCorrectAnswer"));
        return;
      }
    } else {
      const hasCorrect = form.options.some((o) => o.is_correct);
      if (!hasCorrect) {
        Alert.alert(
          t("quizCreate.validationTitle"),
          t("quizCreate.errAtLeastOneCorrect")
        );
        return;
      }
      const hasText = form.options.every((o) => o.option_text.trim());
      if (!hasText) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errAllOptionsText"));
        return;
      }
    }
    onSave(form);
  }, [form, onSave, t]);

  const isTrueFalse   = form.question_type === "true_false";
  const isFillInBlank = form.question_type === "fill_in_the_blank";
  const showOptions   = !isFillInBlank;

  return (
    <View style={styles.questionForm}>
      <Text style={styles.fieldLabel}>{t("quizCreate.questionTypeLabel")}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.typeRow}
      >
        {QUESTION_TYPES.map((qt) => (
          <TouchableOpacity
            key={qt.value}
            style={[
              styles.typeChip,
              form.question_type === qt.value && {
                backgroundColor: ACCENT[categoryAccent(qt.value)].wash,
                borderColor:     ACCENT[categoryAccent(qt.value)].base,
              },
            ]}
            onPress={() => set("question_type", qt.value)}
          >
            <Ionicons
              name={qt.icon}
              size={14}
              color={form.question_type === qt.value ? ACCENT[categoryAccent(qt.value)].deep : COLORS.textSecondary}
            />
            <Text
              style={[
                styles.typeChipText,
                form.question_type === qt.value && styles.typeChipTextActive,
                form.question_type === qt.value && { color: ACCENT[categoryAccent(qt.value)].deep },
              ]}
            >
              {typeLabels[qt.value]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Field
        label={t("quizCreate.questionLabel")}
        value={form.question_text}
        onChange={(v) => set("question_text", v)}
        placeholder={t("quizCreate.questionPlaceholder")}
        multiline
        required
      />

      {isFillInBlank && (
        <Field
          label={t("quizCreate.correctAnswerLabel")}
          value={form.options[0]?.option_text || ""}
          onChange={(v) =>
            set("options", [{ option_text: v, is_correct: true }])
          }
          placeholder={t("quizCreate.correctAnswerPlaceholder")}
          required
        />
      )}

      {showOptions && (
        <View style={styles.optionsSection}>
          <Text style={styles.fieldLabel}>
            {t("quizCreate.answerOptionsLabel")}
            {form.question_type === "multiple_select" && (
              <Text style={styles.fieldHint}>
                {" " + t("quizCreate.checkAllHint")}
              </Text>
            )}
          </Text>

          {form.options.map((opt, i) => (
            <View key={i} style={styles.optionRow}>
              <TouchableOpacity
                style={[
                  styles.optionCorrectToggle,
                  opt.is_correct && styles.optionCorrectToggleOn,
                ]}
                onPress={() =>
                  !isTrueFalse && setOption(i, "is_correct", !opt.is_correct)
                }
                disabled={isTrueFalse}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={opt.is_correct ? "checkmark-circle" : "ellipse-outline"}
                  size={22}
                  color={opt.is_correct ? SEMANTIC.success.icon : COLORS.textSecondary}
                />
              </TouchableOpacity>

              <TextInput
                style={[
                  styles.optionInput,
                  opt.is_correct && styles.optionInputCorrect,
                ]}
                value={opt.option_text}
                onChangeText={(v) => setOption(i, "option_text", v)}
                placeholder={t("quizCreate.optionPlaceholder", { number: i + 1 })}
                placeholderTextColor="#9CA3AF"
                editable={!isTrueFalse}
              />

              {!isTrueFalse && form.options.length > 2 && (
                <TouchableOpacity
                  onPress={() => removeOption(i)}
                  style={styles.optionRemove}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={18} color={SEMANTIC.error.icon} />
                </TouchableOpacity>
              )}
            </View>
          ))}

          {!isTrueFalse && form.options.length < 6 && (
            <TouchableOpacity style={styles.addOptionBtn} onPress={addOption}>
              <Ionicons name="add-circle-outline" size={18} color={ACCENT.indigo.solid} />
              <Text style={styles.addOptionText}>{t("quizCreate.addOption")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={styles.metaRow}>
        <View style={[styles.field, { flex: 1 }]}>
          <Text style={styles.fieldLabel}>{t("quizCreate.difficultyLabel")}</Text>
          <View style={styles.diffRow}>
            {DIFFICULTIES.map((d) => (
              <TouchableOpacity
                key={d}
                style={[
                  styles.diffChip,
                  form.difficulty === d && styles.diffChipActive,
                  form.difficulty === d && {
                    backgroundColor: SEMANTIC[DIFFICULTY_TONE[d]].bg,
                    borderColor:     SEMANTIC[DIFFICULTY_TONE[d]].icon,
                  },
                ]}
                onPress={() => set("difficulty", d)}
              >
                <Text
                  style={[
                    styles.diffChipText,
                    form.difficulty === d && styles.diffChipTextActive,
                    form.difficulty === d && { color: SEMANTIC[DIFFICULTY_TONE[d]].text },
                  ]}
                >
                  {diffLabels[d]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={[styles.field, { width: 70 }]}>
          <Text style={styles.fieldLabel}>{t("quizCreate.pointsLabel")}</Text>
          <TextInput
            style={styles.fieldInput}
            value={String(form.points)}
            onChangeText={(v) => set("points", v)}
            keyboardType="decimal-pad"
          />
        </View>
      </View>

      <Field
        label={t("quizCreate.explanationLabel")}
        value={form.explanation}
        onChange={(v) => set("explanation", v)}
        placeholder={t("quizCreate.explanationPlaceholder")}
        multiline
      />

      {categories.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t("quizCreate.categoryLabel")}</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.typeRow}
          >
            <TouchableOpacity
              style={[styles.typeChip, !form.category_id && styles.typeChipActive]}
              onPress={() => set("category_id", null)}
            >
              <Text
                style={[
                  styles.typeChipText,
                  !form.category_id && styles.typeChipTextActive,
                ]}
              >
                {t("quizCreate.categoryNone")}
              </Text>
            </TouchableOpacity>
            {categories.map((cat) => (
              <TouchableOpacity
                key={cat.id}
                style={[
                  styles.typeChip,
                  form.category_id === cat.id && {
                    backgroundColor: ACCENT[categoryAccent(cat.name)].wash,
                    borderColor:     ACCENT[categoryAccent(cat.name)].base,
                  },
                ]}
                onPress={() => set("category_id", cat.id)}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    form.category_id === cat.id && styles.typeChipTextActive,
                    form.category_id === cat.id && { color: ACCENT[categoryAccent(cat.name)].deep },
                  ]}
                >
                  {cat.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={styles.formActions}>
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={onCancel}
          disabled={saving}
        >
          <Text style={styles.cancelBtnText}>{t("quizCreate.cancel")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Ionicons name="checkmark" size={18} color="#FFF" />
              <Text style={styles.saveBtnText}>{t("quizCreate.saveQuestion")}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────
// QUESTION LIST ITEM  (extracted so FlatList can use it)
// ─────────────────────────────────────────────────────────────

const QuestionListItem = React.memo(({
  item,
  index,
  onEdit,
  onRemove,
}) => {
  const { t }      = useTranslation();
  const typeLabels = questionTypeLabels(t);
  const diffLabels = difficultyLabels(t);

  return (
  <View style={styles.quizQuestionCard}>
    <View style={styles.quizQuestionNum}>
      <Text style={styles.quizQuestionNumText}>{index + 1}</Text>
    </View>

    <View style={{ flex: 1 }}>
      <Text style={styles.quizQuestionText} numberOfLines={2}>
        {item.question_text}
      </Text>
      <View style={styles.quizQuestionMeta}>
        <Text style={styles.quizQuestionMetaText}>
          {typeLabels[item.question_type] ??
            item.question_type?.replace(/_/g, " ")}
        </Text>
        <Text style={styles.quizQuestionMetaDot}>·</Text>
        <Text style={styles.quizQuestionMetaText}>
          {diffLabels[item.difficulty] ?? item.difficulty}
        </Text>
        <Text style={styles.quizQuestionMetaDot}>·</Text>
        <Text style={styles.quizQuestionMetaText}>
          {item.points_override ?? item.points ?? 1} {t("quizCreate.ptShort")}
        </Text>
      </View>
    </View>

    <View style={styles.quizQuestionBtns}>
      <TouchableOpacity
        onPress={() => onEdit(item)}
        style={styles.quizQuestionIconBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="create-outline" size={17} color={ACCENT.indigo.deep} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onRemove(item)}
        style={styles.quizQuestionIconBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="remove-circle-outline" size={17} color={SEMANTIC.error.icon} />
      </TouchableOpacity>
    </View>
  </View>
  );
});

// ─────────────────────────────────────────────────────────────
// BANK QUESTION LIST ITEM
// ─────────────────────────────────────────────────────────────

const BankQuestionItem = React.memo(({ item, onAdd }) => {
  const { t }      = useTranslation();
  const typeLabels = questionTypeLabels(t);
  const diffLabels = difficultyLabels(t);

  return (
    <TouchableOpacity
      style={styles.bankQuestionCard}
      onPress={() => onAdd(item)}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.bankQuestionText} numberOfLines={2}>
          {item.question_text}
        </Text>
        <Text style={styles.bankQuestionMeta}>
          {typeLabels[item.question_type] ??
            item.question_type.replace(/_/g, " ")}
          {" · "}{diffLabels[item.difficulty] ?? item.difficulty}
          {" · "}{item.points} {t("quizCreate.ptShort")}
        </Text>
      </View>
      <View style={styles.addFromBankBtn}>
        <Ionicons name="add" size={18} color={COLORS.onPrimary} />
      </View>
    </TouchableOpacity>
  );
});

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function CreateQuizScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);

  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;

  const editQuizId     = params?.quizId     || null;
  const editQuestionId = params?.questionId || null;
  const rawTab         = params?.tab        || "details";
  const startTab       = rawTab === "question" ? "questions" : rawTab;
  const isEditing      = !!editQuizId;

  // ── State ─────────────────────────────────────────────────
  const [activeTab,        setActiveTab]        = useState(startTab);
  const [quizForm,         setQuizForm]         = useState(DEFAULT_QUIZ);
  const [quizId,           setQuizId]           = useState(editQuizId);
  const [quizQuestions,    setQuizQuestions]    = useState([]);
  const [bankQuestions,    setBankQuestions]    = useState([]);
  const [categories,       setCategories]       = useState([]);
  const [loading,          setLoading]          = useState(true);
  const [saving,           setSaving]           = useState(false);
  const [showQuestionForm, setShowQuestionForm] = useState(false);
  const [editingQuestion,  setEditingQuestion]  = useState(null);
  const [showBankPicker,   setShowBankPicker]   = useState(false);
  const [bankLoading,      setBankLoading]      = useState(false);
  const [savingQuestion,   setSavingQuestion]   = useState(false);
  const [classes,          setClasses]          = useState([]);
  const [subjects,         setSubjects]         = useState([]);

  const setQuizField = useCallback(
    (key, val) => setQuizForm((prev) => ({ ...prev, [key]: val })),
    []
  );

  // ── Load subjects for selected class ──────────────────────
  const loadSubjectsForClass = useCallback(
    async (classId, opts = {}) => {
      try {
        const subjData = await getTeacherSubjectsForClass(
          teacherId, classId, schoolId
        );
        setSubjects(subjData || []);
      } catch (err) {
        console.warn("Failed to load subjects for class:", err.message);
        setSubjects([]);
      }
      if (!opts.preserveSelection) {
        setQuizForm((prev) => ({ ...prev, subject_id: null }));
      }
    },
    [teacherId, schoolId]
  );

  const handleSelectClass = useCallback(
    (classId) => {
      setQuizForm((prev) => ({
        ...prev,
        class_id:   classId,
        subject_id: null,
      }));
      loadSubjectsForClass(classId);
    },
    [loadSubjectsForClass]
  );

  const handleSelectSubject = useCallback((subjectId) => {
    setQuizForm((prev) => ({ ...prev, subject_id: subjectId }));
  }, []);

  // ── The question bank IS the quiz's subject ────────────────
  //
  // Loaded from the database already filtered to this teacher and this
  // subject (getQuestionBank), and reloaded whenever the subject changes.
  // Nothing here filters a wider list down: a Mathematics quiz never has a
  // Physics question in its bank to filter out, and a bank with no subject
  // chosen is empty rather than everything.
  const bankSubjectId = quizForm.subject_id;
  useEffect(() => {
    let cancelled = false;
    if (!bankSubjectId || !schoolId || !teacherId) {
      setBankQuestions([]);
      return undefined;
    }
    setBankLoading(true);
    getQuestionBank({ schoolId, teacherId, subjectId: bankSubjectId })
      .then((rows) => { if (!cancelled) setBankQuestions(rows || []); })
      .catch((err) => {
        console.warn("[quiz] question bank failed:", err?.message);
        if (!cancelled) setBankQuestions([]);
      })
      .finally(() => { if (!cancelled) setBankLoading(false); });
    return () => { cancelled = true; };
  }, [bankSubjectId, schoolId, teacherId]);

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        // The bank is not loaded here: it belongs to the quiz's subject and is
        // loaded by the effect above once a subject is chosen.
        const [catData, classData] = await Promise.all([
          getCategories(schoolId),
          getTeacherClasses(teacherId, schoolId),
        ]);
        setCategories(catData || []);
        setClasses(classData || []);

        if (editQuizId) {
          const quiz = await getQuizById(editQuizId, { includeQuestions: true });
          if (quiz) {
            setQuizForm({
              title:              quiz.title              || "",
              description:        quiz.description        || "",
              instructions:       quiz.instructions       || "",
              class_id:           quiz.class_id           || null,
              subject_id:         quiz.subject_id         || null,
              time_limit_minutes: quiz.time_limit_minutes
                ? String(quiz.time_limit_minutes) : "",
              shuffle_questions:  !!quiz.shuffle_questions,
              shuffle_options:    !!quiz.shuffle_options,
              questions_per_page: quiz.questions_per_page || 1,
              allow_backtrack:    !!quiz.allow_backtrack,
              max_attempts:       String(quiz.max_attempts  || 1),
              passing_score:      String(quiz.passing_score || 70),
              show_answers_after: quiz.show_answers_after  || "on_completion",
              show_score:         quiz.show_score      !== 0,
              show_explanation:   quiz.show_explanation !== 0,
            });

            // Deduplicate quiz questions by id
            const seenQ   = new Set();
            const uniqueQ = (quiz.questions || []).filter((q) => {
              if (seenQ.has(q.id)) return false;
              seenQ.add(q.id);
              return true;
            });
            setQuizQuestions(uniqueQ);

            if (quiz.class_id) {
              await loadSubjectsForClass(quiz.class_id, { preserveSelection: true });
            }
          }
        }

        if (editQuestionId) {
          const q = await getQuestionById(editQuestionId);
          if (q) {
            setEditingQuestion(q);
            setShowQuestionForm(true);
            setActiveTab("questions");
          }
        }
      } catch (err) {
        console.warn("Failed to load:", err.message);
      } finally {
        setLoading(false);
      }
    };

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save quiz ─────────────────────────────────────────────
  const handleSaveQuiz = useCallback(
    async (andPublish = false) => {
      const currentClassId   = quizForm.class_id;
      const currentSubjectId = quizForm.subject_id;

      if (!quizForm.title.trim()) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errQuizTitle"));
        return;
      }
      if (!currentClassId) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errSelectClass"));
        return;
      }
      if (!currentSubjectId) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errSelectSubject"));
        return;
      }

      setSaving(true);
      try {
        const payload = {
          title:              quizForm.title.trim(),
          description:        quizForm.description        || "",
          instructions:       quizForm.instructions       || "",
          class_id:           currentClassId,
          subject_id:         currentSubjectId,
          schoolId,
          created_by:         teacherId,
          time_limit_minutes: quizForm.time_limit_minutes
            ? parseInt(quizForm.time_limit_minutes, 10) : null,
          shuffle_questions:  quizForm.shuffle_questions,
          shuffle_options:    quizForm.shuffle_options,
          questions_per_page: quizForm.questions_per_page || 1,
          allow_backtrack:    quizForm.allow_backtrack,
          max_attempts:       parseInt(quizForm.max_attempts,  10) || 1,
          passing_score:      parseFloat(quizForm.passing_score)   || 70,
          show_answers_after: quizForm.show_answers_after  || "on_completion",
          show_score:         quizForm.show_score,
          show_explanation:   quizForm.show_explanation,
        };

        console.log("💾 Saving quiz payload:", {
          title:      payload.title,
          class_id:   payload.class_id,
          subject_id: payload.subject_id,
          schoolId:   payload.schoolId,
          created_by: payload.created_by,
        });

        let savedId = quizId;

        if (quizId) {
          await updateQuiz(quizId, payload);
        } else {
          const created = await createQuiz(payload);
          savedId = created?.id || created?._id;
          if (!savedId) throw new Error("createQuiz did not return an id");
          setQuizId(savedId);
          console.log(`✅ Quiz created with id: ${savedId}`);
        }

        if (andPublish && savedId) {
          await publishQuiz(savedId);
        }

        Alert.alert(
          t("quizCreate.savedTitle"),
          andPublish
            ? t("quizCreate.quizPublished")
            : t("quizCreate.quizSavedDraft"),
          [{
            text: t("quizCreate.ok"),
            onPress: () => { if (andPublish) router.back(); },
          }]
        );
      } catch (err) {
        console.warn("Save quiz error:", err.message);
        Alert.alert(
          t("quizCreate.errorTitle"),
          errorText(t, err, "quizCreate.errSaveQuiz")
        );
      } finally {
        setSaving(false);
      }
    },
    [quizForm, quizId, schoolId, teacherId, router, t]
  );

  // ── Save question ─────────────────────────────────────────
  const handleSaveQuestion = useCallback(
    async (form) => {
      if (savingQuestion) return;

      // A question is saved under the quiz's subject. Without one there is
      // no bank for it to go in, so the form refuses rather than saving a
      // question nobody will find again.
      if (!quizForm.subject_id) {
        Alert.alert(t("quizCreate.validationTitle"), t("quizCreate.errSelectSubject"));
        return;
      }

      setSavingQuestion(true);
      try {
        const payload = {
          ...form,
          schoolId,
          subject_id: quizForm.subject_id,
          created_by: teacherId,
          points:     parseFloat(form.points) || 1,
        };

        let savedQuestion;

        if (editingQuestion?.id) {
          await updateQuestion(editingQuestion.id, payload);
          await updateQuestionOptions(editingQuestion.id, form.options);
          savedQuestion = await getQuestionById(editingQuestion.id);

          setBankQuestions((prev) =>
            prev.map((q) => q.id === savedQuestion.id ? savedQuestion : q)
          );
          setQuizQuestions((prev) =>
            prev.map((q) => q.id === savedQuestion.id ? savedQuestion : q)
          );
        } else {
          savedQuestion = await createQuestion(payload);

          setBankQuestions((prev) => {
            if (prev.some((q) => q.id === savedQuestion.id)) return prev;
            return [savedQuestion, ...prev];
          });

          if (quizId) {
            setQuizQuestions((prev) => {
              if (prev.some((q) => q.id === savedQuestion.id)) return prev;
              addQuestionToQuiz(quizId, savedQuestion.id).catch((err) =>
                console.warn('addQuestionToQuiz failed:', err.message)
              );
              return [...prev, savedQuestion];
            });
          }
        }

        setShowQuestionForm(false);
        setEditingQuestion(null);
      } catch (err) {
        console.warn("Save question error:", err.message);
        Alert.alert(
          t("quizCreate.errorTitle"),
          errorText(t, err, "quizCreate.errSaveQuestion")
        );
      } finally {
        setSavingQuestion(false);
      }
    },
    [editingQuestion, quizId, schoolId, teacherId, savingQuestion, quizForm.subject_id, t]
  );

  // ── Add from bank ─────────────────────────────────────────
  const handleAddFromBank = useCallback(
    async (question) => {
      if (!quizId) {
        Alert.alert(
          t("quizCreate.saveFirstTitle"),
          t("quizCreate.saveFirstBody")
        );
        return;
      }

      if (quizQuestions.some((q) => q.id === question.id)) {
        Alert.alert(
          t("quizCreate.alreadyAddedTitle"),
          t("quizCreate.alreadyAddedBody")
        );
        return;
      }

      try {
        await addQuestionToQuiz(quizId, question.id);
        setQuizQuestions((prev) => {
          if (prev.some((q) => q.id === question.id)) return prev;
          return [...prev, question];
        });
      } catch {
        Alert.alert(t("quizCreate.errorTitle"), t("quizCreate.errAddQuestion"));
      }
    },
    [quizId, quizQuestions, t]
  );

  const handleRemoveFromQuiz = useCallback(
    async (question) => {
      if (!quizId) return;
      Alert.alert(
        t("quizCreate.removeQuestionTitle"),
        t("quizCreate.removeQuestionBody"),
        [
          { text: t("quizCreate.cancel"), style: "cancel" },
          {
            text:  t("quizCreate.remove"),
            style: "destructive",
            onPress: async () => {
              try {
                await removeQuestionFromQuiz(quizId, question.id);
                setQuizQuestions((prev) =>
                  prev.filter((q) => q.id !== question.id)
                );
              } catch {
                Alert.alert(
                  t("quizCreate.errorTitle"),
                  t("quizCreate.errRemoveQuestion")
                );
              }
            },
          },
        ]
      );
    },
    [quizId, t]
  );

  const openEditQuestion  = useCallback((q) => {
    setEditingQuestion(q);
    setShowQuestionForm(true);
  }, []);

  const openNewQuestion   = useCallback(() => {
    setEditingQuestion(null);
    setShowQuestionForm(true);
  }, []);

  const closeQuestionForm = useCallback(() => {
    setShowQuestionForm(false);
    setEditingQuestion(null);
  }, []);

  // ── Stable callbacks for FlatList renderItem ──────────────
  const renderQuizQuestion = useCallback(({ item, index }) => (
    <QuestionListItem
      item={item}
      index={index}
      onEdit={openEditQuestion}
      onRemove={handleRemoveFromQuiz}
    />
  ), [openEditQuestion, handleRemoveFromQuiz]);

  const renderBankQuestion = useCallback(({ item }) => (
    <BankQuestionItem item={item} onAdd={handleAddFromBank} />
  ), [handleAddFromBank]);

  const keyExtractor = useCallback((item) => item.id, []);

  // ── Tab: Details ──────────────────────────────────────────
  const renderDetailsTab = () => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.tabContent}
      keyboardShouldPersistTaps="handled"
    >
      <SectionHeader title={t("quizCreate.sectionBasic")} icon="information-circle" />

      {/* CLASS PICKER */}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>
          {t("quizCreate.classLabel")} <Text style={{ color: SEMANTIC.error.text }}>*</Text>
        </Text>
        {__DEV__ && quizForm.class_id && (
          <Text style={{ fontSize: 10, color: COLORS.textSecondary, marginBottom: 4 }}>
            class_id: {quizForm.class_id}
          </Text>
        )}
        {classes.length === 0 ? (
          <Text style={styles.pickerEmpty}>{t("quizCreate.noClasses")}</Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pickerRow}
          >
            {classes.map((cls) => (
              <TouchableOpacity
                key={cls.id}
                style={[
                  styles.pickerChip,
                  quizForm.class_id === cls.id && styles.pickerChipActive,
                  quizForm.class_id === cls.id && {
                    backgroundColor: ACCENT[levelAccent(cls.level ?? cls.name)].wash,
                    borderColor:     ACCENT[levelAccent(cls.level ?? cls.name)].base,
                  },
                ]}
                onPress={() => handleSelectClass(cls.id)}
              >
                <Text
                  style={[
                    styles.pickerChipText,
                    quizForm.class_id === cls.id && styles.pickerChipTextActive,
                    quizForm.class_id === cls.id && { color: ACCENT[levelAccent(cls.level ?? cls.name)].deep },
                  ]}
                >
                  {cls.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* SUBJECT PICKER */}
      {quizForm.class_id && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>
            {t("quizCreate.subjectLabel")} <Text style={{ color: SEMANTIC.error.text }}>*</Text>
          </Text>
          {__DEV__ && quizForm.subject_id && (
            <Text style={{ fontSize: 10, color: COLORS.textSecondary, marginBottom: 4 }}>
              subject_id: {quizForm.subject_id}
            </Text>
          )}
          {subjects.length === 0 ? (
            <Text style={styles.pickerEmpty}>
              {t("quizCreate.noSubjects")}
            </Text>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pickerRow}
            >
              {subjects.map((subj) => (
                <TouchableOpacity
                  key={subj.id}
                  style={[
                    styles.pickerChip,
                    quizForm.subject_id === subj.id && styles.pickerChipActive,
                    quizForm.subject_id === subj.id && { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base },
                  ]}
                  onPress={() => handleSelectSubject(subj.id)}
                >
                  <Text
                    style={[
                      styles.pickerChipText,
                      quizForm.subject_id === subj.id && styles.pickerChipTextActive,
                      quizForm.subject_id === subj.id && { color: ACCENT.slate.deep },
                    ]}
                  >
                    {subj.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      <Field
        label={t("quizCreate.quizTitleLabel")}
        value={quizForm.title}
        onChange={(v) => setQuizField("title", v)}
        placeholder={t("quizCreate.quizTitlePlaceholder")}
        required
      />

      <Field
        label={t("quizCreate.descriptionLabel")}
        value={quizForm.description}
        onChange={(v) => setQuizField("description", v)}
        placeholder={t("quizCreate.descriptionPlaceholder")}
        multiline
      />

      <Field
        label={t("quizCreate.instructionsLabel")}
        value={quizForm.instructions}
        onChange={(v) => setQuizField("instructions", v)}
        placeholder={t("quizCreate.instructionsPlaceholder")}
        multiline
      />

      <SectionHeader title={t("quizCreate.sectionTiming")} icon="time" />

      <Field
        label={t("quizCreate.timeLimitLabel")}
        value={quizForm.time_limit_minutes}
        onChange={(v) => setQuizField("time_limit_minutes", v)}
        placeholder={t("quizCreate.timeLimitPlaceholder")}
        keyboardType="number-pad"
      />

      <TouchableOpacity
        style={[styles.primaryBtn, saving && styles.primaryBtnDisabled]}
        onPress={() => handleSaveQuiz(false)}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator size="small" color="#FFF" />
        ) : (
          <>
            <Ionicons name="save-outline" size={18} color="#FFF" />
            <Text style={styles.primaryBtnText}>{t("quizCreate.saveDraft")}</Text>
          </>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.primaryBtn,
          { backgroundColor: ACCENT.green.solid },
          saving && styles.primaryBtnDisabled,
        ]}
        onPress={() => handleSaveQuiz(true)}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator size="small" color="#FFF" />
        ) : (
          <>
            <Ionicons name="globe-outline" size={18} color="#FFF" />
            <Text style={styles.primaryBtnText}>{t("quizCreate.savePublish")}</Text>
          </>
        )}
      </TouchableOpacity>

      <View style={{ height: 24 }} />
    </ScrollView>
  );

  // ── Tab: Questions ────────────────────────────────────────
  const renderQuestionsTab = () => {
    // ── Show question form ────────────────────────────────
    if (showQuestionForm) {
      return (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.tabContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.formHeaderRow}>
            <Text style={styles.formHeaderTitle}>
              {editingQuestion
                ? t("quizCreate.editQuestion")
                : t("quizCreate.newQuestion")}
            </Text>
            {editingQuestion && (
              <View style={styles.editingBadge}>
                <Ionicons name="create-outline" size={12} color={ACCENT.indigo.deep} />
                <Text style={styles.editingBadgeText}>{t("quizCreate.editingBadge")}</Text>
              </View>
            )}
          </View>

          <QuestionForm
            initial={editingQuestion}
            categories={categories}
            onSave={handleSaveQuestion}
            onCancel={closeQuestionForm}
            saving={savingQuestion}
          />
        </ScrollView>
      );
    }

    // ── Show bank picker ──────────────────────────────────
    if (showBankPicker) {
      const notAdded = bankQuestions.filter(
        (bq) => !quizQuestions.some((qq) => qq.id === bq.id)
      );
      const bankSubject     = subjects.find((s) => s.id === quizForm.subject_id) || null;
      const bankSubjectName = bankSubject?.name || t("quizCreate.subjectLabel");

      // Four honest states, in order: no subject chosen; loading; this
      // teacher has no questions in this subject; every one is already in.
      let emptyIcon = "list-outline", emptyTitle = null, emptySub = null;
      if (!quizForm.subject_id) {
        emptyIcon  = "book-outline";
        emptyTitle = t("quizCreate.bankNoSubjectTitle");
        emptySub   = t("quizCreate.bankNoSubjectSub");
      } else if (bankLoading) {
        emptyIcon  = "hourglass-outline";
        emptyTitle = t("quizCreate.bankLoading");
        emptySub   = "";
      } else if (bankQuestions.length === 0) {
        emptyIcon  = "library-outline";
        emptyTitle = t("quizCreate.bankEmptyForSubjectTitle", { subject: bankSubjectName });
        emptySub   = t("quizCreate.bankEmptyForSubjectSub",   { subject: bankSubjectName });
      } else if (notAdded.length === 0) {
        emptyTitle = t("quizCreate.bankEmptyTitle");
        emptySub   = t("quizCreate.bankEmptySub");
      }

      return (
        // ✅ Use flex:1 column layout so header stays fixed
        <View style={styles.questionTabContainer}>
          <View style={styles.bankPickerHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.bankPickerTitle}>
                {t("quizCreate.bankTitle", { count: notAdded.length })}
              </Text>
              {quizForm.subject_id ? (
                <Text style={styles.bankPickerScope}>
                  {t("quizCreate.bankSubjectOnly", { subject: bankSubjectName })}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={() => setShowBankPicker(false)}>
              <Text style={styles.bankPickerClose}>{t("quizCreate.done")}</Text>
            </TouchableOpacity>
          </View>

          {emptyTitle !== null ? (
            <View style={styles.emptyState}>
              <IconSquare icon={emptyIcon} accent="indigo" size={56} radius={16} />
              <Text style={styles.emptyTitle}>{emptyTitle}</Text>
              {emptySub ? <Text style={styles.emptySubtitle}>{emptySub}</Text> : null}
            </View>
          ) : (
            // ✅ FlatList fills remaining space, header never shrinks
            <FlatList
              data={notAdded}
              keyExtractor={keyExtractor}
              renderItem={renderBankQuestion}
              contentContainerStyle={styles.flatListContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />
          )}
        </View>
      );
    }

    // ── Show question list ────────────────────────────────
    return (
      // ✅ flex:1 column — action bar and count row are fixed height,
      //    FlatList gets all remaining space
      <View style={styles.questionTabContainer}>

        {/* ── Fixed: action buttons ── */}
        <View style={styles.questionTabActions}>
          <TouchableOpacity
            style={styles.questionTabBtn}
            onPress={openNewQuestion}
            activeOpacity={0.8}
          >
            <Ionicons name="add-circle-outline" size={18} color={ACCENT.indigo.deep} />
            <Text style={styles.questionTabBtnText}>{t("quizCreate.newQuestion")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.questionTabBtn,
              { backgroundColor: ACCENT.green.wash, borderColor: ACCENT.green.base },
            ]}
            onPress={() => setShowBankPicker(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="library-outline" size={18} color={ACCENT.green.deep} />
            <Text style={[styles.questionTabBtnText, { color: ACCENT.green.deep }]}>
              {t("quizCreate.fromBank")}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Fixed: question count ── */}
        <View style={styles.questionCountRow}>
          <Text style={styles.questionCount}>
            {quizQuestions.length === 1
              ? t("quizCreate.questionCountOne")
              : t("quizCreate.questionCountMany", {
                  count: quizQuestions.length,
                })}
          </Text>
          {!quizId && (
            <Text style={styles.questionCountHint}>
              {t("quizCreate.attachHint")}
            </Text>
          )}
        </View>

        {/* ── Scrollable: question list ── */}
        {quizQuestions.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSquare icon="help-circle-outline" accent="indigo" size={56} radius={16} />
            <Text style={styles.emptyTitle}>{t("quizCreate.noQuestionsTitle")}</Text>
            <Text style={styles.emptySubtitle}>
              {t("quizCreate.noQuestionsSub")}
            </Text>
          </View>
        ) : (
          // ✅ FlatList instead of ScrollView — naturally takes
          //    only the remaining flex space without pushing headers off screen
          <FlatList
            data={quizQuestions}
            keyExtractor={keyExtractor}
            renderItem={renderQuizQuestion}
            contentContainerStyle={styles.flatListContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        )}
      </View>
    );
  };

  // ── Tab: Settings ─────────────────────────────────────────
  const feedbackLabels = {
    immediately:    t("quizCreate.feedbackImmediately"),
    on_completion:  t("quizCreate.feedbackOnCompletion"),
    after_deadline: t("quizCreate.feedbackAfterDeadline"),
    never:          t("quizCreate.feedbackNever"),
  };

  const renderSettingsTab = () => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.tabContent}
    >
      <SectionHeader title={t("quizCreate.sectionAttempts")} icon="repeat" />

      <Field
        label={t("quizCreate.maxAttemptsLabel")}
        value={quizForm.max_attempts}
        onChange={(v) => setQuizField("max_attempts", v)}
        placeholder="1"
        keyboardType="number-pad"
      />

      <Field
        label={t("quizCreate.passingScoreLabel")}
        value={quizForm.passing_score}
        onChange={(v) => setQuizField("passing_score", v)}
        placeholder="70"
        keyboardType="decimal-pad"
      />

      <SectionHeader title={t("quizCreate.sectionDelivery")} icon="layers" />

      <ToggleRow
        label={t("quizCreate.shuffleQuestions")}
        subtitle={t("quizCreate.shuffleQuestionsSub")}
        value={quizForm.shuffle_questions}
        onChange={(v) => setQuizField("shuffle_questions", v)}
      />

      <ToggleRow
        label={t("quizCreate.shuffleOptions")}
        subtitle={t("quizCreate.shuffleOptionsSub")}
        value={quizForm.shuffle_options}
        onChange={(v) => setQuizField("shuffle_options", v)}
      />

      <ToggleRow
        label={t("quizCreate.allowBacktrack")}
        subtitle={t("quizCreate.allowBacktrackSub")}
        value={quizForm.allow_backtrack}
        onChange={(v) => setQuizField("allow_backtrack", v)}
      />

      <SectionHeader title={t("quizCreate.sectionFeedback")} icon="chatbubble-ellipses" />

      {FEEDBACK_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={styles.radioRow}
          onPress={() => setQuizField("show_answers_after", opt.value)}
          activeOpacity={0.7}
        >
          <View
            style={[
              styles.radioOuter,
              quizForm.show_answers_after === opt.value && styles.radioOuterActive,
            ]}
          >
            {quizForm.show_answers_after === opt.value && (
              <View style={styles.radioInner} />
            )}
          </View>
          <Text style={styles.radioLabel}>{feedbackLabels[opt.value]}</Text>
        </TouchableOpacity>
      ))}

      <ToggleRow
        label={t("quizCreate.showScore")}
        subtitle={t("quizCreate.showScoreSub")}
        value={quizForm.show_score}
        onChange={(v) => setQuizField("show_score", v)}
      />

      <ToggleRow
        label={t("quizCreate.showExplanations")}
        subtitle={t("quizCreate.showExplanationsSub")}
        value={quizForm.show_explanation}
        onChange={(v) => setQuizField("show_explanation", v)}
      />

      <TouchableOpacity
        style={[styles.primaryBtn, saving && styles.primaryBtnDisabled]}
        onPress={() => handleSaveQuiz(false)}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator size="small" color="#FFF" />
        ) : (
          <>
            <Ionicons name="save-outline" size={18} color="#FFF" />
            <Text style={styles.primaryBtnText}>{t("quizCreate.saveSettings")}</Text>
          </>
        )}
      </TouchableOpacity>

      <View style={{ height: 32 }} />
    </ScrollView>
  );

  // ── Loading ───────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("quizCreate.loading")}</Text>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
    >
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (showQuestionForm)  { closeQuestionForm();       return; }
            if (showBankPicker)    { setShowBankPicker(false);  return; }
            router.back();
          }}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
        <Text style={styles.headerTitle}>
          {showQuestionForm
            ? editingQuestion
              ? t("quizCreate.editQuestion")
              : t("quizCreate.newQuestion")
            : isEditing
              ? t("quizCreate.editQuiz")
              : t("quizCreate.createQuiz")}
        </Text>

        {quizId && !showQuestionForm && !showBankPicker && (
          <TouchableOpacity
            style={styles.publishBtn}
            onPress={() => handleSaveQuiz(true)}
            disabled={saving}
            activeOpacity={0.8}
          >
            <Ionicons name="globe-outline" size={16} color="#FFF" />
            <Text style={styles.publishBtnText}>{t("quizCreate.publish")}</Text>
          </TouchableOpacity>
        )}
      </View>

      {!showQuestionForm && !showBankPicker && (
        <TabBar active={activeTab} onChange={setActiveTab} tabs={TABS} />
      )}

      {/* ✅ flex:1 ensures the tab content fills remaining screen space */}
      <View style={styles.tabContentWrapper}>
        {activeTab === "details"   && renderDetailsTab()}
        {activeTab === "questions" && renderQuestionsTab()}
        {activeTab === "settings"  && renderSettingsTab()}
      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.page },
  centered:  {
    flex: 1, justifyContent: "center",
    alignItems: "center", backgroundColor: COLORS.page,
  },
  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 10,
  },
  backButton: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerIcon:  { marginRight: 0 },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: "700", color: COLORS.text },
  publishBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#059669", borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, gap: 4,
  },
  publishBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

  tabBar: {
    flexDirection: "row", backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  tab: {
    flex: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", paddingVertical: 12, gap: 5,
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  tabActive:      { borderBottomColor: ACCENT.indigo.base },
  tabLabel:       { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  tabLabelActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  // ✅ Wrapper that gives all tab content the remaining flex space
  tabContentWrapper: { flex: 1 },

  tabContent: { padding: 16 },

  // ✅ Questions tab outer container — column flex so fixed headers
  //    stay pinned and list scrolls in remaining space
  questionTabContainer: {
    flex:           1,
    flexDirection:  "column",
    backgroundColor: COLORS.page,
  },

  // ✅ FlatList padding — replaces ScrollView contentContainerStyle
  flatListContent: {
    padding:       16,
    paddingBottom: 32,
  },

  field:      { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: COLORS.text, marginBottom: 6 },
  fieldHint:  { fontSize: 11, color: COLORS.textSecondary, fontWeight: "400" },
  fieldInput: {
    backgroundColor: COLORS.surface, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    fontSize: 14, color: COLORS.text,
    borderWidth: 1, borderColor: COLORS.border,
  },
  fieldInputMulti:    { height: 80, textAlignVertical: "top" },
  fieldInputDisabled: { backgroundColor: COLORS.page, color: COLORS.textSecondary },

  sectionHeaderRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginTop: 8, marginBottom: 12,
  },
  sectionHeader: {
    fontSize: 13, fontWeight: "700", color: COLORS.textSecondary,
    textTransform: "uppercase", letterSpacing: 0.5,
  },

  pickerRow:            { gap: 8, paddingBottom: 4 },
  pickerChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  pickerChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  pickerChipText:       { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  pickerChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },
  pickerEmpty:          { fontSize: 13, color: COLORS.textSecondary, fontStyle: "italic", marginTop: 4 },

  toggleRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: COLORS.surface, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border,
    padding: 14, marginBottom: 8,
  },
  toggleLabel:    { fontSize: 14, fontWeight: "600", color: COLORS.text },
  toggleSubtitle: { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },

  radioRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: COLORS.surface, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.border,
    padding: 12, marginBottom: 6, gap: 10,
  },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: COLORS.textMuted,
    alignItems: "center", justifyContent: "center",
  },
  radioOuterActive: { borderColor: ACCENT.indigo.base },
  radioInner: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: ACCENT.indigo.solid,
  },
  radioLabel: { fontSize: 14, color: COLORS.text },

  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 14, marginTop: 8, gap: 8,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText:     { color: "#FFF", fontWeight: "700", fontSize: 15 },

  questionForm: {},

  formHeaderRow:   { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 10 },
  formHeaderTitle: { fontSize: 18, fontWeight: "700", color: COLORS.text, flex: 1 },
  editingBadge: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: ACCENT.indigo.wash, borderRadius: 20,
    borderWidth: 1, borderColor: ACCENT.indigo.base + "4D",
    paddingHorizontal: 10, paddingVertical: 4, gap: 4,
  },
  editingBadgeText: { fontSize: 11, fontWeight: "700", color: ACCENT.indigo.deep },

  typeRow: { gap: 8, paddingBottom: 10 },
  typeChip: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border, gap: 5,
  },
  typeChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  typeChipText:       { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },
  typeChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  optionsSection: { marginBottom: 14 },
  optionRow:      { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  optionCorrectToggle: {
    width: 32, height: 32,
    alignItems: "center", justifyContent: "center",
  },
  optionCorrectToggleOn: {},
  optionInput: {
    flex: 1, backgroundColor: COLORS.surface, borderRadius: 10,
    paddingVertical: 9, paddingHorizontal: 12,
    fontSize: 14, color: COLORS.text,
    borderWidth: 1, borderColor: COLORS.border,
  },
  optionInputCorrect: { borderColor: SEMANTIC.success.icon, backgroundColor: SEMANTIC.success.bg },
  optionRemove:       { padding: 4 },
  addOptionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  addOptionText: { fontSize: 13, color: ACCENT.indigo.deep, fontWeight: "600" },

  metaRow: { flexDirection: "row", gap: 12 },

  diffRow: { flexDirection: "row", gap: 6 },
  diffChip: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  diffChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  diffChipText:       { fontSize: 12, color: COLORS.textSecondary },
  diffChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  formActions:    { flexDirection: "row", gap: 10, marginTop: 16 },
  cancelBtn: {
    flex: 1, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border, alignItems: "center",
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600", color: COLORS.textSecondary },
  saveBtn: {
    flex: 2, flexDirection: "row", alignItems: "center",
    justifyContent: "center", backgroundColor: "#4F46E5",
    borderRadius: 12, paddingVertical: 13, gap: 6,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText:     { fontSize: 14, fontWeight: "700", color: "#FFF" },

  // ✅ Fixed action bar — never shrinks
  questionTabActions: {
    flexDirection: "row", gap: 10,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    // No flex here — intrinsic height only
  },
  questionTabBtn: {
    flex: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", paddingVertical: 10,
    borderRadius: 10, backgroundColor: ACCENT.indigo.wash,
    borderWidth: 1, borderColor: ACCENT.indigo.base, gap: 6,
  },
  questionTabBtnText: { fontSize: 13, fontWeight: "700", color: ACCENT.indigo.deep },

  // ✅ Fixed count row — never shrinks
  questionCountRow: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: COLORS.page,
    // No flex here — intrinsic height only
  },
  questionCount:     { fontSize: 13, fontWeight: "600", color: COLORS.text },
  questionCountHint: { fontSize: 11, color: SEMANTIC.error.text, marginTop: 2 },

  quizQuestionCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: ACCENT.indigo.wash, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border,
    borderLeftWidth: 3, borderLeftColor: ACCENT.indigo.base,
    padding: 12, marginBottom: 8, gap: 10,
    shadowColor: COLORS.shadow, shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  quizQuestionNum: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: ACCENT.indigo.solid,
    alignItems: "center", justifyContent: "center",
  },
  quizQuestionNumText: { fontSize: 13, fontWeight: "700", color: COLORS.onPrimary },
  quizQuestionText:    { fontSize: 14, fontWeight: "600", color: COLORS.text, lineHeight: 20 },
  quizQuestionMeta:    { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  quizQuestionMetaText:{ fontSize: 11, color: COLORS.textSecondary },
  quizQuestionMetaDot: { fontSize: 11, color: COLORS.textSecondary },
  quizQuestionBtns:    { flexDirection: "row", gap: 4 },
  quizQuestionIconBtn: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: COLORS.surface,
    alignItems: "center", justifyContent: "center",
  },

  bankPickerHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    // No flex — intrinsic height only
  },
  bankPickerTitle: { fontSize: 16, fontWeight: "700", color: COLORS.text },
  bankPickerScope: { fontSize: 12, fontWeight: "600", color: ACCENT.slate.deep, marginTop: 2 },
  bankPickerClose: { fontSize: 14, fontWeight: "700", color: ACCENT.indigo.deep },
  bankQuestionCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: ACCENT.indigo.wash, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border,
    borderLeftWidth: 3, borderLeftColor: ACCENT.indigo.base,
    padding: 12, marginBottom: 8, gap: 10,
    shadowColor: COLORS.shadow, shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  bankQuestionText: { fontSize: 14, fontWeight: "600", color: COLORS.text, lineHeight: 20 },
  bankQuestionMeta: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  addFromBankBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: ACCENT.indigo.solid,
    alignItems: "center", justifyContent: "center",
  },

  emptyState: {
    flex: 1,
    alignItems: "center", justifyContent: "center",
    paddingVertical: 48, paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: COLORS.text },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
});