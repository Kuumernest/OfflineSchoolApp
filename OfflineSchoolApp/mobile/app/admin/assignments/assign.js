import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  getTeachersList, getClassesList, getSubjectsByClass,
  createAssignment, createBulkAssignments, getTeacherAssignments,
} from "../../../src/services/assignment.service";

const normalizeId = (item) => {
  if (!item || typeof item !== "object") return null;
  const resolvedId = item._id || item.id;
  return { ...item, _id: resolvedId, id: resolvedId };
};

const normalizeList = (list) => (list || []).map(normalizeId).filter(Boolean);

const STEPS = [
  { id: 1, title: "Select Teacher",   icon: "person-outline"           },
  { id: 2, title: "Select Class",     icon: "school-outline"           },
  { id: 3, title: "Select Subjects",  icon: "book-outline"             },
  { id: 4, title: "Review & Confirm", icon: "checkmark-circle-outline" },
];

const EmptyMini = React.memo(({ icon, text, subtext, children }) => (
  <View style={styles.emptyMini}>
    {children || <Ionicons name={icon} size={32} color="#D1D5DB" />}
    <Text style={styles.emptyMiniText}>{text}</Text>
    {!!subtext && <Text style={styles.emptyMiniSubtext}>{subtext}</Text>}
  </View>
));

const StepDot = React.memo(({ step, isActive, isCompleted, onPress }) => (
  <TouchableOpacity
    style={[
      styles.stepDot,
      isActive    && styles.stepDotActive,
      isCompleted && styles.stepDotCompleted,
    ]}
    onPress={isCompleted ? onPress : undefined}
    disabled={!isCompleted}
    activeOpacity={isCompleted ? 0.7 : 1}
  >
    {isCompleted ? (
      <Ionicons name="checkmark" size={14} color="#FFFFFF" />
    ) : (
      <Text style={[styles.stepDotText, isActive && styles.stepDotTextActive]}>
        {step.id}
      </Text>
    )}
  </TouchableOpacity>
));

const TeacherCard = React.memo(({ teacher, isSelected, onPress }) => (
  <TouchableOpacity
    style={[styles.selectionCard, isSelected && styles.selectionCardActive]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={styles.selectionLeft}>
      <View style={[styles.selectionAvatar, isSelected && styles.selectionAvatarActive]}>
        <Text style={[styles.selectionAvatarText, isSelected && styles.selectionAvatarTextActive]}>
          {teacher.name?.charAt(0)?.toUpperCase() || "?"}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.selectionTitle} numberOfLines={1}>{teacher.name}</Text>
        <Text style={styles.selectionSubtitle} numberOfLines={1}>{teacher.email || "No email"}</Text>
      </View>
    </View>
    <View style={[styles.radioOuter, isSelected && styles.radioOuterActive]}>
      {isSelected && <View style={styles.radioInner} />}
    </View>
  </TouchableOpacity>
));

const ClassCard = React.memo(({ classItem, isSelected, existingCount, onPress }) => (
  <TouchableOpacity
    style={[styles.selectionCard, isSelected && styles.selectionCardActive]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={styles.selectionLeft}>
      <View style={[styles.selectionIcon, { backgroundColor: isSelected ? "#4F46E5" : "#EDE9FE" }]}>
        <Ionicons name="school" size={18} color={isSelected ? "#FFFFFF" : "#7C3AED"} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.selectionTitle} numberOfLines={1}>{classItem.name}</Text>
        <Text style={styles.selectionSubtitle}>
          {classItem.section ? `Section ${classItem.section}` : ""}
          {classItem.subjectCount ? ` • ${classItem.subjectCount} subjects` : ""}
        </Text>
      </View>
    </View>
    <View style={styles.selectionRight}>
      {existingCount > 0 && (
        <View style={styles.existingPill}>
          <Text style={styles.existingPillText}>{existingCount} assigned</Text>
        </View>
      )}
      <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
    </View>
  </TouchableOpacity>
));

const SubjectCard = React.memo(({ subject, isSelected, alreadyAssigned, onToggle }) => (
  <TouchableOpacity
    style={[
      styles.subjectCard,
      isSelected      && styles.subjectCardActive,
      alreadyAssigned && styles.subjectCardDisabled,
    ]}
    onPress={() => { if (!alreadyAssigned) onToggle(subject); }}
    activeOpacity={alreadyAssigned ? 1 : 0.7}
    disabled={alreadyAssigned}
  >
    <View style={styles.subjectLeft}>
      <View style={[
        styles.checkbox,
        isSelected      && styles.checkboxActive,
        alreadyAssigned && styles.checkboxDisabled,
      ]}>
        {(isSelected || alreadyAssigned) && (
          <Ionicons name="checkmark" size={14} color={alreadyAssigned ? "#9CA3AF" : "#FFFFFF"} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.subjectName, alreadyAssigned && styles.subjectNameDisabled]} numberOfLines={1}>
          {subject.name}
        </Text>
        {!!subject.code && <Text style={styles.subjectCode}>{subject.code}</Text>}
      </View>
    </View>
    {alreadyAssigned && (
      <View style={styles.assignedTag}>
        <Text style={styles.assignedTagText}>Already Assigned</Text>
      </View>
    )}
  </TouchableOpacity>
));

const ReviewSubjectItem = React.memo(({ subject, onRemove }) => (
  <View style={styles.reviewSubjectItem}>
    <View style={styles.reviewSubjectDot} />
    <Text style={styles.reviewSubjectText} numberOfLines={1}>{subject.name}</Text>
    <TouchableOpacity onPress={() => onRemove(subject._id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
      <Ionicons name="close-circle" size={18} color="#EF4444" />
    </TouchableOpacity>
  </View>
));

export default function AssignTeacher() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const preselectedTeacherId   = params.teacherId   || null;
  const preselectedTeacherName = params.teacherName || null;

  const [currentStep, setCurrentStep] = useState(preselectedTeacherId ? 2 : 1);

  const [teachers,            setTeachers]            = useState([]);
  const [classes,             setClasses]             = useState([]);
  const [subjects,            setSubjects]            = useState([]);
  const [existingAssignments, setExistingAssignments] = useState([]);

  const [selectedTeacher, setSelectedTeacher] = useState(
    preselectedTeacherId ? normalizeId({ _id: preselectedTeacherId, name: preselectedTeacherName }) : null
  );
  const [selectedClass,    setSelectedClass]    = useState(null);
  const [selectedSubjects, setSelectedSubjects] = useState([]);

  const [loading,         setLoading]         = useState(true);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [submitting,      setSubmitting]      = useState(false);
  const [error,           setError]           = useState(null);
  const [teacherSearch,   setTeacherSearch]   = useState("");

  const isMountedRef          = useRef(true);
  const assignmentFetchGenRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // In refreshExistingAssignments callback — add type check
const refreshExistingAssignments = useCallback(async (teacherId) => {
  if (!teacherId) return;
  const generation = ++assignmentFetchGenRef.current;
  try {
    // ✅ Guard: ensure function exists before calling
    if (typeof getTeacherAssignments !== "function") {
      console.warn("[AssignTeacher] getTeacherAssignments is not a function — skipping");
      return;
    }
    const existing = await getTeacherAssignments(teacherId);
    if (isMountedRef.current && generation === assignmentFetchGenRef.current) {
      setExistingAssignments(normalizeList(existing));
    }
  } catch (err) {
    console.warn("Could not load existing assignments:", err.message);
    if (isMountedRef.current && generation === assignmentFetchGenRef.current) {
      setExistingAssignments([]);
    }
  }
}, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [teachersData, classesData] = await Promise.all([
        getTeachersList(), getClassesList(),
      ]);
      if (!isMountedRef.current) return;
      setTeachers(normalizeList(teachersData));
      setClasses(normalizeList(classesData));
      if (preselectedTeacherId) {
        await refreshExistingAssignments(preselectedTeacherId);
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error("Failed to load data:", err);
        setError("Failed to load data. Check your network connection.");
      }
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [preselectedTeacherId, refreshExistingAssignments]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (preselectedTeacherId && teachers.length > 0) {
      const fullTeacher = teachers.find((t) => t._id === preselectedTeacherId);
      if (fullTeacher) setSelectedTeacher(normalizeId(fullTeacher));
    }
  }, [teachers, preselectedTeacherId]);

  const handleClassSelect = useCallback(async (classItem) => {
    const normalized = normalizeId(classItem);
    setSelectedClass(normalized);
    setSelectedSubjects([]);
    setCurrentStep(3);

    try {
      setLoadingSubjects(true);
      const subjectsData = await getSubjectsByClass(normalized._id);
      if (isMountedRef.current) setSubjects(normalizeList(subjectsData));
    } catch (err) {
      if (isMountedRef.current) {
        Alert.alert("Error", "Failed to load subjects for this class");
        setSubjects([]);
      }
    } finally {
      if (isMountedRef.current) setLoadingSubjects(false);
    }
  }, []);

  const handleTeacherSelect = useCallback(async (teacher) => {
    const normalized = normalizeId(teacher);
    setSelectedTeacher(normalized);
    setSelectedClass(null);
    setSelectedSubjects([]);
    setSubjects([]);
    await refreshExistingAssignments(normalized._id);
    if (isMountedRef.current) setCurrentStep(2);
  }, [refreshExistingAssignments]);

  const toggleSubject = useCallback((subject) => {
    const normalized = normalizeId(subject);
    setSelectedSubjects((prev) => {
      const exists = prev.find((s) => s._id === normalized._id);
      if (exists) return prev.filter((s) => s._id !== normalized._id);
      return [...prev, normalized];
    });
  }, []);

  const removeSubjectById = useCallback((subjectId) => {
    setSelectedSubjects((prev) => prev.filter((s) => s._id !== subjectId));
  }, []);

  const goToStep = useCallback((targetStep) => {
    const resolvedStep = targetStep === 1 && preselectedTeacherId ? 2 : targetStep;

    if (resolvedStep === 1) {
      setSelectedTeacher(null);
      setSelectedClass(null);
      setSelectedSubjects([]);
      setExistingAssignments([]);
      setTeacherSearch("");
    } else if (resolvedStep === 2) {
      setSelectedClass(null);
      setSelectedSubjects([]);
      setSubjects([]);
    } else if (resolvedStep === 3) {
      setSelectedSubjects([]);
    }
    setCurrentStep(resolvedStep);
  }, [preselectedTeacherId]);

  const assignedSet = useMemo(() => {
    const set = new Set();
    existingAssignments.forEach((a) => {
      const subjectId = a.subject?._id || a.subjectId || a.subject_id;
      const classId   = a.class?._id   || a.classId   || a.class_id;
      if (subjectId && classId) set.add(`${subjectId}|${classId}`);
    });
    return set;
  }, [existingAssignments]);

  const isAlreadyAssignedToThisTeacher = useCallback(
    (subjectId, classId) => assignedSet.has(`${subjectId}|${classId}`),
    [assignedSet]
  );

  const filteredTeachers = useMemo(() => {
    const query = teacherSearch.toLowerCase().trim();
    if (!query) return teachers;
    return teachers.filter((t) => t.name?.toLowerCase().includes(query));
  }, [teachers, teacherSearch]);

  const availableSubjects = useMemo(
    () => subjects.filter((s) => !isAlreadyAssignedToThisTeacher(s._id, selectedClass?._id)),
    [subjects, isAlreadyAssignedToThisTeacher, selectedClass]
  );

  const allAvailableSelected = useMemo(() => {
    if (availableSubjects.length === 0) return false;
    const selectedIds = new Set(selectedSubjects.map((s) => s._id));
    return availableSubjects.every((s) => selectedIds.has(s._id));
  }, [availableSubjects, selectedSubjects]);

  const handleSubmit = useCallback(async () => {
    if (!selectedTeacher || !selectedClass || selectedSubjects.length === 0) {
      Alert.alert("Error", "Please complete all selections");
      return;
    }
    if (submitting) return;

    try {
      setSubmitting(true);
      const teacherId = selectedTeacher._id;
      const classId   = selectedClass._id;
      let successCount = 0;

      if (selectedSubjects.length === 1) {
        try {
          await createAssignment({ teacherId, classId, subjectId: selectedSubjects[0]._id });
          successCount = 1;
        } catch (err) {
          if (err?.response?.status === 409) successCount = 1;
          else throw err;
        }
      } else {
        const result = await createBulkAssignments({
          teacherId,
          assignments: selectedSubjects.map((s) => ({ classId, subjectId: s._id })),
        });
        successCount =
          ((result?.created?.length ?? 0) + (result?.skipped?.length ?? 0)) ||
          selectedSubjects.length;
      }

      await refreshExistingAssignments(teacherId);

      if (!isMountedRef.current) return;

      Alert.alert(
        "✅ Success!",
        `${successCount} subject${successCount !== 1 ? "s" : ""} assigned to ${selectedTeacher.name}`,
        [
          {
            text: "Assign More",
            onPress: () => {
              if (isMountedRef.current) {
                setSelectedClass(null);
                setSelectedSubjects([]);
                setSubjects([]);
                setCurrentStep(2);
              }
            },
          },
          { text: "Done", onPress: () => router.back() },
        ]
      );
    } catch (err) {
      if (!isMountedRef.current) return;

      if (err?.response?.status === 409) {
        await refreshExistingAssignments(selectedTeacher._id);
        Alert.alert(
          "ℹ️ Already Assigned",
          "Some or all subjects were already assigned to this teacher.",
          [{ text: "OK", onPress: () => router.back() }]
        );
      } else {
        const message = err?.response?.data?.message || err.message || "Failed to create assignment";
        Alert.alert("Assignment Failed", message);
      }
    } finally {
      if (isMountedRef.current) setSubmitting(false);
    }
  }, [selectedTeacher, selectedClass, selectedSubjects, submitting, refreshExistingAssignments, router]);

  const renderStepIndicator = () => (
    <View style={styles.stepIndicator}>
      {STEPS.map((step, index) => {
        const isActive    = currentStep === step.id;
        const isCompleted = currentStep > step.id;
        return (
          <React.Fragment key={step.id}>
            <StepDot
              step={step}
              isActive={isActive}
              isCompleted={isCompleted}
              onPress={() => { if (isCompleted) goToStep(step.id); }}
            />
            {index < STEPS.length - 1 && (
              <View style={[styles.stepLine, (isCompleted || isActive) && styles.stepLineActive]} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );

  const renderCurrentStepInfo = () => {
    const step = STEPS[currentStep - 1];
    return (
      <View style={styles.stepInfo}>
        <View style={styles.stepInfoIcon}>
          <Ionicons name={step.icon} size={22} color="#4F46E5" />
        </View>
        <View>
          <Text style={styles.stepInfoLabel}>Step {step.id} of 4</Text>
          <Text style={styles.stepInfoTitle}>{step.title}</Text>
        </View>
      </View>
    );
  };

  const renderStep1 = () => (
    <View>
      <View style={styles.searchInputContainer}>
        <Ionicons name="search-outline" size={18} color="#9CA3AF" />
        <TextInput
          style={styles.searchTextInput}
          placeholder="Search teachers by name…"
          placeholderTextColor="#9CA3AF"
          value={teacherSearch}
          onChangeText={setTeacherSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {teacherSearch.length > 0 && (
          <TouchableOpacity onPress={() => setTeacherSearch("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        )}
      </View>

      {filteredTeachers.length === 0 ? (
        <EmptyMini
          icon="people-outline"
          text={teacherSearch ? "No teachers match your search" : "No teachers available"}
          subtext={!teacherSearch ? "Add teachers first from the Teachers module" : undefined}
        />
      ) : (
        filteredTeachers.map((teacher) => (
          <TeacherCard
            key={teacher._id}
            teacher={teacher}
            isSelected={selectedTeacher?._id === teacher._id}
            onPress={() => handleTeacherSelect(teacher)}
          />
        ))
      )}
    </View>
  );

  const renderStep2 = () => (
    <View>
      <View style={styles.selectedSummary}>
        <Ionicons name="person" size={16} color="#4F46E5" />
        <Text style={styles.selectedSummaryText} numberOfLines={1}>{selectedTeacher?.name}</Text>
        {!preselectedTeacherId && (
          <TouchableOpacity onPress={() => goToStep(1)}>
            <Text style={styles.changeLink}>Change</Text>
          </TouchableOpacity>
        )}
      </View>

      {existingAssignments.length > 0 && (
        <View style={styles.existingBanner}>
          <Ionicons name="information-circle" size={18} color="#2563EB" />
          <Text style={styles.existingBannerText}>
            Currently assigned to {existingAssignments.length} subject
            {existingAssignments.length !== 1 ? "s" : ""}
          </Text>
        </View>
      )}

      {classes.length === 0 ? (
        <EmptyMini
          icon="school-outline"
          text="No classes available"
          subtext="Create classes first from the Classes module"
        />
      ) : (
        classes.map((classItem) => {
          const existingCount = existingAssignments.filter((a) => {
            const aClassId = a.class?._id || a.classId || a.class_id;
            return aClassId === classItem._id;
          }).length;

          return (
            <ClassCard
              key={classItem._id}
              classItem={classItem}
              isSelected={selectedClass?._id === classItem._id}
              existingCount={existingCount}
              onPress={() => handleClassSelect(classItem)}
            />
          );
        })
      )}
    </View>
  );

  const renderStep3 = () => (
    <View>
      <View style={styles.breadcrumb}>
        <TouchableOpacity
          style={styles.breadcrumbItem}
          onPress={() => goToStep(preselectedTeacherId ? 2 : 1)}
        >
          <Ionicons name="person" size={14} color="#4F46E5" />
          <Text style={styles.breadcrumbText} numberOfLines={1}>{selectedTeacher?.name}</Text>
        </TouchableOpacity>
        <Ionicons name="chevron-forward" size={12} color="#D1D5DB" />
        <TouchableOpacity style={styles.breadcrumbItem} onPress={() => goToStep(2)}>
          <Ionicons name="school" size={14} color="#7C3AED" />
          <Text style={styles.breadcrumbText} numberOfLines={1}>{selectedClass?.name}</Text>
        </TouchableOpacity>
      </View>

      {loadingSubjects ? (
        <EmptyMini text="Loading subjects…">
          <ActivityIndicator size="small" color="#4F46E5" />
        </EmptyMini>
      ) : subjects.length === 0 ? (
        <EmptyMini icon="book-outline" text="No subjects in this class" subtext="Add subjects to this class first" />
      ) : (
        <>
          <Text style={styles.selectHint}>Select one or more subjects to assign</Text>

          {availableSubjects.length > 0 && (
            <TouchableOpacity
              style={styles.selectAllButton}
              onPress={() => setSelectedSubjects(allAvailableSelected ? [] : [...availableSubjects])}
              activeOpacity={0.7}
            >
              <Ionicons
                name={allAvailableSelected ? "checkbox" : "square-outline"}
                size={20}
                color="#4F46E5"
              />
              <Text style={styles.selectAllText}>
                {allAvailableSelected ? "Deselect All" : `Select All (${availableSubjects.length})`}
              </Text>
            </TouchableOpacity>
          )}

          {subjects.map((subject) => {
            const alreadyAssigned = isAlreadyAssignedToThisTeacher(subject._id, selectedClass?._id);
            const isSelected = selectedSubjects.some((s) => s._id === subject._id);
            return (
              <SubjectCard
                key={subject._id}
                subject={subject}
                isSelected={isSelected}
                alreadyAssigned={alreadyAssigned}
                onToggle={toggleSubject}
              />
            );
          })}

          {selectedSubjects.length > 0 && (
            <TouchableOpacity
              style={styles.proceedButton}
              onPress={() => setCurrentStep(4)}
              activeOpacity={0.8}
            >
              <Text style={styles.proceedButtonText}>
                Review {selectedSubjects.length} Selection{selectedSubjects.length !== 1 ? "s" : ""}
              </Text>
              <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );

  const renderStep4 = () => (
    <View>
      <Text style={styles.reviewTitle}>Assignment Summary</Text>

      <View style={styles.reviewSection}>
        <View style={styles.reviewLabel}>
          <Ionicons name="person" size={16} color="#4F46E5" />
          <Text style={styles.reviewLabelText}>Teacher</Text>
        </View>
        <View style={styles.reviewValue}>
          <Text style={styles.reviewValueText}>{selectedTeacher?.name}</Text>
        </View>
      </View>

      <View style={styles.reviewSection}>
        <View style={styles.reviewLabel}>
          <Ionicons name="school" size={16} color="#7C3AED" />
          <Text style={styles.reviewLabelText}>Class</Text>
        </View>
        <View style={styles.reviewValue}>
          <Text style={styles.reviewValueText}>{selectedClass?.name}</Text>
        </View>
      </View>

      <View style={styles.reviewSection}>
        <View style={styles.reviewLabel}>
          <Ionicons name="book" size={16} color="#059669" />
          <Text style={styles.reviewLabelText}>Subjects ({selectedSubjects.length})</Text>
        </View>
        <View style={styles.reviewSubjectsList}>
          {selectedSubjects.map((subject) => (
            <ReviewSubjectItem key={subject._id} subject={subject} onRemove={removeSubjectById} />
          ))}
        </View>
      </View>

      {selectedSubjects.length === 0 && (
        <View style={styles.warningBanner}>
          <Ionicons name="warning" size={18} color="#D97706" />
          <Text style={styles.warningText}>No subjects selected. Go back to select at least one.</Text>
        </View>
      )}

      <View style={styles.reviewActions}>
        <TouchableOpacity style={styles.backStepButton} onPress={() => setCurrentStep(3)} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={18} color="#4F46E5" />
          <Text style={styles.backStepButtonText}>Back</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.confirmButton,
            (submitting || selectedSubjects.length === 0) && styles.confirmButtonDisabled,
          ]}
          onPress={handleSubmit}
          disabled={submitting || selectedSubjects.length === 0}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" />
              <Text style={styles.confirmButtonText}>Confirm</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderCurrentStep = () => {
    switch (currentStep) {
      case 1:  return renderStep1();
      case 2:  return renderStep2();
      case 3:  return renderStep3();
      case 4:  return renderStep4();
      default: return null;
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Assign Teacher</Text>
          <Text style={styles.headerSubtitle}>Map subjects to a teacher</Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={loadData} activeOpacity={0.75}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {renderStepIndicator()}
        {renderCurrentStepInfo()}

        <View style={styles.stepContent}>{renderCurrentStep()}</View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#F9FAFB" },
  centered:      { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText:   { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingBottom: 40 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEE2E2",
    marginHorizontal: 20, marginTop: 16, padding: 12,
    borderRadius: 10, gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },
  stepIndicator: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingHorizontal: 40, marginTop: 24, marginBottom: 20,
  },
  stepDot: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "#E5E7EB",
    alignItems: "center", justifyContent: "center",
  },
  stepDotActive: { backgroundColor: "#4F46E5" },
  stepDotCompleted: { backgroundColor: "#059669" },
  stepDotText: { fontSize: 13, fontWeight: "700", color: "#9CA3AF" },
  stepDotTextActive: { color: "#FFFFFF" },
  stepLine: { flex: 1, height: 2, backgroundColor: "#E5E7EB", marginHorizontal: 4 },
  stepLineActive: { backgroundColor: "#059669" },
  stepInfo: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFFFFF",
    marginHorizontal: 20, padding: 16,
    borderRadius: 14, gap: 14,
    borderWidth: 1, borderColor: "#F3F4F6",
  },
  stepInfoIcon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
  },
  stepInfoLabel: { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },
  stepInfoTitle: { fontSize: 17, fontWeight: "700", color: "#111827", marginTop: 2 },
  stepContent: { paddingHorizontal: 20, marginTop: 20 },
  searchInputContainer: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14, borderRadius: 12, height: 46,
    borderWidth: 1, borderColor: "#E5E7EB",
    marginBottom: 16, gap: 10,
  },
  searchTextInput: { flex: 1, fontSize: 14, color: "#111827", paddingVertical: 0 },
  selectionCard: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 8,
    borderWidth: 1.5, borderColor: "#E5E7EB",
  },
  selectionCardActive: { borderColor: "#4F46E5", backgroundColor: "#FAFAFF" },
  selectionLeft: { flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 },
  selectionAvatar: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
    marginRight: 12,
  },
  selectionAvatarActive: { backgroundColor: "#4F46E5" },
  selectionAvatarText: { fontSize: 16, fontWeight: "700", color: "#6B7280" },
  selectionAvatarTextActive: { color: "#FFFFFF" },
  selectionIcon: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  selectionTitle: { fontSize: 15, fontWeight: "600", color: "#111827" },
  selectionSubtitle: { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  selectionRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  radioOuter: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: "#D1D5DB",
    alignItems: "center", justifyContent: "center",
  },
  radioOuterActive: { borderColor: "#4F46E5" },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#4F46E5" },
  selectedSummary: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", padding: 12,
    borderRadius: 10, marginBottom: 16, gap: 8,
  },
  selectedSummaryText: { flex: 1, fontSize: 14, fontWeight: "600", color: "#4F46E5" },
  changeLink: { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  existingBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#DBEAFE", padding: 12,
    borderRadius: 10, marginBottom: 16, gap: 8,
  },
  existingBannerText: { flex: 1, fontSize: 13, color: "#1E40AF", fontWeight: "500" },
  existingPill: {
    backgroundColor: "#DBEAFE",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
  },
  existingPillText: { fontSize: 11, fontWeight: "600", color: "#2563EB" },
  breadcrumb: {
    flexDirection: "row", alignItems: "center",
    marginBottom: 16, gap: 8, flexWrap: "wrap",
  },
  breadcrumbItem: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, gap: 4, maxWidth: "45%",
  },
  breadcrumbText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  selectHint: { fontSize: 13, color: "#6B7280", marginBottom: 12, fontWeight: "500" },
  selectAllButton: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", padding: 12,
    borderRadius: 10, marginBottom: 12, gap: 10,
  },
  selectAllText: { fontSize: 14, fontWeight: "600", color: "#4F46E5" },
  subjectCard: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 8,
    borderWidth: 1.5, borderColor: "#E5E7EB",
  },
  subjectCardActive: { borderColor: "#059669", backgroundColor: "#F0FDF4" },
  subjectCardDisabled: { borderColor: "#E5E7EB", backgroundColor: "#F9FAFB", opacity: 0.7 },
  subjectLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: "#D1D5DB",
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  checkboxActive: { backgroundColor: "#059669", borderColor: "#059669" },
  checkboxDisabled: { backgroundColor: "#E5E7EB", borderColor: "#D1D5DB" },
  subjectName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  subjectNameDisabled: { color: "#9CA3AF" },
  subjectCode: { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  assignedTag: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 6, marginLeft: 8,
  },
  assignedTagText: { fontSize: 11, fontWeight: "600", color: "#9CA3AF" },
  proceedButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 14, marginTop: 16, gap: 8,
  },
  proceedButtonText: { fontSize: 15, fontWeight: "600", color: "#FFFFFF" },
  reviewTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginBottom: 20 },
  reviewSection: {
    backgroundColor: "#FFFFFF", borderRadius: 12, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: "#F3F4F6",
  },
  reviewLabel: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  reviewLabelText: {
    fontSize: 13, fontWeight: "600", color: "#6B7280",
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  reviewValue: { backgroundColor: "#F9FAFB", padding: 12, borderRadius: 8 },
  reviewValueText: { fontSize: 15, fontWeight: "600", color: "#111827" },
  reviewSubjectsList: { gap: 6 },
  reviewSubjectItem: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F0FDF4", padding: 10, borderRadius: 8, gap: 8,
  },
  reviewSubjectDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#059669" },
  reviewSubjectText: { flex: 1, fontSize: 14, fontWeight: "500", color: "#111827" },
  warningBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEF3C7", padding: 12,
    borderRadius: 10, marginBottom: 16, gap: 8,
  },
  warningText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  reviewActions: { flexDirection: "row", gap: 12, marginTop: 20 },
  backStepButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#EEF2FF", borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 20, gap: 6,
  },
  backStepButtonText: { fontSize: 15, fontWeight: "600", color: "#4F46E5" },
  confirmButton: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#059669", borderRadius: 12,
    paddingVertical: 14, gap: 8,
  },
  confirmButtonDisabled: { backgroundColor: "#9CA3AF" },
  confirmButtonText: { fontSize: 15, fontWeight: "600", color: "#FFFFFF" },
  emptyMini: { alignItems: "center", paddingVertical: 30 },
  emptyMiniText: {
    fontSize: 14, fontWeight: "600", color: "#6B7280",
    marginTop: 8, textAlign: "center",
  },
  emptyMiniSubtext: {
    fontSize: 12, color: "#9CA3AF", marginTop: 2,
    textAlign: "center", paddingHorizontal: 20,
  },
});