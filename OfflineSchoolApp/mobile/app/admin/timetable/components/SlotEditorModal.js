// app/admin/timetable/components/SlotEditorModal.js
"use strict";

import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { SubjectService } from "../../../../src/services/subject.service";
import { TeacherService  } from "../../../../src/services/teacher.service";
import { useTranslation } from "../../../../src/i18n/useTranslation";
import { i18n } from "../../../../src/i18n";
import { errorText } from "../../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, categoryAccent } from "../../../../src/theme/colors";
import { HeaderIcon } from "../../../../src/components/Tinted";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the best available ID string from any value shape.
 * Consider moving to src/utils/idHelpers.js if needed elsewhere.
 */
const resolveId = (value) => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    return (
      resolveId(value._id)  ||
      resolveId(value.id)   ||
      resolveId(value.uuid) ||
      null
    );
  }
  return null;
};

const firstId = (...candidates) => {
  for (const c of candidates) {
    const id = resolveId(c);
    if (id) return id;
  }
  return null;
};

const firstStr = (...candidates) => {
  for (const c of candidates) {
    if (c && typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
};

/** Capitalise first letter — used to display canonical day names. */
const capitalize = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

/**
 * Translation keys for the day shown in the header. Keyed by the first three
 * letters of the canonical day value, which is left untouched.
 */
const DAY_LABEL_KEYS = {
  mon: "timetable.monday",
  tue: "timetable.tuesday",
  wed: "timetable.wednesday",
  thu: "timetable.thursday",
  fri: "timetable.friday",
};

const unwrapArray = (result, ...keys) => {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(result[key])) return result[key];
  }
  if (Array.isArray(result.data)) return result.data;
  if (result.data && typeof result.data === "object") {
    for (const key of keys) {
      if (Array.isArray(result.data[key])) return result.data[key];
    }
  }
  return [];
};

const normalizeSubjects = (result) => {
  const rows = unwrapArray(result, "subjects", "items", "results");
  const seen = new Set();
  const out  = [];

  for (const raw of rows) {
    if (!raw) continue;
    const nested = raw.subject && typeof raw.subject === "object" ? raw.subject : null;
    const id = firstId(raw.subjectId, raw.subject_id, nested, raw._id, raw.id, raw.uuid);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = firstStr(
      raw.subjectName, raw.subject_name,
      nested?.name, nested?.label,
      raw.name, raw.label, raw.code,
    ) ?? i18n.t("ttAdmin.unnamedSubject");
    out.push({ id, name });
  }
  return out;
};

const normalizeTeachers = (result) => {
  const rows = unwrapArray(result, "teachers", "assignments", "users", "items", "results");
  const seen = new Set();
  const out  = [];

  for (const raw of rows) {
    if (!raw) continue;
    const nestedTeacher = raw.teacher && typeof raw.teacher === "object" ? raw.teacher : null;
    const nestedUser    = raw.user    && typeof raw.user    === "object" ? raw.user    : null;
    const id = firstId(
      raw.teacherId, raw.teacher_id, nestedTeacher,
      raw.userId,   raw.user_id,    nestedUser,
      raw._id, raw.id, raw.uuid,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = firstStr(
      raw.teacherName, raw.teacher_name,
      nestedTeacher?.name, nestedTeacher?.fullName, nestedTeacher?.email,
      raw.userName, raw.user_name,
      nestedUser?.name, nestedUser?.fullName, nestedUser?.email,
      raw.name, raw.fullName, raw.email,
    ) ?? id;
    out.push({ id, name });
  }
  return out;
};

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────

export default function SlotEditorModal({
  mode,
  slot,
  cell,
  classId,
  onClose,
  onSave,
  onDelete,
}) {
  const { t } = useTranslation();

  const isMountedRef = useRef(true);

  // ── Data ──────────────────────────────────────────────────
  const [subjects, setSubjects] = useState([]);
  const [teachers, setTeachers] = useState([]);

  // ── Selections ────────────────────────────────────────────
  const [subjectId,       setSubjectId]       = useState(null);
  const [teacherId,       setTeacherId]       = useState(null);
  const [room,            setRoom]            = useState("");

  // ── Preserve teacher across the async load when editing ───
  // Using state (not a ref) so React's batching keeps it consistent
  // with the subjectId that triggers the teacher-load effect.
  const [preserveTeacher, setPreserveTeacher] = useState(false);

  // ── UI ────────────────────────────────────────────────────
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingTeachers, setLoadingTeachers] = useState(false);
  const [saving,          setSaving]          = useState(false);

  // ─────────────────────────────────────────────────────────
  // MOUNT GUARD
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ─────────────────────────────────────────────────────────
  // SEED FORM VALUES WHEN EDITING AN EXISTING SLOT
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (slot) {
      // Signal the teacher-load effect to keep the existing teacherId
      // rather than auto-selecting or clearing it.
      setPreserveTeacher(true);
      setSubjectId(firstId(slot.subjectId, slot.subject_id, slot.subject));
      setTeacherId(firstId(slot.teacherId, slot.teacher_id, slot.teacher));
      setRoom(slot.room ?? "");
    } else {
      setPreserveTeacher(false);
      setSubjectId(null);
      setTeacherId(null);
      setRoom("");
    }
  }, [slot]);

  // ─────────────────────────────────────────────────────────
  // LOAD SUBJECTS
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!classId) {
        if (!cancelled && isMountedRef.current) {
          setSubjects([]);
          setLoadingSubjects(false);
        }
        return;
      }

      if (!cancelled && isMountedRef.current) setLoadingSubjects(true);

      try {
        const raw        = await SubjectService.getAll(classId);
        const normalised = normalizeSubjects(raw);

        if (__DEV__) {
          console.log(
            `📚 SlotEditorModal: ${normalised.length} subject(s) for class ${classId}`,
            normalised.map((s) => `${s.name} [${s.id}]`),
          );
        }

        if (!cancelled && isMountedRef.current) setSubjects(normalised);
      } catch (err) {
        console.error("SlotEditorModal: load subjects failed:", err.message);
        if (!cancelled && isMountedRef.current) setSubjects([]);
      } finally {
        if (!cancelled && isMountedRef.current) setLoadingSubjects(false);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [classId]);

  // ─────────────────────────────────────────────────────────
  // LOAD TEACHERS WHEN SUBJECT CHANGES
  // ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!subjectId || !classId) {
        if (!cancelled && isMountedRef.current) {
          setTeachers([]);
          setLoadingTeachers(false);
        }
        return;
      }

      if (!cancelled && isMountedRef.current) setLoadingTeachers(true);

      try {
        const raw        = await TeacherService.getTeachersBySubjectAndClass(classId, subjectId);
        const normalised = normalizeTeachers(raw);

        if (__DEV__) {
          console.log(
            `👩‍🏫 SlotEditorModal: ${normalised.length} teacher(s)`,
            normalised.map((item) => `${item.name} [${item.id}]`),
          );
        }

        if (!cancelled && isMountedRef.current) {
          setTeachers(normalised);

          if (preserveTeacher) {
            // Edit mode — keep the teacherId that was set from the slot data
            setPreserveTeacher(false);
          } else if (normalised.length === 1) {
            // Auto-select the only available teacher
            setTeacherId(normalised[0].id);
          } else {
            setTeacherId(null);
          }
        }
      } catch (err) {
        console.error("SlotEditorModal: load teachers failed:", err.message);
        if (!cancelled && isMountedRef.current) setTeachers([]);
      } finally {
        if (!cancelled && isMountedRef.current) setLoadingTeachers(false);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [classId, subjectId]);   // preserveTeacher intentionally omitted —
                               // it is read as a snapshot inside the async fn

  // ─────────────────────────────────────────────────────────
  // DERIVED
  // ─────────────────────────────────────────────────────────

  const selectedSubject = useMemo(
    () => subjects.find((s) => s.id === subjectId) ?? null,
    [subjects, subjectId],
  );

  const selectedTeacher = useMemo(
    () => teachers.find((item) => item.id === teacherId) ?? null,
    [teachers, teacherId],
  );

  const canSave = Boolean(subjectId) && Boolean(teacherId) && !saving;

  // ─────────────────────────────────────────────────────────
  // HANDLERS
  // ─────────────────────────────────────────────────────────

  const handleSelectSubject = useCallback(
    (nextId) => {
      if (!nextId || saving) return;
      // Allow re-tap only when teachers list is empty (network retry scenario)
      if (nextId === subjectId && teachers.length > 0) return;
      setPreserveTeacher(false);
      setSubjectId(nextId);
      setTeacherId(null);
      setTeachers([]);
    },
    [saving, subjectId, teachers.length],
  );

  const handleSelectTeacher = useCallback(
    (nextId) => {
      if (!nextId || saving) return;
      setTeacherId(nextId);
    },
    [saving],
  );

  const handleSave = useCallback(async () => {
    if (saving) return;

    if (!subjectId) {
      Alert.alert(t("ttAdmin.missingSubjectTitle"), t("ttAdmin.missingSubjectBody"));
      return;
    }
    if (!teacherId) {
      Alert.alert(t("ttAdmin.missingTeacherTitle"), t("ttAdmin.missingTeacherBody"));
      return;
    }

    try {
      setSaving(true);
      await onSave({
        subjectId: String(subjectId),
        teacherId: String(teacherId),
        room:      room.trim(),
      });
    } catch (err) {
      console.error("SlotEditorModal: save failed:", err.message);
      Alert.alert(t("ttAdmin.saveFailedTitle"), errorText(t, err, "ttAdmin.saveFailedBody"));
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [saving, subjectId, teacherId, room, onSave, t]);

  /**
   * Wraps onDelete so that:
   *  1. The saving spinner shows while the delete confirmation + operation runs.
   *  2. Errors are caught and shown inside the modal rather than silently lost.
   */
  const handleDelete = useCallback(async () => {
    if (saving) return;
    try {
      setSaving(true);
      await onDelete();
    } catch (err) {
      console.error("SlotEditorModal: delete failed:", err.message);
      Alert.alert(t("ttAdmin.deleteFailedTitle"), errorText(t, err, "ttAdmin.removeFailed"));
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [saving, onDelete, t]);

  // ─────────────────────────────────────────────────────────
  // LABELS
  // ─────────────────────────────────────────────────────────

  // The canonical day value is display-only here — translate it, never store it
  const rawDay      = cell?.dayOfWeek ?? slot?.dayOfWeek ?? "";
  const dayLabelKey = DAY_LABEL_KEYS[String(rawDay).slice(0, 3).toLowerCase()];
  const dayLabel    = dayLabelKey ? t(dayLabelKey) : capitalize(rawDay);
  const periodLabel = cell?.period?.name ?? slot?.periodName ?? t("ttAdmin.selectedPeriod");
  const timeLabel   =
    cell?.period?.startTime && cell?.period?.endTime
      ? `${cell.period.startTime} – ${cell.period.endTime}`
      : slot?.startTime && slot?.endTime
        ? `${slot.startTime} – ${slot.endTime}`
        : "";

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={saving ? undefined : onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>

          {/* ── Header ── */}
          <View style={styles.header}>
            <HeaderIcon />
            <View style={styles.headerLeft}>
              <Text style={styles.title}>
                {mode === "edit" ? t("ttAdmin.editSlot") : t("ttAdmin.configureSlot")}
              </Text>
              <Text style={styles.subtitle}>
                {dayLabel}{dayLabel && periodLabel ? " • " : ""}{periodLabel}
              </Text>
              {!!timeLabel && <Text style={styles.time}>{timeLabel}</Text>}
            </View>

            <TouchableOpacity
              onPress={onClose}
              disabled={saving}
              activeOpacity={0.7}
              style={[styles.closeBtn, saving && styles.disabledOpacity]}
            >
              <Ionicons name="close" size={20} color={COLORS.text} />
            </TouchableOpacity>
          </View>

          {/* ── Body ── */}
          <ScrollView
            style={styles.body}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >

            {/* ── Subject ── */}
            <Text style={styles.sectionLabel}>{t("ttAdmin.selectSubject")}</Text>

            {loadingSubjects ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={ACCENT.teal.solid} size="small" />
                <Text style={styles.loadingText}>{t("ttAdmin.loadingSubjects")}</Text>
              </View>
            ) : subjects.length === 0 ? (
              <Text style={styles.emptyText}>{t("ttAdmin.noSubjects")}</Text>
            ) : (
              subjects.map((subject) => {
                const selected = subjectId === subject.id;
                const tint     = ACCENT[categoryAccent(subject.name)];
                return (
                  <Pressable
                    key={`subj-${subject.id}`}
                    style={[
                      styles.option,
                      selected && { backgroundColor: tint.wash, borderColor: tint.base },
                    ]}
                    onPress={() => handleSelectSubject(subject.id)}
                    disabled={saving}
                  >
                    <View style={styles.optionRow}>
                      <Text
                        style={[styles.optionText, selected && { color: tint.deep }]}
                        numberOfLines={2}
                      >
                        {subject.name}
                      </Text>
                      {selected && (
                        <Ionicons name="checkmark-circle" size={19} color={tint.solid} />
                      )}
                    </View>
                  </Pressable>
                );
              })
            )}

            {/* ── Teacher ── */}
            <Text style={[styles.sectionLabel, styles.mt16]}>{t("ttAdmin.selectTeacher")}</Text>

            {!subjectId ? (
              <Text style={styles.emptyText}>{t("timetable.chooseSubjectFirst")}</Text>
            ) : loadingTeachers ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={ACCENT.violet.solid} size="small" />
                <Text style={styles.loadingText}>{t("ttAdmin.loadingTeachers")}</Text>
              </View>
            ) : teachers.length === 0 ? (
              <Text style={styles.emptyText}>
                {t("ttAdmin.noTeacherForSubject")}
              </Text>
            ) : (
              teachers.map((teacher) => {
                const selected = teacherId === teacher.id;
                return (
                  <Pressable
                    key={`tchr-${teacher.id}`}
                    style={[styles.option, selected && styles.optionGreen]}
                    onPress={() => handleSelectTeacher(teacher.id)}
                    disabled={saving}
                  >
                    <View style={styles.optionRow}>
                      <Text
                        style={[styles.optionText, selected && styles.optionTextGreen]}
                        numberOfLines={2}
                      >
                        {teacher.name}
                      </Text>
                      {selected && (
                        <Ionicons name="checkmark-circle" size={19} color={ACCENT.violet.solid} />
                      )}
                    </View>
                  </Pressable>
                );
              })
            )}

            {/* ── Summary ── */}
            {(selectedSubject || selectedTeacher) && (
              <View style={styles.summary}>
                {selectedSubject && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>{t("academic.subject")}</Text>
                    <Text style={styles.summaryValue} numberOfLines={1}>
                      {selectedSubject.name}
                    </Text>
                  </View>
                )}
                {selectedTeacher && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>{t("academic.teacher")}</Text>
                    <Text style={styles.summaryValue} numberOfLines={1}>
                      {selectedTeacher.name}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* ── Room ── */}
            <Text style={[styles.sectionLabel, styles.mt16]}>
              {t("timetable.room")} <Text style={styles.optional}>{t("ttAdmin.roomOptional")}</Text>
            </Text>

            <TextInput
              value={room}
              onChangeText={setRoom}
              placeholder={t("timetable.roomPh")}
              style={styles.input}
              placeholderTextColor="#9CA3AF"
              autoCapitalize="words"
              autoCorrect={false}
              editable={!saving}
              maxLength={60}
              returnKeyType="done"
            />

            <View style={styles.spacer} />
          </ScrollView>

          {/* ── Actions ── */}
          <View style={styles.actions}>
            {mode === "edit" && typeof onDelete === "function" && (
              <TouchableOpacity
                style={[styles.btn, styles.btnDelete, saving && styles.disabledOpacity]}
                onPress={handleDelete}   // uses wrapped handler, not raw onDelete
                disabled={saving}
                activeOpacity={0.7}
              >
                <Text style={styles.btnDeleteText}>{t("common.delete")}</Text>
              </TouchableOpacity>
            )}

            <View style={{ flex: 1 }} />

            <TouchableOpacity
              style={[styles.btn, styles.btnCancel, saving && styles.disabledOpacity]}
              onPress={onClose}
              disabled={saving}
              activeOpacity={0.7}
            >
              <Text style={styles.btnCancelText}>{t("common.cancel")}</Text>
            </TouchableOpacity>

            <View style={{ width: 8 }} />

            <TouchableOpacity
              style={[styles.btn, styles.btnSave, !canSave && styles.btnSaveDisabled]}
              onPress={handleSave}
              disabled={!canSave}
              activeOpacity={0.7}
            >
              {saving ? (
                <ActivityIndicator size="small" color={COLORS.onPrimary} />
              ) : (
                <Text style={styles.btnSaveText}>{t("ttAdmin.saveSlot")}</Text>
              )}
            </TouchableOpacity>
          </View>

        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex:              1,
    backgroundColor:   "rgba(0,0,0,0.45)",
    justifyContent:    "center",
    paddingHorizontal: 16,
  },
  modal: {
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    padding:         16,
    maxHeight:       "88%",
  },

  header: {
    flexDirection: "row",
    alignItems:    "flex-start",
    marginBottom:  12,
  },
  headerLeft: { flex: 1 },
  title: {
    fontSize:   18,
    fontWeight: "700",
    color:      COLORS.text,
  },
  subtitle: {
    fontSize:   13,
    color:      ACCENT.teal.deep,
    fontWeight: "600",
    marginTop:  2,
  },
  time: {
    fontSize:  12,
    color:     COLORS.textSecondary,
    marginTop: 2,
  },
  closeBtn: {
    padding:         6,
    backgroundColor: COLORS.page,
    borderRadius:    8,
    marginLeft:      8,
  },

  // Body — responsive height so it does not clip on small screens
  body:   { maxHeight: SCREEN_HEIGHT * 0.45 },
  spacer: { height: 16 },
  mt16:   { marginTop: 16 },

  sectionLabel: {
    fontSize:     14,
    fontWeight:   "700",
    color:        COLORS.text,
    marginBottom: 8,
  },
  optional: {
    fontSize:   12,
    fontWeight: "400",
    color:      COLORS.textSubtle,
  },

  loadingRow: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 12,
  },
  loadingText: {
    fontSize:   13,
    color:      COLORS.textSecondary,
    marginLeft: 8,
  },

  emptyText: {
    color:           COLORS.textSecondary,
    fontSize:        13,
    fontStyle:       "italic",
    paddingVertical: 12,
  },

  option: {
    padding:         12,
    borderRadius:    10,
    backgroundColor: COLORS.surface,
    marginBottom:    8,
    borderWidth:     1.5,
    borderColor:     COLORS.border,
  },
  optionGreen: { backgroundColor: ACCENT.violet.wash, borderColor: ACCENT.violet.base },
  optionRow: {
    flexDirection: "row",
    alignItems:    "center",
  },
  optionText: {
    flex:        1,
    fontSize:    14,
    fontWeight:  "600",
    color:       COLORS.text,
    marginRight: 8,
  },
  optionTextGreen: { color: ACCENT.violet.deep },

  summary: {
    marginTop:       12,
    padding:         12,
    borderRadius:    10,
    backgroundColor: ACCENT.teal.wash,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.teal.base,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems:    "center",
    marginBottom:  4,
  },
  summaryLabel: {
    width:      70,
    fontSize:   12,
    fontWeight: "700",
    color:      COLORS.textSecondary,
  },
  summaryValue: {
    flex:       1,
    fontSize:   12,
    fontWeight: "600",
    color:      COLORS.text,
  },

  input: {
    backgroundColor: "#F9FAFB",
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    padding:         12,
    borderRadius:    10,
    fontSize:        14,
    color:           "#111827",
  },

  actions: {
    flexDirection: "row",
    alignItems:    "center",
    marginTop:     16,
  },
  btn: {
    minWidth:          76,
    minHeight:         42,
    paddingVertical:   10,
    paddingHorizontal: 16,
    borderRadius:      10,
    justifyContent:    "center",
    alignItems:        "center",
  },
  btnSave:         { backgroundColor: ACCENT.teal.solid },
  btnSaveDisabled: { backgroundColor: COLORS.textMuted },
  btnCancel:       { backgroundColor: COLORS.border },
  btnDelete:       { backgroundColor: SEMANTIC.error.box },
  btnSaveText:   { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
  btnCancelText: { color: COLORS.text, fontWeight: "700", fontSize: 14 },
  btnDeleteText: { color: SEMANTIC.error.text, fontWeight: "700", fontSize: 14 },
  disabledOpacity: { opacity: 0.55 },
});