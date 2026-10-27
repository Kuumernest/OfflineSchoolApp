// src/components/portal/FeesScreen.js
//
// Fees for the selected child: the balance from the family ledger, overdue
// and the due date by the school's own rule (the figure on Home), every
// charge with its due date, the payment plan when there is one, and every
// payment with its receipt. The phone's copy of
// web/src/pages/portal/FeesScreen.tsx.
//
// No charge is marked overdue on its own: a charge's date says nothing about
// whether the payments already made have covered it. The phone used to put
// "Overdue · 59d" on a term paid in full. Overdue is the account's state,
// said once, at the top.

import React from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { formatMoney, formatDate } from "../../i18n/format";
import { Card, CardTitle, Skeleton, EmptyState, said } from "./ui";
import { C, TAP } from "./theme";

// The payment methods the catalogues word; anything else is shown as sent.
const METHODS = ["cash", "mobile_money", "bank", "cheque", "waiver", "other"];

export default function FeesScreen({ data, loading, plan, status, childName, printing, onPrintReceipt }) {
  const { t } = useTranslation();

  if (loading && !data) {
    return (
      <View style={s.stack}>
        <Skeleton width={80} height={22} />
        <Skeleton height={170} radius={14} />
        <Skeleton height={190} radius={14} />
      </View>
    );
  }
  if (!data || ((data.charges?.length ?? 0) === 0 && (data.payments?.length ?? 0) === 0)) {
    return (
      <Card>
        <EmptyState icon="wallet-outline" title={t("portal.feesScreen.empty")} hint={t("portal.feesScreen.emptyHint")} />
      </Card>
    );
  }

  const totals  = data.totals ?? {};
  const owes    = (totals.balance ?? 0) > 0;
  const overdue = owes && Boolean(status?.isOverdue);
  const payments = [...(data.payments ?? [])].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));

  return (
    <View style={s.stack}>
      <Text style={s.h1} accessibilityRole="header">{t("portal.feesScreen.title")}</Text>

      {/* The balance, said first and once. */}
      <Card style={[s.pad, overdue && { borderColor: C.dangerLine }]}>
        {owes ? (
          <>
            <View style={s.balanceHead}>
              <Text style={s.kicker}>{t("portal.feesScreen.balance")}</Text>
              {overdue ? (
                <View style={[s.pill, s.pillDanger]}>
                  <Ionicons name="alert-circle-outline" size={14} color={C.danger} />
                  <Text style={[s.pillText, { color: C.danger }]}>{t("portal.feesScreen.overdue")}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[s.balance, overdue && { color: C.danger }]} numberOfLines={1} adjustsFontSizeToFit>
              {formatMoney(totals.balance)}
            </Text>
            {status?.dueDate ? (
              <View style={s.dueRow}>
                <Ionicons name="time-outline" size={16} color={C.inkMuted} />
                <Text style={s.due}>
                  {overdue
                    ? t("portal.feesScreen.overdueSince", { date: formatDate(status.dueDate) })
                    : t("portal.feesScreen.dueOn", { date: formatDate(status.dueDate) })}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={s.paidRow}>
            <Ionicons name="checkmark-circle-outline" size={36} color={C.success} />
            <View style={{ flex: 1 }}>
              <Text style={s.paidTitle}>{t("portal.feesScreen.paidUp")}</Text>
              <Text style={s.muted}>{t("portal.feesScreen.paidUpHint", { name: childName ?? "" })}</Text>
            </View>
          </View>
        )}
        <View style={s.totals}>
          <Line label={t("portal.feesScreen.charged")} value={formatMoney(totals.charged ?? 0)} />
          {(totals.waived ?? 0) > 0 ? <Line label={t("portal.feesScreen.waived")} value={`−${formatMoney(totals.waived)}`} /> : null}
          <Line label={t("portal.feesScreen.paid")} value={`−${formatMoney(totals.paid ?? 0)}`} color={C.success} />
        </View>
      </Card>

      {/* Charges, each with its due date. */}
      <Card>
        <View style={s.listHead}><CardTitle icon="document-text-outline">{t("portal.feesScreen.charges")}</CardTitle></View>
        {(data.charges ?? []).map((c) => (
          <View key={c._id} style={s.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.rowTitle}>{c.label ?? c.code}</Text>
              <Text style={s.rowMeta}>
                {c.dueDate ? t("portal.feesScreen.dueBy", { date: formatDate(c.dueDate) }) : t("portal.feesScreen.noDueDate")}
                {c.waivedAmount > 0 ? ` · ${t("portal.feesScreen.waived")} ${formatMoney(c.waivedAmount)}` : ""}
              </Text>
            </View>
            <Text style={s.amount}>{formatMoney(c.amount)}</Text>
          </View>
        ))}
      </Card>

      {plan ? (
        <Card>
          <View style={s.listHead}><CardTitle icon="calendar-outline">{t("portal.feesScreen.plan")}</CardTitle></View>
          {plan.reason ? <Text style={[s.muted, { paddingHorizontal: 16, paddingTop: 10 }]}>{plan.reason}</Text> : null}
          {(plan.instalments ?? []).map((i) => (
            <View key={i.seq} style={s.row}>
              <Text style={[s.rowTitle, { flex: 1 }]}>
                {t("portal.feesScreen.instalment", { seq: i.seq })}
                <Text style={s.rowMeta}> · {formatDate(i.dueDate)}</Text>
              </Text>
              <Text style={s.amount}>{formatMoney(i.amount)}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Payments, each with its receipt. */}
      <Card>
        <View style={s.listHead}><CardTitle icon="receipt-outline">{t("portal.feesScreen.payments")}</CardTitle></View>
        {payments.length === 0 ? (
          <EmptyState icon="receipt-outline" title={t("portal.feesScreen.noPayments")} />
        ) : payments.map((p) => (
          <View key={p._id} style={s.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.payAmount, p.isReversal && { color: C.danger }]}>
                {p.isReversal ? "−" : ""}{formatMoney(Math.abs(p.amount))}
              </Text>
              <Text style={s.rowMeta}>
                {[
                  formatDate(p.receivedAt),
                  p.method ? (METHODS.includes(p.method) ? t(`method.${p.method}`) : p.method) : null,
                  p.receiptNo,
                  p.isReversal ? t("portal.feesScreen.reversal") : null,
                ].filter(Boolean).join(" · ")}
              </Text>
            </View>
            {!p.isReversal ? (
              <Pressable
                onPress={() => onPrintReceipt(p._id)}
                disabled={printing === p._id}
                accessibilityRole="button"
                accessibilityLabel={t("portal.feesScreen.receiptFor", { no: p.receiptNo ?? "" })}
                style={({ pressed }) => [s.receiptBtn, pressed && { backgroundColor: C.canvas }]}
              >
                {printing === p._id
                  ? <ActivityIndicator size="small" color={C.primary} />
                  : <Ionicons name="print-outline" size={17} color={C.ink} />}
                <Text style={s.receiptText}>{t("portal.feesScreen.receipt")}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

function Line({ label, value, color }) {
  return (
    <View style={s.line} accessible accessibilityLabel={said(label, value)}>
      <Text style={s.lineLabel}>{label}</Text>
      <Text style={[s.lineValue, color && { color }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 14 },
  pad:   { padding: 18 },
  h1:    { fontSize: 22, fontWeight: "700", color: C.ink },
  kicker: { fontSize: 13, fontWeight: "600", color: C.inkMuted },
  muted:  { fontSize: 13, color: C.inkMuted, lineHeight: 19 },

  balanceHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  balance:     { marginTop: 4, fontSize: 32, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  dueRow:      { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  due:         { fontSize: 14, color: C.inkBody },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999,
  },
  pillDanger: { backgroundColor: C.dangerBg, borderColor: C.dangerLine },
  pillText:   { fontSize: 12, fontWeight: "700" },

  paidRow:   { flexDirection: "row", alignItems: "center", gap: 12 },
  paidTitle: { fontSize: 18, fontWeight: "700", color: C.ink },

  totals:    { marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line, gap: 6 },
  line:      { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  lineLabel: { fontSize: 14, color: C.inkMuted },
  lineValue: { fontSize: 14, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },

  listHead: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60,
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.line,
  },
  rowTitle:  { fontSize: 14, fontWeight: "600", color: C.ink },
  rowMeta:   { marginTop: 2, fontSize: 12, fontWeight: "400", color: C.inkMuted },
  amount:    { fontSize: 14, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  payAmount: { fontSize: 15, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  receiptBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, minHeight: TAP, paddingHorizontal: 12,
    borderRadius: 10, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface,
  },
  receiptText: { fontSize: 13, fontWeight: "600", color: C.ink },
});
