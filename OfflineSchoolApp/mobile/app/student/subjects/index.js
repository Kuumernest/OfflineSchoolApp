// app/student/subjects/index.js
"use strict";

import React, { useState, useEffect, useCallback, useMemo } from "react";
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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons }  from "@expo/vector-icons";
import { useAuthStore }          from "../../../src/store/auth.store";
import { getDatabase }           from "../../../src/db/database";
import { resolveStudentClassId } from "../../../src/services/student.service";

const SUBJECT_COLORS = [
  { bg: "#EEF2FF", color: "#4F46E5", icon: "calculator-outline"   },
  { bg: "#ECFDF5", color: "#059669", icon: "leaf-outline"          },
  { bg: "#FEF3C7", color: "#D97706", icon: "flask-outline"         },
  { bg: "#FEF2F2", color: "#DC2626", icon: "book-outline"          },
  { bg: "#F5F3FF", color: "#7C3AED", icon: "globe-outline"         },
  { bg: "#FDF2F8", color: "#DB2777", icon: "musical-notes-outline" },
  { bg: "#F0F9FF", color: "#0284C7", icon: "desktop-outline"       },
  { bg: "#FFF7ED", color: "#EA580C", icon: "color-palette-outline" },
  { bg: "#F0FDF4", color: "#16A34A", icon: "fitness-outline"       },
  { bg: "#FFF1F2", color: "#E11D48", icon: "language-outline"      },
];

const loadSubjects = async (db, classId) => {
  if (!classId) return [];
  try {
    const sCols   = await db.getAllAsync(`PRAGMA table_info(subjects)`, []).catch(() => []);
    const sColSet = new Set(sCols.map((c) => c.name));
    if (!sColSet.size) return [];

    const classIdCol = sColSet.has("class_id") ? "s.class_id" :
                       sColSet.has("classId")  ? "s.classId"  : null;
    const teacherCol = sColSet.has("teacher_id") ? "s.teacher_id" :
                       sColSet.has("teacherId")  ? "s.teacherId"  : null;
    const deletedCol = sColSet.has("deleted_at") ? "s.deleted_at" :
                       sColSet.has("deletedAt")  ? "s.deletedAt"  : null;
    const codeCol    = sColSet.has("code") ? "s.code" : "NULL";

    if (!classIdCol) return [];

    const deletedFilter = deletedCol
      ? `AND (${deletedCol} IS NULL OR ${deletedCol} = '')`
      : "";

    const uCols   = await db.getAllAsync(`PRAGMA table_info(users)`, []).catch(() => []);
    const uColSet = new Set(uCols.map((c) => c.name));
    const hasEmail = uColSet.has("email");

    let selectClause = `
      SELECT
        s.id,
        s.name,
        ${codeCol} AS code`;

    let fromClause = ` FROM subjects s`;

    if (teacherCol) {
      selectClause += `, u.name AS teacherName${hasEmail ? ", u.email AS teacherEmail" : ""}`;
      fromClause   += ` LEFT JOIN users u ON u.id = ${teacherCol}`;
    } else {
      selectClause += `, NULL AS teacherName, NULL AS teacherEmail`;
    }

    const rows = await db.getAllAsync(
      `${selectClause}
       ${fromClause}
       WHERE (${classIdCol} = ? OR ${classIdCol.replace("s.", "")} = ?)
         ${deletedFilter}
       ORDER BY s.name ASC`,
      [classId, classId]
    );

    return rows;
  } catch (err) {
    console.warn("[loadSubjects] failed:", err.message);
    return [];
  }
};

const SubjectCard = React.memo(({ subject, colorSet, onPress }) => (
  <TouchableOpacity
    style={[st.card, { borderLeftColor: colorSet.color }]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={[st.cardIcon, { backgroundColor: colorSet.bg }]}>
      <Ionicons name={colorSet.icon} size={24} color={colorSet.color} />
    </View>

    <View style={st.cardInfo}>
      <Text style={st.cardName} numberOfLines={1}>{subject.name}</Text>

      {!!subject.code && (
        <View style={st.codeBadge}>
          <Text style={st.codeText}>{subject.code}</Text>
        </View>
      )}

      {!!subject.teacherName && (
        <View style={st.teacherRow}>
          <Ionicons name="person-outline" size={12} color="#9CA3AF" />
          <Text style={st.teacherName} numberOfLines={1}>
            {subject.teacherName}
          </Text>
        </View>
      )}
    </View>

    <View style={st.arrowWrap}>
      <Text style={st.viewContent}>View content</Text>
      <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
    </View>
  </TouchableOpacity>
));

export default function StudentSubjectsScreen() {
  const router  = useRouter();
  const user    = useAuthStore((s) => s.user);
  const userId  = user?._id || user?.id || user?.userId;

  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [classId,    setClassId]    = useState(null);
  const [className,  setClassName]  = useState(null);
  const [subjects,   setSubjects]   = useState([]);
  const [search,     setSearch]     = useState("");

  const load = useCallback(async (isRefresh = false) => {
    if (!userId) { setLoading(false); return; }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const db  = await getDatabase();
      const cid = await resolveStudentClassId(userId);

      setClassId(cid || null);

      if (cid) {
        const row = await db
          .getFirstAsync(`SELECT name FROM classes WHERE id = ? LIMIT 1`, [cid])
          .catch(() => null);
        setClassName(row?.name || null);
      }

      const data = await loadSubjects(db, cid);
      setSubjects(data);
    } catch (err) {
      console.warn("[StudentSubjects] load error:", err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return subjects;
    const q = search.toLowerCase();
    return subjects.filter(
      (s) =>
        s.name?.toLowerCase().includes(q)        ||
        s.code?.toLowerCase().includes(q)        ||
        s.teacherName?.toLowerCase().includes(q)
    );
  }, [subjects, search]);

  const uniqueTeacherCount = useMemo(
    () =>
      new Set(
        subjects.filter((s) => s.teacherName).map((s) => s.teacherName)
      ).size,
    [subjects]
  );

  const goToDetail = useCallback(
    (subject, idx) => {
      router.push({
        pathname: "/student/subjects/detail",
        params: {
          subjectId:   subject.id,
          subjectName: subject.name,
          teacherName: subject.teacherName || "",
          subjectCode: subject.code        || "",
          colorIndex:  String(idx % SUBJECT_COLORS.length),
          classId:     classId ? String(classId) : "",
        },
      });
    },
    [router, classId]
  );

  if (loading) {
    return (
      <View style={st.centered}>
        <ActivityIndicator size="large" color="#059669" />
        <Text style={st.loadingText}>Loading subjects…</Text>
      </View>
    );
  }

  return (
    <View style={st.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      <View style={st.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={st.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={st.headerTitle}>My Subjects</Text>
          {!!className && (
            <Text style={st.headerSub}>{className}</Text>
          )}
        </View>
        <View style={st.countBadge}>
          <Text style={st.countText}>{subjects.length}</Text>
        </View>
      </View>

      <View style={st.searchWrap}>
        <Ionicons name="search-outline" size={18} color="#9CA3AF" />
        <TextInput
          style={st.searchInput}
          placeholder="Search subjects or teachers…"
          placeholderTextColor="#9CA3AF"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {search.length > 0 && (
          <TouchableOpacity
            onPress={() => setSearch("")}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close-circle" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        )}
      </View>

      <View style={st.statsRow}>
        <View style={st.statChip}>
          <Ionicons name="book-outline" size={14} color="#059669" />
          <Text style={st.statChipText}>
            {subjects.length} subject{subjects.length !== 1 ? "s" : ""}
          </Text>
        </View>
        <View style={st.statChip}>
          <Ionicons name="person-outline" size={14} color="#4F46E5" />
          <Text style={st.statChipText}>
            {uniqueTeacherCount} teacher{uniqueTeacherCount !== 1 ? "s" : ""}
          </Text>
        </View>
        {!!className && (
          <View style={[st.statChip, { backgroundColor: "#EEF2FF" }]}>
            <Ionicons name="school-outline" size={14} color="#4F46E5" />
            <Text style={[st.statChipText, { color: "#4F46E5" }]} numberOfLines={1}>
              {className}
            </Text>
          </View>
        )}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={st.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#059669"
            colors={["#059669"]}
          />
        }
      >
        {filtered.length === 0 ? (
          <View style={st.emptyState}>
            <Ionicons name="book-outline" size={52} color="#D1D5DB" />
            <Text style={st.emptyTitle}>
              {search ? "No subjects match your search" : "No subjects found"}
            </Text>
            <Text style={st.emptySub}>
              {search
                ? "Try a different keyword"
                : "Your subjects will appear here after sync"}
            </Text>
            {search.length > 0 && (
              <TouchableOpacity
                style={st.clearBtn}
                onPress={() => setSearch("")}
                activeOpacity={0.7}
              >
                <Text style={st.clearBtnText}>Clear search</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filtered.map((subject, idx) => {
            const colorSet = SUBJECT_COLORS[idx % SUBJECT_COLORS.length];
            return (
              <SubjectCard
                key={subject.id}
                subject={subject}
                colorSet={colorSet}
                onPress={() => goToDetail(subject, idx)}
              />
            );
          })
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  countBadge: {
    backgroundColor: "#ECFDF5", borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  countText: { fontSize: 13, fontWeight: "700", color: "#059669" },

  searchWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12,
    marginHorizontal: 16, marginVertical: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    gap: 8,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  statsRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 8,
    paddingHorizontal: 16, marginBottom: 10,
  },
  statChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "#FFF", borderRadius: 10,
    paddingHorizontal: 10, paddingVertical: 6,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 2, elevation: 1,
  },
  statChipText: { fontSize: 12, fontWeight: "600", color: "#374151" },

  listContent: { paddingHorizontal: 16, paddingTop: 4 },

  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 14,
    padding: 14, marginBottom: 10, gap: 12,
    borderLeftWidth: 4,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  cardIcon: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  cardInfo: { flex: 1, gap: 4 },
  cardName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  codeBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#F3F4F6", borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  codeText:   { fontSize: 10, fontWeight: "700", color: "#6B7280" },
  teacherRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  teacherName:{ fontSize: 12, color: "#9CA3AF" },
  arrowWrap: { flexDirection: "row", alignItems: "center", gap: 2 },
  viewContent: { fontSize: 10, fontWeight: "600", color: "#9CA3AF" },

  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 32, gap: 10,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySub:   { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
  clearBtn: {
    backgroundColor: "#EEF2FF", borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 8, marginTop: 4,
  },
  clearBtnText: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },
});