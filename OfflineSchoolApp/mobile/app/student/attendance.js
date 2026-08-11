// app/student/attendance.js
"use strict";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../src/store/auth.store";
import { getDatabase } from "../../src/db/database";
import api from "../../src/services/api";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { key: "daily",   label: "Daily"   },
  { key: "weekly",  label: "Weekly"  },
  { key: "monthly", label: "Monthly" },
  { key: "overall", label: "Overall" },
];

const STATUS_META = {
  present: { label: "Present", color: "#059669", bg: "#ECFDF5", icon: "checkmark-circle"  },
  absent:  { label: "Absent",  color: "#DC2626", bg: "#FEE2E2", icon: "close-circle"      },
  late:    { label: "Late",    color: "#D97706", bg: "#FEF3C7", icon: "time"               },
  excused: { label: "Excused", color: "#7C3AED", bg: "#EDE9FE", icon: "information-circle" },
};

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
  } catch { return dateStr; }
};

const formatDateShort = (dateStr) => {
  if (!dateStr) return "";
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
      month: "short", day: "numeric",
    });
  } catch { return dateStr; }
};

const getWeekRange = (offsetWeeks = 0) => {
  const now    = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1 + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end:   sunday.toISOString().slice(0, 10),
    label: `${formatDateShort(monday.toISOString().slice(0,10))} – ${formatDateShort(sunday.toISOString().slice(0,10))}`,
  };
};

const getMonthRange = (offsetMonths = 0) => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
  const end   = new Date(now.getFullYear(), now.getMonth() + offsetMonths + 1, 0);
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
    label: `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`,
    month: start.getMonth(),
    year:  start.getFullYear(),
  };
};

const buildSummary = (records) => {
  const s = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
  for (const r of records) {
    const st = (r.status || "").toLowerCase();
    if (st in s) s[st]++;
    s.total++;
  }
  s.rate = s.total > 0 ? Math.round(((s.present + s.late) / s.total) * 100) : 0;
  return s;
};

const getRateColor = (rate) =>
  rate >= 90 ? "#059669" : rate >= 75 ? "#D97706" : "#DC2626";

const normalizeRecord = (r) => ({
  ...r,
  id:        r._id || r.id || null,
  studentId: r.studentId || r.student_id || null,
  date: (
    r.date ||
    r.attendance_date ||
    r.attendanceDate  ||
    r.createdAt?.slice(0, 10) ||
    r.created_at?.slice(0, 10) ||
    ""
  ),
  status: (r.status || r.attendance_status || "absent").toLowerCase(),
});

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE ALL IDs THIS STUDENT MIGHT APPEAR UNDER IN ATTENDANCE RECORDS
// ─────────────────────────────────────────────────────────────────────────────

const resolveAllStudentIds = async (userId) => {
  const ids = new Set();
  if (!userId) return ids;

  ids.add(String(userId).toLowerCase());

  try {
    const db = await getDatabase();

    const tables = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type='table'`)
      .catch(() => []);
    const tableSet = new Set(tables.map((t) => t.name));

    const studentTable = ["students", "student"].find((t) => tableSet.has(t));
    if (!studentTable) return ids;

    const cols   = await db.getAllAsync(`PRAGMA table_info(${studentTable})`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const userCol =
      colSet.has("user_id") ? "user_id" :
      colSet.has("userId")  ? "userId"  :
      colSet.has("auth_id") ? "auth_id" : null;

    if (!userCol) return ids;

    const rows = await db
      .getAllAsync(
        `SELECT * FROM ${studentTable} WHERE ${userCol} = ? OR ${userCol} = ?`,
        [userId, String(userId)]
      )
      .catch(() => []);

    for (const row of rows) {
      // Collect every ID field — attendance may store any of these
      ["id", "_id", "studentId", "student_id"].forEach((pk) => {
        if (row[pk]) ids.add(String(row[pk]).toLowerCase());
      });
    }

    console.log("[attendance] resolved studentIds:", [...ids]);
  } catch (err) {
    console.warn("[attendance] resolveAllStudentIds error:", err.message);
  }

  return ids;
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADER
// Strategy:
//   1. Ask API for all school attendance (backend ignores studentId param)
//   2. Filter client-side using ALL known IDs for this student
//   3. Cache matched records to SQLite for offline use
//   4. On failure fall back to SQLite
// ─────────────────────────────────────────────────────────────────────────────

const cacheRecords = async (records) => {
  if (!records.length) return;
  try {
    const db = await getDatabase();

    // Ensure table exists with minimum required columns
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS attendance (
        id         TEXT PRIMARY KEY,
        student_id TEXT,
        studentId  TEXT,
        class_id   TEXT,
        classId    TEXT,
        schoolId   TEXT,
        date       TEXT,
        status     TEXT,
        note       TEXT,
        _synced    INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT
      )
    `).catch(() => {});

    const now = new Date().toISOString();

    for (const r of records) {
      const id        = r._id || r.id;
      const studentId = r.studentId || r.student_id;
      const classId   = r.classId   || r.class_id;
      if (!id || !studentId) continue;

      await db.runAsync(
        `INSERT OR REPLACE INTO attendance
           (id, student_id, studentId, class_id, classId, schoolId,
            date, status, note, _synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        [
          id, studentId, studentId,
          classId || null, classId || null,
          r.schoolId || null,
          r.date, r.status, r.note || null,
          r.createdAt || r.created_at || now, now,
        ]
      ).catch(() => {});
    }
    console.log(`[attendance] cached ${records.length} record(s) to SQLite`);
  } catch (err) {
    console.warn("[attendance] cache error:", err.message);
  }
};

const loadFromSQLite = async (studentIds, startDate, endDate) => {
  try {
    const db = await getDatabase();

    const tables = await db
      .getAllAsync(`SELECT name FROM sqlite_master WHERE type='table'`)
      .catch(() => []);
    const tableSet = new Set(tables.map((t) => t.name));

    const tableName = ["attendance", "attendances", "student_attendance"]
      .find((t) => tableSet.has(t));
    if (!tableName) return [];

    const cols   = await db.getAllAsync(`PRAGMA table_info(${tableName})`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));

    const studentCol =
      colSet.has("student_id") ? "student_id" :
      colSet.has("studentId")  ? "studentId"  : null;

    const dateCol =
      colSet.has("date")       ? "date"       :
      colSet.has("created_at") ? "created_at" : "rowid";

    if (!studentCol) return [];

    const idList       = [...studentIds];
    const placeholders = idList.map(() => "?").join(", ");

    let q    = `SELECT * FROM ${tableName} WHERE ${studentCol} IN (${placeholders})`;
    const args = [...idList];

    if (startDate) { q += ` AND ${dateCol} >= ?`; args.push(startDate); }
    if (endDate)   { q += ` AND ${dateCol} <= ?`; args.push(endDate);   }
    q += ` ORDER BY ${dateCol} DESC`;

    const rows = await db.getAllAsync(q, args).catch(() => []);
    console.log(`[attendance] SQLite → ${rows.length} record(s)`);
    return rows;
  } catch (err) {
    console.warn("[attendance] SQLite load error:", err.message);
    return [];
  }
};

const loadAttendanceRecords = async ({ userId, schoolId, startDate, endDate }) => {
  // Step 1 — collect every ID this student might appear under
  const studentIds = await resolveAllStudentIds(userId);

  const belongsToMe = (record) => {
    const candidates = [
      record.studentId, record.student_id,
      record.userId,    record.user_id,
    ].filter(Boolean).map((v) => String(v).toLowerCase());
    return candidates.some((c) => studentIds.has(c));
  };

  // Step 2 — try API
  try {
    const params = { schoolId };
    if (startDate) params.startDate = startDate;
    if (endDate)   params.endDate   = endDate;

    const res  = await api.get("/attendance/students", { params });
    const data = res.data;

    let raw =
      data?.records    ||
      data?.data       ||
      data?.attendance ||
      (Array.isArray(data) ? data : []);

    if (!Array.isArray(raw)) raw = [];

    const normalized = raw.map(normalizeRecord);
    const mine       = normalized.filter(belongsToMe);

    console.log(
      `[attendance] API total=${normalized.length} mine=${mine.length}`,
      `ids=[${[...studentIds].join(", ")}]`
    );

    // Debug: show which studentIds the API returned
    const apiIds = [...new Set(normalized.map((r) => r.studentId).filter(Boolean))];
    console.log("[attendance] API record studentIds:", apiIds);

    // Step 3 — cache matched records for offline use
    if (mine.length > 0) {
      await cacheRecords(mine);
    }

    return { records: mine, source: mine.length > 0 ? "api" : "api-empty" };
  } catch (err) {
    console.warn("[attendance] API failed:", err.message);
  }

  // Step 4 — SQLite fallback
  const rows = await loadFromSQLite(studentIds, startDate, endDate);
  const mine = rows.map(normalizeRecord).filter(belongsToMe);
  return { records: mine, source: mine.length > 0 ? "sqlite" : "none" };
};

// ─────────────────────────────────────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const StatCard = ({ status, count, total }) => {
  const meta = STATUS_META[status] || STATUS_META.present;
  const pct  = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <View style={[sc.card, { backgroundColor: meta.bg }]}>
      <Ionicons name={meta.icon} size={22} color={meta.color} />
      <Text style={[sc.count, { color: meta.color }]}>{count}</Text>
      <Text style={[sc.label, { color: meta.color }]}>{meta.label}</Text>
      <Text style={[sc.pct,   { color: meta.color }]}>{pct}%</Text>
    </View>
  );
};
const sc = StyleSheet.create({
  card:  { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: "center", gap: 3 },
  count: { fontSize: 22, fontWeight: "800" },
  label: { fontSize: 10, fontWeight: "600" },
  pct:   { fontSize: 10, color: "#6B7280" },
});

const RateRing = ({ rate, label }) => {
  const color = getRateColor(rate);
  return (
    <View style={rr.container}>
      <View style={[rr.ring, { borderColor: color }]}>
        <Text style={[rr.rate, { color }]}>{rate}%</Text>
        <Text style={rr.sub}>rate</Text>
      </View>
      {!!label && <Text style={rr.label}>{label}</Text>}
    </View>
  );
};
const rr = StyleSheet.create({
  container: { alignItems: "center", gap: 6 },
  ring:  { width: 90, height: 90, borderRadius: 45, borderWidth: 5, alignItems: "center", justifyContent: "center" },
  rate:  { fontSize: 20, fontWeight: "800", color: "#111827" },
  sub:   { fontSize: 10, color: "#9CA3AF" },
  label: { fontSize: 12, color: "#6B7280", fontWeight: "500" },
});

const RecordRow = ({ record }) => {
  const status = (record.status || "").toLowerCase();
  const meta   = STATUS_META[status] || STATUS_META.absent;
  return (
    <View style={row.container}>
      <View style={[row.dot, { backgroundColor: meta.color }]} />
      <View style={{ flex: 1 }}>
        <Text style={row.date}>{formatDate(record.date) || record.date}</Text>
        {!!record.note    && <Text style={row.note} numberOfLines={1}>{record.note}</Text>}
        {!!record.subject && <Text style={row.note} numberOfLines={1}>{record.subject}</Text>}
      </View>
      <View style={[row.badge, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={12} color={meta.color} />
        <Text style={[row.badgeText, { color: meta.color }]}>{meta.label}</Text>
      </View>
    </View>
  );
};
const row = StyleSheet.create({
  container: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#FFF",
    borderRadius: 10, padding: 12, marginBottom: 6, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  dot:       { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  date:      { fontSize: 13, fontWeight: "600", color: "#111827" },
  note:      { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  badge:     { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  badgeText: { fontSize: 11, fontWeight: "700" },
});

const WeekBar = ({ records, weekStart }) => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart + "T00:00:00");
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const record  = records.find((r) => r.date === dateStr);
    const status  = record?.status || null;
    return {
      day: DAY_NAMES[d.getDay()], date: dateStr,
      meta: status ? STATUS_META[status] : null,
      isToday: dateStr === todayStr(),
    };
  });
  return (
    <View style={wb.container}>
      {days.map((d) => (
        <View key={d.date} style={wb.col}>
          <View style={[wb.bar, {
            backgroundColor: d.meta ? d.meta.bg : "#F3F4F6",
            borderColor:  d.isToday ? "#4F46E5" : "transparent",
            borderWidth:  d.isToday ? 2 : 0,
          }]}>
            {d.meta
              ? <Ionicons name={d.meta.icon} size={16} color={d.meta.color} />
              : <View style={wb.empty} />
            }
          </View>
          <Text style={[wb.dayLabel, d.isToday && { color: "#4F46E5", fontWeight: "700" }]}>
            {d.day}
          </Text>
          <Text style={wb.dateLabel}>{formatDateShort(d.date)}</Text>
        </View>
      ))}
    </View>
  );
};
const wb = StyleSheet.create({
  container: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 },
  col:       { alignItems: "center", gap: 4, flex: 1 },
  bar:       { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  empty:     { width: 8, height: 8, borderRadius: 4, backgroundColor: "#D1D5DB" },
  dayLabel:  { fontSize: 10, fontWeight: "600", color: "#6B7280" },
  dateLabel: { fontSize: 9, color: "#9CA3AF" },
});

const MonthCalendar = ({ records, month, year }) => {
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const recordMap   = Object.fromEntries(
    records.filter((r) => r.date).map((r) => [r.date, r])
  );

  const cells = [
    ...Array.from({ length: firstDay },    (_, i) => ({ empty: true, key: `e${i}` })),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d       = i + 1;
      const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const record  = recordMap[dateStr];
      const status  = record?.status || null;
      return {
        d, dateStr, key: dateStr,
        meta:     status ? STATUS_META[status] : null,
        isToday:  dateStr === todayStr(),
        isFuture: dateStr > todayStr(),
      };
    }),
  ];

  return (
    <View>
      <View style={cal.headerRow}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map((day) => (
          <Text key={day} style={cal.headerCell}>{day}</Text>
        ))}
      </View>
      <View style={cal.grid}>
        {cells.map((cell) => cell.empty
          ? <View key={cell.key} style={cal.cell} />
          : (
            <View key={cell.key} style={[
              cal.cell,
              cell.meta    && { backgroundColor: cell.meta.bg },
              cell.isToday && cal.cellToday,
            ]}>
              <Text style={[
                cal.cellText,
                cell.meta     && { color: cell.meta.color, fontWeight: "700" },
                cell.isToday  && { color: "#4F46E5", fontWeight: "800" },
                cell.isFuture && { color: "#D1D5DB" },
              ]}>
                {cell.d}
              </Text>
              {cell.meta && (
                <View style={[cal.dot, { backgroundColor: cell.meta.color }]} />
              )}
            </View>
          )
        )}
      </View>
    </View>
  );
};
const cal = StyleSheet.create({
  headerRow:  { flexDirection: "row", justifyContent: "space-around", marginBottom: 6 },
  headerCell: { width: 36, textAlign: "center", fontSize: 11, fontWeight: "700", color: "#9CA3AF" },
  grid:       { flexDirection: "row", flexWrap: "wrap" },
  cell:       { width: `${100/7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 8, padding: 2, gap: 2 },
  cellToday:  { borderWidth: 2, borderColor: "#4F46E5" },
  cellText:   { fontSize: 12, fontWeight: "500", color: "#374151" },
  dot:        { width: 4, height: 4, borderRadius: 2 },
});

const SourceBadge = ({ source }) => {
  const map = {
    sqlite:     { label: "Cached",   color: "#D97706", bg: "#FEF3C7" },
    "api-empty":{ label: "No Data",  color: "#6B7280", bg: "#F3F4F6" },
    none:       { label: "Offline",  color: "#DC2626", bg: "#FEE2E2" },
  };
  const v = map[source];
  if (!v) return null;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 3,
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
      backgroundColor: v.bg,
    }}>
      <Ionicons name="cloud-offline-outline" size={11} color={v.color} />
      <Text style={{ fontSize: 10, fontWeight: "700", color: v.color }}>{v.label}</Text>
    </View>
  );
};

// ── Tiny reusable layout pieces ───────────────────────────────────────────────

const EmptyCard = ({ title, sub }) => (
  <View style={s.noRecord}>
    <Ionicons name="calendar-outline" size={36} color="#D1D5DB" />
    <Text style={s.noRecordTitle}>{title}</Text>
    <Text style={s.noRecordSub}>{sub}</Text>
  </View>
);

const RatePill = ({ rate }) => (
  <View style={s.ratePill}>
    <Text style={[s.ratePillText, { color: getRateColor(rate) }]}>
      {rate}% attendance
    </Text>
  </View>
);

const ProgressBars = ({ summary }) => (
  <View style={s.progressSection}>
    {["present","absent","late","excused"].map((st) => {
      const meta = STATUS_META[st];
      const pct  = summary.total > 0 ? (summary[st] / summary.total) * 100 : 0;
      return (
        <View key={st} style={s.progressRow}>
          <Text style={s.progressLabel}>{meta.label}</Text>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${pct}%`, backgroundColor: meta.color }]} />
          </View>
          <Text style={[s.progressCount, { color: meta.color }]}>{summary[st]}</Text>
        </View>
      );
    })}
  </View>
);

const Navigator = ({ label, onPrev, onNext, nextDisabled }) => (
  <View style={s.navigator}>
    <TouchableOpacity style={s.navBtn} onPress={onPrev} activeOpacity={0.7}>
      <Ionicons name="chevron-back" size={20} color="#374151" />
    </TouchableOpacity>
    <Text style={s.navLabel}>{label}</Text>
    <TouchableOpacity
      style={[s.navBtn, nextDisabled && s.navBtnDisabled]}
      onPress={nextDisabled ? undefined : onNext}
      disabled={nextDisabled}
      activeOpacity={0.7}
    >
      <Ionicons
        name="chevron-forward"
        size={20}
        color={nextDisabled ? "#D1D5DB" : "#374151"}
      />
    </TouchableOpacity>
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentAttendanceScreen() {
  const router  = useRouter();
  const user    = useAuthStore((s) => s.user);

  const userId = useMemo(() =>
    user?._id || user?.id || user?.userId || user?.studentId || user?.user_id || null,
  [user]);

  const schoolId = useMemo(() =>
    user?.schoolId || user?.school_id || user?.school?._id || null,
  [user]);

  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [allRecords,  setAllRecords]  = useState([]);
  const [source,      setSource]      = useState(null);
  const [activeTab,   setActiveTab]   = useState("weekly");
  const [weekOffset,  setWeekOffset]  = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [error,       setError]       = useState(null);

  const weekRange  = useMemo(() => getWeekRange(weekOffset),   [weekOffset]);
  const monthRange = useMemo(() => getMonthRange(monthOffset), [monthOffset]);

  // ── Load ─────────────────────────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false) => {
    if (!userId) {
      setError("Could not identify your account. Please log out and sign in again.");
      setLoading(false);
      return;
    }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const { records, source: src } = await loadAttendanceRecords({
        userId,
        schoolId,
        startDate: sixMonthsAgo.toISOString().slice(0, 10),
        endDate:   todayStr(),
      });

      const sorted = [...records].sort((a, b) =>
        (b.date || "").localeCompare(a.date || "")
      );

      console.log(`[StudentAttendance] Final: ${sorted.length} records, source=${src}`);
      setAllRecords(sorted);
      setSource(src);
    } catch (err) {
      console.warn("[StudentAttendance] load error:", err.message);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, schoolId]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const todayRecords   = useMemo(() =>
    allRecords.filter((r) => r.date === todayStr()), [allRecords]);
  const todaySummary   = useMemo(() => buildSummary(todayRecords),  [todayRecords]);

  const weekRecords    = useMemo(() =>
    allRecords.filter((r) => r.date >= weekRange.start && r.date <= weekRange.end),
    [allRecords, weekRange]);
  const weekSummary    = useMemo(() => buildSummary(weekRecords),   [weekRecords]);

  const monthRecords   = useMemo(() =>
    allRecords.filter((r) => r.date >= monthRange.start && r.date <= monthRange.end),
    [allRecords, monthRange]);
  const monthSummary   = useMemo(() => buildSummary(monthRecords),  [monthRecords]);

  const overallSummary = useMemo(() => buildSummary(allRecords),    [allRecords]);

  // ── Loading screen ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={s.loadingText}>Loading attendance…</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <View style={s.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      {/* HEADER */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>My Attendance</Text>
          <Text style={s.headerSub}>
            {user?.name || user?.fullName || user?.studentName || "Student"}
          </Text>
        </View>
        <SourceBadge source={source} />
      </View>

      {/* TAB BAR */}
      <View style={s.tabBar}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[s.tab, active && s.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <Text style={[s.tabLabel, active && s.tabLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* Error */}
        {!!error && (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={20} color="#DC2626" />
            <Text style={s.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => load(true)}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ══ DAILY ══ */}
        {activeTab === "daily" && (
          <>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="calendar" size={18} color="#4F46E5" />
                <Text style={s.cardTitle}>Today</Text>
                <Text style={s.cardSub}>{formatDate(todayStr())}</Text>
              </View>
              {todayRecords.length === 0
                ? <EmptyCard title="No record today" sub="Attendance hasn't been marked yet for today." />
                : (
                  <>
                    <View style={s.rateRow}>
                      <RateRing rate={todaySummary.rate} label="Today" />
                      <View style={s.statCardsWrap}>
                        {["present","absent","late","excused"].map((st) => (
                          <StatCard key={st} status={st} count={todaySummary[st]} total={todaySummary.total} />
                        ))}
                      </View>
                    </View>
                    {todayRecords.map((r, i) => <RecordRow key={r.id || i} record={r} />)}
                  </>
                )
              }
            </View>

            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="time-outline" size={18} color="#059669" />
                <Text style={s.cardTitle}>Recent Records</Text>
                <Text style={s.cardSub}>{allRecords.length} total</Text>
              </View>
              {allRecords.length === 0
                ? <EmptyCard title="No records found" sub="Pull down to refresh." />
                : allRecords.slice(0, 10).map((r, i) => (
                    <RecordRow key={r.id || i} record={r} />
                  ))
              }
            </View>
          </>
        )}

        {/* ══ WEEKLY ══ */}
        {activeTab === "weekly" && (
          <>
            <Navigator
              label={weekRange.label}
              onPrev={() => setWeekOffset((v) => v - 1)}
              onNext={() => setWeekOffset((v) => v + 1)}
              nextDisabled={weekOffset >= 0}
            />
            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="bar-chart-outline" size={18} color="#4F46E5" />
                <Text style={s.cardTitle}>Week Overview</Text>
              </View>
              <WeekBar records={weekRecords} weekStart={weekRange.start} />
            </View>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="stats-chart" size={18} color="#7C3AED" />
                <Text style={s.cardTitle}>Week Summary</Text>
                <RatePill rate={weekSummary.rate} />
              </View>
              {weekSummary.total === 0
                ? <EmptyCard
                    title="No records this week"
                    sub={allRecords.length > 0
                      ? `You have ${allRecords.length} record(s) — try another week.`
                      : "No attendance data found yet."}
                  />
                : (
                  <>
                    <View style={s.statRow}>
                      {["present","absent","late","excused"].map((st) => (
                        <StatCard key={st} status={st} count={weekSummary[st]} total={weekSummary.total} />
                      ))}
                    </View>
                    {weekRecords.map((r, i) => <RecordRow key={r.id || i} record={r} />)}
                  </>
                )
              }
            </View>
          </>
        )}

        {/* ══ MONTHLY ══ */}
        {activeTab === "monthly" && (
          <>
            <Navigator
              label={monthRange.label}
              onPrev={() => setMonthOffset((v) => v - 1)}
              onNext={() => setMonthOffset((v) => v + 1)}
              nextDisabled={monthOffset >= 0}
            />
            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="calendar-outline" size={18} color="#4F46E5" />
                <Text style={s.cardTitle}>{monthRange.label}</Text>
              </View>
              <MonthCalendar
                records={monthRecords}
                month={monthRange.month}
                year={monthRange.year}
              />
            </View>
            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="stats-chart" size={18} color="#059669" />
                <Text style={s.cardTitle}>Month Summary</Text>
                <RatePill rate={monthSummary.rate} />
              </View>
              {monthSummary.total === 0
                ? <EmptyCard
                    title="No records this month"
                    sub={allRecords.length > 0
                      ? `You have ${allRecords.length} record(s) — try another month.`
                      : "No attendance data found yet."}
                  />
                : (
                  <>
                    <View style={s.statRow}>
                      {["present","absent","late","excused"].map((st) => (
                        <StatCard key={st} status={st} count={monthSummary[st]} total={monthSummary.total} />
                      ))}
                    </View>
                    <ProgressBars summary={monthSummary} />
                  </>
                )
              }
            </View>
          </>
        )}

        {/* ══ OVERALL ══ */}
        {activeTab === "overall" && (
          <>
            <View style={[s.card, s.overallCard]}>
              <Text style={s.overallTitle}>Overall Attendance Rate</Text>
              <RateRing rate={overallSummary.rate} />
              <Text style={s.overallTotal}>
                {overallSummary.total} total record{overallSummary.total !== 1 ? "s" : ""}
              </Text>
              <Text style={s.overallRange}>
                {allRecords.length > 0
                  ? `${formatDate(allRecords[allRecords.length-1]?.date)} — ${formatDate(allRecords[0]?.date)}`
                  : "No records yet"}
              </Text>
            </View>

            {overallSummary.total > 0 && (
              <>
                <View style={s.card}>
                  <View style={s.cardHeader}>
                    <Ionicons name="stats-chart" size={18} color="#4F46E5" />
                    <Text style={s.cardTitle}>Breakdown</Text>
                  </View>
                  <View style={s.statRow}>
                    {["present","absent","late","excused"].map((st) => (
                      <StatCard key={st} status={st} count={overallSummary[st]} total={overallSummary.total} />
                    ))}
                  </View>
                  <ProgressBars summary={overallSummary} />
                </View>

                <View style={s.card}>
                  <View style={s.cardHeader}>
                    <Ionicons name="trending-up-outline" size={18} color="#059669" />
                    <Text style={s.cardTitle}>Monthly Trend</Text>
                  </View>
                  {[-5,-4,-3,-2,-1,0].map((offset) => {
                    const range   = getMonthRange(offset);
                    const recs    = allRecords.filter(
                      (r) => r.date >= range.start && r.date <= range.end
                    );
                    const summary = buildSummary(recs);
                    if (summary.total === 0) return null;
                    return (
                      <View key={offset} style={s.trendRow}>
                        <Text style={s.trendMonth}>{range.label}</Text>
                        <View style={s.trendBar}>
                          {["present","late","excused","absent"].map((st) => {
                            const pct = summary.total > 0
                              ? (summary[st] / summary.total) * 100 : 0;
                            if (pct === 0) return null;
                            return (
                              <View
                                key={st}
                                style={{
                                  width: `${pct}%`, height: "100%",
                                  backgroundColor: STATUS_META[st].color,
                                }}
                              />
                            );
                          })}
                        </View>
                        <Text style={[s.trendRate, { color: getRateColor(summary.rate) }]}>
                          {summary.rate}%
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </>
            )}

            <View style={s.card}>
              <View style={s.cardHeader}>
                <Ionicons name="list-outline" size={18} color="#6B7280" />
                <Text style={s.cardTitle}>All Records</Text>
                <Text style={s.cardSub}>{allRecords.length} total</Text>
              </View>
              {allRecords.length === 0
                ? <EmptyCard
                    title="No attendance records"
                    sub="Your attendance will appear here once your teacher marks it."
                  />
                : (
                  <>
                    {allRecords.slice(0, 30).map((r, i) => (
                      <RecordRow key={r.id || i} record={r} />
                    ))}
                    {allRecords.length > 30 && (
                      <Text style={s.moreText}>
                        + {allRecords.length - 30} more records
                      </Text>
                    )}
                  </>
                )
              }
            </View>
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    gap: 10,
  },
  backBtn:     { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },

  tabBar: {
    flexDirection: "row", backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    paddingHorizontal: 4,
  },
  tab:            { flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive:      { borderBottomColor: "#4F46E5" },
  tabLabel:       { fontSize: 13, fontWeight: "600", color: "#9CA3AF" },
  tabLabelActive: { color: "#4F46E5" },

  scroll: { paddingHorizontal: 16, paddingTop: 12 },

  card: {
    backgroundColor: "#FFF", borderRadius: 16, padding: 16, marginBottom: 12,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
    gap: 12,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cardTitle:  { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardSub:    { fontSize: 12, color: "#9CA3AF", marginLeft: "auto" },

  statRow:       { flexDirection: "row", gap: 8 },
  statCardsWrap: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  rateRow:       { flexDirection: "row", alignItems: "center", gap: 16 },

  ratePill:     { marginLeft: "auto", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: "#F3F4F6" },
  ratePillText: { fontSize: 11, fontWeight: "700" },

  navigator: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  navBtn:         { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  navBtnDisabled: { backgroundColor: "#F9FAFB" },
  navLabel:       { fontSize: 14, fontWeight: "700", color: "#111827" },

  progressSection: { gap: 10 },
  progressRow:     { flexDirection: "row", alignItems: "center", gap: 10 },
  progressLabel:   { fontSize: 12, fontWeight: "600", color: "#374151", width: 56 },
  progressTrack:   { flex: 1, height: 8, backgroundColor: "#F3F4F6", borderRadius: 4, overflow: "hidden" },
  progressFill:    { height: "100%", borderRadius: 4 },
  progressCount:   { fontSize: 12, fontWeight: "700", width: 24, textAlign: "right" },

  overallCard:  { alignItems: "center", gap: 8 },
  overallTitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  overallTotal: { fontSize: 13, color: "#6B7280" },
  overallRange: { fontSize: 11, color: "#9CA3AF", textAlign: "center" },

  trendRow:   { flexDirection: "row", alignItems: "center", gap: 10 },
  trendMonth: { fontSize: 11, fontWeight: "600", color: "#374151", width: 70 },
  trendBar:   { flex: 1, height: 12, borderRadius: 6, overflow: "hidden", flexDirection: "row", backgroundColor: "#F3F4F6" },
  trendRate:  { fontSize: 11, fontWeight: "700", width: 32, textAlign: "right" },

  noRecord:      { alignItems: "center", paddingVertical: 24, gap: 8 },
  noRecordTitle: { fontSize: 15, fontWeight: "700", color: "#374151" },
  noRecordSub:   { fontSize: 12, color: "#9CA3AF", textAlign: "center" },

  moreText: { fontSize: 12, color: "#9CA3AF", textAlign: "center", paddingVertical: 8 },

  errorBox:  { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#FEE2E2", borderRadius: 10, padding: 12, marginBottom: 10 },
  errorText: { flex: 1, fontSize: 13, color: "#DC2626" },
  retryText: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },
});