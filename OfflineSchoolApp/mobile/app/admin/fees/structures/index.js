// app/admin/fees/structures/index.js
//
// What the school charges.
//
// Reads the local mirror, so it opens with no signal — which is the whole
// point: this list did not exist on the phone at all, because the phone syncs
// through /sync/pull (six collections) while the desktop syncs through
// /sync/changes (thirty-six, fee structures among them). A structure written in
// the office reached the desktop and never the bursar walking the yard.
//
// Applying is queued like every other write here. That is safe rather than
// merely convenient: the server holds a unique index on
// (studentId, structureId, code, term), so a replayed apply raises nothing and
// reports what it skipped. Two phones applying the same structure bill each
// pupil once.

import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar, Switch, Alert,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import FeeStructureService from "../../../../src/services/feeStructure.service";
import { useAuthStore }    from "../../../../src/store/auth.store";
import { useTranslation }  from "../../../../src/i18n/useTranslation";
import { errorText }       from "../../../../src/utils/appError";

const BRAND = "#4F46E5";

const money = (n) => `${Number(n ?? 0).toLocaleString("fr-FR")} XAF`;

const StructureCard = ({ s, onToggle, onApply, t }) => {
  const total = (s.items ?? []).reduce(
    (sum, i) => sum + (i.isOptional ? 0 : Number(i.amount) || 0),
    0
  );

  return (
    <View style={[st.card, !s.isActive && st.cardOff]}>
      <View style={st.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={st.cardTitle} numberOfLines={1}>
            {s.academicYear}
            {s.term ? ` · ${s.term}` : ""}
          </Text>
          <Text style={st.cardSub} numberOfLines={1}>
            {(s.classIds?.length ?? 0) === 0
              ? t("feeStructures.wholeSchool")
              : t("feeStructures.classCount", { count: s.classIds.length })}
          </Text>
        </View>

        {/* A structure this device made that has not reached the server yet.
            Shown so nobody types it a second time while offline. */}
        {s.pending && (
          <View style={st.pendingPill}>
            <Ionicons name="time-outline" size={12} color="#96570B" />
            <Text style={st.pendingText}>{t("feeStructures.pending")}</Text>
          </View>
        )}

        <Switch
          value={s.isActive}
          onValueChange={(v) => onToggle(s, v)}
          trackColor={{ true: "#C7D2FE", false: "#E5E7EB" }}
          thumbColor={s.isActive ? BRAND : "#9CA3AF"}
        />
      </View>

      {(s.items ?? []).map((i, idx) => (
        <View key={`${i.code}-${idx}`} style={st.itemRow}>
          <Text style={st.itemLabel} numberOfLines={1}>
            {i.label}
            {i.isOptional ? ` · ${t("feeStructures.optional")}` : ""}
          </Text>
          <Text style={st.itemAmount}>{money(i.amount)}</Text>
        </View>
      ))}

      <View style={st.cardFoot}>
        <Text style={st.totalLabel}>{t("feeStructures.compulsoryTotal")}</Text>
        <Text style={st.totalAmount}>{money(total)}</Text>
      </View>

      {s.dueDate ? (
        <Text style={st.due}>{t("feeStructures.due", { date: s.dueDate })}</Text>
      ) : null}

      <TouchableOpacity
        style={[st.applyBtn, !s.isActive && st.applyBtnOff]}
        onPress={() => onApply(s)}
        disabled={!s.isActive}
        activeOpacity={0.8}
      >
        <Ionicons name="receipt-outline" size={15} color={s.isActive ? "#FFF" : "#9CA3AF"} />
        <Text style={[st.applyText, !s.isActive && st.applyTextOff]}>
          {t("feeStructures.apply")}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

export default function FeeStructuresScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId) ?? "";

  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await FeeStructureService.listLocal(schoolId));
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err));
    } finally {
      setLoading(false);
    }
  }, [schoolId, t]);

  // On focus, not on mount: coming back from the create screen must show the
  // row that was just made.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await FeeStructureService.syncFromServer(schoolId);
    } catch {
      // Offline is the normal case here; the mirror below is still shown.
    } finally {
      await load();
      setBusy(false);
    }
  }, [schoolId, load]);

  const onToggle = useCallback(async (s, next) => {
    try {
      await FeeStructureService.setActive(s._id, next);
      await load();
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err));
    }
  }, [load, t]);

  const onApply = useCallback((s) => {
    Alert.alert(
      t("feeStructures.applyTitle"),
      t("feeStructures.applyBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("feeStructures.apply"),
          onPress: async () => {
            try {
              await FeeStructureService.apply(s._id);
              // Queued, not done. Saying "charges raised" here would be a
              // claim about a request that has not left the device.
              Alert.alert(t("feeStructures.applyTitle"), t("feeStructures.applyQueued"));
            } catch (err) {
              Alert.alert(t("common.error"), errorText(t, err));
            }
          },
        },
      ]
    );
  }, [t]);

  if (loading) {
    return (
      <View style={st.centered}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  return (
    <View style={st.screen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" translucent={false} />

      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={st.headerCenter}>
          <Text style={st.headerTitle}>{t("feeStructures.title")}</Text>
          <Text style={st.headerSub}>{t("feeStructures.subtitle")}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/admin/fees/structures/new")}
          style={st.addBtn}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(s) => s._id}
        contentContainerStyle={rows.length ? st.list : st.listEmpty}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={BRAND} />}
        renderItem={({ item }) => (
          <StructureCard s={item} onToggle={onToggle} onApply={onApply} t={t} />
        )}
        ListEmptyComponent={
          <View style={st.empty}>
            <Ionicons name="document-text-outline" size={40} color="#D1D5DB" />
            <Text style={st.emptyTitle}>{t("feeStructures.none")}</Text>
            <Text style={st.emptyBody}>{t("feeStructures.noneHint")}</Text>
          </View>
        }
      />
    </View>
  );
}

const st = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#F9FAFB" },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingTop: 60, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
  },
  backBtn:     { padding: 4 },
  headerCenter:{ flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#6B7280", marginTop: 2 },
  addBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: BRAND,
    alignItems: "center", justifyContent: "center",
  },

  list:      { padding: 16, gap: 12 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },

  card: {
    backgroundColor: "#FFF", borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: "#E5E7EB", gap: 8,
  },
  cardOff:   { opacity: 0.6 },
  cardHead:  { flexDirection: "row", alignItems: "center", gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardSub:   { fontSize: 12, color: "#6B7280", marginTop: 2 },

  pendingPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#FDF6EC", borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  pendingText: { fontSize: 11, color: "#96570B", fontWeight: "600" },

  itemRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", gap: 12,
  },
  itemLabel:  { flex: 1, fontSize: 13, color: "#374151" },
  itemAmount: { fontSize: 13, color: "#374151", fontVariant: ["tabular-nums"] },

  cardFoot: {
    flexDirection: "row", justifyContent: "space-between",
    borderTopWidth: 1, borderTopColor: "#F3F4F6", paddingTop: 8, marginTop: 2,
  },
  totalLabel:  { fontSize: 12, color: "#6B7280", fontWeight: "600" },
  totalAmount: { fontSize: 15, fontWeight: "800", color: "#111827", fontVariant: ["tabular-nums"] },

  due: { fontSize: 12, color: "#6B7280" },

  applyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: BRAND, borderRadius: 10, paddingVertical: 11, marginTop: 4,
  },
  applyBtnOff:  { backgroundColor: "#F3F4F6" },
  applyText:    { color: "#FFF", fontWeight: "700", fontSize: 14 },
  applyTextOff: { color: "#9CA3AF" },

  empty:      { alignItems: "center", gap: 8, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptyBody:  { fontSize: 13, color: "#6B7280", textAlign: "center" },
});
