// app/admin/teachers/edit.js
"use strict";

import React, {
  useCallback,
  useEffect,
  useState,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Alert,
  RefreshControl,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TeacherService } from "../../../src/services/teacher.service";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises a row returned by getAssignedSubjects into a consistent shape
 * so the rest of the UI never has to guess which field holds the identifier.
 *
 * getAssignedSubjects returns:
 *   { assignmentId, subjectId, classId, teacherId, name, className }
 *
 * We expose:
 *   { id, assignmentId, subjectId, classId, teacherId, name, className }
 *
 * where id === subjectId (the subject's own PK, used for unassign calls).
 */
const normaliseAssignedSubject = (row) => ({
  ...row,
  // id is what SubjectRow uses as the React key and what unassign needs
  id:           row.subjectId    ?? row.id           ?? row.assignmentId,
  assignmentId: row.assignmentId ?? row.id,
  subjectId:    row.subjectId    ?? row.id,
  name:         row.name         ?? row.subjectName  ?? "Unknown Subject",
  className:    row.className    ?? row.class_name   ?? "Unknown Class",
});

/**
 * Normalises a row returned by getAvailableSubjects into the same shape.
 *
 * getAvailableSubjects returns:
 *   { id, name, classId, className }
 */
const normaliseAvailableSubject = (row) => ({
  ...row,
  id:        row.id      ?? row.subjectId,
  subjectId: row.id      ?? row.subjectId,
  name:      row.name    ?? "Unknown Subject",
  className: row.className ?? row.class_name ?? "Unknown Class",
});

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single subject row shown in both the assigned and available lists.
 * Uses subject.id as the key (normalised above).
 */
const SubjectRow = React.memo(({ subject, actionIcon, actionColor, onAction, disabled }) => (
  <View style={styles.subjectRow}>
    <View style={styles.subjectInfo}>
      <Text style={styles.subjectName} numberOfLines={1}>
        {subject.name}
      </Text>
      <Text style={styles.subjectClass} numberOfLines={1}>
        {subject.className}
      </Text>
    </View>
    <TouchableOpacity
      style={[styles.subjectAction, disabled && { opacity: 0.4 }]}
      onPress={() => onAction(subject)}
      disabled={disabled}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons
        name={actionIcon}
        size={22}
        color={actionColor ?? "#DC2626"}
      />
    </TouchableOpacity>
  </View>
));

const SectionHeader = React.memo(({ title, count }) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {count != null && (
      <View style={styles.sectionBadge}>
        <Text style={styles.sectionBadgeText}>{count}</Text>
      </View>
    )}
  </View>
));

const FieldInput = React.memo(
  ({ label, value, onChangeText, placeholder, keyboardType, autoCapitalize, error }) => (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, !!error && styles.fieldInputError]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9CA3AF"
        keyboardType={keyboardType ?? "default"}
        autoCapitalize={autoCapitalize ?? "words"}
        autoCorrect={false}
      />
      {!!error && <Text style={styles.fieldError}>{error}</Text>}
    </View>
  )
);

const ErrorBanner = React.memo(({ message, onRetry }) => {
                                 const { t } = useTranslation();
                                 return (
  <View style={styles.errorBanner}>
    <Ionicons name="alert-circle" size={16} color="#DC2626" />
    <Text style={styles.errorText}>{message}</Text>
    {onRetry && (
      <TouchableOpacity
        onPress={onRetry}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.retryText}>{t("common.retry")}</Text>
      </TouchableOpacity>
    )}
  </View>
);
                               });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function EditTeacher() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id: teacherId } = useLocalSearchParams();

  const isMountedRef = useRef(true);

  // ── State ──────────────────────────────────────────────────────────────────
  const [teacher,          setTeacher]          = useState(null);
  const [name,             setName]             = useState("");
  const [email,            setEmail]            = useState("");
  const [assignedSubjects, setAssignedSubjects] = useState([]);
  const [availableSubjects,setAvailableSubjects]= useState([]);

  const [loading,          setLoading]          = useState(true);
  const [saving,           setSaving]           = useState(false);
  const [refreshing,       setRefreshing]       = useState(false);

  const [loadError,        setLoadError]        = useState(null);
  const [nameError,        setNameError]        = useState("");
  const [emailError,       setEmailError]       = useState("");

  // IDs of subjects currently being actioned (prevents double-taps)
  const [actioningIds,     setActioningIds]     = useState(new Set());

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Load ───────────────────────────────────────────────────────────────────

  const loadAll = useCallback(async (isRefresh = false) => {
    if (!teacherId) {
      setLoadError(t("teachersEdit.notFound"));
      setLoading(false);
      return;
    }

    try {
      isRefresh ? setRefreshing(true) : setLoading(true);
      setLoadError(null);

      const [teacherRow, assigned, available] = await Promise.all([
        TeacherService.getById(teacherId),
        TeacherService.getAssignedSubjects(teacherId),
        TeacherService.getAvailableSubjects(),
      ]);

      if (!isMountedRef.current) return;

      if (!teacherRow) {
        setLoadError(t("teachersEdit.notFound"));
        return;
      }

      setTeacher(teacherRow);
      setName(teacherRow.name  ?? "");
      setEmail(teacherRow.email ?? "");

      // FIX: normalise both lists so .id is always populated
      setAssignedSubjects(
        (Array.isArray(assigned)  ? assigned  : []).map(normaliseAssignedSubject)
      );
      setAvailableSubjects(
        (Array.isArray(available) ? available : []).map(normaliseAvailableSubject)
      );
    } catch (err) {
      console.error("[EditTeacher] load error:", err.message);
      if (isMountedRef.current) setLoadError(t("teachersEdit.errLoad"));
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t, teacherId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Validation ─────────────────────────────────────────────────────────────

  const validate = () => {
    let valid = true;

    if (!name.trim()) {
      setNameError(t("teachersEdit.errNameRequired"));
      valid = false;
    } else {
      setNameError("");
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email.trim()) {
      setEmailError(t("teachersEdit.errEmailRequired"));
      valid = false;
    } else if (!emailRegex.test(email.trim())) {
      setEmailError(t("teachersEdit.errEmailInvalid"));
      valid = false;
    } else {
      setEmailError("");
    }

    return valid;
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!validate()) return;
    if (saving) return;

    try {
      setSaving(true);
      await TeacherService.update(teacherId, name.trim(), email.trim().toLowerCase());

      if (isMountedRef.current) {
        Alert.alert(t("teachersEdit.savedTitle"), t("teachersEdit.saved"));
        router.back();
      }
    } catch (err) {
      if (isMountedRef.current) {
        Alert.alert(t("teachersEdit.errTitle"), errorText(t, err, "teachersEdit.errSave"));
      }
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [teacherId, name, email, saving, router]);

  // ── Unassign ────────────────────────────────────────────────────────────────

  const handleUnassign = useCallback((subject) => {
    Alert.alert(
      t("teachersEdit.unassignTitle"),
      t("teachersEdit.unassignBody", { name: subject.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.remove"),
          style: "destructive",
          onPress: async () => {
            // FIX: use subject.subjectId (the subject's PK) for the
            // unassign call, not subject.id which may be assignmentId
            const sid = subject.subjectId ?? subject.id;

            setActioningIds((prev) => new Set([...prev, sid]));

            // Optimistic removal
            setAssignedSubjects((prev) => prev.filter((s) => (s.subjectId ?? s.id) !== sid));

            try {
              await TeacherService.unassignSubject(teacherId, sid);

              // Refresh available list to show the newly freed subject
              const available = await TeacherService.getAvailableSubjects();
              if (isMountedRef.current) {
                setAvailableSubjects(
                  (Array.isArray(available) ? available : []).map(normaliseAvailableSubject)
                );
              }
            } catch (err) {
              if (isMountedRef.current) {
                // Roll back
                setAssignedSubjects((prev) => {
                  const exists = prev.some((s) => (s.subjectId ?? s.id) === sid);
                  return exists ? prev : [...prev, subject];
                });
                Alert.alert(t("teachersEdit.errTitle"), errorText(t, err, "teachersEdit.errUnassign"));
              }
            } finally {
              if (isMountedRef.current) {
                setActioningIds((prev) => {
                  const next = new Set(prev);
                  next.delete(sid);
                  return next;
                });
              }
            }
          },
        },
      ]
    );
  }, [t, teacherId]);

  // ── Assign ──────────────────────────────────────────────────────────────────

  const handleAssign = useCallback(async (subject) => {
    const sid = subject.subjectId ?? subject.id;
    if (actioningIds.has(sid)) return;

    setActioningIds((prev) => new Set([...prev, sid]));

    // Optimistic add to assigned list
    const optimistic = normaliseAssignedSubject({
      subjectId:   sid,
      assignmentId: `temp_${sid}`,
      classId:     subject.classId,
      teacherId,
      name:        subject.name,
      className:   subject.className,
    });
    setAssignedSubjects((prev) => [...prev, optimistic]);
    setAvailableSubjects((prev) => prev.filter((s) => (s.subjectId ?? s.id) !== sid));

    try {
      await TeacherService.assignSubject(teacherId, sid);

      // Refresh both lists to get server-confirmed data
      const [assigned, available] = await Promise.all([
        TeacherService.getAssignedSubjects(teacherId),
        TeacherService.getAvailableSubjects(),
      ]);

      if (isMountedRef.current) {
        setAssignedSubjects(
          (Array.isArray(assigned)  ? assigned  : []).map(normaliseAssignedSubject)
        );
        setAvailableSubjects(
          (Array.isArray(available) ? available : []).map(normaliseAvailableSubject)
        );
      }
    } catch (err) {
      if (isMountedRef.current) {
        // Roll back
        setAssignedSubjects((prev) =>
          prev.filter((s) => (s.subjectId ?? s.id) !== sid)
        );
        setAvailableSubjects((prev) => {
          const exists = prev.some((s) => (s.subjectId ?? s.id) === sid);
          return exists ? prev : [...prev, subject];
        });
        Alert.alert(t("teachersEdit.errTitle"), errorText(t, err, "teachersEdit.errAssign"));
      }
    } finally {
      if (isMountedRef.current) {
        setActioningIds((prev) => {
          const next = new Set(prev);
          next.delete(sid);
          return next;
        });
      }
    }
  }, [actioningIds, teacherId, t]);

  // ── Render guards ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("teachersEdit.loading")}</Text>
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={styles.errorMessage}>{loadError}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => loadAll()}>
          <Text style={styles.retryButtonText}>{t("common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {teacher?.name ?? t("teachersEdit.title")}
          </Text>
          <Text style={styles.headerSubtitle}>
            {t("teachersEdit.subjectsAssigned", { count: assignedSubjects.length })}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>{t("common.save")}</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadAll(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* ── PROFILE FIELDS ── */}
        <View style={styles.card}>
          <FieldInput
            label={t("teachersEdit.nameLabel")}
            value={name}
            onChangeText={setName}
            placeholder={t("teachersEdit.namePh")}
            error={nameError}
          />
          <FieldInput
            label={t("teachersEdit.emailLabel")}
            value={email}
            onChangeText={setEmail}
            placeholder={t("teachersEdit.emailPh")}
            keyboardType="email-address"
            autoCapitalize="none"
            error={emailError}
          />
        </View>

        {/* ── ASSIGNED SUBJECTS ── */}
        <View style={styles.card}>
          <SectionHeader
            title={t("teachersEdit.assigned")}
            count={assignedSubjects.length}
          />

          {assignedSubjects.length === 0 ? (
            <Text style={styles.emptyText}>{t("teachersEdit.noneAssigned")}</Text>
          ) : (
            assignedSubjects.map((subject) => (
              <SubjectRow
                // FIX: use the normalised .id field which is always populated
                key={subject.id ?? subject.assignmentId ?? subject.subjectId}
                subject={subject}
                actionIcon="close-circle"
                actionColor="#DC2626"
                onAction={handleUnassign}
                disabled={actioningIds.has(subject.subjectId ?? subject.id)}
              />
            ))
          )}
        </View>

        {/* ── AVAILABLE SUBJECTS ── */}
        <View style={styles.card}>
          <SectionHeader
            title={t("teachersEdit.available")}
            count={availableSubjects.length}
          />

          {availableSubjects.length === 0 ? (
            <Text style={styles.emptyText}>{t("teachersEdit.noneAvailable")}</Text>
          ) : (
            availableSubjects.map((subject) => (
              <SubjectRow
                key={subject.id ?? subject.subjectId}
                subject={subject}
                actionIcon="add-circle"
                actionColor="#059669"
                onAction={handleAssign}
                disabled={actioningIds.has(subject.subjectId ?? subject.id)}
              />
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  errorMessage:{ fontSize: 15, color: "#DC2626", textAlign: "center", marginTop: 12 },
  retryButton: {
    marginTop:       20,
    backgroundColor: "#4F46E5",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius:    10,
  },
  retryButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               10,
  },
  backButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:   { flex: 1 },
  headerTitle:    { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  saveButton: {
    backgroundColor:  "#4F46E5",
    paddingHorizontal: 16,
    paddingVertical:  9,
    borderRadius:     10,
    minWidth:         64,
    alignItems:       "center",
    justifyContent:   "center",
  },
  saveButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, gap: 12 },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius:    14,
    padding:         16,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.03,
    shadowRadius:    4,
    elevation:       1,
  },

  fieldWrap:  { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151" },
  fieldInput: {
    borderWidth:       1,
    borderColor:       "#D1D5DB",
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   11,
    fontSize:          15,
    color:             "#111827",
    backgroundColor:   "#F9FAFB",
  },
  fieldInputError: { borderColor: "#DC2626" },
  fieldError:      { fontSize: 11, color: "#DC2626", marginTop: 2 },

  sectionHeader: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  4,
  },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#374151", flex: 1 },
  sectionBadge: {
    backgroundColor:  "#EEF2FF",
    borderRadius:     10,
    paddingHorizontal: 8,
    paddingVertical:  3,
  },
  sectionBadgeText: { fontSize: 11, fontWeight: "700", color: "#4F46E5" },

  subjectRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   10,
    borderTopWidth:    1,
    borderTopColor:    "#F3F4F6",
  },
  subjectInfo:  { flex: 1 },
  subjectName:  { fontSize: 14, fontWeight: "600", color: "#111827" },
  subjectClass: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  subjectAction:{ padding: 4 },

  emptyText: { fontSize: 13, color: "#9CA3AF", fontStyle: "italic", textAlign: "center", paddingVertical: 8 },

  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FEE2E2",
    padding:         12,
    borderRadius:    10,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B" },
  retryText:  { fontSize: 13, color: "#DC2626", fontWeight: "700" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";