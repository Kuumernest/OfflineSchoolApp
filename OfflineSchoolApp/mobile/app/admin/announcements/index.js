// app/admin/announcements/index.js
"use strict";

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  Alert,
} from "react-native";
import { useRouter }       from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import AnnouncementService from "../../../src/services/announcement.service";

const FILTERS = [
  { key: "all",          labelKey: "annAdmin.filterAll",           icon: "megaphone-outline"  },
  { key: "from_teachers",labelKey: "annAdmin.filterFromTeachers",  icon: "people-outline"    },
  { key: "teachers",     labelKey: "annAdmin.filterToTeachers",    icon: "person-outline"    },
  { key: "students",     labelKey: "annAdmin.filterToStudents",    icon: "school-outline"    },
  { key: "class",        labelKey: "annAdmin.filterByClass",       icon: "layers-outline"    },
  { key: "urgent",       labelKey: "annAdmin.filterUrgent",         icon: "warning-outline"   },
  { key: "unread",       labelKey: "annAdmin.filterUnread",         icon: "mail-unread-outline"},
];

const PRIORITY_COLORS = {
  normal:    { bg: "#F0FDF4", text: "#15803D", border: "#BBF7D0" },
  important: { bg: "#FEF3C7", text: "#92400E", border: "#FDE68A" },
  urgent:    { bg: "#FEE2E2", text: "#991B1B", border: "#FECACA" },
};

const AUDIENCE_LABELS = {
  all:      { labelKey: "annAdmin.audAll",  icon: "globe-outline",  color: "#4F46E5" },
  teachers: { labelKey: "annAdmin.audTeachersShort",  icon: "people-outline", color: "#0891B2" },
  students: { labelKey: "annAdmin.audStudentsShort",  icon: "school-outline", color: "#7C3AED" },
  class:    { labelKey: "annAdmin.audClassShort",     icon: "layers-outline", color: "#EA580C" },
};

const AUTHOR_ROLE_COLORS = {
  super_admin:  { labelKey: "annAdmin.roleSuperAdmin",   color: "#4F46E5", bg: "#EEF2FF" },
  school_admin: { labelKey: "annAdmin.roleSchoolAdmin",  color: "#4F46E5", bg: "#EEF2FF" },
  admin:        { labelKey: "annAdmin.roleAdmin",         color: "#4F46E5", bg: "#EEF2FF" },
  teacher:      { labelKey: "annAdmin.roleTeacher",       color: "#0891B2", bg: "#E0F2FE" },
};

// `t` is a parameter, not a hook call: this runs once per announcement row
// inside a .map(), and a hook fired a list-length-dependent number of times
// per render throws "Rendered more hooks than during the previous render" the
// first time the list changes size. Same convention as formatDate(today, t)
// in attendance/index.js.
const formatDate = (dateStr, t) => {
  if (!dateStr) return "";
  const d       = new Date(dateStr);
  const now     = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr  = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1)  return t("annAdmin.justNow");
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr  < 24) return `${diffHr}h ago`;
  if (diffDay < 7)  return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const isExpired = (d) => d && new Date(d) < new Date();

function StatCard({ icon, label, value, color }) {
  return (
    <View style={[styles.statCard, { borderLeftColor: color }]}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={styles.statValue}>{value ?? 0}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function AdminAnnouncementsScreen() {
  const { t } = useTranslation();
  const router    = useRouter();
  const isMounted = useRef(true);

  const [announcements, setAnnouncements] = useState([]);
  const [stats,         setStats]         = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [activeFilter,  setActiveFilter]  = useState("all");

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const buildFilters = useCallback((filterKey) => {
    switch (filterKey) {
      case "from_teachers":
        return { authorId: "TEACHER_ROLE" };
      case "urgent":
        return { priority: "urgent" };
      case "unread":
        return { unreadOnly: true };
      case "teachers":
      case "students":
      case "class":
        return { audience: filterKey };
      default:
        return {};
    }
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      let data;

      if (activeFilter === "from_teachers") {
        const all = await AnnouncementService.getAnnouncements({ limit: 200 });
        data = all.filter(
          (a) =>
            a.authorRole === "teacher" ||
            a.author_role === "teacher"
        );
      } else {
        const filters = buildFilters(activeFilter);
        data = await AnnouncementService.getAnnouncements({
          ...filters,
          limit: 100,
        });
      }

      const statsData = await AnnouncementService.getAnnouncementStats();

      if (isMounted.current) {
        setAnnouncements(data || []);
        setStats(statsData);
      }
    } catch (err) {
      console.error("loadData error:", err.message);
    } finally {
      if (isMounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeFilter, buildFilters]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDelete = useCallback((id, title) => {
    Alert.alert(
      t("annAdmin.deleteTitle"),
      `Delete "${title}"?\n\nThis will remove it for all recipients.`,
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await AnnouncementService.deleteAnnouncement(id);
              setAnnouncements((prev) =>
                prev.filter((a) => (a.id || a._id) !== id)
              );
              const s = await AnnouncementService.getAnnouncementStats();
              if (isMounted.current) setStats(s);
            } catch (err) {
              Alert.alert(t("annAdmin.errorTitle"), errorText(t, err, "annAdmin.deleteFailed"));
            }
          },
        },
      ]
    );
  }, [t]);

  const handleTogglePin = useCallback(async (id) => {
    try {
      const pinned = await AnnouncementService.togglePin(id);
      setAnnouncements((prev) =>
        prev.map((a) =>
          (a.id || a._id) === id ? { ...a, isPinned: pinned } : a
        )
      );
    } catch (err) {
      Alert.alert(t("annAdmin.errorTitle"), errorText(t, err));
    }
  }, [t]);

  const handleCardPress = useCallback((id) => {
    router.push(`/admin/announcements/${id}`);
  }, [router]);

  const teacherAnnouncementCount = announcements.filter(
    (a) => a.authorRole === "teacher" || a.author_role === "teacher"
  ).length;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("annAdmin.loadingAnnouncements")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("annAdmin.listTitle")}</Text>
          <Text style={styles.headerSub}>
            {stats?.unread ?? 0} unread · {stats?.total ?? 0} total
            {stats?.fromTeachers > 0
              ? ` · ${stats.fromTeachers} from teachers`
              : ""}
          </Text>
        </View>

        <TouchableOpacity
          onPress={() => router.push("/admin/announcements/create")}
          style={styles.createBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      {stats && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.statsScroll}
          contentContainerStyle={styles.statsContent}
        >
          <StatCard
            icon="mail-unread-outline"
            label={t("annAdmin.filterUnread")}
            value={stats.unread}
            color="#DC2626"
          />
          <StatCard
            icon="warning-outline"
            label={t("annAdmin.filterUrgent")}
            value={stats.urgentUnack}
            color="#EA580C"
          />
          <StatCard
            icon="pin-outline"
            label={t("annAdmin.pinned")}
            value={stats.pinned}
            color="#4F46E5"
          />
          <TouchableOpacity
            onPress={() => setActiveFilter("from_teachers")}
            activeOpacity={0.8}
          >
            <StatCard
              icon="people-outline"
              label={t("annAdmin.filterFromTeachers")}
              value={stats.fromTeachers}
              color="#0891B2"
            />
          </TouchableOpacity>
          <StatCard
            icon="list-outline"
            label={t("common.total")}
            value={stats.total}
            color="#059669"
          />
        </ScrollView>
      )}

      {activeFilter === "from_teachers" && (
        <View style={styles.filterBanner}>
          <View style={styles.filterBannerLeft}>
            <Ionicons name="people" size={18} color="#0891B2" />
            <Text style={styles.filterBannerText}>
              Showing {announcements.length} teacher announcement
              {announcements.length !== 1 ? "s" : ""}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setActiveFilter("all")}
            style={styles.filterBannerClear}
          >
            <Text style={styles.filterBannerClearText}>{t("annAdmin.clear")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filtersScroll}
        contentContainerStyle={styles.filtersContent}
      >
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => setActiveFilter(f.key)}
            style={[
              styles.filterChip,
              activeFilter === f.key && styles.filterChipActive,
            ]}
            activeOpacity={0.7}
          >
            <Ionicons
              name={f.icon}
              size={14}
              color={activeFilter === f.key ? "#FFF" : "#6B7280"}
            />
            <Text style={[
              styles.filterText,
              activeFilter === f.key && styles.filterTextActive,
            ]}>
              {t(f.labelKey)}
            </Text>
            {f.key === "from_teachers" && (stats?.fromTeachers ?? 0) > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>
                  {stats.fromTeachers}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {announcements.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons
              name={
                activeFilter === "from_teachers"
                  ? "people-outline"
                  : "megaphone-outline"
              }
              size={48}
              color="#D1D5DB"
            />
            <Text style={styles.emptyTitle}>
              {activeFilter === "from_teachers"
                ? t("annAdmin.emptyNoTeacherAnns")
                : t("annAdmin.emptyNone")}
            </Text>
            <Text style={styles.emptySubtitle}>
              {activeFilter === "from_teachers"
                ? t("annAdmin.emptyTeachersSub")
                : activeFilter === "all"
                ? t("annAdmin.emptyAllSub")
                : t("annAdmin.emptyFilterSub")}
            </Text>
            {activeFilter !== "all" && (
              <TouchableOpacity
                style={styles.clearFilterBtn}
                onPress={() => setActiveFilter("all")}
              >
                <Text style={styles.clearFilterText}>{t("annAdmin.clearFilter")}</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          announcements.map((item) => {
            const id      = item.id || item._id;
            const pri     = PRIORITY_COLORS[item.priority] || PRIORITY_COLORS.normal;
            const aud     = AUDIENCE_LABELS[item.audience] || AUDIENCE_LABELS.all;
            const role    = AUTHOR_ROLE_COLORS[item.authorRole || item.author_role];
            const expired = isExpired(item.expiresAt);
            const fromTeacher =
              item.authorRole === "teacher" ||
              item.author_role === "teacher";

            return (
              <TouchableOpacity
                key={id}
                style={[
                  styles.card,
                  item.isPinned  && styles.cardPinned,
                  !item.isRead   && styles.cardUnread,
                  fromTeacher    && styles.cardTeacher,
                  expired        && styles.cardExpired,
                ]}
                onPress={() => handleCardPress(id)}
                activeOpacity={0.75}
              >
                {!item.isRead && <View style={styles.unreadStrip} />}

                <View style={styles.cardTopRow}>
                  {role && (
                    <View style={[
                      styles.authorRoleBadge,
                      { backgroundColor: role.bg },
                    ]}>
                      <Ionicons
                        name={
                          fromTeacher
                            ? "person-outline"
                            : "shield-half-outline"
                        }
                        size={11}
                        color={role.color}
                      />
                      <Text style={[
                        styles.authorRoleText,
                        { color: role.color },
                      ]}>
                        {t(role.labelKey)}
                      </Text>
                    </View>
                  )}

                  {item.isPinned && (
                    <View style={styles.pinBadge}>
                      <Ionicons name="pin" size={10} color="#4F46E5" />
                      <Text style={styles.pinText}>{t("annAdmin.pinned")}</Text>
                    </View>
                  )}

                  {expired && (
                    <View style={styles.expiredBadge}>
                      <Ionicons name="time-outline" size={10} color="#6B7280" />
                      <Text style={styles.expiredBadgeText}>{t("annAdmin.expired")}</Text>
                    </View>
                  )}

                  <View style={{ flex: 1 }} />

                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        handleTogglePin(id);
                      }}
                      style={styles.actionBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons
                        name={item.isPinned ? "pin" : "pin-outline"}
                        size={15}
                        color={item.isPinned ? "#4F46E5" : "#9CA3AF"}
                      />
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        handleDelete(id, item.title);
                      }}
                      style={styles.actionBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={15}
                        color="#EF4444"
                      />
                    </TouchableOpacity>
                  </View>
                </View>

                <Text
                  style={[
                    styles.cardTitle,
                    !item.isRead && styles.cardTitleUnread,
                  ]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>

                <Text style={styles.cardBody} numberOfLines={2}>
                  {item.body}
                </Text>

                <View style={styles.cardMeta}>
                  <View style={[
                    styles.badge,
                    { backgroundColor: pri.bg, borderColor: pri.border },
                  ]}>
                    <Text style={[styles.badgeText, { color: pri.text }]}>
                      {item.priority}
                    </Text>
                  </View>

                  <View style={[
                    styles.badge,
                    {
                      backgroundColor: `${aud.color}15`,
                      borderColor:     `${aud.color}40`,
                    },
                  ]}>
                    <Ionicons name={aud.icon} size={10} color={aud.color} />
                    <Text style={[
                      styles.badgeText,
                      { color: aud.color, marginLeft: 3 },
                    ]}>
                      {t(aud.labelKey)}
                    </Text>
                  </View>

                  {item.targetClasses?.length > 0 && (
                    <View style={[
                      styles.badge,
                      { backgroundColor: "#FFF7ED", borderColor: "#FED7AA" },
                    ]}>
                      <Ionicons name="school-outline" size={10} color="#EA580C" />
                      <Text style={[
                        styles.badgeText,
                        { color: "#EA580C", marginLeft: 3 },
                      ]}>
                        {item.targetClasses.length} class
                        {item.targetClasses.length > 1 ? "es" : ""}
                      </Text>
                    </View>
                  )}

                  {!item._synced && (
                    <View style={styles.syncBadge}>
                      <Ionicons
                        name="cloud-offline-outline"
                        size={10}
                        color="#F59E0B"
                      />
                      <Text style={styles.syncBadgeText}>{t("annAdmin.offline")}</Text>
                    </View>
                  )}
                </View>

                <View style={styles.cardFooter}>
                  <View style={styles.authorRow}>
                    <Ionicons
                      name={
                        fromTeacher
                          ? "person-circle-outline"
                          : "shield-half-outline"
                      }
                      size={13}
                      color={fromTeacher ? "#0891B2" : "#9CA3AF"}
                    />
                    <Text style={[
                      styles.authorText,
                      fromTeacher && { color: "#0891B2", fontWeight: "600" },
                    ]}>
                      {item.authorName || t("annAdmin.unknown")}
                      {fromTeacher ? " (Teacher)" : ""}
                    </Text>
                  </View>
                  <Text style={styles.dateText}>
                    {formatDate(item.createdAt, t)}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: {
    marginTop:  12,
    fontSize:   14,
    color:      "#6B7280",
    fontWeight: "500",
  },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  createBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },

  statsScroll:  { maxHeight: 90 },
  statsContent: {
    paddingHorizontal: 20,
    paddingVertical:   12,
    gap:               10,
  },
  statCard: {
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    width:           100,
    alignItems:      "center",
    borderLeftWidth: 3,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  statValue: {
    fontSize:   20,
    fontWeight: "800",
    color:      "#111827",
    marginTop:  4,
  },
  statLabel: {
    fontSize:   11,
    color:      "#6B7280",
    marginTop:  2,
    textAlign:  "center",
  },

  filterBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   "#E0F2FE",
    paddingHorizontal: 16,
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: "#BAE6FD",
  },
  filterBannerLeft: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
  },
  filterBannerText:      { fontSize: 13, color: "#0891B2", fontWeight: "600" },
  filterBannerClear:     { paddingHorizontal: 10, paddingVertical: 4 },
  filterBannerClearText: { fontSize: 13, color: "#0891B2", fontWeight: "700" },

  filtersScroll:  { maxHeight: 48 },
  filtersContent: {
    paddingHorizontal: 20,
    gap:               8,
    alignItems:        "center",
    paddingVertical:   6,
  },
  filterChip: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      20,
    backgroundColor:   "#FFF",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               4,
  },
  filterChipActive: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  filterText:       { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  filterTextActive: { color: "#FFF" },
  filterBadge: {
    backgroundColor:   "#DC2626",
    borderRadius:      8,
    minWidth:          16,
    height:            16,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 3,
  },
  filterBadgeText: { color: "#FFF", fontSize: 9, fontWeight: "800" },

  listContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },

  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    overflow:        "hidden",
  },
  cardPinned: {
    borderColor:     "#C7D2FE",
    backgroundColor: "#FAFBFF",
    borderTopWidth:  2,
    borderTopColor:  "#4F46E5",
  },
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: "#4F46E5",
  },
  cardTeacher: {
    borderLeftWidth: 3,
    borderLeftColor: "#0891B2",
  },
  cardExpired: { opacity: 0.7 },

  unreadStrip: {
    position:               "absolute",
    left:                   0,
    top:                    0,
    bottom:                 0,
    width:                  3,
    backgroundColor:        "#4F46E5",
    borderTopLeftRadius:    16,
    borderBottomLeftRadius: 16,
  },

  cardTopRow: {
    flexDirection: "row",
    alignItems:    "center",
    marginBottom:  8,
    gap:           6,
    flexWrap:      "wrap",
  },
  authorRoleBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
  },
  authorRoleText: { fontSize: 11, fontWeight: "700" },
  pinBadge: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           3,
  },
  pinText:    { fontSize: 10, color: "#4F46E5", fontWeight: "700" },
  expiredBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   "#F3F4F6",
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      6,
  },
  expiredBadgeText: { fontSize: 10, color: "#6B7280", fontWeight: "600" },

  cardActions: {
    flexDirection: "row",
    gap:           6,
  },
  actionBtn: {
    width:           28,
    height:          28,
    borderRadius:    8,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },

  cardTitle: {
    fontSize:     15,
    fontWeight:   "600",
    color:        "#374151",
    marginBottom: 6,
  },
  cardTitleUnread: { fontWeight: "700", color: "#111827" },

  cardBody: {
    fontSize:     13,
    color:        "#6B7280",
    lineHeight:   18,
    marginBottom: 10,
  },

  cardMeta: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           6,
    marginBottom:  10,
  },
  badge: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      12,
    borderWidth:       1,
  },
  badgeText: {
    fontSize:      10,
    fontWeight:    "700",
    textTransform: "capitalize",
  },
  syncBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 6,
    paddingVertical:   3,
    borderRadius:      12,
    backgroundColor:   "#FFFBEB",
    borderWidth:       1,
    borderColor:       "#FDE68A",
  },
  syncBadgeText: { fontSize: 10, color: "#F59E0B", fontWeight: "600" },

  cardFooter: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
  },
  authorRow:  { flexDirection: "row", alignItems: "center", gap: 4 },
  authorText: { fontSize: 11, color: "#9CA3AF", fontWeight: "500" },
  dateText:   { fontSize: 11, color: "#9CA3AF" },

  emptyState: {
    alignItems:      "center",
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      "#374151",
    marginTop:  12,
    textAlign:  "center",
  },
  emptySubtitle: {
    fontSize:   13,
    color:      "#9CA3AF",
    marginTop:  4,
    textAlign:  "center",
    lineHeight: 20,
  },
  clearFilterBtn: {
    marginTop:         16,
    paddingHorizontal: 20,
    paddingVertical:   8,
    backgroundColor:   "#EEF2FF",
    borderRadius:      10,
  },
  clearFilterText: { color: "#4F46E5", fontWeight: "600", fontSize: 13 },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";