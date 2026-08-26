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
    case "suspend": return { icon: "ban-outline",             color: "#D97706", labelKey: "syncScreens.vSuspend" };
    case "restore": return { icon: "checkmark-circle-outline", color: "#059669", labelKey: "syncScreens.vRestore" };
    case "delete":  return { icon: "trash-outline",            color: "#DC2626", labelKey: "syncScreens.vDelete"  };
    case "move":    return { icon: "swap-horizontal-outline",  color: "#4F46E5", labelKey: "syncScreens.vMove"    };
    // `raw` keeps an unrecognised action visible instead of mislabelling it.
    default:        return { icon: "sync-outline",             color: "#6B7280", labelKey: "syncScreens.vUpdate", raw: action };
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
  const isUnseen = item.seen_by_loser === 0;

  return (
    <TouchableOpacity
      style={[styles.row, isUnseen && styles.rowUnseen]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {isUnseen && <View style={styles.unseenDot} />}

      <View style={[styles.iconWrap, { backgroundColor: action.color + "15" }]}>
        <Ionicons name={action.icon} size={20} color={action.color} />
      </View>

      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.entity_name || `Unnamed ${item.entity_type}`}
          </Text>
          <Text style={styles.rowTime}>{timeAgo(item.overwritten_at)}</Text>
        </View>

        <View style={styles.rowMeta}>
          <Ionicons
            name={getEntityIcon(item.entity_type)}
            size={11}
            color="#9CA3AF"
          />
          <Text style={styles.rowMetaText}>
            {item.entity_type}
          </Text>
          <Text style={styles.rowSeparator}>•</Text>
          <Text style={[styles.rowMetaText, { color: action.color, fontWeight: "600" }]}>
            {action.label}
          </Text>
        </View>

        <Text style={styles.rowDescription} numberOfLines={2}>
          <Text style={{ fontWeight: "600", color: "#111827" }}>
            {item.overwritten_by_name || t("syncScreens.someone")}
          </Text>
          {"'s edit replaced yours from "}
          {formatDateTime(item.lost_edit_at)}
        </Text>
      </View>

      <TouchableOpacity
        onPress={onDismiss}
        style={styles.dismissBtn}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="close" size={18} color="#9CA3AF" />
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

  const load = useCallback(async () => {
    try {
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
    const unseenCount = overwrites.filter((o) => o.seen_by_loser === 0).length;
    if (unseenCount === 0) return;

    Alert.alert(
      t("syncScreens.markAllSeen"),
      `Mark all ${unseenCount} overwrite${unseenCount > 1 ? "s" : ""} as seen? This will clear the dashboard alert.`,
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
  }, [overwrites, schoolId]);

  // ── Derived counts ───────────────────────────────────

  const unseenCount = overwrites.filter((o) => o.seen_by_loser === 0).length;

  // ── Loading ──────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
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
            <Ionicons name="checkmark-circle" size={48} color="#10B981" />
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
        <Ionicons name="information-circle-outline" size={16} color="#1E40AF" />
        <Text style={styles.infoText}>
          {t("syncScreens.banner")}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor="#4F46E5"
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
        <Ionicons name="chevron-back" size={22} color="#374151" />
      </TouchableOpacity>
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
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "#6B7280", fontSize: 14 },
  scroll:      { padding: 16, gap: 10 },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    backgroundColor:   "#fff",
    paddingHorizontal: 16,
    paddingTop:        50,
    paddingBottom:     14,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#6B7280", marginTop: 1 },
  actionBtn: {
    backgroundColor:   "#EEF2FF",
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
  },
  actionText: { fontSize: 12, fontWeight: "700", color: "#4338CA" },

  // Info banner
  infoBanner: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             8,
    backgroundColor: "#DBEAFE",
    borderColor:     "#BFDBFE",
    borderWidth:     1,
    padding:         12,
    marginHorizontal:16,
    marginTop:       12,
    borderRadius:    10,
  },
  infoText: { flex: 1, fontSize: 12, color: "#1E40AF", lineHeight: 17 },

  // Row
  row: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: "#fff",
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    padding:         14,
    gap:             12,
  },
  rowUnseen: {
    borderColor:     "#C7D2FE",
    backgroundColor: "#FAFBFF",
  },
  unseenDot: {
    position:        "absolute",
    top:             10,
    right:           10,
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: "#4F46E5",
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
    color:      "#111827",
    flex:       1,
    marginRight: 8,
  },
  rowTime: { fontSize: 11, color: "#9CA3AF" },
  rowMeta: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           5,
    marginBottom:  6,
  },
  rowMetaText: {
    fontSize:      11,
    color:         "#6B7280",
    textTransform: "capitalize",
  },
  rowSeparator: { fontSize: 11, color: "#D1D5DB" },
  rowDescription: {
    fontSize:   12,
    color:      "#4B5563",
    lineHeight: 17,
  },
  dismissBtn: {
    width:          28,
    height:         28,
    borderRadius:   14,
    alignItems:     "center",
    justifyContent: "center",
    backgroundColor:"#F3F4F6",
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
    borderRadius:    36,
    backgroundColor: "#ECFDF5",
    alignItems:      "center",
    justifyContent:  "center",
    marginBottom:    8,
  },
  emptyTitle:    { fontSize: 18, fontWeight: "800", color: "#111827" },
  emptySubtitle: { fontSize: 13, color: "#6B7280", textAlign: "center", lineHeight: 19 },
  emptyBtn: {
    marginTop:       16,
    backgroundColor: "#4F46E5",
    borderRadius:    12,
    paddingHorizontal:20,
    paddingVertical: 10,
  },
  emptyBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
import { useTranslation } from "../../../src/i18n/useTranslation";