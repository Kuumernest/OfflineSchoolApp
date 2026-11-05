// app/teacher/dashboard.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Image,
} from "react-native";
import { useRouter }            from "expo-router";
import { Ionicons }             from "@expo/vector-icons";
import { useAuthStore }         from "../../src/store/auth.store";
import { useSafeLogout }        from "../../src/hooks/useSafeLogout";
import { getTeacherStats }      from "../../src/services/teacherStats.service";
import { getSchoolInfo }        from "../../src/services/school.service";
import { isTeacherProfileComplete } from "./profile/setup";
import { useAnnouncementStore } from "../../src/store/announcement.store";
import { toDisplayUri }        from "../../src/utils/logoUri";
import { useTranslation }      from "../../src/i18n/useTranslation";
import { reminderMessageKey, reminderRoute } from "../../src/utils/attendanceReminders";
import { StatTile, ActionTile, TileIcon } from "../../src/components/Tiles";
import { COLORS, SEMANTIC }    from "../../src/theme/colors";

// ─────────────────────────────────────────────────────────────────────────────
// STATIC DATA
// ─────────────────────────────────────────────────────────────────────────────

// The one primary action is taking attendance: the task every teacher does
// every day: it is highlighted (blue border, ringed icon), not filled. Every
// shortcut is a tinted tile in its kind's colour.
const buildQuickActions = (t) => [
  { id: "my-exams",        title: t("teacherHome.qaMyExams"),        icon: "trophy-outline",        route: "/teacher/exams", kind: "exams" },
  { id: "enter-marks",     title: t("teacherHome.qaEnterMarks"),     icon: "create-outline",        route: "/teacher/exams?filter=pending-marks", kind: "marks" },
  { id: "upload-notes",    title: t("teacherHome.qaUploadNotes"),    icon: "document-text-outline", route: "/teacher/content/upload-notes", kind: "content" },
  { id: "create-quiz",     title: t("teacherHome.qaCreateQuiz"),     icon: "help-circle-outline",   route: "/teacher/quizzes/create", kind: "quizzes" },
  { id: "assign-homework", title: t("teacherHome.qaAssignHomework"), icon: "clipboard-outline",     route: "/teacher/homework/create", kind: "homework" },
  { id: "mark-attendance", title: t("teacherHome.qaAttendance"),     icon: "checkbox-outline",      route: "/teacher/attendance", primary: true, kind: "attendance" },
  { id: "announce",        title: t("teacherHome.qaAnnounce"),       icon: "megaphone-outline",     route: "/teacher/announcements/create", kind: "announcements" },
  { id: "messages",        title: t("teacherHome.qaMessages"),       icon: "chatbubbles-outline",   route: "/messages", kind: "messages" },
];

const buildModules = (t) => [
  { id: "exams",         title: t("teacherHome.modExamsTitle"),         icon: "trophy-outline",        kind: "exams",    route: "/teacher/exams",         description: t("teacherHome.modExamsDesc"),         badge: "marks"         },
  { id: "subjects",      title: t("teacherHome.modSubjectsTitle"),      icon: "book-outline",          kind: "subjects", route: "/teacher/subjects",      description: t("teacherHome.modSubjectsDesc")                              },
  { id: "content",       title: t("teacherHome.modContentTitle"),       icon: "folder-outline",        kind: "content",  route: "/teacher/content",       description: t("teacherHome.modContentDesc")                               },
  { id: "quizzes",       title: t("teacherHome.modQuizzesTitle"),       icon: "help-circle-outline",   kind: "quizzes",  route: "/teacher/quizzes",       description: t("teacherHome.modQuizzesDesc")                               },
  { id: "homework",      title: t("teacherHome.modHomeworkTitle"),      icon: "create-outline",        kind: "homework", route: "/teacher/homework",      description: t("teacherHome.modHomeworkDesc")                              },
  { id: "results",       title: t("teacherHome.modResultsTitle"),       icon: "bar-chart-outline",     kind: "results",  route: "/teacher/results",       description: t("teacherHome.modResultsDesc")                               },
  // Reading the guidance needs a connection; recording what you decided to do
  // about it does not — the writer goes through the outbox like every other
  // mutation on this handset.
  { id: "intelligence",  title: t("teacherHome.modIntelligenceTitle"),  icon: "bulb-outline",          kind: "intelligence", route: "/teacher/intelligence",  description: t("teacherHome.modIntelligenceDesc")                          },
  { id: "attendance",    title: t("teacherHome.modAttendanceTitle"),    icon: "calendar-outline",      kind: "attendance", route: "/teacher/attendance",    description: t("teacherHome.modAttendanceDesc")                            },
  { id: "timetable",     title: t("teacherHome.modTimetableTitle"),     icon: "time-outline",          kind: "timetable", route: "/teacher/timetable",     description: t("teacherHome.modTimetableDesc")                             },
  { id: "announcements", title: t("teacherHome.modAnnouncementsTitle"), icon: "megaphone-outline",     kind: "announcements", route: "/teacher/announcements", description: t("teacherHome.modAnnouncementsDesc"), badge: "announcements" },
];

const ALERT_STYLES = {
  danger:  { bg: SEMANTIC.error.box, icon: COLORS.danger, text: SEMANTIC.error.text },
  warning: { bg: SEMANTIC.warning.box, icon: COLORS.warning, text: SEMANTIC.warning.text },
  info:    { bg: SEMANTIC.info.box, icon: COLORS.info, text: SEMANTIC.info.text },
  success: { bg: SEMANTIC.success.bg, icon: COLORS.success, text: SEMANTIC.success.text },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getGreeting = (t) => {
  const hour = new Date().getHours();
  if (hour < 12) return t("teacherHome.greetingMorning");
  if (hour < 17) return t("teacherHome.greetingAfternoon");
  return t("teacherHome.greetingEvening");
};

const computeSlotStatus = (startTime, endTime) => {
  if (!startTime && !endTime) return "upcoming";

  const timeToMinutes = (t) => {
    if (!t) return 0;
    const match = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!match) return 0;
    let hours   = parseInt(match[1], 10);
    const mins  = parseInt(match[2], 10);
    const ampm  = (match[3] || "").toUpperCase();
    if (ampm === "PM" && hours !== 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours  = 0;
    return hours * 60 + mins;
  };

  const now        = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin   = timeToMinutes(startTime);
  const endMin     = timeToMinutes(endTime);

  if (endMin > 0   && currentMin > endMin)                            return "past";
  if (startMin > 0 && currentMin >= startMin && currentMin <= endMin) return "current";
  return "upcoming";
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL BANNER
// ─────────────────────────────────────────────────────────────────────────────

const SchoolBanner = React.memo(({ school }) => {
  if (!school?.name) return null;

  const location = [school.city, school.country].filter(Boolean).join(", ");

  // Prefers the locally cached file, so the logo still shows offline now that
  // the server sends a URL rather than inline base64. The old inline version
  // of this also mis-typed "/uploads/…" paths as base64.
  const logoUri  = toDisplayUri(school.logoLocal, school.logo);
  const hasLogo  = !!logoUri;

  return (
    <View style={sb.banner}>
      {hasLogo && logoUri ? (
        <Image source={{ uri: logoUri }} style={sb.logo} resizeMode="contain" />
      ) : (
        <View style={sb.logoFallback}>
          <Ionicons name="school" size={20} color={COLORS.contextIcon} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={sb.schoolName} numberOfLines={1}>{school.name}</Text>
        {!!location && (
          <Text style={sb.location} numberOfLines={1}>
            <Ionicons name="location-outline" size={11} color={COLORS.contextText} />
            {" "}{location}
          </Text>
        )}
        {!!school.motto && (
          <Text style={sb.motto} numberOfLines={1}>"{school.motto}"</Text>
        )}
      </View>
    </View>
  );
});

// The school context bar: a light blue band, the same on every dashboard.
const sb = StyleSheet.create({
  banner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   COLORS.contextBg,
    marginHorizontal:  16,
    marginTop:         12,
    marginBottom:      4,
    borderRadius:      14,
    paddingHorizontal: 14,
    paddingVertical:   12,
    gap:               12,
    borderWidth:       1,
    borderColor:       COLORS.contextBorder,
  },
  logo:        { width: 44, height: 44, borderRadius: 10, backgroundColor: COLORS.surface },
  logoFallback: {
    width:           44,
    height:          44,
    borderRadius:    10,
    backgroundColor: COLORS.surface,
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     1,
    borderColor:     COLORS.contextBorder,
  },
  schoolName: { fontSize: 14, fontWeight: "700", color: COLORS.contextText },
  location:   { fontSize: 11, color: COLORS.contextText, marginTop: 2 },
  motto:      { fontSize: 11, color: COLORS.contextText, fontStyle: "italic", marginTop: 2, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function TeacherDashboard() {
  const router = useRouter();
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);
  const safeLogout = useSafeLogout();

  // ✅ Primitive string deps — prevents infinite loop from object ref changes
  const teacherId = useAuthStore((s) =>
    s.user?._id || s.user?.id || s.user?.userId || null
  );
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? null);

  const storeProfileCompleted = useAuthStore((s) => s.profileCompleted);

  const fetchAllAnnouncements = useAnnouncementStore((s) => s.fetchAll);
  const announcementStats     = useAnnouncementStore((s) => s.stats);

  // ✅ Reactive unread count
  const announcementUnread = useAnnouncementStore((s) => s.unreadCount);
  const urgentUnack        = announcementStats?.urgentUnack ?? 0;

  const [stats,           setStats]           = useState(null);
  const [school,          setSchool]          = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState(null);
  const [refreshing,      setRefreshing]      = useState(false);

  // ✅ FIX: Initialise to `null` (unknown) so we don't flash incomplete
  //    state before the async check resolves. Only show the banner/redirect
  //    once we know for certain the profile is incomplete.
  const [profileComplete, setProfileComplete] = useState(
    storeProfileCompleted === true ? true : null
  );

  // ✅ FIX: Key the ref by teacherId so it resets when the user changes
  //    but does NOT reset on every re-render (unlike putting the flag in state).
  //    We store the last-checked teacherId so we can detect identity changes.
  const profileCheckedForId = useRef(null);

  // ✅ FIX: Stable ref for the `user` object so fetchAllAnnouncements
  //    always receives the latest user without being listed as a dep.
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // ── Load teacher stats + school info ──────────────────────────────────────
  const loadStats = useCallback(async (isRefresh = false) => {
    if (!teacherId) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      if (!isRefresh) await new Promise((r) => setTimeout(r, 50));

      const [data, schoolData] = await Promise.all([
        getTeacherStats(teacherId),
        getSchoolInfo(schoolId),
      ]);

      setStats(data);
      if (schoolData) setSchool(schoolData);
    } catch (err) {
      console.error("Failed to load teacher stats:", err);
      setError(t("teacherHome.loadError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, schoolId, t]);

  // ── Load stats on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (!teacherId) { setLoading(false); return; }
    loadStats();
  }, [loadStats]);

  // ── Load announcements on mount ───────────────────────────────────────────
  // ✅ FIX: Use userRef.current so this effect only fires when teacherId
  //    changes, never because the user object reference changed.
  useEffect(() => {
    if (!teacherId) return;
    fetchAllAnnouncements(userRef.current).catch((err) =>
      console.warn("Announcement fetch failed:", err.message)
    );
    // fetchAllAnnouncements is a stable Zustand action — safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId]);

  // ── Profile completion check ──────────────────────────────────────────────
  // ✅ FIX: Gate on profileCheckedForId so the check runs once per unique
  //    teacherId. If the store already says complete we short-circuit.
  //    Crucially we do NOT auto-redirect — we only set state so the banner
  //    shows and the teacher can choose to navigate themselves.  This breaks
  //    the mount → redirect → remount → redirect loop caused by "Skip".
  useEffect(() => {
    if (!teacherId) return;

    // Store flipped to true (e.g. after setup completed) — trust it.
    if (storeProfileCompleted === true) {
      setProfileComplete(true);
      profileCheckedForId.current = teacherId;
      return;
    }

    // Already ran the async check for this exact teacher — don't repeat.
    if (profileCheckedForId.current === teacherId) return;
    profileCheckedForId.current = teacherId;

    const checkProfile = async () => {
      try {
        const complete = await isTeacherProfileComplete(teacherId);
        setProfileComplete(complete);

        if (complete) {
          useAuthStore.getState().setProfileCompleted?.(true);
        }
        // ✅ FIX: Removed the auto-redirect (`router.push`) entirely.
        //    The in-dashboard banner + header warning icon are sufficient
        //    prompts. Auto-redirecting after "Skip" caused an infinite
        //    remount loop:
        //      dashboard mounts → redirect to setup → teacher skips →
        //      setup navigates back → dashboard remounts → redirect again…
        //
        //    If you still want a one-time redirect on first-ever login you
        //    should gate it on a persistent flag (AsyncStorage / auth store)
        //    that survives navigation, NOT on component mount.
      } catch (err) {
        console.warn("Profile check failed:", err.message);
        // ✅ FIX: Default to `true` (complete) on error so we never get
        //    stuck in an incomplete-profile redirect loop due to a network
        //    hiccup.
        setProfileComplete(true);
      }
    };

    checkProfile();
    // router intentionally omitted — we no longer redirect from here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, storeProfileCompleted]);

  // ── Alerts ────────────────────────────────────────────────────────────────
  // ✅ FIX: Treat `null` (unknown) as complete so no spurious alert flashes
  //    during the async profile check.
  const isProfileIncomplete = profileComplete === false;

  const alerts = useMemo(() => {
    const list = [];

    if (stats) {
      if (stats.pendingMarksEntry > 0)     list.push({ id: "pending-marks",      type: "danger",  icon: "create-outline",           message: t("teacherHome.alertPendingMarks", { count: stats.pendingMarksEntry }),                route: "/teacher/exams?filter=pending-marks" });
      if (stats.rejectedSubmissions > 0)   list.push({ id: "rejected-marks",     type: "danger",  icon: "alert-circle-outline",     message: t("teacherHome.alertRejectedMarks", { count: stats.rejectedSubmissions }),  route: "/teacher/exams?filter=rejected"      });
      if (stats.pendingGrading > 0)        list.push({ id: "pending-grading",    type: "warning", icon: "clipboard-outline",        message: t("teacherHome.alertPendingGrading", { count: stats.pendingGrading }),                                                             route: "/teacher/results"                    });
      if (stats.upcomingDeadlines > 0)     list.push({ id: "deadlines",          type: "info",    icon: "alarm-outline",            message: t("teacherHome.alertDeadlines", { count: stats.upcomingDeadlines }),                                                         route: "/teacher/homework"                   });
      if (stats.upcomingExams > 0)         list.push({ id: "exams",              type: "warning", icon: "school-outline",           message: t("teacherHome.alertUpcomingExams", { count: stats.upcomingExams }),                                                                route: "/teacher/exams"                      });
      // One reminder per class without a register, each opening THAT class's
      // register for the day. The single count used to open the register
      // screen with no class — an empty screen headed "Class".
      const reminders = Array.isArray(stats.todayAttendanceReminders) ? stats.todayAttendanceReminders : [];
      for (const r of reminders) {
        const time = r.status === "past" ? (r.endTime || "") : (r.startTime || "");
        list.push({
          id:      `attendance-${r.classId}-${r.date}`,
          type:    r.status === "upcoming" ? "warning" : "danger",
          icon:    "alert-circle-outline",
          message: t(time ? reminderMessageKey(r.status) : "teacherHome.attendanceReminderNoTime", {
            className:   r.className   || t("teacherHome.classFallback"),
            subjectName: r.subjectName || t("teacherHome.subjectFallback"),
            time,
          }),
          route: reminderRoute(r),
        });
      }
      // A count with no classes behind it (an older server, no timetable on
      // the phone): the list of classes, where each can be chosen.
      if (!reminders.length && stats.todayAttendanceMissing > 0) {
        list.push({ id: "missing-attendance", type: "danger", icon: "alert-circle-outline", message: t("teacherHome.alertMissingAttendance", { count: stats.todayAttendanceMissing }), route: "/teacher/attendance" });
      }
      if (stats.newSubmissions > 0)        list.push({ id: "new-submissions",    type: "success", icon: "checkmark-circle-outline", message: t("teacherHome.alertNewSubmissions", { count: stats.newSubmissions }),           route: "/teacher/homework"                   });
    }

    if (isProfileIncomplete)    list.push({ id: "profile-incomplete",   type: "warning", icon: "person-outline",    message: t("teacherHome.alertProfileIncomplete"),                                                                       route: "/teacher/profile/setup" });
    if (urgentUnack > 0)        list.push({ id: "urgent-announcements", type: "danger",  icon: "megaphone-outline", message: t("teacherHome.alertUrgentAnnouncements", { count: urgentUnack }),     route: "/teacher/announcements" });
    if (announcementUnread > 0) list.push({ id: "unread-announcements", type: "info",    icon: "megaphone-outline", message: t("teacherHome.alertUnreadAnnouncements", { count: announcementUnread }),                                            route: "/teacher/announcements" });

    return list;
  }, [stats, isProfileIncomplete, announcementUnread, urgentUnack, t]);

  const quickActions = useMemo(() => buildQuickActions(t), [t]);
  const annTone = SEMANTIC[urgentUnack > 0 ? "error" : "info"];
  const modules      = useMemo(() => buildModules(t),      [t]);

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleNav = useCallback((route) => {
    try { router.push(route); }
    catch (err) { console.error(`Nav error ${route}:`, err); }
  }, [router]);

  // Warns first when this account has changes not yet sent.
  const handleLogout = useCallback(() => safeLogout(), [safeLogout]);

  // ✅ FIX: Use userRef so onRefresh is stable and does NOT re-create when
  //    the user object reference changes — which was causing extra renders.
  const onRefresh = useCallback(() => {
    loadStats(true);
    fetchAllAnnouncements(userRef.current).catch(() => {});
  }, [loadStats, fetchAllAnnouncements]);

  if (!teacherId) return null;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>{t("teacherHome.loading")}</Text>
      </View>
    );
  }

  const todayClasses  = stats?.todayClasses || [];
  const upcomingCount = todayClasses.filter(
    (c) => (c.status || computeSlotStatus(c.startTime, c.endTime)) === "upcoming"
  ).length;
  const pastCount = todayClasses.filter(
    (c) => (c.status || computeSlotStatus(c.startTime, c.endTime)) === "past"
  ).length;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{getGreeting(t)},</Text>
          <Text style={styles.userName} numberOfLines={1}>{user?.name || t("teacherHome.teacherFallback")}</Text>
          <Text style={styles.subtitle}>{t("teacherHome.subtitle")}</Text>
        </View>

        <View style={styles.headerActions}>
          {/* ✅ FIX: Only show warning icon when we know for certain
               the profile is incomplete (not during the null/loading phase) */}
          {isProfileIncomplete && (
            <TouchableOpacity
              style={styles.profileIncompleteBtn}
              onPress={() => handleNav("/teacher/profile/setup")}
              activeOpacity={0.7}
            >
              <Ionicons name="alert-circle" size={16} color={COLORS.warning} />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.7}
          >
            <Ionicons name="megaphone-outline" size={20} color={SEMANTIC.info.icon} />
            {announcementUnread > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>
                  {announcementUnread > 9 ? "9+" : announcementUnread}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => handleNav("/teacher/settings")}
            activeOpacity={0.7}
          >
            <Ionicons name="settings-outline" size={22} color={COLORS.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.profileButton}
            onPress={() => handleNav("/teacher/profile/setup")}
            activeOpacity={0.7}
          >
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarText}>
                {(user?.name || "T").trim().split(/\s+/).filter(Boolean)
                  .map((w) => w[0].toUpperCase()).slice(0, 2).join("")}
              </Text>
              {/* ✅ FIX: Only show green dot when definitively complete */}
              {profileComplete === true && <View style={styles.avatarDot} />}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
      >
        <SchoolBanner school={school} />

        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={18} color={COLORS.danger} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => loadStats()}>
              <Text style={styles.retryText}>{t("teacherHome.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ✅ FIX: Only render when definitively incomplete */}
        {isProfileIncomplete && (
          <TouchableOpacity
            style={styles.profileSetupBanner}
            onPress={() => handleNav("/teacher/profile/setup")}
            activeOpacity={0.8}
          >
            <View style={styles.profileSetupIcon}>
              <Ionicons name="person-add-outline" size={22} color={SEMANTIC.warning.icon} />
            </View>
            <View style={styles.profileSetupText}>
              <Text style={styles.profileSetupTitle}>{t("teacherHome.profileBannerTitle")}</Text>
              <Text style={styles.profileSetupSub}>
                {t("teacherHome.profileBannerSub")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={SEMANTIC.warning.icon} />
          </TouchableOpacity>
        )}

        {(announcementUnread > 0 || urgentUnack > 0) && (
          <TouchableOpacity
            style={[
              styles.announcementBanner,
              { backgroundColor: annTone.bg, borderColor: annTone.box },
            ]}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.8}
          >
            <View style={[styles.announcementBannerIcon, { backgroundColor: annTone.box }]}>
              <Ionicons
                name={urgentUnack > 0 ? "warning" : "megaphone"}
                size={24}
                color={annTone.icon}
              />
            </View>
            <View style={styles.announcementBannerText}>
              <Text style={[styles.announcementBannerTitle, { color: annTone.text }]}>
                {urgentUnack > 0
                  ? t("teacherHome.annBannerUrgentTitle")
                  : t("teacherHome.annBannerNewTitle")}
              </Text>
              <Text style={[styles.announcementBannerSub, { color: annTone.text }]}>
                {urgentUnack > 0
                  ? t("teacherHome.annBannerUrgentSub", { count: urgentUnack })
                  : t("teacherHome.annBannerUnreadSub", { count: announcementUnread })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={annTone.icon} />
          </TouchableOpacity>
        )}

        {(stats?.pendingMarksEntry > 0 || stats?.rejectedSubmissions > 0) && (
          <TouchableOpacity
            style={styles.marksBanner}
            onPress={() => handleNav("/teacher/exams?filter=pending-marks")}
            activeOpacity={0.8}
          >
            <View style={styles.marksBannerIcon}>
              <Ionicons name="create" size={24} color={SEMANTIC.error.icon} />
            </View>
            <View style={styles.marksBannerText}>
              <Text style={styles.marksBannerTitle}>{t("teacherHome.marksBannerTitle")}</Text>
              <Text style={styles.marksBannerSub}>
                {stats?.pendingMarksEntry > 0
                  ? t("teacherHome.marksBannerPending", { count: stats.pendingMarksEntry })
                  : ""}
                {stats?.rejectedSubmissions > 0
                  ? ` · ${t("teacherHome.marksBannerRejected", { count: stats.rejectedSubmissions })}`
                  : ""}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={SEMANTIC.error.icon} />
          </TouchableOpacity>
        )}

        {/* ── TEACHING OVERVIEW ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teacherHome.sectionOverview")}</Text>

          <View style={styles.statsRow}>
            <StatTile kind="subjects"  icon="book"   value={stats?.assignedSubjects ?? 0} label={t("teacherHome.statSubjects")} />
            <StatTile kind="classes"   icon="school" value={stats?.assignedClasses  ?? 0} label={t("teacherHome.statClasses")} />
            <StatTile kind="students"  icon="people" value={stats?.totalStudents    ?? 0} label={t("teacherHome.statStudents")} />
            <StatTile kind="timetable" icon="time"   value={stats?.todayClassCount  ?? 0} label={t("teacherHome.statToday")} />
          </View>

          <View style={styles.statsRow}>
            <StatTile kind="exams" icon="trophy" value={stats?.activeExams ?? 0} label={t("teacherHome.statActiveExams")} />
            <StatTile
              kind="marks"
              icon="create"
              value={stats?.pendingMarksEntry ?? 0}
              label={t("teacherHome.statPendingMarks")}
              tone={(stats?.pendingMarksEntry ?? 0) > 0 ? "warning" : undefined}
              onPress={() =>
                (stats?.pendingMarksEntry ?? 0) > 0 &&
                handleNav("/teacher/exams?filter=pending-marks")
              }
            />
            <StatTile kind="marks" icon="time"             value={stats?.submittedMarks ?? 0} label={t("teacherHome.statSubmitted")} />
            <StatTile kind="marks" icon="checkmark-circle" value={stats?.approvedMarks  ?? 0} label={t("teacherHome.statApproved")} />
          </View>

          <View style={styles.statsRow}>
            <StatTile kind="content"  icon="folder"       value={stats?.contentUploads ?? 0} label={t("teacherHome.statContent")} />
            <StatTile kind="quizzes"  icon="help-circle"  value={stats?.activeQuizzes  ?? 0} label={t("teacherHome.statQuizzes")} />
            <StatTile kind="homework" icon="create"       value={stats?.activeHomework ?? 0} label={t("teacherHome.statHomework")} />
            <StatTile kind="homework" icon="alert-circle" value={stats?.pendingGrading ?? 0} label={t("teacherHome.statToGrade")}
              tone={(stats?.pendingGrading ?? 0) > 0 ? "warning" : undefined} />
          </View>

          <TouchableOpacity
            style={styles.announcementStatCard}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.8}
          >
            <View style={styles.announcementStatLeft}>
              <View style={styles.announcementStatIcon}>
                <Ionicons name="megaphone-outline" size={20} color={SEMANTIC.info.icon} />
              </View>
              <View>
                <Text style={styles.announcementStatTitle}>{t("teacherHome.annCardTitle")}</Text>
                <Text style={styles.announcementStatSub}>{t("teacherHome.annCardSub")}</Text>
              </View>
            </View>
            <View style={styles.announcementStatRight}>
              {announcementUnread > 0 && (
                <View style={styles.announcementUnreadBadge}>
                  <Text style={styles.announcementUnreadText}>
                    {t("teacherHome.annUnreadBadge", { count: announcementUnread })}
                  </Text>
                </View>
              )}
              {urgentUnack > 0 && (
                <View style={styles.announcementUrgentBadge}>
                  <Ionicons name="warning" size={11} color={COLORS.onPrimary} />
                  <Text style={styles.announcementUrgentText}>
                    {t("teacherHome.annUrgentBadge", { count: urgentUnack })}
                  </Text>
                </View>
              )}
              {announcementUnread === 0 && urgentUnack === 0 && (
                <Text style={styles.announcementAllClear}>{t("teacherHome.annAllRead")}</Text>
              )}
              <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
            </View>
          </TouchableOpacity>
        </View>

        {/* ── ALERTS ── */}
        {alerts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <View style={[styles.sectionIcon, { backgroundColor: SEMANTIC.error.box }]}>
                <Ionicons name="notifications" size={18} color={COLORS.danger} />
              </View>
              <Text style={styles.sectionTitle}>{t("teacherHome.sectionNotifications")}</Text>
              <View style={styles.alertCountBadge}>
                <Text style={styles.alertCountText}>{alerts.length}</Text>
              </View>
            </View>
            {alerts.map((alert) => {
              const as = ALERT_STYLES[alert.type] || ALERT_STYLES.info;
              return (
                <TouchableOpacity
                  key={alert.id}
                  style={[styles.alertCard, { backgroundColor: as.bg }]}
                  activeOpacity={0.7}
                  onPress={() => handleNav(alert.route)}
                >
                  <Ionicons name={alert.icon} size={20} color={as.icon} />
                  <Text style={[styles.alertText, { color: as.text }]}>
                    {alert.message}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={as.icon} />
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* ── TODAY'S SCHEDULE ── */}
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <View style={[styles.sectionIcon, { backgroundColor: SEMANTIC.info.box }]}>
              <Ionicons name="calendar" size={18} color={COLORS.info} />
            </View>
            <Text style={styles.sectionTitle}>{t("teacherHome.sectionTodayClasses")}</Text>
            {todayClasses.length > 0 && (
              <Text style={styles.scheduleSummary}>
                {pastCount     > 0 && t("teacherHome.scheduleDone", { count: pastCount })}
                {pastCount     > 0 && upcomingCount > 0 && " · "}
                {upcomingCount > 0 && t("teacherHome.scheduleUpcoming", { count: upcomingCount })}
              </Text>
            )}
          </View>

          {todayClasses.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="cafe-outline" size={32} color={COLORS.textMuted} />
              <Text style={styles.emptyText}>{t("teacherHome.emptyClassesTitle")}</Text>
              <Text style={styles.emptySubtext}>{t("teacherHome.emptyClassesSub")}</Text>
            </View>
          ) : (
            todayClasses.map((cls, index) => {
              const status    = cls.status || computeSlotStatus(cls.startTime, cls.endTime);
              const isPast    = status === "past";
              const isCurrent = status === "current";
              return (
                <TouchableOpacity
                  key={cls._id || cls.id || index}
                  style={[
                    styles.scheduleCard,
                    isPast    && styles.scheduleCardPast,
                    isCurrent && styles.scheduleCardCurrent,
                  ]}
                  activeOpacity={0.7}
                  onPress={() => handleNav("/teacher/timetable")}
                >
                  <View style={styles.scheduleTimeBlock}>
                    <Text style={[
                      styles.scheduleTime,
                      isPast    && styles.scheduleTextPast,
                      isCurrent && styles.scheduleTextCurrent,
                    ]}>
                      {cls.startTime || "—"}
                    </Text>
                    <Text style={styles.scheduleDash}>—</Text>
                    <Text style={[
                      styles.scheduleTime,
                      isPast    && styles.scheduleTextPast,
                      isCurrent && styles.scheduleTextCurrent,
                    ]}>
                      {cls.endTime || "—"}
                    </Text>
                  </View>
                  <View style={styles.scheduleInfo}>
                    <View style={styles.scheduleTitleRow}>
                      <Text
                        style={[styles.scheduleSubject, isPast && styles.scheduleTextPast]}
                        numberOfLines={1}
                      >
                        {cls.subjectName || t("teacherHome.subjectFallback")}
                      </Text>
                      {isCurrent && (
                        <View style={styles.currentBadge}>
                          <View style={styles.currentDot} />
                          <Text style={styles.currentBadgeText}>{t("teacherHome.nowBadge")}</Text>
                        </View>
                      )}
                      {isPast && (
                        <Ionicons name="checkmark-circle" size={14} color={COLORS.textMuted} />
                      )}
                    </View>
                    <Text style={[styles.scheduleClass, isPast && styles.scheduleTextPast]}>
                      {cls.className || t("teacherHome.classFallback")}
                      {cls.room ? `  ·  ${t("teacherHome.roomLabel", { room: cls.room })}` : ""}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={isPast ? COLORS.border : COLORS.textMuted}
                  />
                </TouchableOpacity>
              );
            })
          )}
        </View>

        {/* ── QUICK ACTIONS ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teacherHome.sectionQuickActions")}</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((action) => (
              <ActionTile
                key={action.id}
                primary={action.primary}
                kind={action.kind}
                icon={action.icon}
                label={action.title}
                style={styles.actionButton}
                onPress={() => handleNav(action.route)}
              />
            ))}
          </View>
        </View>

        {/* ── ALL MODULES ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teacherHome.sectionMyTools")}</Text>
          {modules.map((mod) => {
            const marksBadgeCount =
              (stats?.pendingMarksEntry ?? 0) + (stats?.rejectedSubmissions ?? 0);
            const badgeValue =
              mod.badge === "marks"         ? marksBadgeCount    :
              mod.badge === "announcements" ? announcementUnread : 0;
            const showBadge  = badgeValue > 0;
            const badgeRoute =
              mod.badge === "marks"
                ? "/teacher/exams?filter=pending-marks"
                : "/teacher/announcements";

            return (
              <TouchableOpacity
                key={mod.id}
                style={styles.moduleCard}
                activeOpacity={0.7}
                onPress={() => handleNav(mod.route)}
              >
                <View style={styles.moduleIcon}>
                  <TileIcon kind={mod.kind} icon={mod.icon} />
                </View>
                <View style={styles.moduleInfo}>
                  <Text style={styles.moduleTitle}>{mod.title}</Text>
                  {mod.description && (
                    <Text style={styles.moduleDesc}>{mod.description}</Text>
                  )}
                </View>
                {showBadge && (
                  <TouchableOpacity
                    style={[
                      styles.moduleBadge,
                      mod.badge === "announcements" && { backgroundColor: COLORS.primary },
                    ]}
                    onPress={(e) => { e.stopPropagation?.(); handleNav(badgeRoute); }}
                  >
                    <Text style={styles.moduleBadgeText}>{badgeValue}</Text>
                  </TouchableOpacity>
                )}
                <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          style={styles.settingsShortcut}
          onPress={() => handleNav("/teacher/settings")}
          activeOpacity={0.7}
        >
          <Ionicons name="settings-outline" size={18} color={COLORS.primary} />
          <Text style={styles.settingsShortcutText}>{t("teacherHome.settingsShortcut")}</Text>
          <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={18} color={COLORS.danger} />
          <Text style={styles.logoutText}>{t("teacherHome.logout")}</Text>
        </TouchableOpacity>

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: COLORS.page },
  centered:      { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: COLORS.page },
  loadingText:   { marginTop: 12, fontSize: 14, color: COLORS.textSubtle, fontWeight: "500" },
  scrollContent: { paddingTop: 8 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  greeting:  { fontSize: 14, color: COLORS.textSubtle, fontWeight: "500" },
  userName:  { fontSize: 24, fontWeight: "700", color: COLORS.text, marginTop: 2 },
  subtitle:  { fontSize: 13, color: COLORS.primary, fontWeight: "600", marginTop: 2 },
  headerActions:        { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 12 },
  profileIncompleteBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: SEMANTIC.warning.box, alignItems: "center", justifyContent: "center" },
  headerIconBtn:        { width: 36, height: 36, borderRadius: 10, backgroundColor: COLORS.primaryLight, alignItems: "center", justifyContent: "center" },
  bellBadge: {
    position:          "absolute",
    top:               -4,
    right:             -4,
    backgroundColor:   COLORS.danger,
    borderRadius:      8,
    minWidth:          16,
    height:            16,
    paddingHorizontal: 3,
    alignItems:        "center",
    justifyContent:    "center",
    borderWidth:       1.5,
    borderColor:       COLORS.surface,
  },
  bellBadgeText:  { color: COLORS.onPrimary, fontSize: 9, fontWeight: "800" },
  profileButton:  { marginLeft: 4 },
  avatarCircle: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: COLORS.primary,
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText: { fontSize: 15, fontWeight: "800", color: COLORS.onPrimary },
  avatarDot: {
    position:        "absolute",
    bottom:          1,
    right:           1,
    width:           10,
    height:          10,
    borderRadius:    5,
    backgroundColor: COLORS.success,
    borderWidth:     2,
    borderColor:     COLORS.surface,
  },

  // Attention banners are light tints of their meaning, never solid fills:
  // a new announcement is info (error when one is urgent), an unfinished
  // profile a warning, marks waiting an error.
  announcementBanner: {
    flexDirection: "row", alignItems: "center", borderWidth: 1,
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  announcementBannerIcon:   { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  announcementBannerText:   { flex: 1 },
  announcementBannerTitle:  { fontSize: 14, fontWeight: "700" },
  announcementBannerSub:    { fontSize: 12, marginTop: 2 },

  profileSetupBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: SEMANTIC.warning.bg,
    borderWidth: 1, borderColor: SEMANTIC.warning.box,
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  profileSetupIcon:  { width: 40, height: 40, borderRadius: 10, backgroundColor: SEMANTIC.warning.box, alignItems: "center", justifyContent: "center" },
  profileSetupText:  { flex: 1 },
  profileSetupTitle: { fontSize: 14, fontWeight: "700", color: SEMANTIC.warning.text },
  profileSetupSub:   { fontSize: 12, color: SEMANTIC.warning.text, marginTop: 2 },

  marksBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: SEMANTIC.error.bg,
    borderWidth: 1, borderColor: SEMANTIC.error.box,
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  marksBannerIcon:  { width: 40, height: 40, borderRadius: 10, backgroundColor: SEMANTIC.error.box, alignItems: "center", justifyContent: "center" },
  marksBannerText:  { flex: 1 },
  marksBannerTitle: { fontSize: 14, fontWeight: "700", color: SEMANTIC.error.text },
  marksBannerSub:   { fontSize: 12, color: SEMANTIC.error.text, marginTop: 2 },

  errorBanner: { flexDirection: "row", alignItems: "center", backgroundColor: SEMANTIC.error.box, marginHorizontal: 20, marginBottom: 16, padding: 12, borderRadius: 10, gap: 8 },
  errorText:   { flex: 1, fontSize: 13, color: SEMANTIC.error.text, fontWeight: "500" },
  retryText:   { fontSize: 13, color: COLORS.danger, fontWeight: "700" },

  section:         { paddingHorizontal: 20, marginBottom: 24, marginTop: 12 },
  sectionTitle:    { fontSize: 18, fontWeight: "700", color: COLORS.text, marginBottom: 12 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sectionIcon:     { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  scheduleSummary: { flex: 1, fontSize: 11, color: COLORS.textMuted, textAlign: "right", fontWeight: "500" },

  announcementStatCard:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: SEMANTIC.info.bg, borderRadius: 14, padding: 14, marginTop: 8, borderWidth: 1, borderColor: SEMANTIC.info.box },
  announcementStatLeft:    { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  announcementStatIcon:    { width: 40, height: 40, borderRadius: 10, backgroundColor: SEMANTIC.info.box, alignItems: "center", justifyContent: "center" },
  announcementStatTitle:   { fontSize: 14, fontWeight: "700", color: SEMANTIC.info.text },
  announcementStatSub:     { fontSize: 11, color: SEMANTIC.info.text, marginTop: 1 },
  announcementStatRight:   { flexDirection: "row", alignItems: "center", gap: 6 },
  announcementUnreadBadge: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  announcementUnreadText:  { color: COLORS.onPrimary, fontSize: 11, fontWeight: "700" },
  announcementUrgentBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: COLORS.danger, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  announcementUrgentText:  { color: COLORS.onPrimary, fontSize: 11, fontWeight: "700" },
  announcementAllClear:    { fontSize: 12, color: COLORS.success, fontWeight: "600" },

  statsRow:   { flexDirection: "row", gap: 8, marginBottom: 8 },

  alertCountBadge: { backgroundColor: COLORS.danger, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1, minWidth: 20, alignItems: "center" },
  alertCountText:  { color: COLORS.onPrimary, fontSize: 11, fontWeight: "700" },
  alertCard:       { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10, marginBottom: 8, gap: 10 },
  alertText:       { flex: 1, fontSize: 13, fontWeight: "500" },

  emptyState:   { backgroundColor: COLORS.surface, borderRadius: 14, padding: 24, alignItems: "center", gap: 6 },
  emptyText:    { fontSize: 14, fontWeight: "600", color: COLORS.textSubtle, marginTop: 8 },
  emptySubtext: { fontSize: 12, color: COLORS.textMuted },

  scheduleCard: {
    flexDirection: "row", alignItems: "center", backgroundColor: COLORS.surface,
    borderRadius: 12, padding: 14, marginBottom: 8, gap: 12,
    shadowColor: COLORS.shadow, shadowOpacity: 0.04, shadowRadius: 3, elevation: 2,
  },
  scheduleCardPast:    { opacity: 0.55, backgroundColor: COLORS.page },
  scheduleCardCurrent: { borderWidth: 1.5, borderColor: COLORS.primary, backgroundColor: COLORS.primaryLight },
  scheduleTimeBlock:   { alignItems: "center", paddingRight: 12, borderRightWidth: 1, borderRightColor: COLORS.border, minWidth: 64 },
  scheduleTime:        { fontSize: 12, fontWeight: "600", color: COLORS.primary },
  scheduleTextPast:    { color: COLORS.textMuted },
  scheduleTextCurrent: { color: COLORS.primaryHover, fontWeight: "700" },
  scheduleDash:        { fontSize: 10, color: COLORS.textMuted },
  scheduleInfo:        { flex: 1 },
  scheduleTitleRow:    { flexDirection: "row", alignItems: "center", gap: 6 },
  scheduleSubject:     { fontSize: 14, fontWeight: "700", color: COLORS.text, flexShrink: 1 },
  scheduleClass:       { fontSize: 12, color: COLORS.textSubtle, marginTop: 2 },
  currentBadge:        { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: COLORS.primary, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  currentDot:          { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.surface },
  currentBadgeText:    { color: COLORS.onPrimary, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },

  actionsGrid:   { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionButton:  { width: "31.5%" },

  moduleCard:      { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 8, shadowColor: COLORS.shadow, shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  moduleIcon:      { marginRight: 12 },
  moduleInfo:      { flex: 1 },
  moduleTitle:     { fontSize: 15, fontWeight: "600", color: COLORS.text },
  moduleDesc:      { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  moduleBadge:     { backgroundColor: COLORS.danger, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, marginRight: 6, minWidth: 22, alignItems: "center" },
  moduleBadgeText: { color: COLORS.onPrimary, fontSize: 11, fontWeight: "700" },

  settingsShortcut:     { flexDirection: "row", alignItems: "center", justifyContent: "center", marginHorizontal: 20, marginBottom: 12, backgroundColor: COLORS.primaryLight, paddingVertical: 12, borderRadius: 12, gap: 8 },
  settingsShortcutText: { color: COLORS.primary, fontWeight: "600", fontSize: 14, flex: 1, textAlign: "center" },
  logoutButton:         { flexDirection: "row", alignItems: "center", justifyContent: "center", marginHorizontal: 20, backgroundColor: SEMANTIC.error.box, paddingVertical: 14, borderRadius: 12, gap: 8 },
  logoutText:           { color: COLORS.danger, fontWeight: "600", fontSize: 15 },
});