// app/student/fees/index.js
"use strict";

/**
 * The pupil's fees: what the school has billed them, what has been paid, and
 * what is still owed.
 *
 * Read-only, and the pupil's own: the server answers the signed-in account's
 * ledger and no other, in the same redacted shape a family sees in the
 * guardian portal. Payments are recorded by the bursar's office; this screen
 * says so rather than offering a button that could not work. Offline it shows
 * the last answer it had and says when that was.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatDateShort, formatTime } from "../../../src/i18n/format";
import { fetchMyFees } from "../../../src/services/studentFees.service";
import { errorText } from "../../../src/utils/appError";

const C = {
  primary: "#2563EB", primaryBg: "#EFF6FF",
  success: "#059669", successBg: "#ECFDF5",
  warning: "#D97706", warningBg: "#FEF3C7",
  danger:  "#DC2626", dangerBg:  "#FEF2F2",
  white:   "#FFFFFF",
  gray50:  "#F9FAFB", gray100: "#F3F4F6", gray200: "#E5E7EB",
  gray400: "#9CA3AF", gray500: "#6B7280", gray600: "#4B5563", gray900: "#111827",
};

export default function StudentFeesScreen() {
  const { t } = useTranslation();

  const [ledger, setLedger]     = useState(null);
  const [stale, setStale]       = useState(null);   // fetchedAt when shown from the cache
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const r = await fetchMyFees();
      setLedger(r.data);
      setStale(r.stale ? r.fetchedAt : null);
    } catch (err) {
      setError(errorText(t, err, "studentFees.loadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const totals  = ledger?.totals ?? { charged: 0, waived: 0, paid: 0, balance: 0 };
  const balance = totals.balance ?? 0;
  const tone    = balance > 0 ? "owes" : balance < 0 ? "credit" : "settled";
  const toneColor = tone === "owes" ? C.danger : C.success;
  const toneBg    = tone === "owes" ? C.dangerBg : C.successBg;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}
                          accessibilityRole="button" accessibilityLabel={t("common.back")}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("studentFees.title")}</Text>
          <Text style={styles.headerSub}>{t("studentFees.blurb")}</Text>
        </View>
      </View>

      {stale && (
        <View style={styles.staleBar}>
          <Ionicons name="cloud-offline-outline" size={16} color={C.warning} />
          <Text style={styles.staleText}>{t("studentFees.staleAt", { time: formatTime(stale) })}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        >
          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={C.danger} />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity onPress={() => load()}>
                <Text style={styles.retryText}>{t("common.retry")}</Text>
              </TouchableOpacity>
            </View>
          )}

          {ledger && (
            <>
              {/* The balance, first */}
              <View style={[styles.balanceCard, { backgroundColor: toneBg, borderColor: toneColor + "40" }]}>
                <Text style={styles.balanceLabel}>
                  {tone === "owes" ? t("studentFees.owing") : tone === "credit" ? t("studentFees.credit") : t("studentFees.settled")}
                </Text>
                <Text style={[styles.balanceValue, { color: toneColor }]}>{formatMoney(Math.abs(balance))}</Text>
                <View style={styles.balanceRow}>
                  <Text style={styles.balanceMeta}>{t("fees.charged")} {formatMoney(totals.charged ?? 0)}</Text>
                  {(totals.waived ?? 0) > 0 && (
                    <Text style={styles.balanceMeta}>{t("fees.waived")} {formatMoney(totals.waived)}</Text>
                  )}
                  <Text style={styles.balanceMeta}>{t("fees.paid")} {formatMoney(totals.paid ?? 0)}</Text>
                </View>
              </View>

              {/* What was billed */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t("fees.charges")}</Text>
                {(ledger.charges?.length ?? 0) === 0 ? (
                  <Text style={styles.empty}>{t("studentFees.empty")}</Text>
                ) : (
                  ledger.charges.map((c) => {
                    const net = Math.max(0, (c.amount ?? 0) - (c.waivedAmount ?? 0));
                    return (
                      <View key={c._id} style={styles.line}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.lineLabel} numberOfLines={1}>{c.label || c.code}</Text>
                          <Text style={styles.lineMeta}>
                            {[
                              c.academicYear,
                              c.term ? t("studentFees.term", { n: c.term }) : null,
                              c.dueDate ? `${t("portal.dueBy")} ${formatDateShort(c.dueDate)}` : null,
                            ].filter(Boolean).join(" · ")}
                          </Text>
                          {(c.waivedAmount ?? 0) > 0 && (
                            <Text style={[styles.lineMeta, { color: C.success }]}>
                              {t("fees.waived")} {formatMoney(c.waivedAmount)}
                            </Text>
                          )}
                        </View>
                        <Text style={styles.lineAmount}>{formatMoney(net)}</Text>
                      </View>
                    );
                  })
                )}
              </View>

              {/* What was paid */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t("fees.payments")}</Text>
                {(ledger.payments?.length ?? 0) === 0 ? (
                  <Text style={styles.empty}>{t("fees.noPayments")}</Text>
                ) : (
                  ledger.payments.map((p) => (
                    <View key={p._id} style={styles.line}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.lineLabel} numberOfLines={1}>
                          {p.receiptNo ? `${t("fees.receiptNo")} ${p.receiptNo}` : t("fees.pendingReceipt")}
                          {p.isReversal ? ` · ${t("fees.reversed")}` : ""}
                        </Text>
                        <Text style={styles.lineMeta}>{formatDateShort(p.receivedAt)}</Text>
                      </View>
                      <Text style={[styles.lineAmount, p.amount < 0 && { color: C.danger }]}>
                        {formatMoney(p.amount)}
                      </Text>
                    </View>
                  ))
                )}
              </View>

              <Text style={styles.footnote}>{t("studentFees.askOffice")}</Text>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:     { flex: 1, backgroundColor: C.gray50 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header:   { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 52, paddingBottom: 12,
              backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.gray200 },
  backBtn:  { padding: 6, marginRight: 6 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },

  staleBar:  { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.warningBg, paddingHorizontal: 16, paddingVertical: 8 },
  staleText: { fontSize: 12, color: C.warning, flex: 1 },

  scroll: { padding: 16, gap: 12, paddingBottom: 40 },

  errorBox:  { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.dangerBg, borderRadius: 10, padding: 12 },
  errorText: { flex: 1, fontSize: 13, color: C.danger },
  retryText: { fontSize: 13, fontWeight: "600", color: C.primary },

  balanceCard:  { borderRadius: 14, padding: 16, borderWidth: 1 },
  balanceLabel: { fontSize: 12, fontWeight: "600", color: C.gray600, textTransform: "uppercase", letterSpacing: 0.4 },
  balanceValue: { fontSize: 28, fontWeight: "800", marginTop: 4 },
  balanceRow:   { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 },
  balanceMeta:  { fontSize: 12, color: C.gray600 },

  card:      { backgroundColor: C.white, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.gray200 },
  cardTitle: { fontSize: 14, fontWeight: "700", color: C.gray900, marginBottom: 6 },
  empty:     { fontSize: 13, color: C.gray400, paddingVertical: 8 },
  line:      { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.gray100 },
  lineLabel: { fontSize: 14, color: C.gray900, fontWeight: "500" },
  lineMeta:  { fontSize: 12, color: C.gray500, marginTop: 2 },
  lineAmount: { fontSize: 14, fontWeight: "700", color: C.gray900 },

  footnote: { fontSize: 12, color: C.gray500, textAlign: "center", marginTop: 4, paddingHorizontal: 8 },
});
