// app/teacher/explorations/[studentId].js
"use strict";

/**
 * A pupil's explorations, for the teacher: what they chose to explore, what
 * you observed, and your rating of an output against the activity's own
 * criteria — the same two actions the web's strengths page offers staff.
 *
 * ── The server decides ────────────────────────────────────────────────────
 *
 * The option lists below are the catalog's names for the choices; the server
 * validates every body it is sent, refuses a teacher who is not assigned to
 * the pupil's class, keeps one observation per teacher per exploration (a
 * second post is a revision, with the first kept) and reads the level of a
 * rating from the ratings. Nothing here computes a level or a score. The
 * screen shows what the server stored, re-read after each write.
 *
 * ── Offline ───────────────────────────────────────────────────────────────
 *
 * Writes go through the outbox; a corridor with no signal still takes the
 * observation, and the server hears it on the next sync. Reading needs a
 * connection the first time; after that the last answer is shown, dated.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, RefreshControl, Alert, StatusBar,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation }  from "../../../src/i18n/useTranslation";
import { formatTime }      from "../../../src/i18n/format";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { errorText }       from "../../../src/utils/appError";
import { MutationQueue }   from "../../../src/services/mutationQueue.service";
import {
  refreshCatalog, refreshPupilExplorations, getPupilExplorations, criteriaFor,
  observeExploration, rateExploration,
} from "../../../src/services/exploration.service";

// The catalog's names for the choices (shared/exploration/catalog.js). The
// server is the judge of them; these only draw the options.
const OBS_LEVELS = ["OBSERVED", "PARTLY_OBSERVED", "NOT_OBSERVED", "INSUFFICIENT_OPPORTUNITY"];
const OBS_CODES  = ["PROBLEM_SOLVING", "PERSISTENCE", "COMMUNICATION", "TECHNICAL_EXECUTION", "CREATIVE_APPROACH", "COLLABORATION", "EXPLANATION", "ITERATION"];
const RATINGS    = ["not_met", "partly_met", "met", "exceeded"];
const OBSERVABLE = ["STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"];
const RATEABLE   = ["SUBMITTED", "REVIEW_REQUIRED"];

const C = {
  primary: "#4F46E5", primaryBg: "#EEF2FF",
  success: "#059669", successBg: "#ECFDF5",
  warning: "#D97706", warningBg: "#FEF3C7",
  error:   "#DC2626", errorBg:   "#FEF2F2",
  white:   "#FFFFFF",
  gray50:  "#F9FAFB", gray100: "#F3F4F6", gray200: "#E5E7EB",
  gray400: "#9CA3AF", gray500: "#6B7280", gray600: "#4B5563",
  gray700: "#374151", gray900: "#111827",
};

const STATUS_TONE = {
  COMPLETED:       { bg: C.successBg, fg: C.success },
  REVIEW_REQUIRED: { bg: C.warningBg, fg: C.warning },
};

export default function PupilExplorationsScreen() {
  const { t, language } = useTranslation();
  const pad = useScreenInsets({ top: 12 });
  const { studentId, name } = useLocalSearchParams();
  const pupilId = String(studentId ?? "");

  const [rows, setRows]         = useState([]);
  const [criteria, setCriteria] = useState({});    // activityId → string[]
  const [loading, setLoading]   = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [offline, setOffline]   = useState(false);
  const [error, setError]       = useState(null);
  const [openId, setOpenId]     = useState(null);
  const [saving, setSaving]     = useState(false);
  // Form state per exploration, so moving between cards loses nothing.
  const [obs, setObs]           = useState({});    // explorationId → { level, codes, note }
  const [ratings, setRatings]   = useState({});    // explorationId → { criterion: rating }

  const withCriteria = useCallback(async (list) => {
    const next = {};
    for (const e of list) {
      if (!(e.activityId in next)) next[e.activityId] = await criteriaFor(e.activityId, language).catch(() => []);
    }
    setCriteria(next);
  }, [language]);

  /** @returns {Promise<boolean>} whether the server answered (false: shown from the cache, or nothing) */
  const load = useCallback(async () => {
    if (!pupilId) { setLoading(false); return false; }
    setError(null);
    try {
      await refreshCatalog(language).catch(() => {});
      const list = await refreshPupilExplorations(pupilId, language);
      setRows(list);
      setFetchedAt(new Date());
      setOffline(false);
      await withCriteria(list);
      return true;
    } catch (err) {
      // The last answer, dated, rather than an empty list that reads as "none".
      const cached = await getPupilExplorations(pupilId).catch(() => null);
      if (cached) {
        setRows(cached.rows);
        setFetchedAt(cached.fetchedAt ? new Date(cached.fetchedAt) : null);
        setOffline(true);
        await withCriteria(cached.rows);
      } else {
        setError(errorText(t, err, `explore.error.${err?.response?.data?.code ?? "generic"}`));
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [pupilId, language, t, withCriteria]);

  useEffect(() => { load(); }, [load]);

  /** Send what the outbox holds if it can, then re-read: the screen shows what the server stored. */
  const settle = async (okKey) => {
    let delivered = false;
    try { await MutationQueue.drain({ limit: 10, includeUploads: false }); delivered = true; } catch { delivered = false; }
    const answered = await load().catch(() => false);
    Alert.alert(t(okKey), delivered && answered ? undefined : t("explore.queued"));
  };

  const fail = (err) => {
    const code = err?.response?.data?.code;
    Alert.alert(t("common.error"), errorText(t, err, `explore.error.${code ?? "generic"}`));
  };

  const obsOf = (id) => obs[id] ?? { level: "OBSERVED", codes: [], note: "" };
  const setObsOf = (id, patch) => setObs((all) => ({ ...all, [id]: { ...obsOf(id), ...patch } }));
  const ratingsOf = (id) => ratings[id] ?? {};

  const observe = async (e) => {
    const o = obsOf(e.explorationId);
    setSaving(true);
    try {
      await observeExploration(e.explorationId, { level: o.level, codes: o.codes, note: o.note.trim() || null });
      setObs((all) => ({ ...all, [e.explorationId]: undefined }));
      await settle("explore.observed");
    } catch (err) { fail(err); } finally { setSaving(false); }
  };

  const rate = async (e) => {
    const chosen = Object.entries(ratingsOf(e.explorationId)).filter(([, r]) => r).map(([criterion, rating]) => ({ criterion, rating }));
    if (!chosen.length) return;
    setSaving(true);
    try {
      await rateExploration(e.explorationId, { version: e.version, ratings: chosen });
      setRatings((all) => ({ ...all, [e.explorationId]: undefined }));
      await settle("explore.rated");
    } catch (err) { fail(err); } finally { setSaving(false); }
  };

  const Chip = ({ on, label, onPress, disabled }) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.chip, on && styles.chipOn, disabled && styles.off]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={[styles.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.back")}>
          <Ionicons name="arrow-back" size={22} color={C.gray900} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{name ? t("explore.pupilHeading", { name }) : t("explore.title")}</Text>
          <Text style={styles.blurb}>{t("explore.teacherBlurb")}</Text>
        </View>
      </View>

      {offline && (
        <View style={styles.staleBar}>
          <Ionicons name="cloud-offline-outline" size={16} color={C.warning} />
          <Text style={styles.staleText}>
            {fetchedAt ? t("classIntel.staleAt", { time: formatTime(fetchedAt) }) : t("classIntel.offline")}
          </Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={styles.loader} color={C.primary} />
      ) : (
        <ScrollView contentContainerStyle={styles.list}
                    refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}>
          {!!error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={C.error} />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity onPress={load}><Text style={styles.retry}>{t("common.retry")}</Text></TouchableOpacity>
            </View>
          )}
          {!error && !rows.length && <Text style={styles.empty}>{t("explore.none")}</Text>}

          {rows.map((e) => {
            const tone = STATUS_TONE[e.status] ?? { bg: C.gray100, fg: C.gray600 };
            const crit = criteria[e.activityId] ?? [];
            const canObserve = OBSERVABLE.includes(e.status);
            const canRate    = crit.length > 0 && RATEABLE.includes(e.status);
            const open = openId === e.explorationId;
            const o = obsOf(e.explorationId);
            const r = ratingsOf(e.explorationId);
            return (
              <View key={e.explorationId} style={styles.card}>
                <TouchableOpacity style={styles.cardHead} onPress={() => setOpenId(open ? null : e.explorationId)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{e.title}</Text>
                    <View style={styles.badgeRow}>
                      <View style={[styles.badge, { backgroundColor: tone.bg }]}>
                        <Text style={[styles.badgeText, { color: tone.fg }]}>{t(`explore.status.${e.status}`)}</Text>
                      </View>
                      <Text style={styles.meta}>{t(`explore.level.${e.level}`)}</Text>
                      {e.pendingSync && <Text style={styles.meta}>· {t("explore.pending")}</Text>}
                    </View>
                  </View>
                  <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={C.gray400} />
                </TouchableOpacity>

                {open && (
                  <View style={styles.detail}>
                    {e.outputs?.length > 0 && e.outputs.map((out, i) => (
                      <Text key={i} style={styles.line}><Text style={styles.muted}>{out.label}: </Text>{out.value}</Text>
                    ))}

                    {/* What was recorded, exactly as the server holds it. */}
                    {(e.observations ?? []).map((ob) => (
                      <Text key={ob.observationId} style={styles.line}>
                        <Text style={styles.muted}>{t("explore.observationBy", { who: ob.observedBy })}: </Text>
                        {t(`explore.obsLevel.${ob.level}`)}{ob.codes?.length ? ` · ${ob.codes.map((c) => t(`explore.obsCode.${c}`)).join(", ")}` : ""}{ob.note ? ` — ${ob.note}` : ""}
                      </Text>
                    ))}
                    {e.performance && (
                      <Text style={styles.line}>
                        <Text style={styles.muted}>{t("explore.ratedBy", { who: e.performance.ratedBy })}: </Text>
                        {t(`explore.perfLevel.${e.performance.level}`)} · {(e.performance.ratings ?? []).map((x) => `${t(`explore.criterion.${x.criterion}`)} ${t(`explore.rating.${x.rating}`)}`).join(", ")}
                      </Text>
                    )}

                    {canObserve && (
                      <View style={styles.form}>
                        <Text style={styles.formTitle}>{t("explore.observeHeading")}</Text>
                        <Text style={styles.label}>{t("explore.obsLevelLabel")}</Text>
                        <View style={styles.chips}>
                          {OBS_LEVELS.map((l) => (
                            <Chip key={l} on={o.level === l} label={t(`explore.obsLevel.${l}`)} disabled={saving}
                                  onPress={() => setObsOf(e.explorationId, { level: l })} />
                          ))}
                        </View>
                        <View style={styles.chips}>
                          {OBS_CODES.map((c) => (
                            <Chip key={c} on={o.codes.includes(c)} label={t(`explore.obsCode.${c}`)} disabled={saving}
                                  onPress={() => setObsOf(e.explorationId, { codes: o.codes.includes(c) ? o.codes.filter((x) => x !== c) : [...o.codes, c] })} />
                          ))}
                        </View>
                        <TextInput value={o.note} onChangeText={(v) => setObsOf(e.explorationId, { note: v })}
                                   placeholder={t("explore.obsNote")} placeholderTextColor={C.gray400}
                                   maxLength={1000} multiline style={styles.input} />
                        <TouchableOpacity disabled={saving} onPress={() => observe(e)} style={[styles.button, styles.buttonSecondary, saving && styles.off]}>
                          <Text style={styles.buttonSecondaryText}>{t("explore.observeButton")}</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    {canRate && (
                      <View style={styles.form}>
                        <Text style={styles.formTitle}>{t("explore.rateHeading")}</Text>
                        <Text style={styles.hint}>{t("explore.rateHint")}</Text>
                        {crit.map((c) => (
                          <View key={c} style={{ marginTop: 6 }}>
                            <Text style={styles.label}>{t(`explore.criterion.${c}`)}</Text>
                            <View style={styles.chips}>
                              {RATINGS.map((rt) => (
                                <Chip key={rt} on={r[c] === rt} label={t(`explore.rating.${rt}`)} disabled={saving}
                                      onPress={() => setRatings((all) => ({ ...all, [e.explorationId]: { ...r, [c]: r[c] === rt ? "" : rt } }))} />
                              ))}
                            </View>
                          </View>
                        ))}
                        <TouchableOpacity disabled={saving || !Object.values(r).some(Boolean)} onPress={() => rate(e)}
                                          style={[styles.button, (saving || !Object.values(r).some(Boolean)) && styles.off]}>
                          <Text style={styles.buttonText}>{t("explore.rateButton")}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: C.gray50 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingBottom: 10 },
  title:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  blurb:  { fontSize: 12, color: C.gray500, marginTop: 4 },

  staleBar:  { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.warningBg, paddingHorizontal: 16, paddingVertical: 8 },
  staleText: { fontSize: 12, color: C.warning, flex: 1 },

  loader: { marginTop: 32 },
  list:   { padding: 16, gap: 12, paddingBottom: 40 },
  empty:  { fontSize: 13, color: C.gray500, textAlign: "center", marginTop: 24 },
  errorBox:  { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.errorBg, borderRadius: 10, padding: 12 },
  errorText: { flex: 1, fontSize: 13, color: C.error },
  retry:     { fontSize: 13, fontWeight: "600", color: C.primary },

  card:     { backgroundColor: C.white, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.gray200 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  name:     { fontSize: 15, fontWeight: "600", color: C.gray900 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 },
  badge:    { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  meta:     { fontSize: 11, color: C.gray500 },

  detail: { marginTop: 10, borderTopWidth: 1, borderTopColor: C.gray100, paddingTop: 10, gap: 6 },
  line:   { fontSize: 12, color: C.gray700, lineHeight: 18 },
  muted:  { color: C.gray500 },

  form:      { backgroundColor: C.gray50, borderRadius: 10, padding: 10, marginTop: 6, gap: 6 },
  formTitle: { fontSize: 13, fontWeight: "600", color: C.gray900 },
  hint:      { fontSize: 11, color: C.gray500 },
  label:     { fontSize: 11, fontWeight: "600", color: C.gray600, marginTop: 4 },
  chips:     { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: C.white, borderWidth: 1, borderColor: C.gray200 },
  chipOn:    { backgroundColor: C.primaryBg, borderColor: C.primary },
  chipText:  { fontSize: 12, color: C.gray600 },
  chipTextOn: { color: C.primary, fontWeight: "600" },
  input:     { backgroundColor: C.white, borderWidth: 1, borderColor: C.gray200, borderRadius: 8, padding: 8, fontSize: 13, color: C.gray900, minHeight: 40 },

  button:    { alignSelf: "flex-start", backgroundColor: C.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginTop: 4 },
  buttonText: { color: C.white, fontSize: 13, fontWeight: "600" },
  buttonSecondary:     { backgroundColor: C.white, borderWidth: 1, borderColor: C.primary },
  buttonSecondaryText: { color: C.primary, fontSize: 13, fontWeight: "600" },
  off: { opacity: 0.5 },
});
