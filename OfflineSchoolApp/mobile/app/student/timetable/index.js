// app/student/timetable/index.js - FIXED: Grid layout matching teacher design

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { useTranslation } from "../../../src/i18n/useTranslation";

import { getDatabase } from "../../../src/db/database";
import { resolveStudentClassId } from "../../../src/services/student.service";
import { syncTimetableFromServer } from "../../../src/services/timetableService";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const DAYS      = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI"];

const DAY_KEY_MAP = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
  mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

const todayIndex = (() => {
  const d = new Date().getDay();
  return d >= 1 && d <= 5 ? d - 1 : -1;
})();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// DB LOADER — keeps student's SQLite logic intact
// ─────────────────────────────────────────────────────────────

const loadFullTimetable = async (db, classId) => {
  if (!classId) return { slots: [], periods: [] };

  try {
    const tableCheck = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='timetable'`
    ).catch(() => null);

    if (!tableCheck?.cnt) return { slots: [], periods: [] };

    // Introspect timetable columns
    const ttCols   = await db.getAllAsync(`PRAGMA table_info(timetable)`, []).catch(() => []);
    const ttColSet = new Set(ttCols.map((c) => c.name));

    const idCol        = ttColSet.has("_id")         ? "t._id"         :
                         ttColSet.has("id")          ? "t.id"          : "t.rowid";
    const classIdCol   = ttColSet.has("class_id")    ? "t.class_id"    :
                         ttColSet.has("classId")     ? "t.classId"     : null;
    const subjectIdCol = ttColSet.has("subject_id")  ? "t.subject_id"  :
                         ttColSet.has("subjectId")   ? "t.subjectId"   : null;
    const teacherIdCol = ttColSet.has("teacher_id")  ? "t.teacher_id"  :
                         ttColSet.has("teacherId")   ? "t.teacherId"   : null;
    const periodIdCol  = ttColSet.has("period_id")   ? "t.period_id"   :
                         ttColSet.has("periodId")    ? "t.periodId"    : null;
    const dayCol       = ttColSet.has("day_of_week") ? "t.day_of_week" :
                         ttColSet.has("dayOfWeek")   ? "t.dayOfWeek"   :
                         ttColSet.has("day")         ? "t.day"         : null;
    const roomCol      = ttColSet.has("room")        ? "t.room"        :
                         ttColSet.has("location")    ? "t.location"    : null;
    const deletedColName = ttColSet.has("deleted_at") ? "t.deleted_at" :
                           ttColSet.has("deletedAt")  ? "t.deletedAt"  : null;

    if (!classIdCol || !dayCol) return { slots: [], periods: [] };

    const deletedFilter = deletedColName
      ? `AND (${deletedColName} IS NULL OR ${deletedColName} = '')`
      : "";

    // Introspect subjects
    const sCols   = await db.getAllAsync(`PRAGMA table_info(subjects)`, []).catch(() => []);
    const sColSet = new Set(sCols.map((c) => c.name));
    const sIdCol  = sColSet.has("_id") ? "_id" : "id";

    // Introspect users
    const uCols   = await db.getAllAsync(`PRAGMA table_info(users)`, []).catch(() => []);
    const uColSet = new Set(uCols.map((c) => c.name));
    const uIdCol  = uColSet.has("_id") ? "_id" : "id";

    // Introspect periods
    const pCols   = await db.getAllAsync(`PRAGMA table_info(periods)`, []).catch(() => []);
    const pColSet = new Set(pCols.map((c) => c.name));

    const pIdCol  = pColSet.has("_id")        ? "_id"        : "id";
    const pStart  = pColSet.has("starttime")  ? "p.starttime"  :
                    pColSet.has("start_time")  ? "p.start_time" :
                    pColSet.has("startTime")   ? "p.startTime"  : "NULL";
    const pEnd    = pColSet.has("endtime")     ? "p.endtime"    :
                    pColSet.has("end_time")    ? "p.end_time"   :
                    pColSet.has("endTime")     ? "p.endTime"    : "NULL";
    const pBreak  = pColSet.has("isbreak")     ? "p.isbreak"    :
                    pColSet.has("is_break")    ? "p.is_break"   :
                    pColSet.has("isBreak")     ? "p.isBreak"    : "0";
    const pSort   = pColSet.has("sortorder")   ? "p.sortorder"  :
                    pColSet.has("sort_order")  ? "p.sort_order" :
                    pColSet.has("sortOrder")   ? "p.sortOrder"  : "0";
    const pName   = pColSet.has("name")        ? "p.name"       : "NULL";

    // Build query
    let selectClause = `
      SELECT
        ${idCol}             AS id,
        ${dayCol}            AS dayOfWeek,
        ${roomCol || "NULL"} AS room`;

    let fromClause = ` FROM timetable t`;

    if (subjectIdCol) {
      selectClause += `, s.name AS subjectName, s.code AS subjectCode`;
      fromClause   += ` LEFT JOIN subjects s ON (s.${sIdCol} = ${subjectIdCol})`;
    } else {
      selectClause += `, NULL AS subjectName, NULL AS subjectCode`;
    }

    if (teacherIdCol) {
      selectClause += `, u.name AS teacherName`;
      fromClause   += ` LEFT JOIN users u ON (u.${uIdCol} = ${teacherIdCol})`;
    } else {
      selectClause += `, NULL AS teacherName`;
    }

    if (periodIdCol && pColSet.size > 0) {
      selectClause +=
        `, ${pName}  AS periodName` +
        `, ${pStart} AS startTime` +
        `, ${pEnd}   AS endTime` +
        `, ${pBreak} AS isbreak` +
        `, ${pSort}  AS sortorder` +
        `, ${periodIdCol} AS periodId`;
      fromClause += ` LEFT JOIN periods p ON (p.${pIdCol} = ${periodIdCol})`;
    } else {
      selectClause += `, NULL AS periodName, NULL AS startTime, NULL AS endTime, 0 AS isbreak, 0 AS sortorder, NULL AS periodId`;
    }

    const rows = await db.getAllAsync(
      `${selectClause}
       ${fromClause}
       WHERE ${classIdCol} = ?
         ${deletedFilter}
       ORDER BY
         CASE LOWER(${dayCol})
           WHEN 'monday' THEN 1    WHEN 'mon' THEN 1
           WHEN 'tuesday' THEN 2   WHEN 'tue' THEN 2
           WHEN 'wednesday' THEN 3 WHEN 'wed' THEN 3
           WHEN 'thursday' THEN 4  WHEN 'thu' THEN 4
           WHEN 'friday' THEN 5    WHEN 'fri' THEN 5
           WHEN 'saturday' THEN 6  WHEN 'sat' THEN 6
           WHEN 'sunday' THEN 7    WHEN 'sun' THEN 7
           ELSE 8
         END,
         COALESCE(${pSort}, 0) ASC`,
      [classId]
    );

    // Build slots with normalised day names
    const slots = (rows ?? []).map((row) => ({
      id:          row.id,
      day:         normDay(row.dayOfWeek),
      periodId:    String(row.periodId || ""),
      subjectName: row.subjectName || "—",
      teacherName: row.teacherName || null,
      room:        row.room        || null,
      startTime:   row.startTime   || null,
      endTime:     row.endTime     || null,
      periodName:  row.periodName  || null,
      sortOrder:   row.sortorder   ?? 0,
      isBreak:     row.isbreak === 1 || row.isbreak === "1" || row.isbreak === true,
    }));

    // Extract unique periods from slots
    const periodMap = new Map();
    for (const s of slots) {
      if (s.periodId && !periodMap.has(s.periodId)) {
        periodMap.set(s.periodId, {
          id:        s.periodId,
          name:      s.periodName || `Period ${periodMap.size + 1}`,
          startTime: s.startTime,
          endTime:   s.endTime,
          sortOrder: s.sortOrder,
          isBreak:   s.isBreak,
        });
      }
    }

    // Fallback: load periods directly from periods table
    if (periodMap.size === 0 && pColSet.size > 0) {
      try {
        const pRows = await db.getAllAsync(
          // `periods p` — the alias is load-bearing. Every interpolated column
          // above is written `p.<col>`, so without it SQLite reports
          // "no such column: p.name", which reads like a schema problem and is
          // in fact a missing two-character alias. The introspection was always
          // correct; the FROM clause simply never declared what `p` referred to.
          `SELECT p.${pIdCol} AS id, ${pName} AS name,
                  ${pStart} AS startTime, ${pEnd} AS endTime,
                  ${pBreak} AS isBreak, ${pSort} AS sortOrder
           FROM periods p
           ORDER BY COALESCE(${pSort}, 0) ASC`
        );
        for (const p of pRows ?? []) {
          periodMap.set(String(p.id), {
            id:        String(p.id),
            name:      p.name || `Period ${periodMap.size + 1}`,
            startTime: p.startTime || null,
            endTime:   p.endTime   || null,
            sortOrder: p.sortOrder || 0,
            isBreak:   p.isBreak === 1 || p.isBreak === "1" || p.isBreak === true,
          });
        }
      } catch (err) {
        console.warn("[loadFullTimetable] periods fallback failed:", err.message);
      }
    }

    const periods = [...periodMap.values()].sort(
      (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
    );

    console.log(`[loadFullTimetable] ${slots.length} slots, ${periods.length} periods`);

    return { slots, periods };
  } catch (err) {
    console.warn("[loadFullTimetable] failed:", err.message);
    return { slots: [], periods: [] };
  }
};

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function StudentTimetableScreen() {
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const userId   = user?._id || user?.id || user?.userId;
  const schoolId = user?.schoolId;
  const { t }    = useTranslation();

  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [classId,    setClassId]    = useState(null);
  const [className,  setClassName]  = useState(null);
  const [schedule,   setSchedule]   = useState([]);
  const [periods,    setPeriods]    = useState([]);
  const [syncError,  setSyncError]  = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!userId) { setLoading(false); return; }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setSyncError(null);

      const db = await getDatabase();

      // Resolve class
      const cid = await resolveStudentClassId(userId);
      console.log("[Timetable] userId:", userId, "classId:", cid);
      setClassId(cid);

      // Class name
      if (cid) {
        const row = await db.getFirstAsync(
          `SELECT name FROM classes WHERE id = ? OR _id = ? LIMIT 1`,
          [cid, cid]
        ).catch(() => null);
        setClassName(row?.name || null);
      }

      // Sync from server
      if (cid) {
        try {
          const synced = await syncTimetableFromServer(cid);
          console.log("[Timetable] synced:", synced);
        } catch (err) {
          console.warn("[Timetable] sync failed:", err.message);
          setSyncError(t("timetable.syncError"));
        }
      }

      // Load from local SQLite
      const { slots, periods: loadedPeriods } = await loadFullTimetable(db, cid);
      setSchedule(slots);
      setPeriods(loadedPeriods);

    } catch (err) {
      console.warn("[StudentTimetable] load error:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, t]);

  useEffect(() => { load(); }, [load]);

  const getSlot = useCallback(
    (day, periodId) =>
      schedule.find((s) => s.day === day && s.periodId === periodId),
    [schedule]
  );

  const lessonCount = schedule.filter((s) => !s.isBreak).length;

  // ── Loading ───────────────────────────────────────────────
  if (loading) {
    return (
      <View style={st.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={st.loadingText}>{t("timetable.loading")}</Text>
      </View>
    );
  }

  // ── No class assigned ─────────────────────────────────────
  if (!classId) {
    return (
      <View style={st.centered}>
        <Ionicons name="calendar-outline" size={52} color="#D1D5DB" />
        <Text style={st.emptyTitle}>{t("timetable.noClassTitle")}</Text>
        <Text style={st.emptyText}>
          {t("timetable.noClassBody")}
        </Text>
      </View>
    );
  }

  // ── No periods ────────────────────────────────────────────
  if (periods.length === 0) {
    return (
      <View style={st.centered}>
        <Ionicons name="calendar-outline" size={48} color="#D1D5DB" />
        <Text style={st.emptyTitle}>{t("timetable.noPeriodsTitle")}</Text>
        <Text style={st.emptyText}>
          {t("timetable.noPeriodsBody")}
        </Text>
      </View>
    );
  }

  // ── No schedule ───────────────────────────────────────────
  if (schedule.length === 0) {
    return (
      <View style={st.centered}>
        <Ionicons name="time-outline" size={48} color="#D1D5DB" />
        <Text style={st.emptyTitle}>{t("timetable.noScheduleTitle")}</Text>
        <Text style={st.emptyText}>
          {t("timetable.noScheduleBody")}
        </Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <View style={st.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      {/* Header */}
      <View style={st.pageHeader}>
        <TouchableOpacity
          style={st.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={st.pageTitle}>{t("timetable.myTimetable")}</Text>
          {className ? (
            <Text style={st.pageSub}>
              {className} · {lessonCount === 1
                ? t("timetable.oneClassThisWeek")
                : t("timetable.manyClassesThisWeek", { count: lessonCount })}
            </Text>
          ) : (
            <Text style={st.pageSub}>
              {lessonCount === 1
                ? t("timetable.oneClassThisWeek")
                : t("timetable.manyClassesThisWeek", { count: lessonCount })}
            </Text>
          )}
        </View>
      </View>

      {/* Sync error banner */}
      {syncError ? (
        <View style={st.syncErrorBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color="#92400E" />
          <Text style={st.syncErrorText}>{syncError}</Text>
        </View>
      ) : null}

      {/* Grid */}
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={st.gridWrapper}
        >
          <View>
            {/* Column header row */}
            <View style={st.row}>
              {/* Corner cell */}
              <View style={[st.timeCell, st.cornerCell]}>
                <Ionicons name="time-outline" size={16} color="#E0E7FF" />
                <Text style={st.cornerText}>{t("timetable.timeCol")}</Text>
              </View>

              {/* Day headers */}
              {DAYS.map((day, i) => {
                const isToday = i === todayIndex;
                return (
                  <View
                    key={day}
                    style={[
                      st.dayHeaderCell,
                      isToday && st.dayHeaderCellToday,
                    ]}
                  >
                    <Text
                      style={[
                        st.dayShort,
                        isToday && st.dayShortToday,
                      ]}
                    >
                      {t(`timetable.${DAY_SHORT[i].toLowerCase()}`)}
                    </Text>
                    <Text
                      style={[
                        st.dayFull,
                        isToday && st.dayFullToday,
                      ]}
                    >
                      {t(`timetable.${day.toLowerCase()}`)}
                    </Text>
                    {isToday && <View style={st.todayDot} />}
                  </View>
                );
              })}
            </View>

            {/* Period rows */}
            {periods.map((period, pIdx) => {
              // Break row
              if (period.isBreak) {
                return (
                  <View key={period.id} style={st.row}>
                    <View style={[st.timeCell, st.breakTimeCell]}>
                      <Text style={st.breakLabel}>{period.name || t("timetable.break")}</Text>
                      {period.startTime ? (
                        <Text style={st.breakTime}>
                          {formatTime(period.startTime)}
                          {period.endTime ? ` – ${formatTime(period.endTime)}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    {DAYS.map((day) => (
                      <View key={`${day}-break-${period.id}`} style={st.breakCell}>
                        <Text style={st.breakCellText}>☕</Text>
                      </View>
                    ))}
                  </View>
                );
              }

              // Normal period row
              return (
                <View key={period.id} style={st.row}>
                  {/* Time column */}
                  <View
                    style={[
                      st.timeCell,
                      pIdx % 2 === 0 ? st.timeCellEven : st.timeCellOdd,
                    ]}
                  >
                    <Text style={st.periodLabel}>{period.name}</Text>
                    {period.startTime ? (
                      <Text style={st.timeStart}>
                        {formatTime(period.startTime)}
                      </Text>
                    ) : null}
                    {period.endTime ? (
                      <Text style={st.timeEnd}>
                        {formatTime(period.endTime)}
                      </Text>
                    ) : null}
                  </View>

                  {/* Day slot cells */}
                  {DAYS.map((day, dIdx) => {
                    const slot    = getSlot(day, period.id);
                    const isToday = dIdx === todayIndex;

                    return (
                      <View
                        key={`${day}-${period.id}`}
                        style={[
                          st.slotCell,
                          slot    ? st.slotFilled : st.slotEmpty,
                          isToday && st.slotToday,
                          isToday && slot && st.slotFilledToday,
                        ]}
                      >
                        {slot ? (
                          <>
                            <View style={st.slotAccent} />
                            <Text style={st.subjectName} numberOfLines={2}>
                              {slot.subjectName}
                            </Text>
                            {slot.teacherName ? (
                              <Text style={st.teacherName} numberOfLines={1}>
                                {slot.teacherName}
                              </Text>
                            ) : null}
                            {slot.room ? (
                              <Text style={st.roomName} numberOfLines={1}>
                                📍 {slot.room}
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          <Text style={st.freeText}>·</Text>
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
        <View style={st.legend}>
          <View style={st.legendItem}>
            <View style={[st.legendSwatch, st.slotFilled]} />
            <Text style={st.legendText}>{t("timetable.classLegend")}</Text>
          </View>
          <View style={st.legendItem}>
            <View style={[st.legendSwatch, st.slotEmpty]} />
            <Text style={st.legendText}>{t("timetable.freeLegend")}</Text>
          </View>
          {todayIndex >= 0 && (
            <View style={st.legendItem}>
              <View
                style={[
                  st.legendSwatch,
                  { backgroundColor: "#EEF2FF", borderWidth: 2, borderColor: "#4F46E5" },
                ]}
              />
              <Text style={st.legendText}>{t("timetable.todayLegend")}</Text>
            </View>
          )}
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F3F4F6",
    padding:         32,
    gap:             12,
  },
  loadingText: { fontSize: 14, color: "#6B7280", marginTop: 8 },
  emptyTitle:  { fontSize: 17, fontWeight: "700", color: "#111827", textAlign: "center" },
  emptyText:   { fontSize: 13, color: "#6B7280", textAlign: "center" },

  // ── Page header ───────────────────────────────────────────
  pageHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
    gap:               12,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  pageTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  pageSub:   { fontSize: 12, color: "#6B7280", marginTop: 1 },

  // ── Sync error ────────────────────────────────────────────
  syncErrorBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#FFFBEB",
    borderBottomWidth: 1,
    borderBottomColor: "#FDE68A",
    paddingHorizontal: 16,
    paddingVertical:   8,
  },
  syncErrorText: { fontSize: 12, color: "#92400E", flex: 1 },

  // ── Grid ──────────────────────────────────────────────────
  gridWrapper: { padding: 16 },
  row:         { flexDirection: "row" },

  // ── Corner cell ───────────────────────────────────────────
  cornerCell: {
    backgroundColor: "#3730A3",
    justifyContent:  "center",
    alignItems:      "center",
  },
  cornerText: {
    fontSize:      10,
    fontWeight:    "700",
    color:         "#C7D2FE",
    marginTop:     2,
    letterSpacing: 0.5,
  },

  // ── Time column ───────────────────────────────────────────
  timeCell: {
    width:             88,
    minHeight:         72,
    paddingVertical:   10,
    paddingHorizontal: 8,
    justifyContent:    "center",
    alignItems:        "center",
    borderRightWidth:  2,
    borderRightColor:  "#3730A3",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  timeCellEven: { backgroundColor: "#4F46E5" },
  timeCellOdd:  { backgroundColor: "#4338CA" },

  periodLabel: {
    fontSize:      11,
    fontWeight:    "800",
    color:         "#FFFFFF",
    textAlign:     "center",
    letterSpacing: 0.3,
  },
  timeStart: {
    fontSize:   11,
    color:      "#C7D2FE",
    marginTop:  4,
    fontWeight: "600",
  },
  timeEnd: {
    fontSize:  10,
    color:     "#A5B4FC",
    marginTop: 1,
  },

  // ── Break row ─────────────────────────────────────────────
  breakTimeCell: {
    backgroundColor: "#F59E0B",
  },
  breakLabel: {
    fontSize:   11,
    fontWeight: "800",
    color:      "#FFFFFF",
    textAlign:  "center",
  },
  breakTime: {
    fontSize:   10,
    color:      "#FEF3C7",
    marginTop:  2,
    fontWeight: "600",
  },
  breakCell: {
    width:             104,
    minHeight:         48,
    backgroundColor:   "#FFFBEB",
    justifyContent:    "center",
    alignItems:        "center",
    borderRightWidth:  1,
    borderRightColor:  "#FDE68A",
    borderBottomWidth: 1,
    borderBottomColor: "#FDE68A",
  },
  breakCellText: { fontSize: 16 },

  // ── Day header row ────────────────────────────────────────
  dayHeaderCell: {
    width:             104,
    paddingVertical:   10,
    backgroundColor:   "#231c81",
    justifyContent:    "center",
    alignItems:        "center",
    borderRightWidth:  1,
    borderRightColor:  "#312E81",
    borderBottomWidth: 2,
    borderBottomColor: "#4F46E5",
    gap:               2,
  },
  dayHeaderCellToday: { backgroundColor: "#4F46E5" },
  dayShort: {
    color:         "#A5B4FC",
    fontWeight:    "800",
    fontSize:      12,
    letterSpacing: 1,
  },
  dayShortToday: { color: "#FFF" },
  dayFull: {
    color:      "#6366F1",
    fontSize:   9,
    fontWeight: "500",
  },
  dayFullToday: { color: "#E0E7FF" },
  todayDot: {
    width:           5,
    height:          5,
    borderRadius:    3,
    backgroundColor: "#FFF",
    marginTop:       2,
  },

  // ── Slot cells ────────────────────────────────────────────
  slotCell: {
    width:             104,
    minHeight:         72,
    padding:           8,
    borderRightWidth:  1,
    borderRightColor:  "#E5E7EB",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
    justifyContent:    "center",
    alignItems:        "center",
    position:          "relative",
  },
  slotFilled:      { backgroundColor: "#F0FDF4" },
  slotEmpty:       { backgroundColor: "#FAFAFA" },
  slotToday:       { backgroundColor: "#F5F3FF" },
  slotFilledToday: {
    backgroundColor: "#EDE9FE",
    borderWidth:     1,
    borderColor:     "#A78BFA",
  },
  slotAccent: {
    position:        "absolute",
    left:            0,
    top:             8,
    bottom:          8,
    width:           3,
    borderRadius:    2,
    backgroundColor: "#22C55E",
  },
  subjectName: {
    fontSize:   11,
    fontWeight: "700",
    color:      "#166534",
    textAlign:  "center",
  },
  teacherName: {
    fontSize:   9,
    color:      "#15803D",
    marginTop:  2,
    textAlign:  "center",
    fontWeight: "500",
  },
  roomName: {
    fontSize:  9,
    color:     "#6B7280",
    marginTop: 1,
    textAlign: "center",
  },
  freeText: {
    color:      "#D1D5DB",
    fontSize:   18,
    fontWeight: "300",
  },

  // ── Legend ────────────────────────────────────────────────
  legend: {
    flexDirection:    "row",
    justifyContent:   "center",
    gap:              20,
    marginTop:        8,
    marginHorizontal: 16,
    paddingVertical:  14,
    borderTopWidth:   1,
    borderTopColor:   "#E5E7EB",
    backgroundColor:  "#FFF",
    borderRadius:     12,
  },
  legendItem: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
  },
  legendSwatch: {
    width:        14,
    height:       14,
    borderRadius: 4,
  },
  legendText: {
    fontSize:   12,
    color:      "#6B7280",
    fontWeight: "500",
  },
});