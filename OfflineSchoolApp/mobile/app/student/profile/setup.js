//app/student/profile/setup.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
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
import DateTimePicker from "@react-native-community/datetimepicker";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import AsyncStorage     from "@react-native-async-storage/async-storage";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api              from "../../../src/services/api";
import DateField        from "../../../src/components/DateField";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { COLORS as THEME, ACCENT, SEMANTIC, TONE_EDGE, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// SKIP FLAG
// Written BEFORE navigation so the dashboard guard reads it
// and does NOT redirect the student back to this screen.
// ─────────────────────────────────────────────────────────

const SKIP_FLAG_KEY = "student_profile_setup_skipped";

export const clearStudentProfileSkipFlag = async () => {
  try { await AsyncStorage.removeItem(SKIP_FLAG_KEY); } catch { /* ignore */ }
};

export const hasStudentSkippedProfileSetup = async () => {
  try {
    const val = await AsyncStorage.getItem(SKIP_FLAG_KEY);
    return val === "true";
  } catch { return false; }
};

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

// The form's colours, from the theme: sign-in and profile screens are blue.
const C = {
  primary:   ACCENT.blue.solid,
  primaryBg: ACCENT.blue.wash,
  primaryDeep: ACCENT.blue.deep,
  success:   TONE_EDGE.success,
  error:     SEMANTIC.error.icon,
  errorText: SEMANTIC.error.text,
  info:      SEMANTIC.info.icon,
  white:     THEME.surface,
  gray50:    THEME.page,
  gray100:   ACCENT.slate.wash,
  gray200:   THEME.border,
  gray400:   THEME.textMuted,     // placeholders and decoration only
  gray500:   THEME.textSecondary,
  gray700:   THEME.text,
  gray900:   THEME.text,
};

// ─────────────────────────────────────────────────────────
// INPUT SANITIZER
// ─────────────────────────────────────────────────────────

const sanitize = (str, maxLen = 500) =>
  typeof str === "string"
    ? str.replace(/[<>]/g, "").trim().slice(0, maxLen)
    : null;


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
  hint:          { fontSize: 11, color: C.gray500, marginTop: 4 },
  errorText:     { fontSize: 11, color: C.errorText, marginTop: 4, fontWeight: "500" },
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
          {selected?.label || t("profileStudent.selectPlaceholder", { label })}
        </Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={C.gray500}
        />
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
  optionActive:     { backgroundColor: C.primaryBg, borderLeftWidth: 3, borderLeftColor: ACCENT.blue.base },
  optionText:       { fontSize: 14, color: C.gray700 },
  optionTextActive: { color: C.primaryDeep, fontWeight: "600" },
  errorText:        { fontSize: 11, color: C.errorText, marginTop: 4, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// OPTION LISTS
// ─────────────────────────────────────────────────────────

/** Options carry a translation key; labels are resolved at render time. */
const withLabels = (options, t) =>
  options.map((o) => ({ value: o.value, label: t(o.labelKey) }));

const GENDERS = [
  { value: "male",   labelKey: "profileStudent.genderMale"   },
  { value: "female", labelKey: "profileStudent.genderFemale" },
  { value: "other",  labelKey: "profileStudent.genderOther"  },
];

const BLOOD_GROUPS = [
  { value: "A+",  label: "A+"  }, { value: "A-",  label: "A-"  },
  { value: "B+",  label: "B+"  }, { value: "B-",  label: "B-"  },
  { value: "AB+", label: "AB+" }, { value: "AB-", label: "AB-" },
  { value: "O+",  label: "O+"  }, { value: "O-",  label: "O-"  },
];

const GUARDIAN_RELATIONS = [
  { value: "father",      labelKey: "profileStudent.relFather"      },
  { value: "mother",      labelKey: "profileStudent.relMother"      },
  { value: "sibling",     labelKey: "profileStudent.relSibling"     },
  { value: "uncle",       labelKey: "profileStudent.relUncle"       },
  { value: "grandparent", labelKey: "profileStudent.relGrandparent" },
  { value: "other",       labelKey: "profileStudent.relOther"       },
];

// ─────────────────────────────────────────────────────────
// STEPS
// ─────────────────────────────────────────────────────────

const STEPS = [
  { id: "personal", icon: "person-outline", titleKey: "profileStudent.stepPersonal", descKey: "profileStudent.stepPersonalDesc" },
  { id: "contact",  icon: "call-outline",   titleKey: "profileStudent.stepContact",  descKey: "profileStudent.stepContactDesc"  },
  { id: "guardian", icon: "people-outline", titleKey: "profileStudent.stepGuardian", descKey: "profileStudent.stepGuardianDesc" },
];

// ─────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────

const validateStep = (step, form, t) => {
  const errors = {};

  if (step === 0) {
    const firstName = form.firstName?.trim();
    if (!firstName) {
      errors.firstName = t("profileStudent.errFirstName");
    } else if (firstName.length < 2) {
      errors.firstName = t("profileStudent.errMinChars");
    } else if (!/^[a-zA-Z\s'-]+$/.test(firstName)) {
      errors.firstName = t("profileStudent.errInvalidChars");
    }

    const lastName = form.lastName?.trim();
    if (!lastName) {
      errors.lastName = t("profileStudent.errLastName");
    } else if (lastName.length < 2) {
      errors.lastName = t("profileStudent.errMinChars");
    }

    if (!form.gender) {
      errors.gender = t("profileStudent.errGender");
    }

    const dob = form.dateOfBirth?.trim();
    if (!dob) {
      errors.dateOfBirth = t("profileStudent.errDob");
    } else {
      const age =
        new Date().getFullYear() - new Date(dob).getFullYear();
      if (age < 3)  errors.dateOfBirth = t("profileStudent.errDobInvalid");
      if (age > 30) errors.dateOfBirth = t("profileStudent.errDobInvalid");
    }
  }

  if (step === 1) {
    const phone = form.phone?.trim();
    if (!phone) {
      errors.phone = t("profileStudent.errPhone");
    } else if (!/^\+?[\d\s\-()]{7,15}$/.test(phone)) {
      errors.phone = t("profileStudent.errPhoneInvalid");
    }

    if (!form.address?.trim()) {
      errors.address = t("profileStudent.errAddress");
    }
  }

  if (step === 2) {
    if (!form.guardianName?.trim()) {
      errors.guardianName = t("profileStudent.errGuardianName");
    }

    const gPhone = form.guardianPhone?.trim();
    if (!gPhone) {
      errors.guardianPhone = t("profileStudent.errGuardianPhone");
    } else if (!/^\+?[\d\s\-()]{7,15}$/.test(gPhone)) {
      errors.guardianPhone = t("profileStudent.errPhoneInvalid");
    }

    if (
      form.guardianEmail?.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.guardianEmail)
    ) {
      errors.guardianEmail = t("profileStudent.errEmail");
    }
  }

  return errors;
};

// ─────────────────────────────────────────────────────────
// SAVE PROFILE
// ─────────────────────────────────────────────────────────

const saveProfile = async (form, userId) => {
  const payload = {
    firstName:         sanitize(form.firstName),
    lastName:          sanitize(form.lastName),
    gender:            form.gender,
    dateOfBirth:       form.dateOfBirth?.trim(),
    placeOfBirth:      sanitize(form.placeOfBirth),
    nationalId:        sanitize(form.nationalId),
    isRepeating:       !!form.isRepeating,
    phone:             sanitize(form.phone),
    alternatePhone:    sanitize(form.alternatePhone),
    address:           sanitize(form.address, 1000),
    city:              sanitize(form.city),
    state:             sanitize(form.state),
    guardianName:      sanitize(form.guardianName),
    guardianPhone:     sanitize(form.guardianPhone),
    guardianRelation:  form.guardianRelation,
    guardianEmail:     sanitize(form.guardianEmail),
    bloodGroup:        form.bloodGroup,
    medicalConditions: sanitize(form.medicalConditions, 1000),
    bio:               sanitize(form.bio, 1000),
    profileCompleted:  true,
  };

  // ── API (best-effort, never blocks local save) ────────
  // Online-only on the server side: nothing queues it. Reported back so the
  // screen can say "saved on this phone only" instead of pretending.
  let serverSaved = false;
  try {
    await api.put("/student/profile", payload, { timeout: 10000 });
    serverSaved = true;
  } catch (err) {
    if (err?.response?.status !== 404) {
      console.warn("[student/setup] API save failed:", err.message);
    }
  }

  // ── SQLite ────────────────────────────────────────────
  try {
    const db = await getDatabase();

    // Ensure table exists (idempotent)
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS student_profiles (
        student_id         TEXT PRIMARY KEY,
        first_name         TEXT,
        last_name          TEXT,
        gender             TEXT,
        date_of_birth      TEXT,
        place_of_birth     TEXT,
        national_id        TEXT,
        is_repeating       INTEGER DEFAULT 0,
        phone              TEXT,
        alternate_phone    TEXT,
        address            TEXT,
        city               TEXT,
        state              TEXT,
        guardian_name      TEXT,
        guardian_phone     TEXT,
        guardian_relation  TEXT,
        guardian_email     TEXT,
        blood_group        TEXT,
        medical_conditions TEXT,
        bio                TEXT,
        profile_completed  INTEGER DEFAULT 0,
        updated_at         TEXT
      )
    `).catch(() => {});

    await db.runAsync(
      `INSERT INTO student_profiles (
         student_id, first_name, last_name, gender, date_of_birth,
         place_of_birth, national_id, is_repeating, phone, alternate_phone,
         address, city, state, guardian_name, guardian_phone,
         guardian_relation, guardian_email, blood_group,
         medical_conditions, bio, profile_completed, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
       ON CONFLICT(student_id) DO UPDATE SET
         first_name         = excluded.first_name,
         last_name          = excluded.last_name,
         gender             = excluded.gender,
         date_of_birth      = excluded.date_of_birth,
         place_of_birth     = excluded.place_of_birth,
         national_id        = excluded.national_id,
         is_repeating       = excluded.is_repeating,
         phone              = excluded.phone,
         alternate_phone    = excluded.alternate_phone,
         address            = excluded.address,
         city               = excluded.city,
         state              = excluded.state,
         guardian_name      = excluded.guardian_name,
         guardian_phone     = excluded.guardian_phone,
         guardian_relation  = excluded.guardian_relation,
         guardian_email     = excluded.guardian_email,
         blood_group        = excluded.blood_group,
         medical_conditions = excluded.medical_conditions,
         bio                = excluded.bio,
         profile_completed  = 1,
         updated_at         = excluded.updated_at`,
      [
        userId,
        payload.firstName,         payload.lastName,
        payload.gender,            payload.dateOfBirth,
        payload.placeOfBirth,      payload.nationalId,
        payload.isRepeating ? 1 : 0,
        payload.phone,             payload.alternatePhone,
        payload.address,           payload.city,
        payload.state,             payload.guardianName,
        payload.guardianPhone,     payload.guardianRelation,
        payload.guardianEmail,     payload.bloodGroup,
        payload.medicalConditions, payload.bio,
        new Date().toISOString(),
      ]
    );

    console.log("✅ student_profiles upsert complete");

    // Keep users table name in sync
    const fullName =
      `${payload.firstName ?? ""} ${payload.lastName ?? ""}`.trim();
    await db
      .runAsync(
        `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
        [fullName, new Date().toISOString(), userId]
      )
      .catch(() => {});

  } catch (err) {
    console.warn("[student/setup] SQLite error:", err.message);
    throw err; // Re-throw so handleSubmit can show the error
  }
  return { serverSaved };
};

// ─────────────────────────────────────────────────────────
// CHECK IF STUDENT PROFILE IS COMPLETE
// Exported — used by the student dashboard guard.
// Uses getState() intentionally (called outside components).
// ─────────────────────────────────────────────────────────

export const isStudentProfileComplete = async (userId) => {
  if (!userId) return false;

  // ── Skip flag — treat as "do not block" ───────────────
  try {
    const skipped = await AsyncStorage.getItem(SKIP_FLAG_KEY);
    if (skipped === "true") return true;
  } catch { /* ignore */ }

  // ── Auth store — fastest in-memory check ──────────────
  const { profileCompleted, token } = useAuthStore.getState();
  if (profileCompleted) return true;

  // ── API check ─────────────────────────────────────────
  try {
    if (token) {
      const res  = await api.get("/student/profile", { timeout: 5000 });
      const data = res.data?.data || res.data?.student || res.data;
      if (data?.profileCompleted) return true;
    }
  } catch { /* fall through */ }

  // ── SQLite fallback ───────────────────────────────────
  try {
    const db  = await getDatabase();
    const row = await db
      .getFirstAsync(
        `SELECT profile_completed FROM student_profiles WHERE student_id = ? LIMIT 1`,
        [userId]
      )
      .catch(() => null);
    if (row?.profile_completed) return true;
  } catch { /* ignore */ }

  return false;
};

// ─────────────────────────────────────────────────────────
// DRAFT PERSISTENCE  (survives app restart mid-setup)
// ─────────────────────────────────────────────────────────

const draftKey  = (uid) => `student_profile_draft_${uid}`;
const loadDraft = async (uid) => {
  try {
    const raw = await AsyncStorage.getItem(draftKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
const saveDraft = async (uid, form, step) => {
  try {
    await AsyncStorage.setItem(draftKey(uid), JSON.stringify({ form, step }));
  } catch { /* ignore */ }
};
const clearDraft = async (uid) => {
  try { await AsyncStorage.removeItem(draftKey(uid)); } catch { /* ignore */ }
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function StudentProfileSetup() {
  const { t }               = useTranslation();
  const user                = useAuthStore((s) => s.user);
  const updateUser          = useAuthStore((s) => s.updateUser);
  const setProfileCompleted = useAuthStore((s) => s.setProfileCompleted);

  // Stable derived value
  const userId = useMemo(
    () => String(user?._id || user?.id || ""),
    [user]
  );

  const scrollRef = useRef(null);

  const [step,    setStep]    = useState(0);
  const [saving,  setSaving]  = useState(false);
  const [errors,  setErrors]  = useState({});
  const [loading, setLoading] = useState(true);

  const [form, setFormState] = useState({
    firstName:         user?.firstName || user?.name?.split(" ")[0]                 || "",
    lastName:          user?.lastName  || user?.name?.split(" ").slice(1).join(" ") || "",
    gender:            user?.gender    || "",
    dateOfBirth:       "",
    placeOfBirth:      "",
    nationalId:        "",
    isRepeating:       false,
    phone:             user?.phone     || "",
    alternatePhone:    "",
    address:           "",
    city:              "",
    state:             "",
    guardianName:      "",
    guardianPhone:     "",
    guardianRelation:  "",
    guardianEmail:     "",
    bloodGroup:        "",
    medicalConditions: "",
    bio:               "",
  });

  // ── Stable setter — clears field error on change ──────
  const set = useCallback((key, val) => {
    setFormState((p) => ({ ...p, [key]: val }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }, []);

  // ── Bootstrap: API → SQLite → draft ───────────────────
  useEffect(() => {
    if (!userId) { setLoading(false); return; }

    const bootstrap = async () => {
      // 1. Try API
      try {
        const res = await api.get("/student/profile", { timeout: 5000 });
        const p   = res.data?.data || res.data?.student || res.data;
        if (p && typeof p === "object" && !p.error && Object.keys(p).length > 0) {
          setFormState((prev) => mergeProfile(prev, p, "api"));
          setLoading(false);
          return; // API is authoritative
        }
      } catch (err) {
        if (err?.response?.status !== 404) {
          console.warn("[student/setup] API load:", err.message);
        }
      }

      // 2. Try student_profiles (SQLite cache)
      try {
        const db  = await getDatabase();
        const row = await db
          .getFirstAsync(
            `SELECT * FROM student_profiles WHERE student_id = ? LIMIT 1`,
            [userId]
          )
          .catch(() => null);

        if (row) {
          setFormState((prev) => mergeProfile(prev, row, "sqlite"));
          setLoading(false);
          return;
        }

        // 3. Try legacy students table
        const sRow = await db
          .getFirstAsync(
            `SELECT * FROM students WHERE userId = ? OR user_id = ? LIMIT 1`,
            [userId, userId]
          )
          .catch(() => null);

        if (sRow) {
          const nameParts = (
            sRow.studentName || sRow.student_name || ""
          ).split(" ");
          setFormState((prev) => ({
            ...prev,
            firstName:     sRow.firstName    || sRow.first_name    || nameParts[0]                || prev.firstName,
            lastName:      sRow.lastName     || sRow.last_name     || nameParts.slice(1).join(" ") || prev.lastName,
            phone:         sRow.phone        || prev.phone,
            guardianName:  sRow.guardianName || sRow.guardian_name  || prev.guardianName,
            guardianPhone: sRow.guardianPhone|| sRow.guardian_phone || prev.guardianPhone,
          }));
          setLoading(false);
          return;
        }
      } catch (err) {
        console.warn("[student/setup] SQLite load:", err.message);
      }

      // 4. Restore draft (mid-setup before app was killed)
      const draft = await loadDraft(userId);
      if (draft?.form) {
        setFormState((prev) => ({ ...prev, ...draft.form }));
        if (typeof draft.step === "number") setStep(draft.step);
      }

      setLoading(false);
    };

    bootstrap();
  }, [userId]);

  // ── Auto-save draft ───────────────────────────────────
  const draftTimerRef = useRef(null);
  useEffect(() => {
    if (!userId || loading) return;
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(
      () => saveDraft(userId, form, step),
      600
    );
    return () => clearTimeout(draftTimerRef.current);
  }, [form, step, userId, loading]);

  // ── Date boundaries ───────────────────────────────────
  const today = useMemo(() => new Date(), []);
  const minBirthday = useMemo(
    () => new Date(today.getFullYear() - 30, 0, 1),
    [today]
  );
  const maxBirthday = useMemo(
    () => new Date(today.getFullYear() - 3, 11, 31),
    [today]
  );

  // ── Navigate to student dashboard ─────────────────────
  const goToDashboard = useCallback(() => {
    router.replace("/student");
  }, []);

  // ── Skip ──────────────────────────────────────────────
  // FIX: Write skip flag AND update store BEFORE navigating.
  // Without this, the dashboard guard sees profileCompleted=false
  // and immediately redirects back here — creating a reload loop.
  const handleSkip = useCallback(() => {
    Alert.alert(
      t("profileStudent.skipTitle"),
      t("profileStudent.skipBody"),
      [
        { text: t("profileStudent.cancel"), style: "cancel" },
        {
          text: t("profileStudent.skipConfirm"),
          style: "destructive",
          onPress: async () => {
            try {
              // Persist flag so guard passes even after app restart
              await AsyncStorage.setItem(SKIP_FLAG_KEY, "true");
            } catch { /* ignore — store flag below is the safety net */ }

            // Update in-memory store so any synchronous guard check passes
            setProfileCompleted(true);

            goToDashboard();
          },
        },
      ]
    );
  }, [goToDashboard, setProfileCompleted, t]);

  // ── Navigation ────────────────────────────────────────
  const goNext = useCallback(() => {
    const errs = validateStep(step, form, t);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // Scroll to top so the user sees the first error
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    setErrors({});
    if (step < STEPS.length - 1) {
      setStep((p) => p + 1);
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    } else {
      handleSubmit();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form, t]);

  const goBack = useCallback(() => {
    setErrors({});
    if (step > 0) {
      setStep((p) => p - 1);
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    } else {
      // Back on step 0 = treat same as skip so guard doesn't loop
      AsyncStorage.setItem(SKIP_FLAG_KEY, "true").catch(() => {});
      setProfileCompleted(true);
      goToDashboard();
    }
  }, [step, goToDashboard, setProfileCompleted]);

  // ── Submit ────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!userId) {
      Alert.alert(
        t("profileStudent.sessionErrorTitle"),
        t("profileStudent.sessionErrorBody")
      );
      return;
    }

    try {
      setSaving(true);
      const { serverSaved } = await saveProfile(form, userId);

      // Clear skip flag (profile is now complete) and draft
      await clearStudentProfileSkipFlag();
      await clearDraft(userId);

      const fullName =
        `${form.firstName ?? ""} ${form.lastName ?? ""}`.trim();

      // Update auth store — guard will not fire again
      setProfileCompleted(true);
      // updateUser, not setUser: setUser(user) with no token wrote an empty
      // token, and the pupil was signed out on the next launch.
      updateUser?.({ name: fullName, profileCompleted: true });

      Alert.alert(
        t("profileStudent.savedTitle"),
        serverSaved ? t("profileStudent.savedBody") : t("common.savedOnPhoneOnly"),
        [{ text: t("profileStudent.continueBtn"), onPress: goToDashboard }]
      );
    } catch (err) {
      console.warn("[handleSubmit] unexpected error:", err.message);
      Alert.alert(
        t("profileStudent.saveFailedTitle"),
        t("profileStudent.saveFailedBody")
      );
    } finally {
      setSaving(false);
    }
  }, [form, userId, updateUser, setProfileCompleted, goToDashboard, t]);

  // ─────────────────────────────────────────────────────
  // STEP CONTENT
  // ─────────────────────────────────────────────────────

  const renderStep = useCallback(() => {
    switch (step) {

      case 0:
        return (
          <>
            <View style={ss.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileStudent.labelFirstName")} required
                  value={form.firstName}
                  onChangeText={(v) => set("firstName", v)}
                  placeholder={t("profileStudent.phFirstName")}
                  icon="person-outline"
                  error={errors.firstName}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileStudent.labelLastName")} required
                  value={form.lastName}
                  onChangeText={(v) => set("lastName", v)}
                  placeholder={t("profileStudent.phLastName")}
                  error={errors.lastName}
                />
              </View>
            </View>

            <SelectField
              label={t("profileStudent.labelGender")} required
              value={form.gender}
              options={withLabels(GENDERS, t)}
              onSelect={(v) => set("gender", v)}
              error={errors.gender}
            />

            <DateField
              label={t("profileStudent.labelDob")} required
              value={form.dateOfBirth}
              onChange={(ymd) => set("dateOfBirth", ymd)}
              maximumDate={maxBirthday}
              minimumDate={minBirthday}
              error={errors.dateOfBirth}
            />

            <Field
              label={t("profileStudent.labelPlaceOfBirth")}
              value={form.placeOfBirth}
              onChangeText={(v) => set("placeOfBirth", v)}
              placeholder={t("profileStudent.phPlaceOfBirth")}
              icon="location-outline"
            />

            <Field
              label={t("profileStudent.labelNationalId")}
              value={form.nationalId}
              onChangeText={(v) => set("nationalId", v)}
              placeholder={t("profileStudent.phNationalId")}
              icon="card-outline"
            />

            <SelectField
              label={t("profileStudent.labelBloodGroup")}
              value={form.bloodGroup}
              options={BLOOD_GROUPS}
              onSelect={(v) => set("bloodGroup", v)}
            />

            {/* Repeating toggle */}
            <View style={ss.toggleRow}>
              <View style={ss.toggleLeft}>
                <View style={[ss.toggleIcon, { backgroundColor: ACCENT.amber.solid }]}>
                  <Ionicons name="repeat-outline" size={18} color={THEME.onPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={ss.toggleTitle}>
                    {t("profileStudent.repeatTitle")}
                  </Text>
                  <Text style={ss.toggleSub}>
                    {t("profileStudent.repeatHint")}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={[ss.checkbox, form.isRepeating && ss.checkboxActive]}
                onPress={() => set("isRepeating", !form.isRepeating)}
                activeOpacity={0.7}
              >
                {form.isRepeating && (
                  <Ionicons name="checkmark" size={16} color={C.white} />
                )}
              </TouchableOpacity>
            </View>

            <Field
              label={t("profileStudent.labelMedical")}
              value={form.medicalConditions}
              onChangeText={(v) => set("medicalConditions", v)}
              placeholder={t("profileStudent.phMedical")}
              multiline
              icon="medical-outline"
            />

            <Field
              label={t("profileStudent.labelBio")}
              value={form.bio}
              onChangeText={(v) => set("bio", v)}
              placeholder={t("profileStudent.phBio")}
              multiline
              icon="document-text-outline"
            />
          </>
        );

      case 1:
        return (
          <>
            <Field
              label={t("profileStudent.labelPhone")} required
              value={form.phone}
              onChangeText={(v) => set("phone", v)}
              placeholder={t("profileStudent.phPhone")}
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.phone}
            />

            <Field
              label={t("profileStudent.labelAltPhone")}
              value={form.alternatePhone}
              onChangeText={(v) => set("alternatePhone", v)}
              placeholder={t("profileStudent.phOptional")}
              keyboardType="phone-pad"
              icon="call-outline"
            />

            <Field
              label={t("profileStudent.labelAddress")} required
              value={form.address}
              onChangeText={(v) => set("address", v)}
              placeholder={t("profileStudent.phAddress")}
              icon="home-outline"
              multiline
              error={errors.address}
            />

            <View style={ss.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileStudent.labelCity")}
                  value={form.city}
                  onChangeText={(v) => set("city", v)}
                  placeholder={t("profileStudent.phCity")}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label={t("profileStudent.labelState")}
                  value={form.state}
                  onChangeText={(v) => set("state", v)}
                  placeholder={t("profileStudent.phState")}
                />
              </View>
            </View>
          </>
        );

      case 2:
        return (
          <>
            <View style={ss.infoBox}>
              <Ionicons name="people-outline" size={20} color={C.info} />
              <Text style={ss.infoText}>
                {t("profileStudent.infoGuardian")}
              </Text>
            </View>

            <Field
              label={t("profileStudent.labelGuardianName")} required
              value={form.guardianName}
              onChangeText={(v) => set("guardianName", v)}
              placeholder={t("profileStudent.phGuardianName")}
              icon="person-outline"
              error={errors.guardianName}
            />

            <Field
              label={t("profileStudent.labelGuardianPhone")} required
              value={form.guardianPhone}
              onChangeText={(v) => set("guardianPhone", v)}
              placeholder={t("profileStudent.phPhone")}
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.guardianPhone}
            />

            <SelectField
              label={t("profileStudent.labelRelation")}
              value={form.guardianRelation}
              options={withLabels(GUARDIAN_RELATIONS, t)}
              onSelect={(v) => set("guardianRelation", v)}
            />

            <Field
              label={t("profileStudent.labelGuardianEmail")}
              value={form.guardianEmail}
              onChangeText={(v) => set("guardianEmail", v)}
              placeholder={t("profileStudent.phGuardianEmail")}
              keyboardType="email-address"
              icon="mail-outline"
              error={errors.guardianEmail}
            />
          </>
        );

      default:
        return null;
    }
  }, [step, form, errors, set, minBirthday, maxBirthday, t]);

  // ─────────────────────────────────────────────────────
  // LOADING STATE
  // ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={ss.loadingScreen}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={ss.loadingText}>{t("profileStudent.loading")}</Text>
      </View>
    );
  }

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

        {/* TOP BAR */}
        <View style={ss.topBar}>
          <TouchableOpacity onPress={goBack} style={ss.backBtn} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color={C.gray700} />
          </TouchableOpacity>
          <HeaderIcon style={{ marginRight: 0 }} />
          <View style={{ flex: 1 }}>
            <Text style={ss.topTitle}>{t("profileStudent.title")}</Text>
            <Text style={ss.topSub}>
              {t("profileStudent.stepOf", { current: step + 1, total: STEPS.length })}
            </Text>
          </View>
          <TouchableOpacity
            style={ss.skipBtn}
            onPress={handleSkip}
            hitSlop={8}
            activeOpacity={0.7}
          >
            <Text style={ss.skipBtnText}>{t("profileStudent.skip")}</Text>
          </TouchableOpacity>
        </View>

        {/* SKIP HINT — only on step 0 */}
        {step === 0 && (
          <View style={ss.skipHint}>
            <Ionicons name="information-circle-outline" size={14} color={SEMANTIC.info.icon} />
            <Text style={ss.skipHintText}>
              {t("profileStudent.skipHint")}
            </Text>
          </View>
        )}

        {/* PROGRESS BAR */}
        <View style={ss.progressTrack}>
          <View style={[ss.progressFill, { width: `${progress}%` }]} />
        </View>

        {/* STEP INDICATORS */}
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
                    : <Ionicons
                        name={s.icon}
                        size={14}
                        color={isCurrent ? C.white : C.gray500}
                      />
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

        {/* STEP HEADER */}
        <View style={[ss.stepHeader, ss.stepHeaderRow]}>
          <IconSquare icon={STEPS[step].icon} accent="blue" size={28} />
          <View style={{ flex: 1 }}>
            <Text style={ss.stepTitle}>{t(STEPS[step].titleKey)}</Text>
            <Text style={ss.stepDesc}>{t(STEPS[step].descKey)}</Text>
          </View>
        </View>

        {/* FORM */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={ss.formContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {renderStep()}
          <View style={{ height: 120 }} />
        </ScrollView>

        {/* BOTTOM BAR */}
        <View style={ss.bottomBar}>
          {step > 0 && (
            <TouchableOpacity style={ss.backAction} onPress={goBack}>
              <Ionicons name="arrow-back" size={18} color={C.primary} />
              <Text style={ss.backActionText}>{t("profileStudent.back")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[ss.nextBtn, saving && ss.nextBtnDisabled]}
            onPress={goNext}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator size="small" color={C.white} />
            ) : (
              <>
                <Text style={ss.nextBtnText}>
                  {step === STEPS.length - 1
                    ? t("profileStudent.save")
                    : t("profileStudent.next")}
                </Text>
                <Ionicons
                  name={
                    step === STEPS.length - 1
                      ? "checkmark-circle"
                      : "arrow-forward"
                  }
                  size={18}
                  color={C.white}
                />
              </>
            )}
          </TouchableOpacity>
        </View>

      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// HELPER — merge profile data into form state
// Handles both camelCase (API) and snake_case (SQLite).
// ─────────────────────────────────────────────────────────

function mergeProfile(prev, raw, source) {
  const g = (camel, snake) =>
    raw[camel] ||
    (source === "sqlite" ? raw[snake] : undefined) ||
    "";

  return {
    ...prev,
    firstName:         g("firstName",         "first_name")         || prev.firstName,
    lastName:          g("lastName",          "last_name")          || prev.lastName,
    gender:            g("gender",            "gender")             || prev.gender,
    dateOfBirth:       g("dateOfBirth",       "date_of_birth")      || prev.dateOfBirth,
    placeOfBirth:      g("placeOfBirth",      "place_of_birth")     || prev.placeOfBirth,
    nationalId:        g("nationalId",        "national_id")        || prev.nationalId,
    isRepeating:       !!(raw.isRepeating     || raw.is_repeating),
    phone:             g("phone",             "phone")              || prev.phone,
    alternatePhone:    g("alternatePhone",    "alternate_phone")    || prev.alternatePhone,
    address:           g("address",           "address")            || prev.address,
    city:              g("city",              "city")               || prev.city,
    state:             g("state",             "state")              || prev.state,
    guardianName:      g("guardianName",      "guardian_name")      || prev.guardianName,
    guardianPhone:     g("guardianPhone",     "guardian_phone")     || prev.guardianPhone,
    guardianRelation:  g("guardianRelation",  "guardian_relation")  || prev.guardianRelation,
    guardianEmail:     g("guardianEmail",     "guardian_email")     || prev.guardianEmail,
    bloodGroup:        g("bloodGroup",        "blood_group")        || prev.bloodGroup,
    medicalConditions: g("medicalConditions", "medical_conditions") || prev.medicalConditions,
    bio:               g("bio",              "bio")                 || prev.bio,
  };
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const ss = StyleSheet.create({
  screen:           { flex: 1, backgroundColor: C.white },
  loadingScreen:    { flex: 1, backgroundColor: C.white, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText:      { fontSize: 14, color: C.gray500 },
  topBar:           { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: C.white, gap: 10, borderBottomWidth: 1, borderBottomColor: THEME.border },
  backBtn:          { width: 36, height: 36, borderRadius: 10, backgroundColor: C.gray50, alignItems: "center", justifyContent: "center" },
  topTitle:         { fontSize: 17, fontWeight: "700", color: C.gray900 },
  topSub:           { fontSize: 12, color: C.gray500, marginTop: 1 },
  skipBtn:          { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1.5, borderColor: C.gray200, backgroundColor: C.white },
  skipBtnText:      { fontSize: 13, fontWeight: "600", color: C.gray500 },
  skipHint:         { flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: SEMANTIC.info.bg, borderRadius: 8, borderWidth: 1, borderColor: statusBadge("info").border },
  skipHintText:     { fontSize: 11, color: SEMANTIC.info.text, flex: 1, lineHeight: 16 },
  progressTrack:    { height: 4, backgroundColor: C.gray100, marginHorizontal: 16 },
  progressFill:     { height: "100%", backgroundColor: C.primary, borderRadius: 2 },
  stepRow:          { maxHeight: 80, backgroundColor: C.white },
  stepRowContent:   { paddingHorizontal: 16, paddingVertical: 12, gap: 24, alignItems: "center" },
  stepItem:         { alignItems: "center", gap: 4 },
  stepCircle:       { width: 32, height: 32, borderRadius: 16, backgroundColor: C.white, borderWidth: 1, borderColor: C.gray200, alignItems: "center", justifyContent: "center" },
  stepCircleActive: { backgroundColor: C.primary, borderColor: C.primary },
  stepCircleDone:   { backgroundColor: C.success, borderColor: C.success },
  stepLabel:        { fontSize: 10, color: C.gray500, fontWeight: "500" },
  stepLabelActive:  { color: C.primaryDeep, fontWeight: "700" },
  stepLabelDone:    { color: SEMANTIC.success.text },
  stepHeader:       { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.gray200, backgroundColor: C.primaryBg },
  stepHeaderRow:    { flexDirection: "row", alignItems: "center", gap: 10 },
  stepTitle:        { fontSize: 18, fontWeight: "700", color: C.gray900 },
  stepDesc:         { fontSize: 13, color: C.gray500, marginTop: 2 },
  formContent:      { paddingHorizontal: 20, paddingTop: 20 },
  row:              { flexDirection: "row", alignItems: "flex-start" },
  infoBox:          { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: SEMANTIC.info.bg, borderRadius: 12, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: statusBadge("info").border },
  infoText:         { flex: 1, fontSize: 13, color: SEMANTIC.info.text, lineHeight: 18 },
  toggleRow:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.white, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: C.gray200 },
  toggleLeft:       { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  toggleIcon:       { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  toggleTitle:      { fontSize: 14, fontWeight: "600", color: C.gray900 },
  toggleSub:        { fontSize: 11, color: C.gray500, marginTop: 1 },
  checkbox:         { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: C.gray200, alignItems: "center", justifyContent: "center" },
  checkboxActive:   { backgroundColor: C.primary, borderColor: C.primary },
  bottomBar:        { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 20, paddingVertical: 16, backgroundColor: C.white, gap: 12, borderTopWidth: 1, borderTopColor: C.gray200 },
  backAction:       { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: C.primary },
  backActionText:   { fontSize: 14, fontWeight: "700", color: C.primary },
  nextBtn:          { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12, flex: 1, justifyContent: "center" },
  nextBtnDisabled:  { opacity: 0.6 },
  nextBtnText:      { fontSize: 15, fontWeight: "700", color: C.white },
});
