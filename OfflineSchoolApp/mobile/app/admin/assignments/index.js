// app/admin/assignments/index.js
"use strict";

import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
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
  TextInput,
  Alert,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons }                   from "@expo/vector-icons";
import {
  getAllAssignments,
  getTeachersList,
  getClassesList,
  deleteAssignment,
  backfillTeacherNames,   // ✅ import the backfill so existing rows get names
} from "../../../src/services/assignment.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const normalizeId = (item) => {
  if (!item || typeof item !== "object") return null;
  const resolvedId = item._id || item.id;
  return { ...item, _id: resolvedId, id: resolvedId };
};

const normalizeList = (list) => (list || []).map(normalizeId).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { id: "all",        labelKey: "assignList.filterAll" },
  { id: "by-teacher", labelKey: "assignList.byTeacher" },
  { id: "by-class",   labelKey: "assignList.byClass"   },
  { id: "unassigned", labelKey: "assignList.unassigned" },
];

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const AssignmentCard = React.memo(({ assignment, onRemove, isDeleting }) => {
                                    const { t } = useTranslation();
                                    return (
  <View style={styles.assignmentCard}>
    <View style={styles.assignmentLeft}>
      <View style={styles.assignmentIconWrap}>
        <Ionicons name="git-branch-outline" size={18} color="#4F46E5" />
      </View>
      <View style={styles.assignmentInfo}>
        <Text style={styles.assignmentTeacher} numberOfLines={1}>
          {assignment.teacher?.name || t("assignList.unknownTeacher")}
        </Text>
        <View style={styles.assignmentMeta}>
          <View style={styles.metaChip}>
            <Ionicons name="book-outline" size={12} color="#059669" />
            <Text style={styles.metaChipText}>
              {assignment.subject?.name || "N/A"}
            </Text>
          </View>
          <View style={styles.metaChip}>
            <Ionicons name="school-outline" size={12} color="#7C3AED" />
            <Text style={styles.metaChipText}>
              {assignment.class?.name || "N/A"}
            </Text>
          </View>
        </View>
      </View>
    </View>

    <TouchableOpacity
      style={[styles.removeButton, isDeleting && { opacity: 0.4 }]}
      onPress={() => onRemove(assignment)}
      disabled={isDeleting}
      activeOpacity={0.7}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      {isDeleting ? (
        <ActivityIndicator size="small" color="#DC2626" />
      ) : (
        <Ionicons name="trash-outline" size={16} color="#DC2626" />
      )}
    </TouchableOpacity>
  </View>
);
                                  });

const GroupHeader = React.memo(
  ({
    title,
    subtitle,
    avatarContent,
    badgeCount,
    badgeColor,
    isExpanded,
    onToggle,
  }) => (
    <TouchableOpacity
      style={styles.groupHeader}
      onPress={onToggle}
      activeOpacity={0.7}
    >
      <View style={styles.groupHeaderLeft}>
        <View
          style={[
            styles.groupAvatar,
            { backgroundColor: badgeColor + "20" },
          ]}
        >
          {avatarContent}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.groupTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.groupSubtitle}>{subtitle}</Text>
        </View>
      </View>
      <View style={styles.groupHeaderRight}>
        <View
          style={[
            styles.countBadge,
            { backgroundColor: badgeColor + "20" },
          ]}
        >
          <Text style={[styles.countBadgeText, { color: badgeColor }]}>
            {badgeCount}
          </Text>
        </View>
        <Ionicons
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={18}
          color="#9CA3AF"
        />
      </View>
    </TouchableOpacity>
  )
);

const UnassignedCard = React.memo(({ teacher, onAssign }) => {
                                    const { t } = useTranslation();
                                    return (
  <View style={styles.unassignedCard}>
    <View style={styles.unassignedLeft}>
      <View style={styles.unassignedAvatar}>
        <Text style={styles.unassignedAvatarText}>
          {teacher.name?.charAt(0)?.toUpperCase() || "?"}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.unassignedName} numberOfLines={1}>
          {teacher.name}
        </Text>
        <Text style={styles.unassignedEmail} numberOfLines={1}>
          {teacher.email || t("assignList.noEmail")}
        </Text>
      </View>
    </View>
    <TouchableOpacity
      style={styles.assignNowButton}
      onPress={() => onAssign(teacher)}
      activeOpacity={0.7}
    >
      <Text style={styles.assignNowText}>{t("assignList.assign")}</Text>
      <Ionicons name="arrow-forward" size={14} color="#4F46E5" />
    </TouchableOpacity>
  </View>
);
                                  });

const EmptyState = React.memo(
  ({ icon, title, subtitle, color = "#374151" }) => (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={48} color={color} />
      <Text style={[styles.emptyTitle, { color }]}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function AssignmentsIndex() {
  const { t } = useTranslation();
  const router = useRouter();

  const [assignments,    setAssignments]    = useState([]);
  const [teachers,       setTeachers]       = useState([]);
  const [classes,        setClasses]        = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [error,          setError]          = useState(null);
  const [activeTab,      setActiveTab]      = useState("all");
  const [searchQuery,    setSearchQuery]    = useState("");
  const [expandedGroups, setExpandedGroups] = useState({});
  const [deletingId,     setDeletingId]     = useState(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      // ✅ Repair any existing rows that have null teacher_json before
      //    reading them — fixes t("assignList.unknownTeacher") for already-synced data.
      //    backfillTeacherNames() is fast (no-op when all rows are already
      //    populated) so calling it on every load is safe.
      await backfillTeacherNames().catch((err) =>
        console.warn("[assignments] backfill warn:", err.message)
      );

      const [assignmentsData, teachersData, classesData] = await Promise.all([
        getAllAssignments(),
        getTeachersList(),
        getClassesList(),
      ]);

      if (!isMountedRef.current) return;

      setAssignments(normalizeList(assignmentsData));
      setTeachers(normalizeList(teachersData));
      setClasses(normalizeList(classesData));
    } catch (err) {
      console.error("[assignments] Failed to load:", err);
      if (isMountedRef.current) {
        setError(t("assignList.loadFailed"));
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  // ── Group toggle ──────────────────────────────────────────────────────────
  const toggleGroup = useCallback((groupId) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupId]: prev[groupId] === undefined ? false : !prev[groupId],
    }));
  }, []);

  const isGroupExpanded = useCallback(
    (groupId) => expandedGroups[groupId] !== false,
    [expandedGroups]
  );

  // ── Delete handler ────────────────────────────────────────────────────────
  const handleRemoveAssignment = useCallback((assignment) => {
    Alert.alert(
      t("assignList.removeTitle"),
      `Remove ${assignment.teacher?.name || "this teacher"} from ` +
      `${assignment.subject?.name || "this subject"} in ` +
      `${assignment.class?.name || "this class"}?`,
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.remove"),
          style: "destructive",
          onPress: async () => {
            const id = assignment._id;
            setDeletingId(id);
            try {
              await deleteAssignment(id);
              if (!isMountedRef.current) return;
              setAssignments((prev) => prev.filter((a) => a._id !== id));
              Alert.alert(t("assignList.removedTitle"), t("assignList.removedBody"));
            } catch (err) {
              console.error("[assignments] Remove failed:", err);
              if (isMountedRef.current) {
                Alert.alert(
                  t("assignList.errTitle"),
                  t("assignList.removeFailed")
                );
              }
            } finally {
              if (isMountedRef.current) setDeletingId(null);
            }
          },
        },
      ]
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAssignTeacher = useCallback(
    (teacher) => {
      router.push({
        pathname: "/admin/assignments/assign",
        params:   { teacherId: teacher._id, teacherName: teacher.name },
      });
    },
    [router]
  );

  // ── Derived data ──────────────────────────────────────────────────────────
  const assignedTeacherIdSet = useMemo(() => {
    const set = new Set();
    assignments.forEach((a) => {
      const id = a.teacher?._id || a.teacher?.id;
      if (id) set.add(id);
    });
    return set;
  }, [assignments]);

  const unassignedTeachers = useMemo(
    () => teachers.filter((tc) => !assignedTeacherIdSet.has(tc._id)),
    [teachers, assignedTeacherIdSet]
  );

  const stats = useMemo(
    () => ({
      totalAssignments:   assignments.length,
      assignedTeachers:   assignedTeacherIdSet.size,
      unassignedTeachers: unassignedTeachers.length,
      totalClasses:       classes.length,
    }),
    [assignments, assignedTeacherIdSet, unassignedTeachers, classes]
  );

  const statCards = useMemo(
    () => {
      return [
      { icon: "git-branch",       color: "#4F46E5", bg: "#EEF2FF", value: stats.totalAssignments,   labelKey: "assignList.countLabel" },
      { icon: "checkmark-circle", color: "#059669", bg: "#ECFDF5", value: stats.assignedTeachers,   labelKey: "assignList.assigned"    },
      { icon: "alert-circle",     color: "#D97706", bg: "#FEF3C7", value: stats.unassignedTeachers, labelKey: "assignList.unassigned"  },
      { icon: "school",           color: "#7C3AED", bg: "#EDE9FE", value: stats.totalClasses,       labelKey: "assignList.classes"     },
    ];
    },
    [stats]
  );

  const groupedByTeacher = useMemo(
    () => {
      return assignments.reduce((acc, assignment) => {
        const tid = assignment.teacher?._id || assignment.teacher?.id || "unknown";
        if (!acc[tid]) {
          acc[tid] = {
            teacher:     assignment.teacher,
            teacherName: assignment.teacher?.name || t("assignList.unknownTeacher"),
            assignments: [],
          };
        }
        acc[tid].assignments.push(assignment);
        return acc;
      }, {});
    },
    [assignments]
  );

  const groupedByClass = useMemo(
    () => {
      return assignments.reduce((acc, assignment) => {
        const cid = assignment.class?._id || assignment.class?.id || "unknown";
        if (!acc[cid]) {
          acc[cid] = {
            class:     assignment.class,
            className: assignment.class?.name || t("assignList.unknownClass"),
            assignments: [],
          };
        }
        acc[cid].assignments.push(assignment);
        return acc;
      }, {});
    },
    [assignments]
  );

  const matchesSearch = useCallback(
    (assignment) => {
      const q = searchQuery.toLowerCase().trim();
      if (!q) return true;
      return (
        assignment.teacher?.name?.toLowerCase().includes(q) ||
        assignment.subject?.name?.toLowerCase().includes(q) ||
        assignment.class?.name?.toLowerCase().includes(q)
      );
    },
    [searchQuery]
  );

  const filteredAssignments = useMemo(
    () => assignments.filter(matchesSearch),
    [assignments, matchesSearch]
  );

  // ── Tab renderers ─────────────────────────────────────────────────────────

  const renderAllTab = useCallback(
    () => {
      return filteredAssignments.length === 0 ? (
        <EmptyState
          icon={searchQuery ? "search-outline" : "git-branch-outline"}
          title={searchQuery ? t("assignList.noMatch") : t("assignList.noneFound")}
          subtitle={
            searchQuery
              ? t("assignList.noMatchSub")
              : t("assignList.noneFoundSub")
          }
        />
      ) : (
        <>
          {filteredAssignments.map((a) => (
            <AssignmentCard
              key={a._id}
              assignment={a}
              onRemove={handleRemoveAssignment}
              isDeleting={deletingId === a._id}
            />
          ))}
        </>
      );
    },
    [filteredAssignments, searchQuery, handleRemoveAssignment, deletingId]
  );

  const renderByTeacherTab = useCallback(() => {
    const groups = Object.entries(groupedByTeacher);
    if (groups.length === 0) {
      return (
        <EmptyState
          icon="people-outline"
          title={t("assignList.emptyTitle")}
          subtitle={t("assignList.emptySub")}
        />
      );
    }

    const rows = groups
      .map(([teacherId, group]) => {
        const key       = `teacher-${teacherId}`;
        const expanded  = isGroupExpanded(key);
        const filtered  = group.assignments.filter(matchesSearch);
        if (searchQuery && filtered.length === 0) return null;
        const displayList = searchQuery ? filtered : group.assignments;

        return (
          <View key={teacherId} style={styles.groupContainer}>
            <GroupHeader
              title={group.teacherName}
              subtitle={`${group.assignments.length} subject${group.assignments.length !== 1 ? "s" : ""} assigned`}
              avatarContent={
                <Text style={[styles.groupAvatarText, { color: "#4F46E5" }]}>
                  {group.teacherName?.charAt(0)?.toUpperCase() || "?"}
                </Text>
              }
              badgeCount={group.assignments.length}
              badgeColor="#4F46E5"
              isExpanded={expanded}
              onToggle={() => toggleGroup(key)}
            />

            {expanded && (
              <View style={styles.groupContent}>
                {displayList.map((assignment) => (
                  <View key={assignment._id} style={styles.groupItem}>
                    <View style={styles.groupItemLeft}>
                      <Ionicons name="book-outline" size={16} color="#059669" />
                      <Text style={styles.groupItemText} numberOfLines={1}>
                        {assignment.subject?.name || "N/A"}
                      </Text>
                      <View style={styles.classPill}>
                        <Text style={styles.classPillText}>
                          {assignment.class?.name || "N/A"}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleRemoveAssignment(assignment)}
                      disabled={deletingId === assignment._id}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.7}
                    >
                      {deletingId === assignment._id ? (
                        <ActivityIndicator size="small" color="#EF4444" />
                      ) : (
                        <Ionicons name="close-circle" size={20} color="#EF4444" />
                      )}
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })
      .filter(Boolean);

    if (searchQuery && rows.length === 0) {
      return (
        <EmptyState
          icon="search-outline"
          title={t("assignList.noMatch")}
          subtitle={t("assignList.noMatchSub")}
        />
      );
    }
    return <>{rows}</>;
  }, [
    groupedByTeacher,
    isGroupExpanded,
    searchQuery,
    matchesSearch,
    toggleGroup,
    handleRemoveAssignment,
    deletingId,
  ]);

  const renderByClassTab = useCallback(() => {
    const groups = Object.entries(groupedByClass);
    if (groups.length === 0) {
      return (
        <EmptyState
          icon="school-outline"
          title={t("assignList.emptyClass")}
          subtitle={t("assignList.emptyClassSub")}
        />
      );
    }

    const rows = groups
      .map(([classId, group]) => {
        const key      = `class-${classId}`;
        const expanded = isGroupExpanded(key);
        const filtered = group.assignments.filter(matchesSearch);
        if (searchQuery && filtered.length === 0) return null;
        const displayList = searchQuery ? filtered : group.assignments;

        return (
          <View key={classId} style={styles.groupContainer}>
            <GroupHeader
              title={group.className}
              subtitle={`${group.assignments.length} teacher${group.assignments.length !== 1 ? "s" : ""} assigned`}
              avatarContent={
                <Ionicons name="school" size={18} color="#7C3AED" />
              }
              badgeCount={group.assignments.length}
              badgeColor="#7C3AED"
              isExpanded={expanded}
              onToggle={() => toggleGroup(key)}
            />

            {expanded && (
              <View style={styles.groupContent}>
                {displayList.map((assignment) => (
                  <View key={assignment._id} style={styles.groupItem}>
                    <View style={styles.groupItemLeft}>
                      <Ionicons name="person-outline" size={16} color="#4F46E5" />
                      <Text style={styles.groupItemText} numberOfLines={1}>
                        {assignment.teacher?.name || "N/A"}
                      </Text>
                      <View
                        style={[styles.classPill, { backgroundColor: "#ECFDF5" }]}
                      >
                        <Text style={[styles.classPillText, { color: "#059669" }]}>
                          {assignment.subject?.name || "N/A"}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleRemoveAssignment(assignment)}
                      disabled={deletingId === assignment._id}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.7}
                    >
                      {deletingId === assignment._id ? (
                        <ActivityIndicator size="small" color="#EF4444" />
                      ) : (
                        <Ionicons name="close-circle" size={20} color="#EF4444" />
                      )}
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })
      .filter(Boolean);

    if (searchQuery && rows.length === 0) {
      return (
        <EmptyState
          icon="search-outline"
          title={t("assignList.noMatch")}
          subtitle={t("assignList.noMatchSub")}
        />
      );
    }
    return <>{rows}</>;
  }, [
    groupedByClass,
    isGroupExpanded,
    searchQuery,
    matchesSearch,
    toggleGroup,
    handleRemoveAssignment,
    deletingId,
  ]);

  const renderUnassignedTab = useCallback(
    () => {
      return unassignedTeachers.length === 0 ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title={t("assignList.allAssigned")}
          subtitle={t("assignList.allAssignedSub")}
          color="#059669"
        />
      ) : (
        <View>
          <View style={styles.unassignedBanner}>
            <Ionicons name="information-circle" size={20} color="#D97706" />
            <Text style={styles.unassignedBannerText}>
              {unassignedTeachers.length} teacher
              {unassignedTeachers.length !== 1 ? "s" : ""} without any subject
              assignment
            </Text>
          </View>
          {unassignedTeachers.map((teacher) => (
            <UnassignedCard
              key={teacher._id}
              teacher={teacher}
              onAssign={handleAssignTeacher}
            />
          ))}
        </View>
      );
    },
    [unassignedTeachers, handleAssignTeacher]
  );

  const renderTabContent = useCallback(() => {
    switch (activeTab) {
      case "by-teacher": return renderByTeacherTab();
      case "by-class":   return renderByClassTab();
      case "unassigned": return renderUnassignedTab();
      default:           return renderAllTab();
    }
  }, [
    activeTab,
    renderAllTab,
    renderByTeacherTab,
    renderByClassTab,
    renderUnassignedTab,
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("assignList.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("assignList.title")}</Text>
          <Text style={styles.headerSubtitle}>{t("assignList.blurb")}</Text>
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => router.push("/admin/assignments/assign")}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {/* ── Error banner ── */}
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => loadData()} activeOpacity={0.75}>
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Stats ── */}
        <View style={styles.statsContainer}>
          {statCards.map((s) => (
            <View key={s.label} style={[styles.statCard, { backgroundColor: s.bg }]}>
              <Ionicons name={s.icon} size={20} color={s.color} />
              <Text style={styles.statNumber}>{s.value}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* ── Search ── */}
        <View style={styles.searchContainer}>
          <Ionicons name="search-outline" size={18} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            placeholder={t("assignList.searchPh")}
            placeholderTextColor="#9CA3AF"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery("")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close-circle" size={18} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>

        {/* ── Filter tabs ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsContainer}
          keyboardShouldPersistTaps="handled"
        >
          {FILTER_TABS.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.tab, activeTab === tab.id && styles.tabActive]}
              onPress={() => {
                setActiveTab(tab.id);
                setSearchQuery("");
              }}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === tab.id && styles.tabTextActive,
                ]}
              >
                {t(tab.labelKey)}
              </Text>
              {tab.id === "unassigned" && unassignedTeachers.length > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unassignedTeachers.length}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* ── Tab content ── */}
        <View style={styles.contentSection}>{renderTabContent()}</View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* ── FAB ── */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push("/admin/assignments/assign")}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#F9FAFB" },
  centered:     { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText:  { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scrollContent: { paddingBottom: 100 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:   { flex: 1, marginLeft: 12 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
  },

  errorBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    backgroundColor:  "#FEE2E2",
    marginHorizontal: 20,
    marginTop:        16,
    padding:          12,
    borderRadius:     10,
    gap:              8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText: { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  statsContainer: {
    flexDirection:     "row",
    paddingHorizontal: 20,
    gap:               8,
    marginTop:         20,
  },
  statCard: {
    flex:              1,
    borderRadius:      14,
    paddingVertical:   14,
    paddingHorizontal: 6,
    alignItems:        "center",
    gap:               4,
  },
  statNumber: { fontSize: 18, fontWeight: "700", color: "#111827" },
  statLabel:  { fontSize: 10, color: "#6B7280", fontWeight: "500", textAlign: "center" },

  searchContainer: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#FFFFFF",
    marginHorizontal:  20,
    marginTop:         20,
    paddingHorizontal: 14,
    borderRadius:      12,
    height:            46,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               10,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  tabsScroll:    { marginTop: 16 },
  tabsContainer: { paddingHorizontal: 20, gap: 8 },
  tab: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   8,
    borderRadius:      20,
    backgroundColor:   "#FFFFFF",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               6,
  },
  tabActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  tabText:       { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  tabTextActive: { color: "#FFFFFF" },
  tabBadge: {
    backgroundColor:   "#EF4444",
    borderRadius:      8,
    paddingHorizontal: 5,
    paddingVertical:   1,
    minWidth:          18,
    alignItems:        "center",
  },
  tabBadgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },

  contentSection: { paddingHorizontal: 20, marginTop: 20 },

  assignmentCard: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "space-between",
    backgroundColor: "#FFFFFF",
    borderRadius:    12,
    padding:         14,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  assignmentLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  assignmentIconWrap: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
    marginRight:     12,
  },
  assignmentInfo:    { flex: 1 },
  assignmentTeacher: { fontSize: 14, fontWeight: "600", color: "#111827", marginBottom: 4 },
  assignmentMeta:    { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  metaChip: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F3F4F6",
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
    gap:               4,
  },
  metaChipText: { fontSize: 11, fontWeight: "500", color: "#374151" },
  removeButton: {
    width:           32,
    height:          32,
    borderRadius:    8,
    backgroundColor: "#FEE2E2",
    alignItems:      "center",
    justifyContent:  "center",
    marginLeft:      8,
  },

  groupContainer: {
    backgroundColor: "#FFFFFF",
    borderRadius:    14,
    marginBottom:    12,
    overflow:        "hidden",
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  groupHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        14,
  },
  groupHeaderLeft:  { flexDirection: "row", alignItems: "center", flex: 1, gap: 12 },
  groupAvatar: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  groupAvatarText:  { fontSize: 16, fontWeight: "700" },
  groupTitle:       { fontSize: 15, fontWeight: "600", color: "#111827" },
  groupSubtitle:    { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  groupHeaderRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  countBadge: {
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   2,
    minWidth:          24,
    alignItems:        "center",
  },
  countBadgeText: { fontSize: 12, fontWeight: "700" },
  groupContent: {
    borderTopWidth:    1,
    borderTopColor:    "#F3F4F6",
    paddingHorizontal: 14,
    paddingVertical:   8,
  },
  groupItem: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  groupItemLeft:  { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  groupItemText:  { fontSize: 14, fontWeight: "500", color: "#374151", flex: 1 },
  classPill: {
    backgroundColor:   "#EEF2FF",
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderRadius:      6,
  },
  classPillText: { fontSize: 11, fontWeight: "600", color: "#4F46E5" },

  unassignedBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FEF3C7",
    padding:         12,
    borderRadius:    10,
    marginBottom:    16,
    gap:             8,
  },
  unassignedBannerText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  unassignedCard: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "space-between",
    backgroundColor: "#FFFFFF",
    borderRadius:    12,
    padding:         14,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     "#FDE68A",
    borderStyle:     "dashed",
  },
  unassignedLeft: { flexDirection: "row", alignItems: "center", flex: 1, gap: 12 },
  unassignedAvatar: {
    width:           40,
    height:          40,
    borderRadius:    10,
    backgroundColor: "#FEF3C7",
    alignItems:      "center",
    justifyContent:  "center",
  },
  unassignedAvatarText: { fontSize: 16, fontWeight: "700", color: "#D97706" },
  unassignedName:       { fontSize: 14, fontWeight: "600", color: "#111827" },
  unassignedEmail:      { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  assignNowButton: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#EEF2FF",
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderRadius:      8,
    gap:               4,
  },
  assignNowText: { fontSize: 13, fontWeight: "600", color: "#4F46E5" },

  emptyState:    { alignItems: "center", paddingVertical: 40 },
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 12 },
  emptySubtitle: {
    fontSize:          13,
    color:             "#9CA3AF",
    marginTop:         4,
    textAlign:         "center",
    paddingHorizontal: 20,
  },

  fab: {
    position:        "absolute",
    bottom:          30,
    right:           20,
    width:           56,
    height:          56,
    borderRadius:    28,
    backgroundColor: "#4F46E5",
    alignItems:      "center",
    justifyContent:  "center",
    shadowColor:     "#4F46E5",
    shadowOffset:    { width: 0, height: 4 },
    shadowOpacity:   0.3,
    shadowRadius:    8,
    elevation:       8,
  },
});