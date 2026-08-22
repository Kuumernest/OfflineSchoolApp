// app/admin/finance/reports.js
//
// Income against expenditure, on a phone.
//
// Read-only: every figure is summed from the ledger by the server, so there is
// nothing here to edit and nothing to queue. It opens from cache when there is
// no signal and says so rather than passing stale figures off as current.
//
// The two kinds of number are kept apart, as they are on the web. The summary
// is a flow over the chosen period; arrears are a position as of today. They
// are never added together.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import ReportService      from "../../../src/services/financeReport.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatMonth, formatDateTime } from "../../../src/i18n/format";
import { useAuthStore }   from "../../../src/store/auth.store";

const C = {
  primary:   "#3B4996",
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

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

const iso = (d) => d.toISOString().slice(0, 10);

const presetRange = (preset) => {
  const now = new Date();
  if (preset === "month") {
    return {
      from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      to:   iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
    };
  }
  if (preset === "year") {
    // Closes 31 August, not 31 July — see the web page for why: August is the
    // holiday month, money still moves in it, and a July cut-off puts today
    // outside the range whenever the year is reviewed in August.
    const startYear =
      now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return {
      from: iso(new Date(Date.UTC(startYear, 8, 1))),
      to:   iso(new Date(Date.UTC(startYear + 1, 7, 31))),
    };
  }
  return {};
};

export default function FinanceReportsScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [preset, setPreset]     = useState("year");
  const [report, setReport]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefresh] = useState(false);

  const range = useMemo(() => presetRange(preset), [preset]);

  const load = useCallback(async () => {
    // Cache first, so a figure is on screen before the network is tried.
    const cached = await ReportService.cachedReport(range);
    if (cached) setReport(cached);

    try {
      setReport(await ReportService.pullReport({
        schoolId,
        from: range.from,
        to:   range.to,
        academicYear: currentAcademicYear(),
      }));
    } catch {
      // Offline. Whatever the cache gave us stands, flagged stale.
      if (!cached) setReport(null);
    }
  }, [schoolId, range]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await load();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [load]);

  const refresh = useCallback(async () => {
    setRefresh(true);
    try { await load(); } finally { setRefresh(false); }
  }, [load]);

  const PRESETS = [
    { key: "month", label: t("finrep.thisMonth") },
    { key: "year",  label: t("finrep.thisYear") },
    { key: "all",   label: t("finrep.allTime") },
  ];

  const summary = report?.summary;
  const arrears = report?.arrears;
  const net     = summary?.net ?? 0;
  const months  = summary?.months ?? [];

  // One scale across both series, so the bars can be compared to each other.
  const peak = Math.max(1, ...months.map((m) => Math.max(m.income, m.expenditure)));

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("finrep.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t("finrep.readOnlyNotice")}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.primary} />
        }
      >
        <View style={styles.chips}>
          {PRESETS.map((p) => (
            <TouchableOpacity
              key={p.key}
              style={[styles.chip, preset === p.key && styles.chipOn]}
              onPress={() => setPreset(p.key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.chipText, preset === p.key && styles.chipTextOn]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
        ) : !report ? (
          <View style={styles.card}>
            <Text style={styles.emptyTitle}>{t("finrep.noData")}</Text>
            <Text style={styles.empty}>{t("finrep.offline")}</Text>
          </View>
        ) : (
          <>
            {report.stale && (
              <View style={styles.staleBanner}>
                <Ionicons name="cloud-offline-outline" size={15} color={C.warning} />
                <Text style={styles.staleText}>{t("finrep.offline")}</Text>
              </View>
            )}

            {/* Headline */}
            <View style={styles.row}>
              <View style={[styles.statCard, { backgroundColor: C.successBg, borderColor: "#C3E2D0" }]}>
                <Text style={styles.statLabel}>{t("finrep.income")}</Text>
                <Text style={[styles.statValue, { color: C.success }]}>
                  {formatMoney(summary?.income?.total ?? 0)}
                </Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: C.dangerBg, borderColor: "#F2D3CF" }]}>
                <Text style={styles.statLabel}>{t("finrep.expenditure")}</Text>
                <Text style={[styles.statValue, { color: C.danger }]}>
                  {formatMoney(summary?.expenditure?.total ?? 0)}
                </Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.statLabel}>
                {net < 0 ? t("finrep.deficit") : t("finrep.surplus")}
              </Text>
              <Text
                style={[styles.bigValue, { color: net < 0 ? C.danger : C.success }]}
              >
                {formatMoney(net)}
              </Text>
              <Text style={styles.meta}>
                {t("expenses.title")} {formatMoney(summary?.expenditure?.expenses ?? 0)}
                {"  ·  "}
                {t("finrep.payrollLine")} {formatMoney(summary?.expenditure?.payroll ?? 0)}
              </Text>
            </View>

            {/* Month by month */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("finrep.monthly")}</Text>
              {months.length === 0 ? (
                <Text style={styles.empty}>{t("finrep.noData")}</Text>
              ) : (
                months.map((m) => (
                  <View key={m.month} style={styles.monthRow}>
                    <View style={styles.monthHead}>
                      <Text style={styles.monthName}>{formatMonth(m.month)}</Text>
                      <Text
                        style={[
                          styles.monthNet,
                          { color: m.net < 0 ? C.danger : C.ink },
                        ]}
                      >
                        {formatMoney(m.net)}
                      </Text>
                    </View>
                    <View style={styles.track}>
                      <View
                        style={[
                          styles.fill,
                          { backgroundColor: C.success, width: `${(m.income / peak) * 100}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.track}>
                      <View
                        style={[
                          styles.fill,
                          { backgroundColor: C.danger, width: `${(m.expenditure / peak) * 100}%` },
                        ]}
                      />
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* By category */}
            {(summary?.byCategory?.length ?? 0) > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t("finrep.byCategory")}</Text>
                {summary.byCategory.map((c) => (
                  <View key={c.categoryId} style={styles.line}>
                    <Text style={styles.lineLabel} numberOfLines={1}>{c.label}</Text>
                    <Text style={styles.lineAmount}>{formatMoney(c.total)}</Text>
                  </View>
                ))}
                {/* Salaries are expenditure but not an expense category. */}
                <View style={styles.line}>
                  <Text style={[styles.lineLabel, { color: C.inkMuted }]}>
                    {t("finrep.payrollLine")}
                  </Text>
                  <Text style={styles.lineAmount}>
                    {formatMoney(summary?.expenditure?.payroll ?? 0)}
                  </Text>
                </View>
              </View>
            )}

            {/* Arrears — a position, not a flow. */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("finrep.arrears")}</Text>
              <Text style={styles.note}>{t("finrep.arrearsNote")}</Text>
              <Text style={[styles.bigValue, { color: C.danger }]}>
                {formatMoney(arrears?.outstanding ?? 0)}
              </Text>
              <View style={styles.line}>
                <Text style={styles.lineLabel}>{t("finrep.billed")}</Text>
                <Text style={styles.lineAmount}>{formatMoney(arrears?.billed ?? 0)}</Text>
              </View>
              <View style={styles.line}>
                <Text style={styles.lineLabel}>{t("finrep.collected")}</Text>
                <Text style={styles.lineAmount}>{formatMoney(arrears?.paid ?? 0)}</Text>
              </View>
              {arrears?.collectionRate !== null && arrears?.collectionRate !== undefined && (
                <>
                  <View style={[styles.line, { borderBottomWidth: 0 }]}>
                    <Text style={styles.lineLabel}>{t("finrep.collectionRate")}</Text>
                    <Text style={styles.lineAmount}>{arrears.collectionRate}%</Text>
                  </View>
                  <View style={styles.track}>
                    <View
                      style={[
                        styles.fill,
                        {
                          backgroundColor: C.primary,
                          width: `${Math.min(100, Math.max(0, arrears.collectionRate))}%`,
                        },
                      ]}
                    />
                  </View>
                </>
              )}
            </View>

            {report.fetchedAt && (
              <Text style={styles.stamp}>
                {t("payroll.lastUpdated", { date: formatDateTime(report.fetchedAt) })}
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
  },
  chipOn:     { backgroundColor: C.primary, borderColor: C.primary },
  chipText:   { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  chipTextOn: { color: "#fff" },

  staleBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: "#F0DCBB",
  },
  staleText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  row: { flexDirection: "row", gap: 12 },
  statCard: { flex: 1, borderRadius: 12, borderWidth: 1, padding: 14 },
  statLabel: {
    fontSize: 10, fontWeight: "600", color: C.inkMuted,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  statValue: {
    marginTop: 6, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"],
  },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 8 },
  bigValue: {
    marginTop: 6, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"],
  },
  meta: { marginTop: 6, fontSize: 11, color: C.inkMuted },
  note: { fontSize: 11, color: C.inkFaint, marginBottom: 2 },

  monthRow:  { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, gap: 4 },
  monthHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  monthName: { fontSize: 12, fontWeight: "600", color: C.inkBody },
  monthNet:  { fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },

  track: { height: 5, borderRadius: 3, backgroundColor: C.canvas, overflow: "hidden" },
  fill:  { height: "100%", borderRadius: 3 },

  line: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  lineLabel:  { flex: 1, fontSize: 13, color: C.inkBody },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },

  stamp:      { fontSize: 10, color: C.inkFaint, textAlign: "center" },
  emptyTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 4 },
  empty:      { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },
});
