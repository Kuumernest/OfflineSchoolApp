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
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, levelAccent } from "../../../src/theme/colors";
import { tileShell } from "../../../src/components/Tiles";
import { HeaderIcon, IconSquare, Badge, EmptyState as TintEmpty } from "../../../src/components/Tinted";

const BRAND = ACCENT.indigo.solid;

// ─────────────────────────────────────────────────────────
// CLASS CARD
// ─────────────────────────────────────────────────────────

const ClassCard = React.memo(function ClassCard({
  classItem, onPress, onToggle, onDelete,
}) {
  const { t } = useTranslation();
  const isActive = !!classItem.isActive;
  const accent = levelAccent(classItem.level);
  const tint = ACCENT[accent];

  return (
    <TouchableOpacity
      style={[
        styles.classCard,
        { backgroundColor: tint.wash, borderLeftColor: tint.base },
        !isActive && styles.classCardInactive,
      ]}
      activeOpacity={0.7}
      onPress={() => onPress(classItem)}
      accessibilityRole="button"
      accessibilityLabel={`${classItem.name}, ${isActive ? "active" : "inactive"}`}
    >
      <IconSquare icon="school" accent={accent} size={44} radius={12} style={styles.classIcon} />

      <View style={styles.classInfo}>
        <Text style={[styles.className, !isActive && styles.classNameInactive]} numberOfLines={1}>
          {classItem.name}
        </Text>

        <View style={styles.classMeta}>
          <View style={styles.metaItem}>
            <Ionicons name="book-outline" size={13} color={tint.solid} />
            <Text style={styles.metaText}>
              {classItem.subjectCount ?? 0}{" "}
              {classItem.subjectCount === 1 ? "subject" : "subjects"}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="people-outline" size={13} color={tint.solid} />
            <Text style={styles.metaText}>
              {classItem.studentCount ?? 0}{" "}
              {classItem.studentCount === 1 ? "student" : "students"}
            </Text>
          </View>
        </View>

        {/* Only when the school has named one — an empty row reads as a
            missing value rather than a class without a form teacher. */}
        {classItem.classTeacherName ? (
          <View style={styles.metaItem}>
            <Ionicons name="person-outline" size={13} color={tint.solid} />
            <Text style={styles.metaText} numberOfLines={1}>
              {classItem.classTeacherName}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.classActions}>
        {!isActive && (
          <Badge
            label={t("common.inactive")}
            tone="warning"
            style={styles.inactiveBadge}
            textStyle={styles.inactiveBadgeText}
          />
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
            color={isActive ? COLORS.warning : COLORS.success}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onDelete(classItem)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
          accessibilityLabel={t("classesAdmin.a11yDelete")}
        >
          <Ionicons name="trash-outline" size={20} color={COLORS.danger} />
        </TouchableOpacity>

        <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
      </View>
    </TouchableOpacity>
  );
});

const EmptyState = React.memo(function EmptyState({ showInactive, onAdd }) {
  const { t } = useTranslation();
  return (
    <TintEmpty
      icon="school-outline"
      accent="indigo"
      style={styles.emptyState}
      title={showInactive ? t("classesAdmin.noneFound") : t("classesAdmin.noneActive")}
      message={showInactive
        ? t("classesAdmin.emptyFirst")
        : t("classesAdmin.emptyInactive")}
      action={
        <TouchableOpacity style={styles.emptyButton} onPress={onAdd} activeOpacity={0.7}>
          <Ionicons name="add-circle" size={18} color={BRAND} />
          <Text style={styles.emptyButtonText}>{t("classesAdmin.addClass")}</Text>
        </TouchableOpacity>
      }
    />
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
        <Text style={[styles.statNumber, { color: SEMANTIC.success.text }]}>{stats.active}</Text>
        <Text style={styles.statLabel}>{t("common.active")}</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statItem}>
        <Text style={[styles.statNumber, stats.inactive > 0 && { color: SEMANTIC.warning.text }]}>
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
  }, [showInactive, t]);

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
                err?.response?.data?.message || errorText(t, err) ||
                  `Failed to ${actionLabel.toLowerCase()} class`
              );
            }
          },
        },
      ]
    );
  }, [t]);

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
                  ? t("classesAdmin.removedWithSubjects", { name: classItem.name, count: deletedSubjects })
                  : t("classesAdmin.removed", { name: classItem.name })
              );
            } catch (err) {
              const status  = err?.response?.status;
              const message = err?.response?.data?.message || errorText(t, err, "classesAdmin.errDelete");

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
  }, [t]);

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
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
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
          <Ionicons name="add" size={24} color={COLORS.onPrimary} />
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
            <Ionicons name="alert-circle" size={18} color={SEMANTIC.error.icon} />
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
  loadingText:   { marginTop: 12, fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },
  scrollContent: { paddingBottom: 40 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        Platform.OS === "ios" ? 60 : 20,
    paddingBottom:     16,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: COLORS.page,
    alignItems: "center", justifyContent: "center",
  },
  headerIcon:     { marginLeft: 12, marginRight: 0 },
  headerCenter:   { flex: 1, marginLeft: 12, marginRight: 8 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSubtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  addButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: BRAND,
    alignItems: "center", justifyContent: "center",
  },

  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: SEMANTIC.error.box,
    marginHorizontal: 20, marginTop: 16,
    padding: 12, borderRadius: 10, gap: 8,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text, fontWeight: "500" },
  retryText: { fontSize: 13, color: SEMANTIC.error.text, fontWeight: "700" },

  filterBar: {
    flexDirection: "row",
    paddingHorizontal: 20, marginTop: 16, marginBottom: 8, gap: 8,
  },
  filterButton: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  filterButtonActive: { backgroundColor: BRAND, borderColor: BRAND },
  filterText:         { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  filterTextActive:   { color: COLORS.onPrimary },

  statsBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    marginHorizontal: 20, marginBottom: 12, marginTop: 4,
    borderRadius: 12, paddingVertical: 14,
    borderWidth: 1,
    ...tileShell("classes"),
    gap: 24,
  },
  statItem:    { alignItems: "center" },
  statNumber:  { fontSize: 20, fontWeight: "700", color: ACCENT.indigo.deep },
  statLabel:   { fontSize: 11, color: COLORS.textSecondary, fontWeight: "500", marginTop: 2 },
  statDivider: { width: 1, height: 28, backgroundColor: COLORS.border },

  classCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: 14, padding: 14,
    marginHorizontal: 20, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
    borderLeftWidth: 3,
  },
  classCardInactive: { opacity: 0.65, borderStyle: "dashed" },
  classIcon: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    marginRight: 12,
  },
  classInfo:         { flex: 1, marginRight: 8 },
  className:         { fontSize: 15, fontWeight: "700", color: COLORS.text },
  classNameInactive: { color: COLORS.textSecondary },
  classMeta:         { flexDirection: "row", marginTop: 4, gap: 12 },
  metaItem:          { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText:          { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },
  classActions:      { flexDirection: "row", alignItems: "center", gap: 4 },
  inactiveBadge: {
    alignSelf: "center",
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, marginRight: 4,
  },
  inactiveBadgeText: {
    fontSize: 10, fontWeight: "700",
    textTransform: "uppercase",
  },
  actionButton: { padding: 6 },

  emptyState: {
    alignItems: "center", justifyContent: "center",
    paddingVertical: 60, paddingHorizontal: 40,
  },
  emptyButton: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: ACCENT.indigo.wash,
    borderWidth: 1, borderColor: ACCENT.indigo.base,
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 10, marginTop: 20, gap: 8,
  },
  emptyButtonText: { fontSize: 14, fontWeight: "600", color: ACCENT.indigo.deep },
});