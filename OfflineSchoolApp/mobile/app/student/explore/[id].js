// app/student/explore/[id].js
"use strict";

/**
 * One activity, or one exploration of it.
 *
 *   title · why it is available (in words, from the reasons) · what you will
 *   do · time · resources · level · expected output — then Start / Save / Skip /
 *   Not interested.
 *
 * Once started: what did you produce (one line per expected output), how did
 * it feel (three choices), what was difficult, would you try something
 * similar, and whether to share the written answers with teachers. Submit
 * says "Your exploration has been recorded." It never says the pupil is
 * talented at anything; a future profile update reads the evidence.
 */

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Switch, StatusBar, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import {
  getActivity, getExploration, getSuggestions, chooseActivity, startExploration, abandonExploration, submitExploration,
} from "../../../src/services/exploration.service";

const INTEREST = ["LOW", "MODERATE", "HIGH"];
const DIFFICULTY = ["EASY", "MANAGEABLE", "DIFFICULT", "VERY_DIFFICULT"];
const CONTINUE = ["NO", "MAYBE", "YES"];

export default function ExploreDetailScreen() {
  const router = useRouter();
  const pad = useScreenInsets({ top: 16 });
  const { id, kind } = useLocalSearchParams();
  const { t, language } = useTranslation();
  const lang = String(language ?? "en").startsWith("fr") ? "fr" : "en";

  const [activity, setActivity] = useState(null);
  const [exploration, setExploration] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [outputs, setOutputs] = useState({});
  const [reflection, setReflection] = useState({ interest: null, difficulty: null, continue: null, enjoyed: "", difficult: "", next: "", shareText: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    if (kind === "exploration") {
      const e = await getExploration(String(id));
      setExploration(e);
      if (e) setActivity(await getActivity(e.activityId, lang));
    } else {
      setActivity(await getActivity(String(id), lang));
      const s = await getSuggestions();
      setSuggestion((s.suggestions ?? []).find((x) => x.activityId === String(id)) ?? null);
    }
  }, [id, kind, lang]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, after) => {
    if (busy) return;
    setBusy(true);
    try { const r = await fn(); after?.(r); } catch (err) { Alert.alert(t("explore.error.generic"), String(err?.message ?? "")); } finally { setBusy(false); }
  };

  const choose = (action) => act(() => chooseActivity({ activity, suggestion, action }), (e) => {
    if (action === "start") { setExploration(e); return; }
    Alert.alert(t(action === "save" ? "explore.saved" : action === "skip" ? "explore.skipped" : "explore.declinedOk"));
    router.back();
  });

  const submit = () => {
    const list = (activity?.expectedOutputs ?? []).map((label) => ({ label, value: (outputs[label] ?? "").trim() })).filter((o) => o.value);
    if (!list.length) { Alert.alert(t("explore.outputRequired")); return; }
    const r = { ...reflection, enjoyed: reflection.enjoyed.trim() || null, difficult: reflection.difficult.trim() || null, next: reflection.next.trim() || null };
    act(() => submitExploration(exploration.explorationId, { outputs: list, reflection: r }), () => setDone(true));
  };

  if (!activity) return <View style={st.root}><Text style={st.empty}>…</Text></View>;

  const status = exploration?.status ?? null;
  const canStart = !exploration || ["SAVED", "SKIPPED", "DISCOVERED"].includes(status);
  const inProgress = status === "STARTED";

  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: pad.paddingTop, paddingBottom: 64 }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={{ marginBottom: 8 }}><Ionicons name="chevron-back" size={24} color="#111827" /></TouchableOpacity>
        <Text style={st.title}>{activity.title}</Text>
        <Text style={st.meta}>{t(`explore.area.${activity.area}`)} · {t(`explore.level.${activity.level}`)} · {t("explore.minutes", { n: activity.estimatedMinutes })}</Text>
        {status && <Text style={st.badge}>{t(`explore.status.${status}`)}</Text>}

        {done ? (
          <View style={st.box}>
            <Text style={st.h}>{t("explore.recorded")}</Text>
            <Text style={st.p}>{t("explore.recordedHint")}</Text>
            <TouchableOpacity style={st.primary} onPress={() => router.back()}><Text style={st.primaryText}>{t("common.close", { defaultValue: "Close" })}</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            {(suggestion?.reasons?.length || exploration?.suggestedBecause?.length) ? (
              <View style={st.box}>
                <Text style={st.h}>{t("explore.whyAvailable")}</Text>
                <Text style={st.p}>{(suggestion?.reasons ?? exploration?.suggestedBecause ?? []).map((r) => t(`explore.reason.${r}`)).join("; ")}</Text>
                {suggestion?.supportingSubjects?.length ? <Text style={st.small}>{suggestion.supportingSubjects.map((s) => s.subjectName ?? s.subjectId).join(", ")}</Text> : null}
              </View>
            ) : null}
            <View style={st.box}>
              <Text style={st.h}>{t("explore.whatYouWillDo")}</Text>
              <Text style={st.p}>{activity.task}</Text>
            </View>
            <View style={st.box}>
              <Text style={st.h}>{t("explore.resources")}</Text>
              <Text style={st.p}>{activity.resources.map((r) => t(`explore.resource.${r}`)).join(", ")}</Text>
              <Text style={[st.h, { marginTop: 10 }]}>{t("explore.expectedOutput")}</Text>
              {activity.expectedOutputs.map((o) => <Text key={o} style={st.p}>• {o}</Text>)}
            </View>

            {canStart && (
              <View style={st.actions}>
                <TouchableOpacity style={st.primary} disabled={busy} onPress={() => choose("start")}><Text style={st.primaryText}>{t("explore.start")}</Text></TouchableOpacity>
                {!exploration && <TouchableOpacity style={st.secondary} disabled={busy} onPress={() => choose("save")}><Text style={st.secondaryText}>{t("explore.save")}</Text></TouchableOpacity>}
                {!exploration && <TouchableOpacity style={st.secondary} disabled={busy} onPress={() => choose("skip")}><Text style={st.secondaryText}>{t("explore.skip")}</Text></TouchableOpacity>}
                {!exploration && <TouchableOpacity style={st.ghost} disabled={busy} onPress={() => choose("not_interested")}><Text style={st.ghostText}>{t("explore.notInterested")}</Text></TouchableOpacity>}
                {exploration && <TouchableOpacity style={st.secondary} disabled={busy} onPress={() => act(() => startExploration(exploration.explorationId), setExploration)}><Text style={st.secondaryText}>{t("explore.continueIt")}</Text></TouchableOpacity>}
              </View>
            )}

            {inProgress && (
              <View style={st.box}>
                <Text style={st.h}>{t("explore.whatDidYouProduce")}</Text>
                {activity.expectedOutputs.map((label) => (
                  <View key={label} style={{ marginBottom: 8 }}>
                    <Text style={st.small}>{label}</Text>
                    <TextInput style={st.input} multiline value={outputs[label] ?? ""} onChangeText={(v) => setOutputs((o) => ({ ...o, [label]: v }))} />
                  </View>
                ))}
                <Text style={st.h}>{t("explore.howDidItFeel")}</Text>
                <Chips label={t("explore.interestQ")} values={INTEREST} value={reflection.interest} onPick={(v) => setReflection((r) => ({ ...r, interest: v }))} t={t} />
                <Chips label={t("explore.difficultyQ")} values={DIFFICULTY} value={reflection.difficulty} onPick={(v) => setReflection((r) => ({ ...r, difficulty: v }))} t={t} />
                <Chips label={t("explore.continueQ")} values={CONTINUE} value={reflection.continue} onPick={(v) => setReflection((r) => ({ ...r, continue: v }))} t={t} />
                <Text style={st.small}>{t("explore.whatWasDifficult")}</Text>
                <TextInput style={st.input} multiline value={reflection.difficult} onChangeText={(v) => setReflection((r) => ({ ...r, difficult: v }))} />
                <Text style={st.small}>{t("explore.tryAgain")}</Text>
                <TextInput style={st.input} multiline value={reflection.enjoyed} onChangeText={(v) => setReflection((r) => ({ ...r, enjoyed: v }))} />
                <Text style={st.small}>{t("explore.whatNext")}</Text>
                <TextInput style={st.input} multiline value={reflection.next} onChangeText={(v) => setReflection((r) => ({ ...r, next: v }))} />
                <View style={[st.rowBetween, { marginTop: 8 }]}>
                  <Text style={[st.p, { flex: 1 }]}>{t("explore.shareText")}</Text>
                  <Switch value={reflection.shareText} onValueChange={(v) => setReflection((r) => ({ ...r, shareText: v }))} />
                </View>
                <Text style={st.small}>{t("explore.sharePrivate")}</Text>
                <TouchableOpacity style={[st.primary, { marginTop: 12 }]} disabled={busy} onPress={submit}><Text style={st.primaryText}>{t("explore.submit")}</Text></TouchableOpacity>
                <TouchableOpacity style={st.ghost} disabled={busy} onPress={() => act(() => abandonExploration(exploration.explorationId), () => router.back())}><Text style={st.ghostText}>{t("explore.abandon")}</Text></TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Chips({ label, values, value, onPick, t }) {
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={st.small}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {values.map((v) => (
          <TouchableOpacity key={v} style={[st.chip, value === v && st.chipOn]} onPress={() => onPick(v)}>
            <Text style={[st.chipText, value === v && st.chipTextOn]}>{t(`explore.scale.${v}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  title: { fontSize: 22, fontWeight: "700", color: "#111827" },
  meta: { color: "#6B7280", fontSize: 13, marginTop: 2, marginBottom: 6 },
  badge: { alignSelf: "flex-start", fontSize: 11, color: "#3730A3", backgroundColor: "#EEF2FF", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, marginBottom: 8 },
  box: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginTop: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  h: { fontSize: 12, fontWeight: "700", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  p: { fontSize: 14, color: "#111827", lineHeight: 20 },
  small: { fontSize: 12, color: "#6B7280", marginTop: 6, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8, padding: 10, minHeight: 44, backgroundColor: "#FFFFFF", color: "#111827" },
  actions: { marginTop: 14, gap: 8 },
  primary: { backgroundColor: "#4F46E5", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#FFFFFF", fontWeight: "700" },
  secondary: { backgroundColor: "#EEF2FF", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: "#3730A3", fontWeight: "600" },
  ghost: { paddingVertical: 10, alignItems: "center" },
  ghostText: { color: "#6B7280" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "#E5E7EB" },
  chipOn: { backgroundColor: "#4F46E5" },
  chipText: { fontSize: 13, color: "#374151" },
  chipTextOn: { color: "#FFFFFF", fontWeight: "600" },
  empty: { textAlign: "center", color: "#6B7280", marginTop: 80 },
});
