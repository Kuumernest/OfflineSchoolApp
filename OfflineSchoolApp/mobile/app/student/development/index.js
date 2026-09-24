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
import { fetchMyDevelopment } from "../../../src/services/exploration.service";

const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");

export default function StudentDevelopmentScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [h, setH] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setH(await fetchMyDevelopment()); } finally { setLoading(false); setRefreshing(false); }
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
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={24} color="#111827" /></TouchableOpacity>
        <Text style={st.title}>{t("development.studentTitle")}</Text>
      </View>
      <Text style={st.sub}>{t("development.studentSubtitle")}</Text>
      {loading ? <ActivityIndicator style={{ marginTop: 32 }} /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
          {(!h || !h.history || h.history.observationCount === 0) && <Text style={st.empty}>{t("development.noHistory")}</Text>}
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
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 52, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  sub: { fontSize: 13, color: "#6B7280", paddingHorizontal: 16, marginBottom: 8 },
  meta: { fontSize: 12, color: "#6B7280", marginBottom: 10 },
  empty: { fontSize: 14, color: "#6B7280", textAlign: "center", marginTop: 24 },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 4 },
  line: { fontSize: 13, color: "#1F2937" },
  label: { fontSize: 12, fontWeight: "600", color: "#4B5563", marginTop: 8 },
  sub2: { fontSize: 12, color: "#374151", marginLeft: 6, marginTop: 2 },
  hint: { fontSize: 11, color: "#6B7280", marginTop: 8 },
});
