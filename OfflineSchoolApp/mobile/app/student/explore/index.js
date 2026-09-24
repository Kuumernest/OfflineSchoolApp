// app/student/explore/index.js
"use strict";

/**
 * Explore — the pupil's first screen of the exploration loop.
 *
 *   For you      what the evidence suggests trying, with the reason in words
 *   In progress  what they started or saved
 *   Completed    what they finished, stopped, skipped or declined
 *
 * Simple on purpose. No ranking, no score, no career. Each suggestion says
 * why it is here ("recurring evidence of strength in this area", "an area you
 * have not explored yet") and the pupil chooses. Works from the local cache
 * when there is no signal; refreshes when there is.
 */

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, StatusBar, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../../../src/i18n/useTranslation";
import {
  refreshCatalog, refreshSuggestions, refreshExplorations, getSuggestions, getExplorations, fetchProfileChanges, fetchLearningConcise, fetchMyStrengths,
} from "../../../src/services/exploration.service";

const TABS = ["forYou", "inProgress", "completed"];
const OPEN = ["DISCOVERED", "SAVED", "STARTED", "SUBMITTED", "REVIEW_REQUIRED"];

export default function ExploreScreen() {
  const router = useRouter();
  const { t, language } = useTranslation();
  const lang = String(language ?? "en").startsWith("fr") ? "fr" : "en";

  const [tab, setTab] = useState("forYou");
  const [suggestions, setSuggestions] = useState([]);
  const [explorations, setExplorations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [changes, setChanges] = useState(null);
  const [learning, setLearning] = useState([]);
  const [mine, setMine] = useState(null);

  const loadLocal = useCallback(async () => {
    const [s, e] = await Promise.all([getSuggestions(), getExplorations()]);
    setSuggestions(s.suggestions ?? []);
    setExplorations(e);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await refreshCatalog(lang);
      await Promise.all([refreshSuggestions(lang), refreshExplorations(lang)]);
      setChanges(await fetchProfileChanges());
      setLearning(await fetchLearningConcise());
      setMine(await fetchMyStrengths());
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      await loadLocal();
      setLoading(false);
      setRefreshing(false);
    }
  }, [lang, loadLocal]);

  useEffect(() => { loadLocal().then(() => refresh()); }, [loadLocal, refresh]);

  const openIds = new Set(explorations.filter((e) => OPEN.includes(e.status)).map((e) => e.activityId));
  const forYou = suggestions.filter((s) => !openIds.has(s.activityId));
  const inProgress = explorations.filter((e) => OPEN.includes(e.status));
  const completed = explorations.filter((e) => !OPEN.includes(e.status));

  const openSuggestion = (s) => router.push({ pathname: "/student/explore/[id]", params: { id: s.activityId, kind: "activity" } });
  const openExploration = (e) => router.push({ pathname: "/student/explore/[id]", params: { id: e.explorationId, kind: "exploration" } });

  const renderSuggestion = ({ item: s }) => (
    <TouchableOpacity style={st.card} onPress={() => openSuggestion(s)} activeOpacity={0.85}>
      <Text style={st.cardTitle}>{s.activity?.title ?? s.activityId}</Text>
      <Text style={st.cardMeta}>{t(`explore.area.${s.area}`)} · {t(`explore.level.${s.level}`)} · {t("explore.minutes", { n: s.activity?.estimatedMinutes ?? "—" })}</Text>
      <Text style={st.cardWhy}>{t("explore.because")}: {(s.reasons ?? []).map((r) => t(`explore.reason.${r}`)).join("; ")}</Text>
    </TouchableOpacity>
  );
  const renderExploration = ({ item: e }) => (
    <TouchableOpacity style={st.card} onPress={() => openExploration(e)} activeOpacity={0.85}>
      <View style={st.rowBetween}>
        <Text style={st.cardTitle}>{e.title}</Text>
        <Text style={st.badge}>{t(`explore.status.${e.status}`)}</Text>
      </View>
      <Text style={st.cardMeta}>{t(`explore.area.${e.area}`)} · {t(`explore.level.${e.level}`)}{e.pendingSync ? " · ⟳" : ""}</Text>
    </TouchableOpacity>
  );

  const data = tab === "forYou" ? forYou : tab === "inProgress" ? inProgress : completed;

  return (
    <View style={st.root}>
      <StatusBar barStyle="dark-content" />
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={24} color="#111827" /></TouchableOpacity>
        <Text style={st.title}>{t("explore.subtitle")}</Text>
      </View>
      <Text style={st.sub}>{t("explore.basedOn")}{offline ? ` · ${t("explore.offline")}` : ""}</Text>
      <View style={st.tabs}>
        {TABS.map((k) => (
          <TouchableOpacity key={k} style={[st.tab, tab === k && st.tabOn]} onPress={() => setTab(k)}>
            <Text style={[st.tabText, tab === k && st.tabTextOn]}>{t(`explore.${k}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {changes?.comparison && (changes.newEvidence?.rows > 0 || changes.comparison.newStrengths.length || changes.comparison.newEmerging.length || changes.comparison.weakened.length) ? (
        <View style={st.updated}>
          <Text style={st.updatedTitle}>{t("strengths.fusion.updated")}</Text>
          {changes.newEvidence?.rows > 0 && <Text style={st.updatedLine}>• {t("strengths.fusion.newEvidenceShort", { n: changes.newEvidence.rows, e: changes.newEvidence.explorations })}</Text>}
          {[...changes.comparison.newStrengths, ...changes.comparison.newEmerging, ...changes.comparison.weakened].map((e) => (
            <Text key={e.dimension} style={st.updatedLine}>• {t(`strengths.dimension.${e.dimension}`)}: {t(`strengths.state.${e.previous.state}`)} → {t(`strengths.state.${e.current.state}`)}</Text>
          ))}
          <Text style={st.updatedHint}>{t("strengths.fusion.updatedHint")}</Text>
        </View>
      ) : null}
      {mine?.dimensions?.length > 0 && (
        <View style={st.updated}>
          <Text style={st.updatedTitle}>{t("strengths.integration.yourStrengths")}</Text>
          {mine.dimensions.slice(0, 4).map((d) => (
            <View key={d.dimension} style={{ marginBottom: 6 }}>
              <Text style={st.updatedLine}>• {t(`strengths.dimension.${d.dimension}`)} — {t(`strengths.state.${d.state}`)}</Text>
              <Text style={st.updatedSub}>{t("strengths.integration.howWeKnow")}: {d.relationship ? t(`strengths.integration.relationship.${d.relationship}`) : "—"}</Text>
              <Text style={st.updatedSub}>{t("strengths.integration.supports")}: {d.events > 0 ? t("strengths.integration.learningLine", { n: d.events, families: d.families.map((f) => t(`strengths.integration.family.${f}`)).join(", ") }) : t("strengths.integration.learningNone")}</Text>
              <Text style={st.updatedSub}>{t("strengths.integration.unclear")}: {d.quality.length || d.missing.length
                ? [...d.quality.map((q) => t(`strengths.integration.quality.${q}`)), ...(d.missing.length ? [t("strengths.integration.missing", { list: d.missing.slice(0, 3).map((f) => t(`strengths.integration.family.${f}`)).join(", ") })] : [])].join(" · ")
                : t("strengths.integration.nothingUnclear")}</Text>
              {d.areas.length > 0 && <Text style={st.updatedSub}>{t("strengths.integration.exploreNext")}: {d.areas.map((a) => t(`explore.area.${a}`)).join(", ")}</Text>}
            </View>
          ))}
          <Text style={st.updatedHint}>{t("strengths.integration.unavailableNote")}</Text>
        </View>
      )}
      {learning.length > 0 && (
        <View style={st.updated}>
          <Text style={st.updatedTitle}>{t("learning.mobileHeading")}</Text>
          {learning.slice(0, 4).map((l, i) => <Text key={i} style={st.updatedLine}>• {t(`learning.concise.${l.code}`, { subject: l.subjectId ?? "", n: l.n ?? "", c: l.completed ?? "", a: l.assigned ?? "" })}</Text>)}
          <Text style={st.updatedHint}>{t("learning.mobileHint")}</Text>
        </View>
      )}
      {loading ? <ActivityIndicator style={{ marginTop: 32 }} /> : (
        <FlatList
          data={data}
          keyExtractor={(x) => x.explorationId ?? x.activityId}
          renderItem={tab === "forYou" ? renderSuggestion : renderExploration}
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); refresh(); }} />}
          ListEmptyComponent={<Text style={st.empty}>{t(tab === "forYou" ? "explore.noSuggestions" : "explore.none")}</Text>}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F9FAFB" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 52, paddingBottom: 4 },
  title: { fontSize: 22, fontWeight: "700", color: "#111827" },
  sub: { paddingHorizontal: 16, color: "#6B7280", fontSize: 13, marginBottom: 8 },
  tabs: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: "#E5E7EB" },
  tabOn: { backgroundColor: "#4F46E5" },
  tabText: { color: "#374151", fontSize: 13, fontWeight: "600" },
  tabTextOn: { color: "#FFFFFF" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#111827", flexShrink: 1 },
  cardMeta: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  cardWhy: { fontSize: 12, color: "#4B5563", marginTop: 6 },
  badge: { fontSize: 11, color: "#3730A3", backgroundColor: "#EEF2FF", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  empty: { textAlign: "center", color: "#6B7280", marginTop: 32 },
  updated: { marginHorizontal: 16, marginTop: 10, backgroundColor: "#EEF2FF", borderRadius: 12, padding: 12 },
  updatedTitle: { fontSize: 14, fontWeight: "700", color: "#3730A3", marginBottom: 4 },
  updatedLine: { fontSize: 13, color: "#1F2937" },
  updatedSub: { fontSize: 12, color: "#4B5563", marginLeft: 12 },
  updatedHint: { fontSize: 11, color: "#6B7280", marginTop: 6 },
});
