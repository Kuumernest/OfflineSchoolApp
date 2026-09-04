// app/admin/assignments/[id].js  (or wherever this screen lives)
"use strict";

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Alert,
} from "react-native";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

// ✅ FIX: correct function names — the service exports
//    getAssignmentsForTeacher (not getTeacherAssignments)
//    deleteAssignment         (not removeAssignment)
import {
  getAssignmentsForTeacher,
  deleteAssignment,
  backfillTeacherNames,
} from "../../../src/services/assignment.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const TeacherCard = React.memo(({ teacherInfo, assignmentCount, classCount }) => {
                                 const { t } = useTranslation();
                                 return (
  <View style={styles.teacherCard}>
    <View style={styles.teacherAvatar}>
      <Text style={styles.teacherAvatarText}>
        {(teacherInfo?.name || "?").charAt(0).toUpperCase()}
      </Text>
    </View>
    <View style={styles.teacherInfoBlock}>
      <Text style={styles.teacherName} numberOfLines={1}>
        {teacherInfo?.name || t("assignList.unknown")}
      </Text>
      <Text style={styles.teacherEmail} numberOfLines={1}>
        {teacherInfo?.email || t("assignList.noEmailRecord")}
      </Text>
      <View style={styles.teacherStats}>
        <View style={styles.teacherStatItem}>
          <Text style={styles.teacherStatNumber}>{assignmentCount}</Text>
          <Text style={styles.teacherStatLabel}>{t("assignList.subjects")}</Text>
        </View>
        <View style={styles.teacherStatDivider} />
        <View style={styles.teacherStatItem}>
          <Text style={styles.teacherStatNumber}>{classCount}</Text>
          <Text style={styles.teacherStatLabel}>{t("assignList.classes")}</Text>
        </View>
      </View>
    </View>
  </View>
);
                               });

const SubjectRow = React.memo(({ assignment, onRemove, isRemoving }) => {
                                const { t } = useTranslation();
                                return (
  <View style={styles.subjectRow}>
    <View style={styles.subjectRowLeft}>
      <View style={styles.subjectDot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.subjectName} numberOfLines={1}>
          {assignment.subject?.name || t("assignList.unknownSubject")}
        </Text>
        {!!assignment.subject?.code && (
          <Text style={styles.subjectCode}>{assignment.subject.code}</Text>
        )}
      </View>
    </View>
    <TouchableOpacity
      style={[styles.removeBtn, isRemoving && { opacity: 0.4 }]}
      onPress={() => onRemove(assignment)}
      disabled={isRemoving}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      {isRemoving ? (
        <ActivityIndicator size="small" color="#EF4444" />
      ) : (
        <Ionicons name="trash-outline" size={16} color="#EF4444" />
      )}
    </TouchableOpacity>
  </View>
);
                              });

const ClassGroup = React.memo(({ classId, group, onRemove, removingId }) => (
  <View style={styles.classGroup}>
    <View style={styles.classGroupHeader}>
      <View style={styles.classGroupIcon}>
        <Ionicons name="school" size={18} color="#7C3AED" />
      </View>
      <Text style={styles.classGroupTitle} numberOfLines={1}>
        {group.className}
      </Text>
      <View style={styles.classGroupBadge}>
        <Text style={styles.classGroupBadgeText}>{group.subjects.length}</Text>
      </View>
    </View>

    {group.subjects.map((assignment) => (
      <SubjectRow
        key={assignment._id}
        assignment={assignment}
        onRemove={onRemove}
        isRemoving={removingId === assignment._id}
      />
    ))}
  </View>
));

const EmptyAssignments = React.memo(({ onAssign }) => {
                                      const { t } = useTranslation();
                                      return (
  <View style={styles.emptyState}>
    <Ionicons name="git-branch-outline" size={48} color="#D1D5DB" />
    <Text style={styles.emptyTitle}>{t("assignList.detailEmpty")}</Text>
    <Text style={styles.emptySubtitle}>
      {t("assignList.detailEmptySub")}
    </Text>
    <TouchableOpacity
      style={styles.emptyAction}
      onPress={onAssign}
      activeOpacity={0.7}
    >
      <Ionicons name="add-circle" size={18} color="#4F46E5" />
      <Text style={styles.emptyActionText}>{t("assignList.assignSubjects")}</Text>
    </TouchableOpacity>
  </View>
);
                                    });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function TeacherAssignmentDetail() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams();

  const teacherId = Array.isArray(params.id)
    ? params.id[0]
    : params.id;
  const fallbackTeacherName = Array.isArray(params.teacherName)
    ? params.teacherName[0]
    : params.teacherName;

  const [assignments, setAssignments] = useState([]);
  const [teacherInfo, setTeacherInfo] = useState(
    fallbackTeacherName ? { name: fallbackTeacherName } : null
  );
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const isMountedRef = useRef(true);
  const isLoadingRef = useRef(false);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadData = useCallback(async (isRefresh = false) => {
    if (!teacherId)          return;
    if (isLoadingRef.current) return;

    isLoadingRef.current = true;

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      setError(null);

      // ✅ Backfill any null teacher_json rows so names are available
      await backfillTeacherNames().catch(() => {});

      // ✅ FIX: was getTeacherAssignments — correct name is getAssignmentsForTeacher
      const data = await getAssignmentsForTeacher(teacherId);

      if (!isMountedRef.current) return;

      const list = data || [];
      setAssignments(list);
      hasLoadedRef.current = true;

      // ✅ FIX: extract teacher info from the first assignment's teacher blob.
      //    hydrateRow() in assignment.service puts the parsed JSON blob into
      //    assignment.teacher = { _id, name, email, role } so this is reliable.
      if (list.length > 0) {
        const firstTeacher = list[0].teacher;
        if (firstTeacher?.name) {
          setTeacherInfo((prev) => ({
            ...prev,
            ...firstTeacher,
            // Always keep the fallback name if the blob name is somehow empty
            name: firstTeacher.name || prev?.name || fallbackTeacherName,
          }));
        }
      }
    } catch (err) {
      console.error("[TeacherAssignmentDetail] Failed to load:", err.message);
      if (isMountedRef.current) {
        setError(t("assignList.detailLoadFailed"));
      }
    } finally {
      isLoadingRef.current = false;
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [teacherId, fallbackTeacherName]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(
    useCallback(() => {
      if (!teacherId) {
        if (isMountedRef.current) {
          setLoading(false);
          setError(t("assignList.invalidTeacherId"));
        }
        return;
      }
      // ✅ On re-focus after assigning, always reload to show new assignments
      loadData(hasLoadedRef.current);
    }, [teacherId, loadData, t])
  );

  // ── Remove assignment ─────────────────────────────────────────────────────
  const handleRemove = useCallback((assignment) => {
    const subjectName = assignment.subject?.name || "this subject";
    const className   = assignment.class?.name   || "this class";

    Alert.alert(
      t("assignList.removeTitle"),
      `Remove "${subjectName}" from ${className}?`,
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.remove"),
          style: "destructive",
          onPress: async () => {
            const id = assignment._id;
            setRemovingId(id);
            try {
              // ✅ FIX: was removeAssignment — correct name is deleteAssignment
              await deleteAssignment(id);
              if (!isMountedRef.current) return;
              setAssignments((prev) => prev.filter((a) => a._id !== id));
              Alert.alert(t("assignList.removedTitle"), t("assignList.removedBody"));
            } catch (err) {
              console.error("[TeacherAssignmentDetail] Remove failed:", err.message);
              if (isMountedRef.current) {
                Alert.alert(t("assignList.errTitle"), t("assignList.removeFailed"));
              }
            } finally {
              if (isMountedRef.current) setRemovingId(null);
            }
          },
        },
      ]
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToAssign = useCallback(() => {
    router.push({
      pathname: "/admin/assignments/assign",
      params: {
        teacherId,
        teacherName: teacherInfo?.name || fallbackTeacherName,
      },
    });
  }, [router, teacherId, teacherInfo, fallbackTeacherName]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const groupedByClass = useMemo(() => {
                                   return assignments.reduce((acc, assignment) => {
      // ✅ FIX: class name/id come from assignment.class which hydrateRow()
      //    populates from class_json blob — { _id, name, level, section }
      const classId   = assignment.class?._id || assignment.class?.id || `no-class-${assignment._id}`;
      const className = assignment.class?.name || t("assignList.unknownClass");

      if (!acc[classId]) {
        acc[classId] = {
          className,
          class:    assignment.class,
          subjects: [],
        };
      }
      acc[classId].subjects.push(assignment);
      return acc;
    }, {});
                                 }
  , [assignments, t]);

  const classCount = useMemo(
    () =>
      Object.keys(groupedByClass).filter((id) => !id.startsWith("no-class-")).length,
    [groupedByClass]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("assignList.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Header ── */}
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
            {teacherInfo?.name || fallbackTeacherName || t("assignList.teacher")}
          </Text>
          <Text style={styles.headerSubtitle}>
            {assignments.length} assignment{assignments.length !== 1 ? "s" : ""}{" "}
            · {classCount} class{classCount !== 1 ? "es" : ""}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={navigateToAssign}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* ── Error banner ── */}
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadData()}
              activeOpacity={0.75}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Teacher card ── */}
        <TeacherCard
          teacherInfo={teacherInfo}
          assignmentCount={assignments.length}
          classCount={classCount}
        />

        {/* ── Section header ── */}
        {assignments.length > 0 && (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t("assignList.byClassTitle")}</Text>
            <TouchableOpacity
              onPress={navigateToAssign}
              activeOpacity={0.7}
              style={styles.sectionAction}
            >
              <Ionicons name="add-circle-outline" size={16} color="#4F46E5" />
              <Text style={styles.sectionActionText}>{t("assignList.addMore")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Class groups or empty state ── */}
        {assignments.length === 0 ? (
          <EmptyAssignments onAssign={navigateToAssign} />
        ) : (
          Object.entries(groupedByClass).map(([classId, group]) => (
            <ClassGroup
              key={classId}
              classId={classId}
              group={group}
              onRemove={handleRemove}
              removingId={removingId}
            />
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#F9FAFB" },
  centered:     { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText:  { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingBottom: 40 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:    { flex: 1, marginLeft: 12 },
  headerTitle:     { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle:  { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },

  errorBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    backgroundColor:  "#FEE2E2",
    marginHorizontal: 20,
    marginTop:        16,
    padding:          12,
    borderRadius:     10,
    gap:              8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  teacherCard: {
    flexDirection:    "row",
    backgroundColor:  "#FFFFFF",
    marginHorizontal: 20,
    marginTop:        20,
    padding:          20,
    borderRadius:     16,
    borderWidth:      1,
    borderColor:      "#E5E7EB",
  },
  teacherAvatar: {
    width:           56,
    height:          56,
    borderRadius:    16,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     16,
  },
  teacherAvatarText: { fontSize: 22, fontWeight: "700", color: "#4F46E5" },
  teacherInfoBlock:  { flex: 1 },
  teacherName:       { fontSize: 18, fontWeight: "700", color: "#111827" },
  teacherEmail:      { fontSize: 13, color: "#9CA3AF", marginTop: 2 },
  teacherStats: {
    flexDirection: "row",
    alignItems:    "center",
    marginTop:     14,
    gap:           20,
  },
  teacherStatItem:   { alignItems: "center" },
  teacherStatNumber: { fontSize: 18, fontWeight: "700", color: "#4F46E5" },
  teacherStatLabel:  { fontSize: 11, color: "#9CA3AF", marginTop: 1, fontWeight: "500" },
  teacherStatDivider: { width: 1, height: 28, backgroundColor: "#E5E7EB" },

  sectionHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginHorizontal: 20,
    marginTop:      24,
    marginBottom:   4,
  },
  sectionTitle:      { fontSize: 14, fontWeight: "700", color: "#374151" },
  sectionAction:     { flexDirection: "row", alignItems: "center", gap: 4 },
  sectionActionText: { fontSize: 13, fontWeight: "600", color: "#4F46E5" },

  classGroup: {
    backgroundColor:  "#FFFFFF",
    marginHorizontal: 20,
    marginTop:        12,
    borderRadius:     14,
    overflow:         "hidden",
    borderWidth:      1,
    borderColor:      "#E5E7EB",
  },
  classGroupHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    padding:           14,
    backgroundColor:   "#FAFAFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  classGroupIcon: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#EDE9FE",
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     10,
  },
  classGroupTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: "#111827" },
  classGroupBadge: {
    backgroundColor:   "#EDE9FE",
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderRadius:      8,
  },
  classGroupBadgeText: { fontSize: 12, fontWeight: "700", color: "#7C3AED" },

  subjectRow: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 14,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  subjectRowLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  subjectDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: "#059669",
    flexShrink:      0,
  },
  subjectName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  subjectCode: { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  removeBtn: {
    width:           32,
    height:          32,
    borderRadius:    8,
    backgroundColor: "#FEE2E2",
    alignItems:      "center",
    justifyContent:  "center",
    marginLeft:      8,
    flexShrink:      0,
  },

  emptyState: {
    alignItems:        "center",
    paddingVertical:   50,
    paddingHorizontal: 20,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", marginTop: 4, textAlign: "center" },
  emptyAction: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#EEF2FF",
    paddingHorizontal: 20,
    paddingVertical:   12,
    borderRadius:      10,
    marginTop:         20,
    gap:               8,
  },
  emptyActionText: { fontSize: 14, fontWeight: "600", color: "#4F46E5" },
});