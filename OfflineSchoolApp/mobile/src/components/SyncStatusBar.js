// src/components/SyncStatusBar.js
"use strict";

/**
 * The app-wide offline / pending-upload strip.
 *
 * Mount once per role layout. It stays out of the way when everything is
 * online and empty, and otherwise states plainly what is happening:
 *
 *   offline                → "Offline — changes are saved on this device"
 *   offline login session  → "Signed in offline — sign in again to upload"
 *   queued work            → "N change(s) waiting to upload"
 *   blocked work           → "N change(s) need attention" (tappable)
 *
 * Tapping a blocked state opens the pending-changes screen.
 *
 * It is pinned to the BOTTOM as an overlay rather than inserted above the
 * navigator. Screens in this app set their own hardcoded `paddingTop: 60`
 * to clear the status bar, so a top strip would double that offset on every
 * screen the moment the device went offline. An overlay changes no layout.
 */

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { useTranslation } from "../i18n/useTranslation";

const C = {
  offline:  "#6B7280",
  pending:  "#B45309",
  blocked:  "#B91C1C",
  text:     "#FFFFFF",
};

/**
 * useSafeAreaInsets throws when no SafeAreaProvider is mounted above it.
 * The hook is still *called* on every render, so hook order is stable and
 * catching here is safe — it just degrades to a flat inset.
 */
const useBottomInset = () => {
  try {
    return useSafeAreaInsets().bottom;
  } catch {
    return 0;
  }
};

export const SyncStatusBar = ({ style }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const bottomInset = useBottomInset();
  const { isConnected, isOfflineSession, stats, pendingCount, hasBlocked } = useSyncStatus();

  const blockedCount = stats.conflict + stats.failed;
  const waitingCount = pendingCount - blockedCount;

  let tone = null;
  let icon = "cloud-offline-outline";
  let label = "";
  let tappable = false;

  if (hasBlocked) {
    tone = C.blocked;
    icon = "alert-circle-outline";
    label = `${blockedCount} change${blockedCount === 1 ? "" : "s"} need attention`;
    tappable = true;
  } else if (isOfflineSession) {
    tone = C.pending;
    icon = "log-in-outline";
    label = t("sync.offlineSession");
  } else if (!isConnected) {
    tone = C.offline;
    icon = "cloud-offline-outline";
    label = waitingCount > 0
      ? `Offline — ${waitingCount} change${waitingCount === 1 ? "" : "s"} saved on this device`
      : "Offline — changes are saved on this device";
  } else if (waitingCount > 0) {
    tone = C.pending;
    icon = "cloud-upload-outline";
    label = `Uploading ${waitingCount} change${waitingCount === 1 ? "" : "s"}…`;
  }

  if (!tone) return null;

  const Wrapper = tappable ? TouchableOpacity : View;

  return (
    <Wrapper
      style={[
        styles.bar,
        { backgroundColor: tone, paddingBottom: 7 + bottomInset },
        style,
      ]}
      {...(tappable
        ? { onPress: () => router.push("/sync/pending"), activeOpacity: 0.8 }
        : {})}
    >
      {isConnected && waitingCount > 0 && !hasBlocked
        ? <ActivityIndicator size="small" color={C.text} />
        : <Ionicons name={icon} size={15} color={C.text} />}

      <Text style={styles.text} numberOfLines={1}>{label}</Text>

      {tappable && <Ionicons name="chevron-forward" size={15} color={C.text} />}
    </Wrapper>
  );
};

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    elevation: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 7,
  },
  text: {
    flex: 1,
    color: C.text,
    fontSize: 12.5,
    fontWeight: "600",
  },
});

export default SyncStatusBar;
