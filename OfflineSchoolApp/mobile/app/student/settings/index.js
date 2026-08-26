// app/student/settings/index.js
"use strict";

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Image,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api, { API_URL } from "../../../src/services/api";
import { API }          from "../../../src/services/apiEndpoints";
import { useTranslation } from "../../../src/i18n/useTranslation";
import * as ImagePicker from "expo-image-picker";

// ─────────────────────────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <View style={sc.wrap}>
      <Text style={sc.title}>{title}</Text>
      <View style={sc.body}>{children}</View>
    </View>
  );
}

const sc = StyleSheet.create({
  wrap:  { marginBottom: 24 },
  title: {
    fontSize: 12, fontWeight: "700", color: C.gray500,
    textTransform: "uppercase", letterSpacing: 0.8,
    marginBottom: 8, paddingHorizontal: 4,
  },
  body: {
    backgroundColor: C.white, borderRadius: 16, overflow: "hidden",
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 1,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SETTING ROW
// ─────────────────────────────────────────────────────────────────────────────

function SettingRow({
  icon, iconBg, iconColor, title, subtitle,
  value, onPress, type = "arrow",
  destructive = false, disabled = false, onToggle, last = false,
}) {
  return (
    <TouchableOpacity
      style={[sr.row, last && sr.rowLast]}
      onPress={type !== "toggle" ? onPress : undefined}
      disabled={disabled || type === "toggle"}
      activeOpacity={0.7}
    >
      <View style={[sr.iconWrap, { backgroundColor: iconBg || C.gray100 }]}>
        <Ionicons name={icon} size={18} color={iconColor || C.gray500} />
      </View>
      <View style={sr.textWrap}>
        <Text style={[sr.title, destructive && sr.destructive]}>{title}</Text>
        {!!subtitle && <Text style={sr.subtitle}>{subtitle}</Text>}
      </View>
      <View style={sr.right}>
        {type === "toggle" && (
          <Switch
            value={!!value}
            onValueChange={onToggle}
            trackColor={{ false: C.gray200, true: C.primary }}
            thumbColor={C.white}
          />
        )}
        {type === "value" && !!value && (
          <Text style={sr.valueText} numberOfLines={2}>{value}</Text>
        )}
        {type === "arrow" && (
          <Ionicons name="chevron-forward" size={16} color={C.gray300} />
        )}
      </View>
    </TouchableOpacity>
  );
}

const sr = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 14, gap: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  rowLast:     { borderBottomWidth: 0 },
  iconWrap:    { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  textWrap:    { flex: 1 },
  title:       { fontSize: 14, fontWeight: "600", color: C.gray900 },
  destructive: { color: C.error },
  subtitle:    { fontSize: 12, color: C.gray400, marginTop: 2 },
  right:       { alignItems: "flex-end", maxWidth: "45%" },
  valueText:   { fontSize: 13, color: C.gray400, fontWeight: "500", textAlign: "right" },
});

// ─────────────────────────────────────────────────────────────────────────────
// AVATAR
// ─────────────────────────────────────────────────────────────────────────────

function Avatar({ name, size = 64 }) {
  const initials = (name || "S")
    .trim().split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase()).slice(0, 2).join("");

  return (
    <View style={[av.wrap, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[av.text, { fontSize: size * 0.35 }]}>{initials || "?"}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  wrap: { backgroundColor: C.primaryBg, alignItems: "center", justifyContent: "center" },
  text: { fontWeight: "800", color: C.primary },
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE PROGRESS
// ─────────────────────────────────────────────────────────────────────────────

function ProfileProgress({ profile }) {
  const { t } = useTranslation();

  const fields = [
    profile?.firstName,
    profile?.lastName,
    profile?.gender,
    profile?.dateOfBirth,
    profile?.phone,
    profile?.address,
    profile?.guardianName,
    profile?.guardianPhone,
  ];
  const filled   = fields.filter(Boolean).length;
  const total    = fields.length;
  const pct      = Math.round((filled / total) * 100);
  const complete = pct === 100;

  return (
    <View style={pp.wrap}>
      <View style={pp.labelRow}>
        <Text style={pp.label}>{t("studentSettings.profileCompleteness")}</Text>
        <Text style={[pp.pct, { color: complete ? C.success : C.warning }]}>{pct}%</Text>
      </View>
      <View style={pp.track}>
        <View
          style={[
            pp.fill,
            { width: `${pct}%`, backgroundColor: complete ? C.success : C.warning },
          ]}
        />
      </View>
      {!complete && (
        <Text style={pp.hint}>
          {total - filled === 1
            ? t("studentSettings.fieldMissing",  { count: total - filled })
            : t("studentSettings.fieldsMissing", { count: total - filled })}
        </Text>
      )}
    </View>
  );
}

const pp = StyleSheet.create({
  wrap:     { marginTop: 12, gap: 6 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label:    { fontSize: 12, color: C.gray500, fontWeight: "600" },
  pct:      { fontSize: 12, fontWeight: "800" },
  track:    { height: 6, backgroundColor: C.gray100, borderRadius: 3, overflow: "hidden" },
  fill:     { height: "100%", borderRadius: 3 },
  hint:     { fontSize: 11, color: C.gray400 },
});

// ─────────────────────────────────────────────────────────────────────────────
// INFO BADGE
// ─────────────────────────────────────────────────────────────────────────────

function InfoBadge({ label, value, color, bg }) {
  if (!value) return null;
  return (
    <View style={[ib.wrap, { backgroundColor: bg }]}>
      <Text style={[ib.text, { color }]}>
        {label ? `${label}: ` : ""}{value}
      </Text>
    </View>
  );
}

const ib = StyleSheet.create({
  wrap: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 8, marginRight: 6, marginBottom: 4,
  },
  text: { fontSize: 11, fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE PASSWORD MODAL
// Self-contained — no separate screen needed.
// Handles the first-login forced change: mustResetPassword accounts may set a
// new password without supplying the random one issued at enrollment.
// ─────────────────────────────────────────────────────────────────────────────

function ChangePasswordModal({ visible, onClose, mustReset }) {
  const updateUser = useAuthStore((s) => s.updateUser);
  const { t }      = useTranslation();

  const [current,     setCurrent]     = useState("");
  const [next,        setNext]        = useState("");
  const [confirm,     setConfirm]     = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext,    setShowNext]    = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState(null);

  // Reset fields when the modal opens
  useEffect(() => {
    if (visible) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
    }
  }, [visible]);

  const handleSave = async () => {
    setError(null);

    if (!current.trim()) {
      setError(t("studentSettings.errCurrentRequired"));
      return;
    }
    if (next.length < 8) {
      setError(t("studentSettings.errMinLength"));
      return;
    }
    if (next !== confirm) {
      setError(t("studentSettings.errMismatch"));
      return;
    }
    if (next === current) {
      setError(t("studentSettings.errSameAsCurrent"));
      return;
    }

    try {
      setSaving(true);

      const res = await api.post(API.auth.changePassword, {
        currentPassword: current.trim(),
        newPassword:     next.trim(),
      });

      const updatedUser = res.data?.user;
      if (updatedUser) {
        await updateUser(updatedUser);
      }

      Alert.alert(
        t("studentSettings.pwdChangedTitle"),
        t("studentSettings.pwdChangedBody"),
        [{ text: t("studentSettings.ok"), onPress: onClose }]
      );
    } catch (err) {
      const msg =
        err?.response?.data?.message ||
        err?.message                 ||
        t("studentSettings.errChangeFailed");
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={saving ? undefined : onClose}
    >
      <KeyboardAvoidingView
        style={cp.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={cp.sheet}>
          {/* Handle */}
          <View style={cp.handle} />

          {/* Header */}
          <View style={cp.header}>
            <View style={{ flex: 1 }}>
              <Text style={cp.title}>{t("studentSettings.changePassword")}</Text>
              <Text style={cp.subtitle}>
                {mustReset
                  ? t("studentSettings.mustSetNewPassword")
                  : t("studentSettings.updateLoginPasswordBelow")}
              </Text>
            </View>
            {!mustReset && (
              <TouchableOpacity
                onPress={onClose}
                disabled={saving}
                style={cp.closeBtn}
                activeOpacity={0.7}
              >
                <Ionicons name="close" size={20} color={C.gray500} />
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            contentContainerStyle={cp.body}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* First-login guidance. The first password is randomly generated
                (shown once at enrollment / sent by email) — NOT the enrollment
                number, so there is nothing useful to echo here. */}

            {/* Error */}
            {!!error && (
              <View style={cp.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={C.error} />
                <Text style={cp.errorText}>{error}</Text>
              </View>
            )}

            {/* Current password */}
            <Text style={cp.label}>{t("studentSettings.currentPassword")}</Text>
            <View style={cp.inputRow}>
              <TextInput
                style={cp.input}
                value={current}
                onChangeText={setCurrent}
                // No default-password hint here — the first password is a
                // random value issued at enrollment, never the enrollment no.
                placeholder={t("studentSettings.enterCurrentPassword")}
                placeholderTextColor={C.gray400}
                secureTextEntry={!showCurrent}
                autoCapitalize="none"
                editable={!saving}
              />
              <TouchableOpacity
                style={cp.eyeBtn}
                onPress={() => setShowCurrent((v) => !v)}
              >
                <Ionicons
                  name={showCurrent ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color={C.gray400}
                />
              </TouchableOpacity>
            </View>

            {/* New password */}
            <Text style={cp.label}>{t("studentSettings.newPassword")}</Text>
            <View style={cp.inputRow}>
              <TextInput
                style={cp.input}
                value={next}
                onChangeText={setNext}
                placeholder={t("studentSettings.min8Chars")}
                placeholderTextColor={C.gray400}
                secureTextEntry={!showNext}
                autoCapitalize="none"
                editable={!saving}
              />
              <TouchableOpacity
                style={cp.eyeBtn}
                onPress={() => setShowNext((v) => !v)}
              >
                <Ionicons
                  name={showNext ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color={C.gray400}
                />
              </TouchableOpacity>
            </View>

            {/* Strength indicator */}
            {next.length > 0 && (
              <PasswordStrength password={next} />
            )}

            {/* Confirm */}
            <Text style={cp.label}>{t("studentSettings.confirmNewPassword")}</Text>
            <View style={cp.inputRow}>
              <TextInput
                style={cp.input}
                value={confirm}
                onChangeText={setConfirm}
                placeholder={t("studentSettings.reenterNewPassword")}
                placeholderTextColor={C.gray400}
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                editable={!saving}
              />
              <TouchableOpacity
                style={cp.eyeBtn}
                onPress={() => setShowConfirm((v) => !v)}
              >
                <Ionicons
                  name={showConfirm ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color={C.gray400}
                />
              </TouchableOpacity>
            </View>

            {/* Match indicator */}
            {confirm.length > 0 && (
              <Text
                style={[
                  cp.matchText,
                  { color: next === confirm ? C.success : C.error },
                ]}
              >
                {next === confirm
                  ? t("studentSettings.passwordsMatch")
                  : t("studentSettings.passwordsNoMatch")}
              </Text>
            )}

            {/* Save button */}
            <TouchableOpacity
              style={[cp.saveBtn, saving && cp.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving}
              activeOpacity={0.8}
            >
              {saving ? (
                <ActivityIndicator color={C.white} size="small" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color={C.white} />
                  <Text style={cp.saveBtnText}>{t("studentSettings.saveNewPassword")}</Text>
                </>
              )}
            </TouchableOpacity>

            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Password strength meter ────────────────────────────────────────────────

function PasswordStrength({ password }) {
  const { t } = useTranslation();

  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score  = checks.filter(Boolean).length;
  const labels = [
    t("studentSettings.strengthTooShort"),
    t("studentSettings.strengthWeak"),
    t("studentSettings.strengthFair"),
    t("studentSettings.strengthGood"),
    t("studentSettings.strengthStrong"),
  ];
  const colors = [C.error, C.error, C.warning, C.warning, C.success];

  return (
    <View style={ps.wrap}>
      <View style={ps.bars}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={[
              ps.bar,
              { backgroundColor: i < score ? colors[score] : C.gray200 },
            ]}
          />
        ))}
      </View>
      <Text style={[ps.label, { color: colors[score] }]}>
        {labels[score]}
      </Text>
    </View>
  );
}

const ps = StyleSheet.create({
  wrap:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  bars:  { flex: 1, flexDirection: "row", gap: 4 },
  bar:   { flex: 1, height: 4, borderRadius: 2 },
  label: { fontSize: 11, fontWeight: "700", width: 52, textAlign: "right" },
});

const cp = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(17,24,39,0.5)", justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: "90%", paddingTop: 10,
  },
  handle: {
    width: 44, height: 5, borderRadius: 99,
    backgroundColor: C.gray200, alignSelf: "center", marginBottom: 14,
  },
  header: {
    flexDirection: "row", alignItems: "flex-start",
    paddingHorizontal: 20, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
    marginBottom: 4,
  },
  title:    { fontSize: 20, fontWeight: "700", color: C.gray900 },
  subtitle: { fontSize: 13, color: C.gray500, marginTop: 2 },
  closeBtn: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: C.gray100, alignItems: "center", justifyContent: "center",
  },
  body: { paddingHorizontal: 20, paddingTop: 16 },

  hintBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    backgroundColor: "#EEF2FF", borderRadius: 10, padding: 12, marginBottom: 16,
  },
  hintText: { flex: 1, fontSize: 13, color: "#3730A3", lineHeight: 18 },
  hintBold: { fontWeight: "700", letterSpacing: 0.5 },

  errorBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.errorBg, borderRadius: 10, padding: 12, marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 13, color: C.error, fontWeight: "500" },

  label: {
    fontSize: 12, fontWeight: "700", color: C.gray700,
    marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4,
  },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1.5, borderColor: C.gray200, borderRadius: 12,
    backgroundColor: C.gray50, marginBottom: 16, overflow: "hidden",
  },
  input: {
    flex: 1, paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: C.gray900,
  },
  eyeBtn: { paddingHorizontal: 12 },

  matchText: { fontSize: 12, fontWeight: "600", marginTop: -10, marginBottom: 16 },

  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: C.primary, borderRadius: 14,
    paddingVertical: 15, marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: C.white, fontSize: 16, fontWeight: "700" },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentSettingsScreen() {
  const { t }      = useTranslation();
  const user       = useAuthStore((s) => s.user);
  const logout     = useAuthStore((s) => s.logout);
  const updateUser = useAuthStore((s) => s.updateUser);

  const userId = String(user?._id || user?.id || "");

  const [profile,          setProfile]          = useState(null);
  const [loading,          setLoading]          = useState(true);
  const [profileComplete,  setProfileComplete]  = useState(false);
  const [notifEnabled,     setNotifEnabled]     = useState(true);
  const [showChangePwd,    setShowChangePwd]    = useState(false);
  const [photoUrl,         setPhotoUrl]         = useState(null);
  const [photoBusy,        setPhotoBusy]        = useState(false);

  // mustResetPassword drives the forced-change flow
  const mustReset    = user?.mustResetPassword === true;

  // ── Photo ────────────────────────────────────────────────────────────────

  /** Stored as a path; the card and this screen need a full URL. */
  const absolutePhoto = (value) => {
    if (!value) return null;
    if (/^(https?:|data:|file:)/i.test(value)) return value;
    return `${API_URL}${value.startsWith("/") ? "" : "/"}${value}`.replace("/api/", "/");
  };

  const pickPhoto = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          t("studentSettings.permissionNeededTitle"),
          t("studentSettings.permissionNeededBody")
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        // Passport proportions, so what is cropped here is what the card prints
        // rather than being re-cropped later into something unflattering.
        aspect: [3, 4],
        quality: 0.7,
        base64: true,
      });

      if (result.canceled || !result.assets?.[0]?.base64) return;

      setPhotoBusy(true);
      const res = await api.put("/students/photo", {
        photoBase64: result.assets[0].base64,
      });
      const url = res.data?.data?.photoUrl ?? res.data?.photoUrl ?? null;
      setPhotoUrl(url);
    } catch (err) {
      // The server's message names the real problem — too large, not an image —
      // so it is shown rather than replaced with something generic.
      Alert.alert(
        t("studentSettings.photoSaveFailedTitle"),
        err?.response?.data?.message || err.message || t("studentSettings.tryAgain")
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = () => {
    Alert.alert(
      t("studentSettings.removePhotoTitle"),
      t("studentSettings.removePhotoBody"),
      [
      { text: t("studentSettings.cancel"), style: "cancel" },
      {
        text: t("studentSettings.remove"), style: "destructive",
        onPress: async () => {
          setPhotoBusy(true);
          try {
            await api.delete("/students/photo");
            setPhotoUrl(null);
          } catch (err) {
            Alert.alert(t("studentSettings.photoRemoveFailedTitle"), err.message);
          } finally {
            setPhotoBusy(false);
          }
        },
      },
      ]
    );
  };

  // ── Load profile ─────────────────────────────────────────────────────────

  const loadProfile = useCallback(async () => {
    try {
      setLoading(true);

      // ── Try API ────────────────────────────────────────────────────────
      try {
        const res = await api.get(API.student.profile, { timeout: 6000 });
        const p   = res.data?.data || res.data?.student || res.data;
        if (p && typeof p === "object" && !p.error) {
          setProfile(p);
          setPhotoUrl(p.photoUrl ?? null);
          setProfileComplete(p.profileCompleted ?? false);

          // Keep the store's enrollmentNo fresh if the API returned it
          if (p.enrollmentNo && !user?.enrollmentNo) {
            await updateUser({ enrollmentNo: p.enrollmentNo });
          }
          return;
        }
      } catch (apiErr) {
        if (apiErr?.response?.status !== 404) {
          console.warn("[student/settings] API error:", apiErr.message);
        }
      }

      // ── Fallback: SQLite student_profiles ─────────────────────────────
      const db  = await getDatabase();
      const row = await db.getFirstAsync(
        `SELECT * FROM student_profiles WHERE student_id = ? LIMIT 1`,
        [userId]
      ).catch(() => null);

      if (row) {
        const p = {
          firstName:        row.first_name,
          lastName:         row.last_name,
          gender:           row.gender,
          dateOfBirth:      row.date_of_birth,
          placeOfBirth:     row.place_of_birth,
          nationalId:       row.national_id,
          phone:            row.phone,
          alternatePhone:   row.alternate_phone,
          address:          row.address,
          city:             row.city,
          state:            row.state,
          guardianName:     row.guardian_name,
          guardianPhone:    row.guardian_phone,
          guardianRelation: row.guardian_relation,
          guardianEmail:    row.guardian_email,
          // Enrollment / admission fields
          enrollmentNo:     row.enrollment_no || row.enrollmentNo || row.admission_no,
          admissionNo:      row.admission_no  || row.enrollmentNo,
          className:        row.class_name,
          grade:            row.grade,
          bloodGroup:       row.blood_group,
          medicalConditions:row.medical_conditions,
          isRepeating:      row.is_repeating,
          bio:              row.bio,
          profileCompleted: !!row.profile_completed,
        };
        setProfile(p);
        setProfileComplete(!!row.profile_completed);
        return;
      }

      // ── Last resort: students table ────────────────────────────────────
      const studentRow = await db.getFirstAsync(
        `SELECT * FROM students WHERE userId = ? OR user_id = ? LIMIT 1`,
        [userId, userId]
      ).catch(() => null);

      if (studentRow) {
        const nameParts = (
          studentRow.studentName || studentRow.student_name || ""
        ).split(" ");

        setProfile({
          firstName:    studentRow.firstName || studentRow.first_name || nameParts[0] || "",
          lastName:     studentRow.lastName  || studentRow.last_name  || nameParts.slice(1).join(" ") || "",
          enrollmentNo: studentRow.enrollmentNo || studentRow.enrollment_no || null,
          admissionNo:  studentRow.admissionNo  || studentRow.admission_no  || "",
          className:    studentRow.className    || studentRow.class_name    || "",
          grade:        studentRow.grade        || "",
          phone:        studentRow.phone        || "",
          guardianName: studentRow.guardianName  || studentRow.guardian_name  || "",
          guardianPhone:studentRow.guardianPhone || studentRow.guardian_phone || "",
          profileCompleted: false,
        });
      }
    } catch (err) {
      console.warn("[student/settings] load failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadProfile();
  }, [loadProfile]);

  // ── Auto-open the change-password modal when mustResetPassword is true ──
  useEffect(() => {
    if (!loading && mustReset) {
      setShowChangePwd(true);
    }
  }, [loading, mustReset]);

  // ── Logout ────────────────────────────────────────────────────────────────

  const handleLogout = () => {
    Alert.alert(t("studentSettings.logout"), t("studentSettings.logoutConfirm"), [
      { text: t("studentSettings.cancel"), style: "cancel" },
      {
        text: t("studentSettings.logout"), style: "destructive",
        onPress: async () => {
          try { await logout(); } catch { /* ignore */ }
          router.replace("/auth/login");
        },
      },
    ]);
  };

  // ── Derived display values ────────────────────────────────────────────────

  const displayName = profile
    ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
    : user?.name || t("studentSettings.student");

  const resolvedEnrollmentNo =
    user?.enrollmentNo ||
    profile?.enrollmentNo ||
    profile?.admissionNo  ||
    null;

  const profileSubtitle = [
    profile?.className   ? t("studentSettings.classLabel", { name: profile.className })      : null,
    resolvedEnrollmentNo ? t("studentSettings.noLabel",    { number: resolvedEnrollmentNo }) : null,
  ].filter(Boolean).join("  ·  ") || t("studentSettings.student");

  const fullAddress = [
    profile?.address,
    profile?.city,
    profile?.state,
  ].filter(Boolean).join(", ") || null;

  const genderDisplay = profile?.gender
    ? profile.gender.charAt(0).toUpperCase() + profile.gender.slice(1)
    : null;

  const isRepeating =
    profile?.isRepeating === true  ||
    profile?.isRepeating === 1     ||
    profile?.isRepeating === "1";

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.primary} />
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.screen}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("studentSettings.title")}</Text>
        <TouchableOpacity
          onPress={loadProfile}
          style={styles.refreshBtn}
          hitSlop={8}
        >
          <Ionicons name="refresh-outline" size={20} color={C.primary} />
        </TouchableOpacity>
      </View>

      {/* ── Must-reset banner ── */}
      {mustReset && (
        <TouchableOpacity
          style={styles.mustResetBanner}
          onPress={() => setShowChangePwd(true)}
          activeOpacity={0.85}
        >
          <Ionicons name="warning-outline" size={18} color="#92400E" />
          <Text style={styles.mustResetText}>
            {t("studentSettings.mustChangeBanner")}{" "}
            <Text style={styles.mustResetLink}>{t("studentSettings.tapHere")}</Text>
          </Text>
        </TouchableOpacity>
      )}

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >

        {/* ── PROFILE CARD ── */}
        <View style={styles.profileCard}>
          <Avatar name={displayName} size={68} />
          <View style={styles.profileCardRight}>
            <View style={styles.profileNameRow}>
              <Text style={styles.profileName} numberOfLines={1}>
                {displayName || t("studentSettings.yourName")}
              </Text>
              {profileComplete && (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={14} color={C.success} />
                  <Text style={styles.verifiedText}>{t("studentSettings.complete")}</Text>
                </View>
              )}
            </View>
            <Text style={styles.profileRole} numberOfLines={1}>
              {profileSubtitle}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {user?.email || ""}
            </Text>

            {/* Quick info badges */}
            <View style={styles.badgeRow}>
              {isRepeating && (
                <InfoBadge
                  label={t("studentSettings.statusLabel")}
                  value={t("studentSettings.repeating")}
                  color={C.warning} bg={C.warningBg}
                />
              )}
              {!!profile?.bloodGroup && (
                <InfoBadge
                  label={t("studentSettings.bloodLabel")}
                  value={profile.bloodGroup}
                  color={C.error} bg={C.errorBg}
                />
              )}
              {!!genderDisplay && (
                <InfoBadge label="" value={genderDisplay} color={C.primary} bg={C.primaryBg} />
              )}
            </View>

            <ProfileProgress profile={profile} />
          </View>
        </View>

        {/* ── SETUP PROMPT ── */}
        {!profileComplete && (
          <TouchableOpacity
            style={styles.setupPrompt}
            onPress={() => router.push("/student/profile/setup")}
            activeOpacity={0.8}
          >
            <View style={styles.setupPromptIcon}>
              <Ionicons name="person-add-outline" size={20} color={C.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.setupPromptTitle}>
                {t("studentSettings.completeYourProfile")}
              </Text>
              <Text style={styles.setupPromptSub}>
                {t("studentSettings.schoolNeedsInfo")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.white} />
          </TouchableOpacity>
        )}

        {/* ── PHOTO ──
            This is the picture that goes on the student's ID card, which is
            why it sits at the top of their own settings rather than being
            something only the office can set. */}
        <Section title={t("studentSettings.photoSection")}>
          <View style={styles.photoRow}>
            <View style={styles.photoFrame}>
              {photoUrl ? (
                <Image source={{ uri: absolutePhoto(photoUrl) }} style={styles.photoImg} />
              ) : (
                <Ionicons name="person" size={34} color="#9AA3B2" />
              )}
            </View>

            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.photoTitle}>{t("studentSettings.idCardPhoto")}</Text>
              <Text style={styles.photoHint}>
                {t("studentSettings.idCardPhotoHint")}
              </Text>

              <View style={styles.photoBtns}>
                <TouchableOpacity
                  style={[styles.photoBtn, photoBusy && styles.photoBtnOff]}
                  onPress={pickPhoto}
                  disabled={photoBusy}
                  activeOpacity={0.85}
                >
                  {photoBusy
                    ? <ActivityIndicator color="#fff" size="small" />
                    : (
                      <Text style={styles.photoBtnText}>
                        {photoUrl
                          ? t("studentSettings.changePhoto")
                          : t("studentSettings.addPhoto")}
                      </Text>
                    )}
                </TouchableOpacity>

                {photoUrl && !photoBusy && (
                  <TouchableOpacity
                    style={styles.photoBtnGhost}
                    onPress={removePhoto}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.photoBtnGhostText}>{t("studentSettings.remove")}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </Section>

        {/* ── ACCOUNT ── */}
        <Section title={t("studentSettings.accountSection")}>
          <SettingRow
            icon="person-outline" iconBg={C.primaryBg} iconColor={C.primary}
            title={t("studentSettings.editProfile")}
            subtitle={
              profileComplete
                ? t("studentSettings.profileCompleteCheck")
                : t("studentSettings.tapToCompleteSetup")
            }
            type="arrow"
            onPress={() => router.push("/student/profile/setup")}
          />
          <SettingRow
            icon="lock-closed-outline" iconBg="#FEF3C7" iconColor={C.warning}
            title={t("studentSettings.changePassword")}
            subtitle={
              mustReset
                ? t("studentSettings.passwordChangeRequired")
                : t("studentSettings.updateLoginPassword")
            }
            type="arrow"
            onPress={() => setShowChangePwd(true)}
            last
          />
        </Section>

        {/* ── ENROLLMENT NUMBER (read-only) ── */}
        {!!resolvedEnrollmentNo && (
          <Section title={t("studentSettings.loginCredentials")}>
            <View style={styles.enrollmentNote}>
              <Ionicons name="information-circle-outline" size={14} color="#4338CA" />
              <Text style={styles.enrollmentNoteText}>
                {t("studentSettings.enrollmentNote")}
              </Text>
            </View>
            <SettingRow
              icon="id-card-outline" iconBg="#EDE9FE" iconColor="#7C3AED"
              title={t("studentSettings.enrollmentNumber")}
              subtitle={t("studentSettings.uniqueLoginId")}
              type="value"
              value={resolvedEnrollmentNo}
              disabled
              last
            />
          </Section>
        )}

        {/* ── PERSONAL DETAILS ── */}
        {profile && (
          <Section title={t("studentSettings.personalDetails")}>
            {!!genderDisplay && (
              <SettingRow
                icon="person-outline" iconBg={C.primaryBg} iconColor={C.primary}
                title={t("studentSettings.gender")} type="value" value={genderDisplay}
              />
            )}
            {!!profile.dateOfBirth && (
              <SettingRow
                icon="calendar-outline" iconBg={C.gray100} iconColor={C.gray500}
                title={t("studentSettings.dateOfBirth")} type="value" value={profile.dateOfBirth}
              />
            )}
            {!!profile.placeOfBirth && (
              <SettingRow
                icon="location-outline" iconBg="#DBEAFE" iconColor="#2563EB"
                title={t("studentSettings.placeOfBirth")} type="value" value={profile.placeOfBirth}
              />
            )}
            {!!profile.nationalId && (
              <SettingRow
                icon="card-outline" iconBg={C.gray100} iconColor={C.gray500}
                title={t("studentSettings.nationalId")} type="value" value={profile.nationalId}
              />
            )}
            {!!profile.bloodGroup && (
              <SettingRow
                icon="water-outline" iconBg={C.errorBg} iconColor={C.error}
                title={t("studentSettings.bloodGroup")} type="value" value={profile.bloodGroup}
              />
            )}
            {!!profile.bio && (
              <SettingRow
                icon="document-text-outline" iconBg={C.gray100} iconColor={C.gray500}
                title={t("studentSettings.aboutMe")} type="value" value={profile.bio}
                last={!profile.medicalConditions && !isRepeating}
              />
            )}
            {!!profile.medicalConditions && (
              <SettingRow
                icon="medical-outline" iconBg={C.errorBg} iconColor={C.error}
                title={t("studentSettings.healthMedical")}
                subtitle={t("studentSettings.healthMedicalHint")}
                type="value" value={profile.medicalConditions}
                last={!isRepeating}
              />
            )}
            {isRepeating && (
              <SettingRow
                icon="repeat-outline" iconBg={C.warningBg} iconColor={C.warning}
                title={t("studentSettings.academicStatus")} type="value"
                value={t("studentSettings.repeating")}
                last
              />
            )}
          </Section>
        )}

        {/* ── CONTACT & ADDRESS ── */}
        {profile && (profile.phone || profile.alternatePhone || fullAddress) && (
          <Section title={t("studentSettings.contactAddress")}>
            {!!profile.phone && (
              <SettingRow
                icon="call-outline" iconBg={C.successBg} iconColor={C.success}
                title={t("studentSettings.phone")} type="value" value={profile.phone}
              />
            )}
            {!!profile.alternatePhone && (
              <SettingRow
                icon="call-outline" iconBg={C.gray100} iconColor={C.gray500}
                title={t("studentSettings.alternatePhone")} type="value" value={profile.alternatePhone}
              />
            )}
            {!!fullAddress && (
              <SettingRow
                icon="home-outline" iconBg="#DBEAFE" iconColor="#2563EB"
                title={t("studentSettings.address")} type="value" value={fullAddress}
                last
              />
            )}
          </Section>
        )}

        {/* ── GUARDIAN / PARENT ── */}
        {profile && (profile.guardianName || profile.guardianPhone) && (
          <Section title={t("studentSettings.guardianParent")}>
            {!!profile.guardianName && (
              <SettingRow
                icon="people-outline" iconBg="#FFF7ED" iconColor="#EA580C"
                title={t("studentSettings.guardianName")}
                subtitle={
                  profile.guardianRelation
                    ? profile.guardianRelation.charAt(0).toUpperCase() +
                      profile.guardianRelation.slice(1)
                    : undefined
                }
                type="value" value={profile.guardianName}
              />
            )}
            {!!profile.guardianPhone && (
              <SettingRow
                icon="call-outline" iconBg="#FFF7ED" iconColor="#EA580C"
                title={t("studentSettings.guardianPhone")} type="value" value={profile.guardianPhone}
              />
            )}
            {!!profile.guardianEmail && (
              <SettingRow
                icon="mail-outline" iconBg="#FFF7ED" iconColor="#EA580C"
                title={t("studentSettings.guardianEmail")} type="value" value={profile.guardianEmail}
                last
              />
            )}
          </Section>
        )}

        {/* ── SCHOOL INFO (read-only) ── */}
        {profile && (profile.admissionNo || profile.className || profile.grade) && (
          <Section title={t("studentSettings.schoolInfo")}>
            <View style={styles.schoolInfoNote}>
              <Ionicons name="information-circle-outline" size={14} color={C.gray400} />
              <Text style={styles.schoolInfoNoteText}>
                {t("studentSettings.schoolInfoNote")}
              </Text>
            </View>
            {!!profile.admissionNo && (
              <SettingRow
                icon="id-card-outline" iconBg="#EDE9FE" iconColor="#7C3AED"
                title={t("studentSettings.admissionNo")} type="value" value={profile.admissionNo}
                disabled
              />
            )}
            {!!profile.className && (
              <SettingRow
                icon="school-outline" iconBg={C.primaryBg} iconColor={C.primary}
                title={t("studentSettings.classTitle")} type="value" value={profile.className}
                disabled
              />
            )}
            {!!profile.grade && profile.grade !== profile.className && (
              <SettingRow
                icon="ribbon-outline" iconBg={C.successBg} iconColor={C.success}
                title={t("studentSettings.gradeYear")} type="value" value={profile.grade}
                disabled last
              />
            )}
          </Section>
        )}

        {/* ── PREFERENCES ── */}
        <Section title={t("studentSettings.preferences")}>
          <SettingRow
            icon="notifications-outline" iconBg="#FEF3C7" iconColor={C.warning}
            title={t("studentSettings.pushNotifications")}
            subtitle={t("studentSettings.pushNotificationsHint")}
            type="toggle" value={notifEnabled} onToggle={setNotifEnabled} last
          />
        </Section>

        {/* ── SUPPORT ── */}
        <Section title={t("studentSettings.support")}>
          <SettingRow
            icon="help-circle-outline" iconBg={C.primaryBg} iconColor={C.primary}
            title={t("studentSettings.helpFaqs")} type="arrow"
            onPress={() =>
              Alert.alert(
                t("studentSettings.needHelpTitle"),
                t("studentSettings.needHelpBody")
              )
            }
          />
          <SettingRow
            icon="document-text-outline" iconBg={C.gray100} iconColor={C.gray500}
            title={t("studentSettings.terms")} type="arrow" onPress={() => {}}
          />
          <SettingRow
            icon="shield-outline" iconBg={C.gray100} iconColor={C.gray500}
            title={t("studentSettings.privacy")} type="arrow" onPress={() => {}} last
          />
        </Section>

        {/* ── SESSION ── */}
        <Section title={t("studentSettings.session")}>
          <SettingRow
            icon="log-out-outline" iconBg={C.errorBg} iconColor={C.error}
            title={t("studentSettings.logout")}
            subtitle={t("studentSettings.signOutHint")}
            type="arrow" destructive onPress={handleLogout} last
          />
        </Section>

        <Text style={styles.version}>{t("studentSettings.hubName")}{"  ·  v1.0.0"}</Text>
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* ── Change Password Modal ── */}
      <ChangePasswordModal
        visible={showChangePwd}
        onClose={() => setShowChangePwd(false)}
        mustReset={mustReset}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  photoRow:   { flexDirection: "row", gap: 14, alignItems: "flex-start", padding: 4 },
  photoFrame: {
    width: 72, height: 96, borderRadius: 8,
    borderWidth: 2, borderColor: "#3B4996", backgroundColor: "#F0F4FF",
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  photoImg:   { width: "100%", height: "100%" },
  photoTitle: { fontSize: 14, fontWeight: "700", color: "#0D1220" },
  photoHint:  { marginTop: 2, fontSize: 12, color: "#4F5A70", lineHeight: 17 },
  photoBtns:  { flexDirection: "row", gap: 8, marginTop: 10 },
  photoBtn: {
    minWidth: 96, height: 36, borderRadius: 8, backgroundColor: "#3B4996",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 14,
  },
  photoBtnOff:  { opacity: 0.5 },
  photoBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  photoBtnGhost: {
    height: 36, borderRadius: 8, borderWidth: 1, borderColor: "#D5D9E2",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 14,
  },
  photoBtnGhostText: { color: "#4F5A70", fontSize: 13, fontWeight: "600" },

  screen:   { flex: 1, backgroundColor: C.gray50 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: C.gray100, alignItems: "center", justifyContent: "center",
  },
  headerTitle: {
    flex: 1, textAlign: "center",
    fontSize: 18, fontWeight: "700", color: C.gray900,
  },
  refreshBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },

  // ── Must-reset banner ─────────────────────────────────────────────────────
  mustResetBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.warningBg,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#FDE68A",
  },
  mustResetText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  mustResetLink: { fontWeight: "700", textDecorationLine: "underline" },

  content: { padding: 16, paddingTop: 20 },

  // ── Profile card ──────────────────────────────────────────────────────────
  profileCard: {
    flexDirection: "row", alignItems: "flex-start",
    backgroundColor: C.white, borderRadius: 16,
    padding: 16, marginBottom: 16, gap: 14,
    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  profileCardRight:  { flex: 1 },
  profileNameRow: {
    flexDirection: "row", alignItems: "center",
    gap: 8, flexWrap: "wrap", marginBottom: 2,
  },
  profileName:    { fontSize: 17, fontWeight: "700", color: C.gray900, flexShrink: 1 },
  verifiedBadge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: C.successBg, borderRadius: 8,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  verifiedText:  { fontSize: 10, fontWeight: "700", color: C.success },
  profileRole:   { fontSize: 12, color: C.gray500 },
  profileEmail:  { fontSize: 11, color: C.gray400, marginTop: 2 },
  badgeRow:      { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },

  // ── Setup prompt ──────────────────────────────────────────────────────────
  setupPrompt: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: C.primary, borderRadius: 14,
    padding: 14, marginBottom: 20,
  },
  setupPromptIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  setupPromptTitle: { fontSize: 14, fontWeight: "700", color: C.white },
  setupPromptSub:   { fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 2 },

  // ── Enrollment number section ─────────────────────────────────────────────
  enrollmentNote: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: "#EEF2FF",
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  enrollmentNoteText: { fontSize: 11, color: "#4338CA", flex: 1 },

  // ── School info note ──────────────────────────────────────────────────────
  schoolInfoNote: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: C.gray50,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  schoolInfoNoteText: { fontSize: 11, color: C.gray400, flex: 1 },

  version: {
    textAlign: "center", fontSize: 12,
    color: C.gray400, fontWeight: "500", marginTop: 8,
  },
});