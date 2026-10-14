// app/teacher/intelligence/index.js
"use strict";

/**
 * Class intelligence, and the first caller of the offline intervention writer.
 *
 * ── What is online and what is not, said plainly ──────────────────────────
 *
 * READING guidance needs the server. The deterministic engine lives in
 * backend/src/services/intelligence and there is no copy of it on the handset —
 * deliberately, because a second implementation of a trend rule is how a phone
 * comes to disagree with the report card. So when there is no connection this
 * screen says what it has and when it got it, rather than showing nothing or,
 * worse, showing stale figures as though they were current.
 *
 * WRITING an action does not need the server. InterventionService writes the
 * row to SQLite and hands it to the outbox, which sends it whenever the phone
 * next has a signal. A teacher standing in a corridor can record what they
 * decided to do, which is the whole point of an offline-first product in a
 * school where the connection comes and goes.
 *
 * ── The human decides ─────────────────────────────────────────────────────
 *
 * Nothing on this screen creates an intervention on its own. Guidance is shown
 * with the evidence behind it; the teacher taps the action they chose. The
 * system never chooses for them, which is the rule the whole product rests on.
 */

import React, { useState, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, RefreshControl, Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router }   from "expo-router";

import api                 from "../../../src/services/api";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import { InterventionService } from "../../../src/services/intervention.service";
import { errorText }       from "../../../src/utils/appError";

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

/** Loud for a child who is struggling, quiet for one who is doing well. */
const TONE = {
  high:     { bg: C.errorBg,   fg: C.error   },
  moderate: { bg: C.warningBg, fg: C.warning },
  low:      { bg: C.gray100,   fg: C.gray600 },
};

export default function ClassIntelligenceScreen() {
  const { t } = useTranslation();
  const pad = useScreenInsets({ top: 16 });

  const [classes, setClasses]   = useState([]);
  const [classId, setClassId]   = useState("");
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [offline, setOffline]   = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [openId, setOpenId]     = useState(null);
  const [guidance, setGuidance] = useState({});   // studentId → items
  const [saving, setSaving]     = useState(false);

  const loadClasses = useCallback(async () => {
    try {
      const { data } = await api.get("/teacher/my-classes");
      const list = data?.classes ?? [];
      setClasses(list);
      setClassId((current) => current || list[0]?._id || "");
    } catch {
      setOffline(true);
    }
  }, []);

  const loadClass = useCallback(async (id) => {
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await api.get(`/insights/class/${id}`);
      setRows(data?.data?.students ?? []);
      setFetchedAt(new Date());
      setOffline(false);
    } catch {
      // The previous answer is kept on screen and labelled, rather than being
      // replaced by an empty list that reads as "nothing to report".
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadClasses(); }, [loadClasses]);
  useEffect(() => { loadClass(classId); }, [classId, loadClass]);

  const openStudent = async (studentId) => {
    if (openId === studentId) { setOpenId(null); return; }
    setOpenId(studentId);
    if (guidance[studentId]) return;
    try {
      const { data } = await api.get(`/insights/student/${studentId}/guidance`);
      setGuidance((g) => ({ ...g, [studentId]: data?.data?.guidance ?? [] }));
    } catch {
      setOffline(true);
    }
  };

  /**
   * The human decision, and the only write on this screen.
   *
   * Goes through InterventionService, which writes locally and queues the send,
   * so it succeeds with no connection. The confirmation names the action the
   * teacher chose rather than implying the system decided anything.
   */
  const recordAction = async (student, item, actionCode) => {
    setSaving(true);
    try {
      await InterventionService.create({
        studentId:  student.studentId,
        classId,
        sourceType: "guidance",
        sourceCode: item.rationaleCode,
        subjectId:  item.subjectId ?? null,
        actionCode,
      });
      Alert.alert(t("classIntel.recordedTitle"), t("classIntel.recordedBody"));
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err, "classIntel.recordFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: pad.paddingTop }]}>
        <Text style={styles.title}>{t("classIntel.title")}</Text>
        <Text style={styles.blurb}>{t("classIntel.blurb")}</Text>
      </View>

      {classes.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    style={styles.classBar} contentContainerStyle={styles.classBarInner}>
          {classes.map((c) => (
            <TouchableOpacity
              key={c._id}
              onPress={() => setClassId(c._id)}
              style={[styles.chip, classId === c._id && styles.chipOn]}
            >
              <Text style={[styles.chipText, classId === c._id && styles.chipTextOn]}>
                {c.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Stale rather than silent — see the header. */}
      {offline && (
        <View style={styles.staleBar}>
          <Ionicons name="cloud-offline-outline" size={16} color={C.warning} />
          <Text style={styles.staleText}>
            {fetchedAt
              ? t("classIntel.staleAt", { time: fetchedAt.toLocaleTimeString() })
              : t("classIntel.offline")}
          </Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={styles.loader} color={C.primary} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => loadClass(classId)} />
          }
        >
          {!rows.length && (
            <Text style={styles.empty}>{t("classIntel.empty")}</Text>
          )}

          {rows.map((row) => (
            <View key={row.studentId} style={styles.card}>
              <TouchableOpacity style={styles.cardHead}
                                onPress={() => openStudent(row.studentId)}>
                <View style={styles.cardHeadText}>
                  <Text style={styles.name}>{row.name ?? row.studentId}</Text>
                  {!row.guidance?.length && (
                    <Text style={styles.quiet}>{t("classIntel.nothingToNote")}</Text>
                  )}
                </View>
                <Ionicons
                  name={openId === row.studentId ? "chevron-up" : "chevron-down"}
                  size={18} color={C.gray400}
                />
              </TouchableOpacity>

              <View style={styles.badgeRow}>
                {(row.guidance ?? []).map((g, i) => (
                  <View key={`${g.rationaleCode}-${i}`}
                        style={[styles.badge, { backgroundColor: TONE[g.priority].bg }]}>
                    <Text style={[styles.badgeText, { color: TONE[g.priority].fg }]}>
                      {g.subjectName ? `${g.subjectName} · ` : ""}
                      {t(`guidance.${g.rationaleCode}`)}
                    </Text>
                  </View>
                ))}
                {(row.openInterventions ?? []).map((i) => (
                  <View key={i._id} style={[styles.badge, { backgroundColor: C.primaryBg }]}>
                    <Text style={[styles.badgeText, { color: C.primary }]}>
                      {t(`intervention.status.${i.status}`)} · {t(`guidance.${i.actionCode}`)}
                    </Text>
                  </View>
                ))}
              </View>

              {openId === row.studentId && (
                <View style={styles.detail}>
                  {/* The pupil's explorations: observe, rate — the web's staff actions, here. */}
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => router.push({
                      pathname: "/teacher/explorations/[studentId]",
                      params:   { studentId: row.studentId, name: row.name ?? "", classId },
                    })}
                  >
                    <Ionicons name="compass-outline" size={14} color={C.primary} />
                    <Text style={styles.actionText}>{t("classIntel.explorations")}</Text>
                  </TouchableOpacity>
                  {!guidance[row.studentId] && <ActivityIndicator color={C.primary} />}
                  {(guidance[row.studentId] ?? []).map((item, i) => (
                    <View key={`${item.rationaleCode}-${i}`} style={styles.guidanceBlock}>
                      <Text style={styles.guidanceTitle}>
                        {item.subjectName ? `${item.subjectName} — ` : ""}
                        {t(`guidance.${item.rationaleCode}`)}
                      </Text>

                      {/* The evidence, exactly as the engine reported it. */}
                      {(item.evidence ?? []).map((e) => (
                        <Text key={e.metric} style={styles.evidence}>
                          {t(`evidence.${e.metric}`)}:{" "}
                          {e.scale ? `${e.value}/${e.scale}` : String(e.value)}
                        </Text>
                      ))}

                      <View style={styles.actionRow}>
                        {(item.recommendedActionCodes ?? []).map((code) => (
                          <TouchableOpacity
                            key={code}
                            disabled={saving}
                            style={[styles.action, saving && styles.actionOff]}
                            onPress={() => recordAction(row, item, code)}
                          >
                            <Ionicons name="add" size={14} color={C.primary} />
                            <Text style={styles.actionText}>{t(`guidance.${code}`)}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ))}
                  {guidance[row.studentId]?.length === 0 && (
                    <Text style={styles.quiet}>{t("classIntel.nothingToNote")}</Text>
                  )}
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: C.gray50 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  title:  { fontSize: 20, fontWeight: "700", color: C.gray900 },
  blurb:  { fontSize: 12, color: C.gray500, marginTop: 4 },

  classBar:      { maxHeight: 48 },
  classBarInner: { paddingHorizontal: 16, gap: 8, alignItems: "center" },
  chip:     { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
              backgroundColor: C.white, borderWidth: 1, borderColor: C.gray200 },
  chipOn:   { backgroundColor: C.primaryBg, borderColor: C.primary },
  chipText: { fontSize: 12, color: C.gray600 },
  chipTextOn: { color: C.primary, fontWeight: "600" },

  staleBar:  { flexDirection: "row", alignItems: "center", gap: 6,
               backgroundColor: C.warningBg, paddingHorizontal: 16, paddingVertical: 8 },
  staleText: { fontSize: 12, color: C.warning, flex: 1 },

  loader: { marginTop: 32 },
  list:   { padding: 16, gap: 12, paddingBottom: 40 },
  empty:  { fontSize: 13, color: C.gray500, textAlign: "center", marginTop: 24 },

  card:     { backgroundColor: C.white, borderRadius: 12, padding: 12,
              borderWidth: 1, borderColor: C.gray200 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardHeadText: { flex: 1 },
  name:  { fontSize: 15, fontWeight: "600", color: C.gray900 },
  quiet: { fontSize: 12, color: C.gray400, marginTop: 2 },

  badgeRow:  { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  badge:     { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: "600" },

  detail:        { marginTop: 12, borderTopWidth: 1, borderTopColor: C.gray100, paddingTop: 12, gap: 12 },
  guidanceBlock: { backgroundColor: C.gray50, borderRadius: 10, padding: 10 },
  guidanceTitle: { fontSize: 13, fontWeight: "600", color: C.gray900, marginBottom: 6 },
  evidence:      { fontSize: 11, color: C.gray600, lineHeight: 17 },

  actionRow:  { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  action:     { flexDirection: "row", alignItems: "center", gap: 4,
                backgroundColor: C.white, borderWidth: 1, borderColor: C.primary,
                borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  actionOff:  { opacity: 0.5 },
  actionText: { fontSize: 12, color: C.primary, fontWeight: "600" },
});
