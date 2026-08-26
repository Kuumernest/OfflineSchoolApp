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
import { getTeacherStats }      from "../../src/services/teacherStats.service";
import { getSchoolInfo }        from "../../src/services/school.service";
import { isTeacherProfileComplete } from "./profile/setup";
import { useAnnouncementStore } from "../../src/store/announcement.store";
import { toDisplayUri }        from "../../src/utils/logoUri";
import { useTranslation }      from "../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────────────────────────
// STATIC DATA
// ─────────────────────────────────────────────────────────────────────────────

const buildQuickActions = (t) => [
  { id: "my-exams",        title: t("teacherHome.qaMyExams"),        icon: "trophy-outline",        color: "#4F46E5", route: "/teacher/exams"                     },
  { id: "enter-marks",     title: t("teacherHome.qaEnterMarks"),     icon: "create-outline",        color: "#DC2626", route: "/teacher/exams?filter=pending-marks" },
  { id: "upload-notes",    title: t("teacherHome.qaUploadNotes"),    icon: "document-text-outline", color: "#7C3AED", route: "/teacher/content/upload-notes"       },
  { id: "create-quiz",     title: t("teacherHome.qaCreateQuiz"),     icon: "help-circle-outline",   color: "#059669", route: "/teacher/quizzes/create"             },
  { id: "assign-homework", title: t("teacherHome.qaAssignHomework"), icon: "clipboard-outline",     color: "#D97706", route: "/teacher/homework/create"            },
  { id: "mark-attendance", title: t("teacherHome.qaAttendance"),     icon: "checkbox-outline",      color: "#DB2777", route: "/teacher/attendance"                 },
  { id: "announce",        title: t("teacherHome.qaAnnounce"),       icon: "megaphone-outline",     color: "#7C3AED", route: "/teacher/announcements/create"       },
  { id: "messages",        title: t("teacherHome.qaMessages"),       icon: "chatbubbles-outline",   color: "#2563EB", route: "/messages"                           },
];

const buildModules = (t) => [
  { id: "exams",         title: t("teacherHome.modExamsTitle"),         icon: "trophy-outline",        color: "#4F46E5", route: "/teacher/exams",         description: t("teacherHome.modExamsDesc"),         badge: "marks"         },
  { id: "subjects",      title: t("teacherHome.modSubjectsTitle"),      icon: "book-outline",          color: "#7C3AED", route: "/teacher/subjects",      description: t("teacherHome.modSubjectsDesc")                              },
  { id: "content",       title: t("teacherHome.modContentTitle"),       icon: "folder-outline",        color: "#059669", route: "/teacher/content",       description: t("teacherHome.modContentDesc")                               },
  { id: "quizzes",       title: t("teacherHome.modQuizzesTitle"),       icon: "help-circle-outline",   color: "#059669", route: "/teacher/quizzes",       description: t("teacherHome.modQuizzesDesc")                               },
  { id: "homework",      title: t("teacherHome.modHomeworkTitle"),      icon: "create-outline",        color: "#D97706", route: "/teacher/homework",      description: t("teacherHome.modHomeworkDesc")                              },
  { id: "results",       title: t("teacherHome.modResultsTitle"),       icon: "bar-chart-outline",     color: "#059669", route: "/teacher/results",       description: t("teacherHome.modResultsDesc")                               },
  { id: "attendance",    title: t("teacherHome.modAttendanceTitle"),    icon: "calendar-outline",      color: "#DB2777", route: "/teacher/attendance",    description: t("teacherHome.modAttendanceDesc")                            },
  { id: "timetable",     title: t("teacherHome.modTimetableTitle"),     icon: "time-outline",          color: "#2563EB", route: "/teacher/timetable",     description: t("teacherHome.modTimetableDesc")                             },
  { id: "announcements", title: t("teacherHome.modAnnouncementsTitle"), icon: "megaphone-outline",     color: "#7C3AED", route: "/teacher/announcements", description: t("teacherHome.modAnnouncementsDesc"), badge: "announcements" },
];

const ALERT_STYLES = {
  danger:  { bg: "#FEE2E2", icon: "#DC2626", text: "#991B1B" },
  warning: { bg: "#FEF3C7", icon: "#D97706", text: "#92400E" },
  info:    { bg: "#DBEAFE", icon: "#2563EB", text: "#1E40AF" },
  success: { bg: "#ECFDF5", icon: "#059669", text: "#064E3B" },
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
          <Ionicons name="school" size={20} color="#4F46E5" />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={sb.schoolName} numberOfLines={1}>{school.name}</Text>
        {!!location && (
          <Text style={sb.location} numberOfLines={1}>
            <Ionicons name="location-outline" size={11} color="#6B7280" />
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

const sb = StyleSheet.create({
  banner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#EEF2FF",
    marginHorizontal:  16,
    marginTop:         12,
    marginBottom:      4,
    borderRadius:      14,
    paddingHorizontal: 14,
    paddingVertical:   12,
    gap:               12,
    borderWidth:       1,
    borderColor:       "#C7D2FE",
  },
  logo:        { width: 44, height: 44, borderRadius: 10, backgroundColor: "#fff" },
  logoFallback: {
    width:           44,
    height:          44,
    borderRadius:    10,
    backgroundColor: "#fff",
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     1,
    borderColor:     "#C7D2FE",
  },
  schoolName: { fontSize: 14, fontWeight: "700", color: "#1E1B4B" },
  location:   { fontSize: 11, color: "#6B7280", marginTop: 2 },
  motto:      { fontSize: 11, color: "#4F46E5", fontStyle: "italic", marginTop: 2, fontWeight: "500" },
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function TeacherDashboard() {
  const router = useRouter();
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

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
      if (stats.todayAttendanceMissing > 0) list.push({ id: "missing-attendance", type: "danger",  icon: "alert-circle-outline",     message: t("teacherHome.alertMissingAttendance", { count: stats.todayAttendanceMissing }),                                         route: "/teacher/attendance/mark"            });
      if (stats.newSubmissions > 0)        list.push({ id: "new-submissions",    type: "success", icon: "checkmark-circle-outline", message: t("teacherHome.alertNewSubmissions", { count: stats.newSubmissions }),           route: "/teacher/homework"                   });
    }

    if (isProfileIncomplete)    list.push({ id: "profile-incomplete",   type: "warning", icon: "person-outline",    message: t("teacherHome.alertProfileIncomplete"),                                                                       route: "/teacher/profile/setup" });
    if (urgentUnack > 0)        list.push({ id: "urgent-announcements", type: "danger",  icon: "megaphone-outline", message: t("teacherHome.alertUrgentAnnouncements", { count: urgentUnack }),     route: "/teacher/announcements" });
    if (announcementUnread > 0) list.push({ id: "unread-announcements", type: "info",    icon: "megaphone-outline", message: t("teacherHome.alertUnreadAnnouncements", { count: announcementUnread }),                                            route: "/teacher/announcements" });

    return list;
  }, [stats, isProfileIncomplete, announcementUnread, urgentUnack, t]);

  const quickActions = useMemo(() => buildQuickActions(t), [t]);
  const modules      = useMemo(() => buildModules(t),      [t]);

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleNav = useCallback((route) => {
    try { router.push(route); }
    catch (err) { console.error(`Nav error ${route}:`, err); }
  }, [router]);

  const handleLogout = useCallback(async () => {
    try { await logout(); router.replace("/auth/login"); }
    catch { router.replace("/auth/login"); }
  }, [logout, router]);

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
        <ActivityIndicator size="large" color="#4F46E5" />
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
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

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
              <Ionicons name="alert-circle" size={16} color="#D97706" />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.7}
          >
            <Ionicons name="megaphone-outline" size={20} color="#7C3AED" />
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
            <Ionicons name="settings-outline" size={22} color="#4F46E5" />
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
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        <SchoolBanner school={school} />

        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={18} color="#DC2626" />
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
              <Ionicons name="person-add-outline" size={22} color="#FFF" />
            </View>
            <View style={styles.profileSetupText}>
              <Text style={styles.profileSetupTitle}>{t("teacherHome.profileBannerTitle")}</Text>
              <Text style={styles.profileSetupSub}>
                {t("teacherHome.profileBannerSub")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#FFF" />
          </TouchableOpacity>
        )}

        {(announcementUnread > 0 || urgentUnack > 0) && (
          <TouchableOpacity
            style={[
              styles.announcementBanner,
              urgentUnack > 0 && styles.announcementBannerUrgent,
            ]}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.8}
          >
            <View style={styles.announcementBannerIcon}>
              <Ionicons
                name={urgentUnack > 0 ? "warning" : "megaphone"}
                size={24}
                color="#FFF"
              />
            </View>
            <View style={styles.announcementBannerText}>
              <Text style={styles.announcementBannerTitle}>
                {urgentUnack > 0
                  ? t("teacherHome.annBannerUrgentTitle")
                  : t("teacherHome.annBannerNewTitle")}
              </Text>
              <Text style={styles.announcementBannerSub}>
                {urgentUnack > 0
                  ? t("teacherHome.annBannerUrgentSub", { count: urgentUnack })
                  : t("teacherHome.annBannerUnreadSub", { count: announcementUnread })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#FFF" />
          </TouchableOpacity>
        )}

        {(stats?.pendingMarksEntry > 0 || stats?.rejectedSubmissions > 0) && (
          <TouchableOpacity
            style={styles.marksBanner}
            onPress={() => handleNav("/teacher/exams?filter=pending-marks")}
            activeOpacity={0.8}
          >
            <View style={styles.marksBannerIcon}>
              <Ionicons name="create" size={24} color="#FFF" />
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
            <Ionicons name="chevron-forward" size={20} color="#FFF" />
          </TouchableOpacity>
        )}

        {/* ── TEACHING OVERVIEW ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teacherHome.sectionOverview")}</Text>

          <View style={styles.statsRow}>
            <View style={[styles.statCard, { backgroundColor: "#EEF2FF" }]}>
              <Ionicons name="book"   size={20} color="#4F46E5" />
              <Text style={styles.statNumber}>{stats?.assignedSubjects ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statSubjects")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#EDE9FE" }]}>
              <Ionicons name="school" size={20} color="#7C3AED" />
              <Text style={styles.statNumber}>{stats?.assignedClasses  ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statClasses")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#ECFDF5" }]}>
              <Ionicons name="people" size={20} color="#059669" />
              <Text style={styles.statNumber}>{stats?.totalStudents    ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statStudents")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#FEF3C7" }]}>
              <Ionicons name="time"   size={20} color="#D97706" />
              <Text style={styles.statNumber}>{stats?.todayClassCount  ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statToday")}</Text>
            </View>
          </View>

          <View style={styles.statsRow}>
            <View style={[styles.statCard, { backgroundColor: "#EEF2FF" }]}>
              <Ionicons name="trophy" size={20} color="#4F46E5" />
              <Text style={styles.statNumber}>{stats?.activeExams      ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statActiveExams")}</Text>
            </View>
            <TouchableOpacity
              style={[
                styles.statCard,
                { backgroundColor: (stats?.pendingMarksEntry ?? 0) > 0 ? "#FEE2E2" : "#F0FDF4" },
              ]}
              onPress={() =>
                (stats?.pendingMarksEntry ?? 0) > 0 &&
                handleNav("/teacher/exams?filter=pending-marks")
              }
              activeOpacity={0.7}
            >
              <Ionicons
                name="create"
                size={20}
                color={(stats?.pendingMarksEntry ?? 0) > 0 ? "#DC2626" : "#059669"}
              />
              <Text style={[
                styles.statNumber,
                { color: (stats?.pendingMarksEntry ?? 0) > 0 ? "#DC2626" : "#111827" },
              ]}>
                {stats?.pendingMarksEntry ?? 0}
              </Text>
              <Text style={styles.statLabel}>{t("teacherHome.statPendingMarks")}</Text>
            </TouchableOpacity>
            <View style={[styles.statCard, { backgroundColor: "#FEF3C7" }]}>
              <Ionicons name="time"             size={20} color="#D97706" />
              <Text style={styles.statNumber}>{stats?.submittedMarks   ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statSubmitted")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#ECFDF5" }]}>
              <Ionicons name="checkmark-circle" size={20} color="#059669" />
              <Text style={styles.statNumber}>{stats?.approvedMarks    ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statApproved")}</Text>
            </View>
          </View>

          <View style={styles.statsRow}>
            <View style={[styles.statCard, { backgroundColor: "#F0FDF4" }]}>
              <Ionicons name="folder"       size={20} color="#059669" />
              <Text style={styles.statNumber}>{stats?.contentUploads  ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statContent")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#DBEAFE" }]}>
              <Ionicons name="help-circle"  size={20} color="#2563EB" />
              <Text style={styles.statNumber}>{stats?.activeQuizzes   ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statQuizzes")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#FFF1F2" }]}>
              <Ionicons name="create"       size={20} color="#DB2777" />
              <Text style={styles.statNumber}>{stats?.activeHomework  ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statHomework")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: "#FEE2E2" }]}>
              <Ionicons name="alert-circle" size={20} color="#DC2626" />
              <Text style={styles.statNumber}>{stats?.pendingGrading  ?? 0}</Text>
              <Text style={styles.statLabel}>{t("teacherHome.statToGrade")}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.announcementStatCard}
            onPress={() => handleNav("/teacher/announcements")}
            activeOpacity={0.8}
          >
            <View style={styles.announcementStatLeft}>
              <View style={styles.announcementStatIcon}>
                <Ionicons name="megaphone-outline" size={20} color="#7C3AED" />
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
                  <Ionicons name="warning" size={11} color="#FFF" />
                  <Text style={styles.announcementUrgentText}>
                    {t("teacherHome.annUrgentBadge", { count: urgentUnack })}
                  </Text>
                </View>
              )}
              {announcementUnread === 0 && urgentUnack === 0 && (
                <Text style={styles.announcementAllClear}>{t("teacherHome.annAllRead")}</Text>
              )}
              <Ionicons name="chevron-forward" size={16} color="#7C3AED" />
            </View>
          </TouchableOpacity>
        </View>

        {/* ── ALERTS ── */}
        {alerts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <View style={[styles.sectionIcon, { backgroundColor: "#FEE2E2" }]}>
                <Ionicons name="notifications" size={18} color="#DC2626" />
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
            <View style={[styles.sectionIcon, { backgroundColor: "#DBEAFE" }]}>
              <Ionicons name="calendar" size={18} color="#2563EB" />
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
              <Ionicons name="cafe-outline" size={32} color="#9CA3AF" />
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
                        <Ionicons name="checkmark-circle" size={14} color="#9CA3AF" />
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
                    color={isPast ? "#E5E7EB" : "#D1D5DB"}
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
              <TouchableOpacity
                key={action.id}
                style={styles.actionButton}
                onPress={() => handleNav(action.route)}
                activeOpacity={0.7}
              >
                <View style={[styles.iconContainer, { backgroundColor: action.color + "18" }]}>
                  <Ionicons name={action.icon} size={22} color={action.color} />
                </View>
                <Text style={styles.actionTitle}>{action.title}</Text>
              </TouchableOpacity>
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
                <View style={[styles.moduleIcon, { backgroundColor: mod.color + "18" }]}>
                  <Ionicons name={mod.icon} size={20} color={mod.color} />
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
                      mod.badge === "announcements" && { backgroundColor: "#7C3AED" },
                    ]}
                    onPress={(e) => { e.stopPropagation?.(); handleNav(badgeRoute); }}
                  >
                    <Text style={styles.moduleBadgeText}>{badgeValue}</Text>
                  </TouchableOpacity>
                )}
                <Ionicons name="chevron-forward" size={16} color="#D1D5DB" />
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          style={styles.settingsShortcut}
          onPress={() => handleNav("/teacher/settings")}
          activeOpacity={0.7}
        >
          <Ionicons name="settings-outline" size={18} color="#4F46E5" />
          <Text style={styles.settingsShortcutText}>{t("teacherHome.settingsShortcut")}</Text>
          <Ionicons name="chevron-forward" size={16} color="#4F46E5" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={18} color="#DC2626" />
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
  container:     { flex: 1, backgroundColor: "#F3F4F6" },
  centered:      { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F3F4F6" },
  loadingText:   { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingTop: 8 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  greeting:  { fontSize: 14, color: "#6B7280", fontWeight: "500" },
  userName:  { fontSize: 24, fontWeight: "700", color: "#111827", marginTop: 2 },
  subtitle:  { fontSize: 13, color: "#4F46E5", fontWeight: "600", marginTop: 2 },
  headerActions:        { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 12 },
  profileIncompleteBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },
  headerIconBtn:        { width: 36, height: 36, borderRadius: 10, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  bellBadge: {
    position:          "absolute",
    top:               -4,
    right:             -4,
    backgroundColor:   "#DC2626",
    borderRadius:      8,
    minWidth:          16,
    height:            16,
    paddingHorizontal: 3,
    alignItems:        "center",
    justifyContent:    "center",
    borderWidth:       1.5,
    borderColor:       "#FFF",
  },
  bellBadgeText:  { color: "#FFF", fontSize: 9, fontWeight: "800" },
  profileButton:  { marginLeft: 4 },
  avatarCircle: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText: { fontSize: 15, fontWeight: "800", color: "#FFF" },
  avatarDot: {
    position:        "absolute",
    bottom:          1,
    right:           1,
    width:           10,
    height:          10,
    borderRadius:    5,
    backgroundColor: "#059669",
    borderWidth:     2,
    borderColor:     "#FFF",
  },

  announcementBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#7C3AED",
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  announcementBannerUrgent: { backgroundColor: "#DC2626" },
  announcementBannerIcon:   { width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  announcementBannerText:   { flex: 1 },
  announcementBannerTitle:  { fontSize: 14, fontWeight: "700", color: "#FFF" },
  announcementBannerSub:    { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 2 },

  profileSetupBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#D97706",
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  profileSetupIcon:  { width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  profileSetupText:  { flex: 1 },
  profileSetupTitle: { fontSize: 14, fontWeight: "700", color: "#FFF" },
  profileSetupSub:   { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 2 },

  marksBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#DC2626",
    marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 14, padding: 14, gap: 12,
  },
  marksBannerIcon:  { width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  marksBannerText:  { flex: 1 },
  marksBannerTitle: { fontSize: 14, fontWeight: "700", color: "#FFF" },
  marksBannerSub:   { fontSize: 12, color: "rgba(255,255,255,0.8)", marginTop: 2 },

  errorBanner: { flexDirection: "row", alignItems: "center", backgroundColor: "#FEE2E2", marginHorizontal: 20, marginBottom: 16, padding: 12, borderRadius: 10, gap: 8 },
  errorText:   { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText:   { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  section:         { paddingHorizontal: 20, marginBottom: 24, marginTop: 12 },
  sectionTitle:    { fontSize: 18, fontWeight: "700", color: "#111827", marginBottom: 12 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sectionIcon:     { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  scheduleSummary: { flex: 1, fontSize: 11, color: "#9CA3AF", textAlign: "right", fontWeight: "500" },

  announcementStatCard:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#F5F3FF", borderRadius: 14, padding: 14, marginTop: 8, borderWidth: 1, borderColor: "#EDE9FE" },
  announcementStatLeft:    { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  announcementStatIcon:    { width: 40, height: 40, borderRadius: 10, backgroundColor: "#EDE9FE", alignItems: "center", justifyContent: "center" },
  announcementStatTitle:   { fontSize: 14, fontWeight: "700", color: "#4C1D95" },
  announcementStatSub:     { fontSize: 11, color: "#7C3AED", marginTop: 1 },
  announcementStatRight:   { flexDirection: "row", alignItems: "center", gap: 6 },
  announcementUnreadBadge: { backgroundColor: "#7C3AED", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  announcementUnreadText:  { color: "#FFF", fontSize: 11, fontWeight: "700" },
  announcementUrgentBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#DC2626", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  announcementUrgentText:  { color: "#FFF", fontSize: 11, fontWeight: "700" },
  announcementAllClear:    { fontSize: 12, color: "#059669", fontWeight: "600" },

  statsRow:   { flexDirection: "row", gap: 8, marginBottom: 8 },
  statCard:   { flex: 1, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 6, alignItems: "center" },
  statNumber: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 6 },
  statLabel:  { fontSize: 10, color: "#6B7280", marginTop: 2, fontWeight: "500", textAlign: "center" },

  alertCountBadge: { backgroundColor: "#DC2626", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1, minWidth: 20, alignItems: "center" },
  alertCountText:  { color: "#FFF", fontSize: 11, fontWeight: "700" },
  alertCard:       { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10, marginBottom: 8, gap: 10 },
  alertText:       { flex: 1, fontSize: 13, fontWeight: "500" },

  emptyState:   { backgroundColor: "#FFF", borderRadius: 14, padding: 24, alignItems: "center", gap: 6 },
  emptyText:    { fontSize: 14, fontWeight: "600", color: "#6B7280", marginTop: 8 },
  emptySubtext: { fontSize: 12, color: "#9CA3AF" },

  scheduleCard: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#FFF",
    borderRadius: 12, padding: 14, marginBottom: 8, gap: 12,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 2,
  },
  scheduleCardPast:    { opacity: 0.55, backgroundColor: "#F9FAFB" },
  scheduleCardCurrent: { borderWidth: 1.5, borderColor: "#4F46E5", backgroundColor: "#EEF2FF" },
  scheduleTimeBlock:   { alignItems: "center", paddingRight: 12, borderRightWidth: 1, borderRightColor: "#E5E7EB", minWidth: 64 },
  scheduleTime:        { fontSize: 12, fontWeight: "600", color: "#4F46E5" },
  scheduleTextPast:    { color: "#9CA3AF" },
  scheduleTextCurrent: { color: "#4338CA", fontWeight: "700" },
  scheduleDash:        { fontSize: 10, color: "#9CA3AF" },
  scheduleInfo:        { flex: 1 },
  scheduleTitleRow:    { flexDirection: "row", alignItems: "center", gap: 6 },
  scheduleSubject:     { fontSize: 14, fontWeight: "700", color: "#111827", flexShrink: 1 },
  scheduleClass:       { fontSize: 12, color: "#6B7280", marginTop: 2 },
  currentBadge:        { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#4F46E5", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  currentDot:          { width: 6, height: 6, borderRadius: 3, backgroundColor: "#FFF" },
  currentBadgeText:    { color: "#FFF", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },

  actionsGrid:   { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionButton:  { width: "31.5%", backgroundColor: "#FFF", borderRadius: 14, paddingVertical: 14, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 2 },
  iconContainer: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  actionTitle:   { fontSize: 11, fontWeight: "600", color: "#374151", textAlign: "center", paddingHorizontal: 4 },

  moduleCard:      { flexDirection: "row", alignItems: "center", backgroundColor: "#FFF", borderRadius: 12, padding: 14, marginBottom: 8, shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1 },
  moduleIcon:      { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", marginRight: 12 },
  moduleInfo:      { flex: 1 },
  moduleTitle:     { fontSize: 15, fontWeight: "600", color: "#111827" },
  moduleDesc:      { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  moduleBadge:     { backgroundColor: "#DC2626", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, marginRight: 6, minWidth: 22, alignItems: "center" },
  moduleBadgeText: { color: "#FFF", fontSize: 11, fontWeight: "700" },

  settingsShortcut:     { flexDirection: "row", alignItems: "center", justifyContent: "center", marginHorizontal: 20, marginBottom: 12, backgroundColor: "#EEF2FF", paddingVertical: 12, borderRadius: 12, gap: 8 },
  settingsShortcutText: { color: "#4F46E5", fontWeight: "600", fontSize: 14, flex: 1, textAlign: "center" },
  logoutButton:         { flexDirection: "row", alignItems: "center", justifyContent: "center", marginHorizontal: 20, backgroundColor: "#FEE2E2", paddingVertical: 14, borderRadius: 12, gap: 8 },
  logoutText:           { color: "#DC2626", fontWeight: "600", fontSize: 15 },
});