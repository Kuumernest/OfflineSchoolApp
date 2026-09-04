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
import { useSyncProgress } from "../hooks/useSyncProgress";
import { ProgressBar } from "./ProgressBar";
import { useTranslation } from "../i18n/useTranslation";

const C = {
  offline:  "#6B7280",
  pending:  "#B45309",
  blocked:  "#B91C1C",
  syncing:  "#4338CA",
  text:     "#FFFFFF",
  // The strip is a saturated colour, so the track behind the fill has to
  // be a wash of white rather than the component default grey.
  track:    "rgba(255,255,255,0.28)",
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
  const progress = useSyncProgress();

  const blockedCount = stats.conflict + stats.failed;
  const waitingCount = pendingCount - blockedCount;

  let tone = null;
  let icon = "cloud-offline-outline";
  let label = "";
  let tappable = false;

  if (hasBlocked) {
    tone = C.blocked;
    icon = "alert-circle-outline";
    // Was an English sentence assembled here, plural "s" and all, in an app
    // that ships in French. A key now, with a real one/other pair: i18n-js
    // reads nested plural forms and NOT the `key_other` spelling that 28
    // keys elsewhere in these locale files use and nothing consults.
    label = t("sync.needAttention", { count: blockedCount });
    tappable = true;
  } else if (isOfflineSession) {
    tone = C.pending;
    icon = "log-in-outline";
    label = t("sync.offlineSession");
  } else if (!isConnected) {
    tone = C.offline;
    icon = "cloud-offline-outline";
    label = waitingCount > 0
      ? t("sync.offlineSaved", { count: waitingCount })
      : t("sync.offlineIdle");
  } else if (waitingCount > 0) {
    tone = C.pending;
    icon = "cloud-upload-outline";
    label = t("sync.uploading", { count: waitingCount });
  }

  // A running sync outranks "N waiting to upload": it is the same work with
  // something concrete to say about it. Blocked rows still win, because they
  // need a person and progress does not.
  const showProgress = progress.visible && !hasBlocked && !isOfflineSession;
  if (showProgress && (!tone || tone === C.pending)) tone = C.syncing;

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
      {showProgress ? (
        // done/total against 100, not the step count: the percentage already
        // folds the tally inside the current step into the whole, so it moves
        // during a long drain rather than once per step.
        <ProgressBar
          style={styles.progress}
          done={progress.percent}
          total={100}
          hideCount
          label={progress.label || t("sync.syncing")}
          detail={progress.detail}
          color={C.text}
          trackColor={C.track}
          textColor={C.text}
        />
      ) : (
        <>
          {isConnected && waitingCount > 0 && !hasBlocked
            ? <ActivityIndicator size="small" color={C.text} />
            : <Ionicons name={icon} size={15} color={C.text} />}

          <Text style={styles.text} numberOfLines={1}>{label}</Text>

          {tappable && <Ionicons name="chevron-forward" size={15} color={C.text} />}
        </>
      )}
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
  // flex: 1 so the bar takes the strip's width. The strip is a row, and an
  // unflexed child would collapse to its content and leave the fill a stub.
  progress: { flex: 1, paddingVertical: 2 },
});

export default SyncStatusBar;
