// mobile/app/student/intelligence/ask.js
//
// Ask about my profile: one question about the pupil's own recorded
// evidence, one structured answer. Not a chat — nothing is remembered
// between questions, on the phone or on the server — and not a general
// assistant: the server answers from the evidence context it has for this
// pupil and refuses a question about another pupil, a hidden note or a
// career choice. A career question comes back as exploration: the areas the
// evidence supports, unranked, and the statement that the choice is the
// pupil's.
//
// The answer is rendered as what it is: its mode (the deterministic layer,
// or a model whose every sentence the server validated against the
// evidence), the date the evidence stands at, the answer, each statement
// typed — observed, an engine's conclusion, an exploration suggestion,
// uncertain, not available — with the records it rests on named in plain
// words, what the evidence does not settle, its limits, and questions the
// pupil could ask next. A suggested question fills the box; the pupil
// presses the button.
//
// Offline, the box is closed and the screen says why: explanations need a
// connection; the summary and every other screen do not.

import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, StatusBar, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { useSyncStatus } from "../../../src/hooks/useSyncStatus";
import { askAboutMyProfile, MAX_QUESTION, citationId, describeCitation } from "../../../src/services/intelligence.service";

const PROMPTS = ["profile", "changed", "evidence", "guidance", "plan", "explore"];
const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const humanCode = (s) => String(s ?? "").toLowerCase().replace(/_/g, " ");

export default function StudentAskScreen() {
  const router = useRouter();
  const { t, language } = useTranslation();
  const pad = useScreenInsets({ top: 16 });
  const { isConnected } = useSyncStatus({ poll: false });
  const lang = String(language ?? "en").startsWith("fr") ? "fr" : "en";
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);   // an i18n key under intel.error, never a server message

  const offline = isConnected === false;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true); setProblem(null);
    try {
      // An open question goes to /ask; the six suggested ones are explanations. The server classifies either way.
      const looksOpen = /\b(career|job|profession|explore|areas?|future|m[ée]tier|explorer|domaines?)\b/i.test(q);
      const r = await askAboutMyProfile(q, { operation: looksOpen ? "answer" : "explain", lang });
      setResult(r);
    } catch (err) {
      const code = err?.response?.data?.code;
      setProblem(err?.isOffline ? "offline" : err?.code === "ECONNABORTED" ? "timeout" : err?.response?.status === 403 ? "forbidden" : code === "QUESTION_TOO_LONG" ? "tooLong" : code === "QUESTION_REQUIRED" ? "required" : "generic");
    } finally { setBusy(false); }
  };

  const out = result?.output ?? null;
  const items = new Map((result?.citations ?? []).map((c) => [c.sourceId, c.item]));
  const cite = (c) => describeCitation(items.get(citationId(c)) ?? null, t);
  const badgeStyle = (type) => (type === "OBSERVED" ? st.badgeGood : type === "INFERRED_BY_DETERMINISTIC_ENGINE" ? st.badgeInfo : type === "SUGGESTED_EXPLORATION" ? st.badgePurple : type === "UNCERTAIN" ? st.badgeWarn : st.badgeMuted);

  return (
    <KeyboardAvoidingView style={st.root} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.goBack")}>
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={st.title} accessibilityRole="header">{t("intel.askTitle")}</Text>
      </View>
      <Text style={st.sub}>{t("intel.askSubtitle")}</Text>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: pad.paddingBottom + 16 }} keyboardShouldPersistTaps="handled">
        {offline && (
          <View style={st.offlineBox} accessibilityRole="alert">
            <Ionicons name="cloud-offline-outline" size={16} color="#92400E" />
            <View style={{ flex: 1 }}>
              <Text style={st.offlineTitle}>{t("intel.aiOfflineTitle")}</Text>
              <Text style={st.offlineText}>{t("intel.aiOffline")}</Text>
              <TouchableOpacity onPress={() => router.back()} accessibilityRole="link"><Text style={st.linkText}>{t("intel.backToSummary")}</Text></TouchableOpacity>
            </View>
          </View>
        )}

        <Text style={st.label} accessibilityRole="header">{t("intel.promptsLabel")}</Text>
        <View style={st.chips} accessibilityRole="menu">
          {PROMPTS.map((k) => (
            <TouchableOpacity key={k} style={st.chip} onPress={() => setQuestion(t(`intel.prompt.${k}`))} disabled={offline} accessibilityRole="button" accessibilityState={{ disabled: offline }}>
              <Text style={st.chipText}>{t(`intel.prompt.${k}`)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={st.label}>{t("intel.questionLabel")}</Text>
        <TextInput
          style={st.input} value={question} onChangeText={setQuestion} multiline maxLength={MAX_QUESTION} editable={!offline && !busy}
          placeholder={t("intel.questionPlaceholder")} placeholderTextColor="#9CA3AF" accessibilityLabel={t("intel.questionLabel")}
        />
        <Text style={st.hint}>{t("intel.questionHint", { max: MAX_QUESTION })}</Text>
        <TouchableOpacity
          style={[st.btn, (offline || busy || !question.trim()) && st.btnDisabled]} onPress={ask} disabled={offline || busy || !question.trim()}
          accessibilityRole="button" accessibilityLabel={t("intel.askButton")} accessibilityState={{ disabled: offline || busy || !question.trim(), busy }}
        >
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="send-outline" size={16} color="#FFFFFF" />}
          <Text style={st.btnText}>{busy ? t("intel.asking") : t("intel.askButton")}</Text>
        </TouchableOpacity>
        <Text style={st.agency}>{t("intel.agency")}</Text>

        {problem && (
          <View style={st.problemBox} accessibilityRole="alert">
            <Text style={st.problemText}>{t(`intel.error.${problem}`)}</Text>
          </View>
        )}

        {result && out && (
          <View style={st.answerCard} accessibilityLiveRegion="polite">
            <View style={st.rowWrap}>
              <Text style={[st.badge, result.mode === "MODEL_VALIDATED" ? st.badgeInfo : result.mode === "REFUSED" ? st.badgeWarn : st.badgeMuted]}>{t(`intel.mode.${result.mode}`)}</Text>
              {result.classification?.transformed === "CAREER_TO_EXPLORATION" && <Text style={[st.badge, st.badgePurple]}>{t("intel.careerTransformed")}</Text>}
            </View>
            {result.fallbackReason && result.mode === "DETERMINISTIC_FALLBACK" && <Text style={st.hint}>{t(`intel.reason.${result.fallbackReason}`, { defaultValue: humanCode(result.fallbackReason) })}</Text>}
            <Text style={st.hint}>{t("intel.asOf", { date: day(result.asOf) })}</Text>

            <Text style={st.answer}>{out.answer}</Text>

            {out.claims?.length > 0 && (
              <View style={st.block}>
                <Text style={st.blockTitle} accessibilityRole="header">{t("intel.whyHeading")}</Text>
                <Text style={st.hint}>{t("intel.whyHint")}</Text>
                {out.claims.map((c, i) => (
                  <View key={i} style={st.claim}>
                    <Text style={[st.badge, badgeStyle(c.type)]}>{t(`intel.claimType.${c.type}`)}</Text>
                    <Text style={st.claimText}>{c.text}</Text>
                    {c.citations?.length > 0 && <Text style={st.hint}>{t("intel.basedOn")}: {c.citations.map(cite).join("; ")}</Text>}
                  </View>
                ))}
              </View>
            )}

            {out.uncertainty ? <View style={st.block}><Text style={st.blockTitle}>{t("intel.uncertaintyHeading")}</Text><Text style={st.sub2}>{out.uncertainty}</Text></View> : null}

            {out.limitations?.length > 0 && (
              <View style={st.block}>
                <Text style={st.blockTitle}>{t("intel.limitations")}</Text>
                <Text style={st.sub2}>{out.limitations.map((l) => t(`intel.limitation.${String(l).split(":")[0]}`, { defaultValue: humanCode(l) })).join("; ")}</Text>
              </View>
            )}

            {out.suggestedQuestions?.length > 0 && (
              <View style={st.block}>
                <Text style={st.blockTitle}>{t("intel.suggestedHeading")}</Text>
                <View style={st.chips}>
                  {out.suggestedQuestions.map((q) => (
                    <TouchableOpacity key={q} style={st.chip} onPress={() => setQuestion(q)} accessibilityRole="button"><Text style={st.chipText}>{q}</Text></TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "700", color: "#111827" },
  sub: { fontSize: 13, color: "#6B7280", paddingHorizontal: 16, marginBottom: 8 },
  label: { fontSize: 12, fontWeight: "600", color: "#4B5563", marginTop: 10, marginBottom: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#EEF2FF", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 12, color: "#3730A3" },
  input: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 10, padding: 12, minHeight: 72, fontSize: 14, color: "#111827", textAlignVertical: "top" },
  hint: { fontSize: 11, color: "#6B7280", marginTop: 4 },
  btn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#4F46E5", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, marginTop: 10, alignSelf: "flex-start" },
  btnDisabled: { backgroundColor: "#A5B4FC" },
  btnText: { color: "#FFFFFF", fontWeight: "600", fontSize: 14 },
  agency: { fontSize: 12, color: "#4B5563", marginTop: 8, fontStyle: "italic" },
  offlineBox: { flexDirection: "row", gap: 8, backgroundColor: "#FEF3C7", borderRadius: 10, padding: 12, marginBottom: 6 },
  offlineTitle: { fontSize: 13, fontWeight: "700", color: "#92400E" },
  offlineText: { fontSize: 12, color: "#92400E", marginTop: 2 },
  linkText: { fontSize: 13, color: "#4F46E5", fontWeight: "600", marginTop: 6 },
  problemBox: { backgroundColor: "#FEF2F2", borderRadius: 10, padding: 12, marginTop: 10 },
  problemText: { fontSize: 13, color: "#991B1B" },
  answerCard: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginTop: 14, borderWidth: 1, borderColor: "#E5E7EB" },
  rowWrap: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  badge: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden", alignSelf: "flex-start" },
  badgeGood: { color: "#065F46", backgroundColor: "#ECFDF5" },
  badgeWarn: { color: "#92400E", backgroundColor: "#FEF3C7" },
  badgeInfo: { color: "#3730A3", backgroundColor: "#EEF2FF" },
  badgePurple: { color: "#6B21A8", backgroundColor: "#F3E8FF" },
  badgeMuted: { color: "#374151", backgroundColor: "#F3F4F6" },
  answer: { fontSize: 14, color: "#111827", marginTop: 10, lineHeight: 20 },
  block: { marginTop: 12, borderTopWidth: 1, borderTopColor: "#F3F4F6", paddingTop: 8 },
  blockTitle: { fontSize: 12, fontWeight: "700", color: "#4B5563" },
  claim: { marginTop: 8 },
  claimText: { fontSize: 13, color: "#1F2937", marginTop: 4 },
  sub2: { fontSize: 12, color: "#374151", marginTop: 4 },
});
