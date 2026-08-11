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
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
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
  getQuestions,
  publishQuiz,
  getTeacherClasses,
  getTeacherSubjectsForClass,
} from "../../../src/services/quiz.service";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "details",   label: "Details",   icon: "information-circle-outline" },
  { id: "questions", label: "Questions", icon: "list-outline"                },
  { id: "settings",  label: "Settings",  icon: "settings-outline"            },
];

const QUESTION_TYPES = [
  { value: "multiple_choice",   label: "Multiple Choice",   icon: "radio-button-on-outline"  },
  { value: "multiple_select",   label: "Multiple Select",   icon: "checkbox-outline"          },
  { value: "true_false",        label: "True / False",      icon: "swap-horizontal-outline"   },
  { value: "fill_in_the_blank", label: "Fill in the Blank", icon: "create-outline"            },
];

const DIFFICULTIES = ["easy", "medium", "hard"];

const FEEDBACK_OPTIONS = [
  { value: "immediately",    label: "After each question" },
  { value: "on_completion",  label: "After submitting"    },
  { value: "after_deadline", label: "After deadline"      },
  { value: "never",          label: "Never"               },
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

const TabBar = ({ active, onChange, tabs }) => (
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
          color={active === tab.id ? "#4F46E5" : "#9CA3AF"}
        />
        <Text style={[styles.tabLabel, active === tab.id && styles.tabLabelActive]}>
          {tab.label}
        </Text>
      </TouchableOpacity>
    ))}
  </View>
);

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
      {required && <Text style={{ color: "#DC2626" }}> *</Text>}
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
      trackColor={{ false: "#E5E7EB", true: "#C7D2FE" }}
      thumbColor={value ? "#4F46E5" : "#9CA3AF"}
    />
  </View>
);

const SectionHeader = ({ title }) => (
  <Text style={styles.sectionHeader}>{title}</Text>
);

// ─────────────────────────────────────────────────────────────
// QUESTION FORM
// ─────────────────────────────────────────────────────────────

const QuestionForm = ({ initial, categories, onSave, onCancel, saving }) => {
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
      Alert.alert("Validation", "Question text is required");
      return;
    }
    if (form.question_type === "fill_in_the_blank") {
      if (!form.options[0]?.option_text?.trim()) {
        Alert.alert("Validation", "Correct answer is required");
        return;
      }
    } else {
      const hasCorrect = form.options.some((o) => o.is_correct);
      if (!hasCorrect) {
        Alert.alert("Validation", "At least one correct answer is required");
        return;
      }
      const hasText = form.options.every((o) => o.option_text.trim());
      if (!hasText) {
        Alert.alert("Validation", "All options must have text");
        return;
      }
    }
    onSave(form);
  }, [form, onSave]);

  const isTrueFalse   = form.question_type === "true_false";
  const isFillInBlank = form.question_type === "fill_in_the_blank";
  const showOptions   = !isFillInBlank;

  return (
    <View style={styles.questionForm}>
      <Text style={styles.fieldLabel}>Question Type</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.typeRow}
      >
        {QUESTION_TYPES.map((t) => (
          <TouchableOpacity
            key={t.value}
            style={[
              styles.typeChip,
              form.question_type === t.value && styles.typeChipActive,
            ]}
            onPress={() => set("question_type", t.value)}
          >
            <Ionicons
              name={t.icon}
              size={14}
              color={form.question_type === t.value ? "#4F46E5" : "#9CA3AF"}
            />
            <Text
              style={[
                styles.typeChipText,
                form.question_type === t.value && styles.typeChipTextActive,
              ]}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Field
        label="Question"
        value={form.question_text}
        onChange={(v) => set("question_text", v)}
        placeholder="Enter your question..."
        multiline
        required
      />

      {isFillInBlank && (
        <Field
          label="Correct Answer"
          value={form.options[0]?.option_text || ""}
          onChange={(v) =>
            set("options", [{ option_text: v, is_correct: true }])
          }
          placeholder="Enter the correct answer..."
          required
        />
      )}

      {showOptions && (
        <View style={styles.optionsSection}>
          <Text style={styles.fieldLabel}>
            Answer Options
            {form.question_type === "multiple_select" && (
              <Text style={styles.fieldHint}> (check all that apply)</Text>
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
                  color={opt.is_correct ? "#059669" : "#D1D5DB"}
                />
              </TouchableOpacity>

              <TextInput
                style={[
                  styles.optionInput,
                  opt.is_correct && styles.optionInputCorrect,
                ]}
                value={opt.option_text}
                onChangeText={(v) => setOption(i, "option_text", v)}
                placeholder={`Option ${i + 1}`}
                placeholderTextColor="#9CA3AF"
                editable={!isTrueFalse}
              />

              {!isTrueFalse && form.options.length > 2 && (
                <TouchableOpacity
                  onPress={() => removeOption(i)}
                  style={styles.optionRemove}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle-outline" size={18} color="#DC2626" />
                </TouchableOpacity>
              )}
            </View>
          ))}

          {!isTrueFalse && form.options.length < 6 && (
            <TouchableOpacity style={styles.addOptionBtn} onPress={addOption}>
              <Ionicons name="add-circle-outline" size={18} color="#4F46E5" />
              <Text style={styles.addOptionText}>Add Option</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={styles.metaRow}>
        <View style={[styles.field, { flex: 1 }]}>
          <Text style={styles.fieldLabel}>Difficulty</Text>
          <View style={styles.diffRow}>
            {DIFFICULTIES.map((d) => (
              <TouchableOpacity
                key={d}
                style={[
                  styles.diffChip,
                  form.difficulty === d && styles.diffChipActive,
                ]}
                onPress={() => set("difficulty", d)}
              >
                <Text
                  style={[
                    styles.diffChipText,
                    form.difficulty === d && styles.diffChipTextActive,
                  ]}
                >
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={[styles.field, { width: 70 }]}>
          <Text style={styles.fieldLabel}>Points</Text>
          <TextInput
            style={styles.fieldInput}
            value={String(form.points)}
            onChangeText={(v) => set("points", v)}
            keyboardType="decimal-pad"
          />
        </View>
      </View>

      <Field
        label="Explanation (shown after quiz)"
        value={form.explanation}
        onChange={(v) => set("explanation", v)}
        placeholder="Why is this answer correct? (optional)"
        multiline
      />

      {categories.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Category</Text>
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
                None
              </Text>
            </TouchableOpacity>
            {categories.map((cat) => (
              <TouchableOpacity
                key={cat.id}
                style={[
                  styles.typeChip,
                  form.category_id === cat.id && styles.typeChipActive,
                ]}
                onPress={() => set("category_id", cat.id)}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    form.category_id === cat.id && styles.typeChipTextActive,
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
          <Text style={styles.cancelBtnText}>Cancel</Text>
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
              <Text style={styles.saveBtnText}>Save Question</Text>
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
}) => (
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
          {item.question_type?.replace(/_/g, " ")}
        </Text>
        <Text style={styles.quizQuestionMetaDot}>·</Text>
        <Text style={styles.quizQuestionMetaText}>{item.difficulty}</Text>
        <Text style={styles.quizQuestionMetaDot}>·</Text>
        <Text style={styles.quizQuestionMetaText}>
          {item.points_override ?? item.points ?? 1} pt
        </Text>
      </View>
    </View>

    <View style={styles.quizQuestionBtns}>
      <TouchableOpacity
        onPress={() => onEdit(item)}
        style={styles.quizQuestionIconBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="create-outline" size={17} color="#4F46E5" />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onRemove(item)}
        style={styles.quizQuestionIconBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="remove-circle-outline" size={17} color="#DC2626" />
      </TouchableOpacity>
    </View>
  </View>
));

// ─────────────────────────────────────────────────────────────
// BANK QUESTION LIST ITEM
// ─────────────────────────────────────────────────────────────

const BankQuestionItem = React.memo(({ item, onAdd }) => (
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
        {item.question_type.replace(/_/g, " ")}
        {" · "}{item.difficulty}
        {" · "}{item.points} pt
      </Text>
    </View>
    <View style={styles.addFromBankBtn}>
      <Ionicons name="add" size={18} color="#4F46E5" />
    </View>
  </TouchableOpacity>
));

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function CreateQuizScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
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

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const [catData, bankData, classData] = await Promise.all([
          getCategories(schoolId),
          getQuestions({ schoolId, limit: 200 }),
          getTeacherClasses(teacherId, schoolId),
        ]);
        setCategories(catData || []);

        // Deduplicate bank questions by id
        const seen       = new Set();
        const uniqueBank = (bankData || []).filter((q) => {
          if (seen.has(q.id)) return false;
          seen.add(q.id);
          return true;
        });
        setBankQuestions(uniqueBank);
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
        Alert.alert("Validation", "Quiz title is required");
        return;
      }
      if (!currentClassId) {
        Alert.alert("Validation", "Please select a class");
        return;
      }
      if (!currentSubjectId) {
        Alert.alert("Validation", "Please select a subject");
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
          "Saved",
          andPublish ? "Quiz published!" : "Quiz saved as draft",
          [{
            text: "OK",
            onPress: () => { if (andPublish) router.back(); },
          }]
        );
      } catch (err) {
        console.warn("Save quiz error:", err.message);
        Alert.alert("Error", err.message || "Could not save quiz. Please try again.");
      } finally {
        setSaving(false);
      }
    },
    [quizForm, quizId, schoolId, teacherId, router]
  );

  // ── Save question ─────────────────────────────────────────
  const handleSaveQuestion = useCallback(
    async (form) => {
      if (savingQuestion) return;

      setSavingQuestion(true);
      try {
        const payload = {
          ...form,
          schoolId,
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
        Alert.alert("Error", err.message || "Could not save question. Please try again.");
      } finally {
        setSavingQuestion(false);
      }
    },
    [editingQuestion, quizId, schoolId, teacherId, savingQuestion]
  );

  // ── Add from bank ─────────────────────────────────────────
  const handleAddFromBank = useCallback(
    async (question) => {
      if (!quizId) {
        Alert.alert(
          "Save Quiz First",
          "Please save the quiz details before adding questions."
        );
        return;
      }

      if (quizQuestions.some((q) => q.id === question.id)) {
        Alert.alert("Already Added", "This question is already in the quiz.");
        return;
      }

      try {
        await addQuestionToQuiz(quizId, question.id);
        setQuizQuestions((prev) => {
          if (prev.some((q) => q.id === question.id)) return prev;
          return [...prev, question];
        });
      } catch {
        Alert.alert("Error", "Could not add question.");
      }
    },
    [quizId, quizQuestions]
  );

  const handleRemoveFromQuiz = useCallback(
    async (question) => {
      if (!quizId) return;
      Alert.alert(
        "Remove Question",
        "Remove this question from the quiz?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text:  "Remove",
            style: "destructive",
            onPress: async () => {
              try {
                await removeQuestionFromQuiz(quizId, question.id);
                setQuizQuestions((prev) =>
                  prev.filter((q) => q.id !== question.id)
                );
              } catch {
                Alert.alert("Error", "Could not remove question.");
              }
            },
          },
        ]
      );
    },
    [quizId]
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
      <SectionHeader title="Basic Information" />

      {/* CLASS PICKER */}
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>
          Class <Text style={{ color: "#DC2626" }}>*</Text>
        </Text>
        {__DEV__ && quizForm.class_id && (
          <Text style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 4 }}>
            class_id: {quizForm.class_id}
          </Text>
        )}
        {classes.length === 0 ? (
          <Text style={styles.pickerEmpty}>No classes assigned to you</Text>
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
                ]}
                onPress={() => handleSelectClass(cls.id)}
              >
                <Text
                  style={[
                    styles.pickerChipText,
                    quizForm.class_id === cls.id && styles.pickerChipTextActive,
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
            Subject <Text style={{ color: "#DC2626" }}>*</Text>
          </Text>
          {__DEV__ && quizForm.subject_id && (
            <Text style={{ fontSize: 10, color: "#9CA3AF", marginBottom: 4 }}>
              subject_id: {quizForm.subject_id}
            </Text>
          )}
          {subjects.length === 0 ? (
            <Text style={styles.pickerEmpty}>
              No subjects assigned to you for this class
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
                  ]}
                  onPress={() => handleSelectSubject(subj.id)}
                >
                  <Text
                    style={[
                      styles.pickerChipText,
                      quizForm.subject_id === subj.id && styles.pickerChipTextActive,
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
        label="Quiz Title"
        value={quizForm.title}
        onChange={(v) => setQuizField("title", v)}
        placeholder="e.g. Chapter 5 Review"
        required
      />

      <Field
        label="Description"
        value={quizForm.description}
        onChange={(v) => setQuizField("description", v)}
        placeholder="Brief description of the quiz..."
        multiline
      />

      <Field
        label="Instructions"
        value={quizForm.instructions}
        onChange={(v) => setQuizField("instructions", v)}
        placeholder="Instructions shown to students before starting..."
        multiline
      />

      <SectionHeader title="Timing" />

      <Field
        label="Time Limit (minutes)"
        value={quizForm.time_limit_minutes}
        onChange={(v) => setQuizField("time_limit_minutes", v)}
        placeholder="Leave blank for no limit"
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
            <Text style={styles.primaryBtnText}>Save Draft</Text>
          </>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.primaryBtn,
          { backgroundColor: "#059669" },
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
            <Text style={styles.primaryBtnText}>Save & Publish</Text>
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
              {editingQuestion ? "Edit Question" : "New Question"}
            </Text>
            {editingQuestion && (
              <View style={styles.editingBadge}>
                <Ionicons name="create-outline" size={12} color="#4F46E5" />
                <Text style={styles.editingBadgeText}>Editing</Text>
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

      return (
        // ✅ Use flex:1 column layout so header stays fixed
        <View style={styles.questionTabContainer}>
          <View style={styles.bankPickerHeader}>
            <Text style={styles.bankPickerTitle}>
              Question Bank ({notAdded.length})
            </Text>
            <TouchableOpacity onPress={() => setShowBankPicker(false)}>
              <Text style={styles.bankPickerClose}>Done</Text>
            </TouchableOpacity>
          </View>

          {notAdded.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="list-outline" size={40} color="#D1D5DB" />
              <Text style={styles.emptyTitle}>No more questions</Text>
              <Text style={styles.emptySubtitle}>
                All bank questions are already added
              </Text>
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
            <Ionicons name="add-circle-outline" size={18} color="#4F46E5" />
            <Text style={styles.questionTabBtnText}>New Question</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.questionTabBtn,
              { backgroundColor: "#F0FDF4", borderColor: "#059669" },
            ]}
            onPress={() => setShowBankPicker(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="library-outline" size={18} color="#059669" />
            <Text style={[styles.questionTabBtnText, { color: "#059669" }]}>
              From Bank
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Fixed: question count ── */}
        <View style={styles.questionCountRow}>
          <Text style={styles.questionCount}>
            {quizQuestions.length} question
            {quizQuestions.length !== 1 ? "s" : ""} in this quiz
          </Text>
          {!quizId && (
            <Text style={styles.questionCountHint}>
              Save quiz details first to attach questions
            </Text>
          )}
        </View>

        {/* ── Scrollable: question list ── */}
        {quizQuestions.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="help-circle-outline" size={48} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>No questions yet</Text>
            <Text style={styles.emptySubtitle}>
              Create a new question or pick from your question bank
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
  const renderSettingsTab = () => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.tabContent}
    >
      <SectionHeader title="Attempt Settings" />

      <Field
        label="Max Attempts"
        value={quizForm.max_attempts}
        onChange={(v) => setQuizField("max_attempts", v)}
        placeholder="1"
        keyboardType="number-pad"
      />

      <Field
        label="Passing Score (%)"
        value={quizForm.passing_score}
        onChange={(v) => setQuizField("passing_score", v)}
        placeholder="70"
        keyboardType="decimal-pad"
      />

      <SectionHeader title="Delivery" />

      <ToggleRow
        label="Shuffle Questions"
        subtitle="Randomize question order for each student"
        value={quizForm.shuffle_questions}
        onChange={(v) => setQuizField("shuffle_questions", v)}
      />

      <ToggleRow
        label="Shuffle Answer Options"
        subtitle="Randomize option order for each student"
        value={quizForm.shuffle_options}
        onChange={(v) => setQuizField("shuffle_options", v)}
      />

      <ToggleRow
        label="Allow Back Navigation"
        subtitle="Students can go back to previous questions"
        value={quizForm.allow_backtrack}
        onChange={(v) => setQuizField("allow_backtrack", v)}
      />

      <SectionHeader title="Feedback" />

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
          <Text style={styles.radioLabel}>Show answers {opt.label}</Text>
        </TouchableOpacity>
      ))}

      <ToggleRow
        label="Show Score"
        subtitle="Show the student their final score"
        value={quizForm.show_score}
        onChange={(v) => setQuizField("show_score", v)}
      />

      <ToggleRow
        label="Show Explanations"
        subtitle="Show explanations alongside answers"
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
            <Text style={styles.primaryBtnText}>Save Settings</Text>
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
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (showQuestionForm)  { closeQuestionForm();       return; }
            if (showBankPicker)    { setShowBankPicker(false);  return; }
            router.back();
          }}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>
          {showQuestionForm
            ? editingQuestion ? "Edit Question" : "New Question"
            : isEditing       ? "Edit Quiz"     : "Create Quiz"}
        </Text>

        {quizId && !showQuestionForm && !showBankPicker && (
          <TouchableOpacity
            style={styles.publishBtn}
            onPress={() => handleSaveQuiz(true)}
            disabled={saving}
            activeOpacity={0.8}
          >
            <Ionicons name="globe-outline" size={16} color="#FFF" />
            <Text style={styles.publishBtnText}>Publish</Text>
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
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  centered:  {
    flex: 1, justifyContent: "center",
    alignItems: "center", backgroundColor: "#F3F4F6",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backButton: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: "700", color: "#111827" },
  publishBtn: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#059669", borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, gap: 4,
  },
  publishBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

  tabBar: {
    flexDirection: "row", backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  tab: {
    flex: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", paddingVertical: 12, gap: 5,
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  tabActive:      { borderBottomColor: "#4F46E5" },
  tabLabel:       { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },
  tabLabelActive: { color: "#4F46E5", fontWeight: "700" },

  // ✅ Wrapper that gives all tab content the remaining flex space
  tabContentWrapper: { flex: 1 },

  tabContent: { padding: 16 },

  // ✅ Questions tab outer container — column flex so fixed headers
  //    stay pinned and list scrolls in remaining space
  questionTabContainer: {
    flex:           1,
    flexDirection:  "column",
    backgroundColor: "#F3F4F6",
  },

  // ✅ FlatList padding — replaces ScrollView contentContainerStyle
  flatListContent: {
    padding:       16,
    paddingBottom: 32,
  },

  field:      { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },
  fieldHint:  { fontSize: 11, color: "#9CA3AF", fontWeight: "400" },
  fieldInput: {
    backgroundColor: "#FFF", borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 12,
    fontSize: 14, color: "#111827",
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  fieldInputMulti:    { height: 80, textAlignVertical: "top" },
  fieldInputDisabled: { backgroundColor: "#F9FAFB", color: "#9CA3AF" },

  sectionHeader: {
    fontSize: 13, fontWeight: "700", color: "#9CA3AF",
    textTransform: "uppercase", letterSpacing: 0.5,
    marginTop: 8, marginBottom: 12,
  },

  pickerRow:            { gap: 8, paddingBottom: 4 },
  pickerChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "transparent",
  },
  pickerChipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  pickerChipText:       { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  pickerChipTextActive: { color: "#4F46E5", fontWeight: "700" },
  pickerEmpty:          { fontSize: 13, color: "#9CA3AF", fontStyle: "italic", marginTop: 4 },

  toggleRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12,
    padding: 14, marginBottom: 8,
  },
  toggleLabel:    { fontSize: 14, fontWeight: "600", color: "#111827" },
  toggleSubtitle: { fontSize: 12, color: "#9CA3AF", marginTop: 1 },

  radioRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 10,
    padding: 12, marginBottom: 6, gap: 10,
  },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: "#D1D5DB",
    alignItems: "center", justifyContent: "center",
  },
  radioOuterActive: { borderColor: "#4F46E5" },
  radioInner: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: "#4F46E5",
  },
  radioLabel: { fontSize: 14, color: "#374151" },

  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 14, marginTop: 8, gap: 8,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText:     { color: "#FFF", fontWeight: "700", fontSize: 15 },

  questionForm: {},

  formHeaderRow:   { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 10 },
  formHeaderTitle: { fontSize: 18, fontWeight: "700", color: "#111827", flex: 1 },
  editingBadge: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", borderRadius: 20,
    paddingHorizontal: 10, paddingVertical: 4, gap: 4,
  },
  editingBadgeText: { fontSize: 11, fontWeight: "700", color: "#4F46E5" },

  typeRow: { gap: 8, paddingBottom: 10 },
  typeChip: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "transparent", gap: 5,
  },
  typeChipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  typeChipText:       { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  typeChipTextActive: { color: "#4F46E5", fontWeight: "700" },

  optionsSection: { marginBottom: 14 },
  optionRow:      { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  optionCorrectToggle: {
    width: 32, height: 32,
    alignItems: "center", justifyContent: "center",
  },
  optionCorrectToggleOn: {},
  optionInput: {
    flex: 1, backgroundColor: "#FFF", borderRadius: 10,
    paddingVertical: 9, paddingHorizontal: 12,
    fontSize: 14, color: "#111827",
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  optionInputCorrect: { borderColor: "#059669", backgroundColor: "#F0FDF4" },
  optionRemove:       { padding: 4 },
  addOptionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  addOptionText: { fontSize: 13, color: "#4F46E5", fontWeight: "600" },

  metaRow: { flexDirection: "row", gap: 12 },

  diffRow: { flexDirection: "row", gap: 6 },
  diffChip: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "transparent",
  },
  diffChipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  diffChipText:       { fontSize: 12, color: "#6B7280" },
  diffChipTextActive: { color: "#4F46E5", fontWeight: "700" },

  formActions:    { flexDirection: "row", gap: 10, marginTop: 16 },
  cancelBtn: {
    flex: 1, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, borderColor: "#E5E7EB", alignItems: "center",
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600", color: "#6B7280" },
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
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    // No flex here — intrinsic height only
  },
  questionTabBtn: {
    flex: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", paddingVertical: 10,
    borderRadius: 10, backgroundColor: "#EEF2FF",
    borderWidth: 1, borderColor: "#4F46E5", gap: 6,
  },
  questionTabBtnText: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },

  // ✅ Fixed count row — never shrinks
  questionCountRow: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: "#F3F4F6",
    // No flex here — intrinsic height only
  },
  questionCount:     { fontSize: 13, fontWeight: "600", color: "#374151" },
  questionCountHint: { fontSize: 11, color: "#DC2626", marginTop: 2 },

  quizQuestionCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12,
    padding: 12, marginBottom: 8, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  quizQuestionNum: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
  },
  quizQuestionNumText: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },
  quizQuestionText:    { fontSize: 14, fontWeight: "600", color: "#111827", lineHeight: 20 },
  quizQuestionMeta:    { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  quizQuestionMetaText:{ fontSize: 11, color: "#9CA3AF" },
  quizQuestionMetaDot: { fontSize: 11, color: "#D1D5DB" },
  quizQuestionBtns:    { flexDirection: "row", gap: 4 },
  quizQuestionIconBtn: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },

  bankPickerHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    // No flex — intrinsic height only
  },
  bankPickerTitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  bankPickerClose: { fontSize: 14, fontWeight: "700", color: "#4F46E5" },
  bankQuestionCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12,
    padding: 12, marginBottom: 8, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  bankQuestionText: { fontSize: 14, fontWeight: "600", color: "#111827", lineHeight: 20 },
  bankQuestionMeta: { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  addFromBankBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
  },

  emptyState: {
    flex: 1,
    alignItems: "center", justifyContent: "center",
    paddingVertical: 48, paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});