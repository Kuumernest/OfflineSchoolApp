import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  TextInput,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons }  from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getTeacherSubjectsForUpload } from "../../../src/services/content.service";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  {
    id:    "syllabus",
    label: "Syllabus",
    icon:  "list-outline",
    color: "#7C3AED",
    bg:    "#EDE9FE",
    hint:  "PDF, DOC",
    maxMB: 50,
  },
  {
    id:    "notes",
    label: "Notes",
    icon:  "document-text-outline",
    color: "#4F46E5",
    bg:    "#EEF2FF",
    hint:  "PDF, DOC, DOCX",
    maxMB: 50,
  },
  {
    id:    "image",
    label: "Image",
    icon:  "image-outline",
    color: "#059669",
    bg:    "#ECFDF5",
    hint:  "JPG, PNG, WEBP",
    maxMB: 20,
  },
  {
    id:    "audio",
    label: "Audio",
    icon:  "musical-notes-outline",
    color: "#D97706",
    bg:    "#FEF3C7",
    hint:  "MP3, WAV, M4A",
    maxMB: 100,
  },
  {
    id:    "video",
    label: "Video",
    icon:  "videocam-outline",
    color: "#DC2626",
    bg:    "#FEE2E2",
    hint:  "MP4, MOV, AVI",
    maxMB: 500,
  },
  {
    id:    "document",
    label: "Document",
    icon:  "attach-outline",
    color: "#059669",
    bg:    "#ECFDF5",
    hint:  "PDF, DOCX, XLSX",
    maxMB: 50,
  },
];

const STEPS = ["Type", "Subject", "Class"];

// ─────────────────────────────────────────────────────────────
// STEP INDICATOR
// ─────────────────────────────────────────────────────────────

function StepIndicator({ currentStep }) {
  return (
    <View style={stepStyles.container}>
      {STEPS.map((label, index) => {
        const done   = index < currentStep;
        const active = index === currentStep;
        return (
          <React.Fragment key={label}>
            <View style={stepStyles.step}>
              <View
                style={[
                  stepStyles.circle,
                  done   && stepStyles.circleDone,
                  active && stepStyles.circleActive,
                ]}
              >
                {done ? (
                  <Ionicons name="checkmark" size={12} color="#FFF" />
                ) : (
                  <Text
                    style={[
                      stepStyles.circleText,
                      active && stepStyles.circleTextActive,
                    ]}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              <Text
                style={[
                  stepStyles.label,
                  active && stepStyles.labelActive,
                  done   && stepStyles.labelDone,
                ]}
              >
                {label}
              </Text>
            </View>
            {index < STEPS.length - 1 && (
              <View
                style={[stepStyles.line, done && stepStyles.lineDone]}
              />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

function SelectSubjectPage() {
  const router    = useRouter();
  const user      = useAuthStore((s) => s.user);
  const teacherId = user?._id || user?.id || user?.userId || null;

  const [step, setStep] = useState(0);

  const [selectedType,    setSelectedType]    = useState(null);
  const [selectedSubject, setSelectedSubject] = useState(null);
  const [selectedClasses, setSelectedClasses] = useState([]);

  const [subjects,  setSubjects]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [subjectSearch, setSubjectSearch] = useState("");

  // ── Load subjects ─────────────────────────────────────────
  const loadSubjects = useCallback(async () => {
    if (!teacherId) { setLoading(false); return; }
    try {
      setLoading(true);
      setLoadError(null);
      const data = await getTeacherSubjectsForUpload(teacherId);
      setSubjects(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("SelectSubjectPage load error:", err);
      setLoadError("Could not load subjects. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [teacherId]);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // ── Derived ───────────────────────────────────────────────
  const filteredSubjects = useMemo(() => {
    if (!subjectSearch.trim()) return subjects;
    const q = subjectSearch.toLowerCase();
    return subjects.filter((s) =>
      s.subjectName?.toLowerCase().includes(q)
    );
  }, [subjects, subjectSearch]);

  const availableClasses = useMemo(() => {
    if (!selectedSubject) return [];
    return (
      subjects.find((s) => s.subjectId === selectedSubject.subjectId)
        ?.classes || []
    );
  }, [selectedSubject, subjects]);

  const allClassesSelected =
    availableClasses.length > 0 &&
    selectedClasses.length === availableClasses.length;

  // ── Handlers ──────────────────────────────────────────────
  const handleSelectType = useCallback((type) => {
    setSelectedType(type);
    setStep(1);
  }, []);

  const handleSelectSubject = useCallback((subject) => {
    setSelectedSubject(subject);
    setSelectedClasses([]);
    setSubjectSearch("");
    setStep(2);
  }, []);

  const toggleClass = useCallback((cls) => {
    setSelectedClasses((prev) => {
      const exists = prev.find((c) => c.classId === cls.classId);
      return exists
        ? prev.filter((c) => c.classId !== cls.classId)
        : [...prev, cls];
    });
  }, []);

  const toggleAllClasses = useCallback(() => {
    setSelectedClasses(
      allClassesSelected ? [] : [...availableClasses]
    );
  }, [allClassesSelected, availableClasses]);

  const handleBack = useCallback(() => {
    if (step === 2) {
      setSelectedClasses([]);
      setStep(1);
    } else if (step === 1) {
      setSelectedSubject(null);
      setSubjectSearch("");
      setStep(0);
    } else {
      router.back();
    }
  }, [step, router]);

  const handleContinue = useCallback(() => {
    if (!selectedType || !selectedSubject || selectedClasses.length === 0)
      return;

    router.push({
      pathname: "/teacher/content/upload-notes",
      params: {
        presetType:        selectedType.id,
        presetSubjectId:   selectedSubject.subjectId,
        presetSubjectName: selectedSubject.subjectName,
        presetClassIds:    JSON.stringify(
          selectedClasses.map((c) => c.classId)
        ),
        presetClassNames: JSON.stringify(
          selectedClasses.map((c) => c.className)
        ),
      },
    });
  }, [selectedType, selectedSubject, selectedClasses, router]);

  // ── Render ────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle}>Upload Content</Text>
          <Text style={styles.headerSub}>
            Step {step + 1} of {STEPS.length} — {STEPS[step]}
          </Text>
        </View>
      </View>

      {/* STEP INDICATOR */}
      <StepIndicator currentStep={step} />

      {/* SELECTION SUMMARY BAR */}
      {(selectedType || selectedSubject) && (
        <View style={styles.selectionBar}>
          {selectedType && (
            <View
              style={[
                styles.selectionChip,
                { backgroundColor: selectedType.bg },
              ]}
            >
              <Ionicons
                name={selectedType.icon}
                size={12}
                color={selectedType.color}
              />
              <Text
                style={[
                  styles.selectionChipText,
                  { color: selectedType.color },
                ]}
              >
                {selectedType.label}
              </Text>
            </View>
          )}

          {selectedSubject && (
            <>
              <Ionicons name="chevron-forward" size={14} color="#D1D5DB" />
              <View style={styles.selectionChip}>
                <Ionicons name="book-outline" size={12} color="#4F46E5" />
                <Text
                  style={[styles.selectionChipText, { color: "#4F46E5" }]}
                  numberOfLines={1}
                >
                  {selectedSubject.subjectName}
                </Text>
              </View>
            </>
          )}

          {selectedClasses.length > 0 && (
            <>
              <Ionicons name="chevron-forward" size={14} color="#D1D5DB" />
              <View
                style={[
                  styles.selectionChip,
                  { backgroundColor: "#ECFDF5" },
                ]}
              >
                <Ionicons name="school-outline" size={12} color="#059669" />
                <Text
                  style={[styles.selectionChipText, { color: "#059669" }]}
                >
                  {selectedClasses.length} class
                  {selectedClasses.length > 1 ? "es" : ""}
                </Text>
              </View>
            </>
          )}
        </View>
      )}

      {/* ══════════ STEP 0 — TYPE ══════════ */}
      {step === 0 && (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.stepHeading}>
            What do you want to upload?
          </Text>
          <Text style={styles.stepSubHeading}>
            Choose a content type to continue
          </Text>

          <View style={styles.typeGrid}>
            {CONTENT_TYPES.map((type) => (
              <TouchableOpacity
                key={type.id}
                style={styles.typeCard}
                onPress={() => handleSelectType(type)}
                activeOpacity={0.75}
              >
                <View
                  style={[
                    styles.typeIconBox,
                    { backgroundColor: type.bg },
                  ]}
                >
                  <Ionicons name={type.icon} size={26} color={type.color} />
                </View>
                <Text style={styles.typeLabel}>{type.label}</Text>
                <Text style={styles.typeHint}>{type.hint}</Text>
                <Text style={styles.typeSize}>Max {type.maxMB} MB</Text>
                <View
                  style={[styles.typeArrow, { backgroundColor: type.bg }]}
                >
                  <Ionicons
                    name="arrow-forward"
                    size={14}
                    color={type.color}
                  />
                </View>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ height: 32 }} />
        </ScrollView>
      )}

      {/* ══════════ STEP 1 — SUBJECT ══════════ */}
      {step === 1 && (
        <View style={{ flex: 1 }}>
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={16} color="#9CA3AF" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search subjects…"
              placeholderTextColor="#9CA3AF"
              value={subjectSearch}
              onChangeText={setSubjectSearch}
              autoFocus
              returnKeyType="search"
            />
            {subjectSearch.length > 0 && (
              <TouchableOpacity onPress={() => setSubjectSearch("")}>
                <Ionicons name="close-circle" size={16} color="#9CA3AF" />
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#4F46E5" />
              <Text style={styles.loadingText}>Loading your subjects…</Text>
            </View>
          ) : loadError ? (
            <View style={styles.centered}>
              <Ionicons
                name="alert-circle-outline"
                size={40}
                color="#DC2626"
              />
              <Text style={styles.errorText}>{loadError}</Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={loadSubjects}
                activeOpacity={0.8}
              >
                <Text style={styles.retryBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : filteredSubjects.length === 0 ? (
            <View style={styles.centered}>
              <Ionicons name="book-outline" size={40} color="#9CA3AF" />
              <Text style={styles.emptyTitle}>
                {subjectSearch ? "No subjects found" : "No subjects assigned"}
              </Text>
              <Text style={styles.emptySubtitle}>
                {subjectSearch
                  ? `No results for "${subjectSearch}"`
                  : "Contact admin to get subjects assigned"}
              </Text>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.subjectListContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.listHeading}>
                {filteredSubjects.length} subject
                {filteredSubjects.length !== 1 ? "s" : ""} assigned
              </Text>

              {filteredSubjects.map((subject) => (
                <TouchableOpacity
                  key={subject.subjectId}
                  style={styles.subjectCard}
                  onPress={() => handleSelectSubject(subject)}
                  activeOpacity={0.75}
                >
                  <View style={styles.subjectIcon}>
                    <Ionicons name="book" size={20} color="#4F46E5" />
                  </View>
                  <View style={styles.subjectInfo}>
                    <Text style={styles.subjectName}>
                      {subject.subjectName}
                    </Text>
                    <Text style={styles.subjectMeta}>
                      {subject.classes?.length || 0} class
                      {(subject.classes?.length || 0) !== 1 ? "es" : ""}
                      {subject.classes?.length > 0
                        ? `  ·  ${subject.classes
                            .slice(0, 2)
                            .map((c) => c.className)
                            .join(", ")}${
                            subject.classes.length > 2
                              ? ` +${subject.classes.length - 2}`
                              : ""
                          }`
                        : ""}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color="#D1D5DB"
                  />
                </TouchableOpacity>
              ))}

              <View style={{ height: 32 }} />
            </ScrollView>
          )}
        </View>
      )}

      {/* ══════════ STEP 2 — CLASS ══════════ */}
      {step === 2 && (
        <View style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={styles.classListContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Subject recap */}
            <View style={styles.subjectRecap}>
              <View style={styles.subjectRecapIcon}>
                <Ionicons name="book" size={16} color="#4F46E5" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.subjectRecapLabel}>Subject</Text>
                <Text style={styles.subjectRecapName}>
                  {selectedSubject?.subjectName}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => { setSelectedClasses([]); setStep(1); }}
                activeOpacity={0.7}
              >
                <Text style={styles.changeBtn}>Change</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.stepHeading}>
              Which classes get access?
            </Text>
            <Text style={styles.stepSubHeading}>
              Select one or more classes for this content
            </Text>

            {availableClasses.length === 0 ? (
              <View style={styles.emptyClasses}>
                <Ionicons name="school-outline" size={36} color="#9CA3AF" />
                <Text style={styles.emptyTitle}>No classes found</Text>
                <Text style={styles.emptySubtitle}>
                  No classes are linked to this subject
                </Text>
              </View>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.selectAllRow}
                  onPress={toggleAllClasses}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.checkbox,
                      allClassesSelected && styles.checkboxChecked,
                    ]}
                  >
                    {allClassesSelected && (
                      <Ionicons name="checkmark" size={12} color="#FFF" />
                    )}
                  </View>
                  <Text style={styles.selectAllText}>
                    {allClassesSelected
                      ? "Deselect all"
                      : `Select all (${availableClasses.length})`}
                  </Text>
                </TouchableOpacity>

                {availableClasses.map((cls) => {
                  const isSelected = !!selectedClasses.find(
                    (c) => c.classId === cls.classId
                  );
                  return (
                    <TouchableOpacity
                      key={cls.classId}
                      style={[
                        styles.classCard,
                        isSelected && styles.classCardSelected,
                      ]}
                      onPress={() => toggleClass(cls)}
                      activeOpacity={0.75}
                    >
                      <View
                        style={[
                          styles.checkbox,
                          isSelected && styles.checkboxChecked,
                        ]}
                      >
                        {isSelected && (
                          <Ionicons name="checkmark" size={12} color="#FFF" />
                        )}
                      </View>

                      <View
                        style={[
                          styles.classIconBox,
                          isSelected && { backgroundColor: "#EEF2FF" },
                        ]}
                      >
                        <Ionicons
                          name="school"
                          size={18}
                          color={isSelected ? "#4F46E5" : "#9CA3AF"}
                        />
                      </View>

                      <Text
                        style={[
                          styles.className,
                          isSelected && styles.classNameSelected,
                        ]}
                      >
                        {cls.className}
                      </Text>

                      {isSelected && (
                        <View style={styles.selectedBadge}>
                          <Ionicons name="checkmark" size={12} color="#FFF" />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            <View style={{ height: 140 }} />
          </ScrollView>

          {/* CONTINUE BAR */}
          {selectedClasses.length > 0 && (
            <View style={styles.continueBar}>
              <View style={styles.continueInfo}>
                <Text style={styles.continueInfoTitle}>Ready to upload</Text>
                <Text style={styles.continueInfoSub}>
                  {selectedType?.label}{"  ·  "}{selectedSubject?.subjectName}
                  {"\n"}
                  {selectedClasses.length} class
                  {selectedClasses.length > 1 ? "es" : ""} selected
                </Text>
              </View>
              <TouchableOpacity
                style={styles.continueBtn}
                onPress={handleContinue}
                activeOpacity={0.85}
              >
                <Text style={styles.continueBtnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color="#FFF" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export default SelectSubjectPage;

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F4F6" },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               12,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerInfo:  { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },

  selectionBar: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               6,
    flexWrap:          "wrap",
  },
  selectionChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      20,
    backgroundColor:   "#EEF2FF",
    maxWidth:          140,
  },
  selectionChipText: { fontSize: 11, fontWeight: "600" },

  scrollContent:  { paddingHorizontal: 16, paddingTop: 20 },
  stepHeading: {
    fontSize:     20,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 4,
  },
  stepSubHeading: {
    fontSize:     14,
    color:        "#9CA3AF",
    marginBottom: 20,
  },

  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  typeCard: {
    width:           "47%",
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    alignItems:      "flex-start",
    gap:             6,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    4,
    elevation:       2,
    position:        "relative",
  },
  typeIconBox: {
    width:          52,
    height:         52,
    borderRadius:   14,
    alignItems:     "center",
    justifyContent: "center",
    marginBottom:   4,
  },
  typeLabel: { fontSize: 15, fontWeight: "700", color: "#111827" },
  typeHint:  { fontSize: 11, color: "#9CA3AF" },
  typeSize:  { fontSize: 10, color: "#D1D5DB" },
  typeArrow: {
    position:       "absolute",
    top:            12,
    right:          12,
    width:          26,
    height:         26,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },

  searchBar: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F9FAFB",
    marginHorizontal:  16,
    marginTop:         12,
    marginBottom:      4,
    paddingHorizontal: 12,
    paddingVertical:   10,
    borderRadius:      12,
    gap:               8,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  subjectListContent: { paddingHorizontal: 16, paddingTop: 12 },
  listHeading: {
    fontSize:      12,
    color:         "#9CA3AF",
    fontWeight:    "600",
    marginBottom:  10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  subjectCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    8,
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       2,
  },
  subjectIcon: {
    width:           42,
    height:          42,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  subjectInfo: { flex: 1 },
  subjectName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  subjectMeta: { fontSize: 12, color: "#9CA3AF", marginTop: 2 },

  classListContent: { paddingHorizontal: 16, paddingTop: 16 },
  subjectRecap: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#EEF2FF",
    borderRadius:    12,
    padding:         12,
    marginBottom:    20,
    gap:             10,
  },
  subjectRecapIcon: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#FFF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  subjectRecapLabel: { fontSize: 11, color: "#6B7280", fontWeight: "500" },
  subjectRecapName:  { fontSize: 14, fontWeight: "700", color: "#111827" },
  changeBtn:         { fontSize: 13, color: "#4F46E5", fontWeight: "600" },

  selectAllRow: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             10,
    marginBottom:    12,
    paddingVertical: 4,
  },
  selectAllText: { fontSize: 14, color: "#4F46E5", fontWeight: "600" },

  checkbox: {
    width:           22,
    height:          22,
    borderRadius:    6,
    borderWidth:     2,
    borderColor:     "#D1D5DB",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#FFF",
  },
  checkboxChecked: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },

  classCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    8,
    gap:             12,
    borderWidth:     1.5,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOpacity:   0.03,
    shadowRadius:    2,
    elevation:       1,
  },
  classCardSelected: { borderColor: "#4F46E5", backgroundColor: "#FAFBFF" },
  classIconBox: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: "#F9FAFB",
    alignItems:      "center",
    justifyContent:  "center",
  },
  className:         { flex: 1, fontSize: 15, fontWeight: "600", color: "#374151" },
  classNameSelected: { color: "#4F46E5" },
  selectedBadge: {
    width:           22,
    height:          22,
    borderRadius:    11,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },
  emptyClasses: { alignItems: "center", paddingTop: 40, gap: 10 },

  continueBar: {
    position:          "absolute",
    bottom:            0,
    left:              0,
    right:             0,
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#FFF",
    paddingHorizontal: 16,
    paddingTop:        14,
    paddingBottom:     Platform.OS === "ios" ? 34 : 20,
    borderTopWidth:    1,
    borderTopColor:    "#F3F4F6",
    gap:               12,
    shadowColor:       "#000",
    shadowOpacity:     0.08,
    shadowRadius:      8,
    elevation:         8,
  },
  continueInfo:      { flex: 1 },
  continueInfoTitle: { fontSize: 13, fontWeight: "700", color: "#111827" },
  continueInfoSub:   { fontSize: 11, color: "#9CA3AF", marginTop: 2, lineHeight: 16 },
  continueBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 20,
    paddingVertical:   13,
    borderRadius:      12,
  },
  continueBtnText: { color: "#FFF", fontWeight: "700", fontSize: 15 },

  centered: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    padding:        32,
    gap:            12,
  },
  loadingText:  { fontSize: 14, color: "#6B7280", marginTop: 8 },
  errorText:    { fontSize: 14, color: "#DC2626", textAlign: "center", fontWeight: "500" },
  retryBtn: {
    backgroundColor:   "#DC2626",
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
    marginTop:         6,
  },
  retryBtnText:  { color: "#FFF", fontWeight: "700", fontSize: 14 },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});

const stepStyles = StyleSheet.create({
  container: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 24,
    paddingVertical:   14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  step:             { alignItems: "center", gap: 4 },
  circle: {
    width:           24,
    height:          24,
    borderRadius:    12,
    backgroundColor: "#E5E7EB",
    alignItems:      "center",
    justifyContent:  "center",
  },
  circleDone:       { backgroundColor: "#059669" },
  circleActive:     { backgroundColor: "#4F46E5" },
  circleText:       { fontSize: 11, fontWeight: "700", color: "#9CA3AF" },
  circleTextActive: { color: "#FFF" },
  label:            { fontSize: 10, color: "#9CA3AF", fontWeight: "500" },
  labelActive:      { color: "#4F46E5", fontWeight: "700" },
  labelDone:        { color: "#059669" },
  line: {
    flex:             1,
    height:           2,
    backgroundColor:  "#E5E7EB",
    marginHorizontal: 4,
    marginBottom:     14,
  },
  lineDone: { backgroundColor: "#059669" },
});