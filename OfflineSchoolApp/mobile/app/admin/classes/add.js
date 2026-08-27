import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  StatusBar, Alert, KeyboardAvoidingView, ScrollView, Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ClassService } from "../../../src/services/class.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

const MAX_CLASS_NAME_LENGTH = 50;

export default function AddClass() {
  const { t } = useTranslation();
  const router = useRouter();
  const isMountedRef = useRef(true);
  const inputRef = useRef(null);

  const [className, setClassName] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const validate = useCallback((value) => {
    const trimmed = value.trim();
    if (!trimmed) return t("classesAdmin.errNameRequired");
    if (trimmed.length < 2) return t("classesAdmin.errNameShort");
    if (trimmed.length > MAX_CLASS_NAME_LENGTH) {
      return `Class name cannot exceed ${MAX_CLASS_NAME_LENGTH} characters.`;
    }
    if (/^\d+$/.test(trimmed)) return t("classesAdmin.errNameNumeric");
    return "";
  }, []);

  const handleChangeText = useCallback((text) => {
    setClassName(text);
    if (fieldError) setFieldError("");
  }, [fieldError]);

  const handleSubmit = useCallback(async () => {
    const trimmed = className.trim();
    const validationError = validate(trimmed);

    if (validationError) {
      setFieldError(validationError);
      inputRef.current?.focus();
      return;
    }

    setFieldError("");
    setLoading(true);

    try {
      await ClassService.create(trimmed);
      if (!isMountedRef.current) return;

      Alert.alert(t("classesAdmin.createdTitle"), t("classesAdmin.createdBody", { name: trimmed }), [
        {
          text: t("classesAdmin.addAnother"),
          onPress: () => {
            setClassName("");
            setFieldError("");
            inputRef.current?.focus();
          },
        },
        { text: "Done", style: "default", onPress: () => router.back() },
      ]);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err.response?.data?.message || errorText(t, err, "classesAdmin.errCreate");
      Alert.alert(t("classesAdmin.errTitle"), message);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [className, validate, router]);

  const trimmed = className.trim();
  const isDisabled = loading || trimmed.length === 0;
  const charCount = trimmed.length;
  const isNearLimit = charCount > MAX_CLASS_NAME_LENGTH - 10;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("classesAdmin.addTitle")}</Text>
          <Text style={styles.headerSubtitle}>{t("classesAdmin.addSub")}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.formCard}>
          <View style={styles.infoBanner}>
            <Ionicons name="information-circle-outline" size={18} color="#2563EB" />
            <Text style={styles.infoBannerText}>
              {t("classesAdmin.visibilityNote")}
            </Text>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("classesAdmin.nameLabel")} <Text style={styles.required}>*</Text>
            </Text>

            <View style={[styles.inputWrapper, fieldError ? styles.inputWrapperError : null]}>
              <Ionicons
                name="school-outline"
                size={18}
                color={fieldError ? "#DC2626" : "#9CA3AF"}
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
                editable={!loading}
              />
            </View>

            <View style={styles.fieldFooter}>
              {fieldError ? (
                <View style={styles.fieldErrorRow}>
                  <Ionicons name="alert-circle" size={13} color="#DC2626" />
                  <Text style={styles.fieldErrorText}>{fieldError}</Text>
                </View>
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

          <View style={styles.examplesRow}>
            <Text style={styles.examplesLabel}>{t("classesAdmin.examples")} </Text>
            {["classesAdmin.ex1", "classesAdmin.ex2", "classesAdmin.ex3"].map((exKey) => (
              <TouchableOpacity
                key={exKey}
                style={styles.exampleChip}
                onPress={() => { setClassName(t(exKey)); setFieldError(""); }}
                activeOpacity={0.7}
              >
                <Text style={styles.exampleChipText}>{t(exKey)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.submitButton, isDisabled && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isDisabled}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="add-circle" size={20} color="#FFFFFF" />
              <Text style={styles.submitButtonText}>{t("classesAdmin.createBtn")}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.discardButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
          disabled={loading}
        >
          <Text style={styles.discardText}>{t("classesAdmin.discardGoBack")}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
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
  scrollContent: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 },
  formCard: {
    backgroundColor: "#FFFFFF", borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  infoBanner: {
    flexDirection: "row", alignItems: "flex-start",
    backgroundColor: "#DBEAFE", padding: 12,
    borderRadius: 10, marginBottom: 20, gap: 8,
  },
  infoBannerText: {
    flex: 1, fontSize: 13, color: "#1E40AF",
    fontWeight: "500", lineHeight: 18,
  },
  formGroup: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: "600", color: "#374151", marginBottom: 8 },
  required: { color: "#DC2626", fontWeight: "700" },
  inputWrapper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F9FAFB", borderRadius: 12,
    borderWidth: 1.5, borderColor: "#E5E7EB", paddingHorizontal: 12,
  },
  inputWrapperError: { borderColor: "#DC2626", backgroundColor: "#FFF5F5" },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: "#111827" },
  fieldFooter: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", marginTop: 6,
  },
  fieldErrorRow: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  fieldErrorText: { fontSize: 12, color: "#DC2626", fontWeight: "500", flex: 1 },
  hint: { fontSize: 12, color: "#9CA3AF", flex: 1 },
  charCount: { fontSize: 11, color: "#9CA3AF", marginLeft: 8 },
  charCountWarning: { color: "#D97706", fontWeight: "600" },
  charCountError: { color: "#DC2626", fontWeight: "700" },
  examplesRow: {
    flexDirection: "row", alignItems: "center",
    flexWrap: "wrap", gap: 8, marginTop: 4,
  },
  examplesLabel: { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },
  exampleChip: {
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
  },
  exampleChipText: { fontSize: 12, color: "#4F46E5", fontWeight: "600" },
  submitButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 16, marginTop: 20, gap: 8,
  },
  submitButtonDisabled: { backgroundColor: "#9CA3AF" },
  submitButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  discardButton: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  discardText: { fontSize: 14, color: "#9CA3AF", fontWeight: "500" },
});