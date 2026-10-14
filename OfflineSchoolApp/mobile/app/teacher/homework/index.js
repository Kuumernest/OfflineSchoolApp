// app/teacher/homework/index.js
//
// The homework a teacher has set, and the way to set more.
//
// The dashboard has linked here since the module list was written, and the
// quick action "Assign HW" has pointed at /teacher/homework/create just as
// long. Neither screen existed: expo-router had nothing to open, and the
// teacher got a navigation error. Everything underneath was already there —
// the server's /api/homework routes, the phone's homework tables, the outbox
// mutations the service enqueues — so this is the screen, not the feature.
//
// Reads the phone's tables (a refresh pulls the server's copy first, when
// there is a network) and offers only the classes and subjects the server says
// this teacher teaches, through the same teacherScope the quiz screens use.
// The server refuses anything else regardless.

import React, { useState, useCallback, useMemo, memo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, StatusBar,
  ActivityIndicator, Alert, RefreshControl, ScrollView,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useAuthStore }    from "../../../src/store/auth.store";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import {
  getHomeworkList, deleteHomework, publishHomework, unpublishHomework,
} from "../../../src/services/homework.service";
import { fetchTeacherScope, allTeacherSubjects } from "../../../src/services/teacherScope.service";
import { SyncManager }     from "../../../src/services/syncManager";
import { errorText }       from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const STATUS_FILTERS = ["all", "published", "draft"];

/** A due date the way the reader's locale writes it; the time only when set. */
export const formatDue = (iso, locale) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime ? `${date} · ${d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : date;
};

const isOverdue = (iso) => Boolean(iso) && new Date(iso).getTime() < Date.now();

// ─────────────────────────────────────────────────────────────
// PIECES
// ─────────────────────────────────────────────────────────────

const Chip = memo(({ label, active, onPress }) => (
  <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} activeOpacity={0.8}>
    <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{label}</Text>
  </TouchableOpacity>
));

const EmptyState = memo(({ icon, title, subtitle, actionLabel, onAction }) => (
  <View style={styles.emptyState}>
    <Ionicons name={icon} size={48} color="#D1D5DB" />
    <Text style={styles.emptyTitle}>{title}</Text>
    {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    {actionLabel && onAction ? (
      <TouchableOpacity style={styles.emptyBtn} onPress={onAction} activeOpacity={0.8}>
        <Ionicons name="add" size={16} color="#FFF" />
        <Text style={styles.emptyBtnText}>{actionLabel}</Text>
      </TouchableOpacity>
    ) : null}
  </View>
));

const HomeworkCard = memo(({ hw, locale, t, onOpen, onEdit, onToggle, onDelete, busy }) => {
  const due      = formatDue(hw.due_date, locale);
  const overdue  = isOverdue(hw.due_date);
  const isLive   = Number(hw.is_published) === 1;
  const subs     = Number(hw.submission_count ?? 0);
  const graded   = Number(hw.graded_count ?? 0);
  return (
    <TouchableOpacity style={styles.card} onPress={() => onOpen(hw)} activeOpacity={0.85}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={2}>{hw.title}</Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {hw.class_name || t("teacherHw.unknownClass")}{"  ·  "}{hw.subject_name || t("teacherHw.unknownSubject")}
          </Text>
        </View>
        <View style={[styles.badge, isLive ? styles.badgeLive : styles.badgeDraft]}>
          <Text style={[styles.badgeText, isLive ? styles.badgeTextLive : styles.badgeTextDraft]}>
            {t(isLive ? "teacherHw.published" : "teacherHw.draft")}
          </Text>
        </View>
      </View>

      <View style={styles.cardRow}>
        <Ionicons name="calendar-outline" size={14} color={overdue ? "#DC2626" : "#6B7280"} />
        <Text style={[styles.cardRowText, overdue && { color: "#DC2626" }]}>
          {due ? t("teacherHw.due", { date: due }) : t("teacherHw.noDue")}
          {overdue ? `  ·  ${t("teacherHw.overdue")}` : ""}
        </Text>
      </View>
      <View style={styles.cardRow}>
        <Ionicons name="people-outline" size={14} color="#6B7280" />
        <Text style={styles.cardRowText}>
          {t("teacherHw.submissions", { count: subs })}
          {subs > 0 ? `  ·  ${t("teacherHw.graded", { graded, total: subs })}` : ""}
        </Text>
      </View>

      <View style={styles.cardActions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onEdit(hw)} disabled={busy}>
          <Ionicons name="create-outline" size={16} color="#4F46E5" />
          <Text style={styles.actionText}>{t("common.edit")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onToggle(hw)} disabled={busy}>
          <Ionicons name={isLive ? "eye-off-outline" : "send-outline"} size={16} color="#059669" />
          <Text style={[styles.actionText, { color: "#059669" }]}>
            {t(isLive ? "teacherHw.unpublish" : "teacherHw.publish")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onDelete(hw)} disabled={busy}>
          <Ionicons name="trash-outline" size={16} color="#DC2626" />
          <Text style={[styles.actionText, { color: "#DC2626" }]}>{t("common.delete")}</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

// ─────────────────────────────────────────────────────────────
// SCREEN
// ─────────────────────────────────────────────────────────────

export default function TeacherHomeworkScreen() {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const screenPad = useScreenInsets({ top: 16 });
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;

  const [scope,      setScope]      = useState(null);
  const [homework,   setHomework]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [busyId,     setBusyId]     = useState(null);

  const [classFilter,   setClassFilter]   = useState(null);
  const [subjectFilter, setSubjectFilter] = useState(null);
  const [statusFilter,  setStatusFilter]  = useState("all");

  const load = useCallback(async (isRefresh = false) => {
    if (!schoolId || !teacherId) {
      setLoading(false);
      setError(t("teacherHw.sessionError"));
      return;
    }
    try {
      if (isRefresh) setRefreshing(true); else setLoading(true);
      setError(null);
      // A refresh asks the server first; the pull reports its own failure and
      // the local read below still answers with what the phone has.
      if (isRefresh) await SyncManager.syncHomeworkData();
      const [nextScope, rows] = await Promise.all([
        fetchTeacherScope({ teacherId, schoolId, force: isRefresh }),
        getHomeworkList({ schoolId: String(schoolId), created_by: String(teacherId), limit: 500 }),
      ]);
      setScope(nextScope);
      setHomework(rows ?? []);
    } catch (err) {
      console.warn("[TeacherHomework] load failed:", err?.message);
      setError(errorText(t, err, "teacherHw.loadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // t reads the live locale at call time; listing it would reload on a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, teacherId]);

  // Reload whenever the screen is shown again — after creating or editing.
  useFocusEffect(useCallback(() => { load(false); }, [load]));

  const classes  = scope?.classes ?? [];
  const subjects = useMemo(() => {
    if (!scope) return [];
    return classFilter ? (scope.subjectsByClassId[classFilter] ?? []) : allTeacherSubjects(scope);
  }, [scope, classFilter]);

  const visible = useMemo(() => homework.filter((h) => {
    if (classFilter   && String(h.class_id)   !== String(classFilter))   return false;
    if (subjectFilter && String(h.subject_id) !== String(subjectFilter)) return false;
    if (statusFilter === "published" && Number(h.is_published) !== 1) return false;
    if (statusFilter === "draft"     && Number(h.is_published) === 1) return false;
    return true;
  }), [homework, classFilter, subjectFilter, statusFilter]);

  const pickClass = (id) => { setClassFilter(id); setSubjectFilter(null); };

  const onOpen = useCallback((hw) => router.push({ pathname: "/teacher/homework/[id]", params: { id: hw.id } }), [router]);
  const onEdit = useCallback((hw) => router.push({ pathname: "/teacher/homework/create", params: { id: hw.id } }), [router]);

  const onToggle = useCallback(async (hw) => {
    setBusyId(hw.id);
    try {
      if (Number(hw.is_published) === 1) await unpublishHomework(hw.id);
      else                                await publishHomework(hw.id);
      await load(false);
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err, "teacherHw.statusFailed"));
    } finally {
      setBusyId(null);
    }
  }, [load, t]);

  const onDelete = useCallback((hw) => {
    Alert.alert(
      t("teacherHw.deleteTitle"),
      t("teacherHw.deleteBody", { title: hw.title }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"), style: "destructive",
          onPress: async () => {
            setBusyId(hw.id);
            try {
              await deleteHomework(hw.id);
              setHomework((prev) => prev.filter((h) => h.id !== hw.id));
            } catch (err) {
              Alert.alert(t("common.error"), errorText(t, err, "teacherHw.deleteFailed"));
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  }, [t]);

  const goCreate = () => router.push("/teacher/homework/create");

  // ── Render ─────────────────────────────────────────────────
  const renderBody = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#D97706" />
          <Text style={styles.loadingText}>{t("teacherHw.loading")}</Text>
        </View>
      );
    }
    if (error) {
      return (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={48} color="#DC2626" />
          <Text style={styles.errorTitle}>{t("teacherHw.loadFailed")}</Text>
          <Text style={styles.emptySub}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load(false)} activeOpacity={0.8}>
            <Ionicons name="refresh" size={16} color="#FFF" />
            <Text style={styles.emptyBtnText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (homework.length === 0 && classes.length === 0) {
      return (
        <EmptyState icon="school-outline" title={t("teacherHw.noScopeTitle")} subtitle={t("teacherHw.noScopeSub")} />
      );
    }
    if (homework.length === 0) {
      return (
        <EmptyState icon="clipboard-outline" title={t("teacherHw.emptyTitle")} subtitle={t("teacherHw.emptySub")}
          actionLabel={t("teacherHw.emptyAction")} onAction={goCreate} />
      );
    }
    if (visible.length === 0) {
      return <EmptyState icon="filter-outline" title={t("teacherHw.emptyFiltered")} />;
    }
    return (
      <FlatList
        data={visible}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <HomeworkCard hw={item} locale={locale} t={t} busy={busyId === item.id}
            onOpen={onOpen} onEdit={onEdit} onToggle={onToggle} onDelete={onDelete} />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#D97706" />}
      />
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      <View style={[styles.header, { paddingTop: screenPad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("teacherHw.title")}</Text>
          <Text style={styles.headerSub}>{t("teacherHw.count", { count: homework.length })}</Text>
        </View>
        <TouchableOpacity style={styles.createBtn} onPress={goCreate} activeOpacity={0.8}>
          <Ionicons name="add" size={20} color="#FFF" />
          <Text style={styles.createBtnText}>{t("teacherHw.new")}</Text>
        </TouchableOpacity>
      </View>

      {scope && scope.source !== "api" ? (
        <View style={styles.offlineNote}>
          <Ionicons name="cloud-offline-outline" size={14} color="#92400E" />
          <Text style={styles.offlineText}>{t("teacherHw.offlineNote")}</Text>
        </View>
      ) : null}

      {classes.length > 0 ? (
        <View style={styles.filters}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip label={t("teacherHw.allClasses")} active={!classFilter} onPress={() => pickClass(null)} />
            {classes.map((c) => (
              <Chip key={c.id} label={c.name || c.id} active={classFilter === c.id} onPress={() => pickClass(c.id)} />
            ))}
          </ScrollView>
          {subjects.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              <Chip label={t("teacherHw.allSubjects")} active={!subjectFilter} onPress={() => setSubjectFilter(null)} />
              {subjects.map((s) => (
                <Chip key={s.id} label={s.name || s.id} active={subjectFilter === s.id}
                  onPress={() => setSubjectFilter((prev) => (prev === s.id ? null : s.id))} />
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.statusRow}>
            {STATUS_FILTERS.map((k) => (
              <TouchableOpacity key={k} style={[styles.statusTab, statusFilter === k && styles.statusTabActive]}
                onPress={() => setStatusFilter(k)}>
                <Text style={[styles.statusText, statusFilter === k && styles.statusTextActive]}>
                  {t(k === "all" ? "teacherHw.filterAll" : k === "published" ? "teacherHw.filterPublished" : "teacherHw.filterDraft")}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>{renderBody()}</View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 0,
    paddingBottom: 14, backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backButton: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  createBtn: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#D97706", borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, gap: 4,
  },
  createBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  offlineNote: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF3C7",
    paddingHorizontal: 16, paddingVertical: 8,
  },
  offlineText: { fontSize: 12, color: "#92400E", flex: 1 },

  filters: { backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6", paddingVertical: 8, gap: 8 },
  chipRow: { paddingHorizontal: 16, gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "#E5E7EB", maxWidth: 200,
  },
  chipActive: { backgroundColor: "#FEF3C7", borderColor: "#D97706" },
  chipText: { fontSize: 13, color: "#4B5563", fontWeight: "500" },
  chipTextActive: { color: "#B45309", fontWeight: "700" },
  statusRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  statusTab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: "#F9FAFB" },
  statusTabActive: { backgroundColor: "#111827" },
  statusText: { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  statusTextActive: { color: "#FFF" },

  listContent: { padding: 16, paddingBottom: 32, gap: 12 },
  card: {
    backgroundColor: "#FFF", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#F3F4F6",
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardMeta: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeLive: { backgroundColor: "#D1FAE5" },
  badgeDraft: { backgroundColor: "#F3F4F6" },
  badgeText: { fontSize: 11, fontWeight: "700" },
  badgeTextLive: { color: "#047857" },
  badgeTextDraft: { color: "#6B7280" },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  cardRowText: { fontSize: 12, color: "#4B5563" },
  cardActions: {
    flexDirection: "row", gap: 6, marginTop: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#F3F4F6",
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, backgroundColor: "#F9FAFB",
  },
  actionText: { fontSize: 12, fontWeight: "600", color: "#4F46E5" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  loadingText: { fontSize: 13, color: "#9CA3AF" },
  errorTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginTop: 6 },
  retryBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#D97706",
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, marginTop: 8,
  },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginTop: 8, textAlign: "center" },
  emptySub: { fontSize: 13, color: "#6B7280", textAlign: "center", lineHeight: 19 },
  emptyBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#D97706",
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, marginTop: 10,
  },
  emptyBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});
