import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  StatusBar, Alert, ActivityIndicator,
  KeyboardAvoidingView, ScrollView, Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ClassService } from "../../../src/services/class.service";

const MAX_CLASS_NAME_LENGTH = 50;

export default function EditClass() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const isMountedRef = useRef(true);
  const inputRef = useRef(null);

  const classId = Array.isArray(params.id) ? params.id[0] : params.id;

  const [className, setClassName] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!classId) {
      Alert.alert("Error", "No class ID provided.", [{ text: "OK", onPress: () => router.back() }]);
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
        } else {
          Alert.alert("Not Found", "This class could not be found.", [
            { text: "OK", onPress: () => router.back() },
          ]);
        }
      } catch (err) {
        if (!active || !isMountedRef.current) return;
        console.error("Load class error:", err);
        Alert.alert("Error", "Failed to load class details.", [
          { text: "OK", onPress: () => router.back() },
        ]);
      } finally {
        if (active && isMountedRef.current) setLoading(false);
      }
    };

    loadClass();

    return () => { active = false; };
  }, [classId]);

  const validate = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return "Class name is required.";
    if (trimmed.length < 2) return "Class name must be at least 2 characters.";
    if (trimmed.length > MAX_CLASS_NAME_LENGTH) {
      return `Class name cannot exceed ${MAX_CLASS_NAME_LENGTH} characters.`;
    }
    if (/^\d+$/.test(trimmed)) return "Class name cannot be purely numeric.";
    return "";
  }, []);

  const handleChangeText = useCallback((text) => {
    setClassName(text);
    if (fieldError) setFieldError("");
  }, [fieldError]);

  const trimmed = className.trim();
  const hasChanges = trimmed !== originalName && trimmed.length > 0;
  const isNoChange = trimmed === originalName && trimmed.length > 0;
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
      await ClassService.update(classId, trimmedValue);
      if (!isMountedRef.current) return;

      Alert.alert("Class Updated", `"${trimmedValue}" has been saved successfully.`, [
        { text: "Done", onPress: () => router.back() },
      ]);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err.response?.data?.message || err.message || "Failed to update class.";
      Alert.alert("Error", message);
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [className, classId, hasChanges, validate, router]);

  const handleDiscard = useCallback(() => {
    if (hasChanges) {
      Alert.alert(
        "Discard Changes",
        "You have unsaved changes. Are you sure you want to go back?",
        [
          { text: "Keep Editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: () => router.back() },
        ]
      );
    } else {
      router.back();
    }
  }, [hasChanges, router]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading class…</Text>
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
          <Text style={styles.headerTitle}>Edit Class</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {originalName || "Update class details"}
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
              <Text style={styles.headerSaveText}>Save</Text>
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
              Editing: <Text style={styles.originalBannerName}>"{originalName}"</Text>
            </Text>
          </View>
        ) : null}

        <View style={styles.formCard}>
          <View style={styles.formGroup}>
            <Text style={styles.label}>
              Class Name <Text style={styles.required}>*</Text>
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
                placeholder="e.g. Form 1, Grade 10, Class A"
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
                <Text style={styles.noChangeHint}>This is already the current name.</Text>
              ) : hasChanges ? (
                <Text style={styles.changedHint}>✎ Unsaved changes</Text>
              ) : (
                <Text style={styles.hint}>Use a clear, recognisable name for this class.</Text>
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
              <Text style={styles.submitButtonText}>Save Changes</Text>
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
            {hasChanges ? "Discard Changes" : "Go Back"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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