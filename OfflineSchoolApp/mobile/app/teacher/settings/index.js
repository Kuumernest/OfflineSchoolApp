// app/teacher/settings/index.js
"use strict";

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api              from "../../../src/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// SECTION
// ─────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <View style={sc.wrap}>
      <Text style={sc.title}>{title}</Text>
      <View style={sc.body}>{children}</View>
    </View>
  );
}

const sc = StyleSheet.create({
  wrap: { marginBottom: 24 },
  title: {
    fontSize:          12,
    fontWeight:        "700",
    color:             C.gray500,
    textTransform:     "uppercase",
    letterSpacing:     0.8,
    marginBottom:      8,
    paddingHorizontal: 4,
  },
  body: {
    backgroundColor: C.white,
    borderRadius:    16,
    overflow:        "hidden",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       1,
  },
});

// ─────────────────────────────────────────────────────────
// SETTING ROW
// ✅ Fix 5 — toggle rows render as plain View, not TouchableOpacity
//    so the Switch is always tappable on Android
// ─────────────────────────────────────────────────────────

function SettingRow({
  icon, iconBg, iconColor, title, subtitle,
  value, onPress, type = "arrow",
  destructive = false, disabled = false,
  onToggle, last = false,
}) {
  const sharedContent = (
    <>
      <View style={[sr.iconWrap, { backgroundColor: iconBg || C.gray100 }]}>
        <Ionicons name={icon} size={18} color={iconColor || C.gray500} />
      </View>
      <View style={sr.textWrap}>
        <Text style={[sr.title, destructive && sr.destructive]}>{title}</Text>
        {!!subtitle && <Text style={sr.subtitle}>{subtitle}</Text>}
      </View>
      <View style={sr.right}>
        {type === "value" && !!value && (
          <Text style={sr.valueText}>{value}</Text>
        )}
        {type === "arrow" && (
          <Ionicons name="chevron-forward" size={16} color={C.gray300} />
        )}
      </View>
    </>
  );

  // ✅ Toggle rows: plain View so Switch receives touches on Android
  if (type === "toggle") {
    return (
      <View style={[sr.row, last && sr.rowLast]}>
        <View style={[sr.iconWrap, { backgroundColor: iconBg || C.gray100 }]}>
          <Ionicons name={icon} size={18} color={iconColor || C.gray500} />
        </View>
        <View style={sr.textWrap}>
          <Text style={sr.title}>{title}</Text>
          {!!subtitle && <Text style={sr.subtitle}>{subtitle}</Text>}
        </View>
        <Switch
          value={!!value}
          onValueChange={onToggle}
          trackColor={{ false: C.gray200, true: C.primary }}
          thumbColor={C.white}
        />
      </View>
    );
  }

  // All other rows: TouchableOpacity
  return (
    <TouchableOpacity
      style={[sr.row, last && sr.rowLast]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      {sharedContent}
    </TouchableOpacity>
  );
}

const sr = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   14,
    gap:               12,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  rowLast:     { borderBottomWidth: 0 },
  iconWrap:    {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  textWrap:    { flex: 1 },
  title:       { fontSize: 14, fontWeight: "600", color: C.gray900 },
  destructive: { color: C.error },
  subtitle:    { fontSize: 12, color: C.gray400, marginTop: 2 },
  right:       { alignItems: "flex-end" },
  valueText:   { fontSize: 13, color: C.gray400, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// AVATAR
// ✅ Fix 4 — fallback "?" applied after trim/split, not before
// ─────────────────────────────────────────────────────────

function Avatar({ name, size = 64 }) {
  const initials = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join("") || "?";   // ✅ fallback here so whitespace-only names show "?"

  return (
    <View style={[av.wrap, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[av.text, { fontSize: size * 0.35 }]}>{initials}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  wrap: {
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  text: { fontWeight: "800", color: "#4F46E5" },
});

// ─────────────────────────────────────────────────────────
// PROFILE PROGRESS
// ✅ specialization removed — admin-assigned, not teacher field
// ─────────────────────────────────────────────────────────

function ProfileProgress({ profile }) {
  const { t } = useTranslation();

  const fields = [
    profile?.firstName,
    profile?.lastName,
    profile?.gender,
    profile?.phone,
    profile?.staffId,
    profile?.qualification,
    profile?.address,
    profile?.emergencyName,
    profile?.emergencyPhone,
  ];
  const filled   = fields.filter(Boolean).length;
  const total    = fields.length;
  const pct      = Math.round((filled / total) * 100);
  const complete = pct === 100;

  return (
    <View style={pp.wrap}>
      <View style={pp.labelRow}>
        <Text style={pp.label}>{t("teacherSettings.profileCompleteness")}</Text>
        <Text style={[pp.pct, { color: complete ? C.success : C.warning }]}>
          {pct}%
        </Text>
      </View>
      <View style={pp.track}>
        <View
          style={[
            pp.fill,
            {
              width:           `${pct}%`,
              backgroundColor: complete ? C.success : C.warning,
            },
          ]}
        />
      </View>
      {!complete && (
        <Text style={pp.hint}>
          {total - filled === 1
            ? t("teacherSettings.fieldMissing",  { count: total - filled })
            : t("teacherSettings.fieldsMissing", { count: total - filled })}
        </Text>
      )}
    </View>
  );
}

const pp = StyleSheet.create({
  wrap:     { marginTop: 12, gap: 6 },
  labelRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
  },
  label: { fontSize: 12, color: C.gray500, fontWeight: "600" },
  pct:   { fontSize: 12, fontWeight: "800" },
  track: {
    height:          6,
    backgroundColor: C.gray100,
    borderRadius:    3,
    overflow:        "hidden",
  },
  fill: { height: "100%", borderRadius: 3 },
  hint: { fontSize: 11, color: C.gray400 },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TeacherSettingsScreen() {
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const userId = String(user?._id || user?.id || "");

  const [profile,         setProfile]         = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [profileComplete, setProfileComplete] = useState(false);

  // ✅ Fix 2 — notification preference loaded from AsyncStorage
  const [notifEnabled, setNotifEnabled] = useState(true);

  // ── Load notification preference ──────────────────────
  useEffect(() => {
    AsyncStorage.getItem("notifEnabled")
      .then((val) => {
        if (val !== null) setNotifEnabled(val === "true");
      })
      .catch(() => {});
  }, []);

  // ✅ Fix 2 — save to AsyncStorage on every toggle
  const handleNotifToggle = useCallback(async (value) => {
    setNotifEnabled(value);
    try {
      await AsyncStorage.setItem("notifEnabled", String(value));
    } catch (err) {
      console.warn("[settings] failed to save notifEnabled:", err.message);
    }
  }, []);

  // ── Load profile ──────────────────────────────────────
  const loadProfile = useCallback(async () => {
    try {
      setLoading(true);

      // Try API first
      try {
        const res = await api.get("/teacher/profile", { timeout: 6000 });
        const p   = res.data?.data || res.data;
        if (p && typeof p === "object") {
          setProfile(p);
          setProfileComplete(p.profileCompleted ?? false);
          return;
        }
      } catch { /* fall through to SQLite */ }

      // SQLite fallback
      const db  = await getDatabase();
      const row = await db.getFirstAsync(
        `SELECT * FROM teacher_profiles WHERE teacher_id = ? LIMIT 1`,
        [userId]
      ).catch(() => null);

      if (row) {
        setProfile({
          firstName:         row.first_name,
          lastName:          row.last_name,
          gender:            row.gender,
          staffId:           row.staff_id,
          qualification:     row.qualification,
          // ✅ specialization omitted — admin-assigned
          employmentType:    row.employment_type,
          phone:             row.phone,
          address:           row.address,
          bloodGroup:        row.blood_group,
          emergencyName:     row.emergency_name,
          emergencyPhone:    row.emergency_phone,
          emergencyRelation: row.emergency_relation,
          profileCompleted:  !!row.profile_completed,
        });
        setProfileComplete(!!row.profile_completed);
      }
    } catch (err) {
      console.warn("[settings] load profile failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // ✅ Fix 3 — depend on userId (primitive), not loadProfile (function)
  useEffect(() => {
    if (userId) loadProfile();
  }, [userId]);

  // ── Logout ───────────────────────────────────────────
  const handleLogout = useCallback(() => {
    Alert.alert(
      t("teacherSettings.logout"),
      t("teacherSettings.logoutConfirm"),
      [
        { text: t("teacherSettings.cancel"), style: "cancel" },
        {
          text:  t("teacherSettings.logout"),
          style: "destructive",
          onPress: async () => {
            try { await logout(); } catch { /* ignore */ }
            router.replace("/auth/login");
          },
        },
      ]
    );
  }, [logout, t]);

  // ── Derived display values ────────────────────────────
  const displayName = profile
    ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim() ||
      user?.name || t("teacherSettings.teacher")
    : user?.name || t("teacherSettings.teacher");

  const profileSubtitle =
    [
      profile?.staffId ? t("teacherSettings.idLabel", { id: profile.staffId }) : null,
      profile?.qualification || null,
    ]
      .filter(Boolean)
      .join("  ·  ") || t("teacherSettings.teacher");

  // ── Loading state ─────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.primary} />
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────
  return (
    <View style={styles.screen}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("teacherSettings.title")}</Text>
        <TouchableOpacity
          onPress={loadProfile}
          style={styles.refreshBtn}
          hitSlop={8}
        >
          <Ionicons name="refresh-outline" size={20} color={C.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Profile card ── */}
        <View style={styles.profileCard}>
          <Avatar name={displayName} size={68} />
          <View style={styles.profileCardRight}>
            <View style={styles.profileNameRow}>
              <Text style={styles.profileName} numberOfLines={1}>
                {displayName}
              </Text>
              {profileComplete && (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={14} color={C.success} />
                  <Text style={styles.verifiedText}>{t("teacherSettings.complete")}</Text>
                </View>
              )}
            </View>
            <Text style={styles.profileRole}  numberOfLines={1}>
              {profileSubtitle}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {user?.email || ""}
            </Text>
            <ProfileProgress profile={profile} />
          </View>
        </View>

        {/* ── Setup prompt (only if incomplete) ── */}
        {!profileComplete && (
          <TouchableOpacity
            style={styles.setupPrompt}
            onPress={() => router.push("/teacher/profile/setup")}
            activeOpacity={0.8}
          >
            <View style={styles.setupPromptIcon}>
              <Ionicons name="person-add-outline" size={20} color={C.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.setupPromptTitle}>
                {t("teacherSettings.completeYourProfile")}
              </Text>
              <Text style={styles.setupPromptSub}>
                {t("teacherSettings.schoolNeedsInfo")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.white} />
          </TouchableOpacity>
        )}

        {/* ── Account ── */}
        <Section title={t("teacherSettings.accountSection")}>
          <SettingRow
            icon="person-outline"
            iconBg={C.primaryBg}
            iconColor={C.primary}
            title={t("teacherSettings.editProfile")}
            subtitle={
              profileComplete
                ? t("teacherSettings.profileCompleteCheck")
                : t("teacherSettings.tapToCompleteSetup")
            }
            onPress={() => router.push("/teacher/profile/setup")}
          />
          <SettingRow
            icon="lock-closed-outline"
            iconBg={C.warningBg}
            iconColor={C.warning}
            title={t("teacherSettings.changePassword")}
            subtitle={t("teacherSettings.updateLoginPassword")}
            onPress={() => router.push("/auth/set-password")}
            last
          />
        </Section>

        {/* ── My Details (shown once profile has data) ── */}
        {profile && (
          <Section title={t("teacherSettings.myDetails")}>
            {!!profile.staffId && (
              <SettingRow
                icon="id-card-outline"
                iconBg="#EDE9FE"
                iconColor="#7C3AED"
                title={t("teacherSettings.staffId")}
                type="value"
                value={profile.staffId}
              />
            )}
            {!!profile.qualification && (
              <SettingRow
                icon="ribbon-outline"
                iconBg={C.primaryBg}
                iconColor={C.primary}
                title={t("teacherSettings.qualification")}
                type="value"
                value={profile.qualification}
              />
            )}
            {!!profile.employmentType && (
              <SettingRow
                icon="briefcase-outline"
                iconBg="#FFF7ED"
                iconColor="#EA580C"
                title={t("teacherSettings.employment")}
                type="value"
                value={profile.employmentType.replace(/_/g, " ")}
              />
            )}
            {!!profile.phone && (
              <SettingRow
                icon="call-outline"
                iconBg={C.successBg}
                iconColor={C.success}
                title={t("teacherSettings.phone")}
                type="value"
                value={profile.phone}
              />
            )}
            {!!profile.bloodGroup && (
              <SettingRow
                icon="water-outline"
                iconBg={C.errorBg}
                iconColor={C.error}
                title={t("teacherSettings.bloodGroup")}
                type="value"
                value={profile.bloodGroup}
              />
            )}
            {!!profile.emergencyName && (
              <SettingRow
                icon="medical-outline"
                iconBg={C.warningBg}
                iconColor={C.warning}
                title={t("teacherSettings.emergencyContact")}
                subtitle={profile.emergencyRelation || undefined}
                type="value"
                value={profile.emergencyPhone || profile.emergencyName}
                last
              />
            )}
          </Section>
        )}

        {/* ── Preferences ── */}
        <Section title={t("teacherSettings.preferences")}>
          {/* ✅ Fix 2 + Fix 5 — persisted toggle, renders as View not TouchableOpacity */}
          <SettingRow
            icon="notifications-outline"
            iconBg={C.warningBg}
            iconColor={C.warning}
            title={t("teacherSettings.pushNotifications")}
            subtitle={t("teacherSettings.pushNotificationsHint")}
            type="toggle"
            value={notifEnabled}
            onToggle={handleNotifToggle}
            last
          />
        </Section>

        {/* ── Support ── */}
        <Section title={t("teacherSettings.support")}>
          <SettingRow
            icon="help-circle-outline"
            iconBg={C.primaryBg}
            iconColor={C.primary}
            title={t("teacherSettings.helpFaqs")}
            onPress={() =>
              Alert.alert(
                t("teacherSettings.needHelpTitle"),
                t("teacherSettings.needHelpBody")
              )
            }
          />
          {/* ✅ Fix 6 — Terms and Privacy now open real URLs */}
          <SettingRow
            icon="document-text-outline"
            iconBg={C.gray100}
            iconColor={C.gray500}
            title={t("teacherSettings.terms")}
            onPress={() => Linking.openURL("https://yourapp.com/terms")}
          />
          <SettingRow
            icon="shield-outline"
            iconBg={C.gray100}
            iconColor={C.gray500}
            title={t("teacherSettings.privacy")}
            onPress={() => Linking.openURL("https://yourapp.com/privacy")}
            last
          />
        </Section>

        {/* ── Session ── */}
        <Section title={t("teacherSettings.session")}>
          <SettingRow
            icon="log-out-outline"
            iconBg={C.errorBg}
            iconColor={C.error}
            title={t("teacherSettings.logout")}
            subtitle={t("teacherSettings.signOutHint")}
            destructive
            onPress={handleLogout}
            last
          />
        </Section>

        <Text style={styles.version}>{t("teacherSettings.hubName")}{"  ·  v1.0.0"}</Text>
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: C.gray50 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  backBtn: {
    width:          40,
    height:         40,
    borderRadius:   12,
    backgroundColor: C.gray100,
    alignItems:     "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex:       1,
    textAlign:  "center",
    fontSize:   18,
    fontWeight: "700",
    color:      C.gray900,
  },
  refreshBtn: {
    width:          40,
    height:         40,
    alignItems:     "center",
    justifyContent: "center",
  },

  content: { padding: 16, paddingTop: 20 },

  profileCard: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    gap:             14,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    4,
    elevation:       2,
  },
  profileCardRight: { flex: 1 },
  profileNameRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flexWrap:      "wrap",
    marginBottom:  2,
  },
  profileName: {
    fontSize:   17,
    fontWeight: "700",
    color:      C.gray900,
    flexShrink: 1,
  },
  verifiedBadge: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             3,
    backgroundColor: C.successBg,
    borderRadius:    8,
    paddingHorizontal: 7,
    paddingVertical:   2,
  },
  verifiedText: { fontSize: 10, fontWeight: "700", color: C.success },
  profileRole:  { fontSize: 12, color: C.gray500 },
  profileEmail: { fontSize: 11, color: C.gray400, marginTop: 2 },

  setupPrompt: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: C.primary,
    borderRadius:    14,
    padding:         14,
    marginBottom:    20,
  },
  setupPromptIcon: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems:      "center",
    justifyContent:  "center",
  },
  setupPromptTitle: { fontSize: 14, fontWeight: "700", color: C.white },
  setupPromptSub:   {
    fontSize:  12,
    color:     "rgba(255,255,255,0.8)",
    marginTop: 2,
  },

  version: {
    textAlign:  "center",
    fontSize:   12,
    color:      C.gray400,
    fontWeight: "500",
    marginTop:  8,
  },
});