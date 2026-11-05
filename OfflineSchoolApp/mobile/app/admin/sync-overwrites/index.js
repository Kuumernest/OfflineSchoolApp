// mobile/app/admin/sync-overwrites/index.js
"use strict";

import { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuthStore }     from "@/store/auth.store";
import SyncOverwriteService from "@/services/sync-overwrite.service";
import { COLORS, ACCENT, SEMANTIC, accentBadge } from "../../../src/theme/colors";
import { HeaderIcon } from "../../../src/components/Tinted";

const ACTION_BTN = accentBadge("amber");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const formatDateTime = (value) => {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year:   "numeric",
    month:  "short",
    day:    "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
};

const timeAgo = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";

  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);

  if (seconds < 60)       return `${seconds}s ago`;
  if (seconds < 3600)     return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400)    return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800)   return `${Math.floor(seconds / 86400)}d ago`;
  return d.toLocaleDateString();
};

const getActionConfig = (action) => {
  switch (action) {
    case "suspend": return { icon: "ban-outline",             color: ACCENT.amber.solid,  deep: ACCENT.amber.deep,  labelKey: "syncScreens.vSuspend" };
    case "restore": return { icon: "checkmark-circle-outline", color: ACCENT.green.solid,  deep: ACCENT.green.deep,  labelKey: "syncScreens.vRestore" };
    case "delete":  return { icon: "trash-outline",            color: ACCENT.red.solid,    deep: ACCENT.red.deep,    labelKey: "syncScreens.vDelete"  };
    case "move":    return { icon: "swap-horizontal-outline",  color: ACCENT.indigo.solid, deep: ACCENT.indigo.deep, labelKey: "syncScreens.vMove"    };
    // `raw` keeps an unrecognised action visible instead of mislabelling it.
    default:        return { icon: "sync-outline",             color: ACCENT.slate.solid,  deep: ACCENT.slate.deep,  labelKey: "syncScreens.vUpdate", raw: action };
  }
};

const getEntityIcon = (entityType) => {
  switch (entityType) {
    case "student": return "person-outline";
    case "teacher": return "school-outline";
    case "class":   return "grid-outline";
    default:        return "cube-outline";
  }
};

// ─────────────────────────────────────────────────────────
// OVERWRITE ROW
// ─────────────────────────────────────────────────────────

function OverwriteRow({ item, onPress, onDismiss }) {
  const { t } = useTranslation();
  const action = getActionConfig(item.new_action);
  // Only a lost edit of yours is news; the note of a change you replaced is
  // stored seen and never shows the dot.
  const isUnseen = item.side === "lost" && item.seen_by_loser === 0;
  const when     = formatDateTime(item.lost_edit_at);

  return (
    <TouchableOpacity
      style={[styles.row, isUnseen && styles.rowUnseen]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {isUnseen && <View style={styles.unseenDot} />}

      <View style={[styles.iconWrap, { backgroundColor: action.color }]}>
        <Ionicons name={action.icon} size={20} color={COLORS.onPrimary} />
      </View>

      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.entity_name || t("syncScreens.unnamed", { type: item.entity_type })}
          </Text>
          <Text style={styles.rowTime}>{timeAgo(item.overwritten_at)}</Text>
        </View>

        <View style={styles.rowMeta}>
          <Ionicons
            name={getEntityIcon(item.entity_type)}
            size={11}
            color={ACCENT.amber.solid}
          />
          <Text style={styles.rowMetaText}>
            {item.entity_type}
          </Text>
          <Text style={styles.rowSeparator}>•</Text>
          <Text style={[styles.rowMetaText, { color: action.deep, fontWeight: "600" }]}>
            {action.raw || t(action.labelKey)}
          </Text>
        </View>

        <Text style={styles.rowDescription} numberOfLines={2}>
          {item.side === "lost"
            ? t("syncScreens.lostRow", { name: item.overwritten_by_name || t("syncScreens.someone"), when })
            : t("syncScreens.wonRow", { name: item.lost_edit_by_name || t("syncScreens.someone"), when })}
        </Text>
      </View>

      <TouchableOpacity
        onPress={onDismiss}
        style={styles.dismissBtn}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="close" size={18} color={COLORS.textSecondary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function SyncOverwritesScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const schoolId = useAuthStore((s) => s.user?.schoolId);

  const [overwrites, setOverwrites] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Load overwrites ──────────────────────────────────

  const load = useCallback(async ({ force = false } = {}) => {
    try {
      // Your own overwritten edits live on the server; online, bring them
      // down first. Offline, what this phone already has is shown.
      await SyncOverwriteService.refreshFromServer({ force });
      const rows = await SyncOverwriteService.getAllOverwrites({
        schoolId,
        limit: 200,
      });
      setOverwrites(rows);
    } catch (err) {
      console.warn("[sync-overwrites] load failed:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId]);

  // Reload every time screen comes into focus
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // ── Dismiss one ──────────────────────────────────────

  const handleDismiss = useCallback(async (id) => {
    await SyncOverwriteService.markAsSeen(id);
    setOverwrites((prev) =>
      prev.map((o) => (o.id === id ? { ...o, seen_by_loser: 1 } : o))
    );
  }, []);

  // ── Dismiss all ──────────────────────────────────────

  const handleDismissAll = useCallback(() => {
    const unseenCount = overwrites.filter((o) => o.side === "lost" && o.seen_by_loser === 0).length;
    if (unseenCount === 0) return;

    Alert.alert(
      t("syncScreens.markAllSeen"),
      t("syncScreens.markAllSeenBody", { count: unseenCount }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("syncScreens.markAll"),
          onPress: async () => {
            await SyncOverwriteService.markAllAsSeen(schoolId);
            setOverwrites((prev) =>
              prev.map((o) => ({ ...o, seen_by_loser: 1 }))
            );
          },
        },
      ]
    );
  }, [overwrites, schoolId, t]);

  // ── Derived counts ───────────────────────────────────

  const unseenCount = overwrites.filter((o) => o.side === "lost" && o.seen_by_loser === 0).length;

  // ── Loading ──────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.amber.solid} />
        <Text style={styles.loadingText}>{t("syncScreens.loading")}</Text>
      </View>
    );
  }

  // ── Empty state ──────────────────────────────────────

  if (overwrites.length === 0) {
    return (
      <View style={styles.container}>
        <Header onBack={() => router.back()} />
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Ionicons name="checkmark-circle" size={40} color={COLORS.onPrimary} />
          </View>
          <Text style={styles.emptyTitle}>{t("syncScreens.allClear")}</Text>
          <Text style={styles.emptySubtitle}>
            {t("syncScreens.allClearSub")}
          </Text>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.emptyBtn}
          >
            <Text style={styles.emptyBtnText}>{t("syncScreens.backToDash")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Main render ──────────────────────────────────────

  return (
    <View style={styles.container}>
      <Header
        onBack={() => router.back()}
        actionLabel={unseenCount > 0 ? t("syncScreens.dismissAll") : null}
        onAction={handleDismissAll}
      />

      {/* Info banner */}
      <View style={styles.infoBanner}>
        <Ionicons name="information-circle-outline" size={16} color={SEMANTIC.info.text} />
        <Text style={styles.infoText}>
          {t("syncScreens.banner")}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load({ force: true }); }}
            tintColor={ACCENT.amber.solid}
          />
        }
      >
        {overwrites.map((item) => (
          <OverwriteRow
            key={item.id}
            item={item}
            onPress={() => router.push(`/admin/sync-overwrites/${item.id}`)}
            onDismiss={() => handleDismiss(item.id)}
          />
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────

function Header({ onBack, actionLabel, onAction }) {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Ionicons name="chevron-back" size={22} color={COLORS.text} />
      </TouchableOpacity>
      <HeaderIcon style={styles.headerIcon} />
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>{t("syncScreens.listTitle")}</Text>
        <Text style={styles.headerSub}>{t("syncScreens.listBlurb")}</Text>
      </View>
      {actionLabel && (
        <TouchableOpacity onPress={onAction} style={styles.actionBtn}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: COLORS.textSecondary, fontSize: 14 },
  scroll:      { padding: 16, gap: 10 },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    backgroundColor:   COLORS.surface,
    paddingHorizontal: 16,
    paddingTop:        50,
    paddingBottom:     14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerIcon: { marginRight: 0 },
  backBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  actionBtn: {
    backgroundColor:   ACTION_BTN.bg,
    borderWidth:       1,
    borderColor:       ACTION_BTN.border,
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
  },
  actionText: { fontSize: 12, fontWeight: "700", color: ACTION_BTN.text },

  // Info banner
  infoBanner: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             8,
    backgroundColor: SEMANTIC.info.bg,
    borderColor:     SEMANTIC.info.box,
    borderWidth:     1,
    padding:         12,
    marginHorizontal:16,
    marginTop:       12,
    borderRadius:    10,
  },
  infoText: { flex: 1, fontSize: 12, color: SEMANTIC.info.text, lineHeight: 17 },

  // Row
  row: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: ACCENT.amber.wash,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.amber.base,
    padding:         14,
    gap:             12,
  },
  rowUnseen: {
    borderColor:     ACCENT.amber.base,
    borderLeftColor: ACCENT.amber.base,
  },
  unseenDot: {
    position:        "absolute",
    top:             10,
    right:           10,
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: ACCENT.amber.solid,
  },
  iconWrap: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1 },
  rowHeader: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   4,
  },
  rowTitle: {
    fontSize:   14,
    fontWeight: "700",
    color:      COLORS.text,
    flex:       1,
    marginRight: 8,
  },
  rowTime: { fontSize: 11, color: COLORS.textSecondary },
  rowMeta: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           5,
    marginBottom:  6,
  },
  rowMetaText: {
    fontSize:      11,
    color:         COLORS.textSecondary,
    textTransform: "capitalize",
  },
  rowSeparator: { fontSize: 11, color: COLORS.textSecondary },
  rowDescription: {
    fontSize:   12,
    color:      COLORS.textSecondary,
    lineHeight: 17,
  },
  dismissBtn: {
    width:          28,
    height:         28,
    borderRadius:   14,
    alignItems:     "center",
    justifyContent: "center",
    backgroundColor:COLORS.surface,
    borderWidth:    1,
    borderColor:    COLORS.border,
  },

  // Empty state
  emptyState: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    padding:         32,
    gap:             12,
  },
  emptyIcon: {
    width:           72,
    height:          72,
    borderRadius:    20,
    backgroundColor: ACCENT.green.solid,
    alignItems:      "center",
    justifyContent:  "center",
    marginBottom:    8,
  },
  emptyTitle:    { fontSize: 18, fontWeight: "800", color: COLORS.text },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center", lineHeight: 19 },
  emptyBtn: {
    marginTop:       16,
    backgroundColor: ACCENT.amber.solid,
    borderRadius:    12,
    paddingHorizontal:20,
    paddingVertical: 10,
  },
  emptyBtnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
});
import { useTranslation } from "../../../src/i18n/useTranslation";