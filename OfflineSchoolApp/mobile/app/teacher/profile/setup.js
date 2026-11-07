// app/teacher/profile/setup.js
"use strict";

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  StatusBar,
  Modal,
} from "react-native";
import { router }               from "expo-router";
import { Ionicons }             from "@expo/vector-icons";
import { useAuthStore }         from "../../../src/store/auth.store";
import { getDatabase }          from "../../../src/db/database";
import TeacherProfile           from "../../../src/services/teacherProfile.service";
import DateField                from "../../../src/components/DateField";
// ✅ FIX: correct relative path — file lives at src/utils/withRetry.js
//    not app/utils/withRetry.js
import { withRetry }            from "../../../src/utils/withRetry";
import api                      from "../../../src/services/api";
import { useTranslation }       from "../../../src/i18n/useTranslation";
import { loadOwnStaffNo }       from "../../../src/services/staffNumber.service";
import { staffNoText }          from "../../../src/utils/staffNumber";
import { needsInternetFailureText } from "../../../src/hooks/useNeedsInternet";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────
// A teacher's own profile is violet, the teachers' colour everywhere.
const C = {
  primary:   ACCENT.violet.solid,
  primaryBg: ACCENT.violet.wash,
  primaryDeep: ACCENT.violet.deep,
  primaryEdge: ACCENT.violet.base,
  success:   ACCENT.green.solid,
  successBg: SEMANTIC.success.bg,
  warning:   COLORS.warning,
  warningBg: SEMANTIC.warning.bg,
  error:     COLORS.danger,
  errorBg:   SEMANTIC.error.bg,
  info:      SEMANTIC.info.icon,
  white:     COLORS.surface,
  gray50:    COLORS.page,
  gray100:   ACCENT.slate.wash,
  gray200:   COLORS.border,
  gray300:   COLORS.textMuted,
  gray400:   COLORS.textMuted,
  gray500:   COLORS.textSecondary,
  gray700:   COLORS.text,
  gray900:   COLORS.text,
};


// ─────────────────────────────────────────────────────────
// STEPS
// ─────────────────────────────────────────────────────────
const STEPS = [
  { id: "personal",     icon: "person-outline",    titleKey: "profileTeacher.stepPersonal",     descKey: "profileTeacher.stepPersonalDesc"     },
  { id: "professional", icon: "briefcase-outline", titleKey: "profileTeacher.stepProfessional", descKey: "profileTeacher.stepProfessionalDesc" },
  { id: "contact",      icon: "call-outline",      titleKey: "profileTeacher.stepContact",      descKey: "profileTeacher.stepContactDesc"      },
  { id: "emergency",    icon: "medical-outline",   titleKey: "profileTeacher.stepEmergency",    descKey: "profileTeacher.stepEmergencyDesc"    },
];

// ─────────────────────────────────────────────────────────
// FIELD
// ─────────────────────────────────────────────────────────
function Field({
  label, value, onChangeText, placeholder,
  keyboardType = "default", multiline = false,
  required = false, error, icon, editable = true, hint,
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={f.wrap}>
      <Text style={f.label}>
        {label}{required && <Text style={f.required}> *</Text>}
      </Text>
      <View style={[
        f.inputWrap,
        focused   && f.inputFocused,
        !!error   && f.inputError,
        !editable && f.inputDisabled,
      ]}>
        {!!icon && (
          <Ionicons
            name={icon}
            size={18}
            color={focused ? C.primary : C.gray400}
            style={f.icon}
          />
        )}
        <TextInput
          style={[f.input, multiline && f.inputMulti]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={C.gray400}
          keyboardType={keyboardType}
          multiline={multiline}
          numberOfLines={multiline ? 3 : 1}
          editable={editable}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCorrect={false}
        />
      </View>
      {!!hint  && !error && <Text style={f.hint}>{hint}</Text>}
      {!!error            && <Text style={f.errorText}>{error}</Text>}
    </View>
  );
}

const f = StyleSheet.create({
  wrap:          { marginBottom: 16 },
  label:         { fontSize: 13, fontWeight: "600", color: C.gray700, marginBottom: 6 },
  required:      { color: C.error },
  inputWrap:     { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderColor: C.gray200, borderRadius: 12, backgroundColor: C.white, paddingHorizontal: 12 },
  inputFocused:  { borderColor: C.primary },
  inputError:    { borderColor: C.error },
  inputDisabled: { backgroundColor: C.gray50, opacity: 0.7 },
  icon:          { marginRight: 8 },
  input:         { flex: 1, fontSize: 14, color: C.gray900, paddingVertical: 12 },
  inputMulti:    { height: 80, textAlignVertical: "top", paddingTop: 12 },
  hint:          { fontSize: 11, color: COLORS.textSubtle, marginTop: 4 },
  errorText:     { fontSize: 11, color: C.error, marginTop: 4, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────────────────────
function SelectField({ label, value, options, onSelect, required, error }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <View style={sf.wrap}>
      <Text style={sf.label}>
        {label}{required && <Text style={{ color: C.error }}> *</Text>}
      </Text>
      <TouchableOpacity
        style={[sf.selector, !!error && sf.selectorError]}
        onPress={() => setOpen((p) => !p)}
        activeOpacity={0.7}
      >
        <Text style={[sf.selectorText, !selected && sf.placeholder]}>
          {selected?.label || t("profileTeacher.selectPlaceholder", { label })}
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={C.gray400} />
      </TouchableOpacity>
      {open && (
        <View style={sf.dropdown}>
          {options.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[sf.option, opt.value === value && sf.optionActive]}
              onPress={() => { onSelect(opt.value); setOpen(false); }}
              activeOpacity={0.7}
            >
              <Text style={[sf.optionText, opt.value === value && sf.optionTextActive]}>
                {opt.label}
              </Text>
              {opt.value === value && (
                <Ionicons name="checkmark" size={16} color={C.primary} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
      {!!error && <Text style={sf.errorText}>{error}</Text>}
    </View>
  );
}

const sf = StyleSheet.create({
  wrap:             { marginBottom: 16 },
  label:            { fontSize: 13, fontWeight: "600", color: C.gray700, marginBottom: 6 },
  selector:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1.5, borderColor: C.gray200, borderRadius: 12, backgroundColor: C.white, paddingHorizontal: 12, paddingVertical: 12 },
  selectorError:    { borderColor: C.error },
  selectorText:     { fontSize: 14, color: C.gray900, flex: 1 },
  placeholder:      { color: C.gray400 },
  dropdown:         { borderWidth: 1, borderColor: C.gray200, borderRadius: 12, backgroundColor: C.white, marginTop: 4, shadowColor: COLORS.shadow, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4, zIndex: 999 },
  option:           { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  optionActive:     { backgroundColor: C.primaryBg, borderWidth: 1, borderColor: C.primaryEdge },
  optionText:       { fontSize: 14, color: C.gray700 },
  optionTextActive: { color: C.primaryDeep, fontWeight: "600" },
  errorText:        { fontSize: 11, color: C.error, marginTop: 4, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// OPTION LISTS
// ─────────────────────────────────────────────────────────

/** Options carry a translation key; labels are resolved at render time. */
const withLabels = (options, t) =>
  options.map((o) => ({ value: o.value, label: t(o.labelKey) }));

const GENDERS = [
  { value: "male",   labelKey: "profileTeacher.genderMale"   },
  { value: "female", labelKey: "profileTeacher.genderFemale" },
  { value: "other",  labelKey: "profileTeacher.genderOther"  },
];

const EMPLOYMENT_TYPES = [
  { value: "full_time",  labelKey: "profileTeacher.empFullTime"   },
  { value: "part_time",  labelKey: "profileTeacher.empPartTime"   },
  { value: "contract",   labelKey: "profileTeacher.empContract"   },
  { value: "substitute", labelKey: "profileTeacher.empSubstitute" },
  { value: "volunteer",  labelKey: "profileTeacher.empVolunteer"  },
];

const QUALIFICATION_LEVELS = [
  { value: "diploma",   labelKey: "profileTeacher.qualDiploma"   },
  { value: "bachelors", labelKey: "profileTeacher.qualBachelors" },
  { value: "pgde",      labelKey: "profileTeacher.qualPgde"      },
  { value: "masters",   labelKey: "profileTeacher.qualMasters"   },
  { value: "phd",       labelKey: "profileTeacher.qualPhd"       },
  { value: "other",     labelKey: "profileTeacher.qualOther"     },
];

const BLOOD_GROUPS = [
  { value: "A+",  label: "A+"  }, { value: "A-",  label: "A-"  },
  { value: "B+",  label: "B+"  }, { value: "B-",  label: "B-"  },
  { value: "AB+", label: "AB+" }, { value: "AB-", label: "AB-" },
  { value: "O+",  label: "O+"  }, { value: "O-",  label: "O-"  },
];

// ─────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────

const validateStep = (step, form, t) => {
  const errors = {};
  if (step === 0) {
    if (!form.firstName?.trim())   errors.firstName   = t("profileTeacher.errFirstName");
    if (!form.lastName?.trim())    errors.lastName    = t("profileTeacher.errLastName");
    if (!form.gender)              errors.gender      = t("profileTeacher.errGender");
    if (!form.dateOfBirth?.trim()) errors.dateOfBirth = t("profileTeacher.errDob");
    if (!form.nationalId?.trim())  errors.nationalId  = t("profileTeacher.errNationalId");
  }
  if (step === 1) {
    if (!form.qualification)     errors.qualification  = t("profileTeacher.errQualification");
    if (!form.employmentType)    errors.employmentType = t("profileTeacher.errEmploymentType");
    if (!form.joinDate?.trim())  errors.joinDate       = t("profileTeacher.errJoinDate");
  }
  if (step === 2) {
    if (!form.phone?.trim())   errors.phone   = t("profileTeacher.errPhone");
    if (!form.address?.trim()) errors.address = t("profileTeacher.errAddress");
    if (
      form.email?.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)
    ) errors.email = t("profileTeacher.errEmail");
  }
  if (step === 3) {
    if (!form.emergencyName?.trim())     errors.emergencyName     = t("profileTeacher.errEmergencyName");
    if (!form.emergencyPhone?.trim())    errors.emergencyPhone    = t("profileTeacher.errEmergencyPhone");
    if (!form.emergencyRelation?.trim()) errors.emergencyRelation = t("profileTeacher.errRelation");
  }
  return errors;
};

// ─────────────────────────────────────────────────────────
// SAVE PROFILE
// ─────────────────────────────────────────────────────────

const saveProfile = async (form, userId) => {
  const fullName = `${form.firstName?.trim() || ""} ${form.lastName?.trim() || ""}`.trim();

  const payload = {
    name:              fullName,
    firstName:         form.firstName?.trim(),
    lastName:          form.lastName?.trim(),
    gender:            form.gender,
    dateOfBirth:       form.dateOfBirth?.trim(),
    nationalId:        form.nationalId?.trim(),
    staffId:           form.staffId?.trim(),
    qualification:     form.qualification,
    employmentType:    form.employmentType,
    joinDate:          form.joinDate?.trim(),
    yearsOfExperience: form.yearsOfExperience?.trim(),
    previousSchool:    form.previousSchool?.trim(),
    phone:             form.phone?.trim(),
    alternatePhone:    form.alternatePhone?.trim(),
    address:           form.address?.trim(),
    city:              form.city?.trim(),
    state:             form.state?.trim(),
    emergencyName:     form.emergencyName?.trim(),
    emergencyPhone:    form.emergencyPhone?.trim(),
    emergencyRelation: form.emergencyRelation?.trim(),
    bloodGroup:        form.bloodGroup,
    medicalConditions: form.medicalConditions?.trim(),
    bio:               form.bio?.trim(),
    profileCompleted:  true,
  };

  // ── API save with retry ───────────────────────────────
  // Online-only on the server side: nothing queues it. Reported back so the
  // screen can say "saved on this phone only" instead of pretending.
  let serverSaved = false;
  try {
    await withRetry(
      () => api.put("/teacher/profile", payload, { timeout: 10_000 }),
      3,
      1_000
    );
    serverSaved = true;
  } catch (err) {
    console.warn("[profile/setup] API save failed:", err.message);
    // Non-fatal — SQLite save below is the source of truth on device
  }

  /*
   * ── SQLite save — the one that matters ──────────────────────────────────
   *
   * On a phone with no signal this IS the save; the API call above is the
   * optimistic half. So it throws on failure rather than warning, and the
   * caller keeps the form open.
   *
   * It used to write to `teacher_profiles`, which belongs to the attendance
   * directory and has five columns — none of them teacher_id. Every save on
   * every device failed with "table teacher_profiles has no column named
   * teacher_id". The teacher's own record now has its own table; see
   * src/services/teacherProfile.service.js.
   */
  try {
    await TeacherProfile.saveLocal(userId, { ...payload, profileCompleted: true });

    console.log("✅ teacher profile saved locally");

    // Update display name in users table
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
      [fullName, new Date().toISOString(), userId]
    ).catch(() => {});

    /*
     * The settings_profile write that used to sit here is gone, and was a
     * second instance of the same bug: settings.service.js creates that table
     * as (id, name, email, role, schoolId, updated_at) keyed by id='me', and
     * this inserted (user_id, profile_completed) into it. It could only ever
     * fail — and it was wrapped in .catch(() => {}), so it failed on every
     * save for the life of the feature without one line in the log.
     *
     * "Is the profile complete?" now has one home, the profile_completed
     * column on the record itself.
     */
  } catch (err) {
    console.warn("[profile/setup] SQLite save error:", err.message);
    throw err;
  }

  // Not reached the server: queued, so it is sent when the phone is next
  // online (and counts as unsent work until it is). It used to be dropped.
  if (!serverSaved) {
    await TeacherProfile.queueUpload(userId, { ...payload, profileCompleted: true }, fullName)
      .catch((err) => console.warn("[profile/setup] could not queue the profile:", err.message));
  }
  return { serverSaved };
};

// ─────────────────────────────────────────────────────────
// CHECK IF TEACHER PROFILE IS COMPLETE
// Exported — used by the teacher dashboard guard.
// ─────────────────────────────────────────────────────────

export const isTeacherProfileComplete = async (userId) => {
  if (!userId) return false;

  // ── 1. Check store first — fastest path ──────────────
  const storeComplete = useAuthStore.getState().profileCompleted;
  if (storeComplete) return true;

  // ── 2. API check (only if we have a token) ────────────
  // ✅ FIX: removed the erroneous second `withRetry` call that was
  //    copy-pasted from the usage example in the previous response.
  //    That dead code declared a new `res` variable after the first
  //    `res` was already used, referenced an undefined `body` variable,
  //    and would throw a ReferenceError at runtime.
  try {
    const { token } = useAuthStore.getState();
    if (token && token !== "offline_mode") {
      // The server's copy merged with this phone's: saves what the server
      // adds, and queues a profile that so far lives only on this phone —
      // which is how a profile saved before the server stored them gets there.
      const { profile } = await TeacherProfile.loadProfile(userId, { api });
      if (profile?.profileCompleted) return true;
    }
  } catch { /* fall through to SQLite */ }

  /*
   * ── 3. SQLite fallback ────────────────────────────────────────────────
   *
   * Both queries here read tables whose schema did not match, behind
   * .catch(() => null) — so this always returned false offline, and a teacher
   * who had completed the form was asked to complete it again on every
   * launch. Silently: a swallowed schema error looks exactly like an empty
   * table.
   */
  try {
    if (await TeacherProfile.isCompleteLocal(userId)) return true;
  } catch { /* ignore */ }

  return false;
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function TeacherProfileSetup() {
  const { t }               = useTranslation();
  const user                = useAuthStore((s) => s.user);
  const updateUser          = useAuthStore((s) => s.updateUser);
  const setProfileCompleted = useAuthStore((s) => s.setProfileCompleted);

  const userId = String(user?._id || user?.id || "");

  const [step,   setStep]   = useState(0);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  // The school's staff number: issued by the server, shown read-only. It
  // replaced the "Staff ID" a teacher used to type here, which the server
  // never stored. Whatever an older build typed stays in form.staffId (and
  // the local teacher_profiles.staff_id column) untouched, but is not shown.
  const [staffNo, setStaffNo] = useState({ kind: "none", value: null });
  useEffect(() => {
    let live = true;
    loadOwnStaffNo(user).then((s) => { if (live) setStaffNo(s); }).catch(() => {});
    return () => { live = false; };
  }, [user]);

  const [form, setForm] = useState({
    firstName:         user?.name?.split(" ")[0]                 || "",
    lastName:          user?.name?.split(" ").slice(1).join(" ") || "",
    gender:            "",
    dateOfBirth:       "",
    nationalId:        "",
    staffId:           "",
    qualification:     "",
    employmentType:    "full_time",
    joinDate:          "",
    yearsOfExperience: "",
    previousSchool:    "",
    phone:             user?.phone || "",
    alternatePhone:    "",
    email:             user?.email || "",
    address:           "",
    city:              "",
    state:             "",
    emergencyName:     "",
    emergencyPhone:    "",
    emergencyRelation: "",
    bloodGroup:        "",
    medicalConditions: "",
    bio:               "",
  });

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  // ── Load existing profile ─────────────────────────────
  useEffect(() => {
    const loadExisting = async () => {
      // The server's copy merged with this phone's, field by field. It used
      // to take the server's reply alone — a reply that carried no profile —
      // and blank every field whenever the phone was online.
      try {
        const { profile } = await TeacherProfile.loadProfile(userId, { api });
        if (profile) {
          setForm((prev) => {
            const merged = { ...prev };
            for (const [key, value] of Object.entries(profile)) {
              if (key === "profileCompleted" || key === "updatedAt") continue;
              if (value !== "" && value != null) merged[key] = value;
            }
            return merged;
          });
        }
      } catch { /* the form keeps what it has */ }
    };

    if (userId) loadExisting();
  }, [userId]);

  // ── Skip ──────────────────────────────────────────────
  // ✅ FIX: router.replace called once — the original had a try/catch
  //    that called replace in both branches which could fire twice.
  const handleSkip = useCallback(() => {
    Alert.alert(
      t("profileTeacher.skipTitle"),
      t("profileTeacher.skipBody"),
      [
        { text: t("profileTeacher.cancel"), style: "cancel" },
        {
          text:  t("profileTeacher.skipConfirm"),
          style: "destructive",
          onPress: () => router.replace("/teacher/dashboard"),
        },
      ]
    );
  }, [t]);

  // ── Navigation ────────────────────────────────────────
  const goNext = () => {
    const errs = validateStep(step, form, t);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    if (step < STEPS.length - 1) setStep((p) => p + 1);
    else handleSubmit();
  };

  const goBack = () => {
    setErrors({});
    if (step > 0) { setStep((p) => p - 1); return; }
    router.replace("/teacher/dashboard");
  };

  // ── Submit ────────────────────────────────────────────
  const handleSubmit = async () => {
    const errs = validateStep(step, form, t);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    try {
      setSaving(true);
      const { serverSaved } = await saveProfile(form, userId);

      const fullName = `${form.firstName} ${form.lastName}`.trim();

      setProfileCompleted(true);
      // updateUser, not setUser: setUser(user) with no token wrote an empty
      // token, and the teacher was signed out on the next launch.
      if (user) updateUser?.({ name: fullName, profileCompleted: true });

      Alert.alert(
        t("profileTeacher.savedTitle"),
        serverSaved ? t("profileTeacher.savedBody") : t("common.savedOnPhoneOnly"),
        [{
          text: t("profileTeacher.continueBtn"),
          onPress: () => router.replace("/teacher/dashboard"),
        }]
      );
    } catch (err) {
      Alert.alert(t("profileTeacher.errorTitle"), needsInternetFailureText(t, err, "profileTeacher.saveFailedBody"));
    } finally {
      setSaving(false);
    }
  };

  // ── Date boundaries ───────────────────────────────────
  const today       = new Date();
  const minBirthday = new Date(today.getFullYear() - 80, 0, 1);
  const maxBirthday = new Date(today.getFullYear() - 18, 11, 31);

  // ─────────────────────────────────────────────────────
  // STEP CONTENT
  // ─────────────────────────────────────────────────────
  const renderStep = () => {
    switch (step) {

      case 0:
        return (
          <>
            <View style={ss.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileTeacher.labelFirstName")} required
                  value={form.firstName}
                  onChangeText={(v) => set("firstName", v)}
                  placeholder={t("profileTeacher.phFirstName")}
                  icon="person-outline"
                  error={errors.firstName}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileTeacher.labelLastName")} required
                  value={form.lastName}
                  onChangeText={(v) => set("lastName", v)}
                  placeholder={t("profileTeacher.phLastName")}
                  error={errors.lastName}
                />
              </View>
            </View>

            <SelectField
              label={t("profileTeacher.labelGender")} required
              value={form.gender}
              options={withLabels(GENDERS, t)}
              onSelect={(v) => set("gender", v)}
              error={errors.gender}
            />

            <DateField
              label={t("profileTeacher.labelDob")} required
              value={form.dateOfBirth}
              onChange={(ymd) => set("dateOfBirth", ymd)}
              maximumDate={maxBirthday}
              minimumDate={minBirthday}
              error={errors.dateOfBirth}
            />

            <Field
              label={t("profileTeacher.labelNationalId")} required
              value={form.nationalId}
              onChangeText={(v) => set("nationalId", v)}
              placeholder={t("profileTeacher.phNationalId")}
              icon="card-outline"
              error={errors.nationalId}
            />

            <SelectField
              label={t("profileTeacher.labelBloodGroup")}
              value={form.bloodGroup}
              options={BLOOD_GROUPS}
              onSelect={(v) => set("bloodGroup", v)}
            />

            <Field
              label={t("profileTeacher.labelBio")}
              value={form.bio}
              onChangeText={(v) => set("bio", v)}
              placeholder={t("profileTeacher.phBio")}
              multiline
              icon="document-text-outline"
            />
          </>
        );

      case 1:
        return (
          <>
            <View style={ss.infoBox}>
              <Ionicons name="information-circle-outline" size={20} color={C.info} />
              <Text style={ss.infoText}>
                {t("profileTeacher.infoProfessional")}
              </Text>
            </View>

            <Field
              label={t("staffNo.labelLong")}
              value={staffNoText(t, staffNo)}
              editable={false}
              icon="id-card-outline"
              hint={t("staffNo.fromSchool")}
            />

            <SelectField
              label={t("profileTeacher.labelQualification")} required
              value={form.qualification}
              options={withLabels(QUALIFICATION_LEVELS, t)}
              onSelect={(v) => set("qualification", v)}
              error={errors.qualification}
            />

            <SelectField
              label={t("profileTeacher.labelEmploymentType")} required
              value={form.employmentType}
              options={withLabels(EMPLOYMENT_TYPES, t)}
              onSelect={(v) => set("employmentType", v)}
              error={errors.employmentType}
            />

            <DateField
              label={t("profileTeacher.labelJoinDate")} required
              value={form.joinDate}
              onChange={(ymd) => set("joinDate", ymd)}
              maximumDate={today}
              minimumDate={new Date(1980, 0, 1)}
              hint={t("profileTeacher.hintJoinDate")}
              error={errors.joinDate}
            />

            <Field
              label={t("profileTeacher.labelYearsExperience")}
              value={form.yearsOfExperience}
              onChangeText={(v) => set("yearsOfExperience", v)}
              placeholder={t("profileTeacher.phYearsExperience")}
              keyboardType="numeric"
              icon="time-outline"
            />

            <Field
              label={t("profileTeacher.labelPreviousSchool")}
              value={form.previousSchool}
              onChangeText={(v) => set("previousSchool", v)}
              placeholder={t("profileTeacher.phPreviousSchool")}
              icon="business-outline"
            />

            <Field
              label={t("profileTeacher.labelMedical")}
              value={form.medicalConditions}
              onChangeText={(v) => set("medicalConditions", v)}
              placeholder={t("profileTeacher.phMedical")}
              multiline
              icon="medical-outline"
            />
          </>
        );

      case 2:
        return (
          <>
            <Field
              label={t("profileTeacher.labelPhone")} required
              value={form.phone}
              onChangeText={(v) => set("phone", v)}
              placeholder={t("profileTeacher.phPhone")}
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.phone}
            />

            <Field
              label={t("profileTeacher.labelAltPhone")}
              value={form.alternatePhone}
              onChangeText={(v) => set("alternatePhone", v)}
              placeholder={t("profileTeacher.phOptional")}
              keyboardType="phone-pad"
              icon="call-outline"
            />

            <Field
              label={t("profileTeacher.labelEmail")}
              value={form.email || user?.email || ""}
              onChangeText={(v) => set("email", v)}
              placeholder={t("profileTeacher.phEmail")}
              keyboardType="email-address"
              icon="mail-outline"
              hint={t("profileTeacher.hintEmail")}
              error={errors.email}
              editable={!user?.email}
            />

            <Field
              label={t("profileTeacher.labelAddress")} required
              value={form.address}
              onChangeText={(v) => set("address", v)}
              placeholder={t("profileTeacher.phAddress")}
              icon="home-outline"
              multiline
              error={errors.address}
            />

            <View style={ss.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileTeacher.labelCity")}
                  value={form.city}
                  onChangeText={(v) => set("city", v)}
                  placeholder={t("profileTeacher.phCity")}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileTeacher.labelState")}
                  value={form.state}
                  onChangeText={(v) => set("state", v)}
                  placeholder={t("profileTeacher.phState")}
                />
              </View>
            </View>
          </>
        );

      case 3:
        return (
          <>
            <View style={ss.infoBox}>
              <Ionicons name="information-circle-outline" size={20} color={C.info} />
              <Text style={ss.infoText}>
                {t("profileTeacher.infoEmergency")}
              </Text>
            </View>

            <Field
              label={t("profileTeacher.labelEmergencyName")} required
              value={form.emergencyName}
              onChangeText={(v) => set("emergencyName", v)}
              placeholder={t("profileTeacher.phFullName")}
              icon="person-outline"
              error={errors.emergencyName}
            />

            <Field
              label={t("profileTeacher.labelEmergencyPhone")} required
              value={form.emergencyPhone}
              onChangeText={(v) => set("emergencyPhone", v)}
              placeholder={t("profileTeacher.phPhone")}
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.emergencyPhone}
            />

            <Field
              label={t("profileTeacher.labelRelation")} required
              value={form.emergencyRelation}
              onChangeText={(v) => set("emergencyRelation", v)}
              placeholder={t("profileTeacher.phRelation")}
              icon="heart-outline"
              error={errors.emergencyRelation}
            />
          </>
        );

      default:
        return null;
    }
  };

  // ─────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
    >
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />
      <View style={ss.screen}>

        {/* Top bar */}
        <View style={ss.topBar}>
          <TouchableOpacity onPress={goBack} style={ss.backBtn} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color={C.gray700} />
          </TouchableOpacity>
          <HeaderIcon style={ss.headerIcon} />
          <View style={{ flex: 1 }}>
            <Text style={ss.topTitle}>{t("profileTeacher.title")}</Text>
            <Text style={ss.topSub}>
              {t("profileTeacher.stepOf", { current: step + 1, total: STEPS.length })}
            </Text>
          </View>
          <TouchableOpacity
            style={ss.skipBtn}
            onPress={handleSkip}
            hitSlop={8}
            activeOpacity={0.7}
          >
            <Text style={ss.skipBtnText}>{t("profileTeacher.skip")}</Text>
          </TouchableOpacity>
        </View>

        {/* Progress bar */}
        <View style={ss.progressTrack}>
          <View style={[ss.progressFill, { width: `${progress}%` }]} />
        </View>

        {/* Step indicators */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={ss.stepRow}
          contentContainerStyle={ss.stepRowContent}
        >
          {STEPS.map((s, i) => {
            const isDone    = i < step;
            const isCurrent = i === step;
            return (
              <View key={s.id} style={ss.stepItem}>
                <View style={[
                  ss.stepCircle,
                  isDone    && ss.stepCircleDone,
                  isCurrent && ss.stepCircleActive,
                ]}>
                  {isDone
                    ? <Ionicons name="checkmark" size={14} color={C.white} />
                    : <Ionicons name={s.icon}    size={14} color={isCurrent ? C.white : C.primary} />
                  }
                </View>
                <Text style={[
                  ss.stepLabel,
                  isCurrent && ss.stepLabelActive,
                  isDone    && ss.stepLabelDone,
                ]}>
                  {t(s.titleKey)}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        {/* Step header */}
        <View style={ss.stepHeader}>
          <View style={ss.stepTitleRow}>
            <IconSquare icon={STEPS[step].icon} accent="violet" size={28} />
            <Text style={ss.stepTitle}>{t(STEPS[step].titleKey)}</Text>
          </View>
          <Text style={ss.stepDesc}>{t(STEPS[step].descKey)}</Text>
        </View>

        {/* Form */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={ss.formContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {renderStep()}
          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Bottom bar */}
        <View style={ss.bottomBar}>
          {step > 0 && (
            <TouchableOpacity style={ss.backAction} onPress={goBack}>
              <Ionicons name="arrow-back" size={18} color={C.primary} />
              <Text style={ss.backActionText}>{t("profileTeacher.back")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[ss.nextBtn, saving && ss.nextBtnDisabled]}
            onPress={goNext}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving
              ? <ActivityIndicator size="small" color={C.white} />
              : <>
                  <Text style={ss.nextBtnText}>
                    {step === STEPS.length - 1
                      ? t("profileTeacher.save")
                      : t("profileTeacher.next")}
                  </Text>
                  <Ionicons
                    name={step === STEPS.length - 1 ? "checkmark-circle" : "arrow-forward"}
                    size={18}
                    color={C.white}
                  />
                </>
            }
          </TouchableOpacity>
        </View>

      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────
const ss = StyleSheet.create({
  screen:           { flex: 1, backgroundColor: C.white },
  topBar:           { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: C.white, gap: 10 },
  backBtn:          { width: 36, height: 36, borderRadius: 10, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  headerIcon:       { marginRight: 0 },
  topTitle:         { fontSize: 17, fontWeight: "700", color: C.gray900 },
  topSub:           { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  skipBtn:          { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1.5, borderColor: C.gray200, backgroundColor: C.white },
  skipBtnText:      { fontSize: 13, fontWeight: "600", color: C.gray500 },
  progressTrack:    { height: 4, backgroundColor: C.gray100, marginHorizontal: 16 },
  progressFill:     { height: "100%", backgroundColor: C.primary, borderRadius: 2 },
  stepRow:          { maxHeight: 80, backgroundColor: C.white },
  stepRowContent:   { paddingHorizontal: 16, paddingVertical: 12, gap: 24, alignItems: "center" },
  stepItem:         { alignItems: "center", gap: 4 },
  stepCircle:       { width: 32, height: 32, borderRadius: 16, backgroundColor: C.primaryBg, borderWidth: 1, borderColor: C.gray200, alignItems: "center", justifyContent: "center" },
  stepCircleActive: { backgroundColor: C.primary, borderColor: C.primary },
  stepCircleDone:   { backgroundColor: C.success, borderColor: C.success },
  stepLabel:        { fontSize: 10, color: COLORS.textSecondary, fontWeight: "500" },
  stepLabelActive:  { color: C.primaryDeep, fontWeight: "700" },
  stepLabelDone:    { color: C.success },
  stepHeader:       { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.gray200, backgroundColor: C.primaryBg },
  stepTitleRow:     { flexDirection: "row", alignItems: "center", gap: 10 },
  stepTitle:        { fontSize: 18, fontWeight: "700", color: C.gray900 },
  stepDesc:         { fontSize: 13, color: C.gray500, marginTop: 2 },
  formContent:      { paddingHorizontal: 20, paddingTop: 20 },
  row:              { flexDirection: "row", alignItems: "flex-start" },
  infoBox:          { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: SEMANTIC.info.box, borderRadius: 12, padding: 12, marginBottom: 16 },
  infoText:         { flex: 1, fontSize: 13, color: SEMANTIC.info.text, lineHeight: 18 },
  bottomBar:        { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 20, paddingVertical: 16, backgroundColor: C.white, gap: 12, borderTopWidth: 1, borderTopColor: C.gray100 },
  backAction:       { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: C.primary },
  backActionText:   { fontSize: 14, fontWeight: "700", color: C.primary },
  nextBtn:          { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12, flex: 1, justifyContent: "center" },
  nextBtnDisabled:  { opacity: 0.6 },
  nextBtnText:      { fontSize: 15, fontWeight: "700", color: C.white },
});
