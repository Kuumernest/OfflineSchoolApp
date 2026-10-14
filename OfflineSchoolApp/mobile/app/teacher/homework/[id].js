// app/teacher/homework/[id].js
//
// One homework in full: what was set, for whom, by when — and who has
// handed it in. Read from the phone's tables, so it opens without a network.

import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, Alert,
} from "react-native";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import {
  getHomeworkById, getSubmissions, deleteHomework, publishHomework, unpublishHomework,
} from "../../../src/services/homework.service";
import { errorText }       from "../../../src/utils/appError";
import { formatDue }       from "./index";

export default function TeacherHomeworkDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const { t, locale } = useTranslation();
  const screenPad = useScreenInsets({ top: 16 });

  const [hw,          setHw]          = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [busy,        setBusy]        = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const row = await getHomeworkById(String(id));
      if (!row) { setError(t("teacherHw.notFound")); return; }
      setHw(row);
      setSubmissions(await getSubmissions(String(id)));
    } catch (err) {
      setError(errorText(t, err, "teacherHw.loadFailed"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = async () => {
    if (!hw) return;
    setBusy(true);
    try {
      if (Number(hw.is_published) === 1) await unpublishHomework(hw.id); else await publishHomework(hw.id);
      await load();
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err, "teacherHw.statusFailed"));
    } finally { setBusy(false); }
  };

  const remove = () => {
    if (!hw) return;
    Alert.alert(t("teacherHw.deleteTitle"), t("teacherHw.deleteBody", { title: hw.title }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => {
        setBusy(true);
        try { await deleteHomework(hw.id); router.back(); }
        catch (err) { Alert.alert(t("common.error"), errorText(t, err, "teacherHw.deleteFailed")); }
        finally { setBusy(false); }
      } },
    ]);
  };

  const isLive = Number(hw?.is_published) === 1;
  const due    = hw ? formatDue(hw.due_date, locale) : null;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />
      <View style={[styles.header, { paddingTop: screenPad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{t("teacherHw.detailTitle")}</Text>
        {hw ? (
          <TouchableOpacity style={styles.editBtn} disabled={busy}
            onPress={() => router.push({ pathname: "/teacher/homework/create", params: { id: hw.id } })}>
            <Ionicons name="create-outline" size={18} color="#4F46E5" />
            <Text style={styles.editBtnText}>{t("common.edit")}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#D97706" /></View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={44} color="#DC2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}><Text style={styles.retryText}>{t("common.retry")}</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.card}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{hw.title}</Text>
              <View style={[styles.badge, isLive ? styles.badgeLive : styles.badgeDraft]}>
                <Text style={[styles.badgeText, isLive ? styles.badgeTextLive : styles.badgeTextDraft]}>
                  {t(isLive ? "teacherHw.published" : "teacherHw.draft")}
                </Text>
              </View>
            </View>
            <Text style={styles.meta}>{hw.class_name || t("teacherHw.unknownClass")}{"  ·  "}{hw.subject_name || t("teacherHw.unknownSubject")}</Text>

            <View style={styles.facts}>
              <Fact icon="calendar-outline" label={t("teacherHw.dueDateLabel")} value={due ?? t("teacherHw.noDue")} />
              <Fact icon="ribbon-outline" label={t("teacherHw.maxScore")} value={String(hw.max_score ?? 100)} />
              <Fact icon="time-outline" label={t("teacherHw.lateLabel")}
                value={t(Number(hw.allow_late) !== 0 ? "teacherHw.lateAllowed" : "teacherHw.lateNotAllowed")} />
            </View>

            {hw.description ? (<><Text style={styles.sectionLabel}>{t("teacherHw.descriptionLabel")}</Text><Text style={styles.para}>{hw.description}</Text></>) : null}
            {hw.instructions ? (<><Text style={styles.sectionLabel}>{t("teacherHw.instructionsLabel")}</Text><Text style={styles.para}>{hw.instructions}</Text></>) : null}

            <View style={styles.actions}>
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#ECFDF5" }]} onPress={toggle} disabled={busy}>
                <Ionicons name={isLive ? "eye-off-outline" : "send-outline"} size={16} color="#059669" />
                <Text style={[styles.actionText, { color: "#059669" }]}>{t(isLive ? "teacherHw.unpublish" : "teacherHw.publish")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#FEF2F2" }]} onPress={remove} disabled={busy}>
                <Ionicons name="trash-outline" size={16} color="#DC2626" />
                <Text style={[styles.actionText, { color: "#DC2626" }]}>{t("common.delete")}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.sectionTitle}>
            {t("teacherHw.submissionsTitle")}{"  "}
            <Text style={styles.sectionCount}>{t("teacherHw.submissions", { count: submissions.length })}</Text>
          </Text>
          {submissions.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="document-text-outline" size={32} color="#D1D5DB" />
              <Text style={styles.emptyText}>{t("teacherHw.noSubmissions")}</Text>
            </View>
          ) : submissions.map((s) => (
            <View key={s.id} style={styles.subCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.subName}>{s.student_name}</Text>
                <Text style={styles.subMeta}>
                  {t("teacherHw.submittedAt", { date: formatDue(s.submitted_at, locale) ?? "—" })}
                  {Number(s.is_late) === 1 ? `  ·  ${t("teacherHw.late")}` : ""}
                </Text>
                {s.submission_text ? <Text style={styles.subText} numberOfLines={3}>{s.submission_text}</Text> : null}
              </View>
              <View style={[styles.scorePill, s.score == null && styles.scorePillNone]}>
                <Text style={[styles.scoreText, s.score == null && styles.scoreTextNone]}>
                  {s.score == null ? t("teacherHw.notGraded") : t("teacherHw.score", { score: s.score, max: hw.max_score ?? 100 })}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const Fact = ({ icon, label, value }) => (
  <View style={styles.fact}>
    <Ionicons name={icon} size={16} color="#6B7280" />
    <View style={{ flex: 1 }}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 0, paddingBottom: 14,
    backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backButton: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827", flex: 1 },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: "#EEF2FF" },
  editBtnText: { color: "#4F46E5", fontWeight: "700", fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  errorText: { fontSize: 14, color: "#6B7280", textAlign: "center" },
  retryBtn: { backgroundColor: "#D97706", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: "#FFF", fontWeight: "700" },
  body: { padding: 16, paddingBottom: 32, gap: 12 },
  card: { backgroundColor: "#FFF", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#F3F4F6", gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111827" },
  meta: { fontSize: 13, color: "#6B7280" },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeLive: { backgroundColor: "#D1FAE5" },
  badgeDraft: { backgroundColor: "#F3F4F6" },
  badgeText: { fontSize: 11, fontWeight: "700" },
  badgeTextLive: { color: "#047857" },
  badgeTextDraft: { color: "#6B7280" },
  facts: { gap: 10, marginTop: 6 },
  fact: { flexDirection: "row", alignItems: "center", gap: 10 },
  factLabel: { fontSize: 11, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: 0.4 },
  factValue: { fontSize: 14, color: "#111827", fontWeight: "600" },
  sectionLabel: { fontSize: 12, fontWeight: "700", color: "#6B7280", marginTop: 8, textTransform: "uppercase", letterSpacing: 0.4 },
  para: { fontSize: 14, color: "#374151", lineHeight: 20 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10 },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10 },
  actionText: { fontSize: 13, fontWeight: "700" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginTop: 8 },
  sectionCount: { fontSize: 13, fontWeight: "500", color: "#9CA3AF" },
  emptyBox: { alignItems: "center", padding: 24, gap: 8, backgroundColor: "#FFF", borderRadius: 14, borderWidth: 1, borderColor: "#F3F4F6" },
  emptyText: { fontSize: 13, color: "#9CA3AF" },
  subCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#FFF", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#F3F4F6" },
  subName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  subMeta: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  subText: { fontSize: 12, color: "#4B5563", marginTop: 4 },
  scorePill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: "#ECFDF5" },
  scorePillNone: { backgroundColor: "#F3F4F6" },
  scoreText: { fontSize: 12, fontWeight: "700", color: "#047857" },
  scoreTextNone: { color: "#6B7280" },
});
