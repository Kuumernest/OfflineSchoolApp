// app/admin/exams/create.js
"use strict";

import React, {
  useState, useCallback, useMemo, useEffect,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, StatusBar,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { ExamService }  from "../../../src/services/exam.service";
import api              from "../../../src/services/api";
import DateField        from "../../../src/components/DateField";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const EXAM_TYPES = [
  { value: "first_test",            label: "First Test"            },
  { value: "second_test",           label: "Second Test"           },
  { value: "mid_term",              label: "Mid-Term Exam"         },
  { value: "practical",             label: "Practical Exam"        },
  { value: "final_exam",            label: "Final Exam"            },
  { value: "mock_exam",             label: "Mock Exam"             },
  { value: "promotion_exam",        label: "Promotion Exam"        },
  { value: "continuous_assessment", label: "Continuous Assessment" },
];

const TERMS = [
  "Term 1", "Term 2", "Term 3",
  "Semester 1", "Semester 2",
  "First Half", "Second Half",
];

const STATUSES = [
  { value: "draft",     label: "Draft"     },
  { value: "scheduled", label: "Scheduled" },
];

const currentYear    = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${currentYear - 1}/${currentYear}`,
  `${currentYear}/${currentYear + 1}`,
  `${currentYear + 1}/${currentYear + 2}`,
];

const STEPS = [
  { key: "details",  label: "Details",  icon: "document-text-outline"    },
  { key: "subjects", label: "Subjects", icon: "book-outline"             },
  { key: "review",   label: "Review",   icon: "checkmark-circle-outline" },
];

// ─────────────────────────────────────────────────────────
// DATE HELPER
// ─────────────────────────────────────────────────────────

function isValidDate(str) {
  if (!str) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  return !isNaN(new Date(str).getTime());
}

// ─────────────────────────────────────────────────────────
// REUSABLE FIELD COMPONENTS
// ─────────────────────────────────────────────────────────

const FieldLabel = ({ label, required }) => (
  <Text style={fs.label}>
    {label}
    {required && <Text style={{ color: "#DC2626" }}> *</Text>}
  </Text>
);

const FieldInput = ({ label, required, error, ...props }) => (
  <View style={fs.field}>
    {label && <FieldLabel label={label} required={required} />}
    <TextInput
      style={[
        fs.input,
        props.multiline && fs.inputMulti,
        error && { borderColor: "#DC2626", borderWidth: 1.5 },
      ]}
      placeholderTextColor="#9CA3AF"
      {...props}
    />
    {error && <Text style={fs.errorText}>{error}</Text>}
  </View>
);

const DateInput = DateField; // shared native calendar picker (YYYY-MM-DD in/out)

const PickerRow = ({ label, required, options, value, onChange }) => (
  <View style={fs.field}>
    {label && <FieldLabel label={label} required={required} />}
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={fs.pickerRow}
    >
      {options.map((opt) => {
        const v        = typeof opt === "string" ? opt : opt.value;
        const l        = typeof opt === "string" ? opt : opt.label;
        const isActive = value === v;
        return (
          <TouchableOpacity
            key={v}
            style={[fs.chip, isActive && fs.chipActive]}
            onPress={() => onChange(v)}
            activeOpacity={0.7}
          >
            <Text style={[fs.chipText, isActive && fs.chipTextActive]}>
              {l}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  </View>
);

const fs = StyleSheet.create({
  field:      { marginBottom: 20 },
  label:      { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 8 },
  errorText:  { fontSize: 11, color: "#DC2626", marginTop: 4 },
  input: {
    backgroundColor:   "#F9FAFB",
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          14,
    color:             "#111827",
  },
  inputMulti: { height: 90, textAlignVertical: "top" },
  pickerRow:  { gap: 8, paddingBottom: 4 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderRadius:      20,
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  chipActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  chipText:       { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  chipTextActive: { color: "#FFF" },
});

// ─────────────────────────────────────────────────────────
// STEP INDICATOR
// ─────────────────────────────────────────────────────────

const StepIndicator = ({ steps, currentStep }) => {
  const stepIndex = steps.findIndex((s) => s.key === currentStep);
  return (
    <View style={si.wrapper}>
      {steps.map((step, index) => {
        const isActive   = step.key === currentStep;
        const isComplete = index < stepIndex;
        return (
          <React.Fragment key={step.key}>
            <View style={si.stepCol}>
              <View style={[
                si.circle,
                isActive   && si.circleActive,
                isComplete && si.circleComplete,
              ]}>
                {isComplete
                  ? <Ionicons name="checkmark" size={14} color="#FFF" />
                  : <Text style={[
                      si.circleText,
                      (isActive || isComplete) && { color: "#FFF" },
                    ]}>
                      {index + 1}
                    </Text>
                }
              </View>
              <Text style={[
                si.stepLabel,
                isActive   && si.stepLabelActive,
                isComplete && si.stepLabelComplete,
              ]}>
                {step.label}
              </Text>
            </View>
            {index < steps.length - 1 && (
              <View style={[si.line, isComplete && si.lineComplete]} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
};

const si = StyleSheet.create({
  wrapper: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 24,
    paddingVertical:   16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  stepCol:           { alignItems: "center", gap: 4 },
  circle: {
    width:           28,
    height:          28,
    borderRadius:    14,
    backgroundColor: "#F3F4F6",
    borderWidth:     2,
    borderColor:     "#E5E7EB",
    alignItems:      "center",
    justifyContent:  "center",
  },
  circleActive:      { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  circleComplete:    { backgroundColor: "#059669", borderColor: "#059669" },
  circleText:        { fontSize: 12, fontWeight: "700", color: "#9CA3AF" },
  stepLabel:         { fontSize: 10, color: "#9CA3AF", fontWeight: "600" },
  stepLabelActive:   { color: "#4F46E5" },
  stepLabelComplete: { color: "#059669" },
  line: {
    flex:             1,
    height:           2,
    backgroundColor:  "#E5E7EB",
    marginBottom:     16,
    marginHorizontal: 4,
  },
  lineComplete: { backgroundColor: "#059669" },
});

// ─────────────────────────────────────────────────────────
// STEP 1 — EXAM DETAILS
// ─────────────────────────────────────────────────────────

const StepDetails = ({ form, onChange, errors }) => (
  <ScrollView
    showsVerticalScrollIndicator={false}
    contentContainerStyle={styles.scroll}
    keyboardShouldPersistTabs="handled"
  >
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Basic Information</Text>

      <FieldInput
        label="Exam Name"
        required
        placeholder="e.g. First Term Examination 2026"
        value={form.name}
        onChangeText={(v) => onChange("name", v)}
        error={errors.name}
      />

      <PickerRow
        label="Exam Type"
        required
        options={EXAM_TYPES}
        value={form.type}
        onChange={(v) => onChange("type", v)}
      />

      <PickerRow
        label="Academic Year"
        required
        options={ACADEMIC_YEARS}
        value={form.academicYear}
        onChange={(v) => onChange("academicYear", v)}
      />

      <PickerRow
        label="Term / Semester"
        required
        options={TERMS}
        value={form.term}
        onChange={(v) => onChange("term", v)}
      />
    </View>

    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Schedule</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <DateInput
            label="Start Date"
            value={form.startDate}
            onChange={(v) => onChange("startDate", v)}
          />
        </View>
        <View style={{ width: 12 }} />
        <View style={{ flex: 1 }}>
          <DateInput
            label="End Date"
            value={form.endDate}
            onChange={(v) => onChange("endDate", v)}
          />
        </View>
      </View>
    </View>

    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Scoring</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <FieldInput
            label="Total Marks"
            required
            placeholder="100"
            value={form.totalMarks}
            onChangeText={(v) => onChange("totalMarks", v)}
            keyboardType="numeric"
            error={errors.totalMarks}
          />
        </View>
        <View style={{ width: 12 }} />
        <View style={{ flex: 1 }}>
          <FieldInput
            label="Pass Mark"
            required
            placeholder="50"
            value={form.passMark}
            onChangeText={(v) => onChange("passMark", v)}
            keyboardType="numeric"
            error={errors.passMark}
          />
        </View>
      </View>

      {Number(form.totalMarks) > 0 && (
        <View style={styles.passPreview}>
          <Ionicons name="information-circle-outline" size={14} color="#4F46E5" />
          <Text style={styles.passPreviewText}>
            Pass rate:{" "}
            {((Number(form.passMark) / Number(form.totalMarks)) * 100).toFixed(1)}%
          </Text>
        </View>
      )}
    </View>

    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Initial Status</Text>
      <PickerRow
        options={STATUSES}
        value={form.status}
        onChange={(v) => onChange("status", v)}
      />
    </View>

    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Additional Details</Text>
      <FieldInput
        label="Description"
        placeholder="Brief description of the exam (optional)"
        value={form.description}
        onChangeText={(v) => onChange("description", v)}
        multiline
      />
      <FieldInput
        label="Instructions"
        placeholder="Instructions for students (optional)"
        value={form.instructions}
        onChangeText={(v) => onChange("instructions", v)}
        multiline
      />
    </View>

    <View style={{ height: 40 }} />
  </ScrollView>
);

// ─────────────────────────────────────────────────────────
// STEP 2 — ASSIGN SUBJECTS + CLASSES
// ─────────────────────────────────────────────────────────

const StepSubjects = ({ schoolId, form, assignments, setAssignments }) => {
  const [classes,          setClasses]          = useState([]);
  const [filteredSubjects, setFilteredSubjects] = useState([]);
  const [teachers,         setTeachers]         = useState([]);
  const [loading,          setLoading]          = useState(true);
  const [subjectsLoading,  setSubjectsLoading]  = useState(false);
  const [selectedClass,    setSelectedClass]    = useState(null);
  const [search,           setSearch]           = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [clsRes, tchRes] = await Promise.all([
          api.get("/admin/classes",  { params: { schoolId } }),
          api.get("/admin/teachers", { params: { schoolId } }),
        ]);
        setClasses(
          clsRes.data?.classes ||
          (Array.isArray(clsRes.data) ? clsRes.data : [])
        );
        setTeachers(
          Array.isArray(tchRes.data)
            ? tchRes.data
            : tchRes.data?.teachers || tchRes.data?.data || []
        );
      } catch (err) {
        console.error("StepSubjects load error:", err.message);
        Alert.alert("Error", "Failed to load school data.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [schoolId]);

  useEffect(() => {
    if (!selectedClass) { setFilteredSubjects([]); return; }
    const loadSubjects = async () => {
      try {
        setSubjectsLoading(true);
        const res = await api.get("/admin/subjects", {
          params: { schoolId, classId: selectedClass.id },
        });
        let subs =
          res.data?.subjects ||
          (Array.isArray(res.data) ? res.data : []);
        if (subs.length > 0 && selectedClass.id) {
          const classFiltered = subs.filter(
            (s) =>
              String(s.class_id || s.classId || s.class || "") === selectedClass.id
          );
          if (classFiltered.length > 0) subs = classFiltered;
        }
        setFilteredSubjects(subs);
      } catch (err) {
        console.warn("loadSubjects error:", err.message);
        setFilteredSubjects([]);
      } finally {
        setSubjectsLoading(false);
      }
    };
    loadSubjects();
  }, [selectedClass, schoolId]);

  const displaySubjects = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return filteredSubjects;
    return filteredSubjects.filter((s) =>
      (s.name || s.subjectName || "").toLowerCase().includes(q)
    );
  }, [filteredSubjects, search]);

  const handleSelectClass = useCallback((cls) => {
    const classId   = String(cls._id || cls.id);
    const className = cls.name || cls.className || "Class";
    setSelectedClass({ id: classId, name: className });
    setSearch("");
  }, []);

  const toggleSubjectForClass = useCallback((subject) => {
    if (!selectedClass) return;
    const classId   = selectedClass.id;
    const className = selectedClass.name;
    const subjectId = String(subject._id || subject.id);
    const subName   = subject.name || subject.subjectName || "Subject";

    setAssignments((prev) => {
      const clsEntry = prev[classId] || { className, subjects: {} };
      if (clsEntry.subjects[subjectId]) {
        const { [subjectId]: _removed, ...restSubjects } = clsEntry.subjects;
        if (Object.keys(restSubjects).length === 0) {
          const { [classId]: _removedCls, ...restCls } = prev;
          return restCls;
        }
        return { ...prev, [classId]: { ...clsEntry, subjects: restSubjects } };
      }
      return {
        ...prev,
        [classId]: {
          ...clsEntry,
          className,
          subjects: {
            ...clsEntry.subjects,
            [subjectId]: {
              subjectName: subName,
              teacherId:   null,
              maxScore:    String(form.totalMarks || "100"),
              passMark:    String(form.passMark   || "50"),
            },
          },
        },
      };
    });
  }, [selectedClass, form.totalMarks, form.passMark, setAssignments]);

  const updateSubjectField = useCallback((classId, subjectId, field, value) => {
    setAssignments((prev) => ({
      ...prev,
      [classId]: {
        ...prev[classId],
        subjects: {
          ...prev[classId]?.subjects,
          [subjectId]: {
            ...prev[classId]?.subjects?.[subjectId],
            [field]: value,
          },
        },
      },
    }));
  }, [setAssignments]);

  const isSubjectAssigned = useCallback((subjectId) => {
    if (!selectedClass) return false;
    return !!assignments[selectedClass.id]?.subjects?.[subjectId];
  }, [selectedClass, assignments]);

  const totalAssignments = useMemo(
    () => Object.values(assignments).reduce(
      (acc, cls) => acc + Object.keys(cls.subjects).length, 0
    ),
    [assignments]
  );

  if (loading) {
    return (
      <View style={st.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={st.loadingText}>Loading school data…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={st.summaryBar}>
        <View style={st.summaryItem}>
          <Text style={st.summaryNum}>{Object.keys(assignments).length}</Text>
          <Text style={st.summaryLabel}>Classes</Text>
        </View>
        <View style={st.summaryDivider} />
        <View style={st.summaryItem}>
          <Text style={st.summaryNum}>{totalAssignments}</Text>
          <Text style={st.summaryLabel}>Subjects</Text>
        </View>
        <View style={st.summaryDivider} />
        <Text style={st.summaryHint}>
          Pick a class → tick subjects → set teacher & scores
        </Text>
      </View>

      <View style={{ flex: 1, flexDirection: "row" }}>
        {/* Class list */}
        <View style={st.classList}>
          <Text style={st.sideTitle}>Classes</Text>
          {classes.length === 0 ? (
            <View style={st.emptySide}>
              <Ionicons name="school-outline" size={28} color="#D1D5DB" />
              <Text style={st.emptySmall}>No classes</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              {classes.map((cls) => {
                const classId      = String(cls._id || cls.id);
                const isSelected   = selectedClass?.id === classId;
                const subjectCount = Object.keys(
                  assignments[classId]?.subjects || {}
                ).length;
                return (
                  <TouchableOpacity
                    key={classId}
                    style={[st.classItem, isSelected && st.classItemActive]}
                    onPress={() => handleSelectClass(cls)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[st.classItemText, isSelected && st.classItemTextActive]}
                      numberOfLines={2}
                    >
                      {cls.name}
                    </Text>
                    {subjectCount > 0 && (
                      <View style={[st.badge, isSelected && { backgroundColor: "#FFF" }]}>
                        <Text style={[st.badgeText, isSelected && { color: "#4F46E5" }]}>
                          {subjectCount}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>

        {/* Subject list */}
        <View style={st.subjectPanel}>
          {!selectedClass ? (
            <View style={st.centered}>
              <Ionicons name="arrow-back" size={32} color="#D1D5DB" />
              <Text style={st.emptyText}>Select a class first</Text>
            </View>
          ) : (
            <>
              <Text style={st.sideTitle} numberOfLines={1}>
                {selectedClass.name} — Subjects
              </Text>
              <View style={st.searchBox}>
                <Ionicons name="search-outline" size={14} color="#9CA3AF" />
                <TextInput
                  style={st.searchInput}
                  placeholder="Search subject…"
                  placeholderTextColor="#9CA3AF"
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {!!search && (
                  <TouchableOpacity onPress={() => setSearch("")}>
                    <Ionicons name="close-circle" size={14} color="#9CA3AF" />
                  </TouchableOpacity>
                )}
              </View>

              {subjectsLoading ? (
                <View style={st.centered}>
                  <ActivityIndicator size="small" color="#4F46E5" />
                  <Text style={st.loadingText}>Loading subjects…</Text>
                </View>
              ) : displaySubjects.length === 0 ? (
                <View style={st.emptySide}>
                  <Ionicons name="book-outline" size={28} color="#D1D5DB" />
                  <Text style={st.emptySmall}>
                    {search ? "No subjects match" : "No subjects for this class"}
                  </Text>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {displaySubjects.map((subject) => {
                    const subjectId    = String(subject._id || subject.id);
                    const classId      = selectedClass.id;
                    const assigned     = isSubjectAssigned(subjectId);
                    const subjectEntry = assignments[classId]?.subjects?.[subjectId];

                    return (
                      <View key={subjectId} style={st.subjectCard}>
                        <TouchableOpacity
                          style={st.subjectHeader}
                          onPress={() => toggleSubjectForClass(subject)}
                          activeOpacity={0.7}
                        >
                          <View style={[st.checkbox, assigned && st.checkboxActive]}>
                            {assigned && <Ionicons name="checkmark" size={12} color="#FFF" />}
                          </View>
                          <Text style={[
                            st.subjectName,
                            assigned && { color: "#4F46E5", fontWeight: "700" },
                          ]}>
                            {subject.name || subject.subjectName}
                          </Text>
                        </TouchableOpacity>

                        {assigned && (
                          <View style={st.subjectConfig}>
                            <Text style={st.configLabel}>Teacher</Text>
                            {teachers.length === 0 ? (
                              <Text style={st.emptySmall}>No teachers found</Text>
                            ) : (
                              <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={{ gap: 6, paddingBottom: 4 }}
                              >
                                {teachers.map((t) => {
                                  const tid      = String(t._id || t.id);
                                  const isActive = subjectEntry?.teacherId === tid;
                                  return (
                                    <TouchableOpacity
                                      key={tid}
                                      style={[st.teacherChip, isActive && st.teacherChipActive]}
                                      onPress={() =>
                                        updateSubjectField(classId, subjectId, "teacherId", tid)
                                      }
                                      activeOpacity={0.7}
                                    >
                                      <Ionicons
                                        name="person-circle-outline"
                                        size={12}
                                        color={isActive ? "#FFF" : "#6B7280"}
                                      />
                                      <Text style={[
                                        st.teacherChipText,
                                        isActive && { color: "#FFF" },
                                      ]}>
                                        {t.name || t.email}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </ScrollView>
                            )}

                            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                              <View style={{ flex: 1 }}>
                                <Text style={st.configLabel}>Max Score</Text>
                                <TextInput
                                  style={st.configInput}
                                  value={subjectEntry?.maxScore}
                                  onChangeText={(v) =>
                                    updateSubjectField(classId, subjectId, "maxScore", v)
                                  }
                                  keyboardType="numeric"
                                  placeholder="100"
                                  placeholderTextColor="#9CA3AF"
                                />
                              </View>
                              <View style={{ flex: 1 }}>
                                <Text style={st.configLabel}>Pass Score</Text>
                                <TextInput
                                  style={st.configInput}
                                  value={subjectEntry?.passMark}
                                  onChangeText={(v) =>
                                    updateSubjectField(classId, subjectId, "passMark", v)
                                  }
                                  keyboardType="numeric"
                                  placeholder="50"
                                  placeholderTextColor="#9CA3AF"
                                />
                              </View>
                            </View>
                          </View>
                        )}
                      </View>
                    );
                  })}
                  <View style={{ height: 40 }} />
                </ScrollView>
              )}
            </>
          )}
        </View>
      </View>
    </View>
  );
};

const st = StyleSheet.create({
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  emptyText:   { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
  emptySide:   { alignItems: "center", paddingVertical: 24, gap: 8 },
  emptySmall:  { fontSize: 12, color: "#D1D5DB", textAlign: "center" },
  summaryBar: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#EEF2FF",
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               12,
  },
  summaryItem:    { alignItems: "center" },
  summaryNum:     { fontSize: 18, fontWeight: "800", color: "#4F46E5" },
  summaryLabel:   { fontSize: 10, color: "#6B7280", fontWeight: "600" },
  summaryDivider: { width: 1, height: 28, backgroundColor: "#C7D2FE" },
  summaryHint:    { flex: 1, fontSize: 11, color: "#6B7280", lineHeight: 16 },
  classList: {
    width:            110,
    borderRightWidth: 1,
    borderRightColor: "#F3F4F6",
    backgroundColor:  "#FAFAFA",
    paddingTop:       8,
  },
  sideTitle: {
    fontSize:          11,
    fontWeight:        "700",
    color:             "#9CA3AF",
    textTransform:     "uppercase",
    letterSpacing:     0.5,
    paddingHorizontal: 10,
    marginBottom:      6,
  },
  classItem: {
    paddingHorizontal: 10,
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    gap:               4,
  },
  classItemActive:     { backgroundColor: "#4F46E5" },
  classItemText:       { fontSize: 12, fontWeight: "600", color: "#374151", flex: 1 },
  classItemTextActive: { color: "#FFF" },
  badge: {
    backgroundColor:   "#EEF2FF",
    borderRadius:      8,
    paddingHorizontal: 5,
    paddingVertical:   2,
  },
  badgeText:    { fontSize: 10, fontWeight: "700", color: "#4F46E5" },
  subjectPanel: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
  searchBox: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F3F4F6",
    borderRadius:      8,
    paddingHorizontal: 8,
    height:            32,
    gap:               6,
    marginBottom:      8,
  },
  searchInput:  { flex: 1, fontSize: 13, color: "#111827" },
  subjectCard: {
    backgroundColor: "#FFF",
    borderRadius:    10,
    marginBottom:    6,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    overflow:        "hidden",
  },
  subjectHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               10,
    paddingHorizontal: 12,
    paddingVertical:   10,
  },
  checkbox: {
    width:           20,
    height:          20,
    borderRadius:    5,
    borderWidth:     2,
    borderColor:     "#E5E7EB",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#F9FAFB",
  },
  checkboxActive: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  subjectName:    { fontSize: 13, fontWeight: "600", color: "#374151", flex: 1 },
  subjectConfig: {
    backgroundColor:   "#F9FAFB",
    borderTopWidth:    1,
    borderTopColor:    "#EEF2FF",
    paddingHorizontal: 12,
    paddingBottom:     12,
    paddingTop:        8,
  },
  configLabel: {
    fontSize:     11,
    fontWeight:   "600",
    color:        "#6B7280",
    marginBottom: 6,
  },
  configInput: {
    backgroundColor:   "#FFF",
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    paddingHorizontal: 10,
    paddingVertical:   6,
    fontSize:          13,
    color:             "#111827",
  },
  teacherChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   5,
    borderRadius:      16,
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  teacherChipActive: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  teacherChipText:   { fontSize: 11, fontWeight: "600", color: "#6B7280" },
});

// ─────────────────────────────────────────────────────────
// STEP 3 — REVIEW
// ─────────────────────────────────────────────────────────

const StepReview = ({ form, assignments }) => {
  const totalSubjects = useMemo(
    () => Object.values(assignments).reduce(
      (acc, cls) => acc + Object.keys(cls.subjects).length, 0
    ),
    [assignments]
  );

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.scroll}
    >
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Exam Details</Text>
        {[
          { label: "Name",          value: form.name },
          { label: "Type",          value: EXAM_TYPES.find((t) => t.value === form.type)?.label || form.type },
          { label: "Academic Year", value: form.academicYear },
          { label: "Term",          value: form.term },
          { label: "Status",        value: form.status },
          { label: "Start Date",    value: form.startDate || "—" },
          { label: "End Date",      value: form.endDate   || "—" },
          { label: "Total Marks",   value: form.totalMarks },
          { label: "Pass Mark",     value: form.passMark  },
        ].map(({ label, value }) => (
          <View key={label} style={rv.row}>
            <Text style={rv.rowLabel}>{label}</Text>
            <Text style={rv.rowValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <View style={rv.sectionHeader}>
          <Text style={styles.sectionTitle}>Subject Assignments</Text>
          <View style={rv.badge}>
            <Text style={rv.badgeText}>
              {Object.keys(assignments).length} class
              {Object.keys(assignments).length !== 1 ? "es" : ""},{" "}
              {totalSubjects} subject{totalSubjects !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {Object.keys(assignments).length === 0 ? (
          <View style={rv.emptyAssign}>
            <Ionicons name="alert-circle-outline" size={32} color="#F59E0B" />
            <Text style={rv.emptyAssignText}>
              No subjects assigned yet.{"\n"}
              You can add them later from the exam detail screen.
            </Text>
          </View>
        ) : (
          Object.entries(assignments).map(([classId, clsData]) => (
            <View key={classId} style={rv.classBlock}>
              <View style={rv.classBlockHeader}>
                <Ionicons name="school-outline" size={14} color="#4F46E5" />
                <Text style={rv.classBlockTitle}>{clsData.className}</Text>
                <Text style={rv.classBlockCount}>
                  {Object.keys(clsData.subjects).length} subject(s)
                </Text>
              </View>
              {Object.entries(clsData.subjects).map(([subjectId, sub]) => (
                <View key={subjectId} style={rv.subjectRow}>
                  <Ionicons name="book-outline" size={12} color="#6B7280" />
                  <Text style={rv.subjectRowName}>{sub.subjectName}</Text>
                  <Text style={rv.subjectRowMeta}>
                    Max {sub.maxScore} · Pass {sub.passMark}
                  </Text>
                  {sub.teacherId ? (
                    <View style={rv.teacherTag}>
                      <Ionicons name="person-outline" size={10} color="#059669" />
                    </View>
                  ) : (
                    <View style={rv.teacherTagWarn}>
                      <Text style={rv.teacherTagWarnText}>No teacher</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          ))
        )}
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
};

const rv = StyleSheet.create({
  row: {
    flexDirection:     "row",
    justifyContent:    "space-between",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  rowLabel: { fontSize: 13, color: "#6B7280", fontWeight: "600" },
  rowValue: {
    fontSize:   13,
    color:      "#111827",
    fontWeight: "700",
    textAlign:  "right",
    flex:       1,
    marginLeft: 8,
  },
  sectionHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   12,
  },
  badge: {
    backgroundColor:   "#EEF2FF",
    borderRadius:      12,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  badgeText:     { fontSize: 11, fontWeight: "700", color: "#4F46E5" },
  emptyAssign:   { alignItems: "center", paddingVertical: 24, gap: 8 },
  emptyAssignText: {
    fontSize:   13,
    color:      "#F59E0B",
    textAlign:  "center",
    fontWeight: "600",
    lineHeight: 20,
  },
  classBlock: {
    borderWidth:  1,
    borderColor:  "#EEF2FF",
    borderRadius: 10,
    marginBottom: 10,
    overflow:     "hidden",
  },
  classBlockHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#EEF2FF",
    paddingHorizontal: 12,
    paddingVertical:   8,
  },
  classBlockTitle: { fontSize: 13, fontWeight: "700", color: "#4F46E5", flex: 1 },
  classBlockCount: { fontSize: 11, color: "#6B7280" },
  subjectRow: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderTopWidth:    1,
    borderTopColor:    "#F3F4F6",
  },
  subjectRowName: { fontSize: 12, fontWeight: "600", color: "#374151", flex: 1 },
  subjectRowMeta: { fontSize: 11, color: "#9CA3AF" },
  teacherTag: { backgroundColor: "#ECFDF5", borderRadius: 10, padding: 4 },
  teacherTagWarn: {
    backgroundColor:   "#FEF3C7",
    borderRadius:      8,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  teacherTagWarnText: { fontSize: 10, color: "#D97706", fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function CreateExamScreen() {
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [currentStep, setCurrentStep] = useState("details");
  const [saving,      setSaving]      = useState(false);

  const [form, setForm] = useState({
    name:         "",
    type:         "first_test",
    academicYear: ACADEMIC_YEARS[1],
    term:         "Term 1",
    status:       "draft",
    startDate:    "",
    endDate:      "",
    description:  "",
    instructions: "",
    totalMarks:   "100",
    passMark:     "50",
  });

  const onChange = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const [assignments, setAssignments] = useState({});

  const detailErrors = useMemo(() => {
    const e  = {};
    const tm = Number(form.totalMarks);
    const pm = Number(form.passMark);
    if (!form.name.trim())          e.name       = "Exam name is required";
    if (isNaN(tm) || tm <= 0)       e.totalMarks = "Must be a positive number";
    if (isNaN(pm) || pm < 0 || pm > tm)
      e.passMark = `Must be between 0 and ${tm}`;
    if (form.startDate && !isValidDate(form.startDate))
      e.startDate = "Invalid start date";
    if (form.endDate && !isValidDate(form.endDate))
      e.endDate = "Invalid end date";
    if (
      form.startDate && form.endDate &&
      isValidDate(form.startDate) && isValidDate(form.endDate) &&
      new Date(form.startDate) > new Date(form.endDate)
    )
      e.endDate = "End date must be after start date";
    return e;
  }, [form]);

  const detailsValid = Object.keys(detailErrors).length === 0;

  const goNext = useCallback(() => {
    if (currentStep === "details") {
      if (!detailsValid) {
        Alert.alert("Fix Errors", Object.values(detailErrors)[0]);
        return;
      }
      setCurrentStep("subjects");
    } else if (currentStep === "subjects") {
      setCurrentStep("review");
    }
  }, [currentStep, detailsValid, detailErrors]);

  const goBack = useCallback(() => {
    if (currentStep === "subjects") setCurrentStep("details");
    else if (currentStep === "review") setCurrentStep("subjects");
    else router.back();
  }, [currentStep, router]);

  const handleSubmit = useCallback(async () => {
    try {
      setSaving(true);

      const examPayload = {
        schoolId,
        name:         form.name.trim(),
        type:         form.type,
        academicYear: form.academicYear,
        term:         form.term,
        status:       form.status,
        startDate:    form.startDate.trim()    || null,
        endDate:      form.endDate.trim()      || null,
        description:  form.description.trim()  || null,
        instructions: form.instructions.trim() || null,
        totalMarks:   Number(form.totalMarks),
        passMark:     Number(form.passMark),
        createdBy:    user?._id || user?.id    || null,
      };

      const examResult = await ExamService.createExam(examPayload);

      const examId =
        examResult?.exam?._id ||
        examResult?.exam?.id  ||
        examResult?.serverId  ||
        examResult?._id       ||
        examResult?.id;

      if (!examId) throw new Error("Exam created but ID was not returned");

      let totalAssigned = 0;
      let totalQueued   = 0;
      for (const [classId, clsData] of Object.entries(assignments)) {
        for (const [subjectId, subData] of Object.entries(clsData.subjects)) {
          try {
            // Goes through ExamService so an assignment made offline is
            // stored locally and queued, instead of being silently lost.
            const res = await ExamService.assignExamSubject({
              examId,
              subjectId,
              classId,
              teacherId:   subData.teacherId || null,
              subjectName: subData.subjectName || null,
              maxScore:    Number(subData.maxScore) || Number(form.totalMarks),
              passMark:    Number(subData.passMark) || Number(form.passMark),
              schoolId,
            });
            totalAssigned++;
            if (res?.queued) totalQueued++;
          } catch (subErr) {
            console.warn(
              `Subject assign failed: ${subData.subjectName}`,
              subErr.message
            );
          }
        }
      }

      Alert.alert(
        examResult?.queued || totalQueued > 0 ? "Exam Saved Offline" : "Exam Created",
        `"${form.name}" created${
          totalAssigned > 0 ? ` with ${totalAssigned} subject assignment(s)` : ""
        }.` +
        (examResult?.queued || totalQueued > 0
          ? "\n\nSaved on this device — it will upload automatically when you're back online."
          : ""),
        [
          {
            text:    "Enter Marks Now",
            onPress: () =>
              router.replace({
                pathname: "/admin/exams/marks",
                params:   { examId, examName: form.name },
              }),
          },
          {
            text:    "View Exam",
            onPress: () =>
              router.replace({
                pathname: "/admin/exams/[id]",
                params:   { id: examId },
              }),
          },
          {
            text:    "Done",
            style:   "cancel",
            onPress: () => router.back(),
          },
        ]
      );
    } catch (err) {
      console.error("Create exam failed:", err.message);
      Alert.alert("Error", err.message || "Failed to create exam");
    } finally {
      setSaving(false);
    }
  }, [form, assignments, schoolId, user, router]);

  const isLastStep = currentStep === "review";

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={goBack} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Create Exam</Text>
          <Text style={styles.headerSub}>
            {currentStep === "details"
              ? "Fill in exam details"
              : currentStep === "subjects"
              ? "Assign subjects & classes"
              : "Review & confirm"}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.saveBtn,
            (saving || (currentStep === "details" && !detailsValid)) && { opacity: 0.5 },
            isLastStep && { backgroundColor: "#059669" },
          ]}
          onPress={isLastStep ? handleSubmit : goNext}
          disabled={saving || (currentStep === "details" && !detailsValid)}
          activeOpacity={0.8}
        >
          {saving
            ? <ActivityIndicator size="small" color="#FFF" />
            : <Text style={styles.saveBtnText}>{isLastStep ? "Create" : "Next"}</Text>
          }
        </TouchableOpacity>
      </View>

      <StepIndicator steps={STEPS} currentStep={currentStep} />

      <View style={{ flex: 1 }}>
        {currentStep === "details"  && <StepDetails  form={form} onChange={onChange} errors={detailErrors} />}
        {currentStep === "subjects" && <StepSubjects schoolId={schoolId} form={form} assignments={assignments} setAssignments={setAssignments} />}
        {currentStep === "review"   && <StepReview   form={form} assignments={assignments} />}
      </View>

      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.bottomNavBack}
          onPress={goBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={16} color="#4F46E5" />
          <Text style={styles.bottomNavBackText}>
            {currentStep === "details" ? "Cancel" : "Back"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.bottomNavNext,
            (saving || (currentStep === "details" && !detailsValid)) && { opacity: 0.5 },
            isLastStep && { backgroundColor: "#059669" },
          ]}
          onPress={isLastStep ? handleSubmit : goNext}
          disabled={saving || (currentStep === "details" && !detailsValid)}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Text style={styles.bottomNavNextText}>
                {isLastStep ? "Create Exam" : "Next Step"}
              </Text>
              <Ionicons
                name={isLastStep ? "checkmark-circle" : "arrow-forward"}
                size={16}
                color="#FFF"
              />
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  saveBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 18,
  },
  saveBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  scroll:      { padding: 16 },
  section: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  sectionTitle: {
    fontSize:     15,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 16,
  },
  row:         { flexDirection: "row" },
  passPreview: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             6,
    backgroundColor: "#EEF2FF",
    borderRadius:    8,
    padding:         10,
    marginTop:       4,
  },
  passPreviewText: { fontSize: 13, color: "#4F46E5", fontWeight: "600" },
  bottomNav: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   12,
    backgroundColor:   "#FFF",
    borderTopWidth:    1,
    borderTopColor:    "#F3F4F6",
    gap:               12,
  },
  bottomNavBack: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingVertical:   12,
    paddingHorizontal: 16,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
  },
  bottomNavBackText: { fontSize: 14, fontWeight: "600", color: "#4F46E5" },
  bottomNavNext: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: "#4F46E5",
    borderRadius:    12,
    paddingVertical: 14,
  },
  bottomNavNextText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});