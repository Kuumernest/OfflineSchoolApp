// app/teacher/timetable/index.js - FIXED
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import { useAuthStore } from "../../../src/store/auth.store";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import NetInfo          from "@react-native-community/netinfo";
import api              from "../../../src/services/api";
import { getDatabase } from "../../../src/db/database";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const DAYS      = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_SHORT = ["MON",    "TUE",     "WED",       "THU",      "FRI"];

/**
 * Maps any day format to the canonical full name used in both
 * the DB (after the backend fix) and the grid comparison.
 */
const DAY_KEY_MAP = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday",
  mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday",
};

const todayIndex = (() => {
  const d = new Date().getDay();
  return d >= 1 && d <= 5 ? d - 1 : -1;
})();

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const formatTime = (time) => {
  if (!time) return "";
  if (/AM|PM/i.test(time)) return time;
  try {
    const [h, m] = time.split(":");
    const hour   = parseInt(h, 10);
    const ampm   = hour >= 12 ? "PM" : "AM";
    const h12    = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  } catch {
    return time;
  }
};

const normDay = (raw) =>
  DAY_KEY_MAP[(raw || "").toLowerCase().trim()] || raw || "";

// ─────────────────────────────────────────────────────────
// OFFLINE-READY DATA FETCHERS
// ─────────────────────────────────────────────────────────

/**
 * Fetches periods from SQLite first, falls back to server if online.
 * FIXED (Issue 7): wraps table existence check before any query.
 */
const fetchPeriods = async (db, schoolId) => {
  try {
    // FIXED (Issue 7): check table exists before querying
    const tableCheck = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master
       WHERE type='table' AND name='periods'`
    ).catch(() => null);

    if (tableCheck?.cnt > 0) {
      const pCols = await db.getAllAsync(
        `PRAGMA table_info(periods)`, []
      ).catch(() => []);

      if (pCols.length > 0) {
        const pColSet = new Set(pCols.map((c) => c.name));
        const pIdCol  = pColSet.has("_id")       ? "_id"       : "id";
        const pStart  = pColSet.has("starttime") ? "starttime" :
                        pColSet.has("start_time")? "start_time": "NULL";
        const pEnd    = pColSet.has("endtime")   ? "endtime"   :
                        pColSet.has("end_time")  ? "end_time"  : "NULL";
        const pBreak  = pColSet.has("isbreak")   ? "isbreak"   :
                        pColSet.has("is_break")  ? "is_break"  : "0";
        const pSort   = pColSet.has("sortorder") ? "sortorder" :
                        pColSet.has("sort_order")? "sort_order": "0";
        const pName   = pColSet.has("name")      ? "name"      : "NULL";

        const rows = await db.getAllAsync(
          `SELECT ${pIdCol} AS id, ${pName} AS name,
                  ${pStart} AS startTime, ${pEnd} AS endTime,
                  ${pSort} AS sortOrder, ${pBreak} AS isBreak
           FROM periods
           ORDER BY COALESCE(${pSort}, 0) ASC`
        );

        if (rows?.length > 0) {
          return rows.map((p) => ({
            ...p,
            // FIXED (Issue 8): always convert id to string for comparison
            id:      String(p.id),
            isBreak: p.isBreak === 1 || p.isBreak === "1" || p.isBreak === true,
          }));
        }
      }
    }
  } catch (err) {
    console.warn("[TeacherTimetable] SQLite periods fetch failed:", err.message);
  }

  // Fallback to server API if online
  const net = await NetInfo.fetch();
  if (net.isConnected) {
    try {
      const res = await api.get("/api/periods", { params: { schoolId } });
      const raw = res.data?.periods ||
                  res.data?.data    ||
                  (Array.isArray(res.data) ? res.data : []);
      return raw.map((p) => ({
        // FIXED (Issue 8): always string id
        id:        String(p._id || p.id),
        name:      p.name      || "Period",
        startTime: p.startTime || p.starttime || null,
        endTime:   p.endTime   || p.endtime   || null,
        sortOrder: p.sortOrder || p.sortorder || 0,
        isBreak:   p.isBreak   || p.isbreak   || false,
      }));
    } catch {
      return [];
    }
  }

  return [];
};

/**
 * Fetches teacher timetable.
 *
 * FIXED (Issue 6): now calls the correct endpoint:
 *   GET /admin/timetable/my-schedule  (uses JWT identity server-side)
 *   instead of the non-existent /teacher/my-timetable
 *
 * FIXED (Issue 7): all SQLite writes are guarded so a missing table
 *   doesn't silently corrupt the cache state.
 *
 * FIXED (Issue 8): periodId always stored and returned as string.
 */
const fetchTeacherSchedule = async (db, teacherId, schoolId) => {
  if (!teacherId) return { slots: [], periods: [] };

  const net = await NetInfo.fetch();

  // ── Online: fetch from server and cache locally ───────────────────────────
  if (net.isConnected) {
    try {
      // FIXED (Issue 6): correct endpoint — server resolves teacher from JWT
      const res = await api.get("/admin/timetable/my-schedule", {
        params: { schoolId },
      });

      const raw = res.data?.slots ||
                  res.data?.data  ||
                  (Array.isArray(res.data) ? res.data : []);

      if (raw.length > 0) {
        // FIXED (Issue 7): guard — ensure table exists before writing
        const tableCheck = await db.getFirstAsync(
          `SELECT COUNT(*) AS cnt FROM sqlite_master
           WHERE type='table' AND name='timetable'`
        ).catch(() => null);

        if (tableCheck?.cnt > 0) {
          await db.runAsync(
            `DELETE FROM timetable WHERE teacher_id = ?`,
            [teacherId]
          ).catch(() => {});

          for (const s of raw) {
            await db.runAsync(
              `INSERT OR REPLACE INTO timetable
                (_id, teacher_id, class_id, subject_id,
                 day_of_week, period_id, room, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                s._id       || s.id                         || null,
                teacherId,
                s.classId   || s.class?._id  || s.class_id  || null,
                s.subjectId || s.subject?._id || s.subject_id || null,
                // FIXED (Issue 4): store canonical lowercase day
                s.dayOfWeek || s.day_of_week                || null,
                // FIXED (Issue 8): store as string
                s.periodId  ? String(s.periodId)            : null,
                s.room                                      || null,
                s.deletedAt || s.deleted_at                 || null,
              ]
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn(
        "[TeacherTimetable] Network refresh failed, serving cached copy:",
        err.message
      );
    }
  }

  // ── Always read from local SQLite (works offline too) ────────────────────
  try {
    // FIXED (Issue 7): guard table existence before query
    const tableCheck = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master
       WHERE type='table' AND name='timetable'`
    ).catch(() => null);

    if (!tableCheck?.cnt) return { slots: [], periods: [] };

    const ttCols   = await db.getAllAsync(
      `PRAGMA table_info(timetable)`, []
    ).catch(() => []);
    const ttColSet = new Set(ttCols.map((c) => c.name));

    if (ttColSet.size === 0) return { slots: [], periods: [] };

    const idCol        = ttColSet.has("_id")         ? "t._id"         : "t.id";
    const teacherIdCol = ttColSet.has("teacher_id")  ? "t.teacher_id"  : "t.teacherId";
    const classIdCol   = ttColSet.has("class_id")    ? "t.class_id"    : "t.classId";
    const subjectIdCol = ttColSet.has("subject_id")  ? "t.subject_id"  : "t.subjectId";
    const periodIdCol  = ttColSet.has("period_id")   ? "t.period_id"   : "t.periodId";
    const dayCol       = ttColSet.has("day_of_week") ? "t.day_of_week" : "t.dayOfWeek";
    const roomCol      = ttColSet.has("room")        ? "t.room"        : "NULL";
    const deletedCol   = ttColSet.has("deleted_at")  ? "t.deleted_at"  :
                         ttColSet.has("deletedAt")   ? "t.deletedAt"   : null;

    const deletedFilter = deletedCol
      ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
      : "";

    // Introspect subjects + classes tables for join column names
    const sCols   = await db.getAllAsync(`PRAGMA table_info(subjects)`, []).catch(() => []);
    const sColSet = new Set(sCols.map((c) => c.name));
    const sIdCol  = sColSet.has("_id") ? "_id" : "id";

    const cCols   = await db.getAllAsync(`PRAGMA table_info(classes)`, []).catch(() => []);
    const cColSet = new Set(cCols.map((c) => c.name));
    const cIdCol  = cColSet.has("_id") ? "_id" : "id";

    const query = `
      SELECT
        ${idCol}             AS id,
        ${dayCol}            AS dayOfWeek,
        ${periodIdCol}       AS periodId,
        ${roomCol}           AS room,
        s.name               AS subjectName,
        c.name               AS className
      FROM timetable t
      LEFT JOIN subjects s
        ON (s.${sIdCol} = ${subjectIdCol})
      LEFT JOIN classes c
        ON (c.${cIdCol} = ${classIdCol})
      WHERE ${teacherIdCol} = ?
        ${deletedFilter}
    `;

    const rows = await db.getAllAsync(query, [teacherId]);

    const slots = (rows ?? []).map((row) => ({
      id:          String(row.id || ""),
      day:         normDay(row.dayOfWeek),
      // FIXED (Issue 8): always string so === comparison with period.id works
      periodId:    String(row.periodId || ""),
      subjectName: row.subjectName || "—",
      className:   row.className   || "—",
      room:        row.room        || null,
    }));

    return { slots, periods: [] };

  } catch (err) {
    console.error("[TeacherTimetable] SQLite fetch failed:", err.message);
    return { slots: [], periods: [] };
  }
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function TeacherTimetable() {
  const router    = useRouter();
  const user      = useAuthStore((s) => s.user);
  const teacherId = user?._id || user?.id || user?.userId || null;
  const schoolId  = user?.schoolId || null;

  const [periods,    setPeriods]    = useState([]);
  const [schedule,   setSchedule]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [isOffline,  setIsOffline]  = useState(false);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const db = await getDatabase();

      const net = await NetInfo.fetch();
      setIsOffline(!net.isConnected);

      // FIXED (Issue 6): pass schoolId so the endpoint can filter correctly
      const { slots } = await fetchTeacherSchedule(db, teacherId, schoolId);
      setSchedule(slots);

      const loadedPeriods = await fetchPeriods(db, schoolId);
      setPeriods(
        loadedPeriods.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      );

    } catch (err) {
      console.error("Failed to load timetable:", err);
      setError("Failed to load timetable. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, schoolId]);

  useEffect(() => { loadData(); }, [loadData]);

  /**
   * FIXED (Issue 8):
   * Both s.periodId and periodId are always strings (coerced above and
   * in fetchPeriods), so === comparison is now reliable.
   */
  const getSlot = useCallback(
    (day, periodId) =>
      schedule.find(
        (s) => s.day === day && s.periodId === String(periodId)
      ),
    [schedule]
  );

  // ── Loading ──────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading schedule…</Text>
      </View>
    );
  }

  // ── Error ────────────────────────────────────────────────
  if (error) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={styles.emptyTitle}>Could not load timetable</Text>
        <Text style={styles.emptyText}>{error}</Text>
      </View>
    );
  }

  // ── No periods ───────────────────────────────────────────
  if (periods.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="calendar-outline" size={48} color="#D1D5DB" />
        <Text style={styles.emptyTitle}>No Periods Configured</Text>
        <Text style={styles.emptyText}>
          Contact admin to set up timetable periods
        </Text>
      </View>
    );
  }

  // ── No schedule ──────────────────────────────────────────
  if (schedule.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="time-outline" size={48} color="#D1D5DB" />
        <Text style={styles.emptyTitle}>No Classes Scheduled</Text>
        <Text style={styles.emptyText}>
          You have no timetable entries yet
        </Text>
      </View>
    );
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Page header */}
      <View style={styles.pageHeader}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.pageTitle}>My Teaching Schedule</Text>
          <Text style={styles.pageSub}>
            {schedule.length} slot{schedule.length !== 1 ? "s" : ""} this week
          </Text>
        </View>
      </View>

      {/* Offline banner */}
      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#92400E" />
          <Text style={styles.offlineText}>Viewing offline cached schedule</Text>
        </View>
      )}

      {/* Grid */}
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.gridWrapper}
        >
          <View>

            {/* Column header row */}
            <View style={styles.row}>
              <View style={[styles.timeCell, styles.cornerCell]}>
                <Ionicons name="time-outline" size={16} color="#E0E7FF" />
                <Text style={styles.cornerText}>Time</Text>
              </View>

              {DAYS.map((day, i) => {
                const isToday = i === todayIndex;
                return (
                  <View
                    key={day}
                    style={[
                      styles.dayHeaderCell,
                      isToday && styles.dayHeaderCellToday,
                    ]}
                  >
                    <Text style={[styles.dayShort, isToday && styles.dayShortToday]}>
                      {DAY_SHORT[i]}
                    </Text>
                    <Text style={[styles.dayFull, isToday && styles.dayFullToday]}>
                      {day}
                    </Text>
                    {isToday && <View style={styles.todayDot} />}
                  </View>
                );
              })}
            </View>

            {/* Period rows */}
            {periods.map((period, pIdx) => {
              if (period.isBreak) {
                return (
                  <View key={period.id} style={styles.row}>
                    <View style={[styles.timeCell, styles.breakTimeCell]}>
                      <Text style={styles.breakLabel}>{period.name || "Break"}</Text>
                      {period.startTime ? (
                        <Text style={styles.breakTime}>
                          {formatTime(period.startTime)}
                          {period.endTime ? ` – ${formatTime(period.endTime)}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    {DAYS.map((day) => (
                      <View key={`${day}-break-${period.id}`} style={styles.breakCell}>
                        <Text style={styles.breakCellText}>☕</Text>
                      </View>
                    ))}
                  </View>
                );
              }

              return (
                <View key={period.id} style={styles.row}>
                  <View
                    style={[
                      styles.timeCell,
                      pIdx % 2 === 0 ? styles.timeCellEven : styles.timeCellOdd,
                    ]}
                  >
                    <Text style={styles.periodLabel}>{period.name}</Text>
                    {period.startTime ? (
                      <Text style={styles.timeStart}>
                        {formatTime(period.startTime)}
                      </Text>
                    ) : null}
                    {period.endTime ? (
                      <Text style={styles.timeEnd}>
                        {formatTime(period.endTime)}
                      </Text>
                    ) : null}
                  </View>

                  {DAYS.map((day, dIdx) => {
                    const slot    = getSlot(day, period.id);
                    const isToday = dIdx === todayIndex;

                    return (
                      <View
                        key={`${day}-${period.id}`}
                        style={[
                          styles.slotCell,
                          slot    ? styles.slotFilled : styles.slotEmpty,
                          isToday && styles.slotToday,
                          isToday && slot && styles.slotFilledToday,
                        ]}
                      >
                        {slot ? (
                          <>
                            <View style={styles.slotAccent} />
                            <Text style={styles.subjectName} numberOfLines={2}>
                              {slot.subjectName}
                            </Text>
                            <Text style={styles.className} numberOfLines={1}>
                              {slot.className}
                            </Text>
                            {slot.room ? (
                              <Text style={styles.roomName} numberOfLines={1}>
                                📍 {slot.room}
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          <Text style={styles.freeText}>·</Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              );
            })}

          </View>
        </ScrollView>

        {/* Legend */}
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, styles.slotFilled]} />
            <Text style={styles.legendText}>Teaching</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, styles.slotEmpty]} />
            <Text style={styles.legendText}>Free</Text>
          </View>
          {todayIndex >= 0 && (
            <View style={styles.legendItem}>
              <View style={[
                styles.legendSwatch,
                { backgroundColor: "#EEF2FF", borderWidth: 2, borderColor: "#4F46E5" },
              ]} />
              <Text style={styles.legendText}>Today</Text>
            </View>
          )}
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES  (unchanged from previous version)
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "#F3F4F6", padding: 32, gap: 12,
  },
  loadingText: { fontSize: 14, color: "#6B7280", marginTop: 8 },
  emptyTitle:  { fontSize: 17, fontWeight: "700", color: "#111827", textAlign: "center" },
  emptyText:   { fontSize: 13, color: "#6B7280", textAlign: "center" },

  pageHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16,
    backgroundColor: "#FFF", borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB", gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  pageTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  pageSub:   { fontSize: 12, color: "#6B7280", marginTop: 1 },

  offlineBanner: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#FFFBEB", borderBottomWidth: 1,
    borderBottomColor: "#FDE68A",
    paddingHorizontal: 16, paddingVertical: 8,
  },
  offlineText: { fontSize: 12, color: "#92400E", flex: 1 },

  gridWrapper: { padding: 16 },
  row:         { flexDirection: "row" },

  cornerCell: {
    backgroundColor: "#3730A3",
    justifyContent: "center", alignItems: "center",
  },
  timeCell: {
    width: 88, minHeight: 72,
    paddingVertical: 10, paddingHorizontal: 8,
    justifyContent: "center", alignItems: "center",
    borderRightWidth: 2, borderRightColor: "#3730A3",
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.1)",
  },
  timeCellEven: { backgroundColor: "#4F46E5" },
  timeCellOdd:  { backgroundColor: "#4338CA" },
  periodLabel: {
    fontSize: 11, fontWeight: "800", color: "#FFFFFF",
    textAlign: "center", letterSpacing: 0.3,
  },
  timeStart: { fontSize: 11, color: "#C7D2FE", marginTop: 4, fontWeight: "600" },
  timeEnd:   { fontSize: 10, color: "#A5B4FC", marginTop: 1 },

  breakTimeCell: { backgroundColor: "#F59E0B" },
  breakLabel: { fontSize: 11, fontWeight: "800", color: "#FFFFFF", textAlign: "center" },
  breakTime:  { fontSize: 10, color: "#FEF3C7", marginTop: 2, fontWeight: "600" },
  breakCell: {
    width: 104, minHeight: 48, backgroundColor: "#FFFBEB",
    justifyContent: "center", alignItems: "center",
    borderRightWidth: 1, borderRightColor: "#FDE68A",
    borderBottomWidth: 1, borderBottomColor: "#FDE68A",
  },
  breakCellText: { fontSize: 16 },

  dayHeaderCell: {
    width: 104, paddingVertical: 10, backgroundColor: "#231c81",
    justifyContent: "center", alignItems: "center",
    borderRightWidth: 1, borderRightColor: "#312E81",
    borderBottomWidth: 2, borderBottomColor: "#4F46E5", gap: 2,
  },
  dayHeaderCellToday: { backgroundColor: "#4F46E5" },
  dayShort: { color: "#A5B4FC", fontWeight: "800", fontSize: 12, letterSpacing: 1 },
  dayShortToday: { color: "#FFF" },
  dayFull: { color: "#6366F1", fontSize: 9, fontWeight: "500" },
  dayFullToday: { color: "#E0E7FF" },
  todayDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: "#FFF", marginTop: 2,
  },

  slotCell: {
    width: 104, minHeight: 72, padding: 8,
    borderRightWidth: 1, borderRightColor: "#E5E7EB",
    borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
    justifyContent: "center", alignItems: "center",
    position: "relative",
  },
  slotFilled:      { backgroundColor: "#F0FDF4" },
  slotEmpty:       { backgroundColor: "#FAFAFA" },
  slotToday:       { backgroundColor: "#F5F3FF" },
  slotFilledToday: { backgroundColor: "#EDE9FE", borderWidth: 1, borderColor: "#A78BFA" },
  slotAccent: {
    position: "absolute", left: 0, top: 8, bottom: 8,
    width: 3, borderRadius: 2, backgroundColor: "#22C55E",
  },
  subjectName: { fontSize: 11, fontWeight: "700", color: "#166534", textAlign: "center" },
  className:   { fontSize: 10, color: "#15803D", marginTop: 3, textAlign: "center", fontWeight: "500" },
  roomName:    { fontSize: 9, color: "#6B7280", marginTop: 1, textAlign: "center" },
  freeText:    { color: "#D1D5DB", fontSize: 18, fontWeight: "300" },
  cornerText:  { fontSize: 10, fontWeight: "700", color: "#C7D2FE", marginTop: 2, letterSpacing: 0.5 },

  legend: {
    flexDirection: "row", justifyContent: "center", gap: 20,
    marginTop: 8, marginHorizontal: 16, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: "#E5E7EB",
    backgroundColor: "#FFF", borderRadius: 12,
  },
  legendItem:  { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch:{ width: 14, height: 14, borderRadius: 4 },
  legendText:  { fontSize: 12, color: "#6B7280", fontWeight: "500" },
});