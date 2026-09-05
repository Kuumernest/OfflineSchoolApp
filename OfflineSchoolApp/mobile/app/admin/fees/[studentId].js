// app/admin/fees/[studentId].js
//
// One student's ledger, and the form that takes cash.
//
// Everything here works with no signal. The payment is written locally and
// queued; the receipt number arrives later, from the server, and the row shows
// "pending" until it does. The phone never invents a receipt number — two
// devices offline would both mint the same one.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, StatusBar,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import FeeService         from "../../../src/services/fee.service";
import { getStudentById } from "../../../src/services/student.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatDateShort } from "../../../src/i18n/format";
import { useAuthStore }   from "../../../src/store/auth.store";
import { errorText } from "../../../src/utils/appError";

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

export default function StudentFeeScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const { studentId, year } = useLocalSearchParams();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [student, setStudent] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  const [amount,    setAmount]    = useState("");
  const [method,    setMethod]    = useState("cash");
  const [reference, setReference] = useState("");

  const academicYear = String(year || "");

  const load = useCallback(async () => {
    try {
      const [s, acct] = await Promise.all([
        getStudentById(String(studentId)).catch(() => null),
        FeeService.getStudentAccount(String(studentId), academicYear),
      ]);
      setStudent(s);
      setAccount(acct);
    } catch (err) {
      console.warn("[fees] account load failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [studentId, academicYear]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    // Whole francs only. Checking here means the bursar is told before they
    // hand back change, not after the server rejects it.
    const value = Number(amount);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      Alert.alert(t("fees.amount"), t("fees.amountHint"));
      return;
    }

    setSaving(true);
    try {
      await FeeService.recordPayment({
        schoolId,
        studentId:    String(studentId),
        academicYear,
        amount:       value,
        method,
        reference:    reference.trim() || null,
      });
      setAmount("");
      setReference("");
      await load();
      // Deliberately not "sent" — it is recorded here and will sync later.
      Alert.alert(t("fees.recorded"), t("fees.recordedOffline"));
    } catch (err) {
      Alert.alert(t("fees.recordFailed"), errorText(t, err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  const totals  = account?.totals ?? { charged: 0, waived: 0, paid: 0, balance: 0 };
  const owes    = totals.balance > 0;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior="padding"
    >
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {student?.name || t("academic.student")}
          </Text>
          <Text style={styles.subtitle}>
            {student?.enrollmentNo || "—"} · {academicYear}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Balance first — the reason anyone opens this screen. */}
        <View style={[styles.balanceCard, owes ? styles.balanceOwes : styles.balanceClear]}>
          <Text style={styles.balanceLabel}>{t("fees.balance")}</Text>
          <Text style={[styles.balanceValue, { color: owes ? C.danger : C.success }]}>
            {formatMoney(totals.balance)}
          </Text>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceMeta}>
              {t("fees.charged")} {formatMoney(totals.charged)}
            </Text>
            <Text style={styles.balanceMeta}>
              {t("fees.paid")} {formatMoney(totals.paid)}
            </Text>
          </View>
        </View>

        {account?.pending > 0 && (
          <View style={styles.pendingBanner}>
            <Ionicons name="cloud-upload-outline" size={15} color={C.warning} />
            <Text style={styles.pendingText}>
              {t("fees.pendingSync", { count: account.pending })}
            </Text>
          </View>
        )}

        {/* Take a payment */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("fees.recordPayment")}</Text>

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

          <Text style={styles.label}>{t("fees.method")}</Text>
          <View style={styles.methods}>
            {METHODS.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.method, method === m && styles.methodOn]}
                onPress={() => setMethod(m)}
                activeOpacity={0.8}
              >
                <Text style={[styles.methodText, method === m && styles.methodTextOn]}>
                  {t(`method.${m}`)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>{t("fees.reference")}</Text>
          <TextInput
            style={styles.input}
            value={reference}
            onChangeText={setReference}
            placeholder="MOMO-…"
            placeholderTextColor={C.inkFaint}
            autoCapitalize="characters"
          />

          <TouchableOpacity
            style={[styles.submit, (!amount || saving) && styles.submitOff]}
            onPress={submit}
            disabled={!amount || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>{t("fees.recordPayment")}</Text>}
          </TouchableOpacity>
        </View>

        {/* Charges */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("fees.charges")}</Text>
          {(account?.charges?.length ?? 0) === 0 ? (
            <Text style={styles.empty}>{t("fees.noCharges")}</Text>
          ) : (
            account.charges.map((c) => (
              <View key={c._id} style={styles.line}>
                <Text style={styles.lineLabel} numberOfLines={1}>{c.label}</Text>
                <Text style={styles.lineAmount}>{formatMoney(c.amount)}</Text>
              </View>
            ))
          )}
        </View>

        {/* Payments */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t("fees.payments")}</Text>
          {(account?.payments?.length ?? 0) === 0 ? (
            <Text style={styles.empty}>{t("fees.noPayments")}</Text>
          ) : (
            account.payments.map((p) => (
              <View key={p._id} style={styles.line}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.lineLabel} numberOfLines={1}>
                    {/* No receipt number yet means the server has not seen it. */}
                    {p.receiptNo || t("fees.pendingReceipt")}
                  </Text>
                  <Text style={styles.lineMeta}>
                    {formatDateShort(p.receivedAt)} · {t(`method.${p.method}`)}
                  </Text>
                </View>
                {!p.isSynced && (
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
                    p.amount < 0 && { color: C.danger },
                  ]}
                >
                  {formatMoney(p.amount)}
                </Text>
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

  balanceCard: { borderRadius: 12, borderWidth: 1, padding: 16 },
  balanceOwes:  { backgroundColor: C.dangerBg,  borderColor: "#F2D3CF" },
  balanceClear: { backgroundColor: C.successBg, borderColor: "#C3E2D0" },
  balanceLabel: { fontSize: 11, fontWeight: "600", color: C.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
  balanceValue: { marginTop: 6, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  balanceRow:   { flexDirection: "row", gap: 16, marginTop: 8 },
  balanceMeta:  { fontSize: 11, color: C.inkMuted, fontVariant: ["tabular-nums"] },

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

  methods: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  method: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
  },
  methodOn:      { backgroundColor: C.primary, borderColor: C.primary },
  methodText:    { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  methodTextOn:  { color: "#fff" },

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
  lineLabel:  { flex: 1, fontSize: 13, color: C.inkBody },
  lineMeta:   { marginTop: 2, fontSize: 11, color: C.inkFaint },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },
  empty:      { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },
});
