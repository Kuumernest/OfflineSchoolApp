// src/components/portal/ResultsScreen.js
//
// Results for the selected child, one term at a time: each published result
// with its average /20, class position and remark, every subject with its
// mark /20, coefficient and remark, and the report card the school issued.
// Above them, how the average has moved across every published result. The
// phone's copy of web/src/pages/portal/ResultsScreen.tsx.
//
// Figures are shown as the server sends them; nothing is recomputed here.

import React, { useMemo, useState, useEffect } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { formatDate } from "../../i18n/format";
import { Card, CardTitle, Skeleton, EmptyState } from "./ui";
import TrendChart from "./TrendChart";
import { C, TAP, ordinal, on20, mark } from "./theme";

export default function ResultsScreen({ data, loading, childId, printing, onOpenReportCard }) {
  const { t } = useTranslation();

  // Terms newest first, each with its results newest first (the order sent).
  const terms = useMemo(() => {
    const out = [];
    for (const r of data ?? []) {
      const key = `${r.academicYear}|${r.term}`;
      let g = out.find((x) => x.key === key);
      if (!g) { g = { key, term: r.term, year: r.academicYear, rows: [] }; out.push(g); }
      g.rows.push(r);
    }
    return out;
  }, [data]);

  // A term picked for one child means nothing for the next.
  const [picked, setPicked] = useState(null);
  useEffect(() => { setPicked(null); }, [childId]);
  const current = terms.find((g) => g.key === picked) ?? terms[0];

  const trend = useMemo(() => [...(data ?? [])].reverse()
    .filter((r) => r.average != null)
    .map((r) => ({ key: String(r._id), label: r.examName ?? `T${r.term}`, value: Number(r.average) })), [data]);

  if (loading && !data) return <ResultsSkeleton />;
  if (!data?.length) {
    return (
      <Card>
        <EmptyState icon="school-outline" title={t("portal.resultsScreen.empty")} hint={t("portal.resultsScreen.emptyHint")} />
      </Card>
    );
  }

  return (
    <View style={s.stack}>
      <Text style={s.h1} accessibilityRole="header">{t("portal.resultsScreen.title")}</Text>

      {trend.length >= 2 && (
        <Card style={s.pad}>
          <CardTitle icon="trending-up-outline" style={{ marginBottom: 10 }}>{t("portal.resultsScreen.trend")}</CardTitle>
          <TrendChart points={trend} />
        </Card>
      )}

      {terms.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.terms}
          accessibilityRole="tablist"
          accessibilityLabel={t("portal.resultsScreen.chooseTerm")}
        >
          {terms.map((g) => {
            const on = g.key === current?.key;
            return (
              <Pressable
                key={g.key}
                onPress={() => setPicked(g.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[s.termChip, on && s.termChipOn]}
              >
                <Text style={[s.termText, on && s.termTextOn]} numberOfLines={1}>
                  {t("portal.resultsScreen.term", { term: g.term, year: g.year })}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {current?.rows.map((r) => (
        <ResultCard key={r._id} result={r} printing={printing} onOpenReportCard={onOpenReportCard} />
      ))}
    </View>
  );
}

function ResultCard({ result: r, printing, onOpenReportCard }) {
  const { t, language } = useTranslation();
  const termLabel = t("portal.resultsScreen.term", { term: r.term, year: r.academicYear });
  const busy = printing === `card-${r._id}`;

  return (
    <Card>
      <View style={s.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.examName} accessibilityRole="header">{r.examName ?? termLabel}</Text>
          <Text style={s.meta}>
            {termLabel}
            {r.issuedAt ? ` · ${t("portal.resultsScreen.published", { date: formatDate(r.issuedAt) })}` : ""}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={s.avg}>{on20(r.average, language)}<Text style={s.outOf}>/20</Text></Text>
          {r.classPosition != null && r.totalInClass != null ? (
            <Text style={s.rank}>
              {t("portal.resultsScreen.rank", { position: ordinal(Number(r.classPosition), language), outOf: r.totalInClass })}
            </Text>
          ) : null}
        </View>
      </View>
      {r.overallRemark ? (
        <View style={s.remarkWrap}><Text style={s.remarkPill}>{r.overallRemark}</Text></View>
      ) : null}

      <View style={s.colHead}>
        <Text style={[s.colText, { flex: 1 }]}>{t("portal.resultsScreen.subject")}</Text>
        <Text style={s.colText}>{t("portal.resultsScreen.mark")}</Text>
      </View>
      {(r.subjects ?? []).map((sub, i) => {
        const detail = [sub.remark, sub.coefficient != null ? `${t("portal.resultsScreen.coef")} ${sub.coefficient}` : null]
          .filter(Boolean).join(" · ");
        return (
          <View
            key={sub.subjectId ?? i}
            style={s.subject}
            accessible
            accessibilityLabel={[
              sub.subjectName,
              sub.isAbsent ? t("portal.resultsScreen.absent") : `${mark(sub.normalizedMark, language)}/20`,
              !sub.isAbsent && !sub.isPassing ? t("portal.resultsScreen.belowPass") : null,
              detail,
            ].filter(Boolean).join(", ")}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.subjectName}>{sub.subjectName ?? "—"}</Text>
              {detail ? <Text style={s.subjectMeta}>{detail}</Text> : null}
            </View>
            {sub.isAbsent ? (
              <Text style={s.absent}>{t("portal.resultsScreen.absent")}</Text>
            ) : (
              <Text style={[s.mark, !sub.isPassing && { color: C.danger }]}>{mark(sub.normalizedMark, language)}</Text>
            )}
          </View>
        );
      })}

      <View style={s.foot}>
        <Pressable
          onPress={() => onOpenReportCard(r)}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [s.cardBtn, (pressed || busy) && { backgroundColor: C.canvas }]}
        >
          {busy
            ? <ActivityIndicator size="small" color={C.primary} />
            : <Ionicons name="document-text-outline" size={18} color={C.ink} />}
          <Text style={s.cardBtnText}>{t("portal.resultsScreen.reportCard")}</Text>
        </Pressable>
      </View>
    </Card>
  );
}

function ResultsSkeleton() {
  return (
    <View style={s.stack}>
      <Skeleton width={110} height={22} />
      <Skeleton height={190} radius={14} />
      <Card style={[s.pad, { gap: 12 }]}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Skeleton width={130} height={18} /><Skeleton width={80} height={26} />
        </View>
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={32} />)}
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 14 },
  pad:   { padding: 16 },
  h1:    { fontSize: 22, fontWeight: "700", color: C.ink },

  terms:      { gap: 8, paddingRight: 4 },
  termChip:   {
    minHeight: TAP, paddingHorizontal: 16, borderRadius: 999, justifyContent: "center",
    borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface,
  },
  termChipOn: { backgroundColor: C.primary, borderColor: C.primary },
  termText:   { fontSize: 14, fontWeight: "600", color: C.inkBody },
  termTextOn: { color: "#FFFFFF" },

  head:     { flexDirection: "row", alignItems: "flex-end", gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  examName: { fontSize: 16, fontWeight: "700", color: C.ink },
  meta:     { marginTop: 2, fontSize: 12, color: C.inkMuted },
  avg:      { fontSize: 26, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  outOf:    { fontSize: 14, fontWeight: "600", color: C.inkFaint },
  rank:     { fontSize: 13, color: C.inkBody },

  remarkWrap: { paddingHorizontal: 16, paddingBottom: 12 },
  remarkPill: {
    alignSelf: "flex-start", fontSize: 13, fontWeight: "600", color: "#2C3778", backgroundColor: C.primaryBg,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: "hidden",
  },

  colHead: {
    flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: C.canvas, borderTopWidth: 1, borderTopColor: C.line,
  },
  colText: { fontSize: 12, fontWeight: "600", color: C.inkMuted },

  subject: {
    flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52,
    paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line,
  },
  subjectName: { fontSize: 14, fontWeight: "600", color: C.ink },
  subjectMeta: { marginTop: 2, fontSize: 12, color: C.inkMuted },
  mark:        { fontSize: 16, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  absent:      { fontSize: 13, color: C.inkMuted },

  foot:    { padding: 12, borderTopWidth: 1, borderTopColor: C.line },
  cardBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    minHeight: TAP + 4, borderRadius: 10, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface,
  },
  cardBtnText: { fontSize: 14, fontWeight: "600", color: C.ink },
});
