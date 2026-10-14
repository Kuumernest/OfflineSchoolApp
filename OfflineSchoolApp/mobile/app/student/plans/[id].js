// mobile/app/student/plans/[id].js
//
// One plan, in the pupil's words: why it exists, what I am working on, what
// I can try, my milestones, what I have completed, what I think about it,
// what happens at review. The pupil accepts or declines a proposal, pauses
// or resumes, completes or skips their own milestones (with a reason), and
// reflects with controlled codes. The system's reading is shown as the
// system's; the decisions are the people's.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, TextInput } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { fetchMyPlan, actOnMyPlan, moveMyPlanMilestone, reflectOnMyPlan } from "../../../src/services/exploration.service";

const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const REFLECTIONS = ["USEFUL", "NOT_USEFUL", "TOO_EASY", "TOO_DIFFICULT", "INTERESTING", "NOT_INTERESTING", "NEED_MORE_SUPPORT", "PREFER_DIFFERENT_APPROACH", "RESOURCE_PROBLEM", "OTHER"];
const SKIPS = ["STUDENT_CHOICE", "RESOURCE_UNAVAILABLE", "TIME_CONSTRAINT", "SCHOOL_CONSTRAINT", "SUPPORT_UNAVAILABLE", "OTHER"];

export default function StudentPlanScreen() {
  const router = useRouter();
  const pad = useScreenInsets({ top: 16 });
  const { id } = useLocalSearchParams();
  const { t } = useTranslation();
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState("");
  const [skipping, setSkipping] = useState(null);
  const load = useCallback(async () => { try { setP(await fetchMyPlan(String(id))); } finally { setLoading(false); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn) => { try { await fn(); await load(); } catch { /* the server said no; the plan is unchanged */ } };
  if (loading) return <View style={st.root}><ActivityIndicator style={{ marginTop: 64 }} /></View>;
  if (!p) return <View style={st.root}><Text style={st.empty}>{t("devPlan.none")}</Text></View>;
  const current = p.actions.filter((a) => !a.replacedAt);
  const sr = p.systemReview;
  const canMove = ["ACTIVE", "REVIEW_DUE", "ADAPTING"].includes(p.status);
  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={24} color="#111827" /></TouchableOpacity>
        <Text style={st.title}>{p.dimension ? t(`strengths.dimension.${p.dimension}`) : p.subjectId ?? ""}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <Text style={st.status}>{t(`devPlan.status.${p.status}`)} · {t("devPlan.reviewOn", { when: day(p.reviewSchedule.reviewDate) })}</Text>
        <Text style={st.label}>{t("devPlan.whyExists")}</Text>
        <Text style={st.line}>{t(`devPlan.objectiveText.${p.objective.code}`)}</Text>
        {(p.rationale?.reasons ?? []).map((r) => <Text key={r} style={st.sub2}>• {t(`devGuidance.reason.${r}`)}</Text>)}
        <Text style={st.label}>{t("devPlan.workingOn")}</Text>
        <Text style={st.line}>{t(`devPlan.objectiveCategory.${p.objective.category}`)}</Text>
        <Text style={st.label}>{t("devPlan.canTry")}</Text>
        {current.map((a) => <Text key={a.actionType} style={st.sub2}>• {t(`devPlan.action.${a.actionType}`)}</Text>)}
        <Text style={st.label}>{t("devPlan.myMilestones")}</Text>
        {p.milestones.map((m) => (
          <View key={m.milestoneId} style={st.ms}>
            <Text style={st.sub2}>• {t(`devPlan.milestone.${m.kind}`)} — {t(`devPlan.milestoneState.${m.state}`)}{m.reason ? ` (${t(`devPlan.skip.${m.reason}`)})` : ""}</Text>
            {canMove && m.owner === "STUDENT" && (m.state === "AVAILABLE" || m.state === "STARTED") && (
              <View style={st.row}>
                <TouchableOpacity style={st.btn} onPress={() => run(() => moveMyPlanMilestone(p.planId, m.milestoneId, "complete"))}><Text style={st.btnText}>{t("devPlan.milestoneComplete")}</Text></TouchableOpacity>
                <TouchableOpacity style={[st.btn, st.btnMuted]} onPress={() => setSkipping(skipping === m.milestoneId ? null : m.milestoneId)}><Text style={st.btnTextMuted}>{t("devPlan.milestoneSkip")}</Text></TouchableOpacity>
              </View>
            )}
            {skipping === m.milestoneId && (
              <View style={st.wrap}>{SKIPS.map((r) => <TouchableOpacity key={r} style={st.chip} onPress={() => { setSkipping(null); run(() => moveMyPlanMilestone(p.planId, m.milestoneId, "skip", r)); }}><Text style={st.chipText}>{t(`devPlan.skip.${r}`)}</Text></TouchableOpacity>)}</View>
            )}
          </View>
        ))}
        <Text style={st.label}>{t("devPlan.completed")}</Text>
        {p.milestones.filter((m) => m.state === "COMPLETED").length === 0 ? <Text style={st.sub2}>—</Text> : p.milestones.filter((m) => m.state === "COMPLETED").map((m) => <Text key={m.milestoneId} style={st.sub2}>• {t(`devPlan.milestone.${m.kind}`)}</Text>)}
        <Text style={st.label}>{t("devPlan.myView")}</Text>
        <Text style={st.hint}>{t("devPlan.reflectHint")}</Text>
        <View style={st.wrap}>{REFLECTIONS.map((c) => <TouchableOpacity key={c} style={[st.chip, picked.includes(c) && st.chipOn]} onPress={() => setPicked(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c])}><Text style={[st.chipText, picked.includes(c) && st.chipTextOn]}>{t(`devPlan.reflection.${c}`)}</Text></TouchableOpacity>)}</View>
        <TextInput style={st.input} placeholder={t("devPlan.reflectNote")} value={note} onChangeText={setNote} maxLength={1000} />
        <TouchableOpacity style={[st.btn, !picked.length && st.btnDisabled]} disabled={!picked.length} onPress={() => run(async () => { await reflectOnMyPlan(p.planId, picked, note); setPicked([]); setNote(""); })}><Text style={st.btnText}>{t("devPlan.reflect")}</Text></TouchableOpacity>
        {(p.reflections ?? []).slice(-3).map((x, i) => <Text key={i} style={st.sub2}>• {day(x.at)}: {x.codes.map((c) => t(`devPlan.reflection.${c}`)).join(", ")}</Text>)}
        <Text style={st.label}>{t("devPlan.atReview")}</Text>
        {sr ? (
          <>
            <Text style={st.sub2}>• {t("devPlan.outcomeLine", { outcome: t(`devPlan.outcome.${sr.outcome}`) })}</Text>
            <Text style={st.sub2}>• {t(`devPlan.statement.${sr.statement.code}`)}</Text>
            {sr.adaptation.suggestedActions.length > 0 && <Text style={st.sub2}>• {t("devPlan.possibleNextStep")}: {sr.adaptation.suggestedActions.map((a) => t(`devPlan.action.${a}`)).join(", ")}</Text>}
          </>
        ) : <Text style={st.sub2}>• {t("devPlan.reviewOn", { when: day(p.reviewSchedule.reviewDate) })}</Text>}
        {p.reviews.slice(-2).map((r) => <Text key={r.reviewId} style={st.sub2}>• {day(r.at)}: {t(`devPlan.outcome.${r.outcome ?? "CONTINUE"}`)} · {t(`devPlan.${r.decision}`)}</Text>)}
        <View style={st.row}>
          {p.status === "PROPOSED" && <TouchableOpacity style={st.btn} onPress={() => run(() => actOnMyPlan(p.planId, "accept"))}><Text style={st.btnText}>{t("devPlan.accept")}</Text></TouchableOpacity>}
          {p.status === "PROPOSED" && <TouchableOpacity style={[st.btn, st.btnMuted]} onPress={() => run(() => actOnMyPlan(p.planId, "decline"))}><Text style={st.btnTextMuted}>{t("devPlan.decline")}</Text></TouchableOpacity>}
          {(p.status === "ACTIVE" || p.status === "REVIEW_DUE") && <TouchableOpacity style={[st.btn, st.btnMuted]} onPress={() => run(() => actOnMyPlan(p.planId, "pause"))}><Text style={st.btnTextMuted}>{t("devPlan.pause")}</Text></TouchableOpacity>}
          {p.status === "PAUSED" && <TouchableOpacity style={st.btn} onPress={() => run(() => actOnMyPlan(p.planId, "resume"))}><Text style={st.btnText}>{t("devPlan.resume")}</Text></TouchableOpacity>}
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  status: { fontSize: 13, color: "#6B7280", marginBottom: 8 },
  label: { fontSize: 13, fontWeight: "700", color: "#111827", marginTop: 14, marginBottom: 4 },
  line: { fontSize: 14, color: "#1F2937" },
  sub2: { fontSize: 12, color: "#374151", marginLeft: 6, marginTop: 2 },
  hint: { fontSize: 11, color: "#6B7280", marginBottom: 6 },
  empty: { fontSize: 14, color: "#6B7280", textAlign: "center", marginTop: 64 },
  ms: { marginBottom: 4 },
  row: { flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  chipOn: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  chipText: { fontSize: 12, color: "#374151" },
  chipTextOn: { color: "#FFFFFF" },
  input: { borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8, padding: 8, marginTop: 8, backgroundColor: "#FFFFFF", fontSize: 13 },
  btn: { backgroundColor: "#4F46E5", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, marginTop: 8, alignSelf: "flex-start" },
  btnMuted: { backgroundColor: "#E5E7EB" },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "#FFFFFF", fontWeight: "600" },
  btnTextMuted: { color: "#374151", fontWeight: "600" },
});
