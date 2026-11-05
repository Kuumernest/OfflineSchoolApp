// app/admin/finance/payroll.js
//
// Payroll, read-only.
//
// Generating and confirming a run stays in the web console — see the note at
// the top of payroll.service.js for why that is a correctness decision and not
// a scoping one. This screen exists so a head who is not at a desk can still
// see what a month cost and who was on it.
//
// The runs list is cached, so it opens with no signal and says plainly that the
// figures are the last ones this phone fetched. Payslips are not cached: they
// are only useful when current, so the screen asks for them on demand and says
// when it cannot.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import PayrollService     from "../../../src/services/payroll.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { formatMoney, formatMonth, formatNumber, formatDateShort }
  from "../../../src/i18n/format";
import { useAuthStore }   from "../../../src/store/auth.store";
import { COLORS, ACCENT, SEMANTIC, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare, EmptyState } from "../../../src/components/Tinted";

const C = {
  primary:   ACCENT.teal.solid,
  primaryBg: ACCENT.teal.wash,
  danger:    SEMANTIC.error.text,
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

const toBadge = (tone) => {
  const b = statusBadge(tone);
  return { bg: b.bg, fg: b.text, border: b.border };
};
const STATUS_STYLE = {
  draft:     toBadge("warning"),
  confirmed: toBadge("success"),
  reversed:  toBadge("error"),
};

export default function PayrollScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [runs, setRuns]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefresh]  = useState(false);
  const [stale, setStale]         = useState(false);

  const [openId, setOpenId]       = useState(null);
  const [detail, setDetail]       = useState(null);
  const [detailBusy, setBusy]     = useState(false);
  const [detailFailed, setFailed] = useState(false);

  const load = useCallback(async () => {
    // Cache first, so something is on screen before the network is tried.
    setRuns(await PayrollService.listCachedRuns());
    try {
      await PayrollService.pullRuns({ schoolId });
      setRuns(await PayrollService.listCachedRuns());
      setStale(false);
    } catch {
      // Offline is expected, not an error worth interrupting anyone over.
      setStale(true);
    }
  }, [schoolId]);

  useEffect(() => {
    (async () => {
      try { await load(); } finally { setLoading(false); }
    })();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefresh(true);
    try { await load(); } finally { setRefresh(false); }
  }, [load]);

  const toggle = async (runId) => {
    if (openId === runId) { setOpenId(null); setDetail(null); return; }

    setOpenId(runId);
    setDetail(null);
    setFailed(false);
    setBusy(true);
    try {
      setDetail(await PayrollService.fetchRunDetail({ schoolId, runId }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("payroll.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t("payroll.readOnlyNotice")}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.primary} />
        }
      >
        {stale && runs.length > 0 && (
          <View style={styles.staleBanner}>
            <Ionicons name="cloud-offline-outline" size={15} color={C.warning} />
            <Text style={styles.staleText}>{t("payroll.offlineRuns")}</Text>
          </View>
        )}

        {runs.length === 0 ? (
          <EmptyState
            icon="cash-outline"
            accent="teal"
            title={t("payroll.none")}
            message={stale ? t("payroll.offlineRuns") : t("payroll.noneHint")}
          />
        ) : (
          runs.map((r) => {
            const tone = STATUS_STYLE[r.status] ?? STATUS_STYLE.reversed;
            const open = openId === r._id;

            return (
              <View key={r._id} style={styles.card}>
                <TouchableOpacity
                  style={styles.runRow}
                  onPress={() => toggle(r._id)}
                  activeOpacity={0.75}
                >
                  <IconSquare icon="cash" accent="teal" size={32} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.runMonth}>{formatMonth(r.periodMonth)}</Text>
                    <Text style={styles.runMeta}>
                      {formatNumber(r.staffCount)} · {t("salaries.net")}{" "}
                      <Text style={styles.netFigure}>{formatMoney(r.totalNet)}</Text>
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                    <Text style={[styles.badgeText, { color: tone.fg }]}>
                      {t(`payroll.${r.status}`)}
                    </Text>
                  </View>
                  <Ionicons
                    name={open ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={COLORS.textSecondary}
                  />
                </TouchableOpacity>

                {open && (
                  <View style={styles.detail}>
                    {detailBusy && <ActivityIndicator color={C.primary} />}

                    {detailFailed && (
                      <Text style={styles.empty}>{t("payroll.offlineDetail")}</Text>
                    )}

                    {detail?.payslips?.map((p) => (
                      <View key={p._id} style={styles.line}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.lineLabel} numberOfLines={1}>
                            {p.staff?.name ?? p.userId}
                          </Text>
                          <Text style={styles.lineMeta} numberOfLines={1}>
                            {/* No number yet means the run is still a draft. */}
                            {p.payslipNo || t("payroll.pendingNumber")}
                          </Text>
                          {p.payType === "hourly" &&
                            p.hoursWorked != null &&
                            p.hourlyRate != null && (
                              <Text style={styles.lineMeta} numberOfLines={1}>
                                {t("payroll.hoursLine", {
                                  hours: p.hoursWorked,
                                  rate:  formatMoney(p.hourlyRate),
                                })}
                              </Text>
                            )}
                        </View>
                        <Text style={[styles.lineAmount, styles.netFigure]}>{formatMoney(p.net)}</Text>
                      </View>
                    ))}

                    {r.fetchedAt && (
                      <Text style={styles.stamp}>
                        {t("payroll.lastUpdated", { date: formatDateShort(r.fetchedAt) })}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
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

  staleBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: SEMANTIC.warning.box,
  },
  staleText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  card: {
    backgroundColor: ACCENT.teal.wash, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 14, paddingVertical: 12,
    borderLeftWidth: 3, borderLeftColor: ACCENT.teal.base,
  },

  runRow:   { flexDirection: "row", alignItems: "center", gap: 10 },
  runMonth: { fontSize: 14, fontWeight: "700", color: C.ink },
  runMeta:  { marginTop: 2, fontSize: 11, color: C.inkMuted, fontVariant: ["tabular-nums"] },

  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  netFigure: { color: ACCENT.teal.deep, fontWeight: "700" },
  badgeText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },

  detail: { marginTop: 10, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6 },

  line: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  lineLabel:  { fontSize: 13, color: C.inkBody },
  lineMeta:   { marginTop: 2, fontSize: 11, color: COLORS.textSecondary },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },

  stamp:      { marginTop: 8, fontSize: 10, color: COLORS.textSecondary },
  empty:      { fontSize: 12, color: COLORS.textSecondary, paddingVertical: 8 },
});
