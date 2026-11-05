// app/admin/students/approved.js
// Renamed conceptually to t("approvedStudents.tabAll") but kept at same path for routing compat.
// Now mirrors the web StudentsPage: status tabs, class filter, honest count label.

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
  SectionList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  TextInput,
  RefreshControl,
  Alert,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons }  from "@expo/vector-icons";
import { StudentService } from "../../../src/services/student.service";
import { getStudentStatusConfig } from "../../../src/utils/studentStatus";
import { useTranslation } from "../../../src/i18n/useTranslation";
import {
  COLORS, ACCENT, SEMANTIC, TONE_EDGE, levelAccent, accentBadge, statusBadge,
} from "../../../src/theme/colors";
import { HeaderIcon } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// COLORS  (unchanged)
// ─────────────────────────────────────────────────────────

// Students are blue; status colours are the semantic tones (theme/colors.js).
const C = {
  primary:     ACCENT.blue.solid,
  primaryBg:   ACCENT.blue.wash,
  primaryDeep: ACCENT.blue.deep,
  success:     ACCENT.green.solid,
  successBg:   SEMANTIC.success.bg,
  warning:     ACCENT.amber.solid,
  warningBg:   SEMANTIC.warning.bg,
  error:       ACCENT.red.solid,
  errorBg:     SEMANTIC.error.bg,
  info:        ACCENT.sky.solid,
  infoBg:      ACCENT.sky.wash,
  white:       COLORS.surface,
  gray50:      COLORS.page,
  gray100:     ACCENT.slate.wash,
  gray200:     COLORS.border,
  gray400:     COLORS.textMuted,
  gray500:     COLORS.textSecondary,
  gray700:     COLORS.text,
  gray900:     COLORS.text,
};

/** A status's badge tone: active is good news, pending waits, the rest are bad news. */
const STATUS_TONE = {
  approved:  "success",
  pending:   "warning",
  suspended: "error",
  rejected:  "error",
  inactive:  "error",
};
const statusTone = (key) => STATUS_TONE[key] ?? "info";
const COUNT_BADGE = accentBadge("blue");

// ─────────────────────────────────────────────────────────
// CONSTANTS  — mirrors web STATUS_OPTIONS exactly
// ─────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  {
    key:   "all",
    labelKey: "common.all",
    icon:  "people-outline",
    color: C.primary,
    bg:    C.primaryBg,
  },
  {
    key:   "approved",
    labelKey: "common.active",
    icon:  "checkmark-circle-outline",
    color: C.success,
    bg:    C.successBg,
  },
  {
    key:   "pending",
    labelKey: "common.pending",
    icon:  "time-outline",
    color: C.warning,
    bg:    C.warningBg,
  },
  {
    key:   "suspended",
    labelKey: "approvedStudents.suspended",
    icon:  "ban-outline",
    color: C.error,
    bg:    C.errorBg,
  },
  {
    key:   "rejected",
    labelKey: "approvedStudents.rejected",
    icon:  "close-circle-outline",
    color: C.error,
    bg:    C.errorBg,
  },
];

const PAGE_LIMIT = 200; // large page → fetch all in one shot for client-side UX
const MAX_PAGES  = 20;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const getDisplayName = (student, t) => {
                         return student.name ||
  [student.firstName, student.lastName].filter(Boolean).join(" ") ||
  t("approvedStudents.unknownStudent");
                       };

/**
 * Maps a status value → { label, color, bg }
 * Mirrors web statusLabel() + statusVariant() combined.
 */
const getStatusConfig = getStudentStatusConfig;

/**
 * Mirrors web resolveClassName():
 * prefers nested `class.name`, falls back to flat `className`.
 */
const resolveClassName = (student, t) => {
                           return student?.class?.name ?? student?.className ?? t("approvedStudents.unassigned");
                         };

/**
 * Mirrors web countLabel(): honest, filter-aware count string.
 */
const buildCountLabel = (total, statusKey) => {
  const noun = total !== 1 ? "students" : "student";
  switch (statusKey) {
    case "all":       return `${total} ${noun} registered`;
    case "approved":  return `${total} active ${noun}`;
    case "pending":   return `${total} pending ${noun}`;
    case "suspended": return `${total} suspended ${noun}`;
    case "rejected":  return `${total} rejected ${noun}`;
    default:          return `${total} ${noun}`;
  }
};

/**
 * Fetches ALL students (any status) across paginated API pages.
 * Passes `status` through so the backend can pre-filter when possible;
 * "all" → backend returns everything (matching web toQueryStatus logic).
 */
const fetchAllStudents = async (statusKey = "all") => {
  let page     = 1;
  let combined = [];
  let total    = Infinity;

  while (page <= MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const res = await StudentService.getStudents({
      page,
      limit:  PAGE_LIMIT,
      status: statusKey,          // "all" | "approved" | "pending" | …
    });

    // Support both legacy array shape and paginated object shape
    const list = Array.isArray(res)
      ? res
      : res?.students ?? res?.data ?? [];

    combined = combined.concat(list);

    total = Array.isArray(res)
      ? combined.length
      : res?.total ?? res?.pagination?.total ?? combined.length;

    const gotFullPage = list.length === PAGE_LIMIT;
    const moreToFetch = combined.length < total;

    if (!gotFullPage || !moreToFetch) break;
    page += 1;
  }

  return { students: combined, total: combined.length };
};

// ─────────────────────────────────────────────────────────
// STATUS FILTER TABS  — mirrors web <Select> for status
// ─────────────────────────────────────────────────────────

const StatusFilterTabs = React.memo(({ activeKey, counts, onChange }) => {
  const { t } = useTranslation();
  return (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    style={styles.tabsScroll}
    contentContainerStyle={styles.tabsContent}
  >
    {STATUS_FILTERS.map((filter) => {
      const isActive = activeKey === filter.key;
      const count    = counts[filter.key] ?? 0;

      return (
        <TouchableOpacity
          key={filter.key}
          style={[
            styles.tab,
            isActive && { backgroundColor: filter.color, borderColor: filter.color },
          ]}
          onPress={() => onChange(filter.key)}
          activeOpacity={0.75}
        >
          <Ionicons
            name={filter.icon}
            size={13}
            color={isActive ? C.white : filter.color}
          />
          <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
            {filter.labelKey ? t(filter.labelKey) : filter.label}
          </Text>
          {/* Count badge — only show when > 0 */}
          {count > 0 && (
            <View
              style={[
                styles.tabBadge,
                { backgroundColor: isActive ? "rgba(255,255,255,0.30)" : filter.bg },
              ]}
            >
              <Text
                style={[
                  styles.tabBadgeText,
                  { color: isActive ? C.white : filter.color },
                ]}
              >
                {count}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      );
    })}
  </ScrollView>
  );
});

// ─────────────────────────────────────────────────────────
// CLASS FILTER PILLS  — mirrors web <Select> for classId
// ─────────────────────────────────────────────────────────

const ClassFilterPills = React.memo(({ classes, activeClass, onChange }) => {
  const { t } = useTranslation();
  if (classes.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.pillsScroll}
      contentContainerStyle={styles.pillsContent}
    >
      {/* t("approvedStudents.allClasses") reset pill */}
      <TouchableOpacity
        style={[
          styles.classPillBtn,
          !activeClass && styles.classPillBtnActive,
        ]}
        onPress={() => onChange("")}
        activeOpacity={0.75}
      >
        <Text
          style={[
            styles.classPillBtnText,
            !activeClass && styles.classPillBtnTextActive,
          ]}
        >
          {t("approvedStudents.allClasses")}
        </Text>
      </TouchableOpacity>

      {classes.map((cls) => (
        <TouchableOpacity
          key={cls}
          style={[
            styles.classPillBtn,
            activeClass === cls && styles.classPillBtnActive,
          ]}
          onPress={() => onChange(cls)}
          activeOpacity={0.75}
        >
          <Text
            style={[
              styles.classPillBtnText,
              activeClass === cls && styles.classPillBtnTextActive,
            ]}
          >
            {cls}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
});

// ─────────────────────────────────────────────────────────
// STUDENT CARD  (expanded status palette)
// ─────────────────────────────────────────────────────────

const StudentCard = React.memo(({ student, onPress }) => {
  const { t } = useTranslation();
  const displayName  = getDisplayName(student, t);
  const firstLetter  = displayName.charAt(0).toUpperCase() || "?";
  const statusConfig = getStatusConfig(student.status);
  const className    = resolveClassName(student, t);
  const isSuspended  = student.status === "suspended";
  const isRejected   = student.status === "rejected";
  const isPending    = student.status === "pending";
  const statusColors = statusBadge(statusTone(statusConfig.key));
  const classColors  = accentBadge(levelAccent(student?.class?.level ?? student?.classLevel));

  // Card border tint by status
  const cardStyle = [
    styles.card,
    isSuspended && styles.cardSuspended,
    isRejected  && styles.cardRejected,
    isPending   && styles.cardPending,
  ];

  // Avatar background by status
  const avatarBg = isSuspended
    ? C.error
    : isRejected
    ? C.error
    : isPending
    ? C.warning
    : C.primary;

  const avatarFg = COLORS.onPrimary;

  return (
    <TouchableOpacity style={cardStyle} onPress={onPress} activeOpacity={0.72}>
      <View style={styles.cardInner}>

        {/* Avatar */}
        <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
          <Text style={[styles.avatarText, { color: avatarFg }]}>
            {firstLetter}
          </Text>
        </View>

        {/* Info */}
        <View style={styles.studentInfo}>
          <Text style={styles.studentName} numberOfLines={1}>
            {displayName}
          </Text>

          {/* Sub-line: email › phone › admission no */}
          {student.email ? (
            <View style={styles.metaRow}>
              <Ionicons name="mail-outline" size={12} color={C.primary} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.email}
              </Text>
            </View>
          ) : student.phone ? (
            <View style={styles.metaRow}>
              <Ionicons name="call-outline" size={12} color={C.primary} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.phone}
              </Text>
            </View>
          ) : (student.admissionNumber || student.admissionNo) ? (
            <View style={styles.metaRow}>
              <Ionicons name="card-outline" size={12} color={C.primary} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.admissionNumber || student.admissionNo}
              </Text>
            </View>
          ) : null}

          {/* Class pill (only when a real class is assigned) */}
          {className !== t("approvedStudents.unassigned") && (
            <View style={[styles.classPill, { backgroundColor: classColors.bg, borderColor: classColors.border }]}>
              <Ionicons name="school-outline" size={10} color={classColors.text} />
              <Text style={[styles.classPillText, { color: classColors.text }]} numberOfLines={1}>
                {className}
              </Text>
            </View>
          )}
        </View>

        {/* Right: status badge + chevron */}
        <View style={styles.cardRight}>
          <View style={[styles.statusBadge, { backgroundColor: statusColors.bg, borderColor: statusColors.border }]}>
            <Text style={[styles.statusText, { color: statusColors.text }]}>
              {statusConfig.labelKey ? t(statusConfig.labelKey) : statusConfig.label}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={C.gray500}
            style={styles.chevron}
          />
        </View>

      </View>
    </TouchableOpacity>
  );
});

// ─────────────────────────────────────────────────────────
// SECTION HEADER  (unchanged)
// ─────────────────────────────────────────────────────────

const SectionHeader = React.memo(({ title, count }) => (
  <View style={styles.sectionHeader}>
    <View style={styles.sectionLeft}>
      <Ionicons name="school-outline" size={14} color={ACCENT.indigo.solid} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
    <View style={styles.countBadge}>
      <Text style={styles.countText}>{count}</Text>
    </View>
  </View>
));

// ─────────────────────────────────────────────────────────
// EMPTY STATE  (unchanged)
// ─────────────────────────────────────────────────────────

const EmptyState = React.memo(({ searchQuery }) => {
                                const { t } = useTranslation();
                                return (
  <View style={styles.emptyState}>
    <View style={styles.emptyIconWrap}>
      <Ionicons
        name={searchQuery ? "search-outline" : "people-outline"}
        size={40}
        color={COLORS.onPrimary}
      />
    </View>
    <Text style={styles.emptyTitle}>
      {searchQuery ? t("approvedStudents.noMatch") : t("approvedStudents.emptyTitle")}
    </Text>
    <Text style={styles.emptySubtitle}>
      {searchQuery
        ? t("approvedStudents.noMatchSub")
        : t("approvedStudents.emptySub")}
    </Text>
  </View>
);
                              });

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ApprovedStudents() {
  const { t } = useTranslation();
  const router       = useRouter();
  const isMountedRef = useRef(true);

  // Raw data fetched once (status="all") — client-side filtering keeps UX snappy
  const [allStudents,  setAllStudents]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);

  // Filter state — mirrors web page state
  const [searchQuery,  setSearchQuery]  = useState("");
  const [activeStatus, setActiveStatus] = useState("all");  // mirrors web default
  const [activeClass,  setActiveClass]  = useState("");     // "" = All Classes

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Fetch ────────────────────────────────────────────────────────────────

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      // Always fetch ALL statuses once so tab switches are instant (no refetch).
      // This mirrors the web page's behaviour of re-querying per status change,
      // but on mobile we optimise for offline-friendliness.
      const { students } = await fetchAllStudents("all");

      if (isMountedRef.current) setAllStudents(students);
    } catch (err) {
      console.error("Failed to load students:", err);
      if (isMountedRef.current)
        Alert.alert(t("approvedStudents.errTitle"), t("approvedStudents.loadFailed"));
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [t]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Navigate to detail  (unchanged) ─────────────────────────────────────

  const handleStudentPress = useCallback((student) => {
    const studentId = String(student._id || student.id || "");
    if (!studentId) {
      Alert.alert(t("approvedStudents.errTitle"), t("approvedStudents.idMissing"));
      return;
    }
    router.push({
      pathname: "/admin/students/detail",
      params:   { studentId },
    });
  }, [router, t]);

  // ── Derived: per-status counts  (mirrors web countLabel logic) ────────────

  const statusCounts = useMemo(() => {
    const counts = { all: allStudents.length };
    STATUS_FILTERS.slice(1).forEach(({ key }) => {
      counts[key] = allStudents.filter((s) => s.status === key).length;
    });
    return counts;
  }, [allStudents]);

  // ── Derived: unique class names for the class filter pills ───────────────

  const availableClasses = useMemo(() => {
    const set = new Set(
      allStudents
        .map(resolveClassName)
        .filter((n) => {
                  return n !== t("approvedStudents.unassigned");
                })
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allStudents, t]);

  // ── Derived: filtered + grouped sections ─────────────────────────────────

  const sections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = allStudents.filter((s) => {
      // 1. Status tab filter  — "all" passes everything (mirrors web toQueryStatus)
      const statusMatch =
        activeStatus === "all" || s.status === activeStatus;

      // 2. Class filter pill
      const classMatch =
        !activeClass || resolveClassName(s, t) === activeClass;

      // 3. Search  — mirrors web search fields: name, email, class, admissionNo
      const searchMatch = !query || (() => {
        const name  = getDisplayName(s, t).toLowerCase();
        const email = (s.email ?? "").toLowerCase();
        const cls   = resolveClassName(s, t).toLowerCase();
        const admNo = (
          s.admissionNumber ?? s.admissionNo ?? ""
        ).toLowerCase();
        return (
          name.includes(query)  ||
          email.includes(query) ||
          cls.includes(query)   ||
          admNo.includes(query)
        );
      })();

      return statusMatch && classMatch && searchMatch;
    });

    // Group by class name (matches web resolveClassName grouping)
    const grouped = {};
    filtered.forEach((student) => {
      const key = resolveClassName(student, t);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(student);
    });

    return Object.keys(grouped)
      .sort((a, b) => {
        if (a === t("approvedStudents.unassigned")) return  1;
        if (b === t("approvedStudents.unassigned")) return -1;
        return a.localeCompare(b);
      })
      .map((className) => ({
        title: className,
        data:  grouped[className],
      }));
  }, [searchQuery, allStudents, activeStatus, activeClass, t]);

  // ── Derived: visible student count for header ─────────────────────────────

  const visibleCount = sections.reduce((sum, s) => sum + s.data.length, 0);
  const countLabel   = buildCountLabel(visibleCount, activeStatus);

  // ── Total classes visible ─────────────────────────────────────────────────

  const visibleClasses = sections.length;

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={styles.loadingText}>{t("approvedStudents.loading")}</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={22} color={C.gray900} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("approvedStudents.title")}</Text>
          {/* Mirrors web countLabel() under the page heading */}
          <Text style={styles.headerSubtitle}>
            {countLabel}
            {visibleClasses > 0
              ? ` · ${t("academic.classCount", { count: visibleClasses })}`
              : ""}
          </Text>
        </View>
      </View>

      {/* ── STATUS FILTER TABS  (mirrors web status <Select>) ───────────── */}
      <View style={styles.tabsWrapper}>
        <StatusFilterTabs
          activeKey={activeStatus}
          counts={statusCounts}
          onChange={(key) => {
            setActiveStatus(key);
            setActiveClass("");    // reset class filter on status change
          }}
        />
      </View>

      {/* ── CLASS FILTER PILLS  (mirrors web class <Select>) ────────────── */}
      {availableClasses.length > 0 && (
        <View style={styles.pillsWrapper}>
          <ClassFilterPills
            classes={availableClasses}
            activeClass={activeClass}
            onChange={setActiveClass}
          />
        </View>
      )}

      {/* ── SEARCH  (unchanged) ─────────────────────────────────────────── */}
      <View style={styles.searchContainer}>
        <View style={styles.searchWrapper}>
          <Ionicons
            name="search"
            size={18}
            color={C.gray400}
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.searchInput}
            placeholder={t("approvedStudents.searchPh")}
            placeholderTextColor={C.gray400}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={C.gray400} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── LIST ────────────────────────────────────────────────────────── */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item._id || item.id)}
        renderItem={({ item }) => (
          <StudentCard
            student={item}
            onPress={() => handleStudentPress(item)}
          />
        )}
        renderSectionHeader={({ section }) => (
          <SectionHeader title={section.title} count={section.data.length} />
        )}
        ListEmptyComponent={<EmptyState searchQuery={searchQuery} />}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor={C.primary}
            colors={[C.primary]}
          />
        }
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: C.gray50 },
  loadingText: { marginTop: 12, fontSize: 14, color: C.gray500, fontWeight: "500" },
  listContent: { paddingBottom: 40 },

  // ── Header ──────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray200,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: C.white,
    borderWidth: 1,
    borderColor: C.gray200,
    alignItems: "center",
    justifyContent: "center",
  },
  headerIcon:     { marginLeft: 12, marginRight: 0 },
  headerCenter:   { flex: 1, marginLeft: 12 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: C.gray900 },
  headerSubtitle: { fontSize: 13, color: C.gray500, marginTop: 2 },

  // ── Status filter tabs ───────────────────────────────────────────────────
  tabsWrapper: {
    backgroundColor: C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    paddingVertical: 10,
  },
  tabsScroll:   { flexGrow: 0 },
  tabsContent:  { paddingHorizontal: 16, gap: 8 },

  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: C.gray200,
    backgroundColor: C.white,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: C.gray700,
  },
  tabLabelActive: {
    color: C.white,
  },
  tabBadge: {
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: "center",
  },
  tabBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },

  // ── Class filter pills ───────────────────────────────────────────────────
  pillsWrapper: {
    backgroundColor: C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    paddingVertical: 8,
  },
  pillsScroll:   { flexGrow: 0 },
  pillsContent:  { paddingHorizontal: 16, gap: 8 },

  classPillBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.gray200,
    backgroundColor: C.white,
  },
  classPillBtnActive: {
    backgroundColor: C.primaryBg,
    borderColor: ACCENT.blue.base,
  },
  classPillBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: C.gray500,
  },
  classPillBtnTextActive: {
    color: C.primaryDeep,
  },

  // ── Search ───────────────────────────────────────────────────────────────
  searchContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  searchWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.gray100,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon:  { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: C.gray900 },

  // ── Section header ───────────────────────────────────────────────────────
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
    backgroundColor: C.gray50,
  },
  sectionLeft:  { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: C.gray700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  countBadge: {
    backgroundColor: COUNT_BADGE.bg,
    borderWidth: 1,
    borderColor: COUNT_BADGE.border,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: { fontSize: 12, fontWeight: "700", color: COUNT_BADGE.text },

  // ── Student card ─────────────────────────────────────────────────────────
  card: {
    backgroundColor: ACCENT.blue.wash,
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.gray200,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.blue.base,
    overflow: "hidden",
  },
  // Status-specific card tints (mirrors web row highlight logic): the tone's edge
  cardSuspended: { borderColor: TONE_EDGE.error,   borderLeftColor: TONE_EDGE.error },
  cardRejected:  { borderColor: TONE_EDGE.error,   borderLeftColor: TONE_EDGE.error },
  cardPending:   { borderColor: TONE_EDGE.warning, borderLeftColor: TONE_EDGE.warning },

  cardInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 12,
  },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarText: { fontSize: 17, fontWeight: "700" },

  studentInfo:  { flex: 1, minWidth: 0, gap: 3 },
  studentName:  { fontSize: 15, fontWeight: "600", color: C.gray900 },
  metaRow:      { flexDirection: "row", alignItems: "center", gap: 4 },
  studentMeta:  { fontSize: 12, color: C.gray500, flex: 1 },

  classPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.primaryBg,
    borderWidth: 1,
    borderColor: C.gray200,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginTop: 2,
  },
  classPillText: { fontSize: 11, fontWeight: "700", color: C.primaryDeep },

  // ── Right: status badge + chevron ────────────────────────────────────────
  cardRight: {
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 6,
    flexShrink: 0,
  },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  statusText:  { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  chevron:     { marginTop: 2 },

  // ── Empty state ───────────────────────────────────────────────────────────
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 40,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: C.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle:    { fontSize: 18, fontWeight: "700", color: C.gray700, textAlign: "center" },
  emptySubtitle: {
    fontSize: 14,
    color: C.gray500,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 20,
  },
});