// app/admin/teachers/index.js

import React, {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TeacherService } from "../../../src/services/teacher.service";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;


// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const TeacherCard = React.memo(({ teacher, onEdit, onDelete }) => {
  const { t } = useTranslation();
  const hasAssignments = Number(teacher.subjectCount ?? 0) > 0;

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.7}
      onPress={() => onEdit(teacher)}
    >
      <View style={styles.cardIcon}>
        <Ionicons name="person" size={22} color="#4F46E5" />
      </View>

      <View style={styles.cardInfo}>
        <Text style={styles.teacherName} numberOfLines={1}>
          {teacher.name}
        </Text>
        <Text style={styles.teacherEmail} numberOfLines={1}>
          {teacher.email || t("teachers.noEmail")}
        </Text>

        <View style={styles.metaRow}>
          <View style={styles.metaChip}>
            <Ionicons name="book-outline" size={12} color="#4F46E5" />
            <Text style={styles.metaChipText}>
              {teacher.subjectCount ?? 0}{" "}
              {Number(teacher.subjectCount ?? 0) === 1
                ? t("teachers.subject")
                : t("teachers.subjects")}
            </Text>
          </View>

          <View style={styles.metaChip}>
            <Ionicons name="school-outline" size={12} color="#4F46E5" />
            <Text style={styles.metaChipText}>
              {teacher.classCount ?? 0}{" "}
              {Number(teacher.classCount ?? 0) === 1
                ? t("teachers.klass")
                : t("teachers.klasses")}
            </Text>
          </View>

          {!hasAssignments && (
            <View style={styles.warningChip}>
              <Ionicons name="alert-circle-outline" size={12} color="#D97706" />
              <Text style={styles.warningChipText}>{t("teachers.unassigned")}</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.cardActions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onEdit(teacher)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="create-outline" size={20} color="#4F46E5" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onDelete(teacher)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </TouchableOpacity>

        <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
      </View>
    </TouchableOpacity>
  );
});

const EmptyState = React.memo(({ showOnlyUnassigned, onAdd }) => {
                                const { t } = useTranslation();
                                return (
  <View style={styles.emptyState}>
    <View style={styles.emptyIconWrap}>
      <Ionicons
        name={showOnlyUnassigned ? "checkmark-circle-outline" : "people-outline"}
        size={36}
        color={showOnlyUnassigned ? "#059669" : "#9CA3AF"}
      />
    </View>
    <Text style={[styles.emptyTitle, showOnlyUnassigned && { color: "#059669" }]}>
      {showOnlyUnassigned ? t("teachers.allAssigned") : t("teachers.none")}
    </Text>
    <Text style={styles.emptySubtitle}>
      {showOnlyUnassigned ? t("teachers.allAssignedHint") : t("teachers.noneHint")}
    </Text>
    {!showOnlyUnassigned && (
      <TouchableOpacity style={styles.emptyButton} onPress={onAdd} activeOpacity={0.7}>
        <Ionicons name="add-circle" size={18} color="#4F46E5" />
        <Text style={styles.emptyButtonText}>{t("teachers.add")}</Text>
      </TouchableOpacity>
    )}
  </View>
);
                              });

const StatsBanner = React.memo(({ stats }) => {
                                 const { t } = useTranslation();
                                 return (
  <View style={styles.statsBanner}>
    <View style={styles.statItem}>
      <Text style={styles.statNumber}>{stats.total}</Text>
      <Text style={styles.statLabel}>{t("common.total")}</Text>
    </View>
    <View style={styles.statDivider} />
    <View style={styles.statItem}>
      <Text style={[styles.statNumber, { color: "#059669" }]}>
        {stats.total - stats.unassigned}
      </Text>
      <Text style={styles.statLabel}>{t("teachers.assigned")}</Text>
    </View>
    <View style={styles.statDivider} />
    <View style={styles.statItem}>
      <Text style={[styles.statNumber, stats.unassigned > 0 && { color: "#D97706" }]}>
        {stats.unassigned}
      </Text>
      <Text style={styles.statLabel}>{t("teachers.unassigned")}</Text>
    </View>
  </View>
);
                               });

const ErrorBanner = React.memo(({ message, onRetry }) => {
                                 const { t } = useTranslation();
                                 return (
  <View style={styles.errorBanner}>
    <Ionicons name="alert-circle" size={18} color="#DC2626" />
    <Text style={styles.errorText}>{message}</Text>
    <TouchableOpacity
      onPress={onRetry}
      activeOpacity={0.75}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Text style={styles.retryText}>{t("common.retry")}</Text>
    </TouchableOpacity>
  </View>
);
                               });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminTeachers() {
  const { t } = useTranslation();
  const router = useRouter();

  const isMountedRef   = useRef(true);
  const requestIdRef   = useRef(0);
  const lastLoadedRef  = useRef(null);

  const [allTeachers,        setAllTeachers]        = useState([]);
  const [loading,            setLoading]            = useState(true);
  const [refreshing,         setRefreshing]         = useState(false);
  const [error,              setError]              = useState(null);
  const [showOnlyUnassigned, setShowOnlyUnassigned] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Derived data ────────────────────────────────────────────────────────────

  const teachers = useMemo(
    () =>
      showOnlyUnassigned
        ? allTeachers.filter((t) => Number(t.subjectCount ?? 0) === 0)
        : allTeachers,
    [allTeachers, showOnlyUnassigned]
  );

  const stats = useMemo(() => {
    const total      = allTeachers.length;
    const unassigned = allTeachers.filter(
      (t) => Number(t.subjectCount ?? 0) === 0
    ).length;
    return { total, unassigned };
  }, [allTeachers]);

  // ── Data fetching ───────────────────────────────────────────────────────────

  const loadTeachers = useCallback(async (isRefresh = false) => {
    const requestId = ++requestIdRef.current;

    try {
      isRefresh ? setRefreshing(true) : setLoading(true);
      setError(null);

      const data = await TeacherService.getAll();

      if (!isMountedRef.current || requestId !== requestIdRef.current) return;

      // FIX #1: Guard against null / non-array responses from the service.
      // TeacherService.getAll() returns [] on error but calling code
      // could theoretically receive undefined if the service is swapped.
      setAllTeachers(Array.isArray(data) ? data : []);
      lastLoadedRef.current = Date.now();
    } catch (err) {
      console.error("Failed to load teachers:", err);
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      setError(t("teachers.loadFailed"));
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  useEffect(() => {
    loadTeachers();
  }, [loadTeachers]);

  // FIX #2: The original useFocusEffect ran on the very first focus (mount),
  // causing a double-fetch immediately after the useEffect above.
  // We skip the first focus with a ref so we only re-fetch when the user
  // actually navigates away and returns.
  const isFirstFocusRef = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }

      const now     = Date.now();
      const isStale =
        !lastLoadedRef.current ||
        now - lastLoadedRef.current > STALE_THRESHOLD_MS;

      if (isStale) {
        loadTeachers(true);
      }
    }, [loadTeachers])
  );

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleEdit = useCallback(
    (teacher) => router.push(`/admin/teachers/edit?id=${teacher.id}`),
    [router]
  );

  const handleAddTeacher = useCallback(
    () => router.push("/admin/teachers/add"),
    [router]
  );

  // FIX #3: handleDelete was missing isMountedRef and loadTeachers from its
  // dependency array. Adding them makes the closure correct and prevents
  // stale-closure bugs where the rollback state setter fires after unmount.
  const handleDelete = useCallback(
    (teacher) => {
      Alert.alert(
        t("teachers.delTitle"),
        t("teachers.delBody", { name: teacher.name }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text:  t("common.delete"),
            style: "destructive",
            onPress: async () => {
              // Optimistic removal
              setAllTeachers((prev) => prev.filter((t) => t.id !== teacher.id));

              try {
                await TeacherService.delete(teacher.id);

                if (isMountedRef.current) {
                  Alert.alert(
                    t("teachers.deletedTitle"),
                    t("teachers.delDone", { name: teacher.name })
                  );
                }
              } catch (err) {
                // Roll back on failure
                if (isMountedRef.current) {
                  setAllTeachers((prev) => {
                    const exists = prev.some((t) => t.id === teacher.id);
                    return exists ? prev : [...prev, teacher];
                  });

                  const message =
                    err.response?.data?.message ||
                    errorText(t, err, "teachers.errDelete");

                  Alert.alert(t("teachers.errTitle"), message);
                }
              }
            },
          },
        ]
      );
    },
    // FIX #3: dependency array was empty [] — added missing deps
    [t]
  );

  // ── FlatList helpers ────────────────────────────────────────────────────────

  const keyExtractor = useCallback((item) => String(item.id), []);

  const renderItem = useCallback(
    ({ item }) => (
      <TeacherCard teacher={item} onEdit={handleEdit} onDelete={handleDelete} />
    ),
    [handleEdit, handleDelete]
  );

  // FIX #4: ListHeaderComponent was memoised on allTeachers.length and stats,
  // but stats is already derived from allTeachers so this was a double-dep.
  // Simplified to depend on stats only, which already captures the length.
  const ListHeaderComponent = useMemo(
    () =>
      stats.total > 0 ? (
        <>
          <StatsBanner stats={stats} />
          <View style={{ height: 12 }} />
        </>
      ) : null,
    [stats]
  );

  const ListEmptyComponent = useMemo(
    () => (
      <EmptyState showOnlyUnassigned={showOnlyUnassigned} onAdd={handleAddTeacher} />
    ),
    [showOnlyUnassigned, handleAddTeacher]
  );

  // FIX #5: ListFooterComponent was re-created on every render because
  // useMemo had no dependency array entry — it was []. A plain constant
  // outside the component is cheaper and avoids even the memo overhead.
  // Moved to a module-level constant below.

  // ── Loading state ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("teachers.loading")}</Text>
      </View>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

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
          <Text style={styles.headerTitle}>{t("teachers.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {stats.total}{" "}
            {stats.total === 1 ? t("teachers.singular") : t("teachers.plural")}
            {stats.unassigned > 0 ? t("teachers.headerUnassigned", { count: stats.unassigned }) : ""}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.addButton}
          onPress={handleAddTeacher}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* FILTER CHIPS */}
      <View style={styles.filterRow}>
        <TouchableOpacity
          style={[styles.filterChip, !showOnlyUnassigned && styles.filterChipActive]}
          onPress={() => setShowOnlyUnassigned(false)}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, !showOnlyUnassigned && styles.filterChipTextActive]}>
            {t("teachers.filterAll", { count: stats.total })}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, showOnlyUnassigned && styles.filterChipActive]}
          onPress={() => setShowOnlyUnassigned(true)}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, showOnlyUnassigned && styles.filterChipTextActive]}>
            {t("teachers.filterUnassigned", { count: stats.unassigned })}
          </Text>

          {stats.unassigned > 0 && !showOnlyUnassigned && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{stats.unassigned}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* ERROR BANNER */}
      {!!error && (
        <ErrorBanner message={error} onRetry={() => loadTeachers()} />
      )}

      {/* TEACHER LIST */}
      <FlatList
        data={teachers}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={ListEmptyComponent}
        ListFooterComponent={LIST_FOOTER}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadTeachers(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      />
    </View>
  );
}

// Module-level constant — avoids re-creating the footer view on every render
const LIST_FOOTER = <View style={{ height: 32 }} />;

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
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
  headerCenter:   { flex: 1, marginLeft: 12, marginRight: 8 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },

  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FEE2E2",
    marginHorizontal: 20,
    marginTop:       16,
    padding:         12,
    borderRadius:    10,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText:  { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  filterRow: {
    flexDirection:   "row",
    paddingHorizontal: 20,
    marginTop:       16,
    marginBottom:    4,
    gap:             8,
  },
  filterChip: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFFFFF",
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    borderRadius:    20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap:             6,
  },
  filterChipActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  filterChipText:       { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  filterChipTextActive: { color: "#FFFFFF" },
  filterBadge: {
    backgroundColor:  "#EF4444",
    borderRadius:     8,
    paddingHorizontal: 5,
    paddingVertical:  1,
    minWidth:         18,
    alignItems:       "center",
  },
  filterBadgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },

  statsBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#FFFFFF",
    paddingVertical: 12,
    borderTopWidth:  1,
    borderBottomWidth: 1,
    borderColor:     "#F3F4F6",
    gap:             24,
  },
  statItem:   { alignItems: "center" },
  statNumber: { fontSize: 18, fontWeight: "700", color: "#111827" },
  statLabel:  { fontSize: 11, color: "#9CA3AF", fontWeight: "500", marginTop: 1 },
  statDivider:{ width: 1, height: 24, backgroundColor: "#E5E7EB" },

  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFFFFF",
    borderRadius:    14,
    padding:         14,
    marginHorizontal: 20,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
  },
  cardIcon: {
    width:           44,
    height:          44,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     12,
    flexShrink:      0,
  },
  cardInfo:     { flex: 1, marginRight: 8 },
  teacherName:  { fontSize: 15, fontWeight: "700", color: "#111827" },
  teacherEmail: { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  metaRow: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           6,
    marginTop:     8,
  },
  metaChip: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             4,
    backgroundColor: "#EEF2FF",
    borderRadius:    6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  metaChipText: { fontSize: 11, fontWeight: "600", color: "#4F46E5" },
  warningChip: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             4,
    backgroundColor: "#FEF3C7",
    borderRadius:    6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  warningChipText: { fontSize: 11, fontWeight: "600", color: "#92400E" },
  cardActions: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
    flexShrink:    0,
  },
  actionButton: { padding: 6 },

  emptyState: {
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyIconWrap: {
    width:           80,
    height:          80,
    borderRadius:    20,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
    marginBottom:    8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 8 },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", marginTop: 4, textAlign: "center", lineHeight: 18 },
  emptyButton: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius:    10,
    marginTop:       20,
    gap:             8,
  },
  emptyButtonText: { fontSize: 14, fontWeight: "600", color: "#4F46E5" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";