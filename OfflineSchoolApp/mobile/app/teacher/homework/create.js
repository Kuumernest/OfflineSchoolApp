// app/teacher/homework/create.js
//
// Set a homework, or change one. With ?id= it edits; without, it creates.
//
// The class and subject pickers offer what the server says this teacher
// teaches — the same teacherScope the quiz screens read — and nothing else.
// That is the offer, not the rule: the server checks the pair against
// TeacherAssignment on every write and refuses anything a picker would not
// have shown. Writes go to the phone's tables and the outbox, so the screen
// works without a network and the homework reaches the server when one
// returns.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  ActivityIndicator, TextInput, Alert, Switch, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useAuthStore }    from "../../../src/store/auth.store";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import {
  createHomework, updateHomework, getHomeworkById,
} from "../../../src/services/homework.service";
import { fetchTeacherScope } from "../../../src/services/teacherScope.service";
import { errorText }       from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, levelAccent } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const EMPTY = {
  class_id: null, subject_id: null, title: "", description: "", instructions: "",
  due_date: "", max_score: "100", allow_late: true, is_published: false,
};

/** "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" → ISO, or null for empty, or false for junk. */
const parseDue = (raw) => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 23), Number(m[5] ?? 59));
  return Number.isNaN(d.getTime()) ? false : d.toISOString();
};

/** ISO → the form's text, in local time. */
const dueToInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
  return endOfDay ? date : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Lives outside the screen on purpose. Defined inside, each keystroke made a
// new Field type, React remounted the TextInput under it, and the keyboard
// closed after one character.
const Field = ({ label, error, children, hint, icon, accent = "indigo" }) => (
  <View style={styles.field}>
    <View style={styles.labelRow}>
      {icon ? <IconSquare icon={icon} accent={accent} size={28} /> : null}
      <Text style={styles.label}>{label}</Text>
    </View>
    {children}
    {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>
);

export default function TeacherHomeworkCreateScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const editing = Boolean(id);
  const { t } = useTranslation();
  const screenPad = useScreenInsets({ top: 16, bottom: 28 });
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;

  const [scope,   setScope]   = useState(null);
  const [form,    setForm]    = useState(EMPTY);
  const [errors,  setErrors]  = useState({});
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [dirty,   setDirty]   = useState(false);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); setErrors((e) => ({ ...e, [k]: undefined })); };

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [nextScope, hw] = await Promise.all([
          teacherId ? fetchTeacherScope({ teacherId, schoolId }) : null,
          editing ? getHomeworkById(String(id)) : null,
        ]);
        if (!live) return;
        setScope(nextScope);
        if (editing) {
          if (!hw) {
            Alert.alert(t("common.error"), t("teacherHw.notFound"), [{ text: t("common.ok"), onPress: () => router.back() }]);
            return;
          }
          setForm({
            class_id: String(hw.class_id), subject_id: String(hw.subject_id),
            title: hw.title ?? "", description: hw.description ?? "", instructions: hw.instructions ?? "",
            due_date: dueToInput(hw.due_date), max_score: String(hw.max_score ?? 100),
            allow_late: Number(hw.allow_late) !== 0, is_published: Number(hw.is_published) === 1,
          });
        }
      } catch (err) {
        if (live) Alert.alert(t("common.error"), errorText(t, err, "teacherHw.loadFailed"));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, teacherId, schoolId]);

  const classes  = scope?.classes ?? [];
  const subjects = useMemo(
    () => (form.class_id ? (scope?.subjectsByClassId?.[form.class_id] ?? []) : []),
    [scope, form.class_id]
  );

  const validate = useCallback(() => {
    const e = {};
    if (!form.class_id)                e.class_id   = t("teacherHw.errClassRequired");
    if (!form.subject_id)              e.subject_id = t("teacherHw.errSubjectRequired");
    if (!form.title.trim())            e.title      = t("teacherHw.errTitleRequired");
    const due = parseDue(form.due_date);
    if (due === false)                 e.due_date   = t("teacherHw.errInvalidDate");
    else if (due && !editing && new Date(due) < new Date()) e.due_date = t("teacherHw.errDatePast");
    const max = Number(form.max_score);
    if (!Number.isFinite(max) || max <= 0) e.max_score = t("teacherHw.errMaxScore");
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [form, editing, t]);

  const save = useCallback(async (publish) => {
    if (!validate()) return;
    if (!schoolId || !teacherId) { Alert.alert(t("common.error"), t("teacherHw.sessionError")); return; }
    setSaving(true);
    try {
      const due = parseDue(form.due_date);
      const isPublished = publish ?? form.is_published;
      if (editing) {
        await updateHomework(String(id), {
          title: form.title.trim(), description: form.description.trim() || null,
          instructions: form.instructions.trim() || null, due_date: due,
          max_score: Number(form.max_score), allow_late: form.allow_late ? 1 : 0,
          is_published: isPublished ? 1 : 0,
        });
      } else {
        await createHomework({
          schoolId: String(schoolId), class_id: form.class_id, subject_id: form.subject_id,
          created_by: String(teacherId), title: form.title.trim(),
          description: form.description.trim() || null, instructions: form.instructions.trim() || null,
          due_date: due, max_score: Number(form.max_score), allow_late: form.allow_late,
          is_published: isPublished,
        });
      }
      setDirty(false);
      Alert.alert(
        t(editing ? "teacherHw.updated" : "teacherHw.created"),
        isPublished ? t("teacherHw.savedPublishedBody") : t("teacherHw.savedDraftBody"),
        [{ text: t("common.ok"), onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err, "teacherHw.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [validate, form, editing, id, schoolId, teacherId, router, t]);

  const leave = () => {
    if (!dirty) { router.back(); return; }
    Alert.alert(t("teacherHw.discardTitle"), t("teacherHw.discardBody"), [
      { text: t("teacherHw.keepEditing"), style: "cancel" },
      { text: t("common.discard"), style: "destructive", onPress: () => router.back() },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={ACCENT.indigo.solid} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.surface} />
      <View style={[styles.header, { paddingTop: screenPad.paddingTop }]}>
        <TouchableOpacity onPress={leave} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <Text style={styles.headerTitle}>{t(editing ? "teacherHw.editTitle" : "teacherHw.createTitle")}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Class */}
        <Field label={t("academic.class")} error={errors.class_id} icon="school"
          hint={editing ? t("teacherHw.classLocked") : undefined}>
          {classes.length === 0 ? (
            <Text style={styles.muted}>{t("teacherHw.noScopeSub")}</Text>
          ) : (
            <View style={styles.chipWrap}>
              {classes.map((c) => {
                const active = form.class_id === c.id;
                const lvl = ACCENT[levelAccent(c.level ?? c.name)];
                return (
                  <TouchableOpacity key={c.id} disabled={editing}
                    style={[styles.chip, active && styles.chipActive, active && { backgroundColor: lvl.wash, borderColor: lvl.base }, editing && !active && styles.chipDisabled]}
                    onPress={() => { set("class_id", c.id); set("subject_id", null); }}>
                    <Text style={[styles.chipText, active && styles.chipTextActive, active && { color: lvl.deep }]}>{c.name || c.id}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </Field>

        {/* Subject */}
        <Field label={t("academic.subject")} error={errors.subject_id} icon="book" accent="slate">
          {!form.class_id ? (
            <Text style={styles.muted}>{t("teacherHw.selectClassFirst")}</Text>
          ) : subjects.length === 0 ? (
            <Text style={styles.muted}>{t("teacherHw.noSubjectsForClass")}</Text>
          ) : (
            <View style={styles.chipWrap}>
              {subjects.map((s) => {
                const active = form.subject_id === s.id;
                return (
                  <TouchableOpacity key={s.id} disabled={editing}
                    style={[styles.chip, active && styles.chipActive, active && { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base }, editing && !active && styles.chipDisabled]}
                    onPress={() => set("subject_id", s.id)}>
                    <Text style={[styles.chipText, active && styles.chipTextActive, active && { color: ACCENT.slate.deep }]}>{s.name || s.id}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </Field>

        <Field label={t("teacherHw.titleLabel")} error={errors.title} icon="text">
          <TextInput style={[styles.input, errors.title && styles.inputError]} value={form.title}
            onChangeText={(v) => set("title", v)} placeholder={t("teacherHw.titlePh")} placeholderTextColor="#9CA3AF" maxLength={250} />
        </Field>

        <Field label={t("teacherHw.descriptionLabel")} icon="document-text">
          <TextInput style={[styles.input, styles.multiline]} value={form.description} multiline
            onChangeText={(v) => set("description", v)} placeholder={t("teacherHw.descriptionPh")} placeholderTextColor="#9CA3AF" />
        </Field>

        <Field label={t("teacherHw.instructionsLabel")} icon="list">
          <TextInput style={[styles.input, styles.multiline]} value={form.instructions} multiline
            onChangeText={(v) => set("instructions", v)} placeholder={t("teacherHw.instructionsPh")} placeholderTextColor="#9CA3AF" />
        </Field>

        <Field label={t("teacherHw.dueDateLabel")} error={errors.due_date} hint={t("teacherHw.dueDateHint")} icon="calendar" accent="amber">
          <TextInput style={[styles.input, errors.due_date && styles.inputError]} value={form.due_date}
            onChangeText={(v) => set("due_date", v)} placeholder={t("teacherHw.dueDatePh")} placeholderTextColor="#9CA3AF"
            autoCapitalize="none" autoCorrect={false} />
        </Field>

        <Field label={t("teacherHw.maxScoreLabel")} error={errors.max_score} icon="trophy">
          <TextInput style={[styles.input, errors.max_score && styles.inputError]} value={form.max_score}
            onChangeText={(v) => set("max_score", v.replace(/[^\d.]/g, ""))} keyboardType="numeric" />
        </Field>

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t("teacherHw.allowLate")}</Text>
          <Switch value={form.allow_late} onValueChange={(v) => set("allow_late", v)} trackColor={{ true: ACCENT.indigo.base + "66" }} thumbColor={form.allow_late ? ACCENT.indigo.solid : COLORS.border} />
        </View>
        <Text style={styles.hint}>{t("teacherHw.publishHint")}</Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: screenPad.paddingBottom }]}>
        <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => save(false)} disabled={saving} activeOpacity={0.8}>
          {saving ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.btnSecondaryText}>{t("teacherHw.saveDraft")}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => save(true)} disabled={saving} activeOpacity={0.8}>
          {saving ? <ActivityIndicator color="#FFF" /> : (
            <>
              <Ionicons name="send-outline" size={16} color={COLORS.onPrimary} />
              <Text style={styles.btnPrimaryText}>{t("teacherHw.savePublish")}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.page },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.page },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 0, paddingBottom: 14,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 10,
  },
  backButton: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  headerIcon: { marginRight: 0 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text, flex: 1 },
  body: { padding: 16, paddingBottom: 32, gap: 16 },
  field: { gap: 6 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 13, fontWeight: "700", color: COLORS.text },
  hint: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },
  error: { fontSize: 12, color: SEMANTIC.error.text, fontWeight: "600" },
  muted: { fontSize: 13, color: COLORS.textSecondary, fontStyle: "italic" },
  input: {
    backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.text,
  },
  inputError: { borderColor: SEMANTIC.error.icon },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  chipDisabled: { opacity: 0.45 },
  chipText: { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  chipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },
  switchRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
  },
  switchLabel: { fontSize: 14, color: COLORS.text, fontWeight: "500", flex: 1 },
  footer: {
    flexDirection: "row", gap: 10, padding: 16, backgroundColor: COLORS.surface,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 12, paddingVertical: 13 },
  btnSecondary: { backgroundColor: ACCENT.indigo.wash, borderWidth: 1, borderColor: ACCENT.indigo.base + "4D" },
  btnSecondaryText: { color: ACCENT.indigo.deep, fontWeight: "700", fontSize: 14 },
  btnPrimary: { backgroundColor: ACCENT.indigo.solid },
  btnPrimaryText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
});
