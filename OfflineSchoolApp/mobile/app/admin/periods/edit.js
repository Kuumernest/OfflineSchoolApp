// app/admin/periods/edit.js

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
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { PeriodsService } from "../../../src/services/periods.service";

export default function EditPeriod() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const isMountedRef = useRef(true);

  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [isBreak, setIsBreak] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const all = await PeriodsService.getAll(true);
        const period = all.find((p) => p.id === id);

        if (!period) {
          Alert.alert(t("periodsAdmin.errorTitle"), t("periodsAdmin.notFound"), [
            { text: "OK", onPress: () => router.back() },
          ]);
          return;
        }

        if (!isMountedRef.current) return;

        setName(period.name);
        setStartTime(period.startTime);
        setEndTime(period.endTime);
        setIsBreak(period.isBreak);
      } catch (err) {
        console.error("Failed to load period:", err);
        Alert.alert(t("periodsAdmin.errorTitle"), t("periodsAdmin.loadPeriodFailed"));
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    };

    if (id) load();
  }, [id]);

  const formatTimeInput = (text) => {
    const digits = text.replace(/\D/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  };

  const validate = useCallback(() => {
    const e = {};
    const timeRegex = /^\d{2}:\d{2}$/;

    if (!name.trim()) e.name = t("periodsAdmin.nameRequired");
    if (!startTime) e.startTime = t("periodsAdmin.startRequired");
    else if (!timeRegex.test(startTime)) e.startTime = t("periodsAdmin.timeFormat");
    if (!endTime) e.endTime = t("periodsAdmin.endRequired");
    else if (!timeRegex.test(endTime)) e.endTime = t("periodsAdmin.timeFormat");

    if (startTime && endTime && timeRegex.test(startTime) && timeRegex.test(endTime)) {
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) {
        e.endTime = t("periodsAdmin.endAfterStart");
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, t, startTime, endTime]);

  const handleSave = useCallback(async () => {
    if (!validate()) return;

    try {
      setSaving(true);
      await PeriodsService.update(id, {
        name: name.trim(),
        startTime,
        endTime,
        isBreak,
      });

      if (!isMountedRef.current) return;
      Alert.alert(t("periodsAdmin.updatedTitle"), `"${name.trim()}" has been updated.`, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      if (!isMountedRef.current) return;
      Alert.alert(
        t("periodsAdmin.errorTitle"),
        err.response?.data?.message || errorText(t, err, "periodsAdmin.updateFailed")
      );
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [validate, id, name, startTime, endTime, isBreak, t, router]);

  const handleDelete = useCallback(() => {
    Alert.alert(
      t("periodsAdmin.deleteTitle"),
      `Delete "${name}"? This cannot be undone if the period is not used in any timetable.`,
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            try {
              setDeleting(true);
              await PeriodsService.delete(id);
              if (!isMountedRef.current) return;
              router.back();
            } catch (err) {
              if (!isMountedRef.current) return;
              Alert.alert(
                t("periodsAdmin.cannotDelete"),
                errorText(t, err, "periodsAdmin.deleteFailed")
              );
            } finally {
              if (isMountedRef.current) setDeleting(false);
            }
          },
        },
      ]
    );
  }, [id, name, router, t]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("periodsAdmin.loadingPeriod")}</Text>
      </View>
    );
  }

  const isDisabled = saving || deleting || !name.trim() || !startTime || !endTime;

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
          <Text style={styles.headerTitle}>{t("periodsAdmin.editTitle")}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleDelete}
          style={styles.deleteHeaderBtn}
          disabled={deleting || saving}
          activeOpacity={0.7}
        >
          {deleting
            ? <ActivityIndicator size="small" color="#DC2626" />
            : <Ionicons name="trash-outline" size={20} color="#DC2626" />
          }
        </TouchableOpacity>
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
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  if (errors.name) setErrors((e) => ({ ...e, name: null }));
                }}
                autoCapitalize="words"
                editable={!saving && !deleting}
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
                value={startTime}
                onChangeText={(v) => {
                  setStartTime(formatTimeInput(v));
                  if (errors.startTime) setErrors((e) => ({ ...e, startTime: null }));
                }}
                keyboardType="numeric"
                maxLength={5}
                placeholder="08:00"
                placeholderTextColor="#9CA3AF"
                editable={!saving && !deleting}
              />
            </View>
            {errors.startTime && <Text style={styles.errorText}>{errors.startTime}</Text>}
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>
              {t("periodsAdmin.endTime")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.inputWrapper, errors.endTime && styles.inputError]}>
              <Ionicons name="stop-circle-outline" size={18} color="#9CA3AF" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={endTime}
                onChangeText={(v) => {
                  setEndTime(formatTimeInput(v));
                  if (errors.endTime) setErrors((e) => ({ ...e, endTime: null }));
                }}
                keyboardType="numeric"
                maxLength={5}
                placeholder="08:45"
                placeholderTextColor="#9CA3AF"
                editable={!saving && !deleting}
              />
            </View>
            {errors.endTime && <Text style={styles.errorText}>{errors.endTime}</Text>}
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={styles.label}>{t("periodsAdmin.markAsBreak")}</Text>
              <Text style={styles.hint}>{t("periodsAdmin.breakHintShort")}</Text>
            </View>
            <Switch
              value={isBreak}
              onValueChange={setIsBreak}
              trackColor={{ false: "#E5E7EB", true: "#A5B4FC" }}
              thumbColor={isBreak ? "#4F46E5" : "#FFFFFF"}
              disabled={saving || deleting}
            />
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, isDisabled && styles.saveDisabled]}
          onPress={handleSave}
          disabled={isDisabled}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={20} color="#FFFFFF" />
              <Text style={styles.saveText}>{t("periodsAdmin.saveChanges")}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.discardButton}
          onPress={() => router.back()}
          disabled={saving || deleting}
          activeOpacity={0.7}
        >
          <Text style={styles.discardText}>{t("periodsAdmin.discardChanges")}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex: 1, justifyContent: "center",
    alignItems: "center", backgroundColor: "#F9FAFB",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

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
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  deleteHeaderBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#FEE2E2",
    alignItems: "center", justifyContent: "center",
  },

  content: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },

  formCard: {
    backgroundColor: "#FFFFFF", borderRadius: 16,
    padding: 20, borderWidth: 1,
    borderColor: "#E5E7EB", marginBottom: 16,
  },
  formGroup: { marginBottom: 20 },
  label: { fontSize: 14, fontWeight: "600", color: "#374151", marginBottom: 8 },
  required: { color: "#DC2626" },
  hint: { fontSize: 12, color: "#9CA3AF", marginTop: 4 },
  errorText: { fontSize: 12, color: "#DC2626", marginTop: 4, fontWeight: "500" },

  inputWrapper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F9FAFB", borderRadius: 12,
    borderWidth: 1.5, borderColor: "#E5E7EB",
    paddingHorizontal: 12,
  },
  inputError: { borderColor: "#DC2626", backgroundColor: "#FFF5F5" },
  inputIcon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, color: "#111827" },

  switchRow: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", paddingTop: 4,
  },
  switchInfo: { flex: 1, paddingRight: 16 },

  saveButton: {
    backgroundColor: "#4F46E5", borderRadius: 12,
    paddingVertical: 16, flexDirection: "row",
    alignItems: "center", justifyContent: "center", gap: 8,
  },
  saveDisabled: { backgroundColor: "#9CA3AF" },
  saveText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  discardButton: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  discardText: { fontSize: 14, color: "#9CA3AF", fontWeight: "500" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";