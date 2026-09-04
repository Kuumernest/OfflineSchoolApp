// mobile/app/admin/subjects/add.js
import { useState, useCallback, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert,
  StyleSheet, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "@/store/auth.store";
import { getDatabase }    from "@/db/database";
import api              from "@/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const MAX_NAME = 80;
const MAX_CODE = 20;
const EXAMPLE_KEYS = [
  "subjectsAdd.exMath",
  "subjectsAdd.exEnglish",
  "subjectsAdd.exBiology",
  "subjectsAdd.exHistory",
];
const INITIAL  = { name: "", code: "", coefficient: "", classIds: [], teacherId: "" };

// SQLite rows use `id` as the primary key, while this screen (and the rest of
// the app's objects) read `_id`. Normalise once at load so key prop, includes,
// toggle and find() all see a real id. Matches mapRowToAnnouncement.
const mapRowsToObjects = (rows) =>
  (rows || []).map((row) => ({
    ...row,
    id:       row.id       || row._id,
    _id:      row._id      || row.id,
    schoolId: row.schoolId || row.school_id,
  }));

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const validate = (form, t) => {
  const errors = {};
  const name   = form.name.trim();

  if (!name)              errors.name     = t("subjectsAdd.errNameRequired");
  else if (name.length < 2)   errors.name = t("subjectsAdd.errNameShort");
  else if (name.length > MAX_NAME)
    errors.name = t("subjectsAdd.errNameLong", { max: MAX_NAME });

  if (form.classIds.length === 0)
    errors.classIds = t("subjectsAdd.errNoClass");

  // Optional, but a coefficient of 0 or a typo would rescale every average in
  // the class, so anything present must be a sane positive number.
  const coeff = form.coefficient.trim();
  if (coeff !== "") {
    const n = Number(coeff);
    if (!Number.isFinite(n))  errors.coefficient = t("subjectsAdd.errCoeffNumber");
    else if (n < 0.1)         errors.coefficient = t("subjectsAdd.errCoeffMin");
    else if (n > 20)          errors.coefficient = t("subjectsAdd.errCoeffMax");
  }

  return errors;
};

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function ResultsSummary({ results, subjectName, onDone, onAddAnother }) {
  const { t } = useTranslation();
  const succeeded = results.filter((r) => r.ok);
  const failed    = results.filter((r) => !r.ok);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.resultsHeading}>
        "{subjectName}" — Results
      </Text>

      {succeeded.length > 0 && (
        <View style={[styles.resultCard, styles.resultSuccess]}>
          <Text style={styles.resultCardTitle}>
            ✅ Created in {succeeded.length}{" "}
            {succeeded.length === 1 ? "class" : "classes"}
          </Text>
          {succeeded.map((r) => (
            <Text key={r.classId} style={styles.resultSuccessItem}>
              • {r.className}
            </Text>
          ))}
        </View>
      )}

      {failed.length > 0 && (
        <View style={[styles.resultCard, styles.resultFail]}>
          <Text style={styles.resultCardTitleFail}>
            ❌ Failed in {failed.length}{" "}
            {failed.length === 1 ? "class" : "classes"}
          </Text>
          {failed.map((r) => (
            <View key={r.classId}>
              <Text style={styles.resultFailItem}>• {r.className}</Text>
              {r.error && (
                <Text style={styles.resultFailErr}>  {r.error}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity onPress={onAddAnother} style={styles.outlineBtn}>
        <Text style={styles.outlineBtnText}>{t("subjectsAdd.another")}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={onDone} style={styles.primaryBtn}>
        <Text style={styles.primaryBtnText}>{t("common.done")}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function AddSubjectScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const { user } = useAuthStore();
  const schoolId = user?.schoolId ?? "";

  const [form,        setForm]        = useState(INITIAL);
  const [errors,      setErrors]      = useState({});
  const [classes,     setClasses]     = useState([]);
  const [teachers,    setTeachers]    = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [submitting,  setSubmitting]  = useState(false);
  const [results,     setResults]     = useState(null);

  // ── Load classes + teachers from SQLite ─────────────────

  useEffect(() => {
    (async () => {
      try {
        const db  = await getDatabase();

        const cls = await db.getAllAsync(
          "SELECT * FROM classes WHERE schoolId = ? ORDER BY name ASC",
          [schoolId]
        );

        let tch = [];
        try {
          tch = await db.getAllAsync(
            "SELECT * FROM teachers WHERE schoolId = ? ORDER BY name ASC",
            [schoolId]
          );
        } catch { /* teachers table optional */ }

        setClasses(mapRowsToObjects(cls));
        setTeachers(mapRowsToObjects(tch));
      } catch (err) {
        console.warn("AddSubject: failed to load data", err);
      } finally {
        setLoadingData(false);
      }
    })();
  }, [schoolId]);

  // ── Class toggle helpers ────────────────────────────────

  const allSelected = classes.length > 0 &&
    classes.every((c) => form.classIds.includes(c._id));

  const toggleClass = useCallback((id) => {
    setForm((prev) => ({
      ...prev,
      classIds: prev.classIds.includes(id)
        ? prev.classIds.filter((x) => x !== id)
        : [...prev.classIds, id],
    }));
    setErrors((prev) => ({ ...prev, classIds: undefined }));
  }, []);

  const toggleAll = useCallback(() => {
    setForm((prev) => ({
      ...prev,
      classIds: allSelected ? [] : classes.map((c) => c._id),
    }));
    setErrors((prev) => ({ ...prev, classIds: undefined }));
  }, [allSelected, classes]);

  const removeClass = useCallback((id) => {
    setForm((prev) => ({
      ...prev,
      classIds: prev.classIds.filter((x) => x !== id),
    }));
  }, []);

  // ── Submit ──────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const errs = validate(form, t);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setSubmitting(true);

    const outcomes = [];

    for (const cid of form.classIds) {
      const cls = classes.find((c) => c._id === cid);
      try {
        // "/admin/subjects" — the only route that serves this; the old
        // "/subjects" had no handler and every create 404'd.
        await api.post("/admin/subjects", {
          name:        form.name.trim(),
          code:        form.code.trim() || undefined,
          classId:     cid,
          teacherId:   form.teacherId || undefined,
          coefficient: form.coefficient.trim() || undefined,
          schoolId,
        });
        outcomes.push({ classId: cid, className: cls?.name ?? cid, ok: true });
      } catch (err) {
        const msg =
          err?.response?.data?.message ||
          errorText(t, err, "subjectsAdd.unknownError");
        outcomes.push({ classId: cid, className: cls?.name ?? cid, ok: false, error: msg });
      }
    }

    setSubmitting(false);

    // If single class and all succeeded → navigate away
    if (outcomes.length === 1 && outcomes[0].ok) {
      router.push("/admin/subjects");
      return;
    }

    setResults(outcomes);
  }, [form, t, classes, schoolId, router]);

  // ── Discard ─────────────────────────────────────────────

  const handleDiscard = useCallback(() => {
    const isDirty =
      form.name.trim()        !== "" ||
      form.code.trim()        !== "" ||
      form.coefficient.trim() !== "" ||
      form.classIds.length > 0   ||
      form.teacherId      !== "";

    if (!isDirty) { router.back(); return; }

    Alert.alert(
      t("subjectsAdd.discardTitle"),
      t("subjectsAdd.discardBody"),
      [
        { text: t("subjectsAdd.keepEditing"), style: "cancel" },
        { text: t("subjectsAdd.discard"), style: "destructive", onPress: () => router.back() },
      ]
    );
  }, [form, router, t]);

  const nameLen    = form.name.trim().length;
  const nearLimit  = nameLen > MAX_NAME - 15;

  // ─────────────────────────────────────────────────────────
  // RESULTS VIEW
  // ─────────────────────────────────────────────────────────

  if (results) {
    return (
      <View style={{ flex: 1, backgroundColor: "#F9FAFB" }}>
        <ScreenHeader title={t("subjectsAdd.created")} onBack={() => router.push("/admin/subjects")} />
        <ResultsSummary
          results={results}
          subjectName={form.name.trim()}
          onDone={() => router.push("/admin/subjects")}
          onAddAnother={() => {
            setForm(INITIAL);
            setResults(null);
            setErrors({});
          }}
        />
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // FORM VIEW
  // ─────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#F9FAFB" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScreenHeader
        title={t("subjectsAdd.title")}
        subtitle={t("subjectsAdd.blurb")}
        onBack={handleDiscard}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Info banner */}
        <View style={styles.infoBanner}>
          <Ionicons name="book-outline" size={15} color="#1D4ED8" />
          <Text style={styles.infoBannerText}>
            {t("subjectsAdd.multiHint")}
          </Text>
        </View>

        <View style={styles.card}>

          {/* Subject name */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>
              {t("subjectsAdd.nameLabel")} <Text style={{ color: "#EF4444" }}>*</Text>
            </Text>
            <View style={[styles.inputWrap, errors.name && styles.inputError]}>
              <Ionicons
                name="book-outline"
                size={16}
                color={errors.name ? "#EF4444" : "#9CA3AF"}
              />
              <TextInput
                value={form.name}
                onChangeText={(v) => {
                  setForm((p) => ({ ...p, name: v }));
                  setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder={t("subjectsAdd.namePh")}
                placeholderTextColor="#D1D5DB"
                maxLength={MAX_NAME + 5}
                autoFocus
                returnKeyType="next"
                style={styles.input}
              />
              {nameLen > 0 && (
                <Text style={[
                  styles.charCount,
                  nearLimit && nameLen <= MAX_NAME && styles.charNear,
                  nameLen > MAX_NAME && styles.charOver,
                ]}>
                  {nameLen}/{MAX_NAME}
                </Text>
              )}
            </View>

            {errors.name ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={12} color="#DC2626" />
                <Text style={styles.errorText}>{errors.name}</Text>
              </View>
            ) : (
              <Text style={styles.hint}>{t("subjectsAdd.nameHint")}</Text>
            )}

            {/* Example chips */}
            <View style={styles.examplesRow}>
              <Text style={styles.examplesLabel}>{t("subjectsAdd.examples")}</Text>
              {EXAMPLE_KEYS.map((exKey) => (
                <TouchableOpacity
                  key={exKey}
                  onPress={() => {
                    setForm((p) => ({ ...p, name: t(exKey) }));
                    setErrors((p) => ({ ...p, name: undefined }));
                  }}
                  style={styles.exampleChip}
                >
                  <Text style={styles.exampleChipText}>{t(exKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Subject code */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>{t("subjectsAdd.codeLabel")}</Text>
            <TextInput
              value={form.code}
              onChangeText={(v) => setForm((p) => ({ ...p, code: v }))}
              placeholder={t("subjectsAdd.codePh")}
              placeholderTextColor="#D1D5DB"
              maxLength={MAX_CODE}
              style={styles.inputStandalone}
            />
            <Text style={styles.hint}>{t("subjectsAdd.codeHint")}</Text>
          </View>

          {/* Subject coefficient */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>{t("subjectsAdd.coeffLabel")}</Text>
            <TextInput
              value={form.coefficient}
              onChangeText={(v) => {
                setForm((p) => ({ ...p, coefficient: v }));
                setErrors((p) => ({ ...p, coefficient: undefined }));
              }}
              placeholder={t("subjectsAdd.coeffPh")}
              placeholderTextColor="#D1D5DB"
              keyboardType="decimal-pad"
              maxLength={5}
              style={[
                styles.inputStandalone,
                errors.coefficient && styles.inputError,
              ]}
            />
            {errors.coefficient ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={12} color="#DC2626" />
                <Text style={styles.errorText}>{errors.coefficient}</Text>
              </View>
            ) : (
              <Text style={styles.hint}>
                {t("subjectsAdd.coeffHint")}
              </Text>
            )}
          </View>

          {/* Classes multi-select */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>
              {t("subjectsAdd.classesLabel")} <Text style={{ color: "#EF4444" }}>*</Text>
            </Text>

            <View style={[
              styles.classList,
              errors.classIds && styles.inputError,
            ]}>
              {loadingData ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color="#4F46E5" />
                  <Text style={styles.hint}>{t("subjectsAdd.loadingClasses")}</Text>
                </View>
              ) : classes.length === 0 ? (
                <Text style={[styles.hint, { padding: 12 }]}>
                  {t("subjectsAdd.noClasses")}
                </Text>
              ) : (
                <>
                  {/* Select all */}
                  <TouchableOpacity
                    onPress={toggleAll}
                    disabled={submitting}
                    style={styles.classSelectAll}
                  >
                    <Ionicons
                      name={allSelected ? "checkbox-outline" : "square-outline"}
                      size={18}
                      color={allSelected ? "#4F46E5" : "#9CA3AF"}
                    />
                    <Text style={styles.classSelectAllText}>
                      {allSelected ? t("subjectsAdd.deselectAll") : t("subjectsAdd.selectAll")}
                    </Text>
                    <Text style={styles.classCountBadge}>
                      {form.classIds.length}/{classes.length}
                    </Text>
                  </TouchableOpacity>

                  {/* Class rows */}
                  {classes.map((cls, i) => {
                    const checked = form.classIds.includes(cls._id);
                    return (
                      <TouchableOpacity
                        key={cls._id}
                        onPress={() => toggleClass(cls._id)}
                        disabled={submitting}
                        style={[
                          styles.classRow,
                          i < classes.length - 1 && styles.classRowBorder,
                          checked && styles.classRowChecked,
                        ]}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={checked ? "checkbox-outline" : "square-outline"}
                          size={18}
                          color={checked ? "#4F46E5" : "#D1D5DB"}
                        />
                        <Text style={[
                          styles.className,
                          checked && styles.classNameChecked,
                        ]}>
                          {cls.name}
                        </Text>
                        {cls.level && (
                          <Text style={styles.classLevel}>Level {cls.level}</Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}
            </View>

            {errors.classIds && (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={12} color="#DC2626" />
                <Text style={styles.errorText}>{errors.classIds}</Text>
              </View>
            )}

            {/* Selected chips */}
            {form.classIds.length > 0 && (
              <View style={styles.chipsRow}>
                {form.classIds.map((id) => {
                  const cls = classes.find((c) => c._id === id);
                  return (
                    <View key={id} style={styles.chip}>
                      <Ionicons name="school-outline" size={11} color="#4338CA" />
                      <Text style={styles.chipText}>{cls?.name ?? id}</Text>
                      <TouchableOpacity onPress={() => removeClass(id)}>
                        <Ionicons name="close" size={12} color="#6366F1" />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          {/* Teacher picker */}
          {teachers.length > 0 && (
            <View style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>{t("subjectsAdd.teacherLabel")}</Text>
              <Text style={styles.hint}>
                {t("subjectsAdd.teacherHint")}
              </Text>

              <View style={styles.classList}>
                {/* No teacher option */}
                <TouchableOpacity
                  onPress={() => setForm((p) => ({ ...p, teacherId: "" }))}
                  style={[
                    styles.classRow,
                    styles.classRowBorder,
                    form.teacherId === "" && styles.classRowChecked,
                  ]}
                >
                  <Ionicons
                    name={form.teacherId === "" ? "radio-button-on" : "radio-button-off"}
                    size={18}
                    color={form.teacherId === "" ? "#4F46E5" : "#D1D5DB"}
                  />
                  <Text style={[
                    styles.className,
                    form.teacherId === "" && styles.classNameChecked,
                  ]}>
                    {t("subjectsAdd.noTeacher")}
                  </Text>
                </TouchableOpacity>

                {teachers.map((teacher, i) => (
                  <TouchableOpacity
                    key={teacher._id}
                    onPress={() => setForm((p) => ({ ...p, teacherId: teacher._id }))}
                    style={[
                      styles.classRow,
                      i < teachers.length - 1 && styles.classRowBorder,
                      form.teacherId === teacher._id && styles.classRowChecked,
                    ]}
                    disabled={submitting}
                  >
                    <Ionicons
                      name={form.teacherId === teacher._id
                        ? "radio-button-on"
                        : "radio-button-off"}
                      size={18}
                      color={form.teacherId === teacher._id ? "#4F46E5" : "#D1D5DB"}
                    />
                    <Text style={[
                      styles.className,
                      form.teacherId === teacher._id && styles.classNameChecked,
                    ]}>
                      {teacher.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Submit */}
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={submitting}
            style={[styles.submitBtn, submitting && styles.submitDisabled]}
            activeOpacity={0.8}
          >
            {submitting ? (
              <>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.submitText}>
                  Creating in {form.classIds.length}{" "}
                  {form.classIds.length === 1 ? "class" : "classes"}…
                </Text>
              </>
            ) : (
              <>
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
                <Text style={styles.submitText}>
                  {t("subjectsAdd.submit")}
                  {form.classIds.length > 1
                    ? ` (${form.classIds.length} classes)`
                    : ""}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Discard */}
          <TouchableOpacity
            onPress={handleDiscard}
            disabled={submitting}
            style={styles.discardBtn}
          >
            <Text style={styles.discardText}>{t("subjectsAdd.discardGoBack")}</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────

function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Ionicons name="arrow-back" size={20} color="#374151" />
      </TouchableOpacity>
      <View>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle && <Text style={styles.headerSub}>{subtitle}</Text>}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:        { padding: 16, gap: 14 },

  header:        { flexDirection: "row", alignItems: "center", gap: 12,
                   backgroundColor: "#fff", borderBottomWidth: 1,
                   borderBottomColor: "#E5E7EB", paddingHorizontal: 16, paddingVertical: 14 },
  backBtn:       { width: 38, height: 38, borderRadius: 10, backgroundColor: "#F3F4F6",
                   alignItems: "center", justifyContent: "center" },
  headerTitle:   { fontSize: 17, fontWeight: "800", color: "#111827" },
  headerSub:     { fontSize: 12, color: "#6B7280", marginTop: 1 },

  infoBanner:     { flexDirection: "row", alignItems: "flex-start", gap: 10,
                    backgroundColor: "#EFF6FF", borderRadius: 12, borderWidth: 1,
                    borderColor: "#BFDBFE", padding: 14 },
  infoBannerText: { flex: 1, fontSize: 13, color: "#1E40AF", lineHeight: 19 },

  card:          { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1,
                   borderColor: "#E5E7EB", padding: 16, gap: 16,
                   shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, elevation: 2 },

  fieldWrap:     { gap: 6 },
  fieldLabel:    { fontSize: 14, fontWeight: "700", color: "#374151" },
  inputWrap:     { flexDirection: "row", alignItems: "center", gap: 10,
                   borderWidth: 2, borderColor: "#E5E7EB", borderRadius: 12,
                   backgroundColor: "#F9FAFB", paddingHorizontal: 14, paddingVertical: 12 },
  inputStandalone: { borderWidth: 2, borderColor: "#E5E7EB", borderRadius: 12,
                     backgroundColor: "#F9FAFB", paddingHorizontal: 14, paddingVertical: 12,
                     fontSize: 14, color: "#111827" },
  inputError:    { borderColor: "#F87171", backgroundColor: "#FEF2F2" },
  input:         { flex: 1, fontSize: 14, color: "#111827" },
  hint:          { fontSize: 12, color: "#9CA3AF" },
  errorRow:      { flexDirection: "row", alignItems: "center", gap: 4 },
  errorText:     { fontSize: 12, color: "#DC2626", fontWeight: "600" },
  charCount:     { fontSize: 11, color: "#D1D5DB" },
  charNear:      { color: "#D97706", fontWeight: "600" },
  charOver:      { color: "#DC2626", fontWeight: "700" },

  // Examples
  examplesRow:   { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  examplesLabel: { fontSize: 11, color: "#9CA3AF" },
  exampleChip:   { backgroundColor: "#EEF2FF", borderRadius: 8,
                   paddingHorizontal: 10, paddingVertical: 5 },
  exampleChipText: { fontSize: 12, fontWeight: "700", color: "#4F46E5" },

  // Class list
  classList:       { borderWidth: 2, borderColor: "#E5E7EB", borderRadius: 12,
                     overflow: "hidden" },
  loadingRow:      { flexDirection: "row", alignItems: "center", gap: 8, padding: 14 },
  classSelectAll:  { flexDirection: "row", alignItems: "center", gap: 10,
                     backgroundColor: "#F3F4F6", borderBottomWidth: 1,
                     borderBottomColor: "#E5E7EB", paddingHorizontal: 14, paddingVertical: 12 },
  classSelectAllText: { flex: 1, fontSize: 12, fontWeight: "700", color: "#374151",
                        textTransform: "uppercase", letterSpacing: 0.5 },
  classCountBadge: { fontSize: 12, color: "#9CA3AF" },
  classRow:        { flexDirection: "row", alignItems: "center", gap: 10,
                     paddingHorizontal: 14, paddingVertical: 13 },
  classRowBorder:  { borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  classRowChecked: { backgroundColor: "#EEF2FF" },
  className:       { flex: 1, fontSize: 14, color: "#374151" },
  classNameChecked: { fontWeight: "700", color: "#3730A3" },
  classLevel:      { fontSize: 12, color: "#9CA3AF" },

  // Chips
  chipsRow:        { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:            { flexDirection: "row", alignItems: "center", gap: 4,
                     backgroundColor: "#EEF2FF", borderRadius: 8,
                     paddingHorizontal: 10, paddingVertical: 5 },
  chipText:        { fontSize: 12, fontWeight: "700", color: "#4338CA" },

  // Submit
  submitBtn:       { flexDirection: "row", alignItems: "center", justifyContent: "center",
                     gap: 8, backgroundColor: "#059669", borderRadius: 12,
                     paddingVertical: 14 },
  submitDisabled:  { backgroundColor: "#D1D5DB" },
  submitText:      { fontSize: 15, fontWeight: "800", color: "#fff" },
  discardBtn:      { alignItems: "center", paddingVertical: 10 },
  discardText:     { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },

  // Results
  resultsHeading:    { fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 8 },
  resultCard:        { borderRadius: 14, borderWidth: 1, padding: 14, gap: 6 },
  resultSuccess:     { backgroundColor: "#ECFDF5", borderColor: "#A7F3D0" },
  resultFail:        { backgroundColor: "#FEF2F2", borderColor: "#FECACA" },
  resultCardTitle:   { fontSize: 14, fontWeight: "800", color: "#065F46" },
  resultCardTitleFail: { fontSize: 14, fontWeight: "800", color: "#991B1B" },
  resultSuccessItem: { fontSize: 13, color: "#047857" },
  resultFailItem:    { fontSize: 13, color: "#B91C1C" },
  resultFailErr:     { fontSize: 11, color: "#EF4444" },

  // Shared buttons (results view)
  outlineBtn:      { borderWidth: 2, borderColor: "#4F46E5", borderRadius: 12,
                     paddingVertical: 14, alignItems: "center" },
  outlineBtnText:  { fontSize: 15, fontWeight: "800", color: "#4F46E5" },
  primaryBtn:      { backgroundColor: "#059669", borderRadius: 12,
                     paddingVertical: 14, alignItems: "center" },
  primaryBtnText:  { fontSize: 15, fontWeight: "800", color: "#fff" },
});