import React, {
  useState,
  useEffect,
  useCallback,
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
  RefreshControl,
  Alert,
  Platform,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons }                  from "@expo/vector-icons";
import { ClassService }              from "../../../src/services/class.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

const BRAND = "#4F46E5";

// ─────────────────────────────────────────────────────────
// CLASS CARD
// ─────────────────────────────────────────────────────────

const ClassCard = React.memo(function ClassCard({
  classItem, onPress, onToggle, onDelete,
}) {
  const { t } = useTranslation();
  const isActive = !!classItem.isActive;

  return (
    <TouchableOpacity
      style={[styles.classCard, !isActive && styles.classCardInactive]}
      activeOpacity={0.7}
      onPress={() => onPress(classItem)}
      accessibilityRole="button"
      accessibilityLabel={`${classItem.name}, ${isActive ? "active" : "inactive"}`}
    >
      <View style={[styles.classIcon, { backgroundColor: isActive ? "#EEF2FF" : "#F3F4F6" }]}>
        <Ionicons name="school" size={22} color={isActive ? BRAND : "#9CA3AF"} />
      </View>

      <View style={styles.classInfo}>
        <Text style={[styles.className, !isActive && styles.classNameInactive]} numberOfLines={1}>
          {classItem.name}
        </Text>

        <View style={styles.classMeta}>
          <View style={styles.metaItem}>
            <Ionicons name="book-outline" size={13} color="#6B7280" />
            <Text style={styles.metaText}>
              {classItem.subjectCount ?? 0}{" "}
              {classItem.subjectCount === 1 ? "subject" : "subjects"}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="people-outline" size={13} color="#6B7280" />
            <Text style={styles.metaText}>
              {classItem.studentCount ?? 0}{" "}
              {classItem.studentCount === 1 ? "student" : "students"}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.classActions}>
        {!isActive && (
          <View style={styles.inactiveBadge}>
            <Text style={styles.inactiveBadgeText}>{t("common.inactive")}</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onToggle(classItem)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
          accessibilityLabel={isActive ? t("classesAdmin.a11yDeactivate") : t("classesAdmin.a11yActivate")}
        >
          <Ionicons
            name={isActive ? "pause-circle-outline" : "play-circle-outline"}
            size={22}
            color={isActive ? "#D97706" : "#059669"}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onDelete(classItem)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
          accessibilityLabel={t("classesAdmin.a11yDelete")}
        >
          <Ionicons name="trash-outline" size={20} color="#DC2626" />
        </TouchableOpacity>

        <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
      </View>
    </TouchableOpacity>
  );
});

const EmptyState = React.memo(function EmptyState({ showInactive, onAdd }) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <Ionicons name="school-outline" size={48} color="#D1D5DB" />
      <Text style={styles.emptyTitle}>
        {showInactive ? t("classesAdmin.noneFound") : t("classesAdmin.noneActive")}
      </Text>
      <Text style={styles.emptySubtitle}>
        {showInactive
          ? t("classesAdmin.emptyFirst")
          : t("classesAdmin.emptyInactive")}
      </Text>
      <TouchableOpacity style={styles.emptyButton} onPress={onAdd} activeOpacity={0.7}>
        <Ionicons name="add-circle" size={18} color={BRAND} />
        <Text style={styles.emptyButtonText}>{t("classesAdmin.addClass")}</Text>
      </TouchableOpacity>
    </View>
  );
});

const StatsBanner = React.memo(function StatsBanner({ stats }) {
  const { t } = useTranslation();
  return (
    <View style={styles.statsBanner}>
      <View style={styles.statItem}>
        <Text style={styles.statNumber}>{stats.total}</Text>
        <Text style={styles.statLabel}>{t("common.total")}</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statItem}>
        <Text style={[styles.statNumber, { color: "#059669" }]}>{stats.active}</Text>
        <Text style={styles.statLabel}>{t("common.active")}</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statItem}>
        <Text style={[styles.statNumber, stats.inactive > 0 && { color: "#D97706" }]}>
          {stats.inactive}
        </Text>
        <Text style={styles.statLabel}>{t("common.inactive")}</Text>
      </View>
    </View>
  );
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function AdminClasses() {
  const { t } = useTranslation();
  const router = useRouter();

  const isMountedRef    = useRef(true);
  const isFirstFocusRef = useRef(true);

  const [classes,      setClasses]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [error,        setError]        = useState(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadClasses = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const data = await ClassService.getAll(showInactive);
      if (!isMountedRef.current) return;

      setClasses(data ?? []);
    } catch (err) {
      console.error("[AdminClasses] load error:", err);
      if (isMountedRef.current) {
        setError(t("classesAdmin.errLoad"));
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [showInactive]);

  useEffect(() => { loadClasses(); }, [loadClasses]);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }
      loadClasses(true);
    }, [loadClasses])
  );

  const handleCardPress = useCallback(
    (classItem) => router.push(`/admin/classes/edit?id=${classItem.id}`),
    [router]
  );

  const handleToggleActive = useCallback((classItem) => {
    const isActive    = !!classItem.isActive;
    const actionLabel = isActive ? t("classesAdmin.deactivate") : t("classesAdmin.activate");

    Alert.alert(
      `${actionLabel} Class`,
      `Are you sure you want to ${actionLabel.toLowerCase()} "${classItem.name}"?`,
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  actionLabel,
          style: isActive ? "destructive" : "default",
          onPress: async () => {
            setClasses((prev) =>
              prev.map((c) => c.id === classItem.id ? { ...c, isActive: !isActive } : c)
            );

            try {
              const updated = await ClassService.toggleActive(classItem.id);
              if (isMountedRef.current) {
                setClasses((prev) =>
                  prev.map((c) => c.id === updated.id ? { ...c, ...updated } : c)
                );
              }
            } catch (err) {
              setClasses((prev) =>
                prev.map((c) => c.id === classItem.id ? { ...c, isActive } : c)
              );
              Alert.alert(
                t("classesAdmin.errTitle"),
                err?.response?.data?.message || err?.message ||
                  `Failed to ${actionLabel.toLowerCase()} class`
              );
            }
          },
        },
      ]
    );
  }, []);

  const handleDelete = useCallback((classItem) => {
    Alert.alert(
      t("classesAdmin.delTitle"),
      t("classesAdmin.delBody", { name: classItem.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.delete"),
          style: "destructive",
          onPress: async () => {
            try {
              const result          = await ClassService.delete(classItem.id);
              const deletedSubjects = result?.deletedSubjects ?? 0;

              if (!isMountedRef.current) return;

              setClasses((prev) => prev.filter((c) => c.id !== classItem.id));

              Alert.alert(
                t("classesAdmin.deletedTitle"),
                deletedSubjects > 0
                  ? `"${classItem.name}" and ${deletedSubjects} subject${deletedSubjects === 1 ? "" : "s"} removed.`
                  : `"${classItem.name}" has been removed.`
              );
            } catch (err) {
              const status  = err?.response?.status;
              const message = err?.response?.data?.message || err?.message || t("classesAdmin.errDelete");

              if (status === 409 || message.toLowerCase().includes("student")) {
                Alert.alert(
                  t("classesAdmin.cannotDelete"),
                  `"${classItem.name}" has students enrolled.\n\nMove or remove all students first, then try again.`
                );
                return;
              }

              Alert.alert(t("classesAdmin.errTitle"), message);
            }
          },
        },
      ]
    );
  }, []);

  const handleAddClass = useCallback(() => router.push("/admin/classes/add"), [router]);

  const stats = useMemo(() => {
    const active = classes.filter((c) => c.isActive).length;
    return { total: classes.length, active, inactive: classes.length - active };
  }, [classes]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={BRAND} />
        <Text style={styles.loadingText}>{t("classesAdmin.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" translucent={false} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
          accessibilityLabel={t("common.goBack")}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("classesAdmin.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {stats.total} {stats.total === 1 ? "class" : "classes"}
            {stats.inactive > 0 ? ` · ${stats.inactive} inactive` : ""}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.addButton}
          onPress={handleAddClass}
          activeOpacity={0.7}
          accessibilityLabel={t("classesAdmin.a11yAdd")}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.filterButton, !showInactive && styles.filterButtonActive]}
          onPress={() => setShowInactive(false)}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterText, !showInactive && styles.filterTextActive]}>
            Active ({stats.active})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterButton, showInactive && styles.filterButtonActive]}
          onPress={() => setShowInactive(true)}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterText, showInactive && styles.filterTextActive]}>
            All ({stats.total})
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadClasses(true)}
            tintColor={BRAND}
            colors={[BRAND]}
          />
        }
      >
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadClasses()}
              activeOpacity={0.75}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {classes.length > 0 && <StatsBanner stats={stats} />}

        {classes.length === 0 ? (
          <EmptyState showInactive={showInactive} onAdd={handleAddClass} />
        ) : (
          classes.map((classItem) => (
            <ClassCard
              key={classItem.id}
              classItem={classItem}
              onPress={handleCardPress}
              onToggle={handleToggleActive}
              onDelete={handleDelete}
            />
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#F9FAFB" },
  centered:      { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText:   { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingBottom: 40 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        Platform.OS === "ios" ? 60 : 20,
    paddingBottom:     16,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter:   { flex: 1, marginLeft: 12, marginRight: 8 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: BRAND,
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

  filterBar: {
    flexDirection: "row",
    paddingHorizontal: 20, marginTop: 16, marginBottom: 8, gap: 8,
  },
  filterButton: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#FFFFFF",
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  filterButtonActive: { backgroundColor: BRAND, borderColor: BRAND },
  filterText:         { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  filterTextActive:   { color: "#FFFFFF" },

  statsBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: "#FFFFFF",
    marginHorizontal: 20, marginBottom: 12, marginTop: 4,
    borderRadius: 12, paddingVertical: 14,
    borderWidth: 1, borderColor: "#E5E7EB",
    gap: 24,
  },
  statItem:    { alignItems: "center" },
  statNumber:  { fontSize: 20, fontWeight: "700", color: "#111827" },
  statLabel:   { fontSize: 11, color: "#9CA3AF", fontWeight: "500", marginTop: 2 },
  statDivider: { width: 1, height: 28, backgroundColor: "#E5E7EB" },

  classCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14, padding: 14,
    marginHorizontal: 20, marginBottom: 8,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  classCardInactive: { opacity: 0.65, borderColor: "#F3F4F6", borderStyle: "dashed" },
  classIcon: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    marginRight: 12,
  },
  classInfo:         { flex: 1, marginRight: 8 },
  className:         { fontSize: 15, fontWeight: "700", color: "#111827" },
  classNameInactive: { color: "#9CA3AF" },
  classMeta:         { flexDirection: "row", marginTop: 4, gap: 12 },
  metaItem:          { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText:          { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  classActions:      { flexDirection: "row", alignItems: "center", gap: 4 },
  inactiveBadge: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, marginRight: 4,
  },
  inactiveBadgeText: {
    fontSize: 10, fontWeight: "700",
    color: "#D97706", textTransform: "uppercase",
  },
  actionButton: { padding: 6 },

  emptyState: {
    alignItems: "center", justifyContent: "center",
    paddingVertical: 60, paddingHorizontal: 40,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", marginTop: 4, textAlign: "center" },
  emptyButton: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 10, marginTop: 20, gap: 8,
  },
  emptyButtonText: { fontSize: 14, fontWeight: "600", color: BRAND },
});