// mobile/app/student/development/index.js
//
// The pupil's own development view: for each strength, what it reads now,
// how it has read across the recorded observations, why it changed, and what
// is still unclear. Categories and counts from the school's own records — no
// score, no ranking, no career. Online only: the history is derived on the
// server from immutable snapshots and the current reading; offline the screen
// says so and shows nothing invented.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, StatusBar, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { fetchMyDevelopment, fetchMyGuidance, fetchMyInterventions, actOnMyIntervention } from "../../../src/services/exploration.service";
import { COLORS, ACCENT } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare, EmptyState } from "../../../src/components/Tinted";

/** A section heading with its solid icon square. */
function SectionTitle({ icon, accent, children }) {
  return (
    <View style={st.sectionRow}>
      <IconSquare icon={icon} accent={accent} size={28} />
      <Text style={st.sectionTitle}>{children}</Text>
    </View>
  );
}

const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");

export default function StudentDevelopmentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const pad = useScreenInsets({ top: 16 });
  const [h, setH] = useState(null);
  const [g, setG] = useState(null);
  const [iv, setIv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dev, guidance, support] = await Promise.all([fetchMyDevelopment(), fetchMyGuidance(), fetchMyInterventions()]);
      setH(dev); setG(guidance); setIv(support);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const fam = (list) => list.map((f) => t(`strengths.integration.family.${f}`)).join(", ");
  const explainLine = (l) => t(`development.explain.${l.code}`, {
    state: l.state ? t(`strengths.state.${l.state}`) : "", n: l.n ?? "", from: l.from ? t(`strengths.state.${l.from}`) : "", to: l.to ? t(`strengths.state.${l.to}`) : "",
    at: day(l.at), family: l.family ? t(`strengths.integration.family.${l.family}`) : "", kind: l.kind ?? "", status: l.status ? t(`development.status.${l.status}`) : "",
    occurrences: l.occurrences ?? "", firstSeen: day(l.firstSeen), lastSeen: day(l.lastSeen), rel: l.relationship ? ` · ${t(`strengths.integration.relationship.${l.relationship}`)}` : "",
  });
  const shown = (h?.trajectories ?? []).filter((x) => x.dimensionId && (x.currentState !== "INSUFFICIENT" || x.stateTransitions.length > 0));

  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={24} color={COLORS.text} /></TouchableOpacity>
        <HeaderIcon style={{ marginRight: 0 }} />
        <Text style={st.title}>{t("development.studentTitle")}</Text>
      </View>
      <Text style={st.sub}>{t("development.studentSubtitle")}</Text>
      {loading ? <ActivityIndicator style={{ marginTop: 32 }} /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
          {(!h || !h.history || h.history.observationCount === 0) && <EmptyState icon="leaf-outline" accent="green" style={st.emptyState} message={t("development.noHistory")} />}
          {h?.history?.observationCount > 0 && <Text style={st.meta}>{t("development.observations", { n: h.history.observationCount, i: h.history.independentObservationCount })}</Text>}
          {shown.map((x) => {
            const unclear = [
              ...(x.trajectory === "INSUFFICIENT_HISTORY" ? [t("development.trajectory.INSUFFICIENT_HISTORY")] : []),
              ...(x.quality.missingModalities.length ? [t("development.unavailable", { list: fam(x.quality.missingModalities) })] : []),
            ];
            return (
              <View key={x.dimensionId} style={st.card}>
                <Text style={st.cardTitle}>{t(`strengths.dimension.${x.dimensionId}`)}</Text>
                <Text style={st.line}>{t("development.current")}: {t(`strengths.state.${x.currentState}`)} · {t(`development.trajectory.${x.trajectory}`)}</Text>
                <Text style={st.label}>{t("development.history")}</Text>
                {x.observations.map((o, i) => <Text key={i} style={st.sub2}>• {o.periodLabel ?? day(o.observedAt)}: {t(`strengths.state.${o.state}`)}</Text>)}
                <Text style={st.label}>{t("development.whyChanged")}</Text>
                {x.explanation.filter((l) => !["MODALITY_UNAVAILABLE", "ATTENDANCE_LIMITED"].includes(l.code)).map((l, i) => <Text key={i} style={st.sub2}>• {explainLine(l)}</Text>)}
                <Text style={st.label}>{t("development.stillUnclear")}</Text>
                {unclear.length ? unclear.map((u, i) => <Text key={i} style={st.sub2}>• {u}</Text>) : <Text style={st.sub2}>• {t("strengths.integration.nothingUnclear")}</Text>}
              </View>
            );
          })}
          {h?.history?.observationCount > 0 && <Text style={st.hint}>{t("development.unavailableNote")}</Text>}

          {/* Things I can try: guidance informs; the pupil decides. */}
          <SectionTitle icon="bulb" accent="green">{t("devGuidance.studentHeading")}</SectionTitle>
          {!(g?.items?.length) && <Text style={st.empty}>{t("devGuidance.none")}</Text>}
          {(g?.items ?? []).map((i) => (
            <View key={i.id} style={st.card}>
              <Text style={st.cardTitle}>{i.dimension ? t(`strengths.dimension.${i.dimension}`) : i.subjectId} · {t(`devGuidance.category.${i.category}`)}</Text>
              <Text style={st.label}>{t("devGuidance.noticed")}</Text>
              <Text style={st.sub2}>• {t("devGuidance.observedLine", { state: t(`strengths.state.${i.explanation.observed.state}`), trajectory: t(`development.trajectory.${i.explanation.observed.trajectory}`), n: i.explanation.observed.observations })}</Text>
              <Text style={st.label}>{t("devGuidance.why")}</Text>
              {i.reasons.map((r) => <Text key={r} style={st.sub2}>• {t(`devGuidance.reason.${r}`)}</Text>)}
              <Text style={st.label}>{t("devGuidance.couldTry")}</Text>
              <Text style={st.sub2}>• {t(`devGuidance.categoryStudent.${i.category}`)}</Text>
              {i.suggestedActions.map((a) => <Text key={a.instruction} style={st.sub2}>• {t(`devGuidance.instruction.${a.instruction}`)}</Text>)}
              <Text style={st.label}>{t("devGuidance.watch")}</Text>
              <Text style={st.sub2}>• {i.evidenceToWatch.map((f) => t(`strengths.integration.family.${f}`)).join(", ")}</Text>
            </View>
          ))}

          {/* My active support: proposals the pupil may accept or decline; agreed support with its observed outcome. */}
          <SectionTitle icon="hand-left" accent="green">{t("devIntervention.studentHeading")}</SectionTitle>
          {!(iv?.interventions?.length) && <Text style={st.empty}>{t("devIntervention.none")}</Text>}
          {(iv?.interventions ?? []).map((x) => (
            <View key={x.interventionId} style={st.card}>
              <Text style={st.cardTitle}>{x.dimension ? t(`strengths.dimension.${x.dimension}`) : ""} · {t(`devIntervention.lifecycle.${x.lifecycle}`)}</Text>
              <Text style={st.sub2}>{t("devIntervention.objective")}: {t(`devIntervention.objectiveText.${x.objective}`)}</Text>
              <Text style={st.sub2}>{t("devIntervention.action")}: {t(`devIntervention.actionText.${x.action}`)}</Text>
              <Text style={st.sub2}>{t("devIntervention.owner")}: {x.ownerRole ? t(`devIntervention.role.${x.ownerRole}`) : "—"} · {t("devIntervention.reviewOn", { when: day(x.reviewDate) })}</Text>
              {x.outcome && <Text style={st.sub2}>{t("devIntervention.outcomeHeading")}: {t(`devIntervention.outcome.${x.outcome.outcome}`)} — {t("devIntervention.outcomeNote")}</Text>}
              {x.lifecycle === "PROPOSED" && (
                <View style={st.row}>
                  <TouchableOpacity style={st.btn} onPress={async () => { try { await actOnMyIntervention(x.interventionId, "accept"); await load(); } catch { /* the server said no; the list is unchanged */ } }}><Text style={st.btnText}>{t("devIntervention.accept")}</Text></TouchableOpacity>
                  <TouchableOpacity style={[st.btn, st.btnMuted]} onPress={async () => { try { await actOnMyIntervention(x.interventionId, "decline"); await load(); } catch { /* the server said no; the list is unchanged */ } }}><Text style={st.btnTextMuted}>{t("devIntervention.decline")}</Text></TouchableOpacity>
                </View>
              )}
            </View>
          ))}

          {/* What I want to explore: the exploration loop stays the pupil's own choice. */}
          <TouchableOpacity style={[st.card, st.exploreCard, { alignItems: "center" }]} onPress={() => router.push("/student/explore")} activeOpacity={0.85}>
            <Text style={st.cardTitle}>{t("explore.title")}</Text>
            <Text style={st.sub2}>{t("explore.subtitle")}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  sub: { fontSize: 13, color: COLORS.textSecondary, paddingHorizontal: 16, marginBottom: 8 },
  meta: { fontSize: 12, color: COLORS.textSecondary, marginBottom: 10 },
  empty: { fontSize: 14, color: COLORS.textSecondary, textAlign: "center", marginTop: 24 },
  emptyState: { paddingVertical: 24 },
  card: { backgroundColor: ACCENT.green.wash, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: COLORS.border, borderTopWidth: 3, borderTopColor: ACCENT.green.base },
  exploreCard: { backgroundColor: ACCENT.sky.wash, borderTopColor: ACCENT.sky.base },
  cardTitle: { fontSize: 16, fontWeight: "700", color: COLORS.text, marginBottom: 4 },
  line: { fontSize: 13, color: ACCENT.green.deep, fontWeight: "600" },
  label: { fontSize: 12, fontWeight: "600", color: ACCENT.green.deep, marginTop: 8 },
  sub2: { fontSize: 12, color: COLORS.textSecondary, marginLeft: 6, marginTop: 2 },
  hint: { fontSize: 11, color: COLORS.textSecondary, marginTop: 8 },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16, marginBottom: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: COLORS.text },
  row: { flexDirection: "row", gap: 8, marginTop: 8 },
  btn: { backgroundColor: ACCENT.green.solid, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  btnMuted: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  btnText: { color: COLORS.onPrimary, fontWeight: "600" },
  btnTextMuted: { color: COLORS.textSecondary, fontWeight: "600" },
});
