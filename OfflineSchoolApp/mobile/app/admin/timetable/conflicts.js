// app/admin/timetable/conflicts.js
"use strict";

/**
 * Timetable conflicts — which lessons clash, and one tap to fix each.
 *
 * The dashboard's "1 timetable conflict detected" used to land on the bare
 * timetable, which could not say which lessons it meant. This screen lists
 * every conflict the shared detector finds (server online, this phone's rows
 * offline): one card each, grouped by day, with the lessons involved side by
 * side and, under each lesson, the fixes that would actually clear it.
 *
 * Every fix goes through timetableService, so it is saved locally, queued and
 * pushed exactly like an edit made in the builder. The list is fetched again
 * after each one; the dashboard recounts when it regains focus.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, StatusBar,
  ActivityIndicator, RefreshControl, Alert, Modal, Pressable,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import timetableService, {
  getConflicts,
  getResolutionOptions,
  syncTimetableFromServer,
} from "../../../src/services/timetableService";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";
import { useScreenInsets } from "../../../src/hooks/useScreenInsets";
import ConflictTypeBadge from "./components/ConflictTypeBadge";

const DAY_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_KEYS = {
  MON: "timetable.monday",   TUE: "timetable.tuesday", WED: "timetable.wednesday",
  THU: "timetable.thursday", FRI: "timetable.friday",  SAT: "timetable.saturday",
  SUN: "timetable.sunday",
};

/** Which fixes make sense for which kind of conflict. */
const ACTIONS_FOR = {
  TEACHER_DOUBLE_BOOKED: ["move", "teacher", "swap", "remove", "open"],
  CLASS_DOUBLE_BOOKED:   ["move", "remove", "open"],
  ROOM_DOUBLE_BOOKED:    ["move", "swap", "remove", "open"],
};

const ACTION_META = {
  move:    { icon: "time-outline",           key: "ttConflicts.actMove" },
  teacher: { icon: "person-outline",         key: "ttConflicts.actTeacher" },
  swap:    { icon: "swap-horizontal",        key: "ttConflicts.actSwap" },
  remove:  { icon: "trash-outline",          key: "ttConflicts.actRemove" },
  open:    { icon: "open-outline",           key: "ttConflicts.actOpen" },
};

/**
 * updateSlot works on this phone's copy. A lesson the server reported but
 * this phone has not pulled yet is fetched first, then the edit is retried.
 */
const withLocalCopy = async (entry, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (!/not found/i.test(String(err?.message))) throw err;
    await syncTimetableFromServer(entry.classId);
    return fn();
  }
};

export default function TimetableConflictsScreen() {
  const router = useRouter();
  const pad    = useScreenInsets({ top: 12 });
  const { t, language } = useTranslation();
  const mountedRef = useRef(true);

  const [conflicts,  setConflicts]  = useState([]);
  const [source,     setSource]     = useState("server");
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [working,    setWorking]    = useState(false);
  const [error,      setError]      = useState(null);

  // The fix sheet: which entry, which action, and the options for it.
  const [sheet, setSheet] = useState(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      setError(null);
      const res = await getConflicts(language);
      if (!mountedRef.current) return;
      setConflicts(res.conflicts);
      setSource(res.source);
    } catch (err) {
      console.error("[conflicts] load failed:", err);
      if (mountedRef.current) setError(errorText(t, err, "ttConflicts.loadFailed"));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [language, t]);

  // Fetched on every focus: coming back from the builder after a manual fix
  // must not show the conflict that was just cleared.
  useFocusEffect(useCallback(() => { load(false); }, [load]));

  const groups = useMemo(() => {
    const byDay = new Map();
    for (const c of conflicts) {
      const k = c.day ?? "PERIODS";
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(c);
    }
    return [...byDay.entries()].sort(([a], [b]) =>
      (a === "PERIODS" ? -1 : DAY_ORDER.indexOf(a)) - (b === "PERIODS" ? -1 : DAY_ORDER.indexOf(b)));
  }, [conflicts]);

  const dayLabel = useCallback((d) => (DAY_KEYS[d] ? t(DAY_KEYS[d]) : d), [t]);
  const periodText = useCallback((p) =>
    p.periodName || (p.periodNumber ? t("timetable.periodN", { n: p.periodNumber }) : ""), [t]);
  const timeText = (p) => (p.startTime && p.endTime ? `${p.startTime}–${p.endTime}` : "");

  // ── Running a fix ──────────────────────────────────────────────────────────
  const run = useCallback(async (entry, fn, doneKey) => {
    try {
      setWorking(true);
      await withLocalCopy(entry, fn);
      if (!mountedRef.current) return;
      setSheet(null);
      await load(false);
      Alert.alert(t("ttConflicts.fixedTitle"), t(doneKey));
    } catch (err) {
      console.error("[conflicts] fix failed:", err);
      Alert.alert(t("ttConflicts.fixFailedTitle"), errorText(t, err, "ttConflicts.fixFailedBody"));
    } finally {
      if (mountedRef.current) setWorking(false);
    }
  }, [load, t]);

  const openAction = useCallback(async (conflict, entry, action) => {
    if (action === "open") {
      router.push({
        pathname: "/admin/timetable/builder",
        params:   { classId: entry.classId, highlight: entry.entryId },
      });
      return;
    }
    if (action === "remove") {
      Alert.alert(
        t("ttConflicts.removeTitle"),
        t("ttConflicts.removeBody", { subject: entry.subjectName, cls: entry.className }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text:    t("common.remove"),
            style:   "destructive",
            onPress: () => run(entry, () => timetableService.deleteSlot(entry.entryId), "ttConflicts.removedBody"),
          },
        ],
      );
      return;
    }
    setSheet({ conflict, entry, action, options: null });
    try {
      const options = await getResolutionOptions(entry.entryId);
      if (mountedRef.current) setSheet((s) => (s && s.entry.entryId === entry.entryId ? { ...s, options } : s));
    } catch (err) {
      if (mountedRef.current) {
        setSheet(null);
        Alert.alert(t("ttConflicts.fixFailedTitle"), errorText(t, err, "ttConflicts.optionsFailed"));
      }
    }
  }, [router, run, t]);

  const pickMove = (entry, p) => run(entry,
    () => timetableService.updateSlot(entry.entryId, { dayOfWeek: p.dayOfWeek, periodId: p.periodId }),
    "ttConflicts.movedBody");

  const pickTeacher = (entry, ft) => run(entry,
    () => timetableService.updateSlot(entry.entryId, { teacherId: ft.teacherId }),
    "ttConflicts.teacherChangedBody");

  /**
   * A swap is two saves (each lesson takes the other's subject, teacher and
   * room). Each is valid on its own; if the second is refused the first is
   * put back, so a half-done swap never stays behind.
   */
  const pickSwap = (entry, sw) => run(entry, async () => {
    const [first, second] = sw.updates;
    const asEdit = (u) => ({ subjectId: u.subjectId, teacherId: u.teacherId, room: u.room ?? "" });
    await timetableService.updateSlot(first.entryId, asEdit(first));
    try {
      await withLocalCopy(sw, () => timetableService.updateSlot(second.entryId, asEdit(second)));
    } catch (err) {
      await timetableService.updateSlot(first.entryId, {
        subjectId: entry.subjectId, teacherId: entry.teacherId, room: entry.room ?? "",
      }).catch((revertErr) => console.warn("[conflicts] swap revert failed:", revertErr.message));
      throw err;
    }
  }, "ttConflicts.swappedBody");

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={[styles.header, { paddingTop: pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("ttConflicts.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {t("ttConflicts.count", { count: conflicts.length })}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#4F46E5" colors={["#4F46E5"]} />
        }
      >
        {source === "local" && (
          <View style={styles.infoBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color="#92400E" />
            <Text style={styles.infoText}>{t("ttConflicts.localSource")}</Text>
          </View>
        )}

        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!error && conflicts.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle" size={44} color="#059669" />
            <Text style={styles.emptyTitle}>{t("ttConflicts.noneTitle")}</Text>
            <Text style={styles.emptyBody}>{t("ttConflicts.noneBody")}</Text>
          </View>
        )}

        {groups.map(([day, list]) => (
          <View key={day} style={styles.group}>
            <Text style={styles.groupTitle}>
              {day === "PERIODS" ? t("ttConflicts.groupPeriods") : dayLabel(day)}
            </Text>

            {list.map((c) => (
              <View key={c.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <ConflictTypeBadge type={c.conflict_type} />
                  {c.day && (
                    <Text style={styles.when}>
                      {[dayLabel(c.day), periodText(c), timeText(c)].filter(Boolean).join(" · ")}
                    </Text>
                  )}
                </View>

                <Text style={styles.message}>{c.message}</Text>

                {c.conflict_type === "PERIOD_OVERLAP" ? (
                  <TouchableOpacity
                    style={styles.actionBtn}
                    onPress={() => router.push("/admin/periods")}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="time-outline" size={15} color="#4F46E5" />
                    <Text style={styles.actionText}>{t("ttConflicts.actEditPeriods")}</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.entries}>
                    {c.entries.map((e) => (
                      <View key={e.entryId} style={styles.entry}>
                        <Text style={styles.entryClass} numberOfLines={1}>{e.className}</Text>
                        <Text style={styles.entryLine} numberOfLines={2}>{e.subjectName}</Text>
                        <Text style={styles.entryLine} numberOfLines={1}>{e.teacherName}</Text>
                        <Text style={styles.entryMuted} numberOfLines={1}>
                          {e.room ? t("ttAdmin.roomShort", { room: e.room }) : t("ttConflicts.noRoom")}
                        </Text>

                        <View style={styles.entryActions}>
                          {(ACTIONS_FOR[c.conflict_type] ?? []).map((a) => (
                            <TouchableOpacity
                              key={a}
                              style={[styles.actionBtn, a === "remove" && styles.actionDanger]}
                              onPress={() => openAction(c, e, a)}
                              disabled={working}
                              activeOpacity={0.7}
                            >
                              <Ionicons
                                name={ACTION_META[a].icon}
                                size={14}
                                color={a === "remove" ? "#DC2626" : "#4F46E5"}
                              />
                              <Text style={[styles.actionText, a === "remove" && styles.actionDangerText]}>
                                {t(ACTION_META[a].key)}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>

      {/* ── Fix sheet: the options for one action on one lesson ── */}
      <Modal
        visible={!!sheet}
        transparent
        animationType="fade"
        onRequestClose={() => !working && setSheet(null)}
        statusBarTranslucent
      >
        <Pressable style={styles.overlay} onPress={() => !working && setSheet(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            {sheet && (
              <>
                <Text style={styles.sheetTitle}>{t(ACTION_META[sheet.action].key)}</Text>
                <Text style={styles.sheetSub}>
                  {`${sheet.entry.subjectName} · ${sheet.entry.className} · ${sheet.entry.teacherName}`}
                </Text>

                {!sheet.options || working ? (
                  <ActivityIndicator style={styles.sheetSpinner} color="#4F46E5" />
                ) : (
                  <ScrollView style={styles.sheetList}>
                    {sheet.action === "move" && (
                      sheet.options.freePeriods.length === 0
                        ? <Text style={styles.sheetEmpty}>{t("ttConflicts.noFreePeriods")}</Text>
                        : sheet.options.freePeriods.map((p) => (
                          <TouchableOpacity
                            key={`${p.dayOfWeek}-${p.periodId}`}
                            style={styles.option}
                            onPress={() => pickMove(sheet.entry, p)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.optionText}>
                              {[dayLabel(p.dayOfWeek), periodText(p), timeText(p)].filter(Boolean).join(" · ")}
                            </Text>
                            {p.sameDay && <Text style={styles.optionTag}>{t("ttConflicts.sameDay")}</Text>}
                          </TouchableOpacity>
                        ))
                    )}

                    {sheet.action === "teacher" && (
                      sheet.options.freeTeachers.length === 0
                        ? <Text style={styles.sheetEmpty}>{t("ttConflicts.noFreeTeachers")}</Text>
                        : sheet.options.freeTeachers.map((ft) => (
                          <TouchableOpacity
                            key={ft.teacherId}
                            style={styles.option}
                            onPress={() => pickTeacher(sheet.entry, ft)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.optionText}>{ft.teacherName}</Text>
                            {ft.teachesThisClass && (
                              <Text style={styles.optionTag}>{t("ttConflicts.teachesClass")}</Text>
                            )}
                          </TouchableOpacity>
                        ))
                    )}

                    {sheet.action === "swap" && (
                      sheet.options.swaps.length === 0
                        ? <Text style={styles.sheetEmpty}>{t("ttConflicts.noSwaps")}</Text>
                        : sheet.options.swaps.map((sw) => (
                          <TouchableOpacity
                            key={sw.entryId}
                            style={styles.option}
                            onPress={() => pickSwap(sheet.entry, sw)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.optionText}>
                              {[dayLabel(sw.dayOfWeek), periodText(sw), timeText(sw)].filter(Boolean).join(" · ")}
                            </Text>
                            <Text style={styles.optionSub}>{`${sw.subjectName} · ${sw.teacherName}`}</Text>
                          </TouchableOpacity>
                        ))
                    )}
                  </ScrollView>
                )}

                <TouchableOpacity
                  style={styles.sheetClose}
                  onPress={() => setSheet(null)}
                  disabled={working}
                  activeOpacity={0.7}
                >
                  <Text style={styles.sheetCloseText}>{t("common.cancel")}</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered:  { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  scroll:    { padding: 16, paddingBottom: 48 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingBottom:     12,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backButton:     { padding: 4, marginRight: 8 },
  headerCenter:   { flex: 1 },
  headerTitle:    { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },

  infoBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 10, borderRadius: 10, backgroundColor: "#FEF3C7", marginBottom: 12,
  },
  infoText:    { flex: 1, fontSize: 12, color: "#92400E" },
  errorBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 12, borderRadius: 10, backgroundColor: "#FEE2E2", marginBottom: 12,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B" },

  empty:      { alignItems: "center", paddingVertical: 48, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  emptyBody:  { fontSize: 13, color: "#6B7280", textAlign: "center" },

  group:      { marginBottom: 16 },
  groupTitle: { fontSize: 15, fontWeight: "700", color: "#374151", marginBottom: 8 },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius:    12,
    padding:         12,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     "#FECACA",
    gap:             8,
  },
  cardTop: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  when:    { fontSize: 12, fontWeight: "600", color: "#4B5563" },
  message: { fontSize: 14, color: "#111827", lineHeight: 20 },

  entries: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  entry: {
    flexGrow:        1,
    flexBasis:       140,
    padding:         10,
    borderRadius:    10,
    backgroundColor: "#F9FAFB",
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    gap:             2,
  },
  entryClass: { fontSize: 14, fontWeight: "700", color: "#111827" },
  entryLine:  { fontSize: 13, color: "#374151" },
  entryMuted: { fontSize: 12, color: "#6B7280" },
  entryActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },

  actionBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    alignSelf:         "flex-start",
    gap:               4,
    paddingVertical:   6,
    paddingHorizontal: 8,
    borderRadius:      8,
    backgroundColor:   "#EEF2FF",
  },
  actionText:       { fontSize: 12, fontWeight: "600", color: "#4F46E5" },
  actionDanger:     { backgroundColor: "#FEE2E2" },
  actionDangerText: { color: "#DC2626" },

  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", paddingHorizontal: 16,
  },
  sheet:        { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 16, maxHeight: "80%" },
  sheetTitle:   { fontSize: 17, fontWeight: "700", color: "#111827" },
  sheetSub:     { fontSize: 13, color: "#6B7280", marginTop: 2, marginBottom: 12 },
  sheetSpinner: { paddingVertical: 24 },
  sheetList:    { flexGrow: 0 },
  sheetEmpty:   { fontSize: 13, color: "#6B7280", fontStyle: "italic", paddingVertical: 12 },
  option: {
    padding:         12,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    marginBottom:    8,
  },
  optionText: { fontSize: 14, fontWeight: "600", color: "#111827" },
  optionSub:  { fontSize: 12, color: "#6B7280", marginTop: 2 },
  optionTag:  { fontSize: 11, fontWeight: "700", color: "#059669", marginTop: 2 },
  sheetClose: {
    marginTop: 8, alignSelf: "flex-end", paddingVertical: 10, paddingHorizontal: 16,
    borderRadius: 10, backgroundColor: "#E5E7EB",
  },
  sheetCloseText: { fontWeight: "700", color: "#374151" },
});
