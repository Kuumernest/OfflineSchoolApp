// app/auth/set-password.js

import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";

import { useAuthStore } from "../../src/store/auth.store";
import api from "../../src/services/api";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";
import { errorText } from "../../src/utils/appError";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS & VALIDATION RULES
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_KEY = "auth_token";

// Labels are i18n keys — translated where the list is rendered, because this
// array lives at module scope outside any React component.
const REQUIREMENTS = [
  {
    key: "length",
    labelKey: "setPassword.reqLength",
    test: (p) => p.length >= 8,
  },
  {
    key: "upper",
    labelKey: "setPassword.reqUpper",
    test: (p) => /[A-Z]/.test(p),
  },
  {
    key: "lower",
    labelKey: "setPassword.reqLower",
    test: (p) => /[a-z]/.test(p),
  },
  {
    key: "number",
    labelKey: "setPassword.reqNumber",
    test: (p) => /\d/.test(p),
  },
  {
    key: "special",
    labelKey: "setPassword.reqSpecial",
    test: (p) => /[!@#$%^&*]/.test(p),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — Password Requirement Row
// ─────────────────────────────────────────────────────────────────────────────

const RequirementRow = ({ met, label }) => (
  <View style={reqStyles.row}>
    <Ionicons
      name={met ? "checkmark-circle" : "ellipse-outline"}
      size={16}
      color={met ? "#059669" : "#D1D5DB"}
    />
    <Text style={[reqStyles.label, met && reqStyles.labelMet]}>
      {label}
    </Text>
  </View>
);

const reqStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  label: { fontSize: 13, color: "#9CA3AF" },
  labelMet: { color: "#059669" },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function SetPasswordScreen() {
  const router = useRouter();
  const { t }  = useTranslation();
  const screenPad = useScreenInsets({ top: 24, bottom: 32 });

  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const updateUser = useAuthStore((s) => s.updateUser);
  const logout = useAuthStore((s) => s.logout);

  // Two flows share this screen:
  //   - forced reset: the admin created the account, so there is no current
  //     password to prove and the API waives it;
  //   - settings: the user is changing a password they already know, and the
  //     API requires currentPassword. Sending none 400s.
  const isForcedReset = !!user?.mustResetPassword;

  const [currentPassword, setCurrentPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ── Password strength checks ───────────────────────────────────────────────
  const checks = REQUIREMENTS.map((req) => ({
    ...req,
    met: req.test(newPassword),
  }));

  const allMet = checks.every((c) => c.met);
  const passwordsMatch =
    newPassword === confirmPassword && confirmPassword.length > 0;

  const canSubmit =
    allMet && passwordsMatch && (isForcedReset || currentPassword.length > 0);

  // ── Handle Navigation ──────────────────────────────────────────────────────
  const navigateByRole = useCallback(
    (targetUser) => {
      // A voluntary change should return where it started, not bounce the user
      // to a dashboard they never asked for.
      if (!isForcedReset) {
        router.back();
        return;
      }
      const role = targetUser?.role || user?.role;
      if (role === "teacher") {
        router.replace("/teacher/dashboard");
      } else if (role === "super_admin" || role === "school_admin") {
        router.replace("/admin/dashboard");
      } else {
        router.replace("/");
      }
    },
    [router, user?.role, isForcedReset]
  );

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    setError(null);

    if (!allMet) {
      setError(t("setPassword.meetAll"));
      return;
    }

    if (!passwordsMatch) {
      setError(t("setPassword.notMatchErr"));
      return;
    }

    if (!isForcedReset && !currentPassword) {
      setError(t("setPassword.currentRequired"));
      return;
    }

    setLoading(true);

    try {
      const response = await api.post("/auth/change-password", {
        newPassword,
        confirmPassword,
        // Only waived while mustResetPassword is set; required otherwise.
        ...(isForcedReset ? {} : { currentPassword }),
      });

      if (!response.data?.success) {
        throw new Error(
          response.data?.message || t("setPassword.failed")
        );
      }

      const { token: newToken, user: updatedUser } = response.data;

      // ── Update Auth Store & Secure Storage ─────────────────────────────────
      if (newToken) {
        await SecureStore.setItemAsync(TOKEN_KEY, newToken);
      }

      if (newToken && updatedUser) {
        await setUser(updatedUser, newToken);
      } else if (updatedUser) {
        await updateUser({ ...updatedUser, mustResetPassword: false });
      } else {
        await updateUser({ ...user, mustResetPassword: false });
      }

      const finalUser = updatedUser || user;

      // ── Success Prompt & Safe Navigation ───────────────────────────────────
      Alert.alert(
        t("setPassword.successTitle"),
        t("setPassword.successBody"),
        [
          {
            text: t("setPassword.letsGo"),
            onPress: () => navigateByRole(finalUser),
          },
        ]
      );
    } catch (err) {
      console.error("set-password error:", err.message);
      const msg =
        err?.response?.data?.message ||
        errorText(t, err, "setPassword.genericError");
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [
    allMet,
    passwordsMatch,
    isForcedReset,
    currentPassword,
    newPassword,
    confirmPassword,
    setUser,
    updateUser,
    user,
    navigateByRole,
    t,
  ]);

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(() => {
    Alert.alert(t("setPassword.signOutTitle"), t("setPassword.signOutBody"), [
      { text: t("setPassword.cancel"), style: "cancel" },
      {
        text: t("setPassword.signOut"),
        style: "destructive",
        onPress: async () => {
          await logout();
          router.replace("/auth/login");
        },
      },
    ]);
  }, [logout, router, t]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      // "padding" on Android too. Edge-to-edge stopped the window resizing
      // for the keyboard, so an undefined behaviour left this doing nothing
      // and the field being typed into sat underneath the keys.
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, screenPad]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed" size={32} color="#4F46E5" />
          </View>

          <Text style={styles.title}>
            {isForcedReset
              ? t("setPassword.title")
              : t("setPassword.changeTitle")}
          </Text>

          {isForcedReset ? (
            <Text style={styles.subtitle}>
              {t("setPassword.welcome")}{" "}
              <Text style={styles.name}>{user?.name || "there"}</Text>!
              {"\n"}
              {t("setPassword.subtitle")}
            </Text>
          ) : (
            <Text style={styles.subtitle}>
              {t("setPassword.changeSubtitle")}
            </Text>
          )}
        </View>

        {/* ── Inline Error Banner ── */}
        {!!error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── Form Card ── */}
        <View style={styles.card}>
          {/* Current password - only when there is one to prove */}
          {!isForcedReset && (
            <>
              <Text style={styles.label}>
                {t("setPassword.currentLabel")}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={currentPassword}
                  onChangeText={(v) => {
                    setCurrentPassword(v);
                    setError(null);
                  }}
                  placeholder={t("setPassword.currentPh")}
                  placeholderTextColor="#9CA3AF"
                  secureTextEntry={!showCurrent}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowCurrent((v) => !v)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name={showCurrent ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color="#9CA3AF"
                  />
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* New password */}
          <Text style={[styles.label, !isForcedReset && { marginTop: 16 }]}>
            {t("setPassword.newLabel")}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={newPassword}
              onChangeText={(v) => {
                setNewPassword(v);
                setError(null);
              }}
              placeholder={t("setPassword.newPh")}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showNew}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={styles.eyeBtn}
              onPress={() => setShowNew((v) => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={showNew ? "eye-off-outline" : "eye-outline"}
                size={20}
                color="#9CA3AF"
              />
            </TouchableOpacity>
          </View>

          {/* Requirements List */}
          {newPassword.length > 0 && (
            <View style={styles.requirements}>
              {checks.map((c) => (
                <RequirementRow key={c.key} met={c.met} label={t(c.labelKey)} />
              ))}
            </View>
          )}

          {/* Confirm password */}
          <Text style={[styles.label, { marginTop: 16 }]}>
            {t("setPassword.confirmLabel")}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[
                styles.input,
                confirmPassword.length > 0 &&
                  !passwordsMatch &&
                  styles.inputError,
                confirmPassword.length > 0 &&
                  passwordsMatch &&
                  styles.inputSuccess,
              ]}
              value={confirmPassword}
              onChangeText={(v) => {
                setConfirmPassword(v);
                setError(null);
              }}
              placeholder={t("setPassword.confirmPh")}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={styles.eyeBtn}
              onPress={() => setShowConfirm((v) => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={showConfirm ? "eye-off-outline" : "eye-outline"}
                size={20}
                color="#9CA3AF"
              />
            </TouchableOpacity>
          </View>

          {/* Match Indicator */}
          {confirmPassword.length > 0 && (
            <View style={reqStyles.row}>
              <Ionicons
                name={
                  passwordsMatch ? "checkmark-circle" : "close-circle"
                }
                size={16}
                color={passwordsMatch ? "#059669" : "#DC2626"}
              />
              <Text
                style={[
                  reqStyles.label,
                  { color: passwordsMatch ? "#059669" : "#DC2626" },
                ]}
              >
                {passwordsMatch
                  ? t("setPassword.match")
                  : t("setPassword.mismatch")}
              </Text>
            </View>
          )}
        </View>

        {/* ── Submit Button ── */}
        <TouchableOpacity
          style={[
            styles.submitBtn,
            (!canSubmit || loading) && styles.submitBtnDisabled,
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit || loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <>
              <Ionicons name="lock-closed-outline" size={18} color="#FFF" />
              <Text style={styles.submitBtnText}>
                {isForcedReset
                  ? t("setPassword.submit")
                  : t("setPassword.changeSubmit")}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* ── Security Note ── */}
        <View style={styles.noteBox}>
          <Ionicons
            name="shield-checkmark-outline"
            size={16}
            color="#4F46E5"
          />
          <Text style={styles.noteText}>
            {t("setPassword.securityNote")}
          </Text>
        </View>

        {/* A forced reset offers a way out; a voluntary change, a way back. */}
        <TouchableOpacity
          style={styles.logoutLink}
          onPress={isForcedReset ? handleLogout : () => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isForcedReset ? "log-out-outline" : "arrow-back-outline"}
            size={16}
            color="#9CA3AF"
          />
          <Text style={styles.logoutText}>
            {isForcedReset
              ? t("setPassword.signOutInstead")
              : t("setPassword.cancel")}
          </Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  scroll: { paddingHorizontal: 24 },

  // Header
  header: { alignItems: "center", marginBottom: 32 },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: "#111827",
    textAlign: "center",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 22,
  },
  name: { fontWeight: "700", color: "#111827" },

  // Error Banner
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEF2F2",
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  errorText: { flex: 1, fontSize: 13, color: "#DC2626", fontWeight: "500" },

  // Card
  card: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 24,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
    marginBottom: 20,
  },

  // Fields
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    backgroundColor: "#F9FAFB",
    marginBottom: 12,
  },
  input: {
    flex: 1,
    padding: 13,
    fontSize: 15,
    color: "#111827",
  },
  inputError: { borderColor: "#FCA5A5" },
  inputSuccess: { borderColor: "#6EE7B7" },
  eyeBtn: {
    padding: 12,
    marginRight: 4,
  },

  // Requirements
  requirements: {
    backgroundColor: "#F9FAFB",
    borderRadius: 10,
    padding: 12,
    marginBottom: 4,
  },

  // Submit Button
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#4F46E5",
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: "#4F46E5",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  submitBtnDisabled: {
    backgroundColor: "#A5B4FC",
    shadowOpacity: 0,
    elevation: 0,
  },
  submitBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
  },

  // Security Note
  noteBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#EEF2FF",
    borderRadius: 10,
    padding: 14,
    gap: 8,
    marginBottom: 20,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: "#4338CA",
    lineHeight: 18,
  },

  // Logout Link
  logoutLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 8,
  },
  logoutText: {
    fontSize: 13,
    color: "#9CA3AF",
    fontWeight: "500",
  },
});