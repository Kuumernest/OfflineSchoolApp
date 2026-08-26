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
  Platform,
  StatusBar,
  Modal,
} from "react-native";
import DateTimePicker           from "@react-native-community/datetimepicker";
import { router }               from "expo-router";
import { Ionicons }             from "@expo/vector-icons";
import { useAuthStore }         from "../../../src/store/auth.store";
import { getDatabase }          from "../../../src/db/database";
import DateField                from "../../../src/components/DateField";
// ✅ FIX: correct relative path — file lives at src/utils/withRetry.js
//    not app/utils/withRetry.js
import { withRetry }            from "../../../src/utils/withRetry";
import api                      from "../../../src/services/api";
import { useTranslation }       from "../../../src/i18n/useTranslation";

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
  info:      "#2563EB",
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
  hint:          { fontSize: 11, color: C.gray400, marginTop: 4 },
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
  dropdown:         { borderWidth: 1, borderColor: C.gray200, borderRadius: 12, backgroundColor: C.white, marginTop: 4, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 8, elevation: 4, zIndex: 999 },
  option:           { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  optionActive:     { backgroundColor: C.primaryBg },
  optionText:       { fontSize: 14, color: C.gray700 },
  optionTextActive: { color: C.primary, fontWeight: "600" },
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
    if (!form.staffId?.trim())   errors.staffId        = t("profileTeacher.errStaffId");
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
  try {
    await withRetry(
      () => api.put("/teacher/profile", payload, { timeout: 10_000 }),
      3,
      1_000
    );
  } catch (err) {
    console.warn("[profile/setup] API save failed:", err.message);
    // Non-fatal — SQLite save below is the source of truth on device
  }

  // ── SQLite save ───────────────────────────────────────
  try {
    const db  = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO teacher_profiles (
         teacher_id, first_name, last_name, gender, date_of_birth,
         national_id, staff_id, qualification, employment_type,
         join_date, years_experience, previous_school,
         phone, alternate_phone, address, city, state,
         emergency_name, emergency_phone, emergency_relation,
         blood_group, medical_conditions, bio,
         profile_completed, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(teacher_id) DO UPDATE SET
         first_name         = excluded.first_name,
         last_name          = excluded.last_name,
         gender             = excluded.gender,
         date_of_birth      = excluded.date_of_birth,
         national_id        = excluded.national_id,
         staff_id           = excluded.staff_id,
         qualification      = excluded.qualification,
         employment_type    = excluded.employment_type,
         join_date          = excluded.join_date,
         years_experience   = excluded.years_experience,
         previous_school    = excluded.previous_school,
         phone              = excluded.phone,
         alternate_phone    = excluded.alternate_phone,
         address            = excluded.address,
         city               = excluded.city,
         state              = excluded.state,
         emergency_name     = excluded.emergency_name,
         emergency_phone    = excluded.emergency_phone,
         emergency_relation = excluded.emergency_relation,
         blood_group        = excluded.blood_group,
         medical_conditions = excluded.medical_conditions,
         bio                = excluded.bio,
         profile_completed  = 1,
         updated_at         = excluded.updated_at`,
      [
        userId,
        payload.firstName         ?? null,
        payload.lastName          ?? null,
        payload.gender            ?? null,
        payload.dateOfBirth       ?? null,
        payload.nationalId        ?? null,
        payload.staffId           ?? null,
        payload.qualification     ?? null,
        payload.employmentType    ?? null,
        payload.joinDate          ?? null,
        payload.yearsOfExperience ?? null,
        payload.previousSchool    ?? null,
        payload.phone             ?? null,
        payload.alternatePhone    ?? null,
        payload.address           ?? null,
        payload.city              ?? null,
        payload.state             ?? null,
        payload.emergencyName     ?? null,
        payload.emergencyPhone    ?? null,
        payload.emergencyRelation ?? null,
        payload.bloodGroup        ?? null,
        payload.medicalConditions ?? null,
        payload.bio               ?? null,
        now,
      ]
    );

    console.log("✅ teacher_profiles upsert complete");

    // Update display name in users table
    await db.runAsync(
      `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
      [fullName, new Date().toISOString(), userId]
    ).catch(() => {});

    // Mark complete in settings_profile if that table exists
    const spExists = await db.getFirstAsync(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name='settings_profile'
       LIMIT 1`
    ).catch(() => null);

    if (spExists) {
      await db.runAsync(
        `INSERT INTO settings_profile (user_id, profile_completed, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           profile_completed = 1,
           updated_at        = excluded.updated_at`,
        [userId, new Date().toISOString()]
      ).catch(() => {});
    }

  } catch (err) {
    console.warn("[profile/setup] SQLite save error:", err.message);
    throw err;
  }
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
      const res = await withRetry(
        () => api.get("/teacher/profile"),
        3,
        1_000
      );
      const data = res.data?.data || res.data;
      if (data?.profileCompleted) return true;
    }
  } catch { /* fall through to SQLite */ }

  // ── 3. SQLite fallback ────────────────────────────────
  try {
    const db = await getDatabase();

    const tpRow = await db.getFirstAsync(
      `SELECT profile_completed
       FROM   teacher_profiles
       WHERE  teacher_id = ?
       LIMIT  1`,
      [userId]
    ).catch(() => null);
    if (tpRow?.profile_completed) return true;

    const spRow = await db.getFirstAsync(
      `SELECT profile_completed
       FROM   settings_profile
       WHERE  user_id = ?
       LIMIT  1`,
      [userId]
    ).catch(() => null);
    if (spRow?.profile_completed) return true;

  } catch { /* ignore */ }

  return false;
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function TeacherProfileSetup() {
  const { t }               = useTranslation();
  const user                = useAuthStore((s) => s.user);
  const setUser             = useAuthStore((s) => s.setUser);
  const setProfileCompleted = useAuthStore((s) => s.setProfileCompleted);

  const userId = String(user?._id || user?.id || "");

  const [step,   setStep]   = useState(0);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

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
      // Try API first (with retry so transient WiFi blip doesn't break it)
      try {
        const res = await withRetry(
          () => api.get("/teacher/profile", { timeout: 8_000 }),
          3,
          1_000
        );
        const p = res.data?.data || res.data;
        if (p && typeof p === "object") {
          setForm((prev) => ({
            ...prev,
            firstName:         p.firstName         || prev.firstName,
            lastName:          p.lastName          || prev.lastName,
            gender:            p.gender            || prev.gender,
            dateOfBirth:       p.dateOfBirth       || "",
            nationalId:        p.nationalId        || "",
            staffId:           p.staffId           || "",
            qualification:     p.qualification     || "",
            employmentType:    p.employmentType    || "full_time",
            joinDate:          p.joinDate          || "",
            yearsOfExperience: p.yearsOfExperience || "",
            previousSchool:    p.previousSchool    || "",
            phone:             p.phone             || prev.phone,
            alternatePhone:    p.alternatePhone    || "",
            address:           p.address           || "",
            city:              p.city              || "",
            state:             p.state             || "",
            emergencyName:     p.emergencyName     || "",
            emergencyPhone:    p.emergencyPhone    || "",
            emergencyRelation: p.emergencyRelation || "",
            bloodGroup:        p.bloodGroup        || "",
            medicalConditions: p.medicalConditions || "",
            bio:               p.bio               || "",
          }));
          return; // API succeeded — no need for SQLite fallback
        }
      } catch { /* fall through to SQLite */ }

      // Fallback: local cache
      try {
        const db  = await getDatabase();
        const row = await db.getFirstAsync(
          `SELECT * FROM teacher_profiles WHERE teacher_id = ? LIMIT 1`,
          [userId]
        ).catch(() => null);

        if (row) {
          setForm((prev) => ({
            ...prev,
            firstName:         row.first_name         || prev.firstName,
            lastName:          row.last_name          || prev.lastName,
            gender:            row.gender             || prev.gender,
            dateOfBirth:       row.date_of_birth      || prev.dateOfBirth,
            nationalId:        row.national_id        || prev.nationalId,
            staffId:           row.staff_id           || prev.staffId,
            qualification:     row.qualification      || prev.qualification,
            employmentType:    row.employment_type    || prev.employmentType,
            joinDate:          row.join_date          || prev.joinDate,
            yearsOfExperience: String(row.years_experience || ""),
            previousSchool:    row.previous_school    || prev.previousSchool,
            phone:             row.phone              || prev.phone,
            alternatePhone:    row.alternate_phone    || prev.alternatePhone,
            address:           row.address            || prev.address,
            city:              row.city               || prev.city,
            state:             row.state              || prev.state,
            emergencyName:     row.emergency_name     || prev.emergencyName,
            emergencyPhone:    row.emergency_phone    || prev.emergencyPhone,
            emergencyRelation: row.emergency_relation || prev.emergencyRelation,
            bloodGroup:        row.blood_group        || prev.bloodGroup,
            medicalConditions: row.medical_conditions || prev.medicalConditions,
            bio:               row.bio                || prev.bio,
          }));
        }
      } catch { /* ignore */ }
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
      await saveProfile(form, userId);

      const fullName = `${form.firstName} ${form.lastName}`.trim();

      setProfileCompleted(true);
      if (user) setUser?.({ ...user, name: fullName, profileCompleted: true });

      Alert.alert(
        t("profileTeacher.savedTitle"),
        t("profileTeacher.savedBody"),
        [{
          text: t("profileTeacher.continueBtn"),
          onPress: () => router.replace("/teacher/dashboard"),
        }]
      );
    } catch (err) {
      Alert.alert(t("profileTeacher.errorTitle"), err.message || t("profileTeacher.saveFailedBody"));
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
              label={t("profileTeacher.labelStaffId")} required
              value={form.staffId}
              onChangeText={(v) => set("staffId", v)}
              placeholder={t("profileTeacher.phStaffId")}
              icon="id-card-outline"
              error={errors.staffId}
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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />
      <View style={ss.screen}>

        {/* Top bar */}
        <View style={ss.topBar}>
          <TouchableOpacity onPress={goBack} style={ss.backBtn} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color={C.gray700} />
          </TouchableOpacity>
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
                    : <Ionicons name={s.icon}    size={14} color={isCurrent ? C.white : C.gray400} />
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
          <Text style={ss.stepTitle}>{t(STEPS[step].titleKey)}</Text>
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
  topTitle:         { fontSize: 17, fontWeight: "700", color: C.gray900 },
  topSub:           { fontSize: 12, color: C.gray400, marginTop: 1 },
  skipBtn:          { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1.5, borderColor: C.gray200, backgroundColor: C.gray50 },
  skipBtnText:      { fontSize: 13, fontWeight: "600", color: C.gray500 },
  progressTrack:    { height: 4, backgroundColor: C.gray100, marginHorizontal: 16 },
  progressFill:     { height: "100%", backgroundColor: C.primary, borderRadius: 2 },
  stepRow:          { maxHeight: 80, backgroundColor: C.white },
  stepRowContent:   { paddingHorizontal: 16, paddingVertical: 12, gap: 24, alignItems: "center" },
  stepItem:         { alignItems: "center", gap: 4 },
  stepCircle:       { width: 32, height: 32, borderRadius: 16, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  stepCircleActive: { backgroundColor: C.primary },
  stepCircleDone:   { backgroundColor: C.success },
  stepLabel:        { fontSize: 10, color: C.gray400, fontWeight: "500" },
  stepLabelActive:  { color: C.primary, fontWeight: "700" },
  stepLabelDone:    { color: C.success },
  stepHeader:       { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.gray100, backgroundColor: C.gray50 },
  stepTitle:        { fontSize: 18, fontWeight: "700", color: C.gray900 },
  stepDesc:         { fontSize: 13, color: C.gray500, marginTop: 2 },
  formContent:      { paddingHorizontal: 20, paddingTop: 20 },
  row:              { flexDirection: "row", alignItems: "flex-start" },
  infoBox:          { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#DBEAFE", borderRadius: 12, padding: 12, marginBottom: 16 },
  infoText:         { flex: 1, fontSize: 13, color: "#1E40AF", lineHeight: 18 },
  bottomBar:        { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 20, paddingVertical: 16, backgroundColor: C.white, gap: 12, borderTopWidth: 1, borderTopColor: C.gray100 },
  backAction:       { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: C.primary },
  backActionText:   { fontSize: 14, fontWeight: "700", color: C.primary },
  nextBtn:          { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12, flex: 1, justifyContent: "center" },
  nextBtnDisabled:  { opacity: 0.6 },
  nextBtnText:      { fontSize: 15, fontWeight: "700", color: C.white },
});
