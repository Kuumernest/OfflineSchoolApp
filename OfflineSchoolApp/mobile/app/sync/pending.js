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

const C = {
  bg: "#F9FAFB", card: "#FFFFFF", border: "#E5E7EB",
  text: "#111827", muted: "#6B7280",
  conflict: "#B45309", conflictBg: "#FEF3C7",
  failed: "#B91C1C", failedBg: "#FEE2E2",
  primary: "#2563EB", success: "#059669",
};

/** Turns "POST /homework" into something a non-engineer can read. */
const describe = (row) => {
  const key = String(row.entity_key || "");
  const [kind, ...rest] = key.split(":");
  const map = {
    attendance: "Attendance register",
    homework: "Homework",
    homework_submission: "Homework submission",
    exam: "Exam",
    "exam-scores": "Exam marks",
    "exam-subject": "Exam subject",
    "exam-status": "Exam status",
    "exam-subject-status": "Marks submission",
  };
  const label = map[kind] || kind || "Change";
  const detail = rest.join(":");
  return { label, detail };
};

const StatusChip = ({ status }) => {
  const isConflict = status === "conflict";
  return (
    <View style={[
      styles.chip,
      { backgroundColor: isConflict ? C.conflictBg : C.failedBg },
    ]}>
      <Text style={[
        styles.chipText,
        { color: isConflict ? C.conflict : C.failed },
      ]}>
        {isConflict ? "Conflict" : "Failed"}
      </Text>
    </View>
  );
};

export default function PendingChangesScreen() {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { stats, refresh: refreshStats } = useSyncStatus({ poll: false });

  const load = useCallback(async () => {
    try {
      const list = await MutationQueue.listUnresolved();
      setRows(list);
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
      await SyncManager.syncAll({ force: true });
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
    const { label } = describe(row);
    Alert.alert(
      "Discard this change?",
      `"${label}" will be permanently removed from the upload queue. ` +
      `The change stays on this device but will never reach the server.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: async () => {
            await MutationQueue.discard(row.id);
            await load();
            await refreshStats();
          },
        },
      ]
    );
  }, [load, refreshStats]);

  const renderItem = ({ item }) => {
    const { label, detail } = describe(item);
    const attempts = item.retry_count || 0;

    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} numberOfLines={1}>{label}</Text>
          <StatusChip status={item.status} />
        </View>

        {!!detail && (
          <Text style={styles.detail} numberOfLines={1}>{detail}</Text>
        )}

        <Text style={styles.meta}>
          {item.method} {item.endpoint}
          {attempts > 0 ? `  ·  ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}
        </Text>

        {!!item.error && (
          <Text style={styles.error} numberOfLines={2}>{item.error}</Text>
        )}

        {item.status === "conflict" && (
          <Text style={styles.hint}>
            The server has a newer version of this record. Retrying will
            overwrite it with your copy.
          </Text>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => retryOne(item)}
            disabled={busy}
          >
            <Ionicons name="refresh" size={14} color="#FFF" />
            <Text style={styles.btnPrimaryText}>Retry</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={() => discardOne(item)}
            disabled={busy}
          >
            <Ionicons name="trash-outline" size={14} color={C.failed} />
            <Text style={styles.btnGhostText}>Discard</Text>
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
          title: "Pending changes",
          headerTintColor: C.text,
          headerStyle: { backgroundColor: C.card },
        }}
      />

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {stats.pending + stats.retrying} waiting
          {stats.uploads > 0 ? `  ·  ${stats.uploads} file${stats.uploads === 1 ? "" : "s"}` : ""}
          {"  ·  "}{stats.conflict} conflict{stats.conflict === 1 ? "" : "s"}
          {"  ·  "}{stats.failed} failed
        </Text>
        <TouchableOpacity onPress={runSync} disabled={busy} style={styles.syncBtn}>
          {busy
            ? <ActivityIndicator size="small" color={C.primary} />
            : <Ionicons name="sync" size={16} color={C.primary} />}
          <Text style={styles.syncBtnText}>Sync now</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.primary} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          contentContainerStyle={rows.length ? styles.list : styles.listEmpty}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={load} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={44} color={C.success} />
              <Text style={styles.emptyTitle}>Nothing stuck</Text>
              <Text style={styles.emptyText}>
                Every change on this device has either uploaded or is waiting
                its turn.
              </Text>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <Text style={styles.backBtnText}>Go back</Text>
              </TouchableOpacity>
            </View>
          }
          ListFooterComponent={
            rows.length > 1 ? (
              <TouchableOpacity
                style={styles.retryAll}
                onPress={retryAll}
                disabled={busy}
              >
                <Ionicons name="refresh-circle-outline" size={18} color={C.primary} />
                <Text style={styles.retryAllText}>Retry all {rows.length}</Text>
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
  syncBtnText: { color: C.primary, fontWeight: "700", fontSize: 13 },

  list: { padding: 14, gap: 12 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },

  card: {
    backgroundColor: C.card, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: C.border, gap: 6,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "700", color: C.text },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
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
  btnPrimaryText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
  btnGhost: { borderWidth: 1, borderColor: C.border },
  btnGhostText: { color: C.failed, fontWeight: "600", fontSize: 13 },

  retryAll: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 14,
  },
  retryAllText: { color: C.primary, fontWeight: "700" },

  empty: { alignItems: "center", padding: 32, gap: 10 },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: C.text },
  emptyText: { fontSize: 13.5, color: C.muted, textAlign: "center", lineHeight: 20 },
  backBtn: { marginTop: 10, paddingHorizontal: 20, paddingVertical: 10 },
  backBtnText: { color: C.primary, fontWeight: "700" },
});
