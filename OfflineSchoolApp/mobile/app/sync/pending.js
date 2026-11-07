// app/sync/pending.js
"use strict";

/**
 * Pending changes — the recovery surface for the mutation outbox.
 *
 * Rows that hit a version conflict or exhausted their retries used to be
 * parked in SQLite with nothing in the app ever reading them again: no
 * retry, no listing, no count. A teacher's offline register could die there
 * silently. This screen lists them and lets the user retry or discard.
 */

import React, { useState, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, Alert, ActivityIndicator,
} from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MutationQueue } from "../../src/services/mutationQueue.service";
import { useSyncStatus } from "../../src/hooks/useSyncStatus";


import { useTranslation } from "../../src/i18n/useTranslation";
import { getDatabase } from "../../src/db/database";
import { countHeldChanges } from "../../src/db/heldChanges";
import { reviewCounts } from "../../src/services/perUserData.service";
import { COLORS, ACCENT, SEMANTIC, TONE_EDGE } from "../../src/theme/colors";
import { HeaderIcon, Badge, EmptyState } from "../../src/components/Tinted";

const C = {
  bg: COLORS.page, card: COLORS.surface, border: COLORS.border,
  text: COLORS.text, muted: COLORS.textSecondary,
  conflict: SEMANTIC.warning.text, conflictBg: SEMANTIC.warning.bg,
  failed: SEMANTIC.error.text, failedBg: SEMANTIC.error.bg,
  primary: ACCENT.amber.solid, success: ACCENT.green.solid,
  heldBg: SEMANTIC.info.bg, held: SEMANTIC.info.text,
};

/**
 * Changes on this phone that the signed-in account does not send: another
 * account's, or nobody's (queued before ownership was recorded). Read-only —
 * there is no action here on purpose. Sending them as this account would put
 * someone else's work under this name; discarding them is not this person's
 * decision to make. See docs/40-per-user-local-data.md.
 */
const HeldNotice = ({ held }) => {
  const { t } = useTranslation();
  if (!held.otherAccounts && !held.ownerlessQueued) return null;
  return (
    <View style={styles.held} accessibilityRole="summary">
      <Ionicons name="people-outline" size={16} color={C.held} />
      <View style={{ flex: 1, gap: 4 }}>
        {held.otherAccounts > 0 && (
          <Text style={styles.heldText}>
            {t("syncScreens.heldOtherAccount", { count: held.otherAccounts })}
          </Text>
        )}
        {held.ownerlessQueued > 0 && (
          <Text style={styles.heldText}>
            {t("syncScreens.heldOwnerless", { count: held.ownerlessQueued })}
          </Text>
        )}
      </View>
    </View>
  );
};

/**
 * Per-user local data (docs/40): changes held in the review store because
 * nobody could tell whose they are. Opens the review list.
 */
const ReviewLink = ({ count, onOpen }) => {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <TouchableOpacity style={styles.held} onPress={onOpen} accessibilityRole="button">
      <Ionicons name="hand-left-outline" size={16} color={C.held} />
      <Text style={[styles.heldText, { flex: 1 }]}>{t("localData.reviewLink", { count })}</Text>
      <Ionicons name="chevron-forward" size={16} color={C.held} />
    </TouchableOpacity>
  );
};

/** Turns "POST /homework" into something a non-engineer can read. */
const describe = (row) => {
  const key = String(row.entity_key || "");
  const [kind, ...rest] = key.split(":");
  // Keys are the stored entity kinds; only the label is localised. An
  // unrecognised kind falls through to its raw value, as before.
  const map = {
    attendance: "syncScreens.kAttendance",
    homework: "syncScreens.kHomework",
    homework_submission: "syncScreens.kHomeworkSubmission",
    exam: "syncScreens.kExam",
    "exam-scores": "syncScreens.kExamMarks",
    "exam-subject": "syncScreens.kExamSubject",
    "exam-status": "syncScreens.kExamStatus",
    "exam-subject-status": "syncScreens.kMarksSubmission",
  };
  const labelKey = map[kind] || null;
  const detail = rest.join(":");
  return { labelKey, rawKind: kind, detail };
};

const StatusChip = ({ status }) => {
  const { t } = useTranslation();
  const isConflict = status === "conflict";
  return (
    <Badge
      tone={isConflict ? "warning" : "error"}
      label={isConflict ? t("syncScreens.chipConflict") : t("syncScreens.chipFailed")}
      textStyle={styles.chipText}
    />
  );
};

export default function PendingChangesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState({ otherAccounts: 0, ownerlessQueued: 0 });
  const [reviewHeld, setReviewHeld] = useState(0);
  const { stats, refresh: refreshStats } = useSyncStatus({ poll: false });

  const load = useCallback(async () => {
    try {
      const list = await MutationQueue.listUnresolved();
      setRows(list);
      setHeld(await countHeldChanges(await getDatabase()));
      setReviewHeld((await reviewCounts().catch(() => ({ held: 0 }))).held);
    } catch (err) {
      console.warn("[pending] load failed:", err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); refreshStats(); }, [load, refreshStats]));

  const runSync = useCallback(async () => {
    setBusy(true);
    try {
      const { SyncManager } = require("../../src/services/syncManager");
      // force: the user tapped "sync now". Without it the global 15 s gap
      // could reject the call and the button would appear to do nothing.
      await SyncManager.ensureStarted();
      await SyncManager.syncAll({ force: true, full: true });
    } catch (err) {
      console.warn("[pending] sync failed:", err.message);
    } finally {
      setBusy(false);
      await load();
      await refreshStats();
    }
  }, [load, refreshStats]);

  const retryOne = useCallback(async (row) => {
    await MutationQueue.retry(row.id);
    await runSync();
  }, [runSync]);

  const retryAll = useCallback(async () => {
    const n = await MutationQueue.retryAllFailed();
    if (n > 0) await runSync();
    else await load();
  }, [runSync, load]);

  const discardOne = useCallback((row) => {
    const { labelKey, rawKind } = describe(row);
    const label = labelKey ? t(labelKey) : (rawKind || t("syncScreens.kChange"));
    Alert.alert(
      t("syncScreens.discardTitle"),
      t("syncScreens.discardBody", { label }),
      [
        { text: t("syncScreens.keep"), style: "cancel" },
        {
          text: t("common.discard"),
          style: "destructive",
          onPress: async () => {
            // Drops the change and undoes it on this device. Where only the
            // server's copy can restore the record, discard() resets the pull
            // cursor; the sync after it (online) brings that copy down now.
            const { refresh } = await MutationQueue.discard(row.id);
            if (refresh) await runSync();
            else {
              await load();
              await refreshStats();
            }
          },
        },
      ]
    );
  }, [load, refreshStats, runSync, t]);

  const renderItem = ({ item }) => {
    const { labelKey, rawKind, detail } = describe(item);
    const label = labelKey ? t(labelKey) : (rawKind || t("syncScreens.kChange"));
    const attempts = item.retry_count || 0;
    const tone = item.status === "conflict" ? "warning" : "error";

    return (
      <View
        style={[
          styles.card,
          { backgroundColor: SEMANTIC[tone].bg, borderLeftColor: TONE_EDGE[tone] },
        ]}
      >
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} numberOfLines={1}>{label}</Text>
          <StatusChip status={item.status} />
        </View>

        {!!detail && (
          <Text style={styles.detail} numberOfLines={1}>{detail}</Text>
        )}

        <Text style={styles.meta}>
          {item.method} {item.endpoint}
          {attempts > 0 ? `  ·  ${t("syncScreens.attemptCount", { count: attempts })}` : ""}
        </Text>

        {!!item.error && (
          <Text style={styles.error} numberOfLines={2}>{item.error}</Text>
        )}

        {item.status === "conflict" && (
          <Text style={styles.hint}>
            {t("syncScreens.conflictNote")}
          </Text>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => retryOne(item)}
            disabled={busy}
          >
            <Ionicons name="refresh" size={14} color={COLORS.onPrimary} />
            <Text style={styles.btnPrimaryText}>{t("common.retry")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={() => discardOne(item)}
            disabled={busy}
          >
            <Ionicons name="trash-outline" size={14} color={C.failed} />
            <Text style={styles.btnGhostText}>{t("common.discard")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      {/* The root Stack hides headers globally; this screen is reached from
          a banner tap, so it needs its own header to get a back affordance. */}
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("syncScreens.pendingTitle"),
          headerTintColor: C.text,
          headerStyle: { backgroundColor: C.card },
        }}
      />

      <View style={styles.summary}>
        <HeaderIcon size={28} style={styles.headerIcon} />
        <Text style={styles.summaryText}>
          {t("syncScreens.waitingCount", { count: stats.pending + stats.retrying })}
          {stats.uploads > 0 ? `  ·  ${t("syncScreens.fileCount", { count: stats.uploads })}` : ""}
          {"  ·  "}{t("syncScreens.conflictCount", { count: stats.conflict })}
          {"  ·  "}{t("syncScreens.failedCount", { count: stats.failed })}
        </Text>
        <TouchableOpacity onPress={runSync} disabled={busy} style={styles.syncBtn}>
          {busy
            ? <ActivityIndicator size="small" color={C.primary} />
            : <Ionicons name="sync" size={16} color={C.primary} />}
          <Text style={styles.syncBtnText}>{t("syncScreens.syncNow")}</Text>
        </TouchableOpacity>
      </View>

      <HeldNotice held={held} />
      <ReviewLink count={reviewHeld} onOpen={() => router.push("/sync/review")} />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.primary} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          contentContainerStyle={rows.length ? styles.list : styles.listEmpty}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={load} tintColor={C.primary} />
          }
          ListEmptyComponent={
            <EmptyState
              icon="checkmark-circle-outline"
              accent="green"
              title={t("syncScreens.nothingStuck")}
              message={t("syncScreens.nothingStuckSub")}
              style={styles.empty}
              action={
                <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                  <Text style={styles.backBtnText}>{t("common.goBack")}</Text>
                </TouchableOpacity>
              }
            />
          }
          ListFooterComponent={
            rows.length > 1 ? (
              <TouchableOpacity
                style={styles.retryAll}
                onPress={retryAll}
                disabled={busy}
              >
                <Ionicons name="refresh-circle-outline" size={18} color={C.primary} />
                <Text style={styles.retryAllText}>{t("syncScreens.retryAll", { count: rows.length })}</Text>
              </TouchableOpacity>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  summary: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  summaryText: { flex: 1, fontSize: 12.5, color: C.muted, fontWeight: "600" },
  syncBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 12 },
  syncBtnText: { color: ACCENT.amber.deep, fontWeight: "700", fontSize: 13 },
  headerIcon: { marginRight: 10 },

  held: {
    flexDirection: "row", gap: 8, alignItems: "flex-start",
    marginHorizontal: 14, marginTop: 12, padding: 12, borderRadius: 10,
    backgroundColor: C.heldBg,
    borderWidth: 1, borderColor: SEMANTIC.info.box,
  },
  heldText: { fontSize: 12.5, color: C.held, lineHeight: 18 },

  list: { padding: 14, gap: 12 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },

  card: {
    backgroundColor: C.card, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: C.border, gap: 6,
    borderLeftWidth: 3,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: C.text },
  chipText: { fontSize: 11, fontWeight: "700" },
  detail: { fontSize: 12, color: C.muted },
  meta: { fontSize: 11, color: C.muted, fontFamily: "monospace" },
  error: { fontSize: 12, color: C.failed },
  hint: { fontSize: 12, color: C.conflict, fontStyle: "italic" },

  actions: { flexDirection: "row", gap: 10, marginTop: 6 },
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
  },
  btnPrimary: { backgroundColor: C.primary },
  btnPrimaryText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 13 },
  btnGhost: { borderWidth: 1, borderColor: C.border, backgroundColor: COLORS.surface },
  btnGhostText: { color: C.failed, fontWeight: "600", fontSize: 13 },

  retryAll: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 14,
  },
  retryAllText: { color: ACCENT.amber.deep, fontWeight: "700" },

  empty: { padding: 32 },
  backBtn: { marginTop: 10, paddingHorizontal: 20, paddingVertical: 10 },
  backBtnText: { color: ACCENT.amber.deep, fontWeight: "700" },
});
