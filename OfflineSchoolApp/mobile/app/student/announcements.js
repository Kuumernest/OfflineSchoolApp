"use strict";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons }  from "@expo/vector-icons";
import { useAuthStore }         from "../../src/store/auth.store";
import { useAnnouncementStore } from "../../src/store/announcement.store";

// ─────────────────────────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FFFBEB",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
  info:      "#2563EB",
  infoBg:    "#DBEAFE",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const timeAgo = (dateStr, t) => {
  if (!dateStr) return "";
  try {
    const now  = new Date();
    const date = new Date(dateStr);
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60)     return t("annStudent.justNow");
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return date.toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return ""; }
};

const formatFullDate = (dateStr) => {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      weekday: "long",
      day:     "2-digit",
      month:   "long",
      year:    "numeric",
      hour:    "2-digit",
      minute:  "2-digit",
    });
  } catch { return dateStr; }
};

const getPriorityConfig = (priority = "normal") => {
  const p = (priority || "normal").toLowerCase();
  switch (p) {
    case "urgent":
      return { labelKey: "annStudent.prioUrgent", icon: "alert-circle",       color: C.error,   bg: C.errorBg,   border: "#FECACA" };
    case "high":
      return { labelKey: "annStudent.prioHigh",   icon: "arrow-up-circle",    color: C.warning, bg: C.warningBg, border: "#FDE68A" };
    case "low":
      return { label: "Low",    icon: "remove-circle",      color: C.gray500, bg: C.gray100,   border: C.gray200 };
    default:
      return { labelKey: "annStudent.prioNormal", icon: "information-circle", color: C.info,    bg: C.infoBg,    border: "#BFDBFE" };
  }
};

const getAuthorConfig = (authorRole = "") => {
  const r = (authorRole || "").toLowerCase();
  if (["super_admin", "school_admin", "admin"].includes(r)) {
    return { icon: "shield-checkmark", color: C.primary, labelKey: "annStudent.roleAdministrator" };
  }
  if (r === "teacher") {
    return { icon: "school", color: C.success, labelKey: "annStudent.roleTeacher" };
  }
  return { icon: "person", color: C.gray500, labelKey: "annStudent.roleStaff" };
};

// ─────────────────────────────────────────────────────────────────────────────
// FILTER TABS
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { key: "all",     labelKey: "annStudent.tabAll"     },
  { key: "unread",  labelKey: "annStudent.tabUnread"  },
  { key: "pinned",  labelKey: "annStudent.pinned"  },
  { key: "urgent",  labelKey: "annStudent.prioUrgent"  },
  { key: "admin",   labelKey: "annStudent.tabAdmin"   },
  { key: "teacher", labelKey: "annStudent.roleTeacher" },
];

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL MODAL
// ─────────────────────────────────────────────────────────────────────────────

function DetailModal({ ann, visible, onClose, onAcknowledge }) {
  const { t } = useTranslation();
  if (!visible || !ann) return null;

  const pri    = getPriorityConfig(ann.priority);
  const author = getAuthorConfig(ann.authorRole || ann.author_role);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      hardwareAccelerated
    >
      <View style={md.overlay}>
        <TouchableOpacity
          style={md.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />

        <View style={md.sheet}>
          <View style={md.header}>
            <TouchableOpacity
              onPress={onClose}
              style={md.closeBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={22} color={C.gray700} />
            </TouchableOpacity>
            <Text style={md.headerTitle}>{t("annStudent.announcement")}</Text>
            <View style={{ width: 36 }} />
          </View>

          <ScrollView
            contentContainerStyle={md.content}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            <View style={md.badgeRow}>
              <View style={[md.badge, { backgroundColor: pri.bg, borderColor: pri.border }]}>
                <Ionicons name={pri.icon} size={13} color={pri.color} />
                <Text style={[md.badgeText, { color: pri.color }]}>{t(pri.labelKey)}</Text>
              </View>
              {ann.isPinned && (
                <View style={[md.badge, { backgroundColor: C.warningBg, borderColor: "#FDE68A" }]}>
                  <Ionicons name="pin" size={13} color={C.warning} />
                  <Text style={[md.badgeText, { color: C.warning }]}>{t("annStudent.pinned")}</Text>
                </View>
              )}
              {ann.isRead && (
                <View style={[md.badge, { backgroundColor: C.successBg, borderColor: "#A7F3D0" }]}>
                  <Ionicons name="checkmark-circle" size={13} color={C.success} />
                  <Text style={[md.badgeText, { color: C.success }]}>{t("annStudent.read")}</Text>
                </View>
              )}
            </View>

            <Text style={md.title}>{ann.title}</Text>

            <View style={md.metaRow}>
              <View style={[md.authorIcon, { backgroundColor: author.color + "18" }]}>
                <Ionicons name={author.icon} size={16} color={author.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={md.authorName}>{ann.authorName || t("annStudent.schoolFallback")}</Text>
                <Text style={md.authorRoleText}>{t(author.labelKey)}</Text>
              </View>
              <View style={md.dateBox}>
                <Ionicons name="time-outline" size={13} color={C.gray400} />
                <Text style={md.dateText}>{timeAgo(ann.createdAt, t)}</Text>
              </View>
            </View>

            <Text style={md.fullDate}>{formatFullDate(ann.createdAt)}</Text>
            <View style={md.divider} />
            <Text style={md.body}>{ann.body || t("annStudent.noContent")}</Text>

            <View style={md.audienceRow}>
              <Ionicons name="people-outline" size={15} color={C.gray400} />
              <Text style={md.audienceText}>
                {ann.audience === "all"
                  ? t("annStudent.audEveryone")
                  : ann.audience === "students"
                  ? t("annStudent.audAllStudents")
                  : ann.audience === "class"
                  ? t("annStudent.audYourClass")
                  : ann.audience || t("annStudent.audEveryone")}
              </Text>
            </View>

            {(ann.priority === "urgent" || ann.priority === "high") &&
              !ann.isAcknowledged && (
                <TouchableOpacity
                  style={md.ackBtn}
                  onPress={() => onAcknowledge(ann.id || ann._id)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="checkmark-done-circle" size={18} color={C.white} />
                  <Text style={md.ackBtnText}>{t("annStudent.ack")}</Text>
                </TouchableOpacity>
              )}

            {ann.isAcknowledged && (
              <View style={md.ackDone}>
                <Ionicons name="checkmark-done-circle" size={16} color={C.success} />
                <Text style={md.ackDoneText}>
                  {t("annStudent.ackedNote")}
                </Text>
              </View>
            )}

            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const md = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent:  "flex-end",
  },
  backdrop: { flex: 1 },
  sheet: {
    backgroundColor:      C.white,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    maxHeight:            "88%",
    paddingBottom:        34,
  },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  headerTitle: { fontSize: 16, fontWeight: "700", color: C.gray900 },
  closeBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  content:  { paddingHorizontal: 20, paddingTop: 16 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  badge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderRadius:      8,
    borderWidth:       1,
  },
  badgeText: { fontSize: 12, fontWeight: "700" },
  title: {
    fontSize:     20,
    fontWeight:   "800",
    color:        C.gray900,
    lineHeight:   28,
    marginBottom: 16,
  },
  metaRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
    marginBottom:  4,
  },
  authorIcon: {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  authorName:     { fontSize: 14, fontWeight: "600", color: C.gray900 },
  authorRoleText: { fontSize: 11, color: C.gray400, marginTop: 1 },
  dateBox:        { flexDirection: "row", alignItems: "center", gap: 4 },
  dateText:       { fontSize: 12, color: C.gray400, fontWeight: "500" },
  fullDate:       { fontSize: 12, color: C.gray400, marginBottom: 16, marginLeft: 46 },
  divider:        { height: 1, backgroundColor: C.gray100, marginBottom: 16 },
  body:           { fontSize: 15, color: C.gray700, lineHeight: 24, marginBottom: 20 },
  audienceRow: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    backgroundColor: C.gray50,
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
  },
  audienceText: { fontSize: 13, color: C.gray500, fontWeight: "500" },
  ackBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: C.primary,
    borderRadius:    12,
    paddingVertical: 14,
    marginTop:       8,
  },
  ackBtnText: { fontSize: 15, fontWeight: "700", color: C.white },
  ackDone: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    backgroundColor: C.successBg,
    borderRadius:    12,
    padding:         12,
    marginTop:       8,
  },
  ackDoneText: { fontSize: 13, color: C.success, fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentAnnouncements() {
  const { t } = useTranslation();
  const router = useRouter();

  // ✅ Primitive userId — stable dep, prevents infinite useEffect loop
  const userId = useAuthStore((s) =>
    s.user?._id || s.user?.id || s.user?.userId
  );
  const user = useAuthStore((s) => s.user);

  const inbox        = useAnnouncementStore((s) => s.inbox);
  const stats        = useAnnouncementStore((s) => s.stats);
  const loadingInbox = useAnnouncementStore((s) => s.loadingInbox);
  // ✅ Derive unreadCount directly from inbox — always in sync
  const unreadCount  = useAnnouncementStore((s) =>
    s.inbox.filter((a) => !a.isRead).length
  );
  const fetchInbox  = useAnnouncementStore((s) => s.fetchInbox);
  const fetchStats  = useAnnouncementStore((s) => s.fetchStats);
  const markRead    = useAnnouncementStore((s) => s.markRead);
  const acknowledge = useAnnouncementStore((s) => s.acknowledge);

  const [refreshing,   setRefreshing]   = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [searchQuery,  setSearchQuery]  = useState("");
  const [selectedAnn,  setSelectedAnn]  = useState(null);
  const [showDetail,   setShowDetail]   = useState(false);

  const modalOpenRef     = useRef(false);
  const markReadTimerRef = useRef(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  // ── Load on mount ─────────────────────────────────────────────────────────
  // ✅ userId string dep — only fires when user identity changes
  useEffect(() => {
    if (!userId) return;
    fetchInbox(user);
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ── Pull-to-refresh ───────────────────────────────────────────────────────
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchInbox(user), fetchStats()]);
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchInbox, fetchStats]);

  // ── Open detail ───────────────────────────────────────────────────────────
  // ✅ Snapshot ann into local state BEFORE markRead to prevent race condition
  //    where store mutation causes modal to receive stale/null data
  const openDetail = useCallback((ann) => {
    const snapshot = { ...ann };
    setSelectedAnn(snapshot);
    setShowDetail(true);
    modalOpenRef.current = true;

    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);

    const id = ann.id || ann._id;
    if (id) {
      markReadTimerRef.current = setTimeout(() => {
        if (modalOpenRef.current) markRead(id);
      }, 300);
    }
  }, [markRead]);

  // ── Close detail ──────────────────────────────────────────────────────────
  const closeDetail = useCallback(() => {
    modalOpenRef.current = false;
    setShowDetail(false);
    setTimeout(() => setSelectedAnn(null), 400);
  }, []);

  // ── Acknowledge ───────────────────────────────────────────────────────────
  const handleAcknowledge = useCallback((id) => {
    acknowledge(id);
    setSelectedAnn((prev) =>
      prev && (prev.id || prev._id) === id
        ? { ...prev, isAcknowledged: true, isRead: true }
        : prev
    );
  }, [acknowledge]);

  // ── Tab counts ────────────────────────────────────────────────────────────
  const tabCounts = useMemo(() => ({
    all:     inbox.length,
    unread:  inbox.filter((a) => !a.isRead).length,
    pinned:  inbox.filter((a) => a.isPinned).length,
    urgent:  inbox.filter((a) =>
      a.priority === "urgent" || a.priority === "high"
    ).length,
    admin:   inbox.filter((a) =>
      ["school_admin", "super_admin", "admin"].includes(a.authorRole)
    ).length,
    teacher: inbox.filter((a) => a.authorRole === "teacher").length,
  }), [inbox]);

  // ── Filtered + sorted list ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...inbox];

    switch (activeFilter) {
      case "unread":  list = list.filter((a) => !a.isRead); break;
      case "pinned":  list = list.filter((a) => a.isPinned); break;
      case "urgent":  list = list.filter((a) =>
        a.priority === "urgent" || a.priority === "high"
      ); break;
      case "admin":   list = list.filter((a) =>
        ["school_admin", "super_admin", "admin"].includes(a.authorRole)
      ); break;
      case "teacher": list = list.filter((a) => a.authorRole === "teacher"); break;
      default: break;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((a) =>
        (a.title      || "").toLowerCase().includes(q) ||
        (a.body       || "").toLowerCase().includes(q) ||
        (a.authorName || "").toLowerCase().includes(q)
      );
    }

    return list.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return  1;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }, [inbox, activeFilter, searchQuery]);

  // ── Render item ───────────────────────────────────────────────────────────
  const renderItem = useCallback(({ item: ann }) => {
    const pri      = getPriorityConfig(ann.priority);
    const author   = getAuthorConfig(ann.authorRole);
    const isUnread = !ann.isRead;

    return (
      <TouchableOpacity
        style={[
          s.card,
          isUnread                  && s.cardUnread,
          ann.isPinned              && s.cardPinned,
          ann.priority === "urgent" && s.cardUrgent,
        ]}
        onPress={() => openDetail(ann)}
        activeOpacity={0.7}
      >
        {isUnread && <View style={s.unreadStrip} />}
        {isUnread && <View style={s.unreadDot} />}

        <View style={[s.cardIcon, { backgroundColor: pri.bg }]}>
          <Ionicons name={pri.icon} size={20} color={pri.color} />
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={s.cardBadgeRow}>
            {ann.isPinned && (
              <View style={s.pinBadge}>
                <Ionicons name="pin" size={10} color={C.warning} />
                <Text style={s.pinBadgeText}>{t("annStudent.pinned")}</Text>
              </View>
            )}
            <View style={[s.priBadge, { backgroundColor: pri.bg }]}>
              <Text style={[s.priBadgeText, { color: pri.color }]}>
                {t(pri.labelKey)}
              </Text>
            </View>
            <View style={[s.authorBadge, { backgroundColor: author.color + "12" }]}>
              <Ionicons name={author.icon} size={10} color={author.color} />
              <Text style={[s.authorBadgeText, { color: author.color }]}>
                {t(author.labelKey)}
              </Text>
            </View>
          </View>

          <Text
            style={[s.cardTitle, isUnread && s.cardTitleUnread]}
            numberOfLines={2}
          >
            {ann.title}
          </Text>

          <Text style={s.cardBody} numberOfLines={2}>
            {ann.body}
          </Text>

          <View style={s.cardMeta}>
            <Text style={s.cardAuthor} numberOfLines={1}>
              {ann.authorName || t("annStudent.schoolFallback")}
            </Text>
            <Text style={s.cardDot}>·</Text>
            <Text style={s.cardTime}>{timeAgo(ann.createdAt, t)}</Text>
            {ann.isAcknowledged && (
              <>
                <Text style={s.cardDot}>·</Text>
                <Ionicons name="checkmark-done" size={12} color={C.success} />
              </>
            )}
          </View>
        </View>

        <Ionicons
          name="chevron-forward"
          size={16}
          color={C.gray300}
          style={{ marginTop: 2 }}
        />
      </TouchableOpacity>
    );
  }, [openDetail, t]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      {/* Header */}
      <View style={s.topBar}>
        <TouchableOpacity
          onPress={() => router.replace("/student")}
          style={s.backBtn}
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={22} color={C.gray700} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.topTitle}>{t("annStudent.listTitle")}</Text>
          <Text style={s.topSub}>
            {inbox.length} total
            {unreadCount > 0 ? ` · ${unreadCount} unread` : ""}
          </Text>
        </View>
        {unreadCount > 0 && (
          <View style={s.unreadBadge}>
            <Text style={s.unreadBadgeText}>
              {unreadCount > 99 ? "99+" : unreadCount}
            </Text>
          </View>
        )}
      </View>

      {/* Urgent banner */}
      {stats.urgentUnack > 0 && (
        <View style={s.urgentBanner}>
          <Ionicons name="warning" size={16} color={C.error} />
          <Text style={s.urgentBannerText}>
            {stats.urgentUnack} urgent announcement
            {stats.urgentUnack !== 1 ? "s" : ""} need your attention
          </Text>
        </View>
      )}

      {/* Search */}
      <View style={s.searchWrap}>
        <Ionicons name="search-outline" size={18} color={C.gray400} />
        <TextInput
          style={s.searchInput}
          placeholder={t("annStudent.searchPh")}
          placeholderTextColor={C.gray400}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={C.gray400} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filter tabs */}
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={FILTER_TABS}
        keyExtractor={(tab) => tab.key}
        style={s.filterRow}
        contentContainerStyle={s.filterContent}
        renderItem={({ item: tab }) => {
          const isActive = activeFilter === tab.key;
          const count    = tabCounts[tab.key] || 0;
          return (
            <TouchableOpacity
              style={[s.filterTab, isActive && s.filterTabActive]}
              onPress={() => setActiveFilter(tab.key)}
              activeOpacity={0.7}
            >
              <Text style={[s.filterTabText, isActive && s.filterTabTextActive]}>
                {t(tab.labelKey)}
              </Text>
              {count > 0 && (
                <View style={[s.filterBadge, isActive && s.filterBadgeActive]}>
                  <Text style={[
                    s.filterBadgeText,
                    isActive && s.filterBadgeTextActive,
                  ]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />

      {/* List */}
      {loadingInbox && inbox.length === 0 ? (
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadingText}>{t("annStudent.loading")}</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id || item._id)}
          renderItem={renderItem}
          contentContainerStyle={[
            s.listContent,
            filtered.length === 0 && s.listContentEmpty,
          ]}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={C.primary}
              colors={[C.primary]}
            />
          }
          ListEmptyComponent={
            <View style={s.emptyState}>
              <View style={s.emptyIconWrap}>
                <Ionicons
                  name={searchQuery ? "search-outline" : "megaphone-outline"}
                  size={40}
                  color={C.gray300}
                />
              </View>
              <Text style={s.emptyTitle}>
                {searchQuery
                  ? t("annStudent.noResults")
                  : activeFilter !== "all"
                  ? `No ${activeFilter} announcements`
                  : t("annStudent.emptyNone")}
              </Text>
              <Text style={s.emptySub}>
                {searchQuery
                  ? t("annStudent.emptySearchSub")
                  : t("annStudent.emptySub")}
              </Text>
            </View>
          }
        />
      )}

      {/* Detail modal */}
      <DetailModal
        ann={selectedAnn}
        visible={showDetail}
        onClose={closeDetail}
        onAcknowledge={handleAcknowledge}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    gap:             12,
    paddingVertical: 60,
  },
  loadingText: { fontSize: 14, color: C.gray500, fontWeight: "500" },

  topBar: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   C.white,
    gap:               10,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  topTitle:    { fontSize: 18, fontWeight: "700", color: C.gray900 },
  topSub:      { fontSize: 12, color: C.gray400, marginTop: 1 },
  unreadBadge: {
    minWidth:          26,
    height:            26,
    borderRadius:      13,
    backgroundColor:   C.error,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 6,
  },
  unreadBadgeText: { fontSize: 12, fontWeight: "800", color: C.white },

  urgentBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    backgroundColor:   C.errorBg,
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: "#FECACA",
  },
  urgentBannerText: { fontSize: 13, color: C.error, fontWeight: "600", flex: 1 },

  searchWrap: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    marginHorizontal:  16,
    marginTop:         12,
    marginBottom:      4,
    backgroundColor:   C.white,
    borderRadius:      12,
    paddingHorizontal: 12,
    paddingVertical:   10,
    borderWidth:       1,
    borderColor:       C.gray200,
  },
  searchInput: { flex: 1, fontSize: 14, color: C.gray900, paddingVertical: 0 },

  filterRow:     { maxHeight: 52 },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
    alignItems:        "center",
  },
  filterTab: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderRadius:      20,
    backgroundColor:   C.white,
    borderWidth:       1,
    borderColor:       C.gray200,
  },
  filterTabActive:       { backgroundColor: C.primary, borderColor: C.primary },
  filterTabText:         { fontSize: 13, fontWeight: "600", color: C.gray500 },
  filterTabTextActive:   { color: C.white },
  filterBadge: {
    minWidth:          20,
    height:            20,
    borderRadius:      10,
    backgroundColor:   C.gray100,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 4,
  },
  filterBadgeActive:     { backgroundColor: "rgba(255,255,255,0.25)" },
  filterBadgeText:       { fontSize: 10, fontWeight: "700", color: C.gray500 },
  filterBadgeTextActive: { color: C.white },

  listContent:      { padding: 12, paddingBottom: 60 },
  listContentEmpty: { flexGrow: 1 },

  card: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: C.white,
    borderRadius:    14,
    padding:         14,
    marginBottom:    8,
    gap:             12,
    borderWidth:     1,
    borderColor:     C.gray100,
    shadowColor:     "#000",
    shadowOpacity:   0.03,
    shadowRadius:    4,
    elevation:       1,
    position:        "relative",
    overflow:        "hidden",
  },
  cardUnread: { backgroundColor: "#FAFAFF", borderWidth: 1.5, borderColor: "#E0E7FF" },
  cardPinned: { borderTopWidth: 2, borderTopColor: C.warning },
  cardUrgent: { backgroundColor: "#FFF5F5", borderColor: "#FECACA" },

  unreadStrip: {
    position:               "absolute",
    left:                   0,
    top:                    0,
    bottom:                 0,
    width:                  3,
    backgroundColor:        C.primary,
    borderTopLeftRadius:    14,
    borderBottomLeftRadius: 14,
  },
  unreadDot: {
    position:        "absolute",
    top:             10,
    right:           10,
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: C.primary,
  },

  cardIcon: {
    width:          42,
    height:         42,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
    marginTop:      2,
    flexShrink:     0,
  },

  cardBadgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginBottom: 5 },
  pinBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      4,
    backgroundColor:   C.warningBg,
  },
  pinBadgeText:    { fontSize: 10, fontWeight: "700", color: C.warning },
  priBadge:        { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  priBadgeText:    { fontSize: 10, fontWeight: "700" },
  authorBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      4,
  },
  authorBadgeText: { fontSize: 10, fontWeight: "600" },

  cardTitle:       { fontSize: 15, fontWeight: "600", color: C.gray900, lineHeight: 20, marginBottom: 4 },
  cardTitleUnread: { fontWeight: "800" },
  cardBody:        { fontSize: 13, color: C.gray500, lineHeight: 18, marginBottom: 6 },
  cardMeta:        { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  cardAuthor:      { fontSize: 11, fontWeight: "600", color: C.gray500, maxWidth: 120 },
  cardDot:         { fontSize: 11, color: C.gray300 },
  cardTime:        { fontSize: 11, color: C.gray400 },

  emptyState: {
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 70,
    gap:             12,
  },
  emptyIconWrap: {
    width:           80,
    height:          80,
    borderRadius:    40,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
    marginBottom:    4,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: C.gray500 },
  emptySub: {
    fontSize:   13,
    color:      C.gray400,
    textAlign:  "center",
    maxWidth:   260,
    lineHeight: 20,
  },
});
import { useTranslation } from "../../src/i18n/useTranslation";