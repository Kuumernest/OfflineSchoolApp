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
import { useSafeLogout }          from "../../../src/hooks/useSafeLogout";
import { getAdminStats }          from "../../../src/services/adminStats.service";
import { syncTeacherAssignments } from "../../../src/services/syncAssignments.service";
import { getSchoolInfo }          from "../../../src/services/school.service";
import SyncOverwriteService       from "../../../src/services/sync-overwrite.service";
import { toDisplayUri }           from "../../../src/utils/logoUri";

import { useTranslation } from "../../../src/i18n/useTranslation";
import { hasPermission, hasRole } from "../../../src/utils/authHelpers";
import { StatTile, ActionTile, TileIcon } from "../../../src/components/Tiles";
import { COLORS, SEMANTIC } from "../../../src/theme/colors";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

// Who sees which tile.
//
// Every tile carries a capability AND the roles that hold it by default. The
// capability is what decides, so a school that has granted its bursar
// gate.scan on the web console sees the gate tile appear here too. The role
// list is the fallback for a session stored before permissions were sent —
// which on an offline-first phone can be weeks old, and must keep working
// exactly as it did.
//
// Offering a tile that cannot work is worse than offering none: a control that
// 403s still looks like a promise the app made. The server remains the
// authority; these lists decide only what is drawn.
const ADMIN   = ["super_admin", "school_admin"];
const FINANCE = ["super_admin", "school_admin", "bursar"];

/**
 * Is this tile for this user?
 *
 * Capability where one exists, role where one does not. The gap is real rather
 * than laziness: classes, subjects, staff accounts and school settings all live
 * behind a single guard in the backend admin router, which has not been split
 * into per-module routers yet, so there is no capability to name for them. They
 * keep the role list, and a school cannot adjust them — which is exactly what
 * is true of them on the web console too.
 *
 * Either way the server decides. These lists only decide what is drawn.
 */
const visible = (item) =>
  item.permission
    ? hasPermission(item.permission, item.roles ?? [])
    : hasRole(item.roles ?? []);

const QUICK_ACTIONS = [
  // First for everyone, and the only reason a bursar opens this app: taking
  // cash at a desk with no signal.
  {
    id:    "collect-fees",
    kind:  "fees",
    // The one primary action on this screen: taking a payment is what the
    // office does most from a phone.
    primary: true,
    titleKey: "dashAdmin.qa_collect_fees",
    icon:  "cash-outline",
    route: "/admin/fees",
    roles: FINANCE,
    permission: "fees.manage",
  },
  {
    id:    "print-register",
    kind:  "attendance",
    titleKey: "dashAdmin.qa_print_register",
    icon:  "print-outline",
    route: "/admin/documents",
    roles: ADMIN,
    permission: "documents.print",
  },
  {
    id:    "gate-scan",
    kind:  "attendance",
    titleKey: "dashAdmin.qa_gate_scan",
    icon:  "qr-code-outline",
    route: "/admin/gate",
    roles: ADMIN,
    // Delegable, and the tile a small school is most likely to want moved.
    permission: "gate.scan",
  },
  {
    id:    "record-expense",
    kind:  "finance",
    titleKey: "dashAdmin.qa_record_expense",
    icon:  "receipt-outline",
    route: "/admin/finance/expenses",
    roles: FINANCE,
    permission: "expenses.manage",
  },
  {
    id:    "add-student",
    kind:  "students",
    titleKey: "dashAdmin.qa_add_student",
    icon:  "person-add-outline",
    route: "/admin/students/add",
    roles: ADMIN,
    permission: "students.manage",
  },
  {
    id:    "add-class",
    kind:  "classes",
    titleKey: "dashAdmin.qa_add_class",
    icon:  "add-circle-outline",
    route: "/admin/classes/add",
    roles: ADMIN,
  },
  {
    id:    "add-subject",
    kind:  "subjects",
    titleKey: "dashAdmin.qa_add_subject",
    icon:  "add-circle-outline",
    route: "/admin/subjects/add",
    roles: ADMIN,
  },
  {
    id:    "add-teacher",
    kind:  "teachers",
    titleKey: "dashAdmin.qa_add_teacher",
    icon:  "add-circle-outline",
    route: "/admin/teachers/add",
    roles: ADMIN,
  },
  {
    id:    "assign-teacher",
    kind:  "teachers",
    titleKey: "dashAdmin.qa_assign_teacher",
    icon:  "git-branch-outline",
    route: "/admin/assignments",
    roles: ADMIN,
    permission: "teachers.manage",
  },
  {
    id:    "review-apps",
    kind:  "students",
    titleKey: "dashAdmin.qa_review_apps",
    icon:  "clipboard-outline",
    route: "/admin/students/applications",
    roles: ADMIN,
    permission: "students.admit",
  },
  {
    id:    "build-timetable",
    kind:  "timetable",
    titleKey: "dashAdmin.qa_build_timetable",
    icon:  "time-outline",
    route: "/admin/timetable",
    roles: ADMIN,
    permission: "timetable.manage",
  },
];

const ALL_MODULES = [
  {
    id:          "fees",
    titleKey:    "dashAdmin.mod_fees",
    icon:        "cash-outline",
    kind:        "fees",
    route:       "/admin/fees",
    descKey:     "dashAdmin.modSub_fees",
    roles:       FINANCE,
    permission:  "fees.view",
  },
  {
    id:          "expenses",
    titleKey:    "dashAdmin.mod_expenses",
    icon:        "receipt-outline",
    kind:        "finance",
    route:       "/admin/finance/expenses",
    descKey:     "dashAdmin.modSub_expenses",
    roles:       FINANCE,
    permission:  "expenses.view",
  },
  {
    id:          "payroll",
    titleKey:    "dashAdmin.mod_payroll",
    icon:        "briefcase-outline",
    kind:        "finance",
    route:       "/admin/finance/payroll",
    descKey:     "dashAdmin.modSub_payroll",
    roles:       FINANCE,
    permission:  "payroll.view",
  },
  {
    id:          "fin-reports",
    titleKey:    "dashAdmin.mod_fin_reports",
    icon:        "stats-chart-outline",
    kind:        "finance",
    route:       "/admin/finance/reports",
    descKey:     "dashAdmin.modSub_fin_reports",
    roles:       FINANCE,
    permission:  "finance.reports",
  },
  {
    id:          "promotion",
    titleKey:    "dashAdmin.mod_promotion",
    icon:        "school-outline",
    kind:        "students",
    route:       "/admin/promotion",
    descKey:     "dashAdmin.modSub_promotion",
    roles:       ADMIN,
    permission:  "promotion.run",
  },
  {
    id:          "printing",
    titleKey:    "dashAdmin.mod_printing",
    icon:        "print-outline",
    kind:        "reports",
    route:       "/admin/documents",
    descKey:     "dashAdmin.modSub_printing",
    roles:       ADMIN,
    permission:  "documents.print",
  },
  {
    id:          "exports",
    titleKey:    "dashAdmin.mod_exports",
    icon:        "grid-outline",
    kind:        "reports",
    route:       "/admin/exports",
    descKey:     "dashAdmin.modSub_exports",
    roles:       FINANCE,
    // The screen itself asks the server which workbooks to offer, so this only
    // has to answer "is there anything here for you at all".
    permission:  "exports.roster",
  },
  {
    id:          "classes",
    titleKey:    "dashAdmin.mod_classes",
    icon:        "school-outline",
    kind:        "classes",
    route:       "/admin/classes",
    descKey:     "dashAdmin.modSub_classes",
    roles:       ADMIN,
  },
  {
    id:          "subjects",
    titleKey:    "dashAdmin.mod_subjects",
    icon:        "book-outline",
    kind:        "subjects",
    route:       "/admin/subjects",
    descKey:     "dashAdmin.modSub_subjects",
    roles:       ADMIN,
  },
  {
    id:          "teachers",
    titleKey:    "dashAdmin.mod_teachers",
    icon:        "people-outline",
    kind:        "teachers",
    route:       "/admin/teachers",
    descKey:     "dashAdmin.modSub_teachers",
    roles:       ADMIN,
  },
  {
    id:          "applications",
    titleKey:    "dashAdmin.mod_applications",
    icon:        "person-add-outline",
    kind:        "students",
    route:       "/admin/students/applications",
    descKey:     "dashAdmin.modSub_applications",
    roles:       ADMIN,
    permission:  "students.admit",
  },
  {
    id:          "students",
    titleKey:    "dashAdmin.mod_students",
    icon:        "people-circle-outline",
    kind:        "students",
    route:       "/admin/students/approved",
    descKey:     "dashAdmin.modSub_students",
    roles:       ADMIN,
  },
  {
    id:          "teacher-assignments",
    titleKey:    "dashAdmin.mod_teacher_assignments",
    icon:        "git-branch-outline",
    kind:        "teachers",
    route:       "/admin/assignments",
    descKey:     "dashAdmin.modSub_teacher_assignments",
    roles:       ADMIN,
    permission:  "teachers.manage",
  },
  {
    id:          "timetable",
    titleKey:    "dashAdmin.mod_timetable",
    icon:        "time-outline",
    kind:        "timetable",
    route:       "/admin/timetable",
    descKey:     "dashAdmin.modSub_timetable",
    roles:       ADMIN,
    permission:  "timetable.view",
  },
  {
    id:          "attendance",
    titleKey:    "dashAdmin.mod_attendance",
    icon:        "calendar-outline",
    kind:        "attendance",
    route:       "/admin/attendance",
    descKey:     "dashAdmin.modSub_attendance",
    roles:       ADMIN,
    // attendance.mark rather than attendance.view: this screen exists to mark a
    // register, and the bursar holds the read and not the write.
    permission:  "attendance.mark",
  },
  {
    id:          "exams",
    titleKey:    "dashAdmin.mod_exams",
    icon:        "trophy-outline",
    kind:        "exams",
    route:       "/admin/exams",
    descKey:     "dashAdmin.modSub_exams",
    roles:       ADMIN,
    permission:  "exams.view",
  },
  {
    id:          "announcements",
    titleKey:    "dashAdmin.mod_announcements",
    icon:        "megaphone-outline",
    kind:        "announcements",
    route:       "/admin/announcements",
    descKey:     "dashAdmin.modSub_announcements",
    roles:       ADMIN,
    permission:  "announcements.create",
  },
  {
    id:          "settings",
    titleKey:    "dashAdmin.mod_settings",
    icon:        "settings-outline",
    kind:        "settings",
    route:       "/admin/settings",
    descKey:     "dashAdmin.modSub_settings",
    roles:       ADMIN,
  },
];

// The same rule as the web console's Setup health: every tile wears its
// kind's tint and solid icon square; a count that is a problem turns its
// border and figure amber above zero (red for a timetable conflict).
const STAT_ROWS = [
  [
    { key: "pendingApplications", labelKey: "dashAdmin.hPending",      icon: "document-text",    kind: "students", toneWhenAny: "warning" },
    { key: "approvedStudents",    labelKey: "dashAdmin.sStudents",     icon: "people-circle",    kind: "students" },
    { key: "totalTeachers",       labelKey: "dashAdmin.sTeachers",     icon: "people",           kind: "teachers" },
    { key: "unassignedTeachers",  labelKey: "dashAdmin.hUnassigned",   icon: "person-remove",    kind: "teachers", toneWhenAny: "warning" },
  ],
  [
    { key: "totalClasses",        labelKey: "dashAdmin.sClasses",      icon: "school",           kind: "classes" },
    { key: "totalSubjects",       labelKey: "dashAdmin.sSubjects",     icon: "book",             kind: "subjects" },
    { key: "unassignedClassSubjects", labelKey: "dashAdmin.hNoTeacher", icon: "git-branch",       kind: "subjects", toneWhenAny: "warning" },
    { key: "activeAnnouncements", labelKey: "dashAdmin.hNotices",      icon: "megaphone",        kind: "announcements" },
  ],
  [
    { key: "totalPeriods",             labelKey: "dashAdmin.hPeriods",      icon: "time",             kind: "timetable" },
    { key: "incompleteTimetableSlots", labelKey: "dashAdmin.hNoTimetable", icon: "calendar-outline", kind: "timetable", toneWhenAny: "warning" },
    { key: "timetableConflicts",       labelKey: "dashAdmin.hConflicts",    icon: "warning",          kind: "timetable", toneWhenAny: "error" },
    { key: "classesWithoutSubjects",   labelKey: "dashAdmin.hNoSubjects",  icon: "alert-circle",     kind: "classes", toneWhenAny: "warning" },
  ],
];

const ALERT_STYLES = {
  danger:  { bg: SEMANTIC.error.box, icon: COLORS.danger, text: SEMANTIC.error.text },
  warning: { bg: SEMANTIC.warning.box, icon: COLORS.warning, text: SEMANTIC.warning.text },
  info:    { bg: SEMANTIC.info.box, icon: COLORS.info, text: SEMANTIC.info.text },
};

const MODULES_PREVIEW_COUNT = 7;

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────

// `t` is a parameter, not a hook call: getGreeting runs inside useState's
// initializer and inside useFocusEffect's callback, and a hook called from
// either is a rules-of-hooks violation that crashes the screen on mount.
// Same shape as getGreeting in teacher/dashboard.js.
const getGreeting = (t) => {
  const h = new Date().getHours();
  if (h < 12) return t("studentHome.greetingMorning");
  if (h < 17) return t("studentHome.greetingAfternoon");
  return t("studentHome.greetingEvening");
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
          <Ionicons name="school" size={22} color={COLORS.contextIcon} />
        </View>
      )}

      <View style={{ flex: 1 }}>
        <Text style={sb.schoolName} numberOfLines={1}>
          {school.name}
        </Text>
        {!!location && (
          <Text style={sb.location} numberOfLines={1}>
            <Ionicons name="location-outline" size={11} color={COLORS.textSubtle} />
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

// The school context bar: a light blue band, the same on every dashboard.
const sb = StyleSheet.create({
  banner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   COLORS.contextBg,
    marginHorizontal:  16,
    marginTop:         16,
    marginBottom:      4,
    borderRadius:      14,
    paddingHorizontal: 14,
    paddingVertical:   12,
    gap:               12,
    borderWidth:       1,
    borderColor:       COLORS.contextBorder,
  },
  logo: {
    width:           44,
    height:          44,
    borderRadius:    10,
    backgroundColor: COLORS.surface,
  },
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
  motto: {
    fontSize:   11,
    color:      COLORS.contextText,
    fontStyle:  "italic",
    marginTop:  2,
    fontWeight: "500",
  },
});

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

const StatCard = React.memo(({ item, value }) => {
  // Each memoised child owns its translation hook: none of these components
  // close over the screen's `t`, which does not exist at module scope.
  const { t } = useTranslation();
  return (
    <StatTile
      kind={item.kind}
      icon={item.icon}
      value={value}
      label={t(item.labelKey)}
      tone={item.toneWhenAny && Number(value) > 0 ? item.toneWhenAny : undefined}
    />
  );
});

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

const ActionButton = React.memo(({ action, onPress }) => {
  const { t } = useTranslation();
  return (
    <ActionTile
      primary={action.primary}
      kind={action.kind}
      icon={action.icon}
      label={t(action.titleKey)}
      style={styles.actionButton}
      onPress={onPress}
    />
  );
});

const ModuleRow = React.memo(({ module, onPress }) => {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={styles.moduleCard}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <TileIcon kind={module.kind} icon={module.icon} />
      <View style={styles.moduleInfo}>
        <Text style={styles.moduleTitle}>{t(module.titleKey)}</Text>
        <Text style={styles.moduleDesc}>{t(module.descKey)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
    </TouchableOpacity>
  );
});

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { t } = useTranslation();
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const safeLogout = useSafeLogout();
  const schoolId = useAuthStore((s) => s.user?.schoolId);

  const role = user?.role ?? null;

  // System Health and the alerts derived from it are the academic state of the
  // school: applications pending, teachers unassigned, timetable conflicts.
  // Every count behind them comes from admin-only data, and none of it is a
  // bursar concern. The flag turns off the fetch as well as the rendering —
  // showing the section and letting it fail would put a row of zeros on screen,
  // which reads as "nothing is wrong" rather than "you cannot see this".
  const showSchoolHealth = role !== "bursar";

  const [stats,          setStats]          = useState(null);
  const [school,         setSchool]         = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [error,          setError]          = useState(null);
  const [showAllModules, setShowAllModules] = useState(false);
  const [greeting,       setGreeting]       = useState(() => getGreeting(t));
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
            // Both of these read admin-only endpoints, so for a bursar they
            // are skipped rather than attempted: the assignment sync pulls the
            // teacher-to-class map, and the stats recount is of academic
            // records. Attempting them would cost two guaranteed 403s on every
            // pull-to-refresh and leave the error banner permanently up.
            if (!showSchoolHealth) return null;

            await syncTeacherAssignments(forceSync);
            // Counts come from SQLite — the same source every feature screen
            // reads — so the dashboard and the screens can no longer disagree.
            // Pull-to-refresh syncs first, then recounts.
            return getAdminStats({ refresh: isRefresh });
          })(),
          // School name and logo. Reachable by a bursar: it is the letterhead
          // on every receipt, and /admin/school-info is on the office
          // allowlist server-side for that reason.
          getSchoolInfo(schoolId),
          SyncOverwriteService.getUnseenCount(schoolId),
        ]);

        if (!mountedRef.current) return;

        setStats(
          data
            ? {
                ...data,
                assignedSubjects:
                  data?.assignedSubjects ?? data?.totalAssignments ?? 0,
              }
            // An empty object rather than null: the loading screen below waits
            // on stats being set, and a bursar never gets one.
            : {}
        );

        if (schoolData) setSchool(schoolData);
        setOverwriteCount(owCount);

      } catch (err) {
        console.error("Dashboard stats error:", err);
        if (!mountedRef.current) return;
        setError(t("dashAdmin.loadFailed"));
      } finally {
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
        initialLoadDoneRef.current = true;
      }
    },
    [schoolId, showSchoolHealth, t]
  );

  // Initial load on mount
  useEffect(() => {
    loadStats(false, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh every time the screen comes into focus (after first load)
  useFocusEffect(
    useCallback(() => {
      if (!initialLoadDoneRef.current) return;
      setGreeting(getGreeting(t));
      loadStats(true, true);
    }, [loadStats, t])
  );

  // ── Navigation helper ─────────────────────────────────
  const navigate = useCallback(
    (path, title) => {
      if (!path) {
        Alert.alert(t("dashAdmin.navErrTitle"), t("dashAdmin.navErrBody", { title }));
        return;
      }
      router.push(path);
    },
    [router, t]
  );

  // ── Logout ────────────────────────────────────────────
  // Warns first when this account has changes not yet sent.
  const handleLogout = useCallback(() => {
    safeLogout({
      title:        t("dashAdmin.logout"),
      body:         t("dashAdmin.logoutBody"),
      confirmLabel: t("dashAdmin.logout"),
    });
  }, [safeLogout, t]);

  // ── Derived alerts ────────────────────────────────────
  const alerts = useMemo(() => {
    if (!stats) return [];
    const list = [];

    // Sync overwrites are the exception and are appended at the end for
    // everybody: "your edits were replaced" is about the caller's own work, and
    // a bursar whose fee entry was overwritten needs to hear it more than
    // anyone. Everything between here and there is academic state.
    if (!showSchoolHealth) {
      if (overwriteCount > 0) {
        list.push({
          id:      "sync-overwrites",
          type:    "warning",
          icon:    "sync-outline",
          message: t("dashAdmin.syncOverwrites", { count: overwriteCount }),
          route:   "/admin/sync-overwrites",
        });
      }
      return list;
    }

    if (stats.stalePendingApps > 0) {
      list.push({
        id:      "stale",
        type:    "danger",
        icon:    "alert-circle-outline",
        message: t("dashAdmin.alertStaleApps", { count: stats.stalePendingApps }),
        route:   "/admin/students/applications",
      });
    }

    if (stats.unassignedTeachers > 0) {
      list.push({
        id:      "unassigned",
        type:    "warning",
        icon:    "people-outline",
        message: t("dashAdmin.alertUnassignedTeachers", { count: stats.unassignedTeachers }),
        route:   "/admin/assignments",
      });
    }

    // B4: class-subjects nobody teaches.
    if (stats.unassignedClassSubjects > 0) {
      list.push({
        id:      "class-subjects-unassigned",
        type:    "warning",
        icon:    "book-outline",
        message: t("dashAdmin.alertClassSubjectsUnassigned", { count: stats.unassignedClassSubjects }),
        route:   "/admin/assignments",
      });
    }

    if (stats.classesWithoutSubjects > 0) {
      list.push({
        id:      "missing-subjects",
        type:    "warning",
        icon:    "book-outline",
        message: t("dashAdmin.alertClassesNoSubjects", { count: stats.classesWithoutSubjects }),
        route:   "/admin/subjects",
      });
    }

    if (stats.timetableConflicts > 0) {
      list.push({
        id:      "conflicts",
        type:    "danger",
        icon:    "warning-outline",
        message: t("dashAdmin.alertConflicts", { count: stats.timetableConflicts }),
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
          message: t("dashAdmin.alertNoTimetable", { count: stats.incompleteTimetableSlots, pct }),
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
        message: t("dashAdmin.noAssignmentsHint"),
        route:   "/admin/assignments",
      });
    }

    if (overwriteCount > 0) {
      list.push({
        id:      "sync-overwrites",
        type:    "warning",
        icon:    "sync-outline",
        message: t("dashAdmin.syncOverwrites", { count: overwriteCount }),
        route:   "/admin/sync-overwrites",
      });
    }

    return list;
  }, [stats, showSchoolHealth, overwriteCount, t]);

  const statValue = useCallback(
    (key) => stats?.[key] ?? 0,
    [stats]
  );

// Recomputed when the role changes, which is also when a fresh sign-in has
  // replaced the stored permission list — the two arrive together.
  const quickActions = useMemo(
    () => QUICK_ACTIONS.filter(visible),
    [role]
  );

  const modules = useMemo(
    () => ALL_MODULES.filter(visible),
    [role]
  );

  const visibleModules = useMemo(
    () =>
      showAllModules
        ? modules
        : modules.slice(0, MODULES_PREVIEW_COUNT),
    [showAllModules, modules]
  );

  // ── Loading screen ────────────────────────────────────
  if (loading && !stats) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>{t("dashAdmin.loading")}</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      {/* ── Header ───────────────────────────────────── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Text style={styles.userName} numberOfLines={1}>
            {user?.name || t("dashAdmin.adminFallback")}
          </Text>
          <Text style={styles.subtitle}>
            {showSchoolHealth
              ? t("dashAdmin.controlCenter")
              : t("dashAdmin.financeCenter")}
          </Text>
          {role === "super_admin" && (
            <TouchableOpacity
              style={styles.schoolRow}
              onPress={() => router.push("/admin/school-picker")}
              activeOpacity={0.75}
            >
              <Ionicons name="business-outline" size={14} color={COLORS.primary} />
              <Text style={styles.schoolName} numberOfLines={1}>
                {t("schoolPick.inSchool", { name: user?.schoolName || "—" })}
              </Text>
              <Text style={styles.schoolChange}>{t("schoolPick.change")}</Text>
            </TouchableOpacity>
          )}
        </View>
        {showSchoolHealth && (
          <TouchableOpacity
            onPress={() => navigate("/admin/settings", t("dashAdmin.settings"))}
            activeOpacity={0.75}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="person-circle-outline" size={46} color={COLORS.primary} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadStats(true, true)}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
      >
        {/* ── School Banner ─────────────────────────── */}
        <SchoolBanner school={school} />

        {/* ── Error Banner ──────────────────────────── */}
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={SEMANTIC.error.text} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={() => loadStats(false, true)}
              activeOpacity={0.75}
            >
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── System Health Stats ───────────────────── */}
        {showSchoolHealth && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("dashAdmin.systemHealth")}</Text>
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
        )}

        {/* ── Alerts ────────────────────────────────── */}
        {alerts.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {t("dashAdmin.alerts")}{" "}
              <Text style={styles.alertBadge}>({alerts.length})</Text>
            </Text>
            {alerts.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                onPress={() => navigate(a.route, t("dashAdmin.alert"))}
              />
            ))}
          </View>
        )}

        {/* ── Quick Actions ─────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("dashAdmin.quickActions")}</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((a) => (
              <ActionButton
                key={a.id}
                action={a}
                onPress={() => navigate(a.route, t(a.titleKey))}
              />
            ))}
          </View>
        </View>

        {/* ── Modules ───────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("dashAdmin.modules")}</Text>
          {visibleModules.map((m) => (
            <ModuleRow
              key={m.id}
              module={m}
              onPress={() => navigate(m.route, t(m.titleKey))}
            />
          ))}
          {modules.length > MODULES_PREVIEW_COUNT && (
            <TouchableOpacity
              style={styles.showMoreBtn}
              onPress={() => setShowAllModules((v) => !v)}
              activeOpacity={0.75}
            >
              <Text style={styles.showMoreText}>
                {showAllModules
                  ? t("dashAdmin.showLess")
                  : t("dashAdmin.showMore", {
                      count: modules.length - MODULES_PREVIEW_COUNT,
                    })}
              </Text>
              <Ionicons
                name={showAllModules ? "chevron-up" : "chevron-down"}
                size={14}
                color={COLORS.primary}
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
          <Ionicons name="log-out-outline" size={18} color={COLORS.danger} />
          <Text style={styles.logoutText}>{t("dashAdmin.logout")}</Text>
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
  container:     { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: COLORS.page,
    gap:             10,
  },
  loadingText:   { color: COLORS.textSubtle, fontSize: 14 },
  scrollContent: { paddingBottom: 20 },

  // ── Header ─────────────────────────────────────────────
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
  greeting: { fontSize: 13, color: COLORS.textSubtle, fontWeight: "500" },
  userName: { fontSize: 22, fontWeight: "700", color: COLORS.text, marginTop: 2 },
  subtitle: { fontSize: 13, color: COLORS.primary, fontWeight: "600", marginTop: 2 },
  schoolRow:    { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  schoolName:   { flexShrink: 1, fontSize: 13, color: COLORS.text, fontWeight: "600" },
  schoolChange: { fontSize: 13, color: COLORS.primary, fontWeight: "700" },

  // ── Error banner ───────────────────────────────────────
  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: SEMANTIC.error.box,
    margin:          16,
    padding:         12,
    borderRadius:    10,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text, fontWeight: "500" },
  retryText: { fontSize: 13, color: COLORS.danger, fontWeight: "700" },

  // ── Sections ───────────────────────────────────────────
  section:      { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        COLORS.text,
    marginBottom: 12,
  },
  alertBadge: { fontSize: 14, color: COLORS.danger, fontWeight: "600" },

  // ── Stat cards ─────────────────────────────────────────
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
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
  actionButton: { flexBasis: "30%", flexGrow: 1 },

  // ── Module rows ────────────────────────────────────────
  moduleCard: {
    flexDirection:   "row",
    alignItems:      "center",
    padding:         14,
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    marginBottom:    8,
    gap:             12,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.08,
    shadowRadius:    6,
    shadowOffset:    { width: 0, height: 2 },
    elevation:       1,
  },
  moduleInfo:  { flex: 1 },
  moduleTitle: { fontSize: 14, fontWeight: "600", color: COLORS.text },
  moduleDesc:  { fontSize: 12, color: COLORS.textSubtle, marginTop: 2 },

  // ── Show more / less ───────────────────────────────────
  showMoreBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    paddingVertical: 12,
    gap:             4,
  },
  showMoreText: { color: COLORS.primary, fontWeight: "600", fontSize: 13 },

  // ── Logout ─────────────────────────────────────────────
  logout: {
    flexDirection:   "row",
    justifyContent:  "center",
    alignItems:      "center",
    padding:         14,
    backgroundColor: SEMANTIC.error.box,
    margin:          16,
    marginTop:       8,
    borderRadius:    12,
    gap:             8,
    borderWidth:     1,
    borderColor:     SEMANTIC.error.box,
  },
  logoutText: { color: COLORS.danger, fontWeight: "700", fontSize: 14 },
});