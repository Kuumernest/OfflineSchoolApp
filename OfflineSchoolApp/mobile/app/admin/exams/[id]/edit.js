// app/admin/exams/[id]/edit.js
"use strict";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, StatusBar, Modal, FlatList,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../../src/store/auth.store";
import { ExamService }  from "../../../../src/services/exam.service";
import api              from "../../../../src/services/api";
import DateField        from "../../../../src/components/DateField";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const EXAM_TYPES = [
  { value: "first_test",            label: "First Test"            },
  { value: "second_test",           label: "Second Test"           },
  { value: "mid_term",              label: "Mid-Term"              },
  { value: "practical",             label: "Practical"             },
  { value: "final_exam",            label: "Final Exam"            },
  { value: "mock_exam",             label: "Mock Exam"             },
  { value: "promotion_exam",        label: "Promotion Exam"        },
  { value: "continuous_assessment", label: "Continuous Assessment" },
];

const TERMS = [
  { value: "first_term",  label: "First Term"  },
  { value: "second_term", label: "Second Term" },
  { value: "third_term",  label: "Third Term"  },
];

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  error:     "#DC2626",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────

function isValidDate(str) {
  if (!str) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  return !isNaN(new Date(str).getTime());
}

// ─────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────

const SectionTitle = ({ children, noMargin }) => (
  <Text style={[s.sectionTitle, noMargin && { marginBottom: 0 }]}>{children}</Text>
);

const Field = ({ label, required, children, hint }) => (
  <View style={s.field}>
    <Text style={s.fieldLabel}>
      {label}
      {required && <Text style={s.required}> *</Text>}
    </Text>
    {children}
    {!!hint && <Text style={s.fieldHint}>{hint}</Text>}
  </View>
);

const StyledInput = ({
  value, onChangeText, placeholder,
  keyboardType, multiline, numberOfLines,
  maxLength, editable = true,
}) => (
  <TextInput
    style={[
      s.input,
      multiline && { height: (numberOfLines || 3) * 28, textAlignVertical: "top" },
      !editable && { opacity: 0.5 },
    ]}
    value={value}
    onChangeText={onChangeText}
    placeholder={placeholder}
    placeholderTextColor={C.gray400}
    keyboardType={keyboardType || "default"}
    multiline={multiline}
    numberOfLines={numberOfLines}
    maxLength={maxLength}
    editable={editable}
  />
);

const DateInput = DateField; // shared native calendar picker (YYYY-MM-DD in/out)

const OptionPicker = ({ options, value, onChange }) => (
  <View style={s.optionGrid}>
    {options.map((opt) => {
      const selected = value === opt.value;
      return (
        <TouchableOpacity
          key={opt.value}
          style={[s.optionBtn, selected && s.optionBtnSelected]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <Text style={[s.optionText, selected && s.optionTextSelected]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
);

// ─────────────────────────────────────────────────────────
// CLASS PICKER MODAL
// ─────────────────────────────────────────────────────────

const ClassPickerModal = ({
  visible, availableClasses, selectedIds,
  onToggle, onClose, loading,
}) => (
  <Modal
    visible={visible}
    transparent
    animationType="slide"
    onRequestClose={onClose}
  >
    <TouchableOpacity style={cm.overlay} activeOpacity={1} onPress={onClose}>
      <TouchableOpacity style={cm.sheet} activeOpacity={1} onPress={() => {}}>
        <View style={cm.handle} />
        <View style={cm.header}>
          <Text style={cm.title}>Select Classes</Text>
          <TouchableOpacity
            onPress={onClose}
            style={cm.closeBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="checkmark" size={22} color={C.primary} />
          </TouchableOpacity>
        </View>
        <Text style={cm.sub}>Tap to select or deselect classes for this exam</Text>

        {loading ? (
          <View style={cm.loadingBox}>
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={cm.loadingText}>Loading classes…</Text>
          </View>
        ) : availableClasses.length === 0 ? (
          <View style={cm.empty}>
            <Ionicons name="school-outline" size={36} color={C.gray300} />
            <Text style={cm.emptyText}>No classes found</Text>
            <Text style={cm.emptySubText}>Create classes in the admin panel first</Text>
          </View>
        ) : (
          <FlatList
            data={availableClasses}
            keyExtractor={(item) => String(item._id || item.id)}
            contentContainerStyle={{ gap: 8, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              const cid      = String(item._id || item.id);
              const selected = selectedIds.includes(cid);
              const name     = item.name || item.className || "Unknown Class";
              return (
                <TouchableOpacity
                  style={[cm.classRow, selected && cm.classRowSelected]}
                  onPress={() => onToggle(cid, name)}
                  activeOpacity={0.7}
                >
                  <View style={[cm.classIcon, selected && { backgroundColor: C.primaryBg }]}>
                    <Ionicons
                      name="school-outline"
                      size={18}
                      color={selected ? C.primary : C.gray500}
                    />
                  </View>
                  <View style={cm.classInfo}>
                    <Text style={[cm.className, selected && { color: C.primary }]}>{name}</Text>
                    {(item.level || item.section) && (
                      <Text style={cm.classGrade}>
                        {[item.level, item.section].filter(Boolean).join(" · ")}
                      </Text>
                    )}
                    {item.studentCount != null && (
                      <Text style={cm.classStudents}>
                        {item.studentCount} student{item.studentCount !== 1 ? "s" : ""}
                      </Text>
                    )}
                  </View>
                  <View style={[
                    cm.checkbox,
                    selected && { backgroundColor: C.primary, borderColor: C.primary },
                  ]}>
                    {selected && <Ionicons name="checkmark" size={14} color={C.white} />}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </TouchableOpacity>
    </TouchableOpacity>
  </Modal>
);

const cm = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      C.white,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    padding:              20,
    paddingTop:           12,
    maxHeight:            "78%",
  },
  handle: {
    width:           40,
    height:          4,
    backgroundColor: C.gray200,
    borderRadius:    2,
    alignSelf:       "center",
    marginBottom:    14,
  },
  header: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   4,
  },
  title:        { fontSize: 17, fontWeight: "700", color: C.gray900 },
  closeBtn:     { padding: 4 },
  sub:          { fontSize: 13, color: C.gray500, marginBottom: 16, lineHeight: 18 },
  loadingBox:   { alignItems: "center", paddingVertical: 48, gap: 12 },
  loadingText:  { fontSize: 14, color: C.gray500 },
  empty:        { alignItems: "center", paddingVertical: 40, gap: 8 },
  emptyText:    { fontSize: 14, fontWeight: "600", color: C.gray400 },
  emptySubText: { fontSize: 12, color: C.gray400, textAlign: "center" },
  classRow: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: C.gray50,
    borderRadius:    12,
    padding:         14,
    borderWidth:     1,
    borderColor:     C.gray200,
  },
  classRowSelected: { borderColor: C.primary, backgroundColor: "#F5F3FF" },
  classIcon: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  classInfo:     { flex: 1 },
  className:     { fontSize: 14, fontWeight: "600", color: C.gray900 },
  classGrade:    { fontSize: 11, color: C.gray500, marginTop: 2 },
  classStudents: { fontSize: 11, color: C.gray400, marginTop: 1 },
  checkbox: {
    width:          22,
    height:         22,
    borderRadius:   6,
    borderWidth:    2,
    borderColor:    C.gray300,
    alignItems:     "center",
    justifyContent: "center",
  },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function EditExamScreen() {
  const router   = useRouter();
  const { id }   = useLocalSearchParams();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const classesLoadedRef  = useRef(false);
  const classesLoadingRef = useRef(false);

  const [loading,          setLoading]          = useState(true);
  const [saving,           setSaving]           = useState(false);
  const [exam,             setExam]             = useState(null);
  const [classPickerOpen,  setClassPickerOpen]  = useState(false);
  const [availableClasses, setAvailableClasses] = useState([]);
  const [classesLoading,   setClassesLoading]   = useState(false);

  const [name,            setName]            = useState("");
  const [type,            setType]            = useState("first_test");
  const [term,            setTerm]            = useState("first_term");
  const [academicYear,    setAcademicYear]    = useState("");
  const [startDate,       setStartDate]       = useState("");
  const [endDate,         setEndDate]         = useState("");
  const [totalMarks,      setTotalMarks]      = useState("100");
  const [passMark,        setPassMark]        = useState("50");
  const [description,     setDescription]     = useState("");
  const [instructions,    setInstructions]    = useState("");
  const [selectedClasses, setSelectedClasses] = useState([]);

  // ── Load exam ──────────────────────────────────────────
  const loadExam = useCallback(async () => {
    try {
      setLoading(true);
      const res = await ExamService.getExamById(id, schoolId);
      const e   = res?.exam;
      if (!e) throw new Error("Exam not found");

      setExam(e);
      setName(e.name              || "");
      setType(e.type              || "first_test");
      setTerm(e.term              || "first_term");
      setAcademicYear(e.academicYear || "");
      setStartDate(e.startDate    || "");
      setEndDate(e.endDate        || "");
      setTotalMarks(String(e.totalMarks ?? 100));
      setPassMark(String(e.passMark     ?? 50));
      setDescription(e.description    || "");
      setInstructions(e.instructions  || "");

      if (Array.isArray(e.classes) && e.classes.length > 0) {
        setSelectedClasses(
          e.classes.map((c) => ({
            classId:   String(c._id || c.id || c.classId),
            className: c.name || c.className || "Unknown",
          }))
        );
      } else if (Array.isArray(e.classIds) && e.classIds.length > 0) {
        setSelectedClasses(
          e.classIds.map((cid) => ({ classId: String(cid), className: "Class" }))
        );
      } else if (e.classId) {
        setSelectedClasses([{ classId: String(e.classId), className: e.className || "Class" }]);
      } else {
        setSelectedClasses([]);
      }
    } catch (err) {
      Alert.alert("Error", err.message || "Failed to load exam");
      router.back();
    } finally {
      setLoading(false);
    }
  }, [id, schoolId]);

  useEffect(() => { loadExam(); }, [loadExam]);

  // ── Load classes ───────────────────────────────────────
  const loadAvailableClasses = useCallback(async () => {
    if (classesLoadingRef.current || classesLoadedRef.current) return;
    classesLoadingRef.current = true;
    setClassesLoading(true);

    try {
      let list = [];
      const endpoints = [
        `/admin/classes?schoolId=${schoolId}`,
        `/classes?schoolId=${schoolId}`,
        `/schools/${schoolId}/classes`,
      ];

      for (const ep of endpoints) {
        try {
          const response = await api.get(ep);
          const raw = response.data?.classes || response.data?.data || response.data || [];
          list = Array.isArray(raw) ? raw : [];
          if (list.length > 0) break;
        } catch { continue; }
      }

      setAvailableClasses(list);
      classesLoadedRef.current = true;

      if (list.length > 0) {
        setSelectedClasses((prev) =>
          prev.map((sel) => {
            if (sel.className !== "Class") return sel;
            const found = list.find((c) => String(c._id || c.id) === sel.classId);
            return found
              ? { ...sel, className: found.name || found.className || sel.className }
              : sel;
          })
        );
      }
    } catch (err) {
      console.warn("Failed to load classes:", err.message);
      setSelectedClasses((prev) => {
        setAvailableClasses(prev.map((c) => ({ _id: c.classId, name: c.className })));
        return prev;
      });
      classesLoadedRef.current = true;
    } finally {
      classesLoadingRef.current = false;
      setClassesLoading(false);
    }
  }, [schoolId]);

  const handleOpenClassPicker = () => {
    if (!classesLoadedRef.current) loadAvailableClasses();
    setClassPickerOpen(true);
  };

  const toggleClass = useCallback((classId, className) => {
    setSelectedClasses((prev) => {
      const exists = prev.some((c) => c.classId === classId);
      return exists
        ? prev.filter((c) => c.classId !== classId)
        : [...prev, { classId, className }];
    });
  }, []);

  // ── Validate ───────────────────────────────────────────
  const validate = useCallback(() => {
    if (!name.trim()) {
      Alert.alert("Validation", "Exam name is required");
      return false;
    }
    if (!academicYear.trim()) {
      Alert.alert("Validation", "Academic year is required");
      return false;
    }
    if (startDate && !isValidDate(startDate)) {
      Alert.alert("Validation", "Start date format must be YYYY-MM-DD");
      return false;
    }
    if (endDate && !isValidDate(endDate)) {
      Alert.alert("Validation", "End date format must be YYYY-MM-DD");
      return false;
    }
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      Alert.alert("Validation", "End date must be after start date");
      return false;
    }
    const tm = Number(totalMarks);
    const pm = Number(passMark);
    if (isNaN(tm) || tm <= 0) {
      Alert.alert("Validation", "Total marks must be a positive number");
      return false;
    }
    if (isNaN(pm) || pm < 0 || pm > tm) {
      Alert.alert("Validation", "Pass mark must be between 0 and total marks");
      return false;
    }
    return true;
  }, [name, academicYear, startDate, endDate, totalMarks, passMark]);

  // ── Save ───────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!validate()) return;
    try {
      setSaving(true);
      await ExamService.updateExam(id, {
        name:         name.trim(),
        type,
        term,
        academicYear: academicYear.trim(),
        startDate:    startDate.trim()    || undefined,
        endDate:      endDate.trim()      || undefined,
        totalMarks:   Number(totalMarks),
        passMark:     Number(passMark),
        description:  description.trim()  || undefined,
        instructions: instructions.trim() || undefined,
        classes:      selectedClasses.map((c) => c.classId),
        classIds:     selectedClasses.map((c) => c.classId),
        classId:      selectedClasses[0]?.classId || undefined,
        className:    selectedClasses.length
          ? selectedClasses.map((c) => c.className).join(", ")
          : undefined,
      }, schoolId);
      Alert.alert("Saved", "Exam updated successfully", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      Alert.alert("Save Failed", err.message || "Could not update exam");
    } finally {
      setSaving(false);
    }
  }, [
    validate, name, type, term, academicYear,
    startDate, endDate, totalMarks, passMark,
    description, instructions, selectedClasses, id, schoolId,
  ]);

  // ── Delete ─────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    Alert.alert(
      "Delete Exam",
      `Are you sure you want to delete "${exam?.name}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text:    "Delete",
          style:   "destructive",
          onPress: async () => {
            try {
              await ExamService.deleteExam(id, schoolId);
              router.replace("/admin/exams");
            } catch (err) {
              Alert.alert("Error", err.message || "Could not delete exam");
            }
          },
        },
      ]
    );
  }, [exam, id, schoolId]);

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={s.loadingText}>Loading exam…</Text>
      </View>
    );
  }

  const selectedIds    = selectedClasses.map((c) => c.classId);
  const tm             = Number(totalMarks);
  const pm             = Number(passMark);
  const passRatePct    = tm > 0 ? ((pm / tm) * 100).toFixed(1) : null;

  return (
    <View style={s.container}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <ClassPickerModal
        visible={classPickerOpen}
        availableClasses={availableClasses}
        selectedIds={selectedIds}
        onToggle={toggleClass}
        onClose={() => setClassPickerOpen(false)}
        loading={classesLoading}
      />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>Edit Exam</Text>
          <Text style={s.headerSub} numberOfLines={1}>{exam?.name || ""}</Text>
        </View>
        <TouchableOpacity
          style={[s.saveHeaderBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving
            ? <ActivityIndicator size="small" color={C.white} />
            : <Text style={s.saveHeaderBtnText}>Save</Text>
          }
        </TouchableOpacity>
      </View>

      {/* Form */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Basic Info */}
        <View style={s.card}>
          <SectionTitle>Basic Information</SectionTitle>
          <Field label="Exam Name" required>
            <StyledInput value={name} onChangeText={setName} placeholder="e.g. Mid-Term Examination 2024" maxLength={120} />
          </Field>
          <Field label="Exam Type" required>
            <OptionPicker options={EXAM_TYPES} value={type} onChange={setType} />
          </Field>
          <Field label="Academic Year" required hint="e.g. 2024/2025">
            <StyledInput value={academicYear} onChangeText={setAcademicYear} placeholder="2024/2025" maxLength={20} />
          </Field>
          <Field label="Term" required>
            <OptionPicker options={TERMS} value={term} onChange={setTerm} />
          </Field>
        </View>

        {/* Classes */}
        <View style={s.card}>
          <View style={s.classSectionHeader}>
            <SectionTitle noMargin>Classes</SectionTitle>
            <TouchableOpacity style={s.addClassBtn} onPress={handleOpenClassPicker} activeOpacity={0.7}>
              <Ionicons name="add" size={18} color={C.primary} />
              <Text style={s.addClassBtnText}>Add / Edit</Text>
            </TouchableOpacity>
          </View>

          {selectedClasses.length === 0 ? (
            <TouchableOpacity style={s.noClassBox} onPress={handleOpenClassPicker} activeOpacity={0.7}>
              <Ionicons name="school-outline" size={28} color={C.gray300} />
              <Text style={s.noClassText}>No classes selected</Text>
              <Text style={s.noClassSub}>Tap "Add / Edit" to assign classes</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.classChipWrap}>
              {selectedClasses.map((c) => (
                <View key={c.classId} style={s.classChip}>
                  <Ionicons name="school-outline" size={12} color={C.primary} />
                  <Text style={s.classChipText} numberOfLines={1}>{c.className}</Text>
                  <TouchableOpacity
                    onPress={() => toggleClass(c.classId, c.className)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={14} color={C.primary} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={s.editClassChip} onPress={handleOpenClassPicker} activeOpacity={0.7}>
                <Ionicons name="pencil-outline" size={12} color={C.gray500} />
                <Text style={s.editClassChipText}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
          {selectedClasses.length > 0 && (
            <Text style={s.classCount}>
              {selectedClasses.length} class{selectedClasses.length !== 1 ? "es" : ""} selected
            </Text>
          )}
        </View>

        {/* Dates */}
        <View style={s.card}>
          <SectionTitle>Dates</SectionTitle>
          <View style={s.dateRow}>
            <View style={s.dateField}>
              <DateInput label="Start Date" value={startDate} onChange={setStartDate} />
            </View>
            <View style={s.dateField}>
              <DateInput label="End Date" value={endDate} onChange={setEndDate} />
            </View>
          </View>
        </View>

        {/* Marks */}
        <View style={s.card}>
          <SectionTitle>Marks Configuration</SectionTitle>
          <View style={s.dateRow}>
            <View style={s.dateField}>
              <Field label="Total Marks" required>
                <StyledInput value={totalMarks} onChangeText={setTotalMarks} placeholder="100" keyboardType="numeric" maxLength={6} />
              </Field>
            </View>
            <View style={s.dateField}>
              <Field label="Pass Mark" required>
                <StyledInput value={passMark} onChangeText={setPassMark} placeholder="50" keyboardType="numeric" maxLength={6} />
              </Field>
            </View>
          </View>
          {passRatePct !== null && (
            <View style={s.passPreview}>
              <Ionicons name="information-circle-outline" size={14} color={C.primary} />
              <Text style={s.passPreviewText}>Pass rate: {passRatePct}%</Text>
            </View>
          )}
        </View>

        {/* Additional */}
        <View style={s.card}>
          <SectionTitle>Additional Information</SectionTitle>
          <Field label="Description" hint="Optional — visible to teachers">
            <StyledInput value={description} onChangeText={setDescription} placeholder="Brief description…" multiline numberOfLines={3} maxLength={500} />
          </Field>
          <Field label="Instructions" hint="Optional — visible to students">
            <StyledInput value={instructions} onChangeText={setInstructions} placeholder="Instructions for students…" multiline numberOfLines={4} maxLength={1000} />
          </Field>
        </View>

        {/* Save */}
        <TouchableOpacity
          style={[s.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <>
              <ActivityIndicator size="small" color={C.white} />
              <Text style={s.saveBtnText}>Saving…</Text>
            </>
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color={C.white} />
              <Text style={s.saveBtnText}>Save Changes</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Danger zone */}
        <View style={s.dangerCard}>
          <Text style={s.dangerTitle}>Danger Zone</Text>
          <Text style={s.dangerSub}>
            Deleting an exam is permanent. All marks and results will be removed.
          </Text>
          <TouchableOpacity style={s.deleteBtn} onPress={handleDelete} activeOpacity={0.8}>
            <Ionicons name="trash-outline" size={16} color={C.error} />
            <Text style={s.deleteBtnText}>Delete This Exam</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: C.gray50 },
  centered:     { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: C.gray50, gap: 12 },
  loadingText:  { color: C.gray500, fontSize: 14 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray200,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:      { flex: 1 },
  headerTitle:       { fontSize: 16, fontWeight: "700", color: C.gray900 },
  headerSub:         { fontSize: 11, color: C.gray500, marginTop: 2 },
  saveHeaderBtn: {
    backgroundColor:   C.primary,
    borderRadius:      10,
    paddingVertical:   8,
    paddingHorizontal: 16,
    minWidth:          60,
    alignItems:        "center",
    justifyContent:    "center",
  },
  saveHeaderBtnText: { color: C.white, fontWeight: "700", fontSize: 14 },
  scroll:            { flex: 1 },
  scrollContent:     { padding: 16 },
  card: {
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: C.gray900, marginBottom: 14 },
  field:        { marginBottom: 16 },
  fieldLabel: {
    fontSize:      12,
    fontWeight:    "600",
    color:         C.gray700,
    marginBottom:  6,
    textTransform: "uppercase",
  },
  required:  { color: C.error },
  fieldHint: { fontSize: 11, color: C.gray400, marginTop: 4 },
  input: {
    backgroundColor:   C.gray50,
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          14,
    color:             C.gray900,
    minHeight:         46,
  },
  optionGrid:         { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionBtn: {
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       C.gray200,
    backgroundColor:   C.gray50,
  },
  optionBtnSelected:  { borderColor: C.primary, backgroundColor: C.primaryBg },
  optionText:         { fontSize: 13, fontWeight: "500", color: C.gray600 },
  optionTextSelected: { color: C.primary, fontWeight: "700" },
  classSectionHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   12,
  },
  addClassBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   C.primaryBg,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   6,
  },
  addClassBtnText: { fontSize: 13, fontWeight: "600", color: C.primary },
  noClassBox: {
    alignItems:        "center",
    paddingVertical:   28,
    gap:               6,
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      12,
    borderStyle:       "dashed",
    backgroundColor:   C.gray50,
  },
  noClassText:   { fontSize: 14, fontWeight: "600", color: C.gray400 },
  noClassSub:    { fontSize: 12, color: C.gray400, textAlign: "center", paddingHorizontal: 20 },
  classChipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  classChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    backgroundColor:   C.primaryBg,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   6,
    borderWidth:       1,
    borderColor:       C.primary + "30",
    maxWidth:          160,
  },
  classChipText: { fontSize: 13, fontWeight: "600", color: C.primary, flexShrink: 1 },
  editClassChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   C.gray100,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   6,
    borderWidth:       1,
    borderColor:       C.gray200,
  },
  editClassChipText: { fontSize: 13, fontWeight: "500", color: C.gray500 },
  classCount:        { fontSize: 12, color: C.gray500, marginTop: 10 },
  dateRow:           { flexDirection: "row", gap: 12 },
  dateField:         { flex: 1 },
  passPreview: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             6,
    backgroundColor: C.primaryBg,
    borderRadius:    8,
    padding:         10,
    marginTop:       4,
  },
  passPreviewText: { fontSize: 13, color: C.primary, fontWeight: "600" },
  saveBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: C.primary,
    borderRadius:    14,
    paddingVertical: 16,
    marginBottom:    16,
    shadowColor:     C.primary,
    shadowOpacity:   0.3,
    shadowRadius:    8,
    elevation:       4,
  },
  saveBtnText: { color: C.white, fontWeight: "700", fontSize: 16 },
  dangerCard: {
    backgroundColor: "#FFF5F5",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     "#FEE2E2",
  },
  dangerTitle: { fontSize: 14, fontWeight: "700", color: C.error, marginBottom: 6 },
  dangerSub:   { fontSize: 13, color: C.gray600, lineHeight: 20, marginBottom: 14 },
  deleteBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    borderWidth:       1,
    borderColor:       C.error,
    borderRadius:      10,
    paddingVertical:   12,
    paddingHorizontal: 16,
    alignSelf:         "flex-start",
  },
  deleteBtnText: { fontSize: 14, fontWeight: "600", color: C.error },
});