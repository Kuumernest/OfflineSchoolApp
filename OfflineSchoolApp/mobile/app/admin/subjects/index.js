import React, {
  useCallback, useEffect, useState, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Alert,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import {
  SubjectService,
  getSubjects as getSubjectsWithAssignments,
} from "../../../src/services/subject.service";
import { ClassService } from "../../../src/services/class.service";
import { getDatabase }  from "../../../src/db/database";

const normaliseId = (id) => {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length === 0 ? null : s;
};

let _classColCache = null;

const resolveClassCol = async () => {
  if (_classColCache) return _classColCache;
  try {
    const db    = await getDatabase();
    const rows  = await db.getAllAsync("PRAGMA table_info(subjects)", []);
    const names = new Set((rows || []).map((r) => r.name));
    _classColCache =
      names.has("class_id") ? "class_id" :
      names.has("classId")  ? "classId"  : null;
    return _classColCache;
  } catch {
    return null;
  }
};

const normaliseSubject = (subject, classMap, classCol) => {
  const { t } = useTranslation();
  const rawClassId =
    subject.classId ?? subject.class_id ??
    (classCol ? subject[classCol] : undefined) ??
    subject.class?.id ?? null;

  const normClassId = normaliseId(rawClassId);
  const classObj = normClassId ? classMap.get(normClassId) : null;

  const className =
    classObj?.name ?? subject.className ?? subject.class_name ??
    subject.class?.name ?? t("subjectsList.unknownClass");

  const teacherName =
    subject.teacherName ?? subject.teacher_name ??
    subject.teacher?.name ?? null;

  return {
    ...subject,
    classId: normClassId ?? rawClassId ?? subject.classId ?? null,
    className,
    teacherName,
  };
};

const SubjectCard = React.memo(
  ({ subject, onEdit, onDelete, hideClassBadge = false }) => {
    const { t } = useTranslation();
    return (
    <View style={styles.card}>
      <View style={styles.iconBox}>
        <Ionicons name="book-outline" size={22} color="#059669" />
      </View>

      <View style={styles.cardInfo}>
        <Text style={styles.subjectName} numberOfLines={1}>{subject.name}</Text>
        <View style={styles.badgeRow}>
          {!hideClassBadge && (
            <View style={styles.classBadge}>
              <Ionicons name="school-outline" size={12} color="#4F46E5" />
              <Text style={styles.classBadgeText} numberOfLines={1}>{subject.className}</Text>
            </View>
          )}

          <View style={[
            styles.teacherBadge,
            subject.teacherName ? styles.teacherAssigned : styles.teacherUnassigned,
          ]}>
            <Ionicons
              name="people-outline"
              size={12}
              color={subject.teacherName ? "#059669" : "#D97706"}
            />
            <Text
              style={[
                styles.teacherBadgeText,
                { color: subject.teacherName ? "#065F46" : "#92400E" },
              ]}
              numberOfLines={1}
            >
              {subject.teacherName || t("subjects.noTeacher")}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onEdit(subject)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Ionicons name="create-outline" size={20} color="#4F46E5" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onDelete(subject)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </TouchableOpacity>
      </View>
    </View>
  );
  }
);

const EmptyState = React.memo(({ icon, title, subtitle, action }) => (
  <View style={styles.emptyState}>
    <View style={styles.emptyIconWrap}>
      <Ionicons name={icon} size={36} color="#9CA3AF" />
    </View>
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptySubtitle}>{subtitle}</Text>
    {action && (
      <TouchableOpacity
        style={[styles.emptyButton, { borderColor: action.color }]}
        onPress={action.onPress}
        activeOpacity={0.7}
      >
        <Ionicons name={action.icon} size={18} color={action.color} />
        <Text style={[styles.emptyButtonText, { color: action.color }]}>{action.label}</Text>
      </TouchableOpacity>
    )}
  </View>
));

const FilterChip = React.memo(({ label, isActive, onPress }) => (
  <TouchableOpacity
    style={[styles.filterChip, isActive && styles.filterChipActive]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
      {label}
    </Text>
  </TouchableOpacity>
));

const ClassSection = React.memo(({ className, count, children }) => (
  <View style={styles.classSection}>
    <View style={styles.classSectionHeader}>
      <View style={styles.classSectionIcon}>
        <Ionicons name="school-outline" size={16} color="#4F46E5" />
      </View>
      <Text style={styles.classSectionTitle} numberOfLines={1}>{className}</Text>
      <View style={styles.classSectionCount}>
        <Text style={styles.classSectionCountText}>{count}</Text>
      </View>
    </View>
    {children}
  </View>
));

export default function AdminSubjects() {
  const { t } = useTranslation();
  const router          = useRouter();
  const isMountedRef    = useRef(true);
  const isFirstFocusRef = useRef(true);

  const [subjects,        setSubjects]        = useState([]);
  const [classes,         setClasses]         = useState([]);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [refreshing,      setRefreshing]      = useState(false);
  const [error,           setError]           = useState(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      setError(null);

      const classCol = await resolveClassCol();

      const [rawSubjects, classRows] = await Promise.all([
        getSubjectsWithAssignments(selectedClassId ?? undefined),
        ClassService.getAll(false),
      ]);

      if (!isMountedRef.current) return;

      const safeClasses  = Array.isArray(classRows)  ? classRows  : [];
      const safeSubjects = Array.isArray(rawSubjects) ? rawSubjects : [];

      const classMap = new Map(safeClasses.map((cls) => [normaliseId(cls.id), cls]));
      const normSubjects = safeSubjects.map((s) => normaliseSubject(s, classMap, classCol));

      setClasses(safeClasses);
      setSubjects(normSubjects);
    } catch (err) {
      console.error("Failed to load subjects:", err);
      if (isMountedRef.current) {
        setError(t("subjectsList.loadFailed"));
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [selectedClassId]);

  useEffect(() => { loadData(); }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }
      loadData(true);
    }, [loadData])
  );

  const handleEdit = useCallback(
    (subject) => router.push(`/admin/subjects/edit?id=${subject.id}`),
    [router]
  );

  const handleDelete = useCallback((subject) => {
    Alert.alert(
      t("subjectsList.delTitle"),
      `Permanently delete "${subject.name}" from ${subject.className}?\n\n` +
      t("subjectsList.delBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"), style: "destructive",
          onPress: async () => {
            try {
              await SubjectService.delete(subject.id);
              if (isMountedRef.current) {
                setSubjects((prev) => prev.filter((s) => s.id !== subject.id));
                Alert.alert(t("subjectsList.deletedTitle"), `"${subject.name}" has been removed.`);
              }
            } catch (err) {
              const message =
                err.response?.data?.message ||
                (err instanceof Error ? errorText(t, err) : null) ||
                t("subjectsList.errDelete");
              Alert.alert(t("subjectsList.errTitle"), message);
              if (isMountedRef.current) loadData(true);
            }
          },
        },
      ]
    );
  }, [loadData]);

  const handleAddSubject = useCallback(() => router.push("/admin/subjects/add"), [router]);
  const handleAddClass   = useCallback(() => router.push("/admin/classes/add"), [router]);

  const hasClasses = classes.length > 0;
  const isAllTab   = selectedClassId === null;

  const stats = useMemo(() => {
    const assigned = subjects.filter((s) => !!s.teacherName).length;
    return { total: subjects.length, assigned, unassigned: subjects.length - assigned };
  }, [subjects]);

  const subjectCountByClass = useMemo(() => {
    const map = {};
    subjects.forEach((subject) => {
      const key = normaliseId(subject.classId) ?? "unknown";
      map[key] = (map[key] || 0) + 1;
    });
    return map;
  }, [subjects]);

  const groupedSubjects = useMemo(() => {
    if (!isAllTab) return [];

    const groups = subjects.reduce((acc, subject) => {
      const cid = normaliseId(subject.classId) ?? "unknown";
      if (!acc[cid]) {
        acc[cid] = { classId: cid, className: subject.className, items: [] };
      }
      acc[cid].items.push(subject);
      return acc;
    }, {});

    return Object.values(groups).sort((a, b) => a.className.localeCompare(b.className));
  }, [subjects, isAllTab]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#059669" />
        <Text style={styles.loadingText}>{t("subjectsList.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>{t("subjects.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {stats.total} {stats.total === 1 ? "subject" : "subjects"}
            {stats.unassigned > 0 ? ` • ${stats.unassigned} unassigned` : ""}
          </Text>
        </View>
        <TouchableOpacity style={styles.addButton} onPress={handleAddSubject} activeOpacity={0.7}>
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {hasClasses && (
        <View style={styles.filterBar}>
          <ScrollView
            horizontal
            style={styles.filterScroll}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
            keyboardShouldPersistTaps="handled"
          >
            <FilterChip
              label={`All Subjects (${stats.total})`}
              isActive={selectedClassId === null}
              onPress={() => setSelectedClassId(null)}
            />
            {classes.map((cls) => {
              const normId = normaliseId(cls.id);
              const count = subjectCountByClass[normId] || 0;
              return (
                <FilterChip
                  key={normId ?? cls.id}
                  label={`${cls.name} (${count})`}
                  isActive={normaliseId(selectedClassId) === normId}
                  onPress={() => setSelectedClassId(normId)}
                />
              );
            })}
          </ScrollView>
        </View>
      )}

      {subjects.length > 0 && (
        <View style={styles.statsBanner}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{stats.total}</Text>
            <Text style={styles.statLabel}>{t("common.total")}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: "#059669" }]}>{stats.assigned}</Text>
            <Text style={styles.statLabel}>{t("subjectsList.assigned")}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, stats.unassigned > 0 && { color: "#D97706" }]}>
              {stats.unassigned}
            </Text>
            <Text style={styles.statLabel}>{t("subjectsList.unassigned")}</Text>
          </View>
        </View>
      )}

      <ScrollView
        style={styles.mainScroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#059669"
            colors={["#059669"]}
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
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!hasClasses ? (
          <EmptyState
            icon="school-outline"
            title={t("subjectsList.noClasses")}
            subtitle={t("subjects.needClass")}
            action={{ icon: "add-circle-outline", label: t("subjectsList.addClass"), color: "#4F46E5", onPress: handleAddClass }}
          />
        ) : subjects.length === 0 ? (
          <EmptyState
            icon="book-outline"
            title={t("subjects.none")}
            subtitle={selectedClassId
              ? t("subjectsList.noneInClass")
              : t("subjectsList.noneHint")}
            action={{ icon: "add-circle-outline", label: t("subjects.add"), color: "#059669", onPress: handleAddSubject }}
          />
        ) : isAllTab ? (
          groupedSubjects.map((group) => (
            <ClassSection key={group.classId} className={group.className} count={group.items.length}>
              {group.items.map((subject) => (
                <SubjectCard
                  key={subject.id}
                  subject={subject}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  hideClassBadge
                />
              ))}
            </ClassSection>
          ))
        ) : (
          subjects.map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F3F4F6" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
    flexShrink: 0,
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
    marginRight: 12,
  },
  headerTextWrap: { flex: 1 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#059669",
    alignItems: "center", justifyContent: "center",
  },
  filterBar: {
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    minHeight: 56, justifyContent: "center", flexShrink: 0,
  },
  filterScroll: { flexGrow: 0 },
  filterRow: { paddingHorizontal: 20, paddingVertical: 12, gap: 8, alignItems: "center" },
  filterChip: {
    backgroundColor: "#F3F4F6", borderColor: "#E5E7EB",
    borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
  },
  filterChipActive: { backgroundColor: "#059669", borderColor: "#059669" },
  filterChipText: { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  filterChipTextActive: { color: "#FFFFFF" },
  statsBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#FFFFFF", paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    gap: 24, flexShrink: 0,
  },
  statItem: { alignItems: "center" },
  statNumber: { fontSize: 18, fontWeight: "700", color: "#111827" },
  statLabel: { fontSize: 11, color: "#9CA3AF", fontWeight: "500", marginTop: 1 },
  statDivider: { width: 1, height: 24, backgroundColor: "#E5E7EB" },
  mainScroll: { flex: 1 },
  scrollContent: { paddingTop: 12, paddingBottom: 12, flexGrow: 1 },
  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEE2E2",
    marginHorizontal: 20, marginTop: 16,
    padding: 12, borderRadius: 10, gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },
  classSection: { marginBottom: 14 },
  classSectionHeader: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: 20, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: "#EEF2FF", borderRadius: 12, gap: 8,
  },
  classSectionIcon: {
    width: 28, height: 28, borderRadius: 8,
    backgroundColor: "#FFFFFF",
    alignItems: "center", justifyContent: "center",
  },
  classSectionTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: "#3730A3" },
  classSectionCount: {
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  classSectionCountText: { fontSize: 12, fontWeight: "700", color: "#4F46E5" },
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFFFFF", borderRadius: 14, padding: 16,
    marginHorizontal: 20, marginBottom: 10,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  iconBox: {
    width: 46, height: 46, borderRadius: 12,
    backgroundColor: "#ECFDF5",
    alignItems: "center", justifyContent: "center",
    marginRight: 14, flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  subjectName: { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 8 },
  badgeRow: { gap: 6 },
  classBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    backgroundColor: "#EEF2FF", borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 4,
    gap: 4, maxWidth: "100%",
  },
  classBadgeText: { fontSize: 12, fontWeight: "600", color: "#4338CA", flexShrink: 1 },
  teacherBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
    gap: 4, maxWidth: "100%",
  },
  teacherAssigned: { backgroundColor: "#ECFDF5" },
  teacherUnassigned: { backgroundColor: "#FEF3C7" },
  teacherBadgeText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  actions: {
    flexDirection: "row", alignItems: "center",
    gap: 4, marginLeft: 8, flexShrink: 0,
  },
  actionButton: { padding: 8 },
  emptyState: {
    alignItems: "center", justifyContent: "center",
    paddingVertical: 60, paddingHorizontal: 32,
  },
  emptyIconWrap: {
    width: 80, height: 80, borderRadius: 20,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: "#111827", marginTop: 8 },
  emptySubtitle: { fontSize: 14, color: "#6B7280", marginTop: 6, textAlign: "center", lineHeight: 20 },
  emptyButton: {
    flexDirection: "row", alignItems: "center",
    marginTop: 20, gap: 6,
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 10, borderWidth: 1.5,
  },
  emptyButtonText: { fontSize: 14, fontWeight: "600" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";