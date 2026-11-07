// app/sync/review.js
"use strict";

/**
 * Held changes — the review list for per-user local data (docs/40 D2/D4).
 *
 * Changes left on this phone with no evidence of whose they are, and outbox
 * rows queued before the owner was recorded, are copied in full into the
 * review store and held: nothing sends them and nothing discards them. This
 * screen shows them to everybody (as a count and a list) and lets an
 * administrator signed in on this phone decide, one at a time:
 *
 *   Give to an account  — the change goes to that account's own data on this
 *                         phone and is sent when they next sign in here
 *   Send as me          — after a confirmation that says plainly the change
 *                         will be recorded under the administrator's name
 *   Save a copy         — the full change as text, to keep or pass on
 *
 * There is no discard (D2: never drop them). Also here, for the same
 * administrator: the D3 gate for deleting the old shared data, which is only
 * ever done by pressing the button after it says it is safe.
 */

import React, { useCallback, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Share, ActivityIndicator,
} from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useAuthStore } from "../../src/store/auth.store";
import LocalData from "../../src/services/perUserData.service";
import { COLORS, ACCENT, SEMANTIC, TONE_EDGE } from "../../src/theme/colors";
import { HeaderIcon, Badge, EmptyState } from "../../src/components/Tinted";

const C = {
  bg: COLORS.page, card: COLORS.surface, border: COLORS.border, text: COLORS.text, muted: COLORS.textSecondary,
  primary: ACCENT.amber.solid, held: SEMANTIC.info.text, heldBg: SEMANTIC.info.bg,
  ok: SEMANTIC.success.text, warn: SEMANTIC.warning.text,
};

/** An item's status as a tone: held waits on a decision, assigned is on its way, placed is done. */
const STATUS_TONE = { held: "warning", assigned: "info", placed: "success" };

const STATUS_KEYS = {
  held: "localData.statusHeld",
  assigned: "localData.statusAssigned",
  placed: "localData.statusPlaced",
};

const GATE_KEYS = {
  notMigrated: "localData.gateNotMigrated",
  tooSoon: "localData.gateTooSoon",
  alreadyDeleted: "localData.gateAlreadyDeleted",
  unplaced: "localData.gateUnplaced",
  waitingOwner: "localData.gateWaitingOwner",
  uploadsPending: "localData.gateUploadsPending",
  inUse: "localData.gateInUse",
};

export default function HeldChangesScreen() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const reviewer = LocalData.canReview(user);
  const [items, setItems] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [gate, setGate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await LocalData.listReview());
      setAccounts(await LocalData.knownAccounts());
      setGate(reviewer ? await LocalData.legacyDeletionGate() : null);
    } catch (err) {
      console.warn("[review] load failed:", err?.message);
    } finally {
      setLoading(false);
    }
  }, [reviewer]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const act = useCallback(async (fn) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && res.ok === false) Alert.alert(t("localData.actionFailed"));
    } finally {
      setBusy(false);
      await load();
    }
  }, [load, t]);

  const assign = useCallback((item) => {
    const choices = accounts.slice(0, 8).map((a) => ({
      text: a.name || a.email || a.user_id,
      onPress: () => Alert.alert(
        t("localData.assignConfirmTitle"),
        t("localData.assignConfirmBody", { name: a.name || a.email || a.user_id }),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("localData.assign"), onPress: () => act(() => LocalData.assignReviewItem(item.id, a.user_id, { by: user })) },
        ]
      ),
    }));
    Alert.alert(t("localData.assignTitle"), t("localData.assignBody"), [
      ...choices,
      { text: t("common.cancel"), style: "cancel" },
    ]);
  }, [accounts, act, t, user]);

  const sendAsMe = useCallback((item) => {
    Alert.alert(t("localData.sendAsMeTitle"), t("localData.sendAsMeBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("localData.sendAsMe"),
        style: "destructive",
        onPress: () => act(() => LocalData.sendReviewItemAsMe(item.id, { by: user, confirmed: true })),
      },
    ]);
  }, [act, t, user]);

  const saveCopy = useCallback(async (item) => {
    const text = await LocalData.exportReviewItem(item.id);
    if (text) await Share.share({ message: text }).catch(() => {});
  }, []);

  const deleteLegacy = useCallback(() => {
    Alert.alert(t("localData.deleteLegacyTitle"), t("localData.deleteLegacyBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("localData.deleteLegacy"), style: "destructive", onPress: () => act(() => LocalData.deleteLegacyFile({ by: user })) },
    ]);
  }, [act, t, user]);

  const renderItem = ({ item }) => {
    const tone = STATUS_TONE[item.status] ?? "warning";
    return (
      <View style={[styles.card, { backgroundColor: SEMANTIC[tone].bg, borderLeftColor: TONE_EDGE[tone] }]}>
        <View style={styles.head}>
          <Ionicons name={item.kind === "outbox" ? "cloud-upload-outline" : "create-outline"} size={16} color={SEMANTIC[tone].text} />
          <Text style={styles.title} numberOfLines={2}>{item.summary || item.row_id}</Text>
          <Badge tone={tone} label={t(STATUS_KEYS[item.status] ?? "localData.statusHeld")} textStyle={styles.status} />
        </View>
        <Text style={styles.meta}>{item.tbl} · {item.row_id}</Text>
        <Text style={styles.meta}>{t("localData.heldSince", { date: String(item.created_at ?? "").slice(0, 10) })}</Text>
        {reviewer && item.status === "held" ? (
          <View style={styles.actions}>
            <TouchableOpacity style={styles.btn} disabled={busy || !accounts.length} onPress={() => assign(item)}>
              <Text style={styles.btnText}>{t("localData.assign")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} disabled={busy} onPress={() => sendAsMe(item)}>
              <Text style={styles.btnText}>{t("localData.sendAsMe")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} disabled={busy} onPress={() => saveCopy(item)}>
              <Text style={styles.btnText}>{t("localData.saveCopy")}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: true, title: t("localData.reviewTitle"), headerTintColor: C.text, headerStyle: { backgroundColor: C.card } }} />
      <View style={[styles.intro, styles.introRow]}>
        <HeaderIcon size={28} style={styles.headerIcon} />
        <View style={styles.introBody}>
          <Text style={styles.introText}>{t("localData.reviewIntro")}</Text>
          {!reviewer ? <Text style={styles.introText}>{t("localData.reviewAdminOnly")}</Text> : null}
        </View>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.primary} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState icon="checkmark-circle-outline" accent="green" message={t("localData.reviewEmpty")} />}
          ListFooterComponent={reviewer && gate ? (
            <View style={styles.gate}>
              <Text style={styles.gateTitle}>{t("localData.legacyTitle")}</Text>
              {gate.ok
                ? <Text style={styles.gateOk}>{t("localData.gateOk")}</Text>
                : gate.reasons.map((r) => (
                    <Text key={r} style={styles.gateReason}>• {t(GATE_KEYS[r] ?? "localData.gateUnplaced", { days: gate.days ?? 0 })}</Text>
                  ))}
              <TouchableOpacity style={[styles.btn, !gate.ok && styles.disabled]} disabled={!gate.ok || busy} onPress={deleteLegacy}>
                <Text style={styles.btnText}>{t("localData.deleteLegacy")}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  intro: { padding: 14, gap: 6, backgroundColor: C.heldBg },
  introRow: { flexDirection: "row", alignItems: "flex-start", gap: 0 },
  introBody: { flex: 1, gap: 6 },
  headerIcon: { marginRight: 10 },
  introText: { fontSize: 13, color: C.held, lineHeight: 19 },
  list: { padding: 14, gap: 12 },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, borderLeftWidth: 3, gap: 4 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: "700", color: C.text },
  status: { fontSize: 11, fontWeight: "700" },
  meta: { fontSize: 11.5, color: C.muted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  btn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: ACCENT.amber.base, backgroundColor: COLORS.surface },
  btnText: { color: ACCENT.amber.deep, fontWeight: "600", fontSize: 13 },
  disabled: { opacity: 0.45 },
  gate: { marginTop: 18, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: ACCENT.amber.wash, borderTopWidth: 3, borderTopColor: ACCENT.amber.base, gap: 6 },
  gateTitle: { fontSize: 14, fontWeight: "700", color: C.text },
  gateOk: { fontSize: 13, color: C.ok },
  gateReason: { fontSize: 13, color: C.warn },
});
