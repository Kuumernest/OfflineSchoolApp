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
import { COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";
import { tileShell } from "../../../src/components/Tiles";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const CLASS_BADGE = accentBadge("indigo");
const ASSIGNED    = statusBadge("success");
const UNASSIGNED  = statusBadge("warning");

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

const normaliseSubject = (subject, classMap, classCol, t) => {
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
        <Ionicons name="book-outline" size={22} color={COLORS.onPrimary} />
      </View>

      <View style={styles.cardInfo}>
        <Text style={styles.subjectName} numberOfLines={1}>{subject.name}</Text>
        <View style={styles.badgeRow}>
          {!hideClassBadge && (
            <View style={styles.classBadge}>
              <Ionicons name="school-outline" size={12} color={CLASS_BADGE.text} />
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
              color={subject.teacherName ? ASSIGNED.text : UNASSIGNED.text}
            />
            <Text
              style={[
                styles.teacherBadgeText,
                { color: subject.teacherName ? ASSIGNED.text : UNASSIGNED.text },
              ]}
              numberOfLines={1}
            >
              {subject.teacherName || t("subjects.noTeacher")}
            </Text>
          </View>

          {/* Created or edited here and still queued: it goes by itself. */}
          {subject._synced === 0 && (
            <View style={[styles.teacherBadge, styles.teacherUnassigned]}>
              <Ionicons name="cloud-upload-outline" size={12} color={UNASSIGNED.text} />
              <Text style={[styles.teacherBadgeText, { color: UNASSIGNED.text }]} numberOfLines={1}>
                {t("common.notSentYet")}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onEdit(subject)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Ionicons name="create-outline" size={20} color={ACCENT.slate.solid} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onDelete(subject)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Ionicons name="trash-outline" size={20} color={COLORS.danger} />
        </TouchableOpacity>
      </View>
    </View>
  );
  }
);

const EmptyState = React.memo(({ icon, accent = "slate", title, subtitle, action }) => (
  <View style={styles.emptyState}>
    <IconSquare icon={icon} accent={accent} size={80} radius={20} style={styles.emptyIconWrap} />
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
      <IconSquare icon="school-outline" accent="indigo" size={28} radius={8} />
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
      const normSubjects = safeSubjects.map((s) => normaliseSubject(s, classMap, classCol, t));

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
  }, [selectedClassId, t]);

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
    (subject) => router.push(`/admin/subjects/add?id=${subject.id}`),
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
                Alert.alert(t("subjectsList.deletedTitle"), t("subjectsList.removedBody", { name: subject.name }));
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
  }, [loadData, t]);

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
        <ActivityIndicator size="large" color={ACCENT.slate.solid} />
        <Text style={styles.loadingText}>{t("subjectsList.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon />
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>{t("subjects.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {stats.total} {stats.total === 1 ? "subject" : "subjects"}
            {stats.unassigned > 0 ? ` • ${stats.unassigned} unassigned` : ""}
          </Text>
        </View>
        <TouchableOpacity style={styles.addButton} onPress={handleAddSubject} activeOpacity={0.7}>
          <Ionicons name="add" size={24} color={COLORS.onPrimary} />
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
              label={t("subjectsList.allWithCount", { count: stats.total })}
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
            <Text style={[styles.statNumber, { color: SEMANTIC.success.text }]}>{stats.assigned}</Text>
            <Text style={styles.statLabel}>{t("subjectsList.assigned")}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, stats.unassigned > 0 && { color: SEMANTIC.warning.text }]}>
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
            tintColor={ACCENT.slate.solid}
            colors={[ACCENT.slate.solid]}
          />
        }
      >
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

        {!hasClasses ? (
          <EmptyState
            icon="school-outline"
            accent="indigo"
            title={t("subjectsList.noClasses")}
            subtitle={t("subjects.needClass")}
            action={{ icon: "add-circle-outline", label: t("subjectsList.addClass"), color: ACCENT.indigo.solid, onPress: handleAddClass }}
          />
        ) : subjects.length === 0 ? (
          <EmptyState
            icon="book-outline"
            title={t("subjects.none")}
            subtitle={selectedClassId
              ? t("subjectsList.noneInClass")
              : t("subjectsList.noneHint")}
            action={{ icon: "add-circle-outline", label: t("subjects.add"), color: ACCENT.slate.solid, onPress: handleAddSubject }}
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
  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    flexShrink: 0,
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: COLORS.page,
    alignItems: "center", justifyContent: "center",
    marginRight: 12,
  },
  headerTextWrap: { flex: 1 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: COLORS.text },
  headerSubtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  addButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: ACCENT.slate.solid,
    alignItems: "center", justifyContent: "center",
  },
  filterBar: {
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    minHeight: 56, justifyContent: "center", flexShrink: 0,
  },
  filterScroll: { flexGrow: 0 },
  filterRow: { paddingHorizontal: 20, paddingVertical: 12, gap: 8, alignItems: "center" },
  filterChip: {
    backgroundColor: COLORS.surface, borderColor: COLORS.border,
    borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
  },
  filterChipActive: { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base },
  filterChipText: { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  filterChipTextActive: { color: ACCENT.slate.deep },
  statsBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 12,
    ...tileShell("subjects"),
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    gap: 24, flexShrink: 0,
  },
  statItem: { alignItems: "center" },
  statNumber: { fontSize: 18, fontWeight: "700", color: ACCENT.slate.deep },
  statLabel: { fontSize: 11, color: COLORS.textSecondary, fontWeight: "500", marginTop: 1 },
  statDivider: { width: 1, height: 24, backgroundColor: COLORS.border },
  mainScroll: { flex: 1 },
  scrollContent: { paddingTop: 12, paddingBottom: 12, flexGrow: 1 },
  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: SEMANTIC.error.box,
    marginHorizontal: 20, marginTop: 16,
    padding: 12, borderRadius: 10, gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text, fontWeight: "500" },
  retryText: { fontSize: 13, color: SEMANTIC.error.text, fontWeight: "700" },
  classSection: { marginBottom: 14 },
  classSectionHeader: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: 20, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: ACCENT.indigo.wash, borderRadius: 12, gap: 8,
    borderWidth: 1, borderColor: COLORS.border,
    borderLeftWidth: 3, borderLeftColor: ACCENT.indigo.base,
  },
  classSectionTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: ACCENT.indigo.deep },
  classSectionCount: {
    backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: CLASS_BADGE.border,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  classSectionCountText: { fontSize: 12, fontWeight: "700", color: ACCENT.indigo.deep },
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: ACCENT.slate.wash, borderRadius: 14, padding: 16,
    marginHorizontal: 20, marginBottom: 10,
    borderWidth: 1, borderColor: COLORS.border,
    borderLeftWidth: 3, borderLeftColor: ACCENT.slate.base,
  },
  iconBox: {
    width: 46, height: 46, borderRadius: 12,
    backgroundColor: ACCENT.slate.solid,
    alignItems: "center", justifyContent: "center",
    marginRight: 14, flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  subjectName: { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 8 },
  badgeRow: { gap: 6 },
  classBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    backgroundColor: CLASS_BADGE.bg, borderRadius: 8,
    borderWidth: 1, borderColor: CLASS_BADGE.border,
    paddingHorizontal: 8, paddingVertical: 4,
    gap: 4, maxWidth: "100%",
  },
  classBadgeText: { fontSize: 12, fontWeight: "600", color: CLASS_BADGE.text, flexShrink: 1 },
  teacherBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1,
    gap: 4, maxWidth: "100%",
  },
  teacherAssigned: { backgroundColor: ASSIGNED.bg, borderColor: ASSIGNED.border },
  teacherUnassigned: { backgroundColor: UNASSIGNED.bg, borderColor: UNASSIGNED.border },
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
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: COLORS.text, marginTop: 8 },
  emptySubtitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: 6, textAlign: "center", lineHeight: 20 },
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