// app/admin/dashboard/index.js
"use strict";

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, ActivityIndicator, RefreshControl, Alert, Image,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuthStore }           from "../../../src/store/auth.store";
import { getAdminStats }          from "../../../src/services/adminStats.service";
import { syncTeacherAssignments } from "../../../src/services/syncAssignments.service";
import { getSchoolInfo }          from "../../../src/services/school.service";
import SyncOverwriteService       from "../../../src/services/sync-overwrite.service";
import { toDisplayUri }           from "../../../src/utils/logoUri";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  {
    id:    "collect-fees",
    title: "Collect Fees",
    icon:  "cash-outline",
    color: "#3B4996",
    route: "/admin/fees",
  },
  {
    id:    "print-register",
    title: "Print Register",
    icon:  "print-outline",
    color: "#4F5A70",
    route: "/admin/documents",
  },
  {
    id:    "record-expense",
    title: "Record Expense",
    icon:  "receipt-outline",
    color: "#9F2318",
    route: "/admin/finance/expenses",
  },
  {
    id:    "add-student",
    title: "Add Student",
    icon:  "person-add-outline",
    color: "#0891B2",
    route: "/admin/students/add",
  },
  {
    id:    "add-class",
    title: "Add Class",
    icon:  "add-circle-outline",
    color: "#4F46E5",
    route: "/admin/classes/add",
  },
  {
    id:    "add-subject",
    title: "Add Subject",
    icon:  "add-circle-outline",
    color: "#059669",
    route: "/admin/subjects/add",
  },
  {
    id:    "add-teacher",
    title: "Add Teacher",
    icon:  "add-circle-outline",
    color: "#7C3AED",
    route: "/admin/teachers/add",
  },
  {
    id:    "assign-teacher",
    title: "Assign Teacher",
    icon:  "git-branch-outline",
    color: "#DB2777",
    route: "/admin/assignments",
  },
  {
    id:    "review-apps",
    title: "Review Apps",
    icon:  "clipboard-outline",
    color: "#D97706",
    route: "/admin/students/applications",
  },
  {
    id:    "build-timetable",
    title: "Timetable",
    icon:  "time-outline",
    color: "#DC2626",
    route: "/admin/timetable",
  },
];

const ALL_MODULES = [
  {
    id:          "fees",
    title:       "Fees",
    icon:        "cash-outline",
    color:       "#3B4996",
    route:       "/admin/fees",
    description: "Balances & payments",
  },
  {
    id:          "expenses",
    title:       "Expenses",
    icon:        "receipt-outline",
    color:       "#9F2318",
    route:       "/admin/finance/expenses",
    description: "Money going out",
  },
  {
    id:          "payroll",
    title:       "Payroll",
    icon:        "briefcase-outline",
    color:       "#12683A",
    route:       "/admin/finance/payroll",
    description: "Runs & payslips (read-only)",
  },
  {
    id:          "fin-reports",
    title:       "Reports",
    icon:        "stats-chart-outline",
    color:       "#3B4996",
    route:       "/admin/finance/reports",
    description: "Income vs expenditure",
  },
  {
    id:          "promotion",
    title:       "End of Year",
    icon:        "school-outline",
    color:       "#1B4F8A",
    route:       "/admin/promotion",
    description: "Rollover (read-only)",
  },
  {
    id:          "printing",
    title:       "Printing",
    icon:        "print-outline",
    color:       "#4F5A70",
    route:       "/admin/documents",
    description: "Class lists & transcripts",
  },
  {
    id:          "exports",
    title:       "Exports",
    icon:        "grid-outline",
    color:       "#12683A",
    route:       "/admin/exports",
    description: "Excel spreadsheets",
  },
  {
    id:          "classes",
    title:       "Classes",
    icon:        "school-outline",
    color:       "#4F46E5",
    route:       "/admin/classes",
    description: "Create & manage classes",
  },
  {
    id:          "subjects",
    title:       "Subjects",
    icon:        "book-outline",
    color:       "#059669",
    route:       "/admin/subjects",
    description: "Create & link subjects",
  },
  {
    id:          "teachers",
    title:       "Teachers",
    icon:        "people-outline",
    color:       "#7C3AED",
    route:       "/admin/teachers",
    description: "Manage teachers",
  },
  {
    id:          "applications",
    title:       "Applications",
    icon:        "person-add-outline",
    color:       "#D97706",
    route:       "/admin/students/applications",
    description: "Review applications",
  },
  {
    id:          "students",
    title:       "Students",
    icon:        "people-circle-outline",
    color:       "#059669",
    route:       "/admin/students/approved",
    description: "Approved students",
  },
  {
    id:          "teacher-assignments",
    title:       "Assignments",
    icon:        "git-branch-outline",
    color:       "#DB2777",
    route:       "/admin/assignments",
    description: "Teacher allocation",
  },
  {
    id:          "timetable",
    title:       "Timetable",
    icon:        "time-outline",
    color:       "#DC2626",
    route:       "/admin/timetable",
    description: "Schedule builder",
  },
  {
    id:          "attendance",
    title:       "Attendance",
    icon:        "calendar-outline",
    color:       "#059669",
    route:       "/admin/attendance",
    description: "Tracking & reports",
  },
  {
    id:          "exams",
    title:       "Exams",
    icon:        "trophy-outline",
    color:       "#7C3AED",
    route:       "/admin/exams",
    description: "Exams & results",
  },
  {
    id:          "announcements",
    title:       "Announcements",
    icon:        "megaphone-outline",
    color:       "#DB2777",
    route:       "/admin/announcements",
    description: "Broadcast system",
  },
  {
    id:          "settings",
    title:       "Settings",
    icon:        "settings-outline",
    color:       "#6B7280",
    route:       "/admin/settings",
    description: "System config",
  },
];

const STAT_ROWS = [
  [
    { key: "pendingApplications", label: "Pending",      icon: "document-text",    color: "#D97706" },
    { key: "approvedStudents",    label: "Students",     icon: "people-circle",    color: "#059669" },
    { key: "totalTeachers",       label: "Teachers",     icon: "people",           color: "#4F46E5" },
    { key: "unassignedTeachers",  label: "Unassigned",   icon: "person-remove",    color: "#DC2626" },
  ],
  [
    { key: "totalClasses",        label: "Classes",      icon: "school",           color: "#7C3AED" },
    { key: "totalSubjects",       label: "Subjects",     icon: "book",             color: "#059669" },
    { key: "assignedSubjects",    label: "Assigned",     icon: "git-branch",       color: "#DB2777" },
    { key: "activeAnnouncements", label: "Notices",      icon: "megaphone",        color: "#7C3AED" },
  ],
  [
    { key: "totalPeriods",             label: "Periods",      icon: "time",             color: "#4F46E5" },
    { key: "incompleteTimetableSlots", label: "No Timetable", icon: "calendar-outline", color: "#DC2626" },
    { key: "timetableConflicts",       label: "Conflicts",    icon: "warning",          color: "#DC2626" },
    { key: "classesWithoutSubjects",   label: "No Subjects",  icon: "alert-circle",     color: "#D97706" },
  ],
];

const ALERT_STYLES = {
  danger:  { bg: "#FEE2E2", icon: "#DC2626", text: "#991B1B" },
  warning: { bg: "#FEF3C7", icon: "#D97706", text: "#92400E" },
  info:    { bg: "#DBEAFE", icon: "#2563EB", text: "#1E40AF" },
};

const MODULES_PREVIEW_COUNT = 7;

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
};

// ─────────────────────────────────────────────────────────
// SCHOOL BANNER
// ─────────────────────────────────────────────────────────

const SchoolBanner = React.memo(({ school }) => {
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
          <Ionicons name="school" size={22} color="#4F46E5" />
        </View>
      )}

      <View style={{ flex: 1 }}>
        <Text style={sb.schoolName} numberOfLines={1}>
          {school.name}
        </Text>
        {!!location && (
          <Text style={sb.location} numberOfLines={1}>
            <Ionicons name="location-outline" size={11} color="#6B7280" />
            {" "}{location}
          </Text>
        )}
        {!!school.motto && (
          <Text style={sb.motto} numberOfLines={1}>
            "{school.motto}"
          </Text>
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
    marginTop:         16,
    marginBottom:      4,
    borderRadius:      14,
    paddingHorizontal: 14,
    paddingVertical:   12,
    gap:               12,
    borderWidth:       1,
    borderColor:       "#C7D2FE",
  },
  logo: {
    width:           44,
    height:          44,
    borderRadius:    10,
    backgroundColor: "#fff",
  },
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
  motto: {
    fontSize:   11,
    color:      "#4F46E5",
    fontStyle:  "italic",
    marginTop:  2,
    fontWeight: "500",
  },
});

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

const StatCard = React.memo(({ item, value }) => (
  <View style={[styles.statCard, { backgroundColor: item.color + "15" }]}>
    <Ionicons name={item.icon} size={18} color={item.color} />
    <Text style={styles.statNumber}>{value}</Text>
    <Text style={styles.statLabel}>{item.label}</Text>
  </View>
));

const AlertRow = React.memo(({ alert, onPress }) => {
  const st = ALERT_STYLES[alert.type] ?? ALERT_STYLES.info;
  return (
    <TouchableOpacity
      style={[styles.alertCard, { backgroundColor: st.bg }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Ionicons name={alert.icon} size={18} color={st.icon} />
      <Text style={[styles.alertText, { color: st.text }]}>
        {alert.message}
      </Text>
      <Ionicons name="chevron-forward" size={16} color={st.icon} />
    </TouchableOpacity>
  );
});

const ActionButton = React.memo(({ action, onPress }) => (
  <TouchableOpacity
    style={styles.actionButton}
    onPress={onPress}
    activeOpacity={0.75}
  >
    <View style={[styles.actionIconWrap, { backgroundColor: action.color + "15" }]}>
      <Ionicons name={action.icon} size={22} color={action.color} />
    </View>
    <Text style={styles.actionTitle} numberOfLines={2}>
      {action.title}
    </Text>
  </TouchableOpacity>
));

const ModuleRow = React.memo(({ module, onPress }) => (
  <TouchableOpacity
    style={styles.moduleCard}
    onPress={onPress}
    activeOpacity={0.75}
  >
    <View style={[styles.moduleIconWrap, { backgroundColor: module.color + "15" }]}>
      <Ionicons name={module.icon} size={20} color={module.color} />
    </View>
    <View style={styles.moduleInfo}>
      <Text style={styles.moduleTitle}>{module.title}</Text>
      <Text style={styles.moduleDesc}>{module.description}</Text>
    </View>
    <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
  </TouchableOpacity>
));

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const logout   = useAuthStore((s) => s.logout);
  const schoolId = useAuthStore((s) => s.user?.schoolId);

  const [stats,          setStats]          = useState(null);
  const [school,         setSchool]         = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [error,          setError]          = useState(null);
  const [showAllModules, setShowAllModules] = useState(false);
  const [greeting,       setGreeting]       = useState(getGreeting);
  const [overwriteCount, setOverwriteCount] = useState(0);

  const mountedRef         = useRef(true);
  const initialLoadDoneRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Core data loader ──────────────────────────────────
  const loadStats = useCallback(
    async (isRefresh = false, forceSync = false) => {
      try {
        setError(null);
        if (isRefresh) setRefreshing(true);
        else           setLoading(true);

        const [data, schoolData, owCount] = await Promise.all([
          (async () => {
            await syncTeacherAssignments(forceSync);
            // Counts come from SQLite — the same source every feature screen
            // reads — so the dashboard and the screens can no longer disagree.
            // Pull-to-refresh syncs first, then recounts.
            return getAdminStats({ refresh: isRefresh });
          })(),
          getSchoolInfo(schoolId),
          SyncOverwriteService.getUnseenCount(schoolId),
        ]);

        if (!mountedRef.current) return;

        setStats({
          ...data,
          assignedSubjects:
            data?.assignedSubjects ?? data?.totalAssignments ?? 0,
        });

        if (schoolData) setSchool(schoolData);
        setOverwriteCount(owCount);

      } catch (err) {
        console.error("Dashboard stats error:", err);
        if (!mountedRef.current) return;
        setError("Failed to load dashboard data. Pull down to retry.");
      } finally {
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
        initialLoadDoneRef.current = true;
      }
    },
    [schoolId]
  );

  // Initial load on mount
  useEffect(() => {
    loadStats(false, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh every time the screen comes into focus (after first load)
  useFocusEffect(
    useCallback(() => {
      if (!initialLoadDoneRef.current) return;
      setGreeting(getGreeting());
      loadStats(true, true);
    }, [loadStats])
  );

  // ── Navigation helper ─────────────────────────────────
  const navigate = useCallback(
    (path, title) => {
      if (!path) {
        Alert.alert("Navigation Error", `No route defined for "${title}".`);
        return;
      }
      router.push(path);
    },
    [router]
  );

  // ── Logout ────────────────────────────────────────────
  const handleLogout = useCallback(() => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
      { text: "Cancel", style: "cancel" },
      {
        text:    "Logout",
        style:   "destructive",
        onPress: async () => {
          await logout();
          router.replace("/auth/login");
        },
      },
    ]);
  }, [logout, router]);

  // ── Derived alerts ────────────────────────────────────
  const alerts = useMemo(() => {
    if (!stats) return [];
    const list = [];

    if (stats.stalePendingApps > 0) {
      list.push({
        id:      "stale",
        type:    "danger",
        icon:    "alert-circle-outline",
        message: `${stats.stalePendingApps} application${
          stats.stalePendingApps > 1 ? "s" : ""
        } pending over 3 days`,
        route:   "/admin/students/applications",
      });
    }

    if (stats.unassignedTeachers > 0) {
      list.push({
        id:      "unassigned",
        type:    "warning",
        icon:    "people-outline",
        message: `${stats.unassignedTeachers} teacher${
          stats.unassignedTeachers > 1 ? "s" : ""
        } not yet assigned`,
        route:   "/admin/assignments",
      });
    }

    if (stats.classesWithoutSubjects > 0) {
      list.push({
        id:      "missing-subjects",
        type:    "warning",
        icon:    "book-outline",
        message: `${stats.classesWithoutSubjects} class${
          stats.classesWithoutSubjects > 1 ? "es" : ""
        } missing subjects`,
        route:   "/admin/subjects",
      });
    }

    if (stats.timetableConflicts > 0) {
      list.push({
        id:      "conflicts",
        type:    "danger",
        icon:    "warning-outline",
        message: `${stats.timetableConflicts} timetable conflict${
          stats.timetableConflicts > 1 ? "s" : ""
        } detected`,
        route:   "/admin/timetable",
      });
    }

    if (
      stats.incompleteTimetableSlots > 0 &&
      stats.totalClasses             > 0
    ) {
      const pct = Math.round(
        (stats.incompleteTimetableSlots / stats.totalClasses) * 100
      );
      if (pct > 50) {
        list.push({
          id:      "timetable-incomplete",
          type:    "info",
          icon:    "calendar-outline",
          message: `${stats.incompleteTimetableSlots} class${
            stats.incompleteTimetableSlots > 1 ? "es" : ""
          } without timetable (${pct}%)`,
          route:   "/admin/timetable",
        });
      }
    }

    if (
      stats.assignedSubjects === 0 &&
      stats.totalTeachers    >  0  &&
      stats.totalSubjects    >  0
    ) {
      list.push({
        id:      "no-assignments",
        type:    "warning",
        icon:    "git-branch-outline",
        message: "No teacher assignments yet — assign teachers to subjects",
        route:   "/admin/assignments",
      });
    }

    if (overwriteCount > 0) {
      list.push({
        id:      "sync-overwrites",
        type:    "warning",
        icon:    "sync-outline",
        message: `${overwriteCount} sync overwrite${
          overwriteCount > 1 ? "s" : ""
        } — your edits were replaced`,
        route:   "/admin/sync-overwrites",
      });
    }

    return list;
  }, [stats, overwriteCount]);

  const statValue = useCallback(
    (key) => stats?.[key] ?? 0,
    [stats]
  );

  const visibleModules = useMemo(
    () =>
      showAllModules
        ? ALL_MODULES
        : ALL_MODULES.slice(0, MODULES_PREVIEW_COUNT),
    [showAllModules]
  );

  // ── Loading screen ────────────────────────────────────
  if (loading && !stats) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading dashboard…</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* ── Header ───────────────────────────────────── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Text style={styles.userName} numberOfLines={1}>
            {user?.name || "Admin"}
          </Text>
          <Text style={styles.subtitle}>Control Center</Text>
        </View>
        <TouchableOpacity
          onPress={() => navigate("/admin/settings", "Settings")}
          activeOpacity={0.75}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="person-circle-outline" size={46} color="#4F46E5" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadStats(true, true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* ── School Banner ─────────────────────────── */}
        <SchoolBanner school={school} />

        {/* ── Error Banner ──────────────────────────── */}
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color="#991B1B" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadStats(false, true)}
              activeOpacity={0.75}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── System Health Stats ───────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>System Health</Text>
          {STAT_ROWS.map((row) => (
            <View
              key={row.map((s) => s.key).join("-")}
              style={styles.statsRow}
            >
              {row.map((s) => (
                <StatCard key={s.key} item={s} value={statValue(s.key)} />
              ))}
            </View>
          ))}
        </View>

        {/* ── Alerts ────────────────────────────────── */}
        {alerts.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Alerts{" "}
              <Text style={styles.alertBadge}>({alerts.length})</Text>
            </Text>
            {alerts.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                onPress={() => navigate(a.route, "Alert")}
              />
            ))}
          </View>
        )}

        {/* ── Quick Actions ─────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            {QUICK_ACTIONS.map((a) => (
              <ActionButton
                key={a.id}
                action={a}
                onPress={() => navigate(a.route, a.title)}
              />
            ))}
          </View>
        </View>

        {/* ── Modules ───────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Modules</Text>
          {visibleModules.map((m) => (
            <ModuleRow
              key={m.id}
              module={m}
              onPress={() => navigate(m.route, m.title)}
            />
          ))}
          {ALL_MODULES.length > MODULES_PREVIEW_COUNT && (
            <TouchableOpacity
              style={styles.showMoreBtn}
              onPress={() => setShowAllModules((v) => !v)}
              activeOpacity={0.75}
            >
              <Text style={styles.showMoreText}>
                {showAllModules
                  ? "Show Less"
                  : `Show ${ALL_MODULES.length - MODULES_PREVIEW_COUNT} More`}
              </Text>
              <Ionicons
                name={showAllModules ? "chevron-up" : "chevron-down"}
                size={14}
                color="#4F46E5"
              />
            </TouchableOpacity>
          )}
        </View>

        {/* ── Logout ────────────────────────────────── */}
        <TouchableOpacity
          style={styles.logout}
          onPress={handleLogout}
          activeOpacity={0.75}
        >
          <Ionicons name="log-out-outline" size={18} color="#DC2626" />
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F3F4F6",
    gap:             10,
  },
  loadingText:   { color: "#6B7280", fontSize: 14 },
  scrollContent: { paddingBottom: 20 },

  // ── Header ─────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  greeting: { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  userName: { fontSize: 22, fontWeight: "700", color: "#111827", marginTop: 2 },
  subtitle: { fontSize: 13, color: "#4F46E5", fontWeight: "600", marginTop: 2 },

  // ── Error banner ───────────────────────────────────────
  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FEE2E2",
    margin:          16,
    padding:         12,
    borderRadius:    10,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  // ── Sections ───────────────────────────────────────────
  section:      { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 12,
  },
  alertBadge: { fontSize: 14, color: "#DC2626", fontWeight: "600" },

  // ── Stat cards ─────────────────────────────────────────
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  statCard: {
    flex:         1,
    padding:      12,
    borderRadius: 12,
    alignItems:   "center",
    gap:          4,
  },
  statNumber: { fontSize: 20, fontWeight: "700", color: "#111827" },
  statLabel:  { fontSize: 11, color: "#6B7280", textAlign: "center" },

  // ── Alert rows ─────────────────────────────────────────
  alertCard: {
    flexDirection: "row",
    alignItems:    "center",
    padding:       12,
    borderRadius:  10,
    marginBottom:  8,
    gap:           10,
  },
  alertText: { flex: 1, fontSize: 13, fontWeight: "500" },

  // ── Quick action grid ──────────────────────────────────
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionButton: {
    flexBasis:       "30%",
    flexGrow:        1,
    alignItems:      "center",
    backgroundColor: "#FFFFFF",
    borderRadius:    14,
    padding:         14,
    gap:             8,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  actionIconWrap: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  actionTitle: {
    fontSize:   11,
    textAlign:  "center",
    color:      "#374151",
    fontWeight: "600",
  },

  // ── Module rows ────────────────────────────────────────
  moduleCard: {
    flexDirection:   "row",
    alignItems:      "center",
    padding:         14,
    backgroundColor: "#FFFFFF",
    borderRadius:    12,
    marginBottom:    8,
    gap:             12,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  moduleIconWrap: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  moduleInfo:  { flex: 1 },
  moduleTitle: { fontSize: 14, fontWeight: "600", color: "#111827" },
  moduleDesc:  { fontSize: 12, color: "#6B7280", marginTop: 2 },

  // ── Show more / less ───────────────────────────────────
  showMoreBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 12,
    gap:             4,
  },
  showMoreText: { color: "#4F46E5", fontWeight: "600", fontSize: 13 },

  // ── Logout ─────────────────────────────────────────────
  logout: {
    flexDirection:   "row",
    justifyContent:  "center",
    alignItems:      "center",
    padding:         14,
    backgroundColor: "#FEE2E2",
    margin:          16,
    marginTop:       8,
    borderRadius:    12,
    gap:             8,
    borderWidth:     1,
    borderColor:     "#FECACA",
  },
  logoutText: { color: "#DC2626", fontWeight: "700", fontSize: 14 },
});