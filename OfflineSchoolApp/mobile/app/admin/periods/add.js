// app/admin/periods/add.js

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { PeriodsService } from "../../../src/services/periods.service";
import { useAuthStore } from "../../../src/store/auth.store";

export default function AddPeriod() {
  const { t } = useTranslation();
  const router = useRouter();
  const isMountedRef = useRef(true);
  const schoolId = useAuthStore((s) => s.user?.schoolId);

  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [isBreak, setIsBreak] = useState(false);
  const [saving, setSaving] = useState(false);

  const [errors, setErrors] = useState({});

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const formatTimeInput = (text) => {
    const digits = text.replace(/\D/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  };

  const validate = useCallback(() => {
    const e = {};
    const timeRegex = /^\d{2}:\d{2}$/;

    if (!name.trim()) {
      e.name = t("periodsAdmin.nameRequired");
    } else if (name.trim().length < 2) {
      e.name = t("periodsAdmin.nameTooShort");
    }

    if (!startTime) {
      e.startTime = t("periodsAdmin.startRequired");
    } else if (!timeRegex.test(startTime)) {
      e.startTime = t("periodsAdmin.timeFormatStart");
    }

    if (!endTime) {
      e.endTime = t("periodsAdmin.endRequired");
    } else if (!timeRegex.test(endTime)) {
      e.endTime = t("periodsAdmin.timeFormatEnd");
    }

    if (startTime && endTime && timeRegex.test(startTime) && timeRegex.test(endTime)) {
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) {
        e.endTime = t("periodsAdmin.endAfterStart");
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, startTime, endTime]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    try {
      setSaving(true);
      await PeriodsService.create({
        name: name.trim(),
        startTime,
        endTime,
        isBreak,
        schoolId,
      });

      if (!isMountedRef.current) return;

      Alert.alert(
        t("periodsAdmin.createdTitle"),
        `"${name.trim()}" (${startTime}–${endTime}) has been added.`,
        [
          {
            text: t("periodsAdmin.addAnotherBtn"),
            onPress: () => {
              setName("");
              setStartTime("");
              setEndTime("");
              setIsBreak(false);
              setErrors({});
            },
          },
          {
            text: t("common.done"),
            style: "default",
            onPress: () => router.back(),
          },
        ]
      );
    } catch (err) {
      if (!isMountedRef.current) return;
      Alert.alert(
        t("periodsAdmin.errorTitle"),
        err.response?.data?.message || errorText(t, err, "periodsAdmin.createFailed")
      );
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [validate, name, startTime, endTime, isBreak, schoolId, router]);

  const isDisabled = saving || !name.trim() || !startTime || !endTime;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("periodsAdmin.addTitle")}</Text>
          <Text style={styles.headerSubtitle}>{t("periodsAdmin.addSubtitle")}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.formCard}>

          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("periodsAdmin.periodName")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.inputWrapper, errors.name && styles.inputError]}>
              <Ionicons name="bookmark-outline" size={18} color="#9CA3AF" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t("periodsAdmin.namePh")}
                placeholderTextColor="#9CA3AF"
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  if (errors.name) setErrors((e) => ({ ...e, name: null }));
                }}
                autoCapitalize="words"
                autoFocus
                returnKeyType="next"
                editable={!saving}
              />
            </View>
            {errors.name && <Text style={styles.errorText}>{errors.name}</Text>}
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("periodsAdmin.startTime")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.inputWrapper, errors.startTime && styles.inputError]}>
              <Ionicons name="play-circle-outline" size={18} color="#9CA3AF" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="08:00"
                placeholderTextColor="#9CA3AF"
                value={startTime}
                onChangeText={(v) => {
                  setStartTime(formatTimeInput(v));
                  if (errors.startTime) setErrors((e) => ({ ...e, startTime: null }));
                }}
                keyboardType="numeric"
                maxLength={5}
                returnKeyType="next"
                editable={!saving}
              />
            </View>
            {errors.startTime
              ? <Text style={styles.errorText}>{errors.startTime}</Text>
              : <Text style={styles.hint}>24-hour format — e.g. 08:00 or 13:30</Text>
            }
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("periodsAdmin.endTime")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.inputWrapper, errors.endTime && styles.inputError]}>
              <Ionicons name="stop-circle-outline" size={18} color="#9CA3AF" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="08:45"
                placeholderTextColor="#9CA3AF"
                value={endTime}
                onChangeText={(v) => {
                  setEndTime(formatTimeInput(v));
                  if (errors.endTime) setErrors((e) => ({ ...e, endTime: null }));
                }}
                keyboardType="numeric"
                maxLength={5}
                returnKeyType="done"
                editable={!saving}
              />
            </View>
            {errors.endTime
              ? <Text style={styles.errorText}>{errors.endTime}</Text>
              : <Text style={styles.hint}>{t("periodsAdmin.endHint")}</Text>
            }
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={styles.label}>{t("periodsAdmin.markAsBreak")}</Text>
              <Text style={styles.hint}>
                {t("periodsAdmin.breakHint")}
              </Text>
            </View>
            <Switch
              value={isBreak}
              onValueChange={setIsBreak}
              trackColor={{ false: "#E5E7EB", true: "#A5B4FC" }}
              thumbColor={isBreak ? "#4F46E5" : "#FFFFFF"}
              disabled={saving}
            />
          </View>

        </View>

        {name.trim() && startTime.length === 5 && endTime.length === 5 && (
          <View style={styles.preview}>
            <Ionicons name="eye-outline" size={16} color="#4F46E5" />
            <View style={styles.previewContent}>
              <Text style={styles.previewName}>{name.trim()}</Text>
              <Text style={styles.previewTime}>
                {startTime} – {endTime}
                {isBreak ? " • Break" : ""}
              </Text>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitButton, isDisabled && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={isDisabled}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="add-circle-outline" size={20} color="#FFFFFF" />
              <Text style={styles.submitText}>{t("periodsAdmin.createPeriod")}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.discardButton}
          onPress={() => router.back()}
          disabled={saving}
          activeOpacity={0.7}
        >
          <Text style={styles.discardText}>{t("periodsAdmin.discardBack")}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40, height: 40,
    borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },

  content: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },

  formCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 16,
  },
  formGroup: { marginBottom: 20 },
  label: { fontSize: 14, fontWeight: "600", color: "#374151", marginBottom: 8 },
  required: { color: "#DC2626" },
  hint: { fontSize: 12, color: "#9CA3AF", marginTop: 4 },
  errorText: { fontSize: 12, color: "#DC2626", marginTop: 4, fontWeight: "500" },

  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    paddingHorizontal: 12,
  },
  inputError: { borderColor: "#DC2626", backgroundColor: "#FFF5F5" },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: "#111827" },

  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  switchInfo: { flex: 1, paddingRight: 16 },

  preview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#EEF2FF",
    padding: 14,
    borderRadius: 12,
    marginBottom: 16,
  },
  previewContent: { flex: 1 },
  previewName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  previewTime: { fontSize: 13, color: "#4F46E5", marginTop: 2, fontWeight: "500" },

  submitButton: {
    backgroundColor: "#4F46E5",
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  submitDisabled: { backgroundColor: "#9CA3AF" },
  submitText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },

  discardButton: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  discardText: { fontSize: 14, color: "#9CA3AF", fontWeight: "500" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";