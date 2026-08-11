import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Alert,
} from "react-native";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  getTeacherAssignments,
  removeAssignment,
} from "../../../src/services/assignment.service";

const TeacherCard = React.memo(({ teacherInfo, assignmentCount, classCount }) => (
  <View style={styles.teacherCard}>
    <View style={styles.teacherAvatar}>
      <Text style={styles.teacherAvatarText}>
        {(teacherInfo?.name || "?").charAt(0).toUpperCase()}
      </Text>
    </View>
    <View style={styles.teacherInfoBlock}>
      <Text style={styles.teacherName} numberOfLines={1}>
        {teacherInfo?.name || "Unknown"}
      </Text>
      <Text style={styles.teacherEmail} numberOfLines={1}>
        {teacherInfo?.email || "No email on record"}
      </Text>
      <View style={styles.teacherStats}>
        <View style={styles.teacherStatItem}>
          <Text style={styles.teacherStatNumber}>{assignmentCount}</Text>
          <Text style={styles.teacherStatLabel}>Subjects</Text>
        </View>
        <View style={styles.teacherStatDivider} />
        <View style={styles.teacherStatItem}>
          <Text style={styles.teacherStatNumber}>{classCount}</Text>
          <Text style={styles.teacherStatLabel}>Classes</Text>
        </View>
      </View>
    </View>
  </View>
));

const SubjectRow = React.memo(({ assignment, onRemove }) => (
  <View style={styles.subjectRow}>
    <View style={styles.subjectRowLeft}>
      <View style={styles.subjectDot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.subjectName} numberOfLines={1}>
          {assignment.subject?.name || "N/A"}
        </Text>
        {!!assignment.subject?.code && (
          <Text style={styles.subjectCode}>{assignment.subject.code}</Text>
        )}
      </View>
    </View>
    <TouchableOpacity
      style={styles.removeBtn}
      onPress={() => onRemove(assignment)}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name="trash-outline" size={16} color="#EF4444" />
    </TouchableOpacity>
  </View>
));

const ClassGroup = React.memo(({ classId, group, onRemove }) => (
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
      <SubjectRow key={assignment._id} assignment={assignment} onRemove={onRemove} />
    ))}
  </View>
));

const EmptyAssignments = React.memo(({ onAssign }) => (
  <View style={styles.emptyState}>
    <Ionicons name="git-branch-outline" size={48} color="#D1D5DB" />
    <Text style={styles.emptyTitle}>No Assignments</Text>
    <Text style={styles.emptySubtitle}>
      This teacher has no subject assignments yet
    </Text>
    <TouchableOpacity
      style={styles.emptyAction}
      onPress={onAssign}
      activeOpacity={0.7}
    >
      <Ionicons name="add-circle" size={18} color="#4F46E5" />
      <Text style={styles.emptyActionText}>Assign Subjects</Text>
    </TouchableOpacity>
  </View>
));

export default function TeacherAssignmentDetail() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const teacherId = Array.isArray(params.id) ? params.id[0] : params.id;
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

  const isMountedRef  = useRef(true);
  const hasLoadedRef  = useRef(false);
  const isLoadingRef  = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    if (!teacherId) return;
    if (isLoadingRef.current) return;

    isLoadingRef.current = true;

    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      setError(null);

      const data = await getTeacherAssignments(teacherId);

      if (!isMountedRef.current) return;

      setAssignments(data || []);
      hasLoadedRef.current = true;

      if (data?.length > 0 && data[0].teacher) {
        setTeacherInfo((prev) => ({ ...prev, ...data[0].teacher }));
      }
    } catch (err) {
      console.error("Failed to load teacher assignments:", err);
      if (isMountedRef.current) {
        setError("Failed to load assignments. Pull down to retry.");
      }
    } finally {
      isLoadingRef.current = false;
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [teacherId]);

  useFocusEffect(
    useCallback(() => {
      if (!teacherId) {
        if (isMountedRef.current) {
          setLoading(false);
          setError("Invalid teacher ID. Please go back and try again.");
        }
        return;
      }
      loadData(hasLoadedRef.current);
    }, [teacherId, loadData])
  );

  const handleRemove = useCallback((assignment) => {
    Alert.alert(
      "Remove Assignment",
      `Remove "${assignment.subject?.name || "this subject"}" from ${
        assignment.class?.name || "this class"
      }?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            try {
              await removeAssignment(assignment._id);
              if (isMountedRef.current) {
                setAssignments((prev) => prev.filter((a) => a._id !== assignment._id));
                Alert.alert("Removed", "Assignment removed successfully.");
              }
            } catch (err) {
              console.error("Remove failed:", err);
              Alert.alert("Error", "Failed to remove assignment. Please try again.");
            }
          },
        },
      ]
    );
  }, []);

  const navigateToAssign = useCallback(() => {
    router.push({
      pathname: "/admin/assignments/assign",
      params: {
        teacherId,
        teacherName: teacherInfo?.name || fallbackTeacherName,
      },
    });
  }, [router, teacherId, teacherInfo, fallbackTeacherName]);

  const groupedByClass = useMemo(() =>
    assignments.reduce((acc, assignment) => {
      const classId = assignment.class?._id || `unknown-${assignment._id}`;
      if (!acc[classId]) {
        acc[classId] = {
          className: assignment.class?.name || "Unknown Class",
          class: assignment.class,
          subjects: [],
        };
      }
      acc[classId].subjects.push(assignment);
      return acc;
    }, {})
  , [assignments]);

  const classCount = useMemo(
    () => Object.keys(groupedByClass).filter((id) => !id.startsWith("unknown-")).length,
    [groupedByClass]
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading assignments…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {teacherInfo?.name || fallbackTeacherName || "Teacher"}
          </Text>
          <Text style={styles.headerSubtitle}>
            {assignments.length} assignment{assignments.length !== 1 ? "s" : ""} •{" "}
            {classCount} class{classCount !== 1 ? "es" : ""}
          </Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={navigateToAssign} activeOpacity={0.7}>
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
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadData()}
              activeOpacity={0.75}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <TeacherCard
          teacherInfo={teacherInfo}
          assignmentCount={assignments.length}
          classCount={classCount}
        />

        {assignments.length > 0 && (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Assignments by Class</Text>
            <TouchableOpacity onPress={navigateToAssign} activeOpacity={0.7} style={styles.sectionAction}>
              <Ionicons name="add-circle-outline" size={16} color="#4F46E5" />
              <Text style={styles.sectionActionText}>Add More</Text>
            </TouchableOpacity>
          </View>
        )}

        {assignments.length === 0 ? (
          <EmptyAssignments onAssign={navigateToAssign} />
        ) : (
          Object.entries(groupedByClass).map(([classId, group]) => (
            <ClassGroup
              key={classId}
              classId={classId}
              group={group}
              onRemove={handleRemove}
            />
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingBottom: 40 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#4F46E5",
    alignItems: "center", justifyContent: "center",
  },

  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEE2E2",
    marginHorizontal: 20, marginTop: 16,
    padding: 12, borderRadius: 10, gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  teacherCard: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    marginHorizontal: 20, marginTop: 20, padding: 20,
    borderRadius: 16, borderWidth: 1, borderColor: "#E5E7EB",
  },
  teacherAvatar: {
    width: 56, height: 56, borderRadius: 16,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center", marginRight: 16,
  },
  teacherAvatarText: { fontSize: 22, fontWeight: "700", color: "#4F46E5" },
  teacherInfoBlock: { flex: 1 },
  teacherName: { fontSize: 18, fontWeight: "700", color: "#111827" },
  teacherEmail: { fontSize: 13, color: "#9CA3AF", marginTop: 2 },
  teacherStats: {
    flexDirection: "row", alignItems: "center",
    marginTop: 14, gap: 20,
  },
  teacherStatItem: { alignItems: "center" },
  teacherStatNumber: { fontSize: 18, fontWeight: "700", color: "#4F46E5" },
  teacherStatLabel: { fontSize: 11, color: "#9CA3AF", marginTop: 1, fontWeight: "500" },
  teacherStatDivider: { width: 1, height: 28, backgroundColor: "#E5E7EB" },

  sectionHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginHorizontal: 20, marginTop: 24, marginBottom: 4,
  },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#374151" },
  sectionAction: { flexDirection: "row", alignItems: "center", gap: 4 },
  sectionActionText: { fontSize: 13, fontWeight: "600", color: "#4F46E5" },

  classGroup: {
    backgroundColor: "#FFFFFF",
    marginHorizontal: 20, marginTop: 12,
    borderRadius: 14, overflow: "hidden",
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  classGroupHeader: {
    flexDirection: "row", alignItems: "center",
    padding: 14, backgroundColor: "#FAFAFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  classGroupIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#EDE9FE",
    alignItems: "center", justifyContent: "center",
    marginRight: 10,
  },
  classGroupTitle: { flex: 1, fontSize: 15, fontWeight: "600", color: "#111827" },
  classGroupBadge: {
    backgroundColor: "#EDE9FE",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
  },
  classGroupBadgeText: { fontSize: 12, fontWeight: "700", color: "#7C3AED" },

  subjectRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#F9FAFB",
  },
  subjectRowLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  subjectDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: "#059669", flexShrink: 0,
  },
  subjectName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  subjectCode: { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  removeBtn: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: "#FEE2E2",
    alignItems: "center", justifyContent: "center",
    marginLeft: 8, flexShrink: 0,
  },

  emptyState: {
    alignItems: "center", paddingVertical: 50, paddingHorizontal: 20,
  },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", marginTop: 4, textAlign: "center" },
  emptyAction: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 10, marginTop: 20, gap: 8,
  },
  emptyActionText: { fontSize: 14, fontWeight: "600", color: "#4F46E5" },
});