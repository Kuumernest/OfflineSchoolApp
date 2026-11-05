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

// A priority's pill takes its status tone; its card's megaphone square takes
// the matching accent (urgent red, high amber, normal sky, low slate).
const PRIORITY_COLORS = {
  low:       statusBadge("info"),
  normal:    statusBadge("info"),
  important: statusBadge("warning"),
  high:      statusBadge("warning"),
  urgent:    statusBadge("error"),
};
const PRIORITY_ACCENT = {
  low: "slate", normal: "sky", important: "amber", high: "amber", urgent: "red",
};

// An audience that is a role takes that role's colour; anything else is sky.
const AUDIENCE_LABELS = {
  all:      { labelKey: "annAdmin.audAll",  icon: "globe-outline",  accent: "sky" },
  teachers: { labelKey: "annAdmin.audTeachersShort",  icon: "people-outline", accent: roleAccent("teacher") },
  students: { labelKey: "annAdmin.audStudentsShort",  icon: "school-outline", accent: roleAccent("student") },
  class:    { labelKey: "annAdmin.audClassShort",     icon: "layers-outline", accent: "sky" },
};

const roleBadge = (role) => {
  const c = accentBadge(roleAccent(role));
  return { color: c.text, bg: c.bg, border: c.border };
};
const AUTHOR_ROLE_COLORS = {
  super_admin:  { labelKey: "annAdmin.roleSuperAdmin",   ...roleBadge("super_admin") },
  school_admin: { labelKey: "annAdmin.roleSchoolAdmin",  ...roleBadge("school_admin") },
  admin:        { labelKey: "annAdmin.roleAdmin",         ...roleBadge("admin") },
  teacher:      { labelKey: "annAdmin.roleTeacher",       ...roleBadge("teacher") },
};

const CLASS_BADGE   = accentBadge("indigo");
const EXPIRED_BADGE = statusBadge("error");
const OFFLINE_BADGE = statusBadge("warning");
const TEACHER       = ACCENT[roleAccent("teacher")];

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

// Plain announcement cards, except unread (info) and urgent (error) when any.
function StatCard({ icon, label, value, tone }) {
  return (
    <StatTile kind="announcements" tone={tone} icon={icon} value={value ?? 0} label={label}
      style={styles.statCard} />
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
        <ActivityIndicator size="large" color={ACCENT.sky.solid} />
        <Text style={styles.loadingText}>{t("annAdmin.loadingAnnouncements")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
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
          <Ionicons name="add" size={22} color={COLORS.onPrimary} />
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
            tone={(stats.unread ?? 0) > 0 ? "info" : undefined}
          />
          <StatCard
            icon="warning-outline"
            label={t("annAdmin.filterUrgent")}
            value={stats.urgentUnack}
            tone={(stats.urgentUnack ?? 0) > 0 ? "error" : undefined}
          />
          <StatCard
            icon="pin-outline"
            label={t("annAdmin.pinned")}
            value={stats.pinned}
          />
          <TouchableOpacity
            onPress={() => setActiveFilter("from_teachers")}
            activeOpacity={0.8}
          >
            <StatCard
              icon="people-outline"
              label={t("annAdmin.filterFromTeachers")}
              value={stats.fromTeachers}
            />
          </TouchableOpacity>
          <StatCard
            icon="list-outline"
            label={t("common.total")}
            value={stats.total}
          />
        </ScrollView>
      )}

      {activeFilter === "from_teachers" && (
        <View style={styles.filterBanner}>
          <View style={styles.filterBannerLeft}>
            <Ionicons name="people" size={18} color={TEACHER.solid} />
            <Text style={styles.filterBannerText}>
              {t("annAdmin.showingTeacherCount", { count: announcements.length })}
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
              color={activeFilter === f.key ? ACCENT.sky.deep : COLORS.textSecondary}
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
            tintColor={ACCENT.sky.solid}
            colors={[ACCENT.sky.solid]}
          />
        }
      >
        {announcements.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSquare
              icon={
                activeFilter === "from_teachers"
                  ? "people-outline"
                  : "megaphone-outline"
              }
              accent={activeFilter === "from_teachers" ? roleAccent("teacher") : "sky"}
              size={56}
              radius={16}
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
                  <IconSquare
                    icon="megaphone"
                    accent={PRIORITY_ACCENT[item.priority] || "sky"}
                    size={28}
                  />
                  {role && (
                    <View style={[
                      styles.authorRoleBadge,
                      { backgroundColor: role.bg, borderColor: role.border },
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
                      <Ionicons name="pin" size={10} color={ACCENT.sky.deep} />
                      <Text style={styles.pinText}>{t("annAdmin.pinned")}</Text>
                    </View>
                  )}

                  {expired && (
                    <View style={styles.expiredBadge}>
                      <Ionicons name="time-outline" size={10} color={EXPIRED_BADGE.text} />
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
                        color={item.isPinned ? ACCENT.sky.solid : COLORS.textSecondary}
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
                        color={COLORS.danger}
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
                      backgroundColor: accentBadge(aud.accent).bg,
                      borderColor:     accentBadge(aud.accent).border,
                    },
                  ]}>
                    <Ionicons name={aud.icon} size={10} color={accentBadge(aud.accent).text} />
                    <Text style={[
                      styles.badgeText,
                      { color: accentBadge(aud.accent).text, marginLeft: 3 },
                    ]}>
                      {t(aud.labelKey)}
                    </Text>
                  </View>

                  {item.targetClasses?.length > 0 && (
                    <View style={[
                      styles.badge,
                      { backgroundColor: CLASS_BADGE.bg, borderColor: CLASS_BADGE.border },
                    ]}>
                      <Ionicons name="school-outline" size={10} color={CLASS_BADGE.text} />
                      <Text style={[
                        styles.badgeText,
                        { color: CLASS_BADGE.text, marginLeft: 3 },
                      ]}>
                        {t("annAdmin.classCount", { count: item.targetClasses.length })}
                      </Text>
                    </View>
                  )}

                  {!item._synced && (
                    <View style={styles.syncBadge}>
                      <Ionicons
                        name="cloud-offline-outline"
                        size={10}
                        color={OFFLINE_BADGE.text}
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
                      color={fromTeacher ? TEACHER.solid : COLORS.textSecondary}
                    />
                    <Text style={[
                      styles.authorText,
                      fromTeacher && { color: TEACHER.deep, fontWeight: "600" },
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
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: COLORS.page,
  },
  loadingText: {
    marginTop:  12,
    fontSize:   14,
    color:      COLORS.textSecondary,
    fontWeight: "500",
  },

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
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:   { marginLeft: 12 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  createBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.sky.solid,
    alignItems:      "center",
    justifyContent:  "center",
  },

  /*
   * No fixed height on either of these scrollers.
   *
   * statsScroll was maxHeight: 90, and the card inside it does not fit in 90.
   * Count it: an 18px icon, a 20pt value with 4 above it, an 11pt label with 2
   * above it, 12px of card padding top and bottom, and a 1px border each side
   * — about 88. Then statsContent adds paddingVertical: 12 top and bottom
   * INSIDE that cap, so the card had roughly 66px to live in. The icon showed,
   * the number was clipped and the label was cut in half, which is exactly
   * what the screen looked like.
   *
   * A fixed height on a horizontal scroller whose children hold translated
   * text is the wrong shape regardless of the number. statLabel is width 100
   * with textAlign centre, so a longer translation wraps to two lines and adds
   * another 14px — a cap tuned to fit English clips French, and nothing in the
   * layout says why.
   *
   * Without it, both scrollers size to their tallest child, which is what they
   * wanted all along.
   */
  statsScroll:  {},
  statsContent: {
    paddingHorizontal: 20,
    paddingVertical:   12,
    gap:               10,
  },
  // Fixed width in a horizontal scroller, so the tile's flex: 1 is cancelled.
  statCard: { flex: 0, width: 100 },

  filterBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   TEACHER.wash,
    paddingHorizontal: 16,
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: accentBadge(roleAccent("teacher")).border,
  },
  filterBannerLeft: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
  },
  filterBannerText:      { fontSize: 13, color: TEACHER.deep, fontWeight: "600" },
  filterBannerClear:     { paddingHorizontal: 10, paddingVertical: 4 },
  filterBannerClearText: { fontSize: 13, color: TEACHER.deep, fontWeight: "700" },

  filtersScroll:  {},   // see statsScroll
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
    backgroundColor:   COLORS.surface,
    borderWidth:       1,
    borderColor:       COLORS.border,
    gap:               4,
  },
  filterChipActive: { backgroundColor: ACCENT.sky.wash, borderColor: ACCENT.sky.base },
  filterText:       { fontSize: 12, fontWeight: "600", color: COLORS.textSecondary },
  filterTextActive: { color: ACCENT.sky.deep },
  filterBadge: {
    backgroundColor:   TEACHER.solid,
    borderRadius:      8,
    minWidth:          16,
    height:            16,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 3,
  },
  filterBadgeText: { color: COLORS.onPrimary, fontSize: 9, fontWeight: "800" },

  listContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },

  card: {
    backgroundColor: ACCENT.sky.wash,
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.sky.base,
    overflow:        "hidden",
  },
  cardPinned: {
    borderColor:     ACCENT.sky.base,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.sky.base,
  },
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.sky.solid,
  },
  cardTeacher: {
    borderLeftWidth: 3,
    borderLeftColor: TEACHER.base,
  },
  cardExpired: { opacity: 0.7 },

  unreadStrip: {
    position:               "absolute",
    left:                   0,
    top:                    0,
    bottom:                 0,
    width:                  3,
    backgroundColor:        ACCENT.sky.solid,
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
    borderWidth:       1,
  },
  authorRoleText: { fontSize: 11, fontWeight: "700" },
  pinBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      6,
    borderWidth:       1,
    backgroundColor:   accentBadge("sky").bg,
    borderColor:       accentBadge("sky").border,
  },
  pinText:    { fontSize: 10, color: ACCENT.sky.deep, fontWeight: "700" },
  expiredBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   EXPIRED_BADGE.bg,
    borderWidth:       1,
    borderColor:       EXPIRED_BADGE.border,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      6,
  },
  expiredBadgeText: { fontSize: 10, color: EXPIRED_BADGE.text, fontWeight: "600" },

  cardActions: {
    flexDirection: "row",
    gap:           6,
  },
  actionBtn: {
    width:           28,
    height:          28,
    borderRadius:    8,
    backgroundColor: COLORS.surface,
    alignItems:      "center",
    justifyContent:  "center",
  },

  cardTitle: {
    fontSize:     15,
    fontWeight:   "600",
    color:        COLORS.textSecondary,
    marginBottom: 6,
  },
  cardTitleUnread: { fontWeight: "700", color: COLORS.text },

  cardBody: {
    fontSize:     13,
    color:        COLORS.textSecondary,
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
    backgroundColor:   OFFLINE_BADGE.bg,
    borderWidth:       1,
    borderColor:       OFFLINE_BADGE.border,
  },
  syncBadgeText: { fontSize: 10, color: OFFLINE_BADGE.text, fontWeight: "600" },

  cardFooter: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
  },
  authorRow:  { flexDirection: "row", alignItems: "center", gap: 4 },
  authorText: { fontSize: 11, color: COLORS.textSecondary, fontWeight: "500" },
  dateText:   { fontSize: 11, color: COLORS.textSecondary },

  emptyState: {
    alignItems:      "center",
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      COLORS.text,
    marginTop:  12,
    textAlign:  "center",
  },
  emptySubtitle: {
    fontSize:   13,
    color:      COLORS.textSecondary,
    marginTop:  4,
    textAlign:  "center",
    lineHeight: 20,
  },
  clearFilterBtn: {
    marginTop:         16,
    paddingHorizontal: 20,
    paddingVertical:   8,
    backgroundColor:   ACCENT.sky.wash,
    borderRadius:      10,
  },
  clearFilterText: { color: ACCENT.sky.deep, fontWeight: "600", fontSize: 13 },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { StatTile } from "../../../src/components/Tiles";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";
import {
  COLORS, ACCENT, roleAccent, accentBadge, statusBadge,
} from "../../../src/theme/colors";
import { errorText } from "../../../src/utils/appError";