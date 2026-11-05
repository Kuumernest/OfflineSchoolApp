// app/teacher/announcements/create.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StatusBar,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from "react-native";
import { useRouter }            from "expo-router";
import { Ionicons }             from "@expo/vector-icons";
import { useTranslation }      from "../../../src/i18n/useTranslation";
import { useAuthStore }         from "../../../src/store/auth.store";
import { useAnnouncementStore } from "../../../src/store/announcement.store";
import { getDatabase }          from "../../../src/db/database";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const PRIORITIES = [
  { key: "low",    icon: "remove-circle-outline", color: ACCENT.slate.solid, bg: ACCENT.slate.wash, deep: ACCENT.slate.deep, base: ACCENT.slate.base },
  { key: "normal", icon: "alert-circle-outline",  color: ACCENT.sky.solid,   bg: ACCENT.sky.wash,   deep: ACCENT.sky.deep,   base: ACCENT.sky.base   },
  { key: "urgent", icon: "warning-outline",       color: ACCENT.red.solid,   bg: ACCENT.red.wash,   deep: ACCENT.red.deep,   base: ACCENT.red.base   },
];

const MAX_TITLE = 120;
const MAX_BODY  = 1000;

const loadClassSubjectMap = async (teacherId) => {
  if (!teacherId) return {};
  try {
    const db = await getDatabase();

    const tables  = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type='table'`)
      .catch(() => []);
    const tableSet = new Set(tables.map((tbl) => tbl.name));

    if (!tableSet.has("subjects")) return {};

    const cols   = await db.getAllAsync(`PRAGMA table_info(subjects)`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const teacherCol =
      colSet.has("teacher_id") ? "teacher_id" :
      colSet.has("teacherId")  ? "teacherId"  : null;
    const classCol =
      colSet.has("class_id") ? "class_id" :
      colSet.has("classId")  ? "classId"  : null;

    if (!teacherCol || !classCol) return {};

    const deletedCol    = colSet.has("deleted_at") ? "deleted_at" : null;
    const deletedFilter = deletedCol
      ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
      : "";

    const rows = await db.getAllAsync(
      `SELECT id, name, code, ${classCol} AS class_id
       FROM subjects
       WHERE (${teacherCol} = ? OR ${teacherCol} = ?)
         ${deletedFilter}
       ORDER BY name ASC`,
      [teacherId, String(teacherId)]
    ).catch(() => []);

    const map = {};
    rows.forEach((row) => {
      const cid = String(row.class_id || "");
      if (!cid) return;
      if (!map[cid]) map[cid] = [];
      map[cid].push({ id: String(row.id), name: row.name, code: row.code });
    });

    return map;
  } catch (err) {
    console.warn("[loadClassSubjectMap]", err.message);
    return {};
  }
};

const ClassChip = React.memo(({ cls, selected, onToggle, single = false }) => {
  const { t }     = useTranslation();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = useCallback(() => {
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 0.93, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1,    useNativeDriver: true }),
    ]).start();
    onToggle(cls.id);
  }, [cls.id, onToggle, scaleAnim]);

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[
          styles.chip,
          selected && (single ? styles.chipSingleSelected : styles.chipSelected),
        ]}
        onPress={handlePress}
        activeOpacity={1}
      >
        {selected && (
          <Ionicons
            name={single ? "radio-button-on" : "checkmark-circle"}
            size={14}
            color={ACCENT.indigo.deep}
          />
        )}
        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
          {cls.name || t("announceCreate.classFallback")}
          {cls.section ? ` ${cls.section}` : ""}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
});

const SubjectChip = React.memo(({ subject, selected, onSelect }) => (
  <TouchableOpacity
    style={[styles.chip, selected && styles.subjectChipSelected]}
    onPress={() => onSelect(selected ? null : subject)}
    activeOpacity={0.7}
  >
    {selected && (
      <Ionicons name="checkmark-circle" size={14} color={ACCENT.slate.deep} />
    )}
    <Text style={[styles.chipText, selected && styles.subjectChipText]}>
      {subject.name}
      {subject.code ? ` (${subject.code})` : ""}
    </Text>
  </TouchableOpacity>
));

const PriorityPill = React.memo(({ item, selected, onSelect }) => {
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      style={[
        styles.priorityPill,
        {
          borderColor:     selected ? item.base : COLORS.border,
          backgroundColor: selected ? item.bg   : COLORS.surface,
        },
      ]}
      onPress={() => onSelect(item.key)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={item.icon}
        size={15}
        color={selected ? item.deep : COLORS.textSecondary}
      />
      <Text style={[
        styles.priorityText,
        { color: selected ? item.deep : COLORS.textSecondary, fontWeight: selected ? "700" : "500" },
      ]}>
        {t(`announceCreate.priority.${item.key}`)}
      </Text>
    </TouchableOpacity>
  );
});

const CharCount = ({ current, max }) => {
  const ratio = current / max;
  const color =
    ratio > 0.9  ? SEMANTIC.error.text :
    ratio > 0.75 ? SEMANTIC.warning.text : COLORS.textSecondary;
  return (
    <Text style={[styles.charCount, { color }]}>{current}/{max}</Text>
  );
};

const FieldLabel = ({ label, required, right, icon, accent = "sky" }) => (
  <View style={styles.fieldLabelRow}>
    <View style={styles.fieldLabelLead}>
      {icon ? <IconSquare icon={icon} accent={accent} size={28} /> : null}
      <Text style={styles.fieldLabel}>
        {label}
        {required && <Text style={{ color: SEMANTIC.error.text }}> *</Text>}
      </Text>
    </View>
    {right}
  </View>
);

export default function CreateAnnouncementScreen() {
  const router  = useRouter();
  const { t }   = useTranslation();
  const user    = useAuthStore((s) => s.user);

  const assignedClasses = useAnnouncementStore((s) => s.assignedClasses);
  const loadingClasses  = useAnnouncementStore((s) => s.loadingClasses);
  const submitting      = useAnnouncementStore((s) => s.submitting);
  const fetchClasses    = useAnnouncementStore((s) => s.fetchClasses);
  const createNew       = useAnnouncementStore((s) => s.createNew);

  const teacherId = user?._id || user?.id || user?.userId;

  const [title,       setTitle]       = useState("");
  const [body,        setBody]        = useState("");
  const [priority,    setPriority]    = useState("normal");
  const [expiresAt,   setExpiresAt]   = useState("");
  const [errors,      setErrors]      = useState({});
  const [noticeType,  setNoticeType]  = useState("general");
  const [selectedClassIds,  setSelectedClassIds]  = useState([]);
  const [classSubjectMap,   setClassSubjectMap]   = useState({});
  const [loadingSubjects,   setLoadingSubjects]   = useState(false);
  const [subjectClassId,    setSubjectClassId]    = useState(null);
  const [selectedSubject,   setSelectedSubject]   = useState(null);

  const bodyRef = useRef(null);

  useEffect(() => {
    fetchClasses();
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!teacherId) return;
    setLoadingSubjects(true);
    loadClassSubjectMap(teacherId)
      .then(setClassSubjectMap)
      .finally(() => setLoadingSubjects(false));
  }, [teacherId]);

  useEffect(() => {
    setSelectedSubject(null);
  }, [subjectClassId]);

  const handleNoticeTypeChange = useCallback((type) => {
    setNoticeType(type);
    setSelectedClassIds([]);
    setSubjectClassId(null);
    setSelectedSubject(null);
    setErrors({});
  }, []);

  const clearFieldError = useCallback((field) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const toggleClassGeneral = useCallback((id) => {
    if (!id) return;
    setSelectedClassIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
    clearFieldError("classes");
  }, [clearFieldError]);

  const handleSelectAll = useCallback(() => {
    const allIds = assignedClasses.map((c) => c.id).filter(Boolean);
    setSelectedClassIds((prev) =>
      prev.length === allIds.length ? [] : allIds
    );
  }, [assignedClasses]);

  const handleSubjectClassPick = useCallback((id) => {
    setSubjectClassId((prev) => prev === id ? null : id);
    clearFieldError("classes");
    clearFieldError("subject");
  }, [clearFieldError]);

  const handleSubjectPick = useCallback((subject) => {
    setSelectedSubject((prev) =>
      prev?.id === subject?.id ? null : subject
    );
    clearFieldError("subject");
  }, [clearFieldError]);

  const availableSubjects = subjectClassId
    ? (classSubjectMap[subjectClassId] || [])
    : [];

  const validate = useCallback(() => {
    const e = {};

    if (!title.trim())
      e.title = t("announceCreate.errTitleRequired");
    else if (title.trim().length > MAX_TITLE)
      e.title = t("announceCreate.errMaxChars", { count: MAX_TITLE });

    if (!body.trim())
      e.body = t("announceCreate.errBodyRequired");
    else if (body.trim().length > MAX_BODY)
      e.body = t("announceCreate.errMaxChars", { count: MAX_BODY });

    if (noticeType === "general") {
      if (selectedClassIds.length === 0)
        e.classes = t("announceCreate.errSelectClass");
    } else {
      if (!subjectClassId)
        e.classes = t("announceCreate.errSelectSubjectClass");
      if (!selectedSubject)
        e.subject = t("announceCreate.errSelectSubject");
    }

    if (expiresAt.trim()) {
      const d = new Date(expiresAt.trim());
      if (isNaN(d.getTime()))
        e.expiresAt = t("announceCreate.errInvalidDate");
      else if (d <= new Date())
        e.expiresAt = t("announceCreate.errExpiryPast");
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }, [title, body, noticeType, selectedClassIds, subjectClassId, selectedSubject, expiresAt, t]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (!validate()) return;

    const finalClassIds = noticeType === "general"
      ? selectedClassIds
      : [subjectClassId];

    const finalSubjectId   = noticeType === "subject" ? selectedSubject?.id   : null;
    const finalSubjectName = noticeType === "subject" ? selectedSubject?.name : null;

    try {
      await createNew({
        title:         title.trim(),
        body:          body.trim(),
        audience:      "students",
        targetClasses: finalClassIds,
        priority,
        isPinned:      false,
        publishAt:     null,
        expiresAt:     expiresAt.trim()
          ? new Date(expiresAt.trim()).toISOString()
          : null,
        subjectId:   finalSubjectId,
        subjectName: finalSubjectName,
      });

      const classCount = finalClassIds.length;
      const successMsg = noticeType === "subject"
        ? t("announceCreate.sentSubject", { name: finalSubjectName })
        : t("announceCreate.sentClasses", { count: classCount });

      Alert.alert(`${t("announceCreate.sentTitle")} ✓`, successMsg, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      Alert.alert(
        t("announceCreate.failedTitle"),
        errorText(t, err, "announceCreate.failedBody"),
        [{ text: "OK" }]
      );
    }
  }, [
    submitting, validate, createNew,
    noticeType, selectedClassIds, subjectClassId, selectedSubject,
    title, body, priority, expiresAt, router, t,
  ]);

  const selPriority = PRIORITIES.find((p) => p.key === priority) || PRIORITIES[1];
  const canPreview  = title.trim().length > 0 || body.trim().length > 0;
  const isSubject   = noticeType === "subject";
  const allSelected = selectedClassIds.length === assignedClasses.length &&
                      assignedClasses.length > 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.surface} />

        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>

          <HeaderIcon style={styles.headerIcon} />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>{t("announceCreate.title")}</Text>
            <Text style={styles.headerSub}>
              {isSubject && selectedSubject
                ? `${t("announceCreate.subjectNotice")} · ${selectedSubject.name}`
                : t("announceCreate.headerSubGeneral")}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.sendBtn, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.85}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#FFF" />
            ) : (
              <>
                <Ionicons name="send" size={15} color="#FFF" />
                <Text style={styles.sendBtnText}>{t("announceCreate.send")}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* NOTICE TYPE */}
          <View style={styles.card}>
            <FieldLabel label={t("announceCreate.labelNoticeType")} icon="megaphone" />
            <View style={styles.typeToggleRow}>
              <TouchableOpacity
                style={[styles.typeToggleBtn, !isSubject && styles.typeToggleBtnActive]}
                onPress={() => handleNoticeTypeChange("general")}
                activeOpacity={0.7}
              >
                <Ionicons name="megaphone-outline" size={18} color={!isSubject ? ACCENT.sky.deep : COLORS.textSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.typeToggleLabel, !isSubject && { color: ACCENT.sky.deep, fontWeight: "700" }]}>
                    {t("announceCreate.typeGeneral")}
                  </Text>
                  <Text style={styles.typeToggleSub}>
                    {t("announceCreate.typeGeneralSub")}
                  </Text>
                </View>
                {!isSubject && <Ionicons name="checkmark-circle" size={16} color={ACCENT.sky.deep} />}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.typeToggleBtn, isSubject && styles.typeToggleBtnSubjectActive]}
                onPress={() => handleNoticeTypeChange("subject")}
                activeOpacity={0.7}
              >
                <Ionicons name="book-outline" size={18} color={isSubject ? ACCENT.slate.deep : COLORS.textSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.typeToggleLabel, isSubject && { color: ACCENT.slate.deep, fontWeight: "700" }]}>
                    {t("announceCreate.typeSubject")}
                  </Text>
                  <Text style={styles.typeToggleSub}>
                    {t("announceCreate.typeSubjectSub")}
                  </Text>
                </View>
                {isSubject && <Ionicons name="checkmark-circle" size={16} color={ACCENT.slate.deep} />}
              </TouchableOpacity>
            </View>
          </View>

          {/* GENERAL — multi-class */}
          {!isSubject && (
            <View style={styles.card}>
              <FieldLabel
                label={t("announceCreate.labelSendTo")}
                icon="school"
                accent="indigo"
                required
                right={
                  assignedClasses.length > 0 ? (
                    <TouchableOpacity onPress={handleSelectAll}>
                      <Text style={styles.selectAllBtn}>
                        {allSelected
                          ? t("announceCreate.deselectAll")
                          : t("announceCreate.selectAll")}
                      </Text>
                    </TouchableOpacity>
                  ) : null
                }
              />
              {loadingClasses ? (
                <View style={styles.loaderRow}>
                  <ActivityIndicator size="small" color="#4F46E5" />
                  <Text style={styles.loaderText}>
                    {t("announceCreate.loadingClasses")}
                  </Text>
                </View>
              ) : assignedClasses.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="school-outline" size={28} color={ACCENT.indigo.solid} />
                  <Text style={styles.emptyTitle}>
                    {t("announceCreate.noClassesTitle")}
                  </Text>
                  <Text style={styles.emptySub}>
                    {t("announceCreate.noClassesSub")}
                  </Text>
                </View>
              ) : (
                <View style={styles.chipsWrap}>
                  {assignedClasses.map((cls) => (
                    <ClassChip
                      key={cls.id}
                      cls={cls}
                      selected={selectedClassIds.includes(cls.id)}
                      onToggle={toggleClassGeneral}
                    />
                  ))}
                </View>
              )}
              {errors.classes && <Text style={styles.errText}>{errors.classes}</Text>}
              {selectedClassIds.length > 0 && (
                <View style={styles.selectedNote}>
                  <Ionicons name="checkmark-circle" size={14} color={ACCENT.indigo.deep} />
                  <Text style={styles.selectedNoteText}>
                    {t("announceCreate.classesSelected", {
                      count: selectedClassIds.length,
                    })}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* SUBJECT MODE — Step 1: pick class */}
          {isSubject && (
            <View style={styles.card}>
              <View style={styles.stepRow}>
                <View style={styles.stepBadge}>
                  <Text style={styles.stepBadgeText}>1</Text>
                </View>
                <FieldLabel label={t("announceCreate.labelPickClass")} required />
              </View>
              {loadingClasses ? (
                <View style={styles.loaderRow}>
                  <ActivityIndicator size="small" color="#059669" />
                  <Text style={styles.loaderText}>
                    {t("announceCreate.loadingClasses")}
                  </Text>
                </View>
              ) : assignedClasses.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="school-outline" size={28} color={ACCENT.indigo.solid} />
                  <Text style={styles.emptyTitle}>
                    {t("announceCreate.noClassesTitle")}
                  </Text>
                  <Text style={styles.emptySub}>
                    {t("announceCreate.noClassesSub")}
                  </Text>
                </View>
              ) : (
                <View style={styles.chipsWrap}>
                  {assignedClasses.map((cls) => (
                    <ClassChip
                      key={cls.id}
                      cls={cls}
                      selected={subjectClassId === cls.id}
                      onToggle={handleSubjectClassPick}
                      single
                    />
                  ))}
                </View>
              )}
              {errors.classes && <Text style={styles.errText}>{errors.classes}</Text>}
              {subjectClassId && (
                <View style={styles.selectedNote}>
                  <Ionicons name="checkmark-circle" size={14} color={ACCENT.indigo.deep} />
                  <Text style={[styles.selectedNoteText, { color: ACCENT.indigo.deep }]}>
                    {t("announceCreate.classSelected", {
                      name:
                        assignedClasses.find((c) => c.id === subjectClassId)?.name ||
                        t("announceCreate.classFallback"),
                    })}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* SUBJECT MODE — Step 2: pick subject */}
          {isSubject && subjectClassId && (
            <View style={styles.card}>
              <View style={styles.stepRow}>
                <View style={[styles.stepBadge, { backgroundColor: ACCENT.slate.solid }]}>
                  <Text style={styles.stepBadgeText}>2</Text>
                </View>
                <FieldLabel label={t("announceCreate.labelPickSubject")} required />
              </View>
              {loadingSubjects ? (
                <View style={styles.loaderRow}>
                  <ActivityIndicator size="small" color="#059669" />
                  <Text style={styles.loaderText}>
                    {t("announceCreate.loadingSubjects")}
                  </Text>
                </View>
              ) : availableSubjects.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="book-outline" size={28} color={ACCENT.slate.solid} />
                  <Text style={styles.emptyTitle}>
                    {t("announceCreate.noSubjectsTitle")}
                  </Text>
                  <Text style={styles.emptySub}>
                    {t("announceCreate.noSubjectsSub")}
                  </Text>
                </View>
              ) : (
                <View style={styles.chipsWrap}>
                  {availableSubjects.map((subject) => (
                    <SubjectChip
                      key={subject.id}
                      subject={subject}
                      selected={selectedSubject?.id === subject.id}
                      onSelect={handleSubjectPick}
                    />
                  ))}
                </View>
              )}
              {errors.subject && <Text style={styles.errText}>{errors.subject}</Text>}
              {selectedSubject && (
                <View style={styles.selectedNote}>
                  <Ionicons name="checkmark-circle" size={14} color={ACCENT.slate.deep} />
                  <Text style={[styles.selectedNoteText, { color: ACCENT.slate.deep }]}>
                    {t("announceCreate.subjectTabNote", { name: selectedSubject.name })}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* PRIORITY */}
          <View style={styles.card}>
            <FieldLabel label={t("announceCreate.labelPriority")} icon="flag" accent="amber" />
            <View style={styles.priorityRow}>
              {PRIORITIES.map((p) => (
                <PriorityPill key={p.key} item={p} selected={priority === p.key} onSelect={setPriority} />
              ))}
            </View>
          </View>

          {/* TITLE */}
          <View style={styles.card}>
            <FieldLabel
              label={t("announceCreate.labelTitle")}
              icon="text"
              required
              right={<CharCount current={title.length} max={MAX_TITLE} />}
            />
            <TextInput
              style={[styles.input, errors.title && styles.inputErr]}
              placeholder={
                isSubject && selectedSubject
                  ? t("announceCreate.phTitleSubject", { name: selectedSubject.name })
                  : t("announceCreate.phTitle")
              }
              placeholderTextColor="#9CA3AF"
              value={title}
              onChangeText={(v) => { setTitle(v); clearFieldError("title"); }}
              maxLength={MAX_TITLE + 10}
              returnKeyType="next"
              onSubmitEditing={() => bodyRef.current?.focus()}
              blurOnSubmit={false}
            />
            {errors.title && <Text style={styles.errText}>{errors.title}</Text>}
          </View>

          {/* BODY */}
          <View style={styles.card}>
            <FieldLabel
              label={t("announceCreate.labelMessage")}
              icon="document-text"
              required
              right={<CharCount current={body.length} max={MAX_BODY} />}
            />
            <TextInput
              ref={bodyRef}
              style={[styles.input, styles.bodyInput, errors.body && styles.inputErr]}
              placeholder={t("announceCreate.phBody")}
              placeholderTextColor="#9CA3AF"
              value={body}
              onChangeText={(v) => { setBody(v); clearFieldError("body"); }}
              maxLength={MAX_BODY + 10}
              multiline
              textAlignVertical="top"
            />
            {errors.body && <Text style={styles.errText}>{errors.body}</Text>}
          </View>

          {/* EXPIRY */}
          <View style={styles.card}>
            <FieldLabel
              label={t("announceCreate.labelExpiry")}
              icon="time"
              right={
                <Text style={styles.optionalLabel}>{t("announceCreate.optional")}</Text>
              }
            />
            <TextInput
              style={[styles.input, errors.expiresAt && styles.inputErr]}
              placeholder={t("announceCreate.phExpiry")}
              placeholderTextColor="#9CA3AF"
              value={expiresAt}
              onChangeText={(v) => { setExpiresAt(v); clearFieldError("expiresAt"); }}
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
            />
            {errors.expiresAt && <Text style={styles.errText}>{errors.expiresAt}</Text>}
            <Text style={styles.hint}>{t("announceCreate.expiryHint")}</Text>
          </View>

          {/* PREVIEW */}
          {canPreview && (
            <View style={styles.card}>
              <Text style={styles.previewLabel}>{t("announceCreate.preview")}</Text>
              <View style={styles.previewBox}>
                <View style={styles.previewTop}>
                  <View style={[styles.previewIcon, {
                    backgroundColor: isSubject ? ACCENT.slate.solid : selPriority.color,
                  }]}>
                    <Ionicons
                      name={isSubject ? "book" : selPriority.icon}
                      size={16}
                      color={COLORS.onPrimary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.previewTitle} numberOfLines={1}>
                      {title || t("announceCreate.previewTitleFallback")}
                    </Text>
                    <Text style={styles.previewMeta}>
                      {user?.name || t("announceCreate.previewAuthorFallback")}
                      {isSubject && selectedSubject ? ` · ${selectedSubject.name}` : ""}
                      {` · ${t("announceCreate.previewJustNow")}`}
                    </Text>
                  </View>
                  {isSubject && (
                    <View style={[styles.previewBadge, { backgroundColor: ACCENT.slate.wash, borderWidth: 1, borderColor: ACCENT.slate.base + "4D" }]}>
                      <Text style={[styles.previewBadgeText, { color: ACCENT.slate.deep }]}>
                        {t("announceCreate.previewSubjectBadge")}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.previewBody} numberOfLines={5}>
                  {body || t("announceCreate.previewBodyFallback")}
                </Text>
              </View>
            </View>
          )}

          {/* SUBMIT */}
          <View style={styles.submitWrap}>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                { backgroundColor: isSubject ? ACCENT.slate.solid : selPriority.color },
                submitting && { opacity: 0.6 },
              ]}
              onPress={handleSubmit}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <>
                  <Ionicons
                    name={isSubject ? "book-outline" : "megaphone-outline"}
                    size={20}
                    color="#FFF"
                  />
                  <Text style={styles.submitText}>
                    {isSubject && selectedSubject
                      ? `${t("announceCreate.sendSubjectNotice")} · ${selectedSubject.name}`
                      : selectedClassIds.length > 0
                        ? t("announceCreate.sendClasses", {
                            count: selectedClassIds.length,
                          })
                        : t("announceCreate.sendAnnouncement")
                    }
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.page },
  scroll:    { paddingBottom: 40 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  headerIcon:  { marginRight: 0 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 11, color: COLORS.textSecondary, marginTop: 1 },
  sendBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "#4F46E5", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
  },
  sendBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  card: {
    backgroundColor: COLORS.surface, marginHorizontal: 14, marginTop: 12,
    borderRadius: 14, padding: 16, borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.shadow, shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },

  stepRow:       { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  stepBadge: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: ACCENT.indigo.solid, alignItems: "center", justifyContent: "center",
  },
  stepBadgeText: { fontSize: 12, fontWeight: "800", color: "#FFF" },

  fieldLabelRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 10,
  },
  fieldLabelLead: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  fieldLabel:    { fontSize: 14, fontWeight: "700", color: COLORS.text },
  optionalLabel: { fontSize: 12, color: COLORS.textSecondary },
  charCount:     { fontSize: 11, fontWeight: "500" },

  typeToggleRow: { flexDirection: "row", gap: 10 },
  typeToggleBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 10, borderWidth: 1.5,
    borderColor: COLORS.border, backgroundColor: COLORS.surface,
  },
  typeToggleBtnActive:        { borderColor: ACCENT.sky.base, backgroundColor: ACCENT.sky.wash },
  typeToggleBtnSubjectActive: { borderColor: ACCENT.slate.base, backgroundColor: ACCENT.slate.wash },
  typeToggleLabel: { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  typeToggleSub:   { fontSize: 10, color: COLORS.textSecondary, marginTop: 1 },

  priorityRow: { flexDirection: "row", gap: 8 },
  priorityPill: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 5, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5,
  },
  priorityText: { fontSize: 13 },

  input: {
    backgroundColor: COLORS.surface, borderWidth: 1.5, borderColor: COLORS.border,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 14, color: COLORS.text,
  },
  inputErr:  { borderColor: SEMANTIC.error.icon, backgroundColor: SEMANTIC.error.bg },
  bodyInput: { height: 130, paddingTop: 12 },
  errText:   { fontSize: 12, color: SEMANTIC.error.text, marginTop: 5, fontWeight: "500" },
  hint:      { fontSize: 11, color: COLORS.textSecondary, marginTop: 5 },

  selectAllBtn: { fontSize: 13, color: ACCENT.indigo.deep, fontWeight: "600" },
  chipsWrap:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 20,
    backgroundColor: COLORS.surface, borderWidth: 1.5, borderColor: COLORS.border,
  },
  chipSelected:        { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  chipSingleSelected:  { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  subjectChipSelected: { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base },
  chipText:            { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  chipTextSelected:    { color: ACCENT.indigo.deep },
  subjectChipText:     { color: ACCENT.slate.deep },

  loaderRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loaderText: { fontSize: 13, color: COLORS.textSecondary },
  emptyBox: { alignItems: "center", paddingVertical: 20, gap: 6 },
  emptyTitle: { fontSize: 14, fontWeight: "600", color: COLORS.text },
  emptySub:   { fontSize: 12, color: COLORS.textSecondary, textAlign: "center" },

  selectedNote: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 10 },
  selectedNoteText: { fontSize: 12, color: ACCENT.indigo.deep, fontWeight: "600" },

  previewLabel: {
    fontSize: 11, fontWeight: "700", color: COLORS.textSecondary,
    letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10,
  },
  previewBox: {
    backgroundColor: ACCENT.sky.wash, borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: COLORS.border,
    borderTopWidth: 3, borderTopColor: ACCENT.sky.base,
  },
  previewTop: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  previewIcon: {
    width: 34, height: 34, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  previewTitle:     { fontSize: 14, fontWeight: "700", color: COLORS.text },
  previewMeta:      { fontSize: 11, color: COLORS.textSecondary, marginTop: 1 },
  previewBadge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  previewBadgeText: { fontSize: 11, fontWeight: "700" },
  previewBody:      { fontSize: 13, color: COLORS.textSecondary, lineHeight: 20 },

  submitWrap: { marginHorizontal: 14, marginTop: 16 },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, paddingVertical: 16, borderRadius: 14,
  },
  submitText: { color: "#FFF", fontWeight: "700", fontSize: 16 },
});