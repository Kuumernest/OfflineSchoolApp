// app/admin/fees/[studentId].js
//
// One student's ledger, and the form that takes cash.
//
// Everything here works with no signal. The payment is written locally and
// queued; the receipt number arrives later, from the server, and the row shows
// "pending" until it does. The phone never invents a receipt number — two
// devices offline would both mint the same one.
//
// The parent still leaves with paper: a payment not yet confirmed prints a
// PROVISIONAL receipt (receipt.service.js), identified by a provisional
// reference from the payment id; once confirmed, the server's official one.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, StatusBar,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import FeeService         from "../../../src/services/fee.service";
import ReceiptService     from "../../../src/services/receipt.service";
import DocumentService    from "../../../src/services/document.service";
import { getStudentById } from "../../../src/services/student.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatDateShort } from "../../../src/i18n/format";
import { useAuthStore }   from "../../../src/store/auth.store";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const C = {
  primary:   ACCENT.teal.solid,
  primaryBg: ACCENT.teal.wash,
  danger:    SEMANTIC.error.text,
  dangerBg:  SEMANTIC.error.bg,
  success:   SEMANTIC.success.text,
  successBg: SEMANTIC.success.bg,
  warning:   SEMANTIC.warning.text,
  warningBg: SEMANTIC.warning.bg,
  ink:       COLORS.text,
  inkBody:   COLORS.text,
  inkMuted:  COLORS.textSecondary,
  inkFaint:  COLORS.textSubtle,
  line:      COLORS.border,
  surface:   COLORS.surface,
  canvas:    COLORS.page,
};

const METHODS = ["cash", "mobile_money", "bank", "cheque"];

export default function StudentFeeScreen() {
  const router   = useRouter();
  const { t, locale } = useTranslation();
  const { studentId, year } = useLocalSearchParams();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [student, setStudent] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [printing, setPrinting] = useState(null);

  const [amount,    setAmount]    = useState("");
  const [method,    setMethod]    = useState("cash");
  const [reference, setReference] = useState("");

  const academicYear = String(year || "");

  const load = useCallback(async () => {
    try {
      /*
       * Fetch the school's own figures, THEN read the mirror.
       *
       * getStudentAccount reads only the local SQLite tables, and nothing was
       * filling them: FeeService.pullStudentAccount existed, exported, written
       * for exactly this, and had no call site anywhere in the app. So this
       * screen showed a balance of zero, "Nothing billed yet" and "No payments
       * recorded" for a pupil whose charges and payments were sitting on the
       * server — and a bursar could have recorded a second payment against a
       * bill that looked unpaid.
       *
       * The mirror stays the thing rendered, which is what makes the screen
       * work with no signal and what lets a payment queued on this device show
       * up before it has synced. pullStudentAccount already respects that: it
       * refuses to overwrite any payment row still marked unsynced.
       *
       * The pull is allowed to fail. Offline, the mirror is all there is, and
       * showing yesterday's copy beats showing nothing.
       */
      if (schoolId) {
        await FeeService.pullStudentAccount({
          schoolId, studentId: String(studentId), academicYear,
        }).catch((err) => {
          console.warn("[fees] account not refreshed:", err.message);
        });
      }

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
  }, [studentId, academicYear, schoolId]);

  useEffect(() => { load(); }, [load]);

  /** Print or share one payment's receipt — provisional until it has synced. */
  const sendReceipt = async (paymentId, mode) => {
    setPrinting(paymentId);
    try {
      const { html, provisional, stale } = await ReceiptService.getReceiptForPrint({
        paymentId, schoolId, lang: locale,
      });
      if (mode === "print") await DocumentService.printDocument(html);
      else {
        await DocumentService.shareDocument(
          html, provisional ? t("fees.provisionalReceipt") : t("fees.receipt"),
        );
      }
      if (stale) Alert.alert(t("fees.receipt"), t("doc.offline"));
    } catch (err) {
      Alert.alert(t("fees.receipt"), errorText(t, err) || String(err));
    } finally {
      setPrinting(null);
    }
  };

  /** Ask how, and say first when the paper will be provisional. */
  const offerReceipt = (p) => {
    const provisional = !p.isSynced;
    Alert.alert(
      provisional ? t("fees.provisionalReceipt") : t("fees.receipt"),
      provisional ? t("fees.provisionalReceiptHint") : undefined,
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("doc.share"), onPress: () => sendReceipt(p._id, "share") },
        { text: t("common.print"), onPress: () => sendReceipt(p._id, "print") },
      ],
    );
  };

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
      const recorded = await FeeService.recordPayment({
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
      // A receipt can be handed over now: provisional, clearly marked.
      Alert.alert(t("fees.recorded"), t("fees.recordedOffline"), [
        { text: t("common.ok") },
        {
          text: t("fees.printProvisional"),
          onPress: () => offerReceipt({ _id: recorded.id, isSynced: false }),
        },
      ]);
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
        <HeaderIcon style={styles.headerIcon} />
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
            <Text style={[styles.balanceMeta, { color: C.success }]}>
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
          <View style={styles.cardHead}>
            <IconSquare icon="cash" accent="teal" size={28} />
            <Text style={[styles.cardTitle, styles.cardTitleInHead]}>{t("fees.recordPayment")}</Text>
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
              ? <ActivityIndicator color={COLORS.onPrimary} />
              : <Text style={styles.submitText}>{t("fees.recordPayment")}</Text>}
          </TouchableOpacity>
        </View>

        {/* Charges */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <IconSquare icon="receipt" accent="teal" size={28} />
            <Text style={[styles.cardTitle, styles.cardTitleInHead]}>{t("fees.charges")}</Text>
          </View>
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
          <View style={styles.cardHead}>
            <IconSquare icon="wallet" accent="teal" size={28} />
            <Text style={[styles.cardTitle, styles.cardTitleInHead]}>{t("fees.payments")}</Text>
          </View>
          {(account?.payments?.length ?? 0) === 0 ? (
            <Text style={styles.empty}>{t("fees.noPayments")}</Text>
          ) : (
            account.payments.map((p) => (
              <View key={p._id} style={[styles.line, styles.paymentLine]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.lineLabel} numberOfLines={1}>
                    {/* No receipt number yet means the server has not seen it. */}
                    {p.receiptNo || t("fees.pendingReceipt")}
                  </Text>
                  {!p.isSynced && ReceiptService.provisionalReference(p._id) && (
                    <Text style={styles.lineMeta}>
                      {t("fees.provisionalRef", { ref: ReceiptService.provisionalReference(p._id) })}
                    </Text>
                  )}
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
                <TouchableOpacity
                  onPress={() => offerReceipt(p)}
                  disabled={printing !== null}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={p.isSynced ? t("fees.receipt") : t("fees.provisionalReceipt")}
                  style={{ marginRight: 6 }}
                >
                  {printing === p._id
                    ? <ActivityIndicator size="small" color={C.primary} />
                    : <Ionicons name="print-outline" size={16} color={C.primary} />}
                </TouchableOpacity>
                <Text
                  style={[
                    styles.lineAmount,
                    { color: p.amount < 0 ? C.danger : C.success },
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
  headerIcon: { marginRight: 0 },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  balanceCard: { borderRadius: 12, borderWidth: 1, padding: 16 },
  balanceOwes:  { backgroundColor: C.dangerBg,  borderColor: SEMANTIC.error.box },
  balanceClear: { backgroundColor: C.successBg, borderColor: SEMANTIC.success.box },
  balanceLabel: { fontSize: 11, fontWeight: "600", color: C.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
  balanceValue: { marginTop: 6, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  balanceRow:   { flexDirection: "row", gap: 16, marginTop: 8 },
  balanceMeta:  { fontSize: 11, color: C.inkMuted, fontVariant: ["tabular-nums"] },

  pendingBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: SEMANTIC.warning.box,
  },
  pendingText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 10 },
  cardHead:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  cardTitleInHead: { marginBottom: 0, flex: 1 },

  label: { fontSize: 12, fontWeight: "600", color: C.inkBody, marginBottom: 5, marginTop: 8 },
  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: 12, fontSize: 15, color: C.ink, backgroundColor: C.surface,
  },
  hint: { marginTop: 4, fontSize: 11, color: C.inkFaint },

  methods: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  method: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: C.surface,
  },
  methodOn:      { backgroundColor: ACCENT.teal.wash, borderColor: ACCENT.teal.base },
  methodText:    { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  methodTextOn:  { color: ACCENT.teal.deep, fontWeight: "700" },

  submit: {
    marginTop: 16, height: 46, borderRadius: 10, backgroundColor: C.primary,
    alignItems: "center", justifyContent: "center",
  },
  submitOff:  { opacity: 0.45 },
  submitText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "600" },

  line: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  paymentLine: {
    borderLeftWidth: 3, borderLeftColor: ACCENT.teal.base, paddingLeft: 8,
  },
  lineLabel:  { flex: 1, fontSize: 13, color: C.inkBody },
  lineMeta:   { marginTop: 2, fontSize: 11, color: COLORS.textSecondary },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },
  empty:      { fontSize: 12, color: COLORS.textSecondary, paddingVertical: 8 },
});
