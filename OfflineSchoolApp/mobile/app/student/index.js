// app/student/index.js
"use strict";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Image,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons }  from "@expo/vector-icons";
import { useAuthStore }         from "../../src/store/auth.store";
import { useAnnouncementStore } from "../../src/store/announcement.store";
import { getDatabase }          from "../../src/db/database";
import { getSchoolInfo }        from "../../src/services/school.service";
import {
  resolveStudentClassId,
  getStudentAttendance,
  getStudentQuizHistory,
} from "../../src/services/student.service";
import {
  getStudentHomework,
  ensureHomeworkTables,
} from "../../src/services/homework.service";
import {
  getQuizzes,
  getUserAttempts,
} from "../../src/services/quiz.service";
import { isStudentProfileComplete } from "./profile/setup";
import { toDisplayUri }             from "../../src/utils/logoUri";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
};

const formatTime = (timeStr) => {
  if (!timeStr) return "";
  try {
    const [h, m] = timeStr.split(":");
    const hour   = parseInt(h, 10);
    const ampm   = hour >= 12 ? "PM" : "AM";
    const h12    = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  } catch { return timeStr; }
};

const getDayName   = () =>
  new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

const getDateString = () =>
  new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });

// ── Homework helpers ──────────────────────────────────────────────────────────

const getDueStatus = (dueDateStr, submittedAt = null) => {
  if (!dueDateStr)
    return { label: "No deadline", color: "#6B7280", bg: "#F3F4F6", urgent: false };

  const due  = new Date(dueDateStr);
  const now  = new Date();
  const diff = due - now;

  if (submittedAt) {
    const wasLate = new Date(submittedAt) > due;
    return wasLate
      ? { label: "Submitted late",    color: "#D97706", bg: "#FEF3C7", urgent: false }
      : { label: "Submitted on time", color: "#059669", bg: "#ECFDF5", urgent: false };
  }

  if (diff < 0) {
    const daysAgo = Math.floor(Math.abs(diff) / 86400000);
    return {
      label:  daysAgo > 0 ? `${daysAgo}d overdue` : "Overdue",
      color:  "#DC2626", bg: "#FEE2E2",
      urgent: true, isPast: true,
    };
  }

  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (hours < 6)  return { label: `${hours}h left`, color: "#DC2626", bg: "#FEE2E2", urgent: true  };
  if (hours < 24) return { label: "Due today",       color: "#D97706", bg: "#FEF3C7", urgent: true  };
  if (days === 1) return { label: "Due tomorrow",    color: "#D97706", bg: "#FEF3C7", urgent: false };
  if (days < 7)   return { label: `${days}d left`,   color: "#059669", bg: "#ECFDF5", urgent: false };
  return              { label: `${Math.floor(days / 7)}w left`, color: "#059669", bg: "#ECFDF5", urgent: false };
};

const getHomeworkSubmissionStatus = (hw) => {
  if (hw.submission_score != null) {
    const pct = hw.max_score > 0
      ? Math.round((hw.submission_score / hw.max_score) * 100) : 0;
    return {
      type:  "graded",
      label: `${hw.submission_score}/${hw.max_score} (${pct}%)`,
      color: pct >= 70 ? "#059669" : "#DC2626",
      icon:  "ribbon-outline",
    };
  }
  if (hw.submission_id)
    return { type: "submitted", label: "Submitted", color: "#4F46E5", icon: "checkmark-circle-outline" };

  const due    = hw.due_date ? new Date(hw.due_date) : null;
  const isPast = due && new Date() > due;
  return {
    type:  "pending",
    label: isPast ? "Late" : "Pending",
    color: isPast ? "#D97706" : "#6B7280",
    icon:  "document-outline",
  };
};

const sameId = (a, b) =>
  a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const getQuizStatus = (quiz, attempts = []) => {
  const now          = new Date();
  const qId          = quiz.id || quiz._id;
  const quizAttempts = attempts.filter((a) => sameId(a.quiz_id, qId));
  const submitted    = quizAttempts.filter(
    (a) => a.status === "submitted" || a.status === "timed_out"
  );

  if (submitted.length > 0 && !quiz.is_published) {
    const best = Math.max(...submitted.map((a) => a.percentage || 0));
    return {
      canStart: false, canAttempt: false,
      attempts: submitted.length, best,
      isPassed: submitted.some((a) => a.is_passed),
      label:    `Completed · ${best.toFixed(1)}%`,
    };
  }
  if (!quiz.is_published)
    return { canStart: false, canAttempt: false, attempts: 0, label: "Unavailable" };
  if (quiz.available_from && now < new Date(quiz.available_from))
    return { canStart: false, canAttempt: false, attempts: 0, label: "Not open yet" };
  if (quiz.available_until && now > new Date(quiz.available_until)) {
    if (submitted.length > 0) {
      const best = Math.max(...submitted.map((a) => a.percentage || 0));
      return {
        canStart: false, canAttempt: false,
        attempts: submitted.length, best,
        isPassed: submitted.some((a) => a.is_passed),
        label:    `Completed · ${best.toFixed(1)}%`,
      };
    }
    return { canStart: false, canAttempt: false, attempts: 0, label: "Closed" };
  }
  if (quiz.max_attempts != null && submitted.length >= quiz.max_attempts) {
    const best = submitted.length > 0
      ? Math.max(...submitted.map((a) => a.percentage || 0)) : 0;
    return {
      canStart: false, canAttempt: false,
      attempts: submitted.length, best,
      isPassed: submitted.some((a) => a.is_passed),
      label:    `Completed · ${best.toFixed(1)}%`,
    };
  }
  const inProgress = quizAttempts.find((a) => a.status === "in_progress");
  if (inProgress)
    return {
      canStart: true, canAttempt: true,
      attempts: submitted.length,
      resumeId: inProgress.id || inProgress._id,
      label:    "In Progress",
    };
  return {
    canStart: true, canAttempt: true,
    attempts: submitted.length,
    label:    submitted.length > 0 ? "Retake" : "Not Started",
  };
};

const dbQuery = async (db, sql, params = []) => {
  try { return (await db.getAllAsync(sql, params)) ?? []; }
  catch (err) { console.warn("[StudentDash] query failed:", err.message); return []; }
};

const dbFirst = async (db, sql, params = []) => {
  try { return await db.getFirstAsync(sql, params); }
  catch { return null; }
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADERS
// ─────────────────────────────────────────────────────────────────────────────

const loadClassName = async (db, classId) => {
  if (!classId) return null;
  const row = await dbFirst(db, `SELECT name FROM classes WHERE id = ? LIMIT 1`, [classId]);
  return row?.name || null;
};

const loadTodaysTimetable = async (db, classId) => {
  if (!classId) return [];
  const dayName = getDayName();
  try {
    const tableCheck = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='timetable'`
    ).catch(() => null);
    if (!tableCheck?.cnt) return [];

    const ttCols   = await db.getAllAsync(`PRAGMA table_info(timetable)`, []).catch(() => []);
    const ttColSet = new Set(ttCols.map((c) => c.name));

    const idCol        = ttColSet.has("id")         ? "t.id"         : ttColSet.has("_id")         ? "t._id"         : "t.rowid";
    const classIdCol   = ttColSet.has("classId")    ? "t.classId"    : ttColSet.has("class_id")    ? "t.class_id"    : ttColSet.has("class")      ? "t.class"      : null;
    const dayCol       = ttColSet.has("dayOfWeek")  ? "t.dayOfWeek"  : ttColSet.has("day_of_week") ? "t.day_of_week" : ttColSet.has("day")        ? "t.day"        : ttColSet.has("day_name")   ? "t.day_name"   : ttColSet.has("weekday")    ? "t.weekday"    : null;
    const subjectIdCol = ttColSet.has("subjectId")  ? "t.subjectId"  : ttColSet.has("subject_id")  ? "t.subject_id"  : null;
    const teacherIdCol = ttColSet.has("teacherId")  ? "t.teacherId"  : ttColSet.has("teacher_id")  ? "t.teacher_id"  : null;
    const periodIdCol  = ttColSet.has("periodId")   ? "t.periodId"   : ttColSet.has("period_id")   ? "t.period_id"   : null;
    const startTimeCol = ttColSet.has("start_time") ? "t.start_time" : ttColSet.has("startTime")   ? "t.startTime"   : null;
    const endTimeCol   = ttColSet.has("end_time")   ? "t.end_time"   : ttColSet.has("endTime")     ? "t.endTime"     : null;
    const roomCol      = ttColSet.has("room")       ? "t.room"       : ttColSet.has("room_number")  ? "t.room_number" : null;
    const deletedColName = ttColSet.has("deleted_at") ? "t.deleted_at" : ttColSet.has("deletedAt") ? "t.deletedAt" : null;
    const deletedFilter  = deletedColName
      ? `AND (${deletedColName} IS NULL OR ${deletedColName} = '')` : "";

    if (!classIdCol || !dayCol) return [];

    let selectClause = `SELECT ${idCol} AS id, ${roomCol || "NULL"} AS room, ${dayCol} AS dayOfWeek`;
    let fromClause   = ` FROM timetable t`;

    if (subjectIdCol) {
      selectClause += `, s.name AS subjectName, s.code AS subjectCode`;
      fromClause   += ` LEFT JOIN subjects s ON s.id = ${subjectIdCol}`;
    } else {
      selectClause += `, NULL AS subjectName, NULL AS subjectCode`;
    }

    if (teacherIdCol) {
      selectClause += `, u.name AS teacherName`;
      fromClause   += ` LEFT JOIN users u ON u.id = ${teacherIdCol}`;
    } else {
      selectClause += `, NULL AS teacherName`;
    }

    if (periodIdCol) {
      const pCols   = await db.getAllAsync(`PRAGMA table_info(periods)`, []).catch(() => []);
      const pColSet = new Set(pCols.map((c) => c.name));
      const pStart  = pColSet.has("starttime")  ? "p.starttime"  : pColSet.has("start_time") ? "p.start_time" : "NULL";
      const pEnd    = pColSet.has("endtime")    ? "p.endtime"    : pColSet.has("end_time")   ? "p.end_time"   : "NULL";
      const pBreak  = pColSet.has("isbreak")    ? "p.isbreak"    : pColSet.has("is_break")   ? "p.is_break"   : "0";
      const pSort   = pColSet.has("sortorder")  ? "p.sortorder"  : pColSet.has("sort_order") ? "p.sort_order" : "0";
      selectClause += `, p.name AS periodName, ${pStart} AS startTime, ${pEnd} AS endTime, ${pBreak} AS isbreak, ${pSort} AS sortorder`;
      fromClause   += ` LEFT JOIN periods p ON p.id = ${periodIdCol}`;
    } else if (startTimeCol && endTimeCol) {
      selectClause += `, NULL AS periodName, ${startTimeCol} AS startTime, ${endTimeCol} AS endTime, 0 AS isbreak, 0 AS sortorder`;
    } else {
      selectClause += `, NULL AS periodName, NULL AS startTime, NULL AS endTime, 0 AS isbreak, 0 AS sortorder`;
    }

    const orderCol = periodIdCol ? "p.sortorder" : startTimeCol || "t.rowid";
    return await db.getAllAsync(
      `${selectClause} ${fromClause}
       WHERE ${classIdCol} = ?
         AND LOWER(${dayCol}) = ?
         ${deletedFilter}
       ORDER BY ${orderCol} ASC`,
      [classId, dayName]
    );
  } catch (err) {
    console.warn("[loadTodaysTimetable]", err.message);
    return [];
  }
};

const loadSubjectsForClass = async (db, classId) => {
  if (!classId) return [];
  return dbQuery(
    db,
    `SELECT s.id, s.name, s.code, u.name AS teacherName
     FROM subjects s LEFT JOIN users u ON u.id = s.teacher_id
     WHERE (s.class_id = ? OR s.classId = ?)
       AND (s.deleted_at IS NULL OR s.deleted_at = '')
     ORDER BY s.name ASC`,
    [classId, classId]
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL INFO — student-safe local-first fetch
// Students must NOT call /teacher/school/info (403).
// ─────────────────────────────────────────────────────────────────────────────

const loadSchoolInfoForStudent = async (db, schoolId) => {
  if (!schoolId) return null;

  // 1. Try local schools table
  try {
    const tableCheck = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='schools'`
    ).catch(() => null);

    if (tableCheck?.cnt) {
      const row = await db.getFirstAsync(
        `SELECT * FROM schools WHERE id = ? LIMIT 1`, [schoolId]
      ).catch(() => null);

      if (row) {
        return {
          name:    row.name    || row.school_name || null,
          logo:    row.logo    || null,
          motto:   row.motto   || null,
          city:    row.city    || null,
          country: row.country || null,
        };
      }
    }
  } catch { /* non-fatal */ }

  // 2. Try local school_info table
  try {
    const tableCheck2 = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='school_info'`
    ).catch(() => null);

    if (tableCheck2?.cnt) {
      const row = await db.getFirstAsync(`SELECT * FROM school_info LIMIT 1`).catch(() => null);
      if (row) {
        return {
          name:    row.name    || row.school_name || null,
          logo:    row.logo    || null,
          motto:   row.motto   || null,
          city:    row.city    || null,
          country: row.country || null,
        };
      }
    }
  } catch { /* non-fatal */ }

  // 3. getSchoolInfo — skip remote to avoid teacher-only API call
  try {
    const info = await getSchoolInfo(schoolId, { skipRemote: true });
    if (info) return info;
  } catch { /* non-fatal */ }

  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL BANNER
// ─────────────────────────────────────────────────────────────────────────────

const SchoolBanner = React.memo(({ school, className }) => {
  if (!school?.name) return null;

  // Prefers the locally cached file, so the logo still shows offline now that
  // the server sends a URL rather than inline base64.
  const logoUri  = toDisplayUri(school.logoLocal, school.logo);
  const hasLogo  = !!logoUri;
  const location = [school.city, school.country].filter(Boolean).join(", ");

  return (
    <View style={sb.banner}>
      {hasLogo ? (
        <Image
          source={{ uri: logoUri }}
          style={sb.logo}
          resizeMode="contain"
        />
      ) : (
        <View style={sb.logoFallback}>
          <Ionicons name="school" size={20} color="#4F46E5" />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={sb.schoolName} numberOfLines={1}>{school.name}</Text>
        {!!location && (
          <Text style={sb.location} numberOfLines={1}>
            <Ionicons name="location-outline" size={11} color="#6B7280" /> {location}
          </Text>
        )}
        {!!school.motto && (
          <Text style={sb.motto} numberOfLines={1}>"{school.motto}"</Text>
        )}
      </View>
      {!!className && (
        <View style={sb.classChip}>
          <Ionicons name="people-outline" size={11} color="#4F46E5" />
          <Text style={sb.classChipText} numberOfLines={1}>{className}</Text>
        </View>
      )}
    </View>
  );
});

const sb = StyleSheet.create({
  banner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF",
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    gap: 10, borderWidth: 1, borderColor: "#C7D2FE",
  },
  logo: { width: 40, height: 40, borderRadius: 10, backgroundColor: "#fff" },
  logoFallback: {
    width: 40, height: 40, borderRadius: 10, backgroundColor: "#fff",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "#C7D2FE",
  },
  schoolName: { fontSize: 13, fontWeight: "700", color: "#1E1B4B" },
  location:   { fontSize: 11, color: "#6B7280", marginTop: 2 },
  motto:      { fontSize: 11, color: "#4F46E5", fontStyle: "italic", marginTop: 2, fontWeight: "500" },
  classChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#fff", paddingHorizontal: 8, paddingVertical: 5,
    borderRadius: 8, borderWidth: 1, borderColor: "#C7D2FE",
  },
  classChipText: { fontSize: 11, fontWeight: "700", color: "#4F46E5", maxWidth: 80 },
});

// ─────────────────────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const StatCard = ({ icon, value, label, bg, color }) => (
  <View style={[s.statCard, { backgroundColor: bg }]}>
    <View style={[s.statIconBg, { backgroundColor: color + "20" }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={[s.statValue, { color }]}>{value ?? "—"}</Text>
    <Text style={s.statLabel}>{label}</Text>
  </View>
);

const SectionHead = ({ title, action, onAction }) => (
  <View style={s.sectionHeader}>
    <Text style={s.sectionTitle}>{title}</Text>
    {action && onAction && (
      <TouchableOpacity onPress={onAction} activeOpacity={0.7}>
        <Text style={s.seeAll}>{action}</Text>
      </TouchableOpacity>
    )}
  </View>
);

const EmptyCard = ({ icon, title, subtitle }) => (
  <View style={s.emptyCard}>
    <Ionicons name={icon} size={32} color="#D1D5DB" />
    <Text style={s.emptyCardTitle}>{title}</Text>
    {subtitle && <Text style={s.emptyCardSub}>{subtitle}</Text>}
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentDashboard() {
  const router = useRouter();

  // Primitive IDs — stable deps, no infinite loop
  const userId   = useAuthStore((st) => st.user?._id  || st.user?.id  || st.user?.userId || null);
  const schoolId = useAuthStore((st) => st.user?.schoolId || null);

  // Full user object — for display and callbacks only, NOT used in useEffect deps
  const user   = useAuthStore((st) => st.user);
  const logout = useAuthStore((st) => st.logout);

  const storeProfileCompleted = useAuthStore((s) => s.profileCompleted);

  const { inbox: storeInbox, fetchInbox, fetchStats } = useAnnouncementStore();

  const [loading,         setLoading]        = useState(true);
  const [refreshing,      setRefreshing]      = useState(false);
  const [school,          setSchool]          = useState(null);
  const [classId,         setClassId]         = useState(null);
  const [className,       setClassName]       = useState(null);
  const [todayClasses,    setTodayClasses]    = useState([]);
  const [subjects,        setSubjects]        = useState([]);
  const [attendance,      setAttendance]      = useState({ stats: {} });
  const [quizzes,         setQuizzes]         = useState([]);
  const [quizAttempts,    setQuizAttempts]    = useState([]);
  const [quizHistory,     setQuizHistory]     = useState([]);
  const [homework,        setHomework]        = useState([]);
  const [profileChecked,  setProfileChecked]  = useState(false);
  const [profileComplete, setProfileComplete] = useState(true);

  // ── Derived from store ────────────────────────────────────────────────────
  const unreadAnnouncements = useAnnouncementStore((s) =>
    s.inbox.filter((a) => !a.isRead).length
  );
  const pinnedAnnouncements = useMemo(
    () => storeInbox.filter((a) => a.isPinned).slice(0, 2),
    [storeInbox]
  );
  const recentAnnouncements = useMemo(
    () => storeInbox.filter((a) => !a.isPinned).slice(0, 3),
    [storeInbox]
  );

  // ── Derived stats ─────────────────────────────────────────────────────────
  const quizStats = useMemo(() => {
    if (!quizHistory.length) return { total: 0, avgScore: null, passed: 0 };
    const total    = quizHistory.length;
    const passed   = quizHistory.filter((a) => a.is_passed).length;
    const avgScore = Math.round(
      quizHistory.reduce((sum, a) => sum + (a.percentage || 0), 0) / total
    );
    return { total, avgScore, passed };
  }, [quizHistory]);

  const homeworkStats = useMemo(() => {
    const total     = homework.length;
    const pending   = homework.filter((h) => !h.submission_id).length;
    const submitted = homework.filter((h) => !!h.submission_id).length;
    const graded    = homework.filter((h) => h.submission_score != null).length;
    const urgent    = homework.filter((h) => {
      const due = getDueStatus(h.due_date, h.submission_submitted_at);
      return due.urgent && !h.submission_id;
    }).length;
    return { total, pending, submitted, graded, urgent };
  }, [homework]);

  const availableQuizzes = useMemo(
    () =>
      quizzes
        .map((q) => ({ quiz: q, status: getQuizStatus(q, quizAttempts) }))
        .filter(({ status }) => status.canStart)
        .slice(0, 3),
    [quizzes, quizAttempts]
  );

  // ── Profile completion check ──────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;

    if (storeProfileCompleted) {
      setProfileComplete(true);
      setProfileChecked(true);
      return;
    }

    if (profileChecked) return;

    const checkProfile = async () => {
      try {
        const complete = await isStudentProfileComplete(userId);
        setProfileComplete(complete);
        setProfileChecked(true);
        if (complete) {
          useAuthStore.getState().setProfileCompleted?.(true);
        } else {
          setTimeout(() => router.push("/student/profile/setup"), 800);
        }
      } catch (err) {
        console.warn("Student profile check failed:", err.message);
        setProfileChecked(true);
      }
    };

    checkProfile();
  }, [userId, profileChecked, storeProfileCompleted, router]);

  // ── Load dashboard data ───────────────────────────────────────────────────
  const loadData = useCallback(async (isRefresh = false) => {
    if (!userId) { setLoading(false); return; }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const db = await getDatabase();
      await ensureHomeworkTables();

      const cid = await resolveStudentClassId(userId, schoolId);
      setClassId(cid);

      const [
        schoolData,
        cName,
        tt,
        subj,
        attResult,
        quizData,
        attemptData,
        hist,
        hwList,
      ] = await Promise.all([
        loadSchoolInfoForStudent(db, schoolId),
        loadClassName(db, cid),
        loadTodaysTimetable(db, cid),
        loadSubjectsForClass(db, cid),
        getStudentAttendance(userId),
        getQuizzes({
          schoolId:   String(schoolId || ""),
          student_id: String(userId),
          class_id:   cid,
        }).catch(() => []),
        getUserAttempts(userId).catch(() => []),
        getStudentQuizHistory(userId, 10),
        getStudentHomework({
          schoolId:  String(schoolId || ""),
          studentId: String(userId),
          classId:   cid,
        }).catch(() => []),
      ]);

      if (schoolData) setSchool(schoolData);
      setClassName(cName);
      setTodayClasses(tt);
      setSubjects(subj);
      setAttendance(attResult);
      setQuizzes(quizData       ?? []);
      setQuizAttempts(attemptData ?? []);
      setQuizHistory(hist);
      setHomework(hwList || []);

      // Fetch announcements — user captured from outer scope,
      // not a dep of loadData to avoid infinite loop
      fetchInbox(user);
      fetchStats();

    } catch (err) {
      console.warn("[StudentDash] loadData error:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, schoolId, fetchInbox, fetchStats]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleLogout = async () => {
    await logout();
    router.replace("/auth/login");
  };

  // ── Quick actions ─────────────────────────────────────────────────────────
  const QUICK_ACTIONS = useMemo(() => [
    { id: "timetable",     title: "Timetable",     icon: "time-outline",          color: "#7C3AED", route: "/student/timetable"       },
    { id: "quizzes",       title: "Quizzes",       icon: "help-circle-outline",   color: "#4F46E5", route: "/student/quizzes"         },
    { id: "homework",      title: "Homework",      icon: "document-text-outline", color: "#059669", route: "/student/homework"        },
    { id: "subjects",      title: "Subjects",      icon: "book-outline",          color: "#D97706", route: "/student/subjects"        },
    { id: "attendance",    title: "Attendance",    icon: "calendar-outline",      color: "#DC2626", route: "/student/attendance"      },
    { id: "announcements", title: "Announcements", icon: "megaphone-outline",     color: "#DB2777", route: "/student/announcements"   },
    { id: "messages",      title: "Messages",      icon: "chatbubbles-outline",   color: "#2563EB", route: "/messages"                },
    { id: "results",       title: "Results",       icon: "trophy-outline",        color: "#059669", route: "/student/results"         },
    { id: "settings",      title: "Settings",      icon: "settings-outline",      color: "#6B7280", route: "/student/settings"        },
  ], []);

  // ── Loading screen ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={s.loadingText}>Loading dashboard…</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={s.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      {/* HEADER */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.greeting}>{getGreeting()},</Text>
          <Text style={s.userName} numberOfLines={1}>
            {user?.name || user?.fullName || user?.studentName || "Student"}
          </Text>
        </View>

        {!profileComplete && (
          <TouchableOpacity
            style={s.profileIncompleteBtn}
            onPress={() => router.push("/student/profile/setup")}
            activeOpacity={0.7}
            hitSlop={8}
          >
            <Ionicons name="alert-circle" size={16} color="#D97706" />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={s.headerIconBtn}
          onPress={() => router.push("/student/announcements")}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Ionicons name="notifications-outline" size={22} color="#6B7280" />
          {unreadAnnouncements > 0 && (
            <View style={s.headerBadge}>
              <Text style={s.headerBadgeText}>
                {unreadAnnouncements > 9 ? "9+" : unreadAnnouncements}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.headerIconBtn}
          onPress={() => router.push("/student/settings")}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Ionicons name="settings-outline" size={22} color="#6B7280" />
        </TouchableOpacity>

        <TouchableOpacity
          style={s.avatarCircle}
          onPress={() => router.push("/student/profile/setup")}
          activeOpacity={0.7}
        >
          <Text style={s.avatarText}>
            {(user?.name || user?.studentName || "S").charAt(0).toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* School banner */}
        <SchoolBanner school={school} className={className} />

        {/* Profile setup banner */}
        {!profileComplete && (
          <TouchableOpacity
            style={s.profileSetupBanner}
            onPress={() => router.push("/student/profile/setup")}
            activeOpacity={0.8}
          >
            <View style={s.profileSetupIcon}>
              <Ionicons name="person-add-outline" size={20} color="#FFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.profileSetupTitle}>Complete Your Profile</Text>
              <Text style={s.profileSetupSub}>
                Your school needs your full details — tap to complete setup
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#FFF" />
          </TouchableOpacity>
        )}

        {/* Date banner */}
        <View style={s.dateBanner}>
          <Ionicons name="calendar-outline" size={15} color="#6B7280" />
          <Text style={s.dateText}>{getDateString()}</Text>
        </View>

        {/* Stats row */}
        <View style={s.statsRow}>
          <StatCard
            icon="calendar"
            value={
              attendance.stats?.percentage != null
                ? `${attendance.stats.percentage}%`
                : attendance.percentage != null
                  ? `${attendance.percentage}%`
                  : "—"
            }
            label="Attendance"
            bg="#EEF2FF"
            color="#4F46E5"
          />
          <StatCard
            icon="document-text"
            value={homeworkStats.pending > 0 ? `${homeworkStats.pending}` : homeworkStats.total}
            label={homeworkStats.pending > 0 ? "HW Pending" : "Homework"}
            bg={homeworkStats.urgent > 0 ? "#FEE2E2" : "#ECFDF5"}
            color={homeworkStats.urgent > 0 ? "#DC2626" : "#059669"}
          />
          <StatCard
            icon="trophy"
            value={quizStats.avgScore != null ? `${quizStats.avgScore}%` : "—"}
            label="Avg Score"
            bg="#FFFBEB"
            color="#D97706"
          />
        </View>

        {/* Urgent homework banner */}
        {homeworkStats.urgent > 0 && (
          <View style={s.section}>
            <TouchableOpacity
              style={s.urgentBanner}
              onPress={() => router.push("/student/homework")}
              activeOpacity={0.8}
            >
              <Ionicons name="warning" size={18} color="#DC2626" />
              <Text style={s.urgentBannerText}>
                {homeworkStats.urgent} assignment{homeworkStats.urgent !== 1 ? "s" : ""} due very soon!
              </Text>
              <Text style={s.urgentBannerLink}>View →</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Pinned announcements */}
        {pinnedAnnouncements.length > 0 && (
          <View style={s.section}>
            <SectionHead
              title="📌 Pinned"
              action="All Announcements"
              onAction={() => router.push("/student/announcements")}
            />
            {pinnedAnnouncements.map((ann) => (
              <TouchableOpacity
                key={ann.id || ann._id}
                style={s.pinnedCard}
                onPress={() => router.push("/student/announcements")}
                activeOpacity={0.7}
              >
                <View style={s.pinnedIcon}>
                  <Ionicons name="megaphone" size={16} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.pinnedTitle} numberOfLines={1}>{ann.title}</Text>
                  <Text style={s.pinnedBody}  numberOfLines={2}>{ann.body}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Today's schedule */}
        <View style={s.section}>
          <SectionHead
            title="Today's Schedule"
            action="Full Timetable"
            onAction={() => router.push("/student/timetable")}
          />
          {todayClasses.length === 0 ? (
            <EmptyCard icon="calendar-outline" title="No classes today" subtitle="Enjoy your free day!" />
          ) : (
            todayClasses.slice(0, 7).map((item, idx) => {
              const isBreak = item.isbreak === 1 || item.isbreak === "1" || item.isBreak === true;
              return (
                <View key={item.id || idx} style={[s.ttCard, isBreak && s.ttCardBreak]}>
                  <View style={s.ttTime}>
                    <Text style={s.ttTimeStart}>{formatTime(item.startTime)}</Text>
                    <Text style={s.ttTimeSep}>–</Text>
                    <Text style={s.ttTimeEnd}>{formatTime(item.endTime)}</Text>
                  </View>
                  <View style={s.ttDivider} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.ttSubject, isBreak && s.ttSubjectBreak]} numberOfLines={1}>
                      {item.subjectName || item.periodName || (isBreak ? "Break" : "—")}
                    </Text>
                    {!isBreak && (
                      <Text style={s.ttMeta} numberOfLines={1}>
                        {[item.teacherName, item.room].filter(Boolean).join(" · ")}
                      </Text>
                    )}
                  </View>
                  {!isBreak && item.periodName && (
                    <View style={s.ttBadge}>
                      <Text style={s.ttBadgeText}>{item.periodName}</Text>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>

        {/* Quick access */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Quick Access</Text>
          <View style={s.actionsGrid}>
            {QUICK_ACTIONS.map((a) => {
              const hwBadge  = a.id === "homework"      && homeworkStats.pending > 0;
              const annBadge = a.id === "announcements" && unreadAnnouncements   > 0;
              const badgeNum = hwBadge ? homeworkStats.pending
                             : annBadge ? unreadAnnouncements : 0;
              return (
                <TouchableOpacity
                  key={a.id}
                  style={s.actionBtn}
                  onPress={() => router.push(a.route)}
                  activeOpacity={0.7}
                >
                  <View style={s.actionIconWrap}>
                    <View style={[s.actionIconBg, { backgroundColor: a.color + "15" }]}>
                      <Ionicons name={a.icon} size={22} color={a.color} />
                    </View>
                    {badgeNum > 0 && (
                      <View style={s.actionBadge}>
                        <Text style={s.actionBadgeText}>{badgeNum > 9 ? "9+" : badgeNum}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.actionTitle}>{a.title}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Homework */}
        <View style={s.section}>
          <SectionHead title="Homework" action="View All" onAction={() => router.push("/student/homework")} />
          {homework.length === 0 ? (
            <EmptyCard
              icon="document-text-outline"
              title="No homework assigned"
              subtitle="Check back when your teacher assigns work"
            />
          ) : (
            [...homework]
              .sort((a, b) => {
                const aU = getDueStatus(a.due_date).urgent && !a.submission_id;
                const bU = getDueStatus(b.due_date).urgent && !b.submission_id;
                if (aU && !bU) return -1;
                if (!aU && bU) return  1;
                if (!a.due_date) return  1;
                if (!b.due_date) return -1;
                return new Date(a.due_date) - new Date(b.due_date);
              })
              .slice(0, 4)
              .map((hw) => {
                const due    = getDueStatus(hw.due_date, hw.submission_submitted_at);
                const status = getHomeworkSubmissionStatus(hw);
                return (
                  <TouchableOpacity
                    key={hw.id}
                    style={[s.hwCard, due.urgent && !hw.submission_id && s.hwCardUrgent]}
                    onPress={() => router.push("/student/homework")}
                    activeOpacity={0.7}
                  >
                    <View style={[s.hwIconBg, { backgroundColor: status.color + "18" }]}>
                      <Ionicons name={status.icon} size={20} color={status.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.hwTitle} numberOfLines={1}>{hw.title}</Text>
                      <Text style={s.hwMeta}  numberOfLines={1}>
                        {[hw.subject_name, hw.class_name].filter(Boolean).join("  ·  ")}
                      </Text>
                      <View style={s.hwChipRow}>
                        <View style={[s.hwChip, { backgroundColor: due.bg }]}>
                          <Ionicons name="calendar-outline" size={10} color={due.color} />
                          <Text style={[s.hwChipText, { color: due.color }]}>{due.label}</Text>
                        </View>
                        <View style={[s.hwChip, { backgroundColor: status.color + "18" }]}>
                          <Text style={[s.hwChipText, { color: status.color }]}>{status.label}</Text>
                        </View>
                        {hw.submission_score != null && (
                          <View style={[s.hwChip, { backgroundColor: "#EEF2FF" }]}>
                            <Ionicons name="ribbon-outline" size={10} color="#4F46E5" />
                            <Text style={[s.hwChipText, { color: "#4F46E5" }]}>
                              {hw.submission_score}/{hw.max_score ?? 100}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <View style={s.hwScoreBox}>
                      <Text style={s.hwScoreValue}>{hw.max_score ?? 100}</Text>
                      <Text style={s.hwScoreLabel}>pts</Text>
                    </View>
                  </TouchableOpacity>
                );
              })
          )}
          {homework.length > 4 && (
            <TouchableOpacity
              style={s.seeMoreBtn}
              onPress={() => router.push("/student/homework")}
              activeOpacity={0.7}
            >
              <Text style={s.seeMoreText}>
                +{homework.length - 4} more assignment{homework.length - 4 !== 1 ? "s" : ""}
              </Text>
              <Ionicons name="chevron-forward" size={14} color="#4F46E5" />
            </TouchableOpacity>
          )}
        </View>

        {/* Available quizzes */}
        <View style={s.section}>
          <SectionHead
            title="Available Quizzes"
            action="See All"
            onAction={() => router.push("/student/quizzes")}
          />
          {availableQuizzes.length === 0 ? (
            <EmptyCard icon="help-circle-outline" title="No quizzes available" subtitle="Check back later for new quizzes" />
          ) : (
            availableQuizzes.map(({ quiz, status }) => (
              <TouchableOpacity
                key={quiz.id || quiz._id}
                style={s.quizCard}
                activeOpacity={0.7}
                onPress={() =>
                  router.push({
                    pathname: "/student/quizzes/attempt",
                    params: {
                      quizId:    quiz.id || quiz._id,
                      attemptId: status.resumeId || undefined,
                    },
                  })
                }
              >
                <View style={[s.quizIconBg, { backgroundColor: "#EEF2FF" }]}>
                  <Ionicons
                    name={status.resumeId ? "play-circle" : "help-circle"}
                    size={20}
                    color="#4F46E5"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.quizTitle} numberOfLines={1}>{quiz.title}</Text>
                  <Text style={s.quizMeta}  numberOfLines={1}>
                    {[
                      quiz.subject_name,
                      quiz.question_count     ? `${quiz.question_count} Q`       : null,
                      quiz.time_limit_minutes ? `${quiz.time_limit_minutes} min`  : null,
                    ].filter(Boolean).join(" · ")}
                  </Text>
                  {quiz.max_attempts != null && (
                    <Text style={s.quizAttemptInfo}>
                      {status.attempts}/{quiz.max_attempts} attempts
                      {status.best != null ? `  ·  Best: ${Math.round(status.best)}%` : ""}
                    </Text>
                  )}
                </View>
                <View style={s.quizStartBtn}>
                  <Text style={s.quizStartText}>{status.resumeId ? "Resume" : "Start"}</Text>
                  <Ionicons name="play" size={12} color="#FFF" />
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* My subjects */}
        <View style={s.section}>
          <SectionHead
            title="My Subjects"
            action="View All"
            onAction={() => router.push("/student/subjects")}
          />
          {subjects.length === 0 ? (
            <EmptyCard icon="book-outline" title="No subjects found" subtitle="Subjects will appear after sync" />
          ) : (
            <View style={s.subjectsGrid}>
              {subjects.slice(0, 6).map((subj, idx) => {
                const palette = ["#4F46E5","#059669","#D97706","#DC2626","#7C3AED","#DB2777"];
                const color   = palette[idx % palette.length];
                return (
                  <TouchableOpacity
                    key={subj.id}
                    style={s.subjectChip}
                    activeOpacity={0.7}
                    onPress={() =>
                      router.push({
                        pathname: "/student/subjects/detail",
                        params: { subjectId: subj.id, subjectName: subj.name },
                      })
                    }
                  >
                    <View style={[s.subjectDot, { backgroundColor: color }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.subjectName} numberOfLines={1}>{subj.name}</Text>
                      {subj.teacherName && (
                        <Text style={s.subjectTeacher} numberOfLines={1}>{subj.teacherName}</Text>
                      )}
                    </View>
                    {subj.code && <Text style={s.subjectCode}>{subj.code}</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* Recent quiz results */}
        {quizHistory.length > 0 && (
          <View style={s.section}>
            <SectionHead
              title="Recent Quiz Results"
              action="History"
              onAction={() => router.push("/student/quizzes/history")}
            />
            {quizHistory.slice(0, 4).map((attempt) => (
              <View key={attempt.id} style={s.resultCard}>
                <View style={[
                  s.resultScoreBg,
                  { backgroundColor: attempt.is_passed ? "#ECFDF5" : "#FEF2F2" },
                ]}>
                  <Text style={[
                    s.resultScore,
                    { color: attempt.is_passed ? "#059669" : "#DC2626" },
                  ]}>
                    {Math.round(attempt.percentage || 0)}%
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.resultTitle} numberOfLines={1}>
                    {attempt.quizTitle || attempt.title}
                  </Text>
                  <Text style={s.resultMeta}>
                    {[
                      attempt.subjectName || attempt.subject_name,
                      attempt.is_passed ? "Passed ✓" : "Not passed",
                    ].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Results section — links to /student/results ───────────────── */}
        <View style={s.section}>
          <SectionHead
            title="Exam Results"
            action="View All"
            onAction={() => router.push("/student/results")}
          />
          <TouchableOpacity
            style={s.resultsCard}
            onPress={() => router.push("/student/results")}
            activeOpacity={0.7}
          >
            <View style={s.resultsIconBg}>
              <Ionicons name="document-text-outline" size={24} color="#2563EB" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.resultsCardTitle}>My Report Cards</Text>
              <Text style={s.resultsCardSub}>
                View your exam results and report cards
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        </View>

        {/* Announcements (non-pinned) */}
        {recentAnnouncements.length > 0 && (
          <View style={s.section}>
            <SectionHead
              title="Announcements"
              action="See All"
              onAction={() => router.push("/student/announcements")}
            />
            {recentAnnouncements.map((ann) => (
              <TouchableOpacity
                key={ann.id || ann._id}
                style={[s.annCard, !ann.isRead && s.annCardUnread]}
                onPress={() => router.push("/student/announcements")}
                activeOpacity={0.7}
              >
                {!ann.isRead && <View style={s.annUnreadDot} />}
                <View style={s.annDot} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.annTitle, !ann.isRead && s.annTitleUnread]} numberOfLines={1}>
                    {ann.title}
                  </Text>
                  <Text style={s.annBody}  numberOfLines={2}>{ann.body}</Text>
                  {ann.authorName && (
                    <Text style={s.annAuthor}>— {ann.authorName}</Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={16} color="#D1D5DB" />
              </TouchableOpacity>
            ))}
            {storeInbox.filter((a) => !a.isPinned).length > 3 && (
              <TouchableOpacity
                style={s.seeMoreBtn}
                onPress={() => router.push("/student/announcements")}
                activeOpacity={0.7}
              >
                <Text style={s.seeMoreText}>
                  +{storeInbox.filter((a) => !a.isPinned).length - 3} more
                </Text>
                <Ionicons name="chevron-forward" size={14} color="#4F46E5" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Logout */}
        <TouchableOpacity
          style={s.logoutBtn}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={18} color="#DC2626" />
          <Text style={s.logoutText}>Logout</Text>
        </TouchableOpacity>

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 56, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
    gap: 8,
  },
  greeting: { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  userName:  { fontSize: 22, fontWeight: "700", color: "#111827", marginTop: 2 },

  profileIncompleteBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "#FEF3C7",
    alignItems: "center", justifyContent: "center",
  },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
    position: "relative",
  },
  headerBadge: {
    position: "absolute", top: 6, right: 6,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: "#DC2626",
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 2,
    borderWidth: 1.5, borderColor: "#FFF",
  },
  headerBadgeText: { fontSize: 9, fontWeight: "800", color: "#FFF" },
  avatarCircle: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#C7D2FE",
  },
  avatarText: { fontSize: 18, fontWeight: "700", color: "#4F46E5" },

  profileSetupBanner: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#D97706",
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    borderRadius: 14, padding: 14, gap: 12,
  },
  profileSetupIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  profileSetupTitle: { fontSize: 14, fontWeight: "700", color: "#FFF" },
  profileSetupSub:   { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 2 },

  scroll:     { paddingTop: 4 },
  dateBanner: {
    flexDirection: "row", alignItems: "center",
    gap: 6, paddingHorizontal: 20, paddingVertical: 10,
  },
  dateText: { fontSize: 13, color: "#6B7280", fontWeight: "500" },

  statsRow: {
    flexDirection: "row", paddingHorizontal: 20, gap: 10, marginBottom: 20,
  },
  statCard: {
    flex: 1, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center",
  },
  statIconBg: {
    width: 32, height: 32, borderRadius: 10,
    alignItems: "center", justifyContent: "center", marginBottom: 6,
  },
  statValue: { fontSize: 19, fontWeight: "800" },
  statLabel: { fontSize: 10, fontWeight: "600", color: "#6B7280", marginTop: 2 },

  section:       { paddingHorizontal: 20, marginBottom: 20 },
  sectionHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 12,
  },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  seeAll:       { fontSize: 13, color: "#4F46E5", fontWeight: "600" },

  emptyCard: {
    backgroundColor: "#FFF", borderRadius: 12, padding: 24,
    alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: "#F3F4F6",
  },
  emptyCardTitle: { fontSize: 14, fontWeight: "600", color: "#6B7280" },
  emptyCardSub:   { fontSize: 12, color: "#9CA3AF" },

  urgentBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#FEE2E2", borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: "#FECACA",
  },
  urgentBannerText: { flex: 1, fontSize: 13, color: "#DC2626", fontWeight: "600" },
  urgentBannerLink: { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  pinnedCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FEF2F2", borderRadius: 12, padding: 12,
    marginBottom: 8, gap: 10,
    borderWidth: 1, borderColor: "#FECACA",
  },
  pinnedIcon: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: "#FEE2E2",
    alignItems: "center", justifyContent: "center",
  },
  pinnedTitle: { fontSize: 13, fontWeight: "700", color: "#991B1B" },
  pinnedBody:  { fontSize: 12, color: "#B91C1C", marginTop: 2 },

  ttCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 6, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  ttCardBreak:    { backgroundColor: "#FFFBEB", borderWidth: 1, borderColor: "#FDE68A" },
  ttTime:         { width: 60, alignItems: "center" },
  ttTimeStart:    { fontSize: 11, fontWeight: "700", color: "#4F46E5" },
  ttTimeSep:      { fontSize: 9,  color: "#C7D2FE" },
  ttTimeEnd:      { fontSize: 10, color: "#9CA3AF" },
  ttDivider:      { width: 3, height: 36, borderRadius: 2, backgroundColor: "#E0E7FF" },
  ttSubject:      { fontSize: 14, fontWeight: "600", color: "#111827" },
  ttSubjectBreak: { color: "#D97706", fontStyle: "italic" },
  ttMeta:         { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  ttBadge: {
    backgroundColor: "#F3F4F6", borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  ttBadgeText: { fontSize: 10, fontWeight: "700", color: "#6B7280" },

  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  actionBtn: {
    width: "23%", backgroundColor: "#FFF", borderRadius: 14, paddingVertical: 12,
    alignItems: "center",
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  actionIconWrap: { position: "relative", marginBottom: 6 },
  actionIconBg: {
    width: 42, height: 42, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  actionBadge: {
    position: "absolute", top: -4, right: -4,
    minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: "#DC2626",
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 3,
  },
  actionBadgeText: { fontSize: 10, fontWeight: "800", color: "#FFF" },
  actionTitle:     { fontSize: 10, fontWeight: "600", color: "#374151", textAlign: "center" },

  hwCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 8, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  hwCardUrgent: { borderWidth: 1, borderColor: "#FECACA", backgroundColor: "#FFFAFA" },
  hwIconBg: {
    width: 38, height: 38, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  hwTitle:   { fontSize: 14, fontWeight: "600", color: "#111827" },
  hwMeta:    { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  hwChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 5 },
  hwChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
  },
  hwChipText:   { fontSize: 10, fontWeight: "600" },
  hwScoreBox:   { alignItems: "center", minWidth: 32 },
  hwScoreValue: { fontSize: 15, fontWeight: "800", color: "#374151" },
  hwScoreLabel: { fontSize: 9, color: "#9CA3AF", fontWeight: "500" },

  seeMoreBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 4, paddingVertical: 10,
    backgroundColor: "#EEF2FF", borderRadius: 10,
  },
  seeMoreText: { fontSize: 13, fontWeight: "600", color: "#4F46E5" },

  quizCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 8, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  quizIconBg: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  quizTitle:       { fontSize: 14, fontWeight: "600", color: "#111827" },
  quizMeta:        { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  quizAttemptInfo: { fontSize: 10, color: "#D97706", marginTop: 2, fontWeight: "600" },
  quizStartBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#4F46E5", borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  quizStartText: { fontSize: 12, fontWeight: "700", color: "#FFF" },

  subjectsGrid: { gap: 6 },
  subjectChip: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.02, shadowRadius: 2, elevation: 1,
  },
  subjectDot:     { width: 8, height: 8, borderRadius: 4 },
  subjectName:    { fontSize: 14, fontWeight: "600", color: "#111827" },
  subjectTeacher: { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  subjectCode: {
    fontSize: 10, fontWeight: "700", color: "#9CA3AF",
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },

  resultCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 6, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.02, shadowRadius: 2, elevation: 1,
  },
  resultScoreBg: {
    width: 46, height: 46, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  resultScore: { fontSize: 15, fontWeight: "800" },
  resultTitle: { fontSize: 14, fontWeight: "600", color: "#111827" },
  resultMeta:  { fontSize: 11, color: "#9CA3AF", marginTop: 2 },

  // Results card (exam results shortcut)
  resultsCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12, padding: 14, gap: 12,
    borderWidth: 1, borderColor: "#DBEAFE",
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  resultsIconBg: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: "#EFF6FF",
    alignItems: "center", justifyContent: "center",
  },
  resultsCardTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  resultsCardSub:   { fontSize: 12, color: "#6B7280", marginTop: 2 },

  annCard: {
    flexDirection: "row", alignItems: "flex-start",
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginBottom: 6, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.02, shadowRadius: 2, elevation: 1,
    position: "relative", overflow: "hidden",
  },
  annCardUnread:  { borderLeftWidth: 3, borderLeftColor: "#4F46E5", backgroundColor: "#FAFAFF" },
  annUnreadDot: {
    position: "absolute", top: 8, right: 8,
    width: 8, height: 8, borderRadius: 4, backgroundColor: "#4F46E5",
  },
  annDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: "#4F46E5", marginTop: 4,
  },
  annTitle:       { fontSize: 14, fontWeight: "600", color: "#111827" },
  annTitleUnread: { fontWeight: "800" },
  annBody:        { fontSize: 12, color: "#6B7280", marginTop: 2, lineHeight: 18 },
  annAuthor:      { fontSize: 11, color: "#9CA3AF", marginTop: 4, fontStyle: "italic" },

  logoutBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    marginHorizontal: 20, backgroundColor: "#FEE2E2",
    paddingVertical: 14, borderRadius: 12, gap: 8, marginTop: 4,
  },
  logoutText: { color: "#DC2626", fontWeight: "600", fontSize: 15 },
});