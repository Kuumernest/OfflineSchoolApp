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
import { COLORS, ACCENT, SEMANTIC, levelAccent, accentBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

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
        <ActivityIndicator size="small" color={ACCENT.red.solid} />
      ) : (
        <Ionicons name="trash-outline" size={16} color={ACCENT.red.solid} />
      )}
    </TouchableOpacity>
  </View>
);
                              });

const ClassGroup = React.memo(({ classId, group, onRemove, removingId }) => (
  <View
    style={[
      styles.classGroup,
      {
        backgroundColor: ACCENT[levelAccent(group.class?.level)].wash,
        borderLeftColor: ACCENT[levelAccent(group.class?.level)].base,
      },
    ]}
  >
    <View style={styles.classGroupHeader}>
      <IconSquare icon="school" accent={levelAccent(group.class?.level)} size={36} radius={10} style={styles.classGroupIcon} />
      <Text style={styles.classGroupTitle} numberOfLines={1}>
        {group.className}
      </Text>
      <View
        style={[
          styles.classGroupBadge,
          {
            backgroundColor: accentBadge(levelAccent(group.class?.level)).bg,
            borderColor: accentBadge(levelAccent(group.class?.level)).border,
          },
        ]}
      >
        <Text style={[styles.classGroupBadgeText, { color: accentBadge(levelAccent(group.class?.level)).text }]}>
          {group.subjects.length}
        </Text>
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
    <IconSquare icon="git-branch-outline" accent="violet" size={56} radius={16} />
    <Text style={styles.emptyTitle}>{t("assignList.detailEmpty")}</Text>
    <Text style={styles.emptySubtitle}>
      {t("assignList.detailEmptySub")}
    </Text>
    <TouchableOpacity
      style={styles.emptyAction}
      onPress={onAssign}
      activeOpacity={0.7}
    >
      <Ionicons name="add-circle" size={18} color={ACCENT.violet.deep} />
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
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {teacherInfo?.name || fallbackTeacherName || t("assignList.teacher")}
          </Text>
          <Text style={styles.headerSubtitle}>
            {t("assignList.assignmentCount", { count: assignments.length })}{" "}
            · {t("academic.classCount", { count: classCount })}
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
            <Ionicons name="alert-circle" size={18} color={SEMANTIC.error.icon} />
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
            <View style={styles.sectionTitleRow}>
              <IconSquare icon="school" accent="indigo" size={28} />
              <Text style={styles.sectionTitle}>{t("assignList.byClassTitle")}</Text>
            </View>
            <TouchableOpacity
              onPress={navigateToAssign}
              activeOpacity={0.7}
              style={styles.sectionAction}
            >
              <Ionicons name="add-circle-outline" size={16} color={ACCENT.violet.deep} />
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
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:      { marginLeft: 12, marginRight: 0 },
  headerCenter:    { flex: 1, marginLeft: 12 },
  headerTitle:     { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSubtitle:  { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
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
    backgroundColor:  ACCENT.violet.wash,
    marginHorizontal: 20,
    marginTop:        20,
    padding:          20,
    borderRadius:     16,
    borderWidth:      1,
    borderColor:      COLORS.border,
    borderTopWidth:   3,
    borderTopColor:   ACCENT.violet.base,
  },
  teacherAvatar: {
    width:           56,
    height:          56,
    borderRadius:    16,
    backgroundColor: ACCENT.violet.solid,
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     16,
  },
  teacherAvatarText: { fontSize: 22, fontWeight: "700", color: COLORS.onPrimary },
  teacherInfoBlock:  { flex: 1 },
  teacherName:       { fontSize: 18, fontWeight: "700", color: COLORS.text },
  teacherEmail:      { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  teacherStats: {
    flexDirection: "row",
    alignItems:    "center",
    marginTop:     14,
    gap:           20,
  },
  teacherStatItem:   { alignItems: "center" },
  teacherStatNumber: { fontSize: 18, fontWeight: "700", color: ACCENT.violet.deep },
  teacherStatLabel:  { fontSize: 11, color: COLORS.textSecondary, marginTop: 1, fontWeight: "500" },
  teacherStatDivider: { width: 1, height: 28, backgroundColor: COLORS.border },

  sectionHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginHorizontal: 20,
    marginTop:      24,
    marginBottom:   4,
  },
  sectionTitleRow:   { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle:      { fontSize: 14, fontWeight: "700", color: COLORS.text },
  sectionAction:     { flexDirection: "row", alignItems: "center", gap: 4 },
  sectionActionText: { fontSize: 13, fontWeight: "600", color: ACCENT.violet.deep },

  classGroup: {
    backgroundColor:  COLORS.surface,
    marginHorizontal: 20,
    marginTop:        12,
    borderRadius:     14,
    overflow:         "hidden",
    borderWidth:      1,
    borderColor:      COLORS.border,
    borderLeftWidth:  3,
  },
  classGroupHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    padding:           14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  classGroupIcon: { marginRight: 10 },
  classGroupTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: COLORS.text },
  classGroupBadge: {
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderRadius:      8,
    borderWidth:       1,
  },
  classGroupBadgeText: { fontSize: 12, fontWeight: "700" },

  subjectRow: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 14,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  subjectRowLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  subjectDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: ACCENT.slate.solid,
    flexShrink:      0,
  },
  subjectName: { fontSize: 14, fontWeight: "600", color: COLORS.text },
  subjectCode: { fontSize: 11, color: COLORS.textSecondary, marginTop: 1 },
  removeBtn: {
    width:           32,
    height:          32,
    borderRadius:    8,
    backgroundColor: SEMANTIC.error.box,
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
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: COLORS.text, marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 4, textAlign: "center" },
  emptyAction: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   ACCENT.violet.wash,
    paddingHorizontal: 20,
    paddingVertical:   12,
    borderRadius:      10,
    marginTop:         20,
    gap:               8,
  },
  emptyActionText: { fontSize: 14, fontWeight: "600", color: ACCENT.violet.deep },
});