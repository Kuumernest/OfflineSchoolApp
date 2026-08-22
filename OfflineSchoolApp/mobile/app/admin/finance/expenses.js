// app/admin/finance/expenses.js
//
// Record what the school spends, with or without a signal.
//
// The mirror of fee collection: someone pays a supplier with the receipt in
// hand and no network. The row is written locally and queued, and shows a
// pending marker until the server has it. A mistake the server already has is
// voided with a reason — never deleted — so the ledger still reads honestly;
// one it has not seen yet is removed outright, because a record the server has
// never heard of cannot be voided.
//
// Categories are read-only here. Creating one is a rare setup act with a
// uniqueness rule the server owns, so it lives in the web console.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, RefreshControl, KeyboardAvoidingView,
  Platform, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import ExpenseService     from "../../../src/services/expense.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatDateShort } from "../../../src/i18n/format";
import { useAuthStore }   from "../../../src/store/auth.store";

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
  danger:    "#9F2318",
  dangerBg:  "#FDF2F1",
  success:   "#12683A",
  successBg: "#EEF7F1",
  warning:   "#96570B",
  warningBg: "#FDF6EC",
  ink:       "#0D1220",
  inkBody:   "#343D4F",
  inkMuted:  "#4F5A70",
  inkFaint:  "#666F84",
  line:      "#E9EBF0",
  surface:   "#FFFFFF",
  canvas:    "#F4F5F8",
};

const METHODS = ["cash", "mobile_money", "bank", "cheque"];

export default function ExpensesScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses]     = useState([]);
  const [total, setTotal]           = useState(0);
  const [pending, setPending]       = useState(0);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving]         = useState(false);

  const [categoryId, setCategoryId]   = useState("");
  const [amount, setAmount]           = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor]           = useState("");
  const [method, setMethod]           = useState("cash");

  /** Reads local only, so the screen opens with no signal. */
  const loadLocal = useCallback(async () => {
    const [cats, list] = await Promise.all([
      ExpenseService.listCategories(),
      ExpenseService.listExpenses(),
    ]);
    setCategories(cats);
    setExpenses(list.expenses);
    setTotal(list.total);
    setPending(list.pending);
    // Only preselect when nothing is chosen — reselecting on every refresh
    // would yank the picker out from under someone mid-entry.
    setCategoryId((current) => current || cats[0]?._id || "");
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadLocal();
        // Best effort. Offline is the expected case, not an error worth showing.
        await ExpenseService.pullExpenses({ schoolId }).catch(() => {});
        await loadLocal();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadLocal, schoolId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await ExpenseService.pullExpenses({ schoolId }).catch(() => {});
      await loadLocal();
    } finally {
      setRefreshing(false);
    }
  }, [loadLocal, schoolId]);

  const submit = async () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0) {
      Alert.alert(t("fees.amount"), t("fees.amountHint"));
      return;
    }
    setSaving(true);
    try {
      await ExpenseService.recordExpense({
        schoolId,
        categoryId,
        amount: value,
        description: description.trim() || null,
        vendor: vendor.trim() || null,
        method,
      });
      setAmount("");
      setDescription("");
      setVendor("");
      await loadLocal();
    } catch (err) {
      Alert.alert(t("expenses.record"), err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Undo — but which undo depends on whether the server has the row.
   *
   * A row still waiting to sync is removed outright: voiding something the
   * server has never heard of would send a void that arrives before its own
   * create and gets dropped, leaving the phone and the server disagreeing about
   * money. A row the server already has is voided with a reason, the normal way.
   */
  const askUndo = (expense) => {
    const unsent = !expense.isSynced;

    Alert.alert(
      unsent ? t("expenses.cancelTitle") : t("expenses.voidTitle"),
      unsent ? t("expenses.cancelBody")  : t("expenses.voidBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: unsent ? t("expenses.cancelAction") : t("expenses.void"),
          style: "destructive",
          onPress: async () => {
            try {
              if (unsent) {
                const { cancelled } = await ExpenseService.cancelUnsentExpense({
                  id: expense._id,
                });
                // It synced between the tap and the confirm. Falling through to
                // a void is what the row now needs.
                if (!cancelled) {
                  Alert.alert(t("expenses.cancelTitle"), t("expenses.cancelTooLate"));
                  await loadLocal();
                  return;
                }
              } else {
                await ExpenseService.voidExpense({
                  schoolId,
                  id: expense._id,
                  reason: t("expenses.voidTitle"),
                });
              }
              await loadLocal();
            } catch (err) {
              Alert.alert(t("expenses.void"), err?.message ?? String(err));
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  const labelFor = (id) =>
    categories.find((c) => c._id === id)?.label ?? "—";

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("expenses.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{t("expenses.blurb")}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.primary} />
        }
      >
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>{t("expenses.totalSpent")}</Text>
          <Text style={styles.totalValue}>{formatMoney(total)}</Text>
        </View>

        {pending > 0 && (
          <View style={styles.pendingBanner}>
            <Ionicons name="cloud-upload-outline" size={15} color={C.warning} />
            <Text style={styles.pendingText}>
              {t("fees.pendingSync", { count: pending })}
            </Text>
          </View>
        )}

        {/* Record */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("expenses.record")}</Text>

          {categories.length === 0 ? (
            <Text style={styles.empty}>{t("expenses.noCategories")}</Text>
          ) : (
            <>
              <Text style={styles.label}>{t("expenses.category")}</Text>
              <View style={styles.chips}>
                {categories.map((c) => (
                  <TouchableOpacity
                    key={c._id}
                    style={[styles.chip, categoryId === c._id && styles.chipOn]}
                    onPress={() => setCategoryId(c._id)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.chipText, categoryId === c._id && styles.chipTextOn]}
                    >
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>{t("fees.amount")}</Text>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={setAmount}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={C.inkFaint}
              />
              <Text style={styles.hint}>{t("fees.amountHint")}</Text>

              <Text style={styles.label}>{t("common.description")}</Text>
              <TextInput
                style={styles.input}
                value={description}
                onChangeText={setDescription}
                placeholderTextColor={C.inkFaint}
              />

              <Text style={styles.label}>{t("expenses.vendor")}</Text>
              <TextInput
                style={styles.input}
                value={vendor}
                onChangeText={setVendor}
                placeholderTextColor={C.inkFaint}
              />

              <Text style={styles.label}>{t("fees.method")}</Text>
              <View style={styles.chips}>
                {METHODS.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.chip, method === m && styles.chipOn]}
                    onPress={() => setMethod(m)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.chipText, method === m && styles.chipTextOn]}>
                      {t(`method.${m}`)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                style={[styles.submit, (!amount || !categoryId || saving) && styles.submitOff]}
                onPress={submit}
                disabled={!amount || !categoryId || saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitText}>{t("expenses.record")}</Text>}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Ledger */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("expenses.title")}</Text>
          {expenses.length === 0 ? (
            <Text style={styles.empty}>{t("expenses.none")}</Text>
          ) : (
            expenses.map((e) => (
              <View key={e._id} style={styles.line}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.lineLabel} numberOfLines={1}>
                    {e.description || labelFor(e.categoryId)}
                  </Text>
                  <Text style={styles.lineMeta} numberOfLines={1}>
                    {formatDateShort(e.incurredAt)} · {labelFor(e.categoryId)}
                    {e.vendor ? ` · ${e.vendor}` : ""}
                  </Text>
                </View>

                {!e.isSynced && (
                  <Ionicons
                    name="cloud-upload-outline"
                    size={14}
                    color={C.warning}
                    style={{ marginRight: 6 }}
                  />
                )}

                <Text
                  style={[
                    styles.lineAmount,
                    e.voidedAt && styles.lineAmountVoid,
                  ]}
                >
                  {formatMoney(e.amount)}
                </Text>

                {e.voidedAt ? (
                  <Text style={styles.voidTag}>{t("expenses.voided")}</Text>
                ) : (
                  <TouchableOpacity onPress={() => askUndo(e)} hitSlop={8}>
                    <Ionicons
                      name={e.isSynced ? "ban-outline" : "trash-outline"}
                      size={16}
                      color={C.inkFaint}
                    />
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  totalCard: {
    borderRadius: 12, borderWidth: 1, padding: 16,
    backgroundColor: C.surface, borderColor: C.line,
  },
  totalLabel: {
    fontSize: 11, fontWeight: "600", color: C.inkMuted,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  totalValue: {
    marginTop: 6, fontSize: 30, fontWeight: "700", color: C.ink,
    fontVariant: ["tabular-nums"],
  },

  pendingBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: "#F0DCBB",
  },
  pendingText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 10 },

  label: { fontSize: 12, fontWeight: "600", color: C.inkBody, marginBottom: 5, marginTop: 8 },
  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: "#D5D9E2",
    paddingHorizontal: 12, fontSize: 15, color: C.ink, backgroundColor: C.surface,
  },
  hint: { marginTop: 4, fontSize: 11, color: C.inkFaint },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
  },
  chipOn:     { backgroundColor: C.primary, borderColor: C.primary },
  chipText:   { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  chipTextOn: { color: "#fff" },

  submit: {
    marginTop: 16, height: 46, borderRadius: 10, backgroundColor: C.primary,
    alignItems: "center", justifyContent: "center",
  },
  submitOff:  { opacity: 0.45 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  line: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  lineLabel:  { fontSize: 13, color: C.inkBody },
  lineMeta:   { marginTop: 2, fontSize: 11, color: C.inkFaint },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },
  lineAmountVoid: {
    color: C.inkFaint, textDecorationLine: "line-through",
  },
  voidTag: { fontSize: 10, fontWeight: "600", color: C.inkFaint, textTransform: "uppercase" },
  empty:   { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },
});
