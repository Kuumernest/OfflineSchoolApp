// app/admin/timetable/index.js
"use strict";

import React, {
  useEffect, useState, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl, StatusBar,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { getDatabase }    from "../../../src/db/database";
import { ClassService }   from "../../../src/services/class.service";
import { PeriodsService } from "../../../src/services/periods.service";
import { SubjectService } from "../../../src/services/subject.service";
import timetableService, {
  pushUnsyncedTimetableSlots,
  syncTimetableFromServer,
  canonicalDay,
} from "../../../src/services/timetableService";
import SlotEditorModal from "./components/SlotEditorModal";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * DAYS uses full canonical names so they match the values that
 * timetableService stores in SQLite (always full lowercase).
 * The label field is for display only.
 */
const DAYS = [
  { key: "monday",    label: "Mon" },
  { key: "tuesday",   label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday",  label: "Thu" },
  { key: "friday",    label: "Fri" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves a display name for a slot's related entity (subject / teacher).
 * Uses an options object instead of positional parameters to prevent
 * accidental transposition at call sites.
 */
const resolveName = (slot, { objectKey, nameKey, idKey, altIdKey }, lookupMap) => {
  if (slot[nameKey] && typeof slot[nameKey] === "string") return slot[nameKey];
  if (slot[objectKey] && typeof slot[objectKey] === "object")
    return slot[objectKey].name || slot[objectKey].label || "";
  const id = slot[idKey] ? String(slot[idKey]).trim() : null;
  if (id && lookupMap?.has(id)) return lookupMap.get(id);
  if (altIdKey) {
    const altId = slot[altIdKey] ? String(slot[altIdKey]).trim() : null;
    if (altId && lookupMap?.has(altId)) return lookupMap.get(altId);
  }
  return "";
};

const getPeriodTime = (period) => ({
  start: period.startTime || period.starttime || "",
  end:   period.endTime   || period.endtime   || "",
});

// ─────────────────────────────────────────────────────────────────────────────

export default function AdminTimetableBuilder() {
  const router     = useRouter();
  const mountedRef = useRef(true);
  const initialLoadDoneRef = useRef(false);

  // Keep a ref in sync with selectedClassId so loadInitialData
  // can check it without capturing it as a dependency.
  const selectedClassIdRef = useRef(null);

  const [classes,    setClasses]    = useState([]);
  const [periods,    setPeriods]    = useState([]);
  const [slots,      setSlots]      = useState([]);
  const [subjectMap, setSubjectMap] = useState(new Map());
  const [teacherMap, setTeacherMap] = useState(new Map());

  const [selectedClassId, setSelectedClassId] = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [refreshing,      setRefreshing]       = useState(false);
  const [syncing,         setSyncing]          = useState(false);
  const [error,           setError]            = useState(null);
  const [unsyncedCount,   setUnsyncedCount]    = useState(0);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalMode,    setModalMode]    = useState("create");
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  // Keep ref in sync
  useEffect(() => {
    selectedClassIdRef.current = selectedClassId;
  }, [selectedClassId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Unsynced count ──────────────────────────────────────────────────────────
  const refreshUnsyncedCount = useCallback(async () => {
    try {
      const db  = await getDatabase();
      const row = await db.getFirstAsync(
        `SELECT COUNT(*) AS count
         FROM   timetable
         WHERE  (_synced = 0 OR _synced IS NULL)
           AND  (deleted_at IS NULL OR deleted_at = '')`
      ).catch(() => null);
      if (mountedRef.current) setUnsyncedCount(row?.count ?? 0);
    } catch { /* non-fatal */ }
  }, []);

  // ── Lookup maps ─────────────────────────────────────────────────────────────
  /**
   * Builds subject and teacher Maps keyed by their server ID string.
   *
   * Subject names were previously missing because SubjectService.getAll()
   * is only called by SlotEditorModal — it never ran during grid load.
   * This function now detects an empty subjectMap and triggers a subject
   * sync so the grid always has names to display.
   */
  const buildLookupMaps = useCallback(async (db) => {
    let newSubjectMap = new Map();
    let newTeacherMap = new Map();

    /**
     * Returns the actual PRIMARY KEY column name for a table.
     * Checks the SQLite pk flag first, then falls back to common names.
     */
    const resolvePkCol = (cols) =>
      (cols || []).find((c) => c.pk === 1)?.name
      || (cols || []).find((c) => c.name === "_id")?.name
      || (cols || []).find((c) => c.name === "id")?.name
      || null;

    // ── Subjects ──────────────────────────────────────────────────────────
    try {
      const cols  = await db.getAllAsync(`PRAGMA table_info(subjects)`).catch(() => []);
      const pkCol = resolvePkCol(cols);

      if (pkCol) {
        const readSubjects = async () =>
          db.getAllAsync(
            `SELECT ${pkCol} AS pk, name
             FROM   subjects
             WHERE  (deleted_at IS NULL OR deleted_at = '')
               AND  name IS NOT NULL AND name != ''`
          ).catch(() => []);

        let rows = await readSubjects();

        // If the local subjects table is empty, pull from the server now
        // so the grid has subject names to display immediately.
        if (!rows.length) {
          console.warn("[timetable] subjectMap empty — syncing subjects from server…");
          try {
            await SubjectService.getAll();   // persists server subjects locally
            rows = await readSubjects();
          } catch (syncErr) {
            console.warn("[timetable] Subject sync failed:", syncErr.message);
          }
        }

        rows.forEach((s) => {
          if (s.pk && s.name) {
            newSubjectMap.set(String(s.pk).trim(), s.name);
          }
        });
        console.log(`🗂️ subjectMap: ${newSubjectMap.size} entries`);
      }
    } catch (err) {
      console.warn("[timetable] buildLookupMaps subjects error:", err.message);
    }

    // ── Teachers ──────────────────────────────────────────────────────────
    try {
      const cols  = await db.getAllAsync(`PRAGMA table_info(users)`).catch(() => []);
      const pkCol = resolvePkCol(cols);

      if (pkCol) {
        const rows = await db.getAllAsync(
          `SELECT ${pkCol} AS pk, name
           FROM   users
           WHERE  LOWER(role) = 'teacher'
             AND  (deleted_at IS NULL OR deleted_at = '')
             AND  name IS NOT NULL AND name != ''`
        ).catch(() => []);

        rows.forEach((t) => {
          if (t.pk && t.name) {
            newTeacherMap.set(String(t.pk).trim(), t.name);
          }
        });
        console.log(`🗂️ teacherMap: ${newTeacherMap.size} entries`);
      }
    } catch (err) {
      console.warn("[timetable] buildLookupMaps teachers error:", err.message);
    }

    return { newSubjectMap, newTeacherMap };
  }, []);

  // ── Load slots for selected class ───────────────────────────────────────────
  const loadSlots = useCallback(async () => {
    if (!selectedClassIdRef.current) {
      setSlots([]);
      return;
    }
    try {
      const data = await timetableService.getByClass(selectedClassIdRef.current);
      if (mountedRef.current) setSlots(data || []);
      await refreshUnsyncedCount();
    } catch (err) {
      console.error("loadSlots failed:", err);
      if (mountedRef.current) Alert.alert("Error", "Failed to load timetable slots");
    }
  }, [refreshUnsyncedCount]);

  // ── Full initial load ───────────────────────────────────────────────────────
  const loadInitialData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      if (isRefresh) {
        try {
          setSyncing(true);
          await pushUnsyncedTimetableSlots();
        } catch (err) {
          console.warn("pushUnsyncedTimetableSlots failed:", err.message);
        } finally {
          if (mountedRef.current) setSyncing(false);
        }
      }

      const db = await getDatabase();

      const [classRows, periodRows] = await Promise.all([
        ClassService.getAll(false),
        PeriodsService.getAll(false),
      ]);

      const { newSubjectMap, newTeacherMap } = await buildLookupMaps(db);

      if (!mountedRef.current) return;

      const activeClasses = (classRows || []).filter(
        (c) => c.isActive !== 0 && c.isActive !== false
      );

      const activePeriods = (periodRows || [])
        .filter((p) =>
          p.isActive !== 0 && p.isActive !== false &&
          !p.isbreak && !p.isBreak
        )
        .sort((a, b) => {
          const ao = a.sortOrder ?? a.sortorder ?? a.periodNumber ?? 0;
          const bo = b.sortOrder ?? b.sortorder ?? b.periodNumber ?? 0;
          return ao - bo;
        });

      setClasses(activeClasses);
      setPeriods(activePeriods);
      setSubjectMap(newSubjectMap);
      setTeacherMap(newTeacherMap);

      // Use the ref so this callback does not depend on selectedClassId state
      if (activeClasses.length > 0 && !selectedClassIdRef.current) {
        setSelectedClassId(activeClasses[0].id);
      }

      await refreshUnsyncedCount();
    } catch (err) {
      console.error("loadInitialData failed:", err);
      if (mountedRef.current) setError("Failed to load timetable configuration.");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        initialLoadDoneRef.current = true;
      }
    }
  }, [buildLookupMaps, refreshUnsyncedCount]);

  // ── Boot ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadInitialData();
  }, []);

  // ── Focus effect — lightweight refresh, push only when pending ──────────────
  useFocusEffect(
    useCallback(() => {
      if (!initialLoadDoneRef.current) return;

      const run = async () => {
        await loadSlots();
        await refreshUnsyncedCount();
        if (unsyncedCount > 0) {
          await loadInitialData(true);
        }
      };

      run().catch(console.warn);
    }, [loadSlots, refreshUnsyncedCount, unsyncedCount, loadInitialData])
  );

  // ── Re-load slots when selected class changes ───────────────────────────────
  useEffect(() => {
    if (selectedClassId) loadSlots();
  }, [selectedClassId]);

  // ── After slots load, rebuild lookup maps so new subjects are captured ───────
  //    This handles the case where slots were synced AFTER the initial map build.
  useEffect(() => {
    if (!slots.length) return;

    const rebuildIfNeeded = async () => {
      // Check if any slot's subjectId is missing from the current map
      const missingSubject = slots.some((s) => {
        const sid = s.subjectId ? String(s.subjectId).trim() :
                    s.subject_id ? String(s.subject_id).trim() : null;
        return sid && !subjectMap.has(sid);
      });

      if (missingSubject) {
        console.log("[timetable] Detected missing subject names — rebuilding lookup maps…");
        try {
          const db = await getDatabase();
          const { newSubjectMap, newTeacherMap } = await buildLookupMaps(db);
          if (mountedRef.current) {
            setSubjectMap(newSubjectMap);
            setTeacherMap(newTeacherMap);
          }
        } catch (err) {
          console.warn("[timetable] Lookup map rebuild failed:", err.message);
        }
      }
    };

    rebuildIfNeeded();
  }, [slots]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    await loadInitialData(true);
    if (selectedClassIdRef.current) await loadSlots();
  }, [loadInitialData, loadSlots]);

  const handleManualSync = useCallback(async () => {
    if (syncing) return;
    try {
      setSyncing(true);
      await pushUnsyncedTimetableSlots();

      if (selectedClassIdRef.current) {
        await syncTimetableFromServer(selectedClassIdRef.current);
        await loadSlots();
      }

      await refreshUnsyncedCount();
      if (mountedRef.current) Alert.alert("Synced", "Timetable synced with server.");
    } catch (err) {
      Alert.alert("Sync Failed", err.message || "Could not sync timetable.");
    } finally {
      if (mountedRef.current) setSyncing(false);
    }
  }, [syncing, loadSlots, refreshUnsyncedCount]);

  // ── Derived data ─────────────────────────────────────────────────────────────
  const selectedClass = useMemo(
    () => classes.find((c) => c.id === selectedClassId) || null,
    [classes, selectedClassId]
  );

  /**
   * Builds a Map keyed by "day|periodId" for O(1) grid cell lookup.
   *
   * Subject names were previously "—" because subjectMap was built before
   * subjects were synced. Now:
   *  1. buildLookupMaps forces a subject sync if the map would be empty.
   *  2. The effect above rebuilds the map if any slot still has a missing name.
   *  3. resolveName trims IDs before lookup to prevent whitespace mismatches.
   */
  const slotMap = useMemo(() => {
    const map = new Map();

    slots.forEach((s) => {
      const dayKey = s.dayOfWeek   ? canonicalDay(s.dayOfWeek)   :
                     s.day_of_week ? canonicalDay(s.day_of_week) : null;
      const periodKey = s.periodId || s.period_id || null;
      if (!dayKey || !periodKey) return;

      // Normalise IDs — trim whitespace so map lookups never silently miss
      const rawSubjectId =
        (s.subjectId  ? String(s.subjectId).trim()  : null) ||
        (s.subject_id ? String(s.subject_id).trim() : null) ||
        null;

      const rawTeacherId =
        (s.teacherId  ? String(s.teacherId).trim()  : null) ||
        (s.teacher_id ? String(s.teacher_id).trim() : null) ||
        null;

      // Direct map lookup first (fastest path), then fall through to resolveName
      const subjectName =
        (rawSubjectId && subjectMap.get(rawSubjectId)) ||
        resolveName(s, {
          objectKey: "subject",
          nameKey:   "subjectName",
          idKey:     "subjectId",
          altIdKey:  "subject_id",
        }, subjectMap) ||
        "—";

      const teacherName =
        (rawTeacherId && teacherMap.get(rawTeacherId)) ||
        resolveName(s, {
          objectKey: "teacher",
          nameKey:   "teacherName",
          idKey:     "teacherId",
          altIdKey:  "teacher_id",
        }, teacherMap) ||
        "—";

      map.set(`${dayKey}|${periodKey}`, {
        ...s,
        dayOfWeek:   dayKey,
        periodId:    periodKey,
        subjectName,
        teacherName,
      });
    });

    return map;
  }, [slots, subjectMap, teacherMap]);

  // day.key is already canonical ("monday" etc.) — lookup is direct
  const getSlot = useCallback(
    (dayOfWeek, periodId) => slotMap.get(`${dayOfWeek}|${periodId}`) || null,
    [slotMap]
  );

  const openCreateModal = useCallback((dayOfWeek, period) => {
    setModalMode("create");
    setSelectedSlot(null);
    setSelectedCell({ dayOfWeek, period });
    setModalVisible(true);
  }, []);

  const openEditModal = useCallback((slot, dayOfWeek, period) => {
    setModalMode("edit");
    setSelectedSlot(slot);
    setSelectedCell({ dayOfWeek, period });
    setModalVisible(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalVisible(false);
    setSelectedSlot(null);
    setSelectedCell(null);
  }, []);

  const handleSaveSlot = useCallback(async ({ subjectId, teacherId, room }) => {
    try {
      if (modalMode === "edit" && selectedSlot) {
        const slotId = selectedSlot._id || selectedSlot.id;
        if (!slotId) throw new Error("Cannot update slot — missing id");

        await timetableService.updateSlot(slotId, {
          classId:   selectedClassIdRef.current,
          subjectId,
          teacherId,
          dayOfWeek: selectedCell.dayOfWeek,
          periodId:  selectedCell.period.id,
          room,
        });
      } else {
        await timetableService.createSlot({
          classId:   selectedClassIdRef.current,
          subjectId,
          teacherId,
          dayOfWeek: selectedCell.dayOfWeek,
          periodId:  selectedCell.period.id,
          room,
        });
      }

      if (mountedRef.current) {
        closeModal();
        // Rebuild lookup maps after save so the new slot's subject name appears
        const db = await getDatabase();
        const { newSubjectMap, newTeacherMap } = await buildLookupMaps(db);
        if (mountedRef.current) {
          setSubjectMap(newSubjectMap);
          setTeacherMap(newTeacherMap);
        }
        await loadSlots();
        if (mountedRef.current) Alert.alert("Saved", "Timetable slot saved successfully");
      }
    } catch (err) {
      console.error("handleSaveSlot failed:", err);
      Alert.alert("Could Not Save", err.message || "Failed to save timetable slot");
    }
  }, [modalMode, selectedSlot, selectedCell, loadSlots, closeModal, buildLookupMaps]);

  const handleDeleteSlot = useCallback(async () => {
    if (!selectedSlot) return;

    Alert.alert(
      "Remove Slot",
      "Are you sure you want to clear this timetable slot?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text:  "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              const slotId = selectedSlot._id || selectedSlot.id;
              if (!slotId) throw new Error("Cannot delete slot — missing id");

              await timetableService.deleteSlot(slotId);

              if (mountedRef.current) {
                closeModal();
                await loadSlots();
                if (mountedRef.current) Alert.alert("Removed", "Slot cleared from timetable");
              }
            } catch (err) {
              Alert.alert("Error", err.message || "Failed to remove slot");
            }
          },
        },
      ]
    );
  }, [selectedSlot, loadSlots, closeModal]);

  // ── Render ───────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Initializing timetable grid…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Timetable Builder</Text>
          <Text style={styles.headerSubtitle}>Configure weekly schedules</Text>
        </View>

        <TouchableOpacity
          style={[styles.syncButton, unsyncedCount > 0 && styles.syncButtonPending]}
          onPress={handleManualSync}
          activeOpacity={0.7}
          disabled={syncing}
        >
          {syncing ? (
            <ActivityIndicator size="small" color="#4F46E5" />
          ) : (
            <>
              <Ionicons
                name="cloud-upload-outline"
                size={20}
                color={unsyncedCount > 0 ? "#D97706" : "#4F46E5"}
              />
              {unsyncedCount > 0 && (
                <View style={styles.syncBadge}>
                  <Text style={styles.syncBadgeText}>
                    {unsyncedCount > 99 ? "99+" : unsyncedCount}
                  </Text>
                </View>
              )}
            </>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* ── Error banner ── */}
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadInitialData()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Unsynced banner ── */}
        {unsyncedCount > 0 && !syncing && (
          <TouchableOpacity
            style={styles.unsyncedBanner}
            onPress={handleManualSync}
            activeOpacity={0.8}
          >
            <Ionicons name="warning-outline" size={18} color="#D97706" />
            <Text style={styles.unsyncedText}>
              {unsyncedCount} slot{unsyncedCount !== 1 ? "s" : ""} not yet synced. Tap to sync.
            </Text>
            <Ionicons name="chevron-forward" size={16} color="#D97706" />
          </TouchableOpacity>
        )}

        {/* ── Syncing banner ── */}
        {syncing && (
          <View style={styles.syncingBanner}>
            <ActivityIndicator size="small" color="#4F46E5" />
            <Text style={styles.syncingText}>Syncing with server…</Text>
          </View>
        )}

        {/* ── Class selector ── */}
        <Text style={styles.sectionLabel}>Select Class</Text>

        {classes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="school-outline" size={28} color="#9CA3AF" />
            <Text style={styles.emptyText}>No active classes found.</Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.classChipsScroll}
            contentContainerStyle={styles.classChipsContent}
          >
            {classes.map((cls) => {
              const isSelected = selectedClassId === cls.id;
              return (
                <TouchableOpacity
                  key={cls.id}
                  style={[styles.classChip, isSelected && styles.classChipActive]}
                  onPress={() => setSelectedClassId(cls.id)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.classChipText, isSelected && styles.classChipTextActive]}>
                    {cls.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* ── Period config hint ── */}
        <View style={styles.configBanner}>
          <Ionicons name="time-outline" size={18} color="#4F46E5" />
          <Text style={styles.configBannerText}>
            Time periods are synced from the server.
          </Text>
          <TouchableOpacity onPress={() => router.push("/admin/periods")} activeOpacity={0.7}>
            <Text style={styles.configAction}>Configure</Text>
          </TouchableOpacity>
        </View>

        {/* ── Grid ── */}
        {!selectedClassId ? (
          <View style={styles.emptyState}>
            <Ionicons name="school-outline" size={32} color="#9CA3AF" />
            <Text style={styles.emptyText}>Please select a class above.</Text>
          </View>
        ) : periods.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="hourglass-outline" size={32} color="#D97706" />
            <Text style={styles.emptyText}>
              No active periods found.{"\n"}Configure system periods first.
            </Text>
          </View>
        ) : (
          <View>
            <Text style={styles.gridMetaTitle}>
              {"Editing: "}
              <Text style={styles.highlightText}>{selectedClass?.name || ""}</Text>
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
              <View>
                {/* Column headers */}
                <View style={styles.gridHeader}>
                  <View style={styles.periodHeaderCell}>
                    <Text style={styles.gridHeaderText}>Period</Text>
                  </View>
                  {DAYS.map((day) => (
                    <View key={day.key} style={styles.dayHeaderCell}>
                      <Text style={styles.gridHeaderText}>{day.label}</Text>
                    </View>
                  ))}
                </View>

                {/* Rows */}
                {periods.map((period) => {
                  const { start, end } = getPeriodTime(period);
                  return (
                    <View key={period.id} style={styles.gridRow}>
                      {/* Period label */}
                      <View style={styles.periodCell}>
                        <Text style={styles.periodName} numberOfLines={1}>
                          {period.name}
                        </Text>
                        {(start || end) && (
                          <Text style={styles.periodTime}>
                            {start}{start && end ? " – " : ""}{end}
                          </Text>
                        )}
                      </View>

                      {/* Slot cells */}
                      {DAYS.map((day) => {
                        const slot    = getSlot(day.key, period.id);
                        const pending = slot && slot._synced === 0;

                        return (
                          <TouchableOpacity
                            key={`${day.key}-${period.id}`}
                            style={[
                              styles.slotCell,
                              slot
                                ? pending ? styles.pendingSlot : styles.filledSlot
                                : styles.emptySlot,
                            ]}
                            onPress={() =>
                              slot
                                ? openEditModal(slot, day.key, period)
                                : openCreateModal(day.key, period)
                            }
                            activeOpacity={0.7}
                          >
                            {slot ? (
                              <View style={styles.slotInner}>
                                <Text style={styles.subjectText} numberOfLines={2}>
                                  {slot.subjectName}
                                </Text>
                                <Text style={styles.teacherText} numberOfLines={1}>
                                  {slot.teacherName}
                                </Text>
                                {!!slot.room && (
                                  <Text style={styles.roomText} numberOfLines={1}>
                                    Rm: {slot.room}
                                  </Text>
                                )}
                                {pending && (
                                  <View style={styles.pendingDot}>
                                    <Ionicons
                                      name="cloud-offline-outline"
                                      size={10}
                                      color="#D97706"
                                    />
                                  </View>
                                )}
                              </View>
                            ) : (
                              <Ionicons name="add" size={20} color="#D1D5DB" />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}

        <View style={styles.bottomSpacer} />
      </ScrollView>

      {/* ── Slot editor modal ── */}
      {modalVisible && (
        <SlotEditorModal
          mode={modalMode}
          slot={selectedSlot}
          cell={selectedCell}
          classId={selectedClassId}
          onClose={closeModal}
          onSave={handleSaveSlot}
          onDelete={handleDeleteSlot}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#F9FAFB", gap: 12,
  },
  loadingText: { fontSize: 14, color: "#6B7280", fontWeight: "500" },

  scrollContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 },
  bottomSpacer:  { height: 40 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter:   { flex: 1, marginLeft: 12 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },

  syncButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center", marginLeft: 8,
  },
  syncButtonPending: { backgroundColor: "#FEF3C7" },
  syncBadge: {
    position: "absolute", top: 4, right: 4,
    backgroundColor: "#D97706", borderRadius: 6,
    minWidth: 12, height: 12,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 2,
  },
  syncBadgeText: { fontSize: 8, color: "#FFFFFF", fontWeight: "700" },

  errorBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEE2E2", padding: 12, borderRadius: 10,
    marginBottom: 12, gap: 8,
  },
  errorText:  { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText:  { fontSize: 13, fontWeight: "700", color: "#DC2626" },

  unsyncedBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEF3C7", padding: 12, borderRadius: 10,
    marginBottom: 12, gap: 8,
  },
  unsyncedText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },

  syncingBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", padding: 12, borderRadius: 10,
    marginBottom: 12, gap: 8,
  },
  syncingText: { flex: 1, fontSize: 13, color: "#4F46E5", fontWeight: "500" },

  configBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", padding: 12, borderRadius: 12,
    marginBottom: 20, gap: 8,
  },
  configBannerText: { flex: 1, fontSize: 12, color: "#4F46E5", fontWeight: "500" },
  configAction:     { fontSize: 12, fontWeight: "700", color: "#4F46E5" },

  sectionLabel:  { fontSize: 14, fontWeight: "700", color: "#374151", marginBottom: 8 },
  gridMetaTitle: { fontSize: 14, fontWeight: "600", color: "#6B7280", marginBottom: 12 },
  highlightText: { color: "#111827", fontWeight: "700" },

  classChipsScroll:   { marginBottom: 16, marginHorizontal: -20 },
  classChipsContent:  { paddingHorizontal: 20 },
  classChip: {
    backgroundColor: "#FFFFFF", paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20, marginRight: 8, borderWidth: 1, borderColor: "#E5E7EB",
  },
  classChipActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  classChipText:       { fontSize: 13, fontWeight: "600", color: "#374151" },
  classChipTextActive: { color: "#FFFFFF" },

  gridHeader:       { flexDirection: "row", marginBottom: 6 },
  periodHeaderCell: { width: 110, padding: 8 },
  dayHeaderCell:    { width: 110, padding: 8, alignItems: "center" },
  gridHeaderText:   { fontWeight: "700", color: "#374151", fontSize: 13 },

  gridRow:  { flexDirection: "row", marginBottom: 6 },
  periodCell: {
    width: 110, minHeight: 82,
    backgroundColor: "#FFFFFF", borderRadius: 12, padding: 10,
    justifyContent: "center", marginRight: 4,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  periodName: { fontWeight: "700", color: "#111827", fontSize: 13 },
  periodTime: { fontSize: 11, color: "#6B7280", marginTop: 3 },

  slotCell: {
    width: 110, minHeight: 82, borderRadius: 12,
    marginHorizontal: 2, padding: 6,
    alignItems: "center", justifyContent: "center", borderWidth: 1.5,
  },
  emptySlot:   { backgroundColor: "#FFFFFF", borderColor: "#E5E7EB", borderStyle: "dashed" },
  filledSlot:  { backgroundColor: "#ECFDF5", borderColor: "#059669" },
  pendingSlot: { backgroundColor: "#FFFBEB", borderColor: "#D97706", borderStyle: "dashed" },

  slotInner:   { alignItems: "center", justifyContent: "center", width: "100%" },
  subjectText: { fontSize: 12, fontWeight: "700", color: "#111827", textAlign: "center" },
  teacherText: { fontSize: 11, color: "#059669", marginTop: 3, textAlign: "center", fontWeight: "500" },
  roomText:    { fontSize: 10, color: "#6B7280", marginTop: 2, textAlign: "center" },
  pendingDot:  { marginTop: 4 },

  emptyState: {
    backgroundColor: "#FFFFFF", borderRadius: 14, padding: 24,
    alignItems: "center", marginTop: 10,
    borderWidth: 1, borderColor: "#E5E7EB", gap: 8,
  },
  emptyBox: {
    backgroundColor: "#FFFFFF", borderRadius: 12, padding: 16,
    alignItems: "center", borderWidth: 1, borderColor: "#E5E7EB",
    marginBottom: 16, gap: 6,
  },
  emptyText: { color: "#6B7280", fontSize: 13, textAlign: "center" },
});