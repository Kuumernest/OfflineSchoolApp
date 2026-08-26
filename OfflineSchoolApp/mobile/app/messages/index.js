// app/messages/index.js
//
// The conversation list.
//
// Reads the local store first and renders immediately, then refreshes from
// the server in the background. A list that only appears once the network
// answers is useless on the links this app is built for — the whole point of
// keeping conversations locally is that opening Messages on a dead link
// still shows you your threads.

import { useState, useCallback, useEffect } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuthStore } from "../../src/store/auth.store";
import MessageService   from "../../src/services/message.service";
import { useTranslation } from "../../src/i18n/useTranslation";

const C = {
  primary: "#2563EB", primaryBg: "#EFF6FF", white: "#FFFFFF",
  gray50: "#F9FAFB", gray100: "#F3F4F6", gray200: "#E5E7EB",
  gray300: "#D1D5DB", gray400: "#9CA3AF", gray500: "#6B7280",
  gray700: "#374151", gray900: "#111827",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const timeLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** Direct threads carry no title; they are named for the other person. */
const titleFor = (c, myId) => {
  const { t } = useTranslation();
  if (c.title) return c.title;
  const other = (c.participants || []).find((p) => String(p.id) !== String(myId));
  return other?.name || t("msgMobile.conversation");
};

const iconFor = (kind) => {
  if (kind === "group") return "people-outline";
  if (kind === "class" || kind === "subject") return "school-outline";
  return "chatbubble-ellipses-outline";
};

// ── Screen ──────────────────────────────────────────────────────────────────

export default function ConversationsScreen() {
  const { t } = useTranslation();
  const user  = useAuthStore((s) => s.user);
  const myId  = String(user?._id ?? "");

  const [conversations, setConversations] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [syncNote,      setSyncNote]      = useState(null);

  /** Local read — instant, and correct offline. */
  const loadLocal = useCallback(async () => {
    try {
      setConversations(await MessageService.listConversations());
    } catch (err) {
      console.warn("[messages] local read failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Server refresh. Failure here is ordinary — say so quietly, do not alarm. */
  const refresh = useCallback(async () => {
    const res = await MessageService.syncConversations({ myId, myKind: "user" });
    setSyncNote(res.ok ? null : t("msgMobile.syncNote"));
    await loadLocal();
  }, [myId, loadLocal]);

  useEffect(() => {
    loadLocal().then(refresh);
  }, [loadLocal, refresh]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  // ── Render ────────────────────────────────────────────────────────────────

  const renderItem = ({ item }) => {
                       return (
    <TouchableOpacity
      style={s.row}
      activeOpacity={0.7}
      onPress={() => router.push(`/messages/${item._id}`)}
    >
      <View style={s.avatar}>
        <Ionicons name={iconFor(item.kind)} size={20} color={C.primary} />
      </View>

      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={s.rowTitle} numberOfLines={1}>
            {titleFor(item, myId)}
          </Text>
          <Text style={s.rowTime}>{timeLabel(item.lastMessageAt)}</Text>
        </View>

        <View style={s.rowBottom}>
          <Text style={s.rowPreview} numberOfLines={1}>
            {item.lastMessagePreview || t("msgMobile.noMessagesYet")}
          </Text>
          {item.unread > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{item.unread}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
                     };

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t("msgMobile.title")}</Text>
        <TouchableOpacity
          onPress={() => router.push("/messages/new")}
          style={s.backBtn}
        >
          <Ionicons name="create-outline" size={22} color={C.primary} />
        </TouchableOpacity>
      </View>

      {syncNote && (
        <View style={s.note}>
          <Ionicons name="cloud-offline-outline" size={14} color={C.gray500} />
          <Text style={s.noteText}>{syncNote}</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c._id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.primary} />
          }
          ListEmptyComponent={
            <View style={s.empty}>
              <Ionicons name="chatbubbles-outline" size={44} color={C.gray300} />
              <Text style={s.emptyTitle}>{t("msgMobile.emptyTitle")}</Text>
              <Text style={s.emptyBody}>
                {t("msgMobile.emptyBody")}
              </Text>
              <TouchableOpacity
                style={s.emptyBtn}
                onPress={() => router.push("/messages/new")}
                activeOpacity={0.85}
              >
                <Ionicons name="create-outline" size={17} color={C.white} />
                <Text style={s.emptyBtnText}>{t("msgMobile.startConversation")}</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray200,
  },
  backBtn:     { width: 40, alignItems: "center" },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: "700", color: C.gray900, textAlign: "center" },

  note: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: C.gray50, paddingHorizontal: 16, paddingVertical: 8,
  },
  noteText: { fontSize: 12, color: C.gray500 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.primaryBg, alignItems: "center", justifyContent: "center",
  },
  rowBody:   { flex: 1 },
  rowTop:    { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle:  { flex: 1, fontSize: 15, fontWeight: "700", color: C.gray900 },
  rowTime:   { fontSize: 11, color: C.gray400 },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  rowPreview:{ flex: 1, fontSize: 13, color: C.gray500 },

  badge: {
    minWidth: 20, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 10, backgroundColor: C.primary, alignItems: "center",
  },
  badgeText: { fontSize: 11, fontWeight: "700", color: C.white },

  empty:      { alignItems: "center", paddingTop: 80, paddingHorizontal: 40, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: C.gray700 },
  emptyBody:  { fontSize: 13, color: C.gray500, textAlign: "center", lineHeight: 19 },
  emptyBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.primary, borderRadius: 12,
    paddingHorizontal: 18, paddingVertical: 11, marginTop: 8,
  },
  emptyBtnText: { fontSize: 14, fontWeight: "700", color: C.white },
});
