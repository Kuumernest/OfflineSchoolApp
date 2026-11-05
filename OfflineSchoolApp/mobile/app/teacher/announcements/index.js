// app/teacher/announcements/index.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
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
  Animated,
  Alert,
} from "react-native";
import { useRouter }            from "expo-router";
import { Ionicons }             from "@expo/vector-icons";
import { useAuthStore }         from "../../../src/store/auth.store";
import { useAnnouncementStore } from "../../../src/store/announcement.store";
import { COLORS, ACCENT, accentBadge, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { key: "inbox", labelKey: "annTeacher.tabInbox", icon: "mail-outline" },
  { key: "sent",  labelKey: "annTeacher.tabSent",  icon: "send-outline" },
];

const PRIORITY_CONFIG = {
  urgent: { accent: "red",   color: ACCENT.red.deep,   bg: ACCENT.red.wash,   labelKey: "annTeacher.prioUrgent" },
  high:   { accent: "amber", color: ACCENT.amber.deep, bg: ACCENT.amber.wash, labelKey: "annTeacher.prioHigh"   },
  normal: { accent: "sky",   color: ACCENT.sky.deep,   bg: ACCENT.sky.wash,   labelKey: "annTeacher.prioNormal" },
  medium: { accent: "sky",   color: ACCENT.sky.deep,   bg: ACCENT.sky.wash,   labelKey: "annTeacher.prioNormal" },
  low:    { accent: "slate", color: ACCENT.slate.deep, bg: ACCENT.slate.wash, labelKey: "annTeacher.prioLow"    },
};

const AUDIENCE_CONFIG = {
  all:      { labelKey: "annTeacher.audAll",      accent: "sky",    color: ACCENT.sky.deep,    bg: ACCENT.sky.wash    },
  teachers: { labelKey: "annTeacher.audTeachers", accent: "violet", color: ACCENT.violet.deep, bg: ACCENT.violet.wash },
  students: { labelKey: "annTeacher.audStudents", accent: "blue",   color: ACCENT.blue.deep,   bg: ACCENT.blue.wash   },
  class:    { labelKey: "annTeacher.audClass",    accent: "indigo", color: ACCENT.indigo.deep, bg: ACCENT.indigo.wash },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatRelative = (dateStr, t) => {
  if (!dateStr) return "";
  const date   = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const m      = Math.floor(diffMs / 60000);
  const h      = Math.floor(diffMs / 3600000);
  const d      = Math.floor(diffMs / 86400000);

  if (m  <  1) return t("annTeacher.justNow");
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  if (d  <  7) return `${d}d ago`;

  return date.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
};

const checkExpired = (expiresAt) =>
  expiresAt ? new Date(expiresAt) < new Date() : false;

// ─── Empty state ──────────────────────────────────────────────────────────────

const EmptyState = ({ tab, onCompose }) => {
                     const { t } = useTranslation();
                     return (
  <View style={styles.emptyWrap}>
    <IconSquare
      icon={tab === "inbox" ? "mail-open-outline" : "send-outline"}
      accent="sky"
      size={56}
      radius={16}
      style={styles.emptyIconCircle}
    />
    <Text style={styles.emptyTitle}>
      {tab === "inbox" ? t("annTeacher.emptyInboxTitle") : t("annTeacher.emptySentTitle")}
    </Text>
    <Text style={styles.emptySub}>
      {tab === "inbox"
        ? t("annTeacher.emptyInboxSub")
        : t("annTeacher.emptySentSub")}
    </Text>
    {tab === "sent" && (
      <TouchableOpacity style={styles.emptyAction} onPress={onCompose}>
        <Ionicons name="add" size={18} color="#FFF" />
        <Text style={styles.emptyActionText}>{t("annTeacher.createAnnouncement")}</Text>
      </TouchableOpacity>
    )}
  </View>
);
                   };

// ─── Announcement card ────────────────────────────────────────────────────────

const AnnouncementCard = React.memo(({ item, tab, onPress, onLongPress }) => {
  const { t } = useTranslation();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const priority = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG.normal;
  const audience = AUDIENCE_CONFIG[item.audience] || AUDIENCE_CONFIG.all;
  const expired  = checkExpired(item.expiresAt);
  const isUnread = tab === "inbox" && !item.isRead;
  const isPinned = item.isPinned;

  const handlePressIn  = () =>
    Animated.spring(scaleAnim, { toValue: 0.975, useNativeDriver: true }).start();
  const handlePressOut = () =>
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true }).start();

  const senderLabel =
    tab === "inbox"
      ? item.authorName || t("annTeacher.adminFallback")
      : `To: ${
          item.targetClasses?.length
            ? item.targetClasses.map((c) => c?.name || c).join(", ")
            : item.audience === "all"
            ? t("annTeacher.wholeSchool")
            : t(audience.labelKey)
        }`;

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[
          styles.card,
          isUnread && styles.cardUnread,
          isPinned && styles.cardPinned,
          expired  && styles.cardExpired,
        ]}
        onPress={() => onPress(item)}
        onLongPress={() => onLongPress(item)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={1}
      >
        {isUnread && <View style={styles.unreadStrip} />}

        {isPinned && (
          <View style={styles.pinnedBadge}>
            <Ionicons name="pin" size={11} color={ACCENT.violet.deep} />
            <Text style={styles.pinnedText}>{t("annTeacher.pinned")}</Text>
          </View>
        )}

        {/* Top row */}
        <View style={styles.cardHeader}>
          <View style={[styles.roleAvatar, { backgroundColor: ACCENT[priority.accent].solid }]}>
            <Ionicons
              name={
                item.authorRole === "super_admin" ||
                item.authorRole === "school_admin"
                  ? "shield-half-outline"
                  : item.authorRole === "teacher"
                  ? "person-outline"
                  : "business-outline"
              }
              size={15}
              color={COLORS.onPrimary}
            />
          </View>

          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text
                style={[styles.cardTitle, isUnread && styles.cardTitleBold]}
                numberOfLines={1}
              >
                {item.title}
              </Text>
              {isUnread && <View style={styles.unreadDot} />}
            </View>
            <Text style={styles.senderText} numberOfLines={1}>
              {senderLabel}
            </Text>
          </View>

          <Text style={styles.dateText}>{formatRelative(item.createdAt, t)}</Text>
        </View>

        {/* Body preview */}
        <Text style={styles.bodyPreview} numberOfLines={2}>
          {item.body}
        </Text>

        {/* Tags row */}
        <View style={styles.tagsRow}>
          <View style={[styles.tag, { backgroundColor: COLORS.surface, borderColor: accentBadge(priority.accent).border }]}>
            <View style={[styles.tagDot, { backgroundColor: ACCENT[priority.accent].base }]} />
            <Text style={[styles.tagText, { color: priority.color }]}>
              {t(priority.labelKey)}
            </Text>
          </View>

          <View style={[styles.tag, { backgroundColor: COLORS.surface, borderColor: accentBadge(audience.accent).border }]}>
            <Text style={[styles.tagText, { color: audience.color }]}>
              {t(audience.labelKey)}
            </Text>
          </View>

          {expired && (
            <View style={[styles.tag, { backgroundColor: statusBadge("error").bg, borderColor: statusBadge("error").border }]}>
              <Text style={[styles.tagText, { color: statusBadge("error").text }]}>{t("annTeacher.expired")}</Text>
            </View>
          )}

          {tab === "inbox" && item.isAcknowledged && (
            <View style={[styles.tag, { backgroundColor: statusBadge("success").bg, borderColor: statusBadge("success").border }]}>
              <Ionicons name="checkmark-done" size={11} color={statusBadge("success").text} />
              <Text style={[styles.tagText, { color: statusBadge("success").text }]}>
                {t("annTeacher.acknowledged")}
              </Text>
            </View>
          )}

          {tab === "sent" && item.targetClasses?.length > 0 && (
            <View style={styles.classCountChip}>
              <Ionicons name="school-outline" size={11} color={ACCENT.indigo.solid} />
              <Text style={styles.classCountText}>
                {t("annTeacher.classCount", { count: item.targetClasses.length })}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function AnnouncementsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const user   = useAuthStore((s) => s.user);

  // ✅ Subscribe to reactive state fields directly — Zustand re-renders
  //    this component whenever any of these values change
  const inbox        = useAnnouncementStore((s) => s.inbox);
  const sent         = useAnnouncementStore((s) => s.sent);
  const stats        = useAnnouncementStore((s) => s.stats);
  const loadingInbox = useAnnouncementStore((s) => s.loadingInbox);
  const loadingSent  = useAnnouncementStore((s) => s.loadingSent);
  // ✅ unreadCount is reactive state — badge updates instantly
  const unreadCount  = useAnnouncementStore((s) => s.unreadCount);

  const fetchAll    = useAnnouncementStore((s) => s.fetchAll);
  const markRead    = useAnnouncementStore((s) => s.markRead);
  const acknowledge = useAnnouncementStore((s) => s.acknowledge);
  const remove      = useAnnouncementStore((s) => s.remove);

  const [activeTab,  setActiveTab]  = useState("inbox");
  const [refreshing, setRefreshing] = useState(false);

  const tabAnim = useRef(new Animated.Value(0)).current;

  // ── Load data ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchAll(user);
  }, [user, fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll(user);
    setRefreshing(false);
  }, [user, fetchAll]);

  // ── Tab switch ─────────────────────────────────────────────────────────
  const switchTab = useCallback((key) => {
    Animated.spring(tabAnim, {
      toValue:         key === "inbox" ? 0 : 1,
      useNativeDriver: false,
      tension:         300,
      friction:        30,
    }).start();
    setActiveTab(key);
  }, [tabAnim]);

  const tabLeft = tabAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: ["2%", "52%"],
  });

  // ── Card handlers ──────────────────────────────────────────────────────
  // ✅ Always call markRead — store guards against double-calls internally
  const handlePress = useCallback((item) => {
    const id = item.id || item._id;
    markRead(id);
    router.push(`/teacher/announcements/${id}`);
  }, [markRead, router]);

  const handleLongPress = useCallback((item) => {
    const id = item.id || item._id;

    if (activeTab === "sent") {
      Alert.alert(
        t("annTeacher.deleteTitle"),
        `"${item.title}"\n\nThis will remove it for all recipients.`,
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text:    t("common.delete"),
            style:   "destructive",
            onPress: async () => {
              try { await remove(id); }
              catch (err) { Alert.alert(t("annTeacher.errorTitle"), errorText(t, err)); }
            },
          },
        ]
      );
    } else {
      Alert.alert(
        t("annTeacher.ackTitle"),
        t("annTeacher.ackBody"),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("annTeacher.ackTitle"), onPress: () => acknowledge(id) },
        ]
      );
    }
  }, [activeTab, t, remove, acknowledge]);

  // ── Computed ───────────────────────────────────────────────────────────
  const data    = activeTab === "inbox" ? inbox : sent;
  const loading = activeTab === "inbox" ? loadingInbox : loadingSent;

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.surface} />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("annTeacher.listTitle")}</Text>
          {unreadCount > 0 && (
            <Text style={styles.headerSub}>{unreadCount} unread</Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.composeBtn}
          onPress={() => router.push("/teacher/announcements/create")}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={20} color="#FFF" />
          <Text style={styles.composeBtnText}>{t("annTeacher.new")}</Text>
        </TouchableOpacity>
      </View>

      {/* ── STATS BAR ── */}
      {(stats.unread > 0 || stats.urgentUnack > 0) && (
        <View style={styles.statsBar}>
          {stats.unread > 0 && (
            <View style={styles.statChip}>
              <Ionicons name="mail-unread-outline" size={13} color={ACCENT.sky.solid} />
              <Text style={styles.statChipText}>{stats.unread} unread</Text>
            </View>
          )}
          {stats.urgentUnack > 0 && (
            <View style={[styles.statChip, { backgroundColor: ACCENT.red.wash }]}>
              <Ionicons name="warning-outline" size={13} color={ACCENT.red.solid} />
              <Text style={[styles.statChipText, { color: ACCENT.red.deep }]}>
                {stats.urgentUnack} urgent
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── TAB BAR ── */}
      <View style={styles.tabBar}>
        <Animated.View style={[styles.tabIndicator, { left: tabLeft }]} />
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.tabBtn}
              onPress={() => switchTab(tab.key)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={tab.icon}
                size={15}
                color={active ? ACCENT.sky.solid : COLORS.textSecondary}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {t(tab.labelKey)}
              </Text>
              {tab.key === "inbox" && unreadCount > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── LIST ── */}
      {loading && data.length === 0 ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color="#4F46E5" />
          <Text style={styles.loaderText}>{t("annTeacher.loading")}</Text>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => String(item.id || item._id)}
          renderItem={({ item }) => (
            <AnnouncementCard
              item={item}
              tab={activeTab}
              onPress={handlePress}
              onLongPress={handleLongPress}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              tab={activeTab}
              onCompose={() => router.push("/teacher/announcements/create")}
            />
          }
          contentContainerStyle={[
            styles.listContent,
            data.length === 0 && styles.listContentEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#4F46E5"
              colors={["#4F46E5"]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* ── FAB ── */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push("/teacher/announcements/create")}
        activeOpacity={0.85}
      >
        <Ionicons name="megaphone-outline" size={22} color="#FFF" />
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.page },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               12,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:   { marginRight: 0 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  composeBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderRadius:      10,
  },
  composeBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

  statsBar: {
    flexDirection:     "row",
    gap:               8,
    paddingHorizontal: 16,
    paddingVertical:   8,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  statChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    backgroundColor:   ACCENT.sky.wash,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      20,
  },
  statChipText: { fontSize: 12, fontWeight: "600", color: ACCENT.sky.deep },

  tabBar: {
    flexDirection:     "row",
    backgroundColor:   "#FFF",
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    position:          "relative",
  },
  tabIndicator: {
    position:        "absolute",
    top:             6,
    width:           "46%",
    height:          38,
    backgroundColor: ACCENT.sky.wash,
    borderRadius:    10,
  },
  tabBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 9,
    gap:             6,
    zIndex:          1,
  },
  tabLabel:       { fontSize: 14, fontWeight: "600", color: COLORS.textSecondary },
  tabLabelActive: { color: ACCENT.sky.deep },
  tabBadge: {
    backgroundColor:   ACCENT.red.solid,
    borderRadius:      8,
    paddingHorizontal: 5,
    paddingVertical:   1,
    minWidth:          18,
    alignItems:        "center",
  },
  tabBadgeText: { color: "#FFF", fontSize: 10, fontWeight: "700" },

  listContent:      { padding: 12, paddingBottom: 100 },
  listContentEmpty: { flexGrow: 1 },

  card: {
    backgroundColor: ACCENT.sky.wash,
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    overflow:        "hidden",
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.sky.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    4,
    elevation:       2,
  },
  cardUnread: {
    borderWidth:     1.5,
    borderColor:     ACCENT.sky.base + "4D",
    borderTopWidth:  3,
    borderTopColor:  ACCENT.sky.base,
  },
  cardPinned:  { borderTopWidth: 3, borderTopColor: ACCENT.violet.base },
  cardExpired: { opacity: 0.6 },
  unreadStrip: {
    position:               "absolute",
    left:                   0,
    top:                    0,
    bottom:                 0,
    width:                  3,
    backgroundColor:        ACCENT.sky.solid,
    borderTopLeftRadius:    14,
    borderBottomLeftRadius: 14,
  },
  pinnedBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    alignSelf:         "flex-start",
    backgroundColor:   ACCENT.violet.wash,
    borderWidth:       1,
    borderColor:       accentBadge("violet").border,
    paddingHorizontal: 7,
    paddingVertical:   2,
    borderRadius:      6,
    marginBottom:      8,
  },
  pinnedText: { fontSize: 10, fontWeight: "700", color: ACCENT.violet.deep },

  cardHeader: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           10,
    marginBottom:  8,
  },
  roleAvatar: {
    width:          32,
    height:         32,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    flex:          1,
  },
  cardTitle:     { flex: 1, fontSize: 14, fontWeight: "500", color: COLORS.text },
  cardTitleBold: { fontWeight: "700", color: COLORS.text },
  unreadDot: {
    width:           7,
    height:          7,
    borderRadius:    4,
    backgroundColor: ACCENT.sky.solid,
  },
  senderText: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  dateText:   { fontSize: 11, color: COLORS.textSecondary, paddingTop: 2 },

  bodyPreview: {
    fontSize:     13,
    color:        COLORS.textSecondary,
    lineHeight:   19,
    marginBottom: 10,
  },

  tagsRow: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           6,
    alignItems:    "center",
  },
  tag: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
    borderWidth:       1,
  },
  tagDot:  { width: 5, height: 5, borderRadius: 3 },
  tagText: { fontSize: 11, fontWeight: "600" },
  classCountChip: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           3,
    marginLeft:    "auto",
  },
  classCountText: { fontSize: 11, color: COLORS.textSecondary },

  emptyWrap: {
    flex:              1,
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   60,
    paddingHorizontal: 32,
  },
  emptyIconCircle: {
    marginBottom:    16,
  },
  emptyTitle:  { fontSize: 17, fontWeight: "700", color: COLORS.text, textAlign: "center" },
  emptySub: {
    fontSize:     13,
    color:        COLORS.textSecondary,
    textAlign:    "center",
    lineHeight:   20,
    marginTop:    8,
    marginBottom: 20,
  },
  emptyAction: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 20,
    paddingVertical:   11,
    borderRadius:      12,
  },
  emptyActionText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  loaderWrap: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    gap:            12,
  },
  loaderText: { fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },

  fab: {
    position:        "absolute",
    bottom:          28,
    right:           20,
    width:           56,
    height:          56,
    borderRadius:    28,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
    shadowColor:     "#4F46E5",
    shadowOpacity:   0.4,
    shadowRadius:    8,
    shadowOffset:    { width: 0, height: 4 },
    elevation:       6,
  },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";