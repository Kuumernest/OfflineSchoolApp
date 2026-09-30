// mobile/app/student/intelligence/feedback.js
//
// Six questions about the pupil's own summary, asked only while the school
// runs a validation pilot (Stage 18). Each is answered from four words —
// yes, partly, no, not shown — and there is no box to type in: the pilot
// wants to know whether a pupil could understand what the system observed,
// inferred, left uncertain, supported with evidence, opened to explore and
// left to them to choose. A pupil is never asked whether an algorithm is
// "correct", and nothing answered here changes anything about them.
//
// Online only, for the same reason a question is: a pilot may close while
// the phone is away. Offline, the screen says so and offers nothing to tap.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { useSyncStatus } from "../../../src/hooks/useSyncStatus";
import { getMyPilotFeedback, submitMyPilotFeedback, FEEDBACK_QUESTIONS, FEEDBACK_ANSWERS } from "../../../src/services/intelligence.service";

export default function StudentPilotFeedbackScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const pad = useScreenInsets({ top: 16 });
  const { isConnected } = useSyncStatus({ poll: false });
  const [status, setStatus] = useState(null);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState(null);   // an i18n key under intel.feedback.error, never a server message

  const offline = isConnected === false;

  const load = useCallback(async () => {
    try {
      const s = await getMyPilotFeedback();
      setStatus(s);
      if (s?.mine?.answers) setAnswers(s.mine.answers);
      setProblem(null);
    } catch (err) {
      setStatus(null);
      setProblem(err?.isOffline ? "offline" : "generic");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const complete = FEEDBACK_QUESTIONS.every((q) => FEEDBACK_ANSWERS.includes(answers[q]));
  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true); setProblem(null);
    try {
      await submitMyPilotFeedback(answers);
      setDone(true);
    } catch (err) {
      const code = err?.response?.data?.code;
      setProblem(err?.isOffline ? "offline" : code === "NO_PILOT_COLLECTING" ? "closed" : "generic");
    } finally { setBusy(false); }
  };

  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.goBack")}>
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={st.title} accessibilityRole="header">{t("intel.feedback.title")}</Text>
      </View>
      <Text style={st.sub}>{t("intel.feedback.subtitle")}</Text>

      {loading ? <ActivityIndicator style={{ marginTop: 32 }} accessibilityLabel={t("common.loading")} /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: pad.paddingBottom + 16 }}>
          {(offline || problem === "offline") && (
            <View style={st.offlineBox} accessibilityRole="alert">
              <Ionicons name="cloud-offline-outline" size={18} color="#D97706" />
              <View style={{ flex: 1 }}>
                <Text style={st.offlineTitle}>{t("intel.feedback.offlineTitle")}</Text>
                <Text style={st.offlineText}>{t("intel.feedback.offline")}</Text>
              </View>
            </View>
          )}

          {!offline && status && !status.open && !done && (
            <Text style={st.empty}>{t("intel.feedback.notCollecting")}</Text>
          )}

          {done && (
            <View style={st.note} accessibilityLiveRegion="polite">
              <Text style={st.noteTitle}>{t("intel.feedback.thanksTitle")}</Text>
              <Text style={st.noteText}>{t("intel.feedback.thanks")}</Text>
            </View>
          )}

          {!offline && status?.open && !done && (
            <>
              <View style={st.note}>
                <Text style={st.noteTitle}>{t("intel.feedback.aboutTitle")}</Text>
                <Text style={st.noteText}>{t("intel.feedback.about")}</Text>
              </View>
              {status.submitted && <Text style={st.hint}>{t("intel.feedback.alreadyAnswered")}</Text>}

              {FEEDBACK_QUESTIONS.map((q) => (
                <View key={q} style={st.card}>
                  <Text style={st.question} accessibilityRole="header">{t(`intel.feedback.q.${q}`)}</Text>
                  <View style={st.chips} accessibilityRole="radiogroup">
                    {FEEDBACK_ANSWERS.map((a) => {
                      const on = answers[q] === a;
                      return (
                        <TouchableOpacity key={a} style={[st.chip, on && st.chipOn]} onPress={() => setAnswers((x) => ({ ...x, [q]: a }))}
                          accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={t(`intel.feedback.a.${a}`)}>
                          <Text style={[st.chipText, on && st.chipTextOn]}>{t(`intel.feedback.a.${a}`)}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ))}

              <TouchableOpacity style={[st.btn, (!complete || busy) && st.btnDisabled]} onPress={submit} disabled={!complete || busy}
                accessibilityRole="button" accessibilityLabel={t("intel.feedback.submit")} accessibilityState={{ disabled: !complete || busy }}>
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#FFFFFF" />}
                <Text style={st.btnText}>{t("intel.feedback.submit")}</Text>
              </TouchableOpacity>
              {!complete && <Text style={st.hint}>{t("intel.feedback.answerAll")}</Text>}
              <Text style={st.agency}>{t("intel.feedback.agency")}</Text>
            </>
          )}

          {problem && problem !== "offline" && (
            <View style={st.problemBox} accessibilityRole="alert">
              <Text style={st.problemText}>{t(`intel.feedback.error.${problem}`)}</Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  sub: { fontSize: 13, color: "#6B7280", paddingHorizontal: 16, marginBottom: 8 },
  note: { backgroundColor: "#EEF2FF", borderRadius: 12, padding: 12, marginBottom: 10 },
  noteTitle: { fontSize: 13, fontWeight: "700", color: "#3730A3", marginBottom: 2 },
  noteText: { fontSize: 12, color: "#3730A3" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  question: { fontSize: 14, fontWeight: "600", color: "#111827", marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#F3F4F6", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: "#E5E7EB" },
  chipOn: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  chipText: { fontSize: 12, color: "#374151" },
  chipTextOn: { color: "#FFFFFF", fontWeight: "600" },
  btn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#4F46E5", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, marginTop: 6, alignSelf: "flex-start" },
  btnDisabled: { backgroundColor: "#A5B4FC" },
  btnText: { color: "#FFFFFF", fontWeight: "600", fontSize: 14 },
  hint: { fontSize: 11, color: "#6B7280", marginTop: 6 },
  agency: { fontSize: 12, color: "#4B5563", marginTop: 10, fontStyle: "italic" },
  empty: { fontSize: 13, color: "#6B7280" },
  offlineBox: { flexDirection: "row", gap: 8, backgroundColor: "#FEF3C7", borderRadius: 10, padding: 12, marginBottom: 10 },
  offlineTitle: { fontSize: 13, fontWeight: "700", color: "#92400E" },
  offlineText: { fontSize: 12, color: "#92400E", marginTop: 2 },
  problemBox: { backgroundColor: "#FEF2F2", borderRadius: 10, padding: 12, marginTop: 10 },
  problemText: { fontSize: 13, color: "#991B1B" },
});
