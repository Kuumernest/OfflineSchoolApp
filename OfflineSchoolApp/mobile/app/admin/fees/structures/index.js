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
import { COLORS, ACCENT, termAccent, statusBadge } from "../../../../src/theme/colors";
import { HeaderIcon, IconSquare, Badge, EmptyState } from "../../../../src/components/Tinted";

const BRAND = ACCENT.teal.solid;
const PENDING = statusBadge("warning");

const money = (n) => `${Number(n ?? 0).toLocaleString("fr-FR")} XAF`;

const StructureCard = ({ s, onToggle, onApply, t }) => {
  const total = (s.items ?? []).reduce(
    (sum, i) => sum + (i.isOptional ? 0 : Number(i.amount) || 0),
    0
  );

  const accent = termAccent(s.term);
  const a = ACCENT[accent];

  return (
    <View
      style={[
        st.card,
        { backgroundColor: a.wash, borderTopWidth: 3, borderTopColor: a.base },
        !s.isActive && st.cardOff,
      ]}
    >
      <View style={st.cardHead}>
        <IconSquare icon="wallet" accent={accent} size={36} />
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
            <Ionicons name="time-outline" size={12} color={PENDING.text} />
            <Text style={st.pendingText}>{t("feeStructures.pending")}</Text>
          </View>
        )}

        {!s.isActive && <Badge label={t("common.inactive")} tone="error" />}

        <Switch
          value={s.isActive}
          onValueChange={(v) => onToggle(s, v)}
          trackColor={{ true: a.base + "66", false: COLORS.border }}
          thumbColor={s.isActive ? a.solid : COLORS.textMuted}
        />
      </View>

      {(s.items ?? []).map((i, idx) => (
        <View key={`${i.code}-${idx}`} style={st.itemRow}>
          <Text style={st.itemLabel} numberOfLines={1}>
            {i.label}
          </Text>
          {i.isOptional ? <Badge label={t("feeStructures.optional")} tone="info" /> : null}
          <Text style={st.itemAmount}>{money(i.amount)}</Text>
        </View>
      ))}

      <View style={st.cardFoot}>
        <Text style={st.totalLabel}>{t("feeStructures.compulsoryTotal")}</Text>
        <Text style={[st.totalAmount, { color: a.deep }]}>{money(total)}</Text>
      </View>

      {s.dueDate ? (
        <Text style={st.due}>{t("feeStructures.due", { date: s.dueDate })}</Text>
      ) : null}

      <TouchableOpacity
        style={[st.applyBtn, { backgroundColor: a.solid }, !s.isActive && st.applyBtnOff]}
        onPress={() => onApply(s)}
        disabled={!s.isActive}
        activeOpacity={0.8}
      >
        <Ionicons name="receipt-outline" size={15} color={s.isActive ? COLORS.onPrimary : COLORS.textSecondary} />
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
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} translucent={false} />

      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={st.headerIcon} />
        <View style={st.headerCenter}>
          <Text style={st.headerTitle}>{t("feeStructures.title")}</Text>
          <Text style={st.headerSub}>{t("feeStructures.subtitle")}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/admin/fees/structures/new")}
          style={st.addBtn}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={22} color={COLORS.onPrimary} />
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
          <EmptyState
            icon="document-text-outline"
            accent="teal"
            title={t("feeStructures.none")}
            message={t("feeStructures.noneHint")}
            style={st.empty}
          />
        }
      />
    </View>
  );
}

const st = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: COLORS.page },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.page },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingTop: 60, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn:     { padding: 4 },
  headerIcon:  { marginRight: 0 },
  headerCenter:{ flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  addBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: BRAND,
    alignItems: "center", justifyContent: "center",
  },

  list:      { padding: 16, gap: 12 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: COLORS.border, gap: 8,
  },
  cardOff:   { opacity: 0.6 },
  cardHead:  { flexDirection: "row", alignItems: "center", gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: COLORS.text },
  cardSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },

  pendingPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: PENDING.bg, borderRadius: 999, borderWidth: 1, borderColor: PENDING.border,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  pendingText: { fontSize: 11, color: PENDING.text, fontWeight: "600" },

  itemRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", gap: 12,
  },
  itemLabel:  { flex: 1, fontSize: 13, color: COLORS.text },
  itemAmount: { fontSize: 13, color: COLORS.text, fontVariant: ["tabular-nums"] },

  cardFoot: {
    flexDirection: "row", justifyContent: "space-between",
    borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 8, marginTop: 2,
  },
  totalLabel:  { fontSize: 12, color: COLORS.textSecondary, fontWeight: "600" },
  totalAmount: { fontSize: 15, fontWeight: "800", color: COLORS.text, fontVariant: ["tabular-nums"] },

  due: { fontSize: 12, color: COLORS.textSecondary },

  applyBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: BRAND, borderRadius: 10, paddingVertical: 11, marginTop: 4,
  },
  applyBtnOff:  { backgroundColor: COLORS.border },
  applyText:    { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
  applyTextOff: { color: COLORS.textSecondary },

  empty:      { padding: 32 },
});
