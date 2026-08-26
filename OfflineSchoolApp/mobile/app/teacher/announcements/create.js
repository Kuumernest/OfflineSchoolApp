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

const PRIORITIES = [
  { key: "low",    icon: "remove-circle-outline", color: "#059669", bg: "#ECFDF5" },
  { key: "normal", icon: "alert-circle-outline",  color: "#D97706", bg: "#FEF3C7" },
  { key: "urgent", icon: "warning-outline",       color: "#DC2626", bg: "#FEE2E2" },
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
            color="#4F46E5"
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
      <Ionicons name="checkmark-circle" size={14} color="#059669" />
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
          borderColor:     selected ? item.color : "transparent",
          backgroundColor: selected ? item.bg    : "#F9FAFB",
        },
      ]}
      onPress={() => onSelect(item.key)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={item.icon}
        size={15}
        color={selected ? item.color : "#9CA3AF"}
      />
      <Text style={[
        styles.priorityText,
        { color: selected ? item.color : "#6B7280", fontWeight: selected ? "700" : "500" },
      ]}>
        {t(`announceCreate.priority.${item.key}`)}
      </Text>
    </TouchableOpacity>
  );
});

const CharCount = ({ current, max }) => {
  const ratio = current / max;
  const color =
    ratio > 0.9  ? "#DC2626" :
    ratio > 0.75 ? "#D97706" : "#9CA3AF";
  return (
    <Text style={[styles.charCount, { color }]}>{current}/{max}</Text>
  );
};

const FieldLabel = ({ label, required, right }) => (
  <View style={styles.fieldLabelRow}>
    <Text style={styles.fieldLabel}>
      {label}
      {required && <Text style={{ color: "#DC2626" }}> *</Text>}
    </Text>
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
        err.message || t("announceCreate.failedBody"),
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
        <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={22} color="#111827" />
          </TouchableOpacity>

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
            <FieldLabel label={t("announceCreate.labelNoticeType")} />
            <View style={styles.typeToggleRow}>
              <TouchableOpacity
                style={[styles.typeToggleBtn, !isSubject && styles.typeToggleBtnActive]}
                onPress={() => handleNoticeTypeChange("general")}
                activeOpacity={0.7}
              >
                <Ionicons name="megaphone-outline" size={18} color={!isSubject ? "#4F46E5" : "#9CA3AF"} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.typeToggleLabel, !isSubject && { color: "#4F46E5", fontWeight: "700" }]}>
                    {t("announceCreate.typeGeneral")}
                  </Text>
                  <Text style={styles.typeToggleSub}>
                    {t("announceCreate.typeGeneralSub")}
                  </Text>
                </View>
                {!isSubject && <Ionicons name="checkmark-circle" size={16} color="#4F46E5" />}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.typeToggleBtn, isSubject && styles.typeToggleBtnSubjectActive]}
                onPress={() => handleNoticeTypeChange("subject")}
                activeOpacity={0.7}
              >
                <Ionicons name="book-outline" size={18} color={isSubject ? "#059669" : "#9CA3AF"} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.typeToggleLabel, isSubject && { color: "#059669", fontWeight: "700" }]}>
                    {t("announceCreate.typeSubject")}
                  </Text>
                  <Text style={styles.typeToggleSub}>
                    {t("announceCreate.typeSubjectSub")}
                  </Text>
                </View>
                {isSubject && <Ionicons name="checkmark-circle" size={16} color="#059669" />}
              </TouchableOpacity>
            </View>
          </View>

          {/* GENERAL — multi-class */}
          {!isSubject && (
            <View style={styles.card}>
              <FieldLabel
                label={t("announceCreate.labelSendTo")}
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
                  <Ionicons name="school-outline" size={28} color="#D1D5DB" />
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
                  <Ionicons name="checkmark-circle" size={14} color="#4F46E5" />
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
                  <Ionicons name="school-outline" size={28} color="#D1D5DB" />
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
                  <Ionicons name="checkmark-circle" size={14} color="#059669" />
                  <Text style={[styles.selectedNoteText, { color: "#059669" }]}>
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
                <View style={[styles.stepBadge, { backgroundColor: "#059669" }]}>
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
                  <Ionicons name="book-outline" size={28} color="#D1D5DB" />
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
                  <Ionicons name="checkmark-circle" size={14} color="#059669" />
                  <Text style={[styles.selectedNoteText, { color: "#059669" }]}>
                    {t("announceCreate.subjectTabNote", { name: selectedSubject.name })}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* PRIORITY */}
          <View style={styles.card}>
            <FieldLabel label={t("announceCreate.labelPriority")} />
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
                    backgroundColor: isSubject ? "#ECFDF5" : selPriority.bg,
                  }]}>
                    <Ionicons
                      name={isSubject ? "book" : selPriority.icon}
                      size={16}
                      color={isSubject ? "#059669" : selPriority.color}
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
                    <View style={[styles.previewBadge, { backgroundColor: "#ECFDF5" }]}>
                      <Text style={[styles.previewBadgeText, { color: "#059669" }]}>
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
                { backgroundColor: isSubject ? "#059669" : selPriority.color },
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
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  scroll:    { paddingBottom: 40 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 11, color: "#6B7280", marginTop: 1 },
  sendBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "#4F46E5", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
  },
  sendBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  card: {
    backgroundColor: "#FFF", marginHorizontal: 14, marginTop: 12,
    borderRadius: 14, padding: 16,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },

  stepRow:       { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  stepBadge: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#4F46E5", alignItems: "center", justifyContent: "center",
  },
  stepBadgeText: { fontSize: 12, fontWeight: "800", color: "#FFF" },

  fieldLabelRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 10,
  },
  fieldLabel:    { fontSize: 14, fontWeight: "700", color: "#374151" },
  optionalLabel: { fontSize: 12, color: "#9CA3AF" },
  charCount:     { fontSize: 11, fontWeight: "500" },

  typeToggleRow: { flexDirection: "row", gap: 10 },
  typeToggleBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 10, borderWidth: 1.5,
    borderColor: "#E5E7EB", backgroundColor: "#F9FAFB",
  },
  typeToggleBtnActive:        { borderColor: "#4F46E5", backgroundColor: "#EEF2FF" },
  typeToggleBtnSubjectActive: { borderColor: "#059669", backgroundColor: "#ECFDF5" },
  typeToggleLabel: { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  typeToggleSub:   { fontSize: 10, color: "#9CA3AF", marginTop: 1 },

  priorityRow: { flexDirection: "row", gap: 8 },
  priorityPill: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 5, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5,
  },
  priorityText: { fontSize: 13 },

  input: {
    backgroundColor: "#F9FAFB", borderWidth: 1.5, borderColor: "#E5E7EB",
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 14, color: "#111827",
  },
  inputErr:  { borderColor: "#DC2626", backgroundColor: "#FFF5F5" },
  bodyInput: { height: 130, paddingTop: 12 },
  errText:   { fontSize: 12, color: "#DC2626", marginTop: 5, fontWeight: "500" },
  hint:      { fontSize: 11, color: "#9CA3AF", marginTop: 5 },

  selectAllBtn: { fontSize: 13, color: "#4F46E5", fontWeight: "600" },
  chipsWrap:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 20,
    backgroundColor: "#F3F4F6", borderWidth: 1.5, borderColor: "#E5E7EB",
  },
  chipSelected:        { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  chipSingleSelected:  { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  subjectChipSelected: { backgroundColor: "#ECFDF5", borderColor: "#059669" },
  chipText:            { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  chipTextSelected:    { color: "#4F46E5" },
  subjectChipText:     { color: "#059669" },

  loaderRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loaderText: { fontSize: 13, color: "#9CA3AF" },
  emptyBox: { alignItems: "center", paddingVertical: 20, gap: 6 },
  emptyTitle: { fontSize: 14, fontWeight: "600", color: "#6B7280" },
  emptySub:   { fontSize: 12, color: "#9CA3AF", textAlign: "center" },

  selectedNote: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 10 },
  selectedNoteText: { fontSize: 12, color: "#4F46E5", fontWeight: "600" },

  previewLabel: {
    fontSize: 11, fontWeight: "700", color: "#9CA3AF",
    letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10,
  },
  previewBox: {
    backgroundColor: "#F9FAFB", borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: "#E5E7EB",
  },
  previewTop: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  previewIcon: {
    width: 34, height: 34, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  previewTitle:     { fontSize: 14, fontWeight: "700", color: "#111827" },
  previewMeta:      { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  previewBadge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  previewBadgeText: { fontSize: 11, fontWeight: "700" },
  previewBody:      { fontSize: 13, color: "#6B7280", lineHeight: 20 },

  submitWrap: { marginHorizontal: 14, marginTop: 16 },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, paddingVertical: 16, borderRadius: 14,
  },
  submitText: { color: "#FFF", fontWeight: "700", fontSize: 16 },
});