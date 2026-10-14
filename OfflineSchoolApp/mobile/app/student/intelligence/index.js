// mobile/app/student/intelligence/index.js
//
// My intelligence: the pupil's own summary — the engines' readings lined
// up, in plain words — and the doors to the screens that already exist
// for each part of it: strengths and exploration, development, plans. Not
// a second copy of those screens; a connected entry point, with one thing
// only it offers: a way to ask about the evidence.
//
// Deterministic first. Everything on this screen is the engines' reading;
// the explanation layer decides nothing and computes nothing, and the note
// at the top says so. Nothing here is a mark, a rank or a prediction.
//
// Offline: the last summary taken is shown, dated, and said to be the last
// one. That is the intelligence, still available. Asking needs a
// connection, which the ask screen says on its own — a different condition,
// shown differently.

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, StatusBar, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { refreshMyIntelligenceSummary, getCachedIntelligenceSummary, getMyPilotFeedback } from "../../../src/services/intelligence.service";

const day = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const humanCode = (s) => String(s ?? "").toLowerCase().replace(/_/g, " ");

export default function StudentIntelligenceScreen() {
  const router = useRouter();
  const { t, language } = useTranslation();
  const pad = useScreenInsets({ top: 16 });
  const lang = String(language ?? "en").startsWith("fr") ? "fr" : "en";
  const [data, setData] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Whether the school's validation pilot is collecting the pupil's answers.
  // Online only, never mirrored: a pilot may close while the phone is away.
  const [pilot, setPilot] = useState(null);

  const load = useCallback(async () => {
    try {
      const fresh = await refreshMyIntelligenceSummary(lang);
      setData(fresh); setFetchedAt(null); setOffline(false);
      getMyPilotFeedback().then(setPilot).catch(() => setPilot(null));
    } catch {
      // No server: the last summary taken, and the date it was taken.
      const cached = await getCachedIntelligenceSummary();
      setData(cached?.summary ?? null); setFetchedAt(cached?.fetchedAt ?? null); setOffline(true);
    } finally { setLoading(false); setRefreshing(false); }
  }, [lang]);
  useEffect(() => { load(); }, [load]);

  const dims = data?.synthesis?.dimensions ?? [];
  const overall = data?.synthesis?.overall ?? null;
  const candidates = data?.exploration?.candidates ?? [];
  const dimName = (d) => t(`strengths.dimension.${d}`);
  const go = (pathname) => router.push(pathname);

  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[st.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.goBack")}>
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={st.title} accessibilityRole="header">{t("intel.title")}</Text>
      </View>
      <Text style={st.sub}>{t("intel.subtitle")}</Text>

      {loading ? <ActivityIndicator style={{ marginTop: 32 }} accessibilityLabel={t("common.loading")} /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: pad.paddingBottom + 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
          {offline && (
            <View style={st.staleBar} accessibilityRole="alert">
              <Ionicons name="cloud-offline-outline" size={16} color="#D97706" />
              <Text style={st.staleText}>{fetchedAt ? t("intel.offlineCached", { when: day(fetchedAt) }) : t("intel.offlineNone")}</Text>
            </View>
          )}

          <View style={st.note}>
            <Text style={st.noteTitle}>{t("intel.aiNoteTitle")}</Text>
            <Text style={st.noteText}>{t("intel.aiNote")}</Text>
          </View>

          {!data && !offline && <Text style={st.empty}>{t("intel.noProfile")}</Text>}

          {data && (
            <>
              {/* My strengths — the strengths engine's reading; the full picture is on the explore screen */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.strengthsHeading")}</Text>
              {dims.length === 0 ? <Text style={st.empty}>{t("intel.noProfile")}</Text> : dims.map((d) => (
                <View key={d.dimension} style={st.card}>
                  <View style={st.rowWrap}>
                    <Text style={st.cardTitle}>{dimName(d.dimension)}</Text>
                    <Text style={[st.badge, d.academicState === "ESTABLISHED" ? st.badgeGood : d.academicState === "DECLINING" ? st.badgeWarn : st.badgeInfo]}>{t(`strengths.state.${d.academicState}`)}</Text>
                  </View>
                  {d.supportingSubjects?.length > 0 && <Text style={st.hint}>{t("intel.supportedBy", { list: d.supportingSubjects.map((s) => s.subjectName ?? s.subjectId).filter(Boolean).join(", ") })}</Text>}
                  {d.activePlan && <Text style={st.hint}>{t("intel.hasActivePlan")}</Text>}
                </View>
              ))}
              <TouchableOpacity style={st.link} onPress={() => go("/student/explore")} accessibilityRole="link"><Text style={st.linkText}>{t("intel.openStrengths")}</Text></TouchableOpacity>

              {/* What has changed — the development engine's trajectory and the latest change */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.changedHeading")}</Text>
              {dims.length === 0 ? <Text style={st.empty}>{t("intel.noHistory")}</Text> : dims.map((d) => (
                <Text key={d.dimension} style={st.line}>• {dimName(d.dimension)}: {t(`development.trajectory.${d.trajectory}`)} · {t(`intel.recentChange.${d.recentChange}`)}</Text>
              ))}
              {overall && <Text style={st.hint}>{t("intel.observations", { n: overall.independentObservations })}{overall.historySufficient ? "" : ` · ${t("intel.historyShort")}`}</Text>}
              <TouchableOpacity style={st.link} onPress={() => go("/student/development")} accessibilityRole="link"><Text style={st.linkText}>{t("intel.openDevelopment")}</Text></TouchableOpacity>

              {/* Learning evidence — the relationship the integration engine read, and which sources agree */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.learningHeading")}</Text>
              {dims.length === 0 ? <Text style={st.empty}>—</Text> : dims.map((d) => (
                <Text key={d.dimension} style={st.line}>• {dimName(d.dimension)}: {t(`strengths.integration.relationship.${d.learningRelationship}`)} · {t(`intel.sources.${d.crossDomain?.relationship ?? "INSUFFICIENT"}`)}</Text>
              ))}

              {/* Guidance — the categories the guidance engine opened; the items themselves live on the development screen */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.guidanceHeading")}</Text>
              {dims.every((d) => !d.guidanceCategories?.length) ? <Text style={st.empty}>{t("intel.noGuidance")}</Text> : dims.filter((d) => d.guidanceCategories?.length).map((d) => (
                <Text key={d.dimension} style={st.line}>• {dimName(d.dimension)}: {d.guidanceCategories.map((c) => t(`devGuidance.category.${c}`)).join(", ")}</Text>
              ))}
              <TouchableOpacity style={st.link} onPress={() => go("/student/development")} accessibilityRole="link"><Text style={st.linkText}>{t("intel.openGuidance")}</Text></TouchableOpacity>

              {/* Current plan */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.planHeading")}</Text>
              <Text style={st.line}>{overall?.activePlans ? t("intel.activePlans", { n: overall.activePlans }) : t("intel.noPlan")}</Text>
              <TouchableOpacity style={st.link} onPress={() => go("/student/plans")} accessibilityRole="link"><Text style={st.linkText}>{t("intel.openPlans")}</Text></TouchableOpacity>

              {/* Explore further — unranked, alphabetical; the pupil decides */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.exploreHeading")}</Text>
              <Text style={st.hint}>{t("intel.exploreHint")}</Text>
              {candidates.length === 0 ? <Text style={st.empty}>{t("intel.noExploration")}</Text> : candidates.map((c) => (
                <View key={c.domain} style={st.card}>
                  <Text style={st.cardTitle}>{c.label}</Text>
                  {c.description ? <Text style={st.sub2}>{c.description}</Text> : null}
                  <Text style={st.hint}>{t("intel.candidateLine", { why: c.whyItAppeared.map((w) => humanCode(w.code)).join(", "), n: c.activities.length })}</Text>
                </View>
              ))}
              <TouchableOpacity style={st.link} onPress={() => go("/student/explore")} accessibilityRole="link"><Text style={st.linkText}>{t("intel.openExplore")}</Text></TouchableOpacity>

              {/* Ask about this */}
              <Text style={st.sectionTitle} accessibilityRole="header">{t("intel.askHeading")}</Text>
              <Text style={st.hint}>{t("intel.askHint")}</Text>
              <TouchableOpacity style={st.btn} onPress={() => go("/student/intelligence/ask")} accessibilityRole="button" accessibilityLabel={t("intel.askButton")}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color="#FFFFFF" />
                <Text style={st.btnText}>{t("intel.askButton")}</Text>
              </TouchableOpacity>

              {/* The pilot's six questions — only while the school's pilot is collecting, only online */}
              {!offline && pilot?.open && (
                <View style={st.pilotCard}>
                  <Text style={st.cardTitle}>{t("intel.feedback.cardTitle")}</Text>
                  <Text style={st.sub2}>{t(pilot.submitted ? "intel.feedback.cardAnswered" : "intel.feedback.cardText")}</Text>
                  <TouchableOpacity style={st.link} onPress={() => go("/student/intelligence/feedback")} accessibilityRole="link"><Text style={st.linkText}>{t(pilot.submitted ? "intel.feedback.cardChange" : "intel.feedback.cardOpen")}</Text></TouchableOpacity>
                </View>
              )}

              {data.limitations?.length > 0 && <Text style={st.hint}>{t("intel.limitations")}: {data.limitations.map((l) => t(`intel.limitation.${String(l).split(":")[0]}`, { defaultValue: humanCode(l) })).join("; ")}</Text>}
              <Text style={st.hint}>{t("intel.asOf", { date: day(data.asOf) })}</Text>
            </>
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
  staleBar: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#FEF3C7", borderRadius: 10, padding: 10, marginBottom: 10 },
  staleText: { flex: 1, fontSize: 12, color: "#92400E" },
  note: { backgroundColor: "#EEF2FF", borderRadius: 12, padding: 12, marginBottom: 8 },
  noteTitle: { fontSize: 13, fontWeight: "700", color: "#3730A3", marginBottom: 2 },
  noteText: { fontSize: 12, color: "#3730A3" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginTop: 16, marginBottom: 6 },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  pilotCard: { backgroundColor: "#FFFBEB", borderRadius: 12, padding: 14, marginTop: 16, borderWidth: 1, borderColor: "#FDE68A" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  rowWrap: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  badge: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  badgeGood: { color: "#065F46", backgroundColor: "#ECFDF5" },
  badgeWarn: { color: "#92400E", backgroundColor: "#FEF3C7" },
  badgeInfo: { color: "#3730A3", backgroundColor: "#EEF2FF" },
  line: { fontSize: 13, color: "#1F2937", marginBottom: 4 },
  sub2: { fontSize: 12, color: "#374151", marginTop: 2 },
  hint: { fontSize: 11, color: "#6B7280", marginTop: 4 },
  empty: { fontSize: 13, color: "#6B7280" },
  link: { alignSelf: "flex-start", marginTop: 4 },
  linkText: { fontSize: 13, color: "#4F46E5", fontWeight: "600" },
  btn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#4F46E5", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, marginTop: 6, alignSelf: "flex-start" },
  btnText: { color: "#FFFFFF", fontWeight: "600", fontSize: 14 },
});
