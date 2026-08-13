// app/admin/students/approved.js

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StudentService } from "../../../src/services/student.service";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#D1FAE5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEE2E2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const getDisplayName = (student) =>
  student.name ||
  [student.firstName, student.lastName].filter(Boolean).join(" ") ||
  "Unknown Student";

const getStatusConfig = (status) => {
  switch (status) {
    case "suspended":
      return { label: "Suspended", color: C.error,   bg: C.errorBg   };
    case "approved":
    default:
      return { label: "Approved",  color: C.success, bg: C.successBg };
  }
};

/**
 * Fetches ALL approved students across paginated pages.
 * Supports both legacy array shape and paginated object shape.
 */
const fetchAllApprovedStudents = async () => {
  const PAGE_LIMIT = 200;
  const MAX_PAGES  = 20;

  let page     = 1;
  let combined = [];
  let total    = Infinity;

  while (page <= MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const res = await StudentService.getApprovedStudents({ page, limit: PAGE_LIMIT });

    const list = Array.isArray(res)
      ? res
      : res?.students || res?.data || [];

    combined = combined.concat(list);

    total = Array.isArray(res)
      ? combined.length
      : res?.total ?? res?.pagination?.total ?? combined.length;

    const gotFullPage = list.length === PAGE_LIMIT;
    const moreToFetch = combined.length < total;

    if (!gotFullPage || !moreToFetch) break;
    page += 1;
  }

  return combined;
};

// ─────────────────────────────────────────────────────────
// STUDENT CARD  ← actions removed; tap opens detail screen
// ─────────────────────────────────────────────────────────

const StudentCard = React.memo(({ student, onPress }) => {
  const displayName  = getDisplayName(student);
  const firstLetter  = displayName.charAt(0).toUpperCase() || "?";
  const statusConfig = getStatusConfig(student.status);
  const isSuspended  = student.status === "suspended";

  return (
    <TouchableOpacity
      style={[styles.card, isSuspended && styles.cardSuspended]}
      onPress={onPress}
      activeOpacity={0.72}
    >
      <View style={styles.cardInner}>

        {/* ── Avatar ── */}
        <View style={[
          styles.avatar,
          { backgroundColor: isSuspended ? C.errorBg : C.primaryBg },
        ]}>
          <Text style={[
            styles.avatarText,
            { color: isSuspended ? C.error : C.primary },
          ]}>
            {firstLetter}
          </Text>
        </View>

        {/* ── Info ── */}
        <View style={styles.studentInfo}>
          <Text style={styles.studentName} numberOfLines={1}>
            {displayName}
          </Text>

          {/* Sub-line: email › phone › admission no */}
          {student.email ? (
            <View style={styles.metaRow}>
              <Ionicons name="mail-outline" size={12} color={C.gray400} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.email}
              </Text>
            </View>
          ) : student.phone ? (
            <View style={styles.metaRow}>
              <Ionicons name="call-outline" size={12} color={C.gray400} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.phone}
              </Text>
            </View>
          ) : student.admissionNo ? (
            <View style={styles.metaRow}>
              <Ionicons name="card-outline" size={12} color={C.gray400} />
              <Text style={styles.studentMeta} numberOfLines={1}>
                {student.admissionNo}
              </Text>
            </View>
          ) : null}

          {/* Class name pill */}
          {student.className && student.className !== "Unassigned" && (
            <View style={styles.classPill}>
              <Ionicons name="school-outline" size={10} color={C.primary} />
              <Text style={styles.classPillText} numberOfLines={1}>
                {student.className}
              </Text>
            </View>
          )}
        </View>

        {/* ── Right side: status badge + chevron ── */}
        <View style={styles.cardRight}>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.bg }]}>
            <Text style={[styles.statusText, { color: statusConfig.color }]}>
              {statusConfig.label}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={C.gray400}
            style={styles.chevron}
          />
        </View>

      </View>
    </TouchableOpacity>
  );
});

// ─────────────────────────────────────────────────────────
// SECTION HEADER
// ─────────────────────────────────────────────────────────

const SectionHeader = React.memo(({ title, count }) => (
  <View style={styles.sectionHeader}>
    <View style={styles.sectionLeft}>
      <Ionicons name="school-outline" size={14} color={C.primary} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
    <View style={styles.countBadge}>
      <Text style={styles.countText}>{count}</Text>
    </View>
  </View>
));

// ─────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────

const EmptyState = React.memo(({ searchQuery }) => (
  <View style={styles.emptyState}>
    <View style={styles.emptyIconWrap}>
      <Ionicons
        name={searchQuery ? "search-outline" : "people-outline"}
        size={40}
        color={C.gray400}
      />
    </View>
    <Text style={styles.emptyTitle}>
      {searchQuery ? "No matches found" : "No approved students yet"}
    </Text>
    <Text style={styles.emptySubtitle}>
      {searchQuery
        ? "Try adjusting your search term"
        : "Students will appear here once their applications are approved."}
    </Text>
  </View>
));

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ApprovedStudents() {
  const router       = useRouter();
  const isMountedRef = useRef(true);

  const [allStudents, setAllStudents] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Load ─────────────────────────────────────────────────

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const students = await fetchAllApprovedStudents();
      if (isMountedRef.current) setAllStudents(students || []);
    } catch (err) {
      console.error("Failed to load approved students:", err);
      if (isMountedRef.current) Alert.alert("Error", "Failed to load students");
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Navigate to detail ────────────────────────────────────

  const handleStudentPress = useCallback((student) => {
    const studentId = String(student._id || student.id || "");
    if (!studentId) {
      Alert.alert("Error", "Cannot open student — ID missing.");
      return;
    }
    router.push({
      pathname: "/admin/students/detail",
      params:   { studentId },
    });
  }, [router]);

  // ── Sections (filtered + grouped by class) ────────────────

  const sections = useMemo(() => {
    const query    = searchQuery.trim().toLowerCase();
    const filtered = query
      ? allStudents.filter((s) => {
          const name      = getDisplayName(s).toLowerCase();
          const email     = (s.email       || "").toLowerCase();
          const cls       = (s.className   || "").toLowerCase();
          const admission = (s.admissionNo || "").toLowerCase();
          return (
            name.includes(query)      ||
            email.includes(query)     ||
            cls.includes(query)       ||
            admission.includes(query)
          );
        })
      : allStudents;

    // Group by class
    const grouped = {};
    filtered.forEach((student) => {
      const key = student.className || "Unassigned";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(student);
    });

    return Object.keys(grouped)
      .sort((a, b) => {
        if (a === "Unassigned") return  1;
        if (b === "Unassigned") return -1;
        return a.localeCompare(b);
      })
      .map((className) => ({
        title: className,
        data:  grouped[className],
      }));
  }, [allStudents, searchQuery]);

  // ── Stats ─────────────────────────────────────────────────

  const totalStudents  = allStudents.length;
  const totalClasses   = new Set(
    allStudents.map((s) => s.className || "Unassigned")
  ).size;
  const totalSuspended = allStudents.filter(
    (s) => s.status === "suspended"
  ).length;

  // ── Loading ───────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={styles.loadingText}>Loading students…</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      {/* ── HEADER ──────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={22} color={C.gray900} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Approved Students</Text>
          <Text style={styles.headerSubtitle}>
            {totalStudents} students · {totalClasses} classes
            {totalSuspended > 0 ? ` · ${totalSuspended} suspended` : ""}
          </Text>
        </View>
      </View>

      {/* ── STAT CHIPS ──────────────────────────────────── */}
      <View style={styles.statRow}>
        <View style={[styles.statChip, { backgroundColor: C.primaryBg }]}>
          <Ionicons name="people-outline" size={14} color={C.primary} />
          <Text style={[styles.statChipText, { color: C.primary }]}>
            {totalStudents} Students
          </Text>
        </View>

        <View style={[styles.statChip, { backgroundColor: C.successBg }]}>
          <Ionicons name="school-outline" size={14} color={C.success} />
          <Text style={[styles.statChipText, { color: C.success }]}>
            {totalClasses} Classes
          </Text>
        </View>

        {totalSuspended > 0 && (
          <View style={[styles.statChip, { backgroundColor: C.errorBg }]}>
            <Ionicons name="ban-outline" size={14} color={C.error} />
            <Text style={[styles.statChipText, { color: C.error }]}>
              {totalSuspended} Suspended
            </Text>
          </View>
        )}
      </View>

      {/* ── SEARCH ──────────────────────────────────────── */}
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
            placeholder="Search by name, email, class or admission no…"
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

      {/* ── LIST ────────────────────────────────────────── */}
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

  // ── Header ───────────────────────────────────────────────
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  backButton: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: C.gray100,
    alignItems: "center", justifyContent: "center",
  },
  headerCenter:   { flex: 1, marginLeft: 12 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: C.gray900 },
  headerSubtitle: { fontSize: 13, color: C.gray500, marginTop: 2 },

  // ── Stat chips ────────────────────────────────────────────
  statRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 8,
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  statChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  statChipText: { fontSize: 12, fontWeight: "700" },

  // ── Search ────────────────────────────────────────────────
  searchContainer: {
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: C.white,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  searchWrapper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.gray100, borderRadius: 12,
    paddingHorizontal: 12, height: 44,
  },
  searchIcon:  { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: C.gray900 },

  // ── Section header ────────────────────────────────────────
  sectionHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
    backgroundColor: C.gray50,
  },
  sectionLeft:  { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: {
    fontSize: 13, fontWeight: "700", color: C.gray700,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  countBadge: {
    backgroundColor: C.gray200, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  countText: { fontSize: 12, fontWeight: "700", color: C.gray700 },

  // ── Student card ──────────────────────────────────────────
  card: {
    backgroundColor: C.white,
    marginHorizontal: 20, marginBottom: 8,
    borderRadius: 14, borderWidth: 1, borderColor: C.gray200,
    overflow: "hidden",
  },
  cardSuspended: { borderColor: "#FECACA", backgroundColor: "#FFFAFA" },
  cardInner: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 13,
    gap: 12,
  },

  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  avatarText: { fontSize: 17, fontWeight: "700" },

  studentInfo:  { flex: 1, minWidth: 0, gap: 3 },
  studentName:  { fontSize: 15, fontWeight: "600", color: C.gray900 },
  metaRow:      { flexDirection: "row", alignItems: "center", gap: 4 },
  studentMeta:  { fontSize: 12, color: C.gray500, flex: 1 },

  classPill: {
    alignSelf: "flex-start",
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: C.primaryBg, borderRadius: 8,
    paddingHorizontal: 7, paddingVertical: 3, marginTop: 2,
  },
  classPillText: { fontSize: 11, fontWeight: "700", color: C.primary },

  // ── Right side (status + chevron) ─────────────────────────
  cardRight: {
    alignItems: "flex-end", justifyContent: "center",
    gap: 6, flexShrink: 0,
  },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  statusText:  { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  chevron:     { marginTop: 2 },

  // ── Empty state ───────────────────────────────────────────
  emptyState: {
    alignItems: "center", justifyContent: "center",
    paddingVertical: 80, paddingHorizontal: 40,
  },
  emptyIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: C.gray100,
    alignItems: "center", justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle:    { fontSize: 18, fontWeight: "700", color: C.gray700, textAlign: "center" },
  emptySubtitle: {
    fontSize: 14, color: C.gray500,
    marginTop: 8, textAlign: "center", lineHeight: 20,
  },
});