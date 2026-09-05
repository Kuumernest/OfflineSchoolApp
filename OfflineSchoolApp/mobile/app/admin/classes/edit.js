import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  StatusBar, Alert, ActivityIndicator, Modal, FlatList,
  KeyboardAvoidingView, ScrollView, Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ClassService } from "../../../src/services/class.service";
import { getTeachersList } from "../../../src/services/assignment.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// Matches Class.js maxlength (100) on the server. Was 50, which rejected
// names the web/desktop console and the server both accept.
const MAX_CLASS_NAME_LENGTH = 100;

export default function EditClass() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams();
  const isMountedRef = useRef(true);
  const inputRef = useRef(null);

  const classId = Array.isArray(params.id) ? params.id[0] : params.id;

  const [className, setClassName] = useState("");
  const [originalName, setOriginalName] = useState("");
  // Level and section, editable like the web/desktop console. The originals
  // are kept so a save that leaves a field untouched sends nothing for it —
  // the server reads an absent level/section as "leave alone".
  const [level,           setLevel]           = useState("");
  const [section,         setSection]         = useState("");
  const [originalLevel,   setOriginalLevel]   = useState(null);
  const [originalSection, setOriginalSection] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState("");

  // The class teacher. `originalTeacherId` is kept so a rename with the
  // picker untouched sends nothing for it — the server reads an absent field
  // as "leave alone" and an empty one as "clear", and this screen used to
  // send neither because it only ever edited the name.
  const [teachers,           setTeachers]           = useState([]);
  const [teacherId,          setTeacherId]          = useState(null);
  const [teacherName,        setTeacherName]        = useState(null);
  const [originalTeacherId,  setOriginalTeacherId]  = useState(null);
  const [pickerOpen,         setPickerOpen]         = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!classId) {
      Alert.alert(t("classesAdmin.errTitle"), t("classesAdmin.errNoId"), [{ text: "OK", onPress: () => router.back() }]);
      return;
    }

    let active = true;

    const loadClass = async () => {
      try {
        const data = await ClassService.getById(classId);
        if (!active || !isMountedRef.current) return;

        if (data?.name) {
          setClassName(data.name);
          setOriginalName(data.name);
          setLevel(data.level ?? "");
          setOriginalLevel(data.level ?? null);
          setSection(data.section ?? "");
          setOriginalSection(data.section ?? "");
          setTeacherId(data.classTeacherId ?? null);
          setTeacherName(data.classTeacherName ?? null);
          setOriginalTeacherId(data.classTeacherId ?? null);
        } else {
          Alert.alert(t("classesAdmin.notFoundTitle"), t("classesAdmin.notFoundBody"), [
            { text: "OK", onPress: () => router.back() },
          ]);
        }
      } catch (err) {
        if (!active || !isMountedRef.current) return;
        console.error("Load class error:", err);
        Alert.alert(t("classesAdmin.errTitle"), t("classesAdmin.errLoadDetails"), [
          { text: "OK", onPress: () => router.back() },
        ]);
      } finally {
        if (active && isMountedRef.current) setLoading(false);
      }
    };

    loadClass();

    // From the local users table, so the picker works with no connection.
    getTeachersList()
      .then((rows) => { if (active && isMountedRef.current) setTeachers(rows ?? []); })
      .catch(() => {});

    return () => { active = false; };
  }, [classId]);

  const validate = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return t("classesAdmin.errNameRequired");
    if (trimmed.length < 2) return t("classesAdmin.errNameShort");
    if (trimmed.length > MAX_CLASS_NAME_LENGTH) {
      return `Class name cannot exceed ${MAX_CLASS_NAME_LENGTH} characters.`;
    }
    if (/^\d+$/.test(trimmed)) return t("classesAdmin.errNameNumeric");
    return "";
  }, [t]);

  const handleChangeText = useCallback((text) => {
    setClassName(text);
    if (fieldError) setFieldError("");
  }, [fieldError]);

  const trimmed = className.trim();
  const trimmedLevel   = level.trim();
  const trimmedSection = section.trim();
  const teacherChanged  = (teacherId ?? null) !== (originalTeacherId ?? null);
  const levelChanged    = trimmedLevel !== (originalLevel ?? "");
  const sectionChanged  = trimmedSection !== originalSection;
  const hasChanges =
    (trimmed !== originalName || teacherChanged || levelChanged || sectionChanged)
    && trimmed.length > 0;
  const isNoChange =
    trimmed === originalName && !teacherChanged && !levelChanged && !sectionChanged
    && trimmed.length > 0;
  const isDisabled = saving || !hasChanges;
  const charCount = trimmed.length;
  const isNearLimit = charCount > MAX_CLASS_NAME_LENGTH - 10;

  const handleSubmit = useCallback(async () => {
    const trimmedValue = className.trim();
    const validationError = validate(trimmedValue);

    if (validationError) {
      setFieldError(validationError);
      inputRef.current?.focus();
      return;
    }

    if (!hasChanges || !classId) return;

    setFieldError("");
    setSaving(true);

    try {
      await ClassService.update(classId, trimmedValue, {
        // Each field present only when it changed — the service omits the
        // rest from the request, and the server leaves them alone.
        ...(levelChanged   ? { level: trimmedLevel || null } : {}),
        ...(sectionChanged ? { section: trimmedSection } : {}),
        // undefined leaves the teacher alone; anything else changes it.
        classTeacher: teacherChanged
          ? (teacherId ? { id: teacherId, name: teacherName } : null)
          : undefined,
      });
      if (!isMountedRef.current) return;

      Alert.alert(t("classesAdmin.updatedTitle"), t("classesAdmin.savedBody", { name: trimmedValue }), [
        { text: t("common.done"), onPress: () => router.back() },
      ]);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err.response?.data?.message || errorText(t, err, "classesAdmin.errUpdate");
      Alert.alert(t("classesAdmin.errTitle"), message);
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [className, validate, hasChanges, classId, t, router, teacherChanged,
      teacherId, teacherName, levelChanged, sectionChanged,
      trimmedLevel, trimmedSection]);

  const handleDiscard = useCallback(() => {
    if (hasChanges) {
      Alert.alert(
        t("classesAdmin.discardTitle"),
        t("classesAdmin.discardBody"),
        [
          { text: t("classesAdmin.keepEditing"), style: "cancel" },
          { text: t("common.discard"), style: "destructive", onPress: () => router.back() },
        ]
      );
    } else {
      router.back();
    }
  }, [hasChanges, router, t]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("classesAdmin.loadingOne")}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity onPress={handleDiscard} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("classesAdmin.editTitle")}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {originalName || t("classesAdmin.editSub")}
          </Text>
        </View>
        {hasChanges && (
          <TouchableOpacity
            onPress={handleSubmit}
            style={styles.headerSaveBtn}
            activeOpacity={0.7}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#4F46E5" />
            ) : (
              <Text style={styles.headerSaveText}>{t("common.save")}</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {originalName ? (
          <View style={styles.originalBanner}>
            <Ionicons name="create-outline" size={16} color="#2563EB" />
            <Text style={styles.originalBannerText}>
              {t("classesAdmin.editingLabel")} <Text style={styles.originalBannerName}>"{originalName}"</Text>
            </Text>
          </View>
        ) : null}

        <View style={styles.formCard}>
          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("classesAdmin.nameLabel")} <Text style={styles.required}>*</Text>
            </Text>

            <View style={[
              styles.inputWrapper,
              fieldError ? styles.inputWrapperError : null,
              hasChanges ? styles.inputWrapperChanged : null,
            ]}>
              <Ionicons
                name="school-outline"
                size={18}
                color={fieldError ? "#DC2626" : hasChanges ? "#4F46E5" : "#9CA3AF"}
                style={styles.inputIcon}
              />
              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder={t("classesAdmin.namePh")}
                placeholderTextColor="#9CA3AF"
                value={className}
                onChangeText={handleChangeText}
                autoCapitalize="words"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                maxLength={MAX_CLASS_NAME_LENGTH + 5}
                editable={!saving}
              />
              {hasChanges && (
                <TouchableOpacity
                  onPress={() => { setClassName(originalName); setFieldError(""); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="refresh-outline" size={18} color="#9CA3AF" />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.fieldFooter}>
              {fieldError ? (
                <View style={styles.fieldErrorRow}>
                  <Ionicons name="alert-circle" size={13} color="#DC2626" />
                  <Text style={styles.fieldErrorText}>{fieldError}</Text>
                </View>
              ) : isNoChange ? (
                <Text style={styles.noChangeHint}>{t("classesAdmin.sameName")}</Text>
              ) : hasChanges ? (
                <Text style={styles.changedHint}>✎ Unsaved changes</Text>
              ) : (
                <Text style={styles.hint}>{t("classesAdmin.nameHint")}</Text>
              )}
              <Text style={[
                styles.charCount,
                isNearLimit && styles.charCountWarning,
                charCount > MAX_CLASS_NAME_LENGTH && styles.charCountError,
              ]}>
                {charCount}/{MAX_CLASS_NAME_LENGTH}
              </Text>
            </View>
          </View>

          {/* ── Level ─────────────────────────────────────────────────── */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>{t("classesAdmin.levelLabel")}</Text>

            <View style={[
              styles.inputWrapper,
              levelChanged ? styles.inputWrapperChanged : null,
            ]}>
              <Ionicons
                name="layers-outline"
                size={18}
                color={levelChanged ? "#4F46E5" : "#9CA3AF"}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                placeholder={t("classesAdmin.levelPh")}
                placeholderTextColor="#9CA3AF"
                value={level}
                onChangeText={setLevel}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                maxLength={100}
                editable={!saving}
              />
            </View>
          </View>

          {/* ── Section ───────────────────────────────────────────────── */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>{t("classesAdmin.sectionLabel")}</Text>

            <View style={[
              styles.inputWrapper,
              sectionChanged ? styles.inputWrapperChanged : null,
            ]}>
              <Ionicons
                name="grid-outline"
                size={18}
                color={sectionChanged ? "#4F46E5" : "#9CA3AF"}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.input}
                placeholder={t("classesAdmin.sectionPh")}
                placeholderTextColor="#9CA3AF"
                value={section}
                onChangeText={setSection}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                maxLength={100}
                editable={!saving}
              />
            </View>
          </View>

          {/* ── Class teacher ──────────────────────────────────────────── */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>{t("classesAdmin.teacherLabel")}</Text>

            <TouchableOpacity
              style={[
                styles.inputWrapper,
                teacherChanged ? styles.inputWrapperChanged : null,
              ]}
              onPress={() => setPickerOpen(true)}
              disabled={saving}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t("classesAdmin.teacherPick")}
            >
              <Ionicons
                name="person-outline"
                size={18}
                color={teacherChanged ? "#4F46E5" : "#9CA3AF"}
                style={styles.inputIcon}
              />
              <Text
                style={[styles.input, !teacherName && styles.inputPlaceholder]}
                numberOfLines={1}
              >
                {teacherName || t("classesAdmin.teacherNone")}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#9CA3AF" />
            </TouchableOpacity>

            <View style={styles.fieldFooter}>
              <Text style={styles.hint}>{t("classesAdmin.teacherHint")}</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.submitButton, isDisabled && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isDisabled}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="save-outline" size={20} color="#FFFFFF" />
              <Text style={styles.submitButtonText}>{t("classesAdmin.saveChanges")}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.discardButton}
          onPress={handleDiscard}
          activeOpacity={0.7}
          disabled={saving}
        >
          <Text style={[styles.discardText, hasChanges && styles.discardTextDanger]}>
            {hasChanges ? t("classesAdmin.discardTitle") : t("common.goBack")}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Class teacher picker ─────────────────────────────────────────── */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
      >
        <TouchableOpacity
          style={styles.pickerBackdrop}
          activeOpacity={1}
          onPress={() => setPickerOpen(false)}
        >
          <TouchableOpacity style={styles.pickerSheet} activeOpacity={1}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>
                {t("classesAdmin.teacherPick")}
              </Text>
              <TouchableOpacity
                onPress={() => setPickerOpen(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {/* "Not assigned" first, so clearing is as easy as choosing. */}
            <FlatList
              data={[{ id: null, name: t("classesAdmin.teacherNone") }, ...teachers]}
              keyExtractor={(item) => String(item.id ?? "__none__")}
              ListEmptyComponent={
                <Text style={styles.pickerEmpty}>
                  {t("classesAdmin.teacherEmpty")}
                </Text>
              }
              renderItem={({ item }) => {
                const selected = (item.id ?? null) === (teacherId ?? null);
                return (
                  <TouchableOpacity
                    style={styles.pickerRow}
                    onPress={() => {
                      setTeacherId(item.id ?? null);
                      setTeacherName(item.id ? item.name : null);
                      setPickerOpen(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={item.id ? "person-circle-outline" : "remove-circle-outline"}
                      size={20}
                      color={selected ? "#4F46E5" : "#9CA3AF"}
                    />
                    <Text
                      style={[styles.pickerRowText, selected && styles.pickerRowTextOn]}
                      numberOfLines={1}
                    >
                      {item.name}
                    </Text>
                    {selected && (
                      <Ionicons name="checkmark" size={18} color="#4F46E5" />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // The class-teacher field renders a chosen value where the name field
  // renders an input, so it borrows inputWrapper and needs a muted variant
  // for the empty state.
  inputPlaceholder: { color: "#9CA3AF" },

  pickerBackdrop: {
    flex:            1,
    backgroundColor: "rgba(17, 24, 39, 0.45)",
    justifyContent:  "flex-end",
  },
  pickerSheet: {
    backgroundColor:     "#FFFFFF",
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    paddingBottom:        28,
    maxHeight:            "70%",
  },
  pickerHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   16,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  pickerTitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  pickerRow: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  pickerRowText:   { flex: 1, fontSize: 15, color: "#374151" },
  pickerRowTextOn: { color: "#4F46E5", fontWeight: "700" },
  pickerEmpty: {
    padding:   24,
    textAlign: "center",
    color:     "#9CA3AF",
    fontSize:  14,
  },

  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  headerSaveBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: "#EEF2FF", borderRadius: 10,
    minWidth: 52, alignItems: "center",
  },
  headerSaveText: { fontSize: 14, fontWeight: "700", color: "#4F46E5" },
  scrollContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },
  originalBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#DBEAFE", padding: 12,
    borderRadius: 10, marginBottom: 16, gap: 8,
  },
  originalBannerText: { fontSize: 13, color: "#1E40AF", fontWeight: "500" },
  originalBannerName: { fontWeight: "700" },
  formCard: {
    backgroundColor: "#FFFFFF", borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  formGroup: { marginBottom: 0 },
  label: { fontSize: 14, fontWeight: "600", color: "#374151", marginBottom: 8 },
  required: { color: "#DC2626", fontWeight: "700" },
  inputWrapper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F9FAFB", borderRadius: 12,
    borderWidth: 1.5, borderColor: "#E5E7EB", paddingHorizontal: 12,
  },
  inputWrapperError: { borderColor: "#DC2626", backgroundColor: "#FFF5F5" },
  inputWrapperChanged: { borderColor: "#4F46E5", backgroundColor: "#FAFAFF" },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: "#111827" },
  fieldFooter: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", marginTop: 6,
  },
  fieldErrorRow: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  fieldErrorText: { fontSize: 12, color: "#DC2626", fontWeight: "500", flex: 1 },
  hint: { fontSize: 12, color: "#9CA3AF", flex: 1 },
  noChangeHint: { fontSize: 12, color: "#9CA3AF", fontStyle: "italic", flex: 1 },
  changedHint: { fontSize: 12, color: "#4F46E5", fontWeight: "600", flex: 1 },
  charCount: { fontSize: 11, color: "#9CA3AF", marginLeft: 8 },
  charCountWarning: { color: "#D97706", fontWeight: "600" },
  charCountError: { color: "#DC2626", fontWeight: "700" },
  submitButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 16, marginTop: 20, gap: 8,
  },
  submitButtonDisabled: { backgroundColor: "#9CA3AF" },
  submitButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  discardButton: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  discardText: { fontSize: 14, color: "#9CA3AF", fontWeight: "500" },
  discardTextDanger: { color: "#EF4444", fontWeight: "600" },
});