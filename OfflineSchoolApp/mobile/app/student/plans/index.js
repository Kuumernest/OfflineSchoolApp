// mobile/app/student/plans/index.js
//
// My development plans: the plans a pupil is part of — active plans, the
// next milestones, recent reviews, what changed, the pupil's own
// reflections. Plain words; no engine terms. The pupil accepts, declines,
// pauses, completes milestones and reflects; nothing here is a mark or a
// judgement. Online only: the plan and the reading beside it are the
// server's, derived from the same records the teacher sees.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, StatusBar, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { fetchMyPlans } from "../../../src/services/exploration.service";

const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const OPEN = ["PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "PAUSED"];

export default function StudentPlansScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const pad = useScreenInsets({ top: 16 });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => { try { setData(await fetchMyPlans()); } finally { setLoading(false); setRefreshing(false); } }, []);
  useEffect(() => { load(); }, [load]);
  const plans = data?.plans ?? [];
  const active = plans.filter((p) => OPEN.includes(p.status));
  const upcoming = active.flatMap((p) => p.milestones.filter((m) => m.state === "AVAILABLE" || m.state === "STARTED").map((m) => ({ plan: p, m })));
  const reviews = plans.flatMap((p) => p.reviews.map((r) => ({ plan: p, r }))).sort((a, b) => (a.r.at < b.r.at ? 1 : -1)).slice(0, 5);
  const changes = plans.flatMap((p) => p.adaptations.map((a) => ({ plan: p, a }))).sort((a, b) => (a.a.at < b.a.at ? 1 : -1)).slice(0, 5);
  const reflections = plans.flatMap((p) => (p.reflections ?? []).map((x) => ({ plan: p, x }))).sort((a, b) => (a.x.at < b.x.at ? 1 : -1)).slice(0, 5);
  const label = (p) => `${p.dimension ? t(`strengths.dimension.${p.dimension}`) : p.subjectId ?? ""} · ${t(`devPlan.objectiveCategory.${p.objective.category}`)}`;
  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={24} color="#111827" /></TouchableOpacity>
        <Text style={st.title}>{t("devPlan.studentTitle")}</Text>
      </View>
      {loading ? <ActivityIndicator style={{ marginTop: 32 }} /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
          <Text style={st.sectionTitle}>{t("devPlan.activePlans")}</Text>
          {active.length === 0 && <Text style={st.empty}>{t("devPlan.none")}</Text>}
          {active.map((p) => (
            <TouchableOpacity key={p.planId} style={st.card} onPress={() => router.push({ pathname: "/student/plans/[id]", params: { id: p.planId } })} activeOpacity={0.85}>
              <Text style={st.cardTitle}>{label(p)}</Text>
              <Text style={st.sub2}>{t(`devPlan.objectiveText.${p.objective.code}`)} · {t(`devPlan.status.${p.status}`)}</Text>
              <Text style={st.sub2}>{t("devPlan.reviewOn", { when: day(p.reviewSchedule.reviewDate) })}</Text>
            </TouchableOpacity>
          ))}
          <Text style={st.sectionTitle}>{t("devPlan.upcoming")}</Text>
          {upcoming.length === 0 && <Text style={st.empty}>—</Text>}
          {upcoming.map(({ plan, m }) => <Text key={`${plan.planId}:${m.milestoneId}`} style={st.line}>• {t(`devPlan.milestone.${m.kind}`)} — {label(plan)}</Text>)}
          <Text style={st.sectionTitle}>{t("devPlan.recentReviews")}</Text>
          {reviews.length === 0 && <Text style={st.empty}>—</Text>}
          {reviews.map(({ plan, r }) => <Text key={`${plan.planId}:${r.reviewId}`} style={st.line}>• {day(r.at)} · {label(plan)} · {t(`devPlan.outcome.${r.outcome ?? "CONTINUE"}`)} · {t(`devPlan.${r.decision}`)}</Text>)}
          <Text style={st.sectionTitle}>{t("devPlan.whatChanged")}</Text>
          {changes.length === 0 && <Text style={st.empty}>—</Text>}
          {changes.map(({ plan, a }) => <Text key={`${plan.planId}:${a.index}`} style={st.line}>• {day(a.at)} · {label(plan)} · {t("devPlan.changedLine", { from: a.previous.actions.map((x) => t(`devPlan.action.${x}`)).join(", "), to: a.next.actions.map((x) => t(`devPlan.action.${x}`)).join(", ") })}</Text>)}
          <Text style={st.sectionTitle}>{t("devPlan.myReflections")}</Text>
          {reflections.length === 0 && <Text style={st.empty}>—</Text>}
          {reflections.map(({ plan, x }, i) => <Text key={i} style={st.line}>• {day(x.at)} · {label(plan)} · {x.codes.map((c) => t(`devPlan.reflection.${c}`)).join(", ")}</Text>)}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginTop: 12, marginBottom: 6 },
  empty: { fontSize: 13, color: "#6B7280" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 2 },
  line: { fontSize: 13, color: "#1F2937", marginBottom: 4 },
  sub2: { fontSize: 12, color: "#374151", marginTop: 2 },
});
