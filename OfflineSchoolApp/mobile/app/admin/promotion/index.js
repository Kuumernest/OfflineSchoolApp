// app/admin/promotion/index.js
//
// End-of-year rollover, read-only.
//
// Starting and committing a rollover stays in the web console — see the note at
// the top of promotion.service.js for why that is a correctness decision, not a
// scoping one. This screen exists so a head away from a desk can see what a
// rollover proposed or did, and look up which class a student has been in.
//
// Runs are fetched live and not cached: they matter for about a week a year, and
// a stale copy of something this consequential is worse than saying there is no
// connection. A student's class history IS cached, because that is the question
// asked all year round, often with a parent standing in front of you.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import PromotionService   from "../../../src/services/promotion.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useAuthStore }   from "../../../src/store/auth.store";
import {
  COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge,
} from "../../../src/theme/colors";
import { HeaderIcon, EmptyState } from "../../../src/components/Tinted";

// Promotion is blue, as on the dashboard and the web console.
const PROMO = ACCENT.blue;

const C = {
  primary:   PROMO.solid,
  danger:    SEMANTIC.error.text,
  dangerBg:  SEMANTIC.error.bg,
  success:   SEMANTIC.success.text,
  successBg: SEMANTIC.success.bg,
  info:      PROMO.deep,
  infoBg:    PROMO.wash,
  warning:   SEMANTIC.warning.text,
  warningBg: SEMANTIC.warning.bg,
  ink:       COLORS.text,
  inkBody:   COLORS.text,
  inkMuted:  COLORS.textSecondary,
  inkFaint:  COLORS.textSecondary,
  line:      COLORS.border,
  surface:   COLORS.surface,
  canvas:    COLORS.page,
};

/** A badge's colours as { bg, fg, border } — never grey. */
const pill = ({ bg, text, border }) => ({ bg, fg: text, border });

const STATUS_TONE = {
  draft:     pill(statusBadge("warning")),
  committed: pill(statusBadge("success")),
  reversed:  pill(statusBadge("info")),
};

const OUTCOME_TONE = {
  promoted:   pill(statusBadge("success")),
  repeated:   pill(statusBadge("warning")),
  graduated:  pill(accentBadge("blue")),
  unassigned: pill(statusBadge("error")),
};

export default function PromotionScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [runs, setRuns]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefresh] = useState(false);
  const [offline, setOffline]   = useState(false);

  const [openId, setOpenId]     = useState(null);
  const [detail, setDetail]     = useState(null);
  const [detailBusy, setBusy]   = useState(false);
  const [detailFailed, setFail] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuns(await PromotionService.fetchRuns({ schoolId }));
      setOffline(false);
    } catch {
      setOffline(true);
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
    setFail(false);
    setBusy(true);
    try {
      setDetail(await PromotionService.fetchRun({ schoolId, runId }));
    } catch {
      setFail(true);
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
          <Text style={styles.title} numberOfLines={1}>{t("promo.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t("promo.readOnlyNotice")}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.primary} />
        }
      >
        {offline && (
          <View style={styles.banner}>
            <Ionicons name="cloud-offline-outline" size={15} color={C.warning} />
            <Text style={styles.bannerText}>{t("promo.offline")}</Text>
          </View>
        )}

        {runs.length === 0 ? (
          <View style={styles.card}>
            <EmptyState
              icon="trending-up"
              accent="blue"
              title={t("promo.none")}
              message={offline ? t("promo.offline") : t("promo.noneHint")}
            />
          </View>
        ) : (
          runs.map((r) => {
            const tone    = STATUS_TONE[r.status] ?? STATUS_TONE.reversed;
            const open    = openId === r._id;
            const counts  = r.counts ?? {};
            const blocked = counts.unassigned ?? 0;

            return (
              <View key={r._id} style={[styles.card, styles.runCard]}>
                <TouchableOpacity
                  style={styles.runRow}
                  onPress={() => toggle(r._id)}
                  activeOpacity={0.75}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.runYears}>
                      {r.fromYear} → {r.toYear}
                    </Text>
                    <Text style={styles.runMeta}>
                      {t("promo.students", { count: counts.total ?? 0 })}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                    <Text style={[styles.badgeText, { color: tone.fg }]}>
                      {t(`promo.${r.status}`)}
                    </Text>
                  </View>
                  <Ionicons
                    name={open ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={COLORS.textSecondary}
                  />
                </TouchableOpacity>

                {/* The four figures that say what the rollover does. */}
                <View style={styles.tallies}>
                  {[
                    ["promo.promoted",  counts.promoted  ?? 0, C.success],
                    ["promo.repeated",  counts.repeated  ?? 0, C.warning],
                    ["promo.graduated", counts.graduated ?? 0, C.info],
                    ["promo.unassigned", blocked, blocked > 0 ? C.danger : COLORS.textSecondary],
                  ].map(([key, value, colour]) => (
                    <View key={key} style={styles.tally}>
                      <Text style={[styles.tallyValue, { color: colour }]}>{value}</Text>
                      <Text style={styles.tallyLabel} numberOfLines={1}>{t(key)}</Text>
                    </View>
                  ))}
                </View>

                {blocked > 0 && r.status === "draft" && (
                  <Text style={styles.blocked}>
                    {t("promo.blockedNotice", { count: blocked })}
                  </Text>
                )}

                {open && (
                  <View style={styles.detail}>
                    {detailBusy && <ActivityIndicator color={C.primary} />}
                    {detailFailed && <Text style={styles.empty}>{t("promo.offline")}</Text>}

                    {detail?.decisions?.map((d) => {
                      const ot = OUTCOME_TONE[d.outcome] ?? OUTCOME_TONE.unassigned;
                      return (
                        <View key={d._id} style={styles.line}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.lineLabel} numberOfLines={1}>
                              {d.studentName || d.enrollmentNo || d.studentId}
                            </Text>
                            <Text style={styles.lineMeta} numberOfLines={1}>
                              {d.fromClassName || "—"} → {d.toClassName || "—"}
                              {"  ·  "}
                              {t(`promo.basis_${d.basis}`)}
                            </Text>
                          </View>
                          <View style={[styles.badge, { backgroundColor: ot.bg, borderColor: ot.border }]}>
                            <Text style={[styles.badgeText, { color: ot.fg }]}>
                              {t(`promo.${d.outcome}`)}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
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
  headerIcon: { marginRight: 0 },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: statusBadge("warning").border,
  },
  bannerText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, paddingVertical: 12,
  },
  runCard: {
    backgroundColor: PROMO.wash,
    borderTopWidth: 3, borderTopColor: PROMO.base,
  },

  runRow:   { flexDirection: "row", alignItems: "center", gap: 10 },
  runYears: { fontSize: 14, fontWeight: "700", color: C.ink },
  runMeta:  { marginTop: 2, fontSize: 11, color: C.inkMuted },

  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },

  tallies: {
    flexDirection: "row", marginTop: 12,
    borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10,
  },
  tally:      { flex: 1, alignItems: "center" },
  tallyValue: { fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  tallyLabel: { marginTop: 2, fontSize: 9, color: C.inkFaint, textTransform: "uppercase" },

  blocked: {
    marginTop: 8, fontSize: 11, color: C.danger, fontWeight: "500",
  },

  detail: { marginTop: 10, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 4 },

  line: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  lineLabel: { fontSize: 13, color: C.inkBody, fontWeight: "500" },
  lineMeta:  { marginTop: 2, fontSize: 11, color: C.inkFaint },

  empty:      { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },
});
