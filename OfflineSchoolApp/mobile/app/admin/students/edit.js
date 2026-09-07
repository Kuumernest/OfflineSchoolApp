// app/admin/students/edit.js
//
// Correcting a pupil's record — the screen that did not exist.
//
// The office could admit a pupil, approve, suspend, restore, move and delete
// them, and could not fix a mistyped surname. That name prints on report cards,
// identity cards and receipts, and deleting the pupil to re-enter them detaches
// their marks, register and fees, because twenty server collections carry a
// studentId.
//
// Narrower than the record on purpose. Class and status are not here: each has
// its own route and its own consequences — moving a pupil re-bills them for the
// destination class — and a correction form that quietly did either would be
// the more dangerous kind of convenience.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";

import StudentService from "@/services/student.service";
import DateField          from "../../../src/components/DateField";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText }      from "../../../src/utils/appError";

const COLORS = {
  bg:      "#F8FAFC",
  surface: "#FFFFFF",
  border:  "#E2E8F0",
  text:    "#0F172A",
  muted:   "#64748B",
  faint:   "#94A3B8",
  primary: "#2563EB",
  error:   "#DC2626",
  warnBg:  "#FEF3C7",
  warnText:"#92400E",
};

/*
 * The editable fields, grouped as the form shows them.
 *
 * A SUBSET of the server's eighteen, on purpose. The web form offers all of
 * them because an office screen has the room; this is a phone held in a
 * corridor, and the twelve here are the ones somebody corrects while standing
 * in front of the pupil. The six left out — state, nationalId, guardianRelation,
 * bloodGroup, medicalConditions, notes — are office work, and the web form is
 * where they belong.
 *
 * Being a subset is safe in a way that being a superset would not be: the
 * server ignores what it does not recognise, so a field missing here simply
 * cannot be edited from a phone. check-student-edit.js asserts the web form and
 * the desktop handler cover the server's list exactly; this file is deliberately
 * not held to that.
 */
const IDENTITY = [
  { key: "firstName",   labelKey: "common.firstName" },
  { key: "lastName",    labelKey: "common.lastName"  },
  { key: "dateOfBirth", labelKey: "common.dateOfBirth", kind: "date" },
  { key: "gender",      labelKey: "common.gender",      kind: "gender" },
];

const CONTACT = [
  { key: "email",          labelKey: "common.email",              kind: "email" },
  { key: "phone",          labelKey: "common.phone",              kind: "phone" },
  { key: "alternatePhone", labelKey: "studentEdit.alternatePhone", kind: "phone" },
  { key: "address",        labelKey: "common.address",            kind: "multiline" },
  { key: "city",           labelKey: "studentEdit.city" },
];

const GUARDIAN = [
  { key: "guardianName",  labelKey: "academic.guardian" },
  { key: "guardianPhone", labelKey: "studentEdit.guardianPhone", kind: "phone" },
  { key: "guardianEmail", labelKey: "common.email",              kind: "email" },
];

const ALL = [...IDENTITY, ...CONTACT, ...GUARDIAN];

const blank = () => Object.fromEntries(ALL.map((f) => [f.key, ""]));

export default function EditStudentScreen() {
  const { t }    = useTranslation();
  const router   = useRouter();
  const { id }   = useLocalSearchParams();
  const studentId = Array.isArray(id) ? id[0] : id;

  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [form,    setForm]    = useState(blank);
  const [initial, setInitial] = useState(blank);
  const [reason,  setReason]  = useState("");
  /*
   * The updatedAt the form was loaded with.
   *
   * Sent back as baseUpdatedAt so the server can tell somebody else edited this
   * record between the load and the save. The write still goes through —
   * last-write-wins is the rule throughout this app — but the version it
   * replaced is snapshotted, and the person whose edit lost can be shown what
   * happened on the sync-overwrites screen.
   */
  const [baseUpdatedAt, setBase] = useState(null);
  const [who, setWho] = useState({ name: null, enrollmentNo: null, className: null });

  const load = useCallback(async () => {
    if (!studentId) { setLoadErr(t("studentDetail.notFound")); setLoading(false); return; }
    setLoading(true);
    setLoadErr(null);
    try {
      const s = await StudentService.getStudentForEdit(studentId);
      if (!s) { setLoadErr(t("studentDetail.notFound")); return; }
      const next = blank();
      for (const f of ALL) next[f.key] = s[f.key] == null ? "" : String(s[f.key]);
      setForm(next);
      setInitial(next);
      setBase(s.updatedAt ?? null);
      // Read-only context for the header: you are correcting one child's
      // record, and the first question when a correction goes wrong is
      // "whose?". Held separately from the form so it stays correct while
      // the name fields are being edited.
      setWho({
        name:         s.studentName  ?? null,
        enrollmentNo: s.enrollmentNo ?? null,
        className:    s.className    ?? null,
      });
    } catch (err) {
      setLoadErr(errorText(t, err, "studentEdit.errSave"));
    } finally {
      setLoading(false);
    }
  }, [studentId, t]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => ALL.map((f) => f.key).filter((k) => form[k] !== initial[k]),
    [form, initial]
  );

  const set = useCallback(
    (key) => (value) => setForm((prev) => ({ ...prev, [key]: value })),
    []
  );

  const save = useCallback(async () => {
    if (dirty.length === 0) {
      Alert.alert(t("studentEdit.noChanges"), t("studentEdit.noChangesBody"));
      return;
    }

    /*
     * Checked before sending, not after failing.
     *
     * Every student write in this app is online-only — move, suspend, restore
     * and remove all call the API directly. Saying so up front is better than
     * letting the request fail and showing a network error the admin has to
     * interpret.
     */
    const net = await NetInfo.fetch().catch(() => ({ isConnected: true }));
    if (net && net.isConnected === false) {
      Alert.alert(t("studentEdit.errSave"), t("studentEdit.needsConnection"));
      return;
    }

    setSaving(true);
    try {
      // Only what moved. An empty string goes as null so the server clears the
      // field rather than storing "" — "we do not have one" is an answer, and a
      // blank string reads as data.
      const patch = {};
      for (const k of dirty) {
        const v = String(form[k] ?? "").trim();
        patch[k] = v === "" ? null : v;
      }

      const res = await StudentService.updateStudent(studentId, patch, {
        baseUpdatedAt,
        changeReason: reason.trim() || undefined,
      });

      const changed = res?.changed ?? [];
      if (changed.length === 0) {
        Alert.alert(t("studentEdit.noChanges"), t("studentEdit.noChangesBody"));
        return;
      }
      Alert.alert(
        t("studentEdit.saved"),
        t("studentEdit.savedCount", { count: changed.length })
      );
      router.back();
    } catch (err) {
      Alert.alert(t("studentEdit.errSave"), errorText(t, err, "studentEdit.errSave"));
    } finally {
      setSaving(false);
    }
  }, [dirty, form, reason, baseUpdatedAt, studentId, router, t]);

  // ── Field rendering ────────────────────────────────────────────────────────

  const renderField = (f) => {
    const label = t(f.labelKey);

    if (f.kind === "date") {
      return (
        <View key={f.key} style={s.field}>
          <DateField label={label} value={form[f.key]} onChange={set(f.key)} />
        </View>
      );
    }

    if (f.kind === "gender") {
      const options = [
        { value: "male",   label: t("common.male")    },
        { value: "female", label: t("common.female")  },
        { value: "other",  label: t("common.unknown") },
      ];
      return (
        <View key={f.key} style={s.field}>
          <Text style={s.label}>{label}</Text>
          <View style={s.chips}>
            {options.map((o) => {
              const active = form[f.key] === o.value;
              return (
                <TouchableOpacity
                  key={o.value}
                  onPress={() => set(f.key)(active ? "" : o.value)}
                  style={[s.chip, active && s.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[s.chipText, active && s.chipTextOn]}>{o.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      );
    }

    return (
      <View key={f.key} style={s.field}>
        <Text style={s.label}>{label}</Text>
        <TextInput
          style={[s.input, f.kind === "multiline" && s.inputMultiline]}
          value={form[f.key]}
          onChangeText={set(f.key)}
          multiline={f.kind === "multiline"}
          keyboardType={
            f.kind === "email" ? "email-address"
            : f.kind === "phone" ? "phone-pad"
            : "default"
          }
          autoCapitalize={f.kind === "email" ? "none" : "words"}
          autoCorrect={false}
          placeholderTextColor={COLORS.faint}
        />
      </View>
    );
  };

  const section = (titleKey, fields, hintKey) => (
    <View style={s.card}>
      <Text style={s.cardTitle}>{t(titleKey)}</Text>
      {hintKey ? <Text style={s.cardHint}>{t(hintKey)}</Text> : null}
      {fields.map(renderField)}
    </View>
  );

  // ── Screen ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
        <View style={s.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      </SafeAreaView>
    );
  }

  if (loadErr) {
    return (
      <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={32} color={COLORS.error} />
          <Text style={s.errText}>{loadErr}</Text>
          <TouchableOpacity onPress={() => router.back()} style={s.secondaryBtn}>
            <Text style={s.secondaryBtnText}>{t("common.cancel")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={s.backBtn}
          accessibilityRole="button"
          accessibilityLabel={t("common.cancel")}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <View style={s.headerText}>
          <Text style={s.title} numberOfLines={1}>
            {who.name || t("studentEdit.title")}
          </Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {[who.enrollmentNo, who.className].filter(Boolean).join(" · ")
              || t("studentEdit.blurb")}
          </Text>
        </View>
      </View>

      {/*
        "height" on Android, not undefined. An undefined behavior makes
        KeyboardAvoidingView inert there, so the keyboard covers the field being
        typed into — which is the whole reason the wrapper is here. scripts/check.js
        asserts no screen ships that way.
      */}
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {section("studentEdit.identity", IDENTITY, "studentEdit.identityHint")}
          {section("studentEdit.contact",  CONTACT)}
          {section("studentEdit.guardian", GUARDIAN)}

          <View style={s.card}>
            <Text style={s.cardTitle}>{t("studentEdit.reason")}</Text>
            <TextInput
              style={s.input}
              value={reason}
              onChangeText={setReason}
              placeholder={t("studentEdit.reasonPh")}
              placeholderTextColor={COLORS.faint}
            />
          </View>
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity
            onPress={save}
            disabled={saving || dirty.length === 0}
            style={[s.primaryBtn, (saving || dirty.length === 0) && s.primaryBtnOff]}
            accessibilityRole="button"
          >
            {saving
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={s.primaryBtnText}>{t("studentEdit.save")}</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: COLORS.bg },
  flex:   { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn:    { padding: 6, borderRadius: 10 },
  headerText: { flex: 1, minWidth: 0 },
  title:      { fontSize: 17, fontWeight: "700", color: COLORS.text },
  subtitle:   { fontSize: 12, color: COLORS.muted, marginTop: 2 },

  scroll: { padding: 16, gap: 14, paddingBottom: 24 },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: COLORS.border, gap: 12,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: COLORS.text },
  cardHint:  { fontSize: 11, color: COLORS.muted, marginTop: -6 },

  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "600", color: COLORS.muted },
  input: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: COLORS.text, backgroundColor: COLORS.surface,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },

  chips:      { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.bg,
  },
  chipOn:      { borderColor: COLORS.primary, backgroundColor: "#EFF6FF" },
  chipText:    { fontSize: 12, fontWeight: "600", color: COLORS.muted },
  chipTextOn:  { color: COLORS.primary },

  footer: {
    padding: 16, backgroundColor: COLORS.surface,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  primaryBtn: {
    backgroundColor: COLORS.primary, borderRadius: 12,
    paddingVertical: 13, alignItems: "center", justifyContent: "center",
  },
  primaryBtnOff:  { opacity: 0.5 },
  primaryBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },

  secondaryBtn: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface,
  },
  secondaryBtnText: { fontSize: 13, fontWeight: "600", color: COLORS.text },

  errText: { fontSize: 13, color: COLORS.muted, textAlign: "center" },
});
