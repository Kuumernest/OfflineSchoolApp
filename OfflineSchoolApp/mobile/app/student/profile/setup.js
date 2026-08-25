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
  Platform,
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

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  error:     "#DC2626",
  info:      "#2563EB",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
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
  hint:          { fontSize: 11, color: C.gray400, marginTop: 4 },
  errorText:     { fontSize: 11, color: C.error, marginTop: 4, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// SELECT
// ─────────────────────────────────────────────────────────

function SelectField({ label, value, options, onSelect, required, error }) {
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
          {selected?.label || `Select ${label}`}
        </Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={C.gray400}
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
  optionActive:     { backgroundColor: C.primaryBg },
  optionText:       { fontSize: 14, color: C.gray700 },
  optionTextActive: { color: C.primary, fontWeight: "600" },
  errorText:        { fontSize: 11, color: C.error, marginTop: 4, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────
// OPTION LISTS
// ─────────────────────────────────────────────────────────

const GENDERS = [
  { value: "male",   label: "Male"   },
  { value: "female", label: "Female" },
  { value: "other",  label: "Other / Prefer not to say" },
];

const BLOOD_GROUPS = [
  { value: "A+",  label: "A+"  }, { value: "A-",  label: "A-"  },
  { value: "B+",  label: "B+"  }, { value: "B-",  label: "B-"  },
  { value: "AB+", label: "AB+" }, { value: "AB-", label: "AB-" },
  { value: "O+",  label: "O+"  }, { value: "O-",  label: "O-"  },
];

const GUARDIAN_RELATIONS = [
  { value: "father",      label: "Father"       },
  { value: "mother",      label: "Mother"       },
  { value: "sibling",     label: "Sibling"      },
  { value: "uncle",       label: "Uncle / Aunt" },
  { value: "grandparent", label: "Grandparent"  },
  { value: "other",       label: "Other"        },
];

// ─────────────────────────────────────────────────────────
// STEPS
// ─────────────────────────────────────────────────────────

const STEPS = [
  { id: "personal", title: "Personal Info", icon: "person-outline", desc: "Basic personal details" },
  { id: "contact",  title: "Contact",       icon: "call-outline",   desc: "How to reach you"       },
  { id: "guardian", title: "Guardian",      icon: "people-outline", desc: "Parent / guardian info" },
];

// ─────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────

const validateStep = (step, form) => {
  const errors = {};

  if (step === 0) {
    const firstName = form.firstName?.trim();
    if (!firstName) {
      errors.firstName = "First name is required";
    } else if (firstName.length < 2) {
      errors.firstName = "Must be at least 2 characters";
    } else if (!/^[a-zA-Z\s'-]+$/.test(firstName)) {
      errors.firstName = "Contains invalid characters";
    }

    const lastName = form.lastName?.trim();
    if (!lastName) {
      errors.lastName = "Last name is required";
    } else if (lastName.length < 2) {
      errors.lastName = "Must be at least 2 characters";
    }

    if (!form.gender) {
      errors.gender = "Please select your gender";
    }

    const dob = form.dateOfBirth?.trim();
    if (!dob) {
      errors.dateOfBirth = "Date of birth is required";
    } else {
      const age =
        new Date().getFullYear() - new Date(dob).getFullYear();
      if (age < 3)  errors.dateOfBirth = "Please enter a valid date of birth";
      if (age > 30) errors.dateOfBirth = "Please enter a valid date of birth";
    }
  }

  if (step === 1) {
    const phone = form.phone?.trim();
    if (!phone) {
      errors.phone = "Phone number is required";
    } else if (!/^\+?[\d\s\-()]{7,15}$/.test(phone)) {
      errors.phone = "Enter a valid phone number";
    }

    if (!form.address?.trim()) {
      errors.address = "Address is required";
    }
  }

  if (step === 2) {
    if (!form.guardianName?.trim()) {
      errors.guardianName = "Guardian name is required";
    }

    const gPhone = form.guardianPhone?.trim();
    if (!gPhone) {
      errors.guardianPhone = "Guardian phone is required";
    } else if (!/^\+?[\d\s\-()]{7,15}$/.test(gPhone)) {
      errors.guardianPhone = "Enter a valid phone number";
    }

    if (
      form.guardianEmail?.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.guardianEmail)
    ) {
      errors.guardianEmail = "Invalid email address";
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
  try {
    await api.put("/student/profile", payload, { timeout: 10000 });
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
  const user                = useAuthStore((s) => s.user);
  const setUser             = useAuthStore((s) => s.setUser);
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
      "Skip for Now?",
      "You can complete your profile later from Settings. Some features may be limited until your profile is complete.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Skip for Now",
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
  }, [goToDashboard, setProfileCompleted]);

  // ── Navigation ────────────────────────────────────────
  const goNext = useCallback(() => {
    const errs = validateStep(step, form);
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
  }, [step, form]);

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
      Alert.alert("Session Error", "Your session has expired. Please log in again.");
      return;
    }

    try {
      setSaving(true);
      await saveProfile(form, userId);

      // Clear skip flag (profile is now complete) and draft
      await clearStudentProfileSkipFlag();
      await clearDraft(userId);

      const fullName =
        `${form.firstName ?? ""} ${form.lastName ?? ""}`.trim();

      // Update auth store — guard will not fire again
      setProfileCompleted(true);
      setUser?.({ ...user, name: fullName, profileCompleted: true });

      Alert.alert(
        "Profile Saved! 🎉",
        "Your profile has been set up successfully.",
        [{ text: "Continue", onPress: goToDashboard }]
      );
    } catch (err) {
      console.warn("[handleSubmit] unexpected error:", err.message);
      Alert.alert("Save Failed", "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [form, userId, user, setUser, setProfileCompleted, goToDashboard]);

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
                  label="First Name" required
                  value={form.firstName}
                  onChangeText={(v) => set("firstName", v)}
                  placeholder="e.g. John"
                  icon="person-outline"
                  error={errors.firstName}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="Last Name" required
                  value={form.lastName}
                  onChangeText={(v) => set("lastName", v)}
                  placeholder="e.g. Doe"
                  error={errors.lastName}
                />
              </View>
            </View>

            <SelectField
              label="Gender" required
              value={form.gender}
              options={GENDERS}
              onSelect={(v) => set("gender", v)}
              error={errors.gender}
            />

            <DateField
              label="Date of Birth" required
              value={form.dateOfBirth}
              onChange={(ymd) => set("dateOfBirth", ymd)}
              maximumDate={maxBirthday}
              minimumDate={minBirthday}
              error={errors.dateOfBirth}
            />

            <Field
              label="Place of Birth"
              value={form.placeOfBirth}
              onChangeText={(v) => set("placeOfBirth", v)}
              placeholder="City / town you were born in"
              icon="location-outline"
            />

            <Field
              label="National ID / Birth Certificate No."
              value={form.nationalId}
              onChangeText={(v) => set("nationalId", v)}
              placeholder="e.g. BC123456"
              icon="card-outline"
            />

            <SelectField
              label="Blood Group"
              value={form.bloodGroup}
              options={BLOOD_GROUPS}
              onSelect={(v) => set("bloodGroup", v)}
            />

            {/* Repeating toggle */}
            <View style={ss.toggleRow}>
              <View style={ss.toggleLeft}>
                <View style={[ss.toggleIcon, { backgroundColor: "#FEF3C7" }]}>
                  <Ionicons name="repeat-outline" size={18} color="#D97706" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={ss.toggleTitle}>Repeating this year?</Text>
                  <Text style={ss.toggleSub}>
                    Tick if you are repeating this class / grade
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
              label="Health / Medical Conditions (optional)"
              value={form.medicalConditions}
              onChangeText={(v) => set("medicalConditions", v)}
              placeholder="Any known conditions, allergies or disabilities"
              multiline
              icon="medical-outline"
            />

            <Field
              label="About Me (optional)"
              value={form.bio}
              onChangeText={(v) => set("bio", v)}
              placeholder="A short introduction about yourself…"
              multiline
              icon="document-text-outline"
            />
          </>
        );

      case 1:
        return (
          <>
            <Field
              label="Primary Phone" required
              value={form.phone}
              onChangeText={(v) => set("phone", v)}
              placeholder="e.g. +233 20 000 0000"
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.phone}
            />

            <Field
              label="Alternate Phone"
              value={form.alternatePhone}
              onChangeText={(v) => set("alternatePhone", v)}
              placeholder="Optional"
              keyboardType="phone-pad"
              icon="call-outline"
            />

            <Field
              label="Residential Address" required
              value={form.address}
              onChangeText={(v) => set("address", v)}
              placeholder="House / street address"
              icon="home-outline"
              multiline
              error={errors.address}
            />

            <View style={ss.row}>
              <View style={{ flex: 1 }}>
                <Field
                  label="City / Town"
                  value={form.city}
                  onChangeText={(v) => set("city", v)}
                  placeholder="e.g. Accra"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field
                  label="State / Region"
                  value={form.state}
                  onChangeText={(v) => set("state", v)}
                  placeholder="e.g. Greater Accra"
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
                Guardian information is used for emergency contact and school
                communication.
              </Text>
            </View>

            <Field
              label="Guardian Full Name" required
              value={form.guardianName}
              onChangeText={(v) => set("guardianName", v)}
              placeholder="Parent / guardian full name"
              icon="person-outline"
              error={errors.guardianName}
            />

            <Field
              label="Guardian Phone" required
              value={form.guardianPhone}
              onChangeText={(v) => set("guardianPhone", v)}
              placeholder="e.g. +233 20 000 0000"
              keyboardType="phone-pad"
              icon="call-outline"
              error={errors.guardianPhone}
            />

            <SelectField
              label="Relationship to You"
              value={form.guardianRelation}
              options={GUARDIAN_RELATIONS}
              onSelect={(v) => set("guardianRelation", v)}
            />

            <Field
              label="Guardian Email (Optional)"
              value={form.guardianEmail}
              onChangeText={(v) => set("guardianEmail", v)}
              placeholder="guardian@email.com"
              keyboardType="email-address"
              icon="mail-outline"
              error={errors.guardianEmail}
            />
          </>
        );

      default:
        return null;
    }
  }, [step, form, errors, set, minBirthday, maxBirthday]);

  // ─────────────────────────────────────────────────────
  // LOADING STATE
  // ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={ss.loadingScreen}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={ss.loadingText}>Loading your profile…</Text>
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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />
      <View style={ss.screen}>

        {/* TOP BAR */}
        <View style={ss.topBar}>
          <TouchableOpacity onPress={goBack} style={ss.backBtn} hitSlop={8}>
            <Ionicons name="arrow-back" size={22} color={C.gray700} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={ss.topTitle}>Profile Setup</Text>
            <Text style={ss.topSub}>Step {step + 1} of {STEPS.length}</Text>
          </View>
          <TouchableOpacity
            style={ss.skipBtn}
            onPress={handleSkip}
            hitSlop={8}
            activeOpacity={0.7}
          >
            <Text style={ss.skipBtnText}>Skip for now</Text>
          </TouchableOpacity>
        </View>

        {/* SKIP HINT — only on step 0 */}
        {step === 0 && (
          <View style={ss.skipHint}>
            <Ionicons name="information-circle-outline" size={14} color={C.gray400} />
            <Text style={ss.skipHintText}>
              You can skip and complete your profile later from Settings
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
                        color={isCurrent ? C.white : C.gray400}
                      />
                  }
                </View>
                <Text style={[
                  ss.stepLabel,
                  isCurrent && ss.stepLabelActive,
                  isDone    && ss.stepLabelDone,
                ]}>
                  {s.title}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        {/* STEP HEADER */}
        <View style={ss.stepHeader}>
          <Text style={ss.stepTitle}>{STEPS[step].title}</Text>
          <Text style={ss.stepDesc}>{STEPS[step].desc}</Text>
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
              <Text style={ss.backActionText}>Back</Text>
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
                  {step === STEPS.length - 1 ? "Save Profile" : "Next"}
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
  topBar:           { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12, backgroundColor: C.white, gap: 10 },
  backBtn:          { width: 36, height: 36, borderRadius: 10, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  topTitle:         { fontSize: 17, fontWeight: "700", color: C.gray900 },
  topSub:           { fontSize: 12, color: C.gray400, marginTop: 1 },
  skipBtn:          { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1.5, borderColor: C.gray200, backgroundColor: C.gray50 },
  skipBtnText:      { fontSize: 13, fontWeight: "600", color: C.gray500 },
  skipHint:         { flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: C.gray50, borderRadius: 8 },
  skipHintText:     { fontSize: 11, color: C.gray400, flex: 1, lineHeight: 16 },
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
  toggleRow:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: C.gray50, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: C.gray200 },
  toggleLeft:       { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  toggleIcon:       { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  toggleTitle:      { fontSize: 14, fontWeight: "600", color: C.gray900 },
  toggleSub:        { fontSize: 11, color: C.gray400, marginTop: 1 },
  checkbox:         { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: C.gray200, alignItems: "center", justifyContent: "center" },
  checkboxActive:   { backgroundColor: C.primary, borderColor: C.primary },
  bottomBar:        { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 20, paddingVertical: 16, backgroundColor: C.white, gap: 12, borderTopWidth: 1, borderTopColor: C.gray100 },
  backAction:       { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: C.primary },
  backActionText:   { fontSize: 14, fontWeight: "700", color: C.primary },
  nextBtn:          { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12, flex: 1, justifyContent: "center" },
  nextBtnDisabled:  { opacity: 0.6 },
  nextBtnText:      { fontSize: 15, fontWeight: "700", color: C.white },
});
