// app/admin/exams/marks.js
"use strict";

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, StatusBar, RefreshControl,
  TextInput, ScrollView, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { ExamService }  from "../../../src/services/exam.service";
import api              from "../../../src/services/api";
import { getDatabase }  from "../../../src/db/database";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const rateColor = (pct) => {
  if (pct >= 70) return "#059669";
  if (pct >= 50) return "#D97706";
  return "#DC2626";
};

const STATUS_META = {
  draft:     { color: "#6B7280", bg: "#F3F4F6", label: "Draft"     },
  scheduled: { color: "#4F46E5", bg: "#EEF2FF", label: "Scheduled" },
  ongoing:   { color: "#D97706", bg: "#FEF3C7", label: "Ongoing"   },
  completed: { color: "#059669", bg: "#ECFDF5", label: "Completed" },
  published: { color: "#7C3AED", bg: "#F5F3FF", label: "Published" },
  archived:  { color: "#9CA3AF", bg: "#F9FAFB", label: "Archived"  },
};

const EXAM_TYPE_LABELS = {
  first_test:            "First Test",
  second_test:           "Second Test",
  mid_term:              "Mid-Term",
  practical:             "Practical",
  final_exam:            "Final Exam",
  mock_exam:             "Mock Exam",
  promotion_exam:        "Promotion Exam",
  continuous_assessment: "CA",
};

const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];
const isAdminRole = (role) => ADMIN_ROLES.includes(role);

const extractClassId = (s) =>
  s.classId || s.class_id || s.class?._id || s.class?.id || null;

const displayClass = (cls) => {
  if (!cls) return "Class";
  if (cls.className && cls.className !== "Unknown Class") return cls.className;
  if (cls.classId) return `Class …${String(cls.classId).slice(-4)}`;
  return "Class";
};

// ─────────────────────────────────────────────────────────
// ROLE-AWARE CLASS FETCHER
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// OFFLINE FALLBACKS
//
// Entering marks is the exam task most likely to happen with no signal, so
// every loader on this screen falls back to SQLite. Classes, students and
// exams are all synced locally; without these fallbacks the screen could
// not even reach the mark sheet offline.
// ─────────────────────────────────────────────────────────

const classesFromCache = async (schoolId) => {
  try {
    const db  = await getDatabase();
    const rows = await db.getAllAsync(
      `SELECT id, name FROM classes
       WHERE (deleted_at IS NULL OR deleted_at = '')
         AND (schoolId = ? OR school_id = ? OR ? IS NULL)
       ORDER BY name ASC`,
      [schoolId, schoolId, schoolId ?? null]
    );
    return (rows ?? []).map((c) => ({
      id:   String(c.id),
      name: c.name || `Class …${String(c.id).slice(-4)}`,
    }));
  } catch (err) {
    console.warn("[classesFromCache] failed:", err.message);
    return [];
  }
};

const studentsFromCache = async (classId) => {
  try {
    const db = await getDatabase();
    const rows = await db.getAllAsync(
      `SELECT id, name, studentName, admissionNo, admissionNumber, email, classId, class_id
       FROM students
       WHERE (classId = ? OR class_id = ?)
         AND (deleted_at IS NULL OR deleted_at = '')
       ORDER BY COALESCE(studentName, name) ASC`,
      [String(classId), String(classId)]
    );
    return (rows ?? []).map((s) => ({
      _id:         String(s.id),
      studentName: s.studentName || s.name || "Unknown",
      admissionNo: s.admissionNo || s.admissionNumber || null,
      email:       s.email || null,
      classId:     String(s.classId || s.class_id || classId),
    }));
  } catch (err) {
    console.warn("[studentsFromCache] failed:", err.message);
    return [];
  }
};

const fetchClasses = async (schoolId, role) => {
  try {
    const res = isAdminRole(role)
      ? await api.get("/admin/classes", { params: { schoolId } })
      : await api.get("/teacher/my-classes");
    const raw =
      res.data?.classes ||
      res.data?.data    ||
      (Array.isArray(res.data) ? res.data : []);
    const list = raw.map((c) => ({
      id:   String(c._id || c.id),
      name: c.name || c.className || `Class …${String(c._id || c.id).slice(-4)}`,
    }));
    if (list.length) return list;
    return classesFromCache(schoolId);
  } catch (err) {
    console.warn("[fetchClasses] network failed, using cache:", err.message);
    return classesFromCache(schoolId);
  }
};

const fetchExamRecord = async (examId, schoolId) => {
  if (!examId) return null;
  try {
    const { exam } = await ExamService.getExamById(examId, schoolId);
    return exam || null;
  } catch (err) {
    console.warn("[fetchExamRecord] failed:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// ROLE-AWARE STUDENT FETCHER
// ─────────────────────────────────────────────────────────

const fetchStudentsForClass = async (schoolId, classId, role) => {
  if (!classId) {
    console.warn("[fetchStudents] classId is missing");
    return [];
  }

  // Primary: role-based endpoint
  try {
    const endpoint = isAdminRole(role)
      ? "/admin/students"
      : "/teacher/my-students";

    const res = await api.get(endpoint, {
      params: { schoolId, classId },
    });

    const raw =
      res.data?.students ||
      res.data?.data     ||
      (Array.isArray(res.data) ? res.data : []);

    if (raw.length > 0) {
      return raw.map((s) => ({
        _id:         String(s._id || s.id),
        studentName: s.studentName || s.name || "Unknown",
        admissionNo: s.admissionNo || s.admissionNumber || null,
        email:       s.email || null,
        classId:     String(s.classId || classId),
      }));
    }
  } catch (err) {
    console.warn(
      `[fetchStudents] primary endpoint failed:`,
      err.message
    );
  }

  // Fallback: attendance roster
  try {
    const res = await api.get("/attendance/students/roster", {
      params: { schoolId, classId },
    });
    const raw =
      res.data?.students ||
      res.data?.data     ||
      (Array.isArray(res.data) ? res.data : []);
    if (raw.length > 0) {
      return raw.map((s) => ({
        _id:         String(s._id || s.id),
        studentName: s.studentName || s.name || "Unknown",
        admissionNo: s.admissionNo || null,
        email:       s.email || null,
        classId:     String(s.classId || classId),
      }));
    }
  } catch (err) {
    console.warn("[fetchStudents] roster fallback failed:", err.message);
  }

  // Last resort: the locally synced roster.
  return studentsFromCache(classId);
};

// ─────────────────────────────────────────────────────────
// STEP 0 — EXAM SELECTOR
// ─────────────────────────────────────────────────────────

const ExamSelector = ({ schoolId, role, onSelect }) => {
  const [exams,      setExams]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");
  const [filter,     setFilter]     = useState("all");

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);
      // Network-first with a SQLite fallback, so the exam picker still
      // opens offline and the teacher can reach the mark sheet.
      const { exams: list } = await ExamService.getExams({ schoolId, limit: 50 });
      setExams(list || []);
    } catch (err) {
      console.error("ExamSelector load failed:", err.message);
      setError("Failed to load exams");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let list = filter !== "all"
      ? exams.filter((e) => e.status === filter)
      : exams;
    const q = search.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (e) =>
          e.name?.toLowerCase().includes(q) ||
          e.term?.toLowerCase().includes(q)  ||
          e.academicYear?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [exams, filter, search]);

  if (loading) {
    return (
      <View style={ex.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={ex.loadingText}>Loading exams…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={ex.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={ex.errorText}>{error}</Text>
        <TouchableOpacity style={ex.retryBtn} onPress={() => load()}>
          <Text style={ex.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={ex.searchWrap}>
        <View style={ex.searchBox}>
          <Ionicons name="search-outline" size={16} color="#9CA3AF" />
          <TextInput
            style={ex.searchInput}
            placeholder="Search exams…"
            placeholderTextColor="#9CA3AF"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={ex.filterRow}
      >
        {[
          { key: "all",       label: "All Exams" },
          { key: "ongoing",   label: "Ongoing"   },
          { key: "scheduled", label: "Scheduled" },
          { key: "draft",     label: "Draft"     },
          { key: "completed", label: "Completed" },
        ].map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[ex.filterChip, filter === f.key && ex.filterChipActive]}
            onPress={() => setFilter(f.key)}
            activeOpacity={0.7}
          >
            <Text style={[
              ex.filterChipText,
              filter === f.key && ex.filterChipTextActive,
            ]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item._id || item.id)}
        contentContainerStyle={ex.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        ListEmptyComponent={
          <View style={ex.empty}>
            <Ionicons name="document-outline" size={48} color="#D1D5DB" />
            <Text style={ex.emptyTitle}>
              {search || filter !== "all"
                ? "No exams match your filter"
                : "No exams created yet"}
            </Text>
            <Text style={ex.emptySub}>
              {search || filter !== "all"
                ? "Try a different search or filter"
                : "Create an exam first from the Exams screen"}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const meta         = STATUS_META[item.status] || STATUS_META.draft;
          const classDisplay = item.classNames || item.className || null;

          return (
            <TouchableOpacity
              style={ex.card}
              onPress={() => onSelect(item)}
              activeOpacity={0.7}
            >
              <View style={[ex.cardAccent, { backgroundColor: meta.color }]} />
              <View style={ex.cardBody}>
                <View style={ex.cardTop}>
                  <Text style={ex.cardName} numberOfLines={2}>{item.name}</Text>
                  <View style={[ex.statusBadge, { backgroundColor: meta.bg }]}>
                    <Text style={[ex.statusText, { color: meta.color }]}>
                      {meta.label}
                    </Text>
                  </View>
                </View>
                <View style={ex.cardMeta}>
                  <View style={ex.cardMetaItem}>
                    <Ionicons name="grid-outline" size={12} color="#9CA3AF" />
                    <Text style={ex.cardMetaText}>
                      {EXAM_TYPE_LABELS[item.type] || item.type}
                    </Text>
                  </View>
                  <View style={ex.cardMetaItem}>
                    <Ionicons name="calendar-outline" size={12} color="#9CA3AF" />
                    <Text style={ex.cardMetaText}>
                      {item.academicYear} · {item.term}
                    </Text>
                  </View>
                  {!!classDisplay && (
                    <View style={ex.cardMetaItem}>
                      <Ionicons name="school-outline" size={12} color="#9CA3AF" />
                      <Text style={ex.cardMetaText} numberOfLines={1}>
                        {classDisplay}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={ex.cardFooter}>
                  <Text style={ex.cardFooterText}>
                    Max: {item.totalMarks} · Pass: {item.passMark}
                  </Text>
                  <View style={ex.enterBtn}>
                    <Ionicons name="create-outline" size={13} color="#4F46E5" />
                    <Text style={ex.enterBtnText}>Enter Marks</Text>
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
};

const ex = StyleSheet.create({
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  errorText:   { fontSize: 14, color: "#DC2626", textAlign: "center" },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         4,
  },
  retryText:            { color: "#FFF", fontWeight: "700", fontSize: 14 },
  searchWrap:           { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  searchBox: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F9FAFB",
    borderRadius:      10,
    paddingHorizontal: 12,
    height:            42,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               8,
  },
  searchInput:          { flex: 1, fontSize: 14, color: "#111827" },
  filterRow:            { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      20,
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  filterChipActive:     { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  filterChipText:       { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  filterChipTextActive: { color: "#FFF" },
  list:                 { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
  empty:                { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyTitle: {
    fontSize:   15,
    fontWeight: "600",
    color:      "#374151",
    textAlign:  "center",
  },
  emptySub:    { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
  card: {
    flexDirection:   "row",
    backgroundColor: "#FFF",
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    overflow:        "hidden",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardAccent:    { width: 4 },
  cardBody:      { flex: 1, padding: 14 },
  cardTop: {
    flexDirection:  "row",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    gap:            8,
    marginBottom:   8,
  },
  cardName:     { flex: 1, fontSize: 15, fontWeight: "700", color: "#111827", lineHeight: 20 },
  statusBadge:  { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusText:   { fontSize: 11, fontWeight: "700" },
  cardMeta:     { gap: 4, marginBottom: 10 },
  cardMetaItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  cardMetaText: { fontSize: 12, color: "#6B7280" },
  cardFooter: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
    paddingTop:     10,
  },
  cardFooterText: { fontSize: 11, color: "#9CA3AF" },
  enterBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   "#EEF2FF",
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   5,
  },
  enterBtnText: { fontSize: 12, fontWeight: "700", color: "#4F46E5" },
});

// ─────────────────────────────────────────────────────────
// STEP 0.5 — CLASS SELECTOR
// ─────────────────────────────────────────────────────────

const ClassSelector = ({ examId, examName, schoolId, role, onSelect }) => {
  const [classes,    setClasses]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const [submissionsRes, allClasses, examRecord] = await Promise.all([
        ExamService.getSubmissions({ examId, schoolId }),
        fetchClasses(schoolId, role),
        fetchExamRecord(examId, schoolId),
      ]);

      const submissions = submissionsRes?.submissions || [];

      const classMap = {};
      for (const c of allClasses) {
        classMap[c.id] = c.name;
      }

      const examClassIds   = examRecord?.classIds || [];
      const examClassNames = examRecord?.classNames
        ? examRecord.classNames.split(",").map((n) => n.trim())
        : [];

      examClassIds.forEach((cid, i) => {
        const cidStr = String(cid);
        if (!classMap[cidStr] && examClassNames[i]) {
          classMap[cidStr] = examClassNames[i];
        }
      });

      const map = {};

      for (let i = 0; i < examClassIds.length; i++) {
        const cidStr = String(examClassIds[i]);
        if (!map[cidStr]) {
          map[cidStr] = {
            classId:      cidStr,
            className:    classMap[cidStr] || examClassNames[i] || `Class …${cidStr.slice(-4)}`,
            subjectCount: 0,
          };
        }
      }

      for (const s of submissions) {
        const cid = extractClassId(s);
        if (!cid) continue;
        const cidStr = String(cid);
        if (!map[cidStr]) {
          map[cidStr] = {
            classId:      cidStr,
            className:    classMap[cidStr] || `Class …${cidStr.slice(-4)}`,
            subjectCount: 0,
          };
        }
        map[cidStr].subjectCount++;
      }

      const classList = Object.values(map).sort(
        (a, b) => a.className.localeCompare(b.className)
      );

      if (classList.length === 1) {
        onSelect(classList[0]);
        return;
      }

      setClasses(classList);
    } catch (err) {
      console.error("ClassSelector load failed:", err.message);
      setError("Failed to load classes");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [examId, schoolId, role, onSelect]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={cl.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={cl.loadingText}>Loading classes…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={cl.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={cl.errorText}>{error}</Text>
        <TouchableOpacity style={cl.retryBtn} onPress={() => load()}>
          <Text style={cl.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (classes.length === 0) {
    return (
      <View style={cl.centered}>
        <Ionicons name="school-outline" size={48} color="#D1D5DB" />
        <Text style={cl.emptyTitle}>No Classes Assigned</Text>
        <Text style={cl.emptyText}>
          This exam has no subjects assigned to any class yet.{"\n"}
          Add subjects from the exam detail screen.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={cl.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => load(true)}
          tintColor="#4F46E5"
          colors={["#4F46E5"]}
        />
      }
    >
      <Text style={cl.hint}>Select a class to enter marks for</Text>
      <Text style={cl.examName}>{examName}</Text>

      {classes.map((cls) => (
        <TouchableOpacity
          key={cls.classId}
          style={cl.card}
          onPress={() => onSelect(cls)}
          activeOpacity={0.7}
        >
          <View style={cl.cardIcon}>
            <Ionicons name="school-outline" size={22} color="#4F46E5" />
          </View>
          <View style={cl.cardInfo}>
            <Text style={cl.cardName}>{displayClass(cls)}</Text>
            <Text style={cl.cardSub}>
              {cls.subjectCount > 0
                ? `${cls.subjectCount} subject${cls.subjectCount !== 1 ? "s" : ""} assigned`
                : "Tap to enter marks"}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#D1D5DB" />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
};

const cl = StyleSheet.create({
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  errorText:   { fontSize: 14, color: "#DC2626", textAlign: "center" },
  emptyTitle:  { fontSize: 16, fontWeight: "700", color: "#374151", textAlign: "center" },
  emptyText:   { fontSize: 13, color: "#9CA3AF", textAlign: "center", lineHeight: 20 },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         4,
  },
  retryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  list:      { padding: 16, gap: 10, paddingBottom: 40 },
  hint:      { fontSize: 13, color: "#9CA3AF", marginBottom: 2 },
  examName:  { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 16 },
  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             14,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardIcon: {
    width:           48,
    height:          48,
    borderRadius:    14,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  cardInfo: { flex: 1 },
  cardName: { fontSize: 16, fontWeight: "700", color: "#111827" },
  cardSub:  { fontSize: 12, color: "#6B7280", marginTop: 3 },
});

// ─────────────────────────────────────────────────────────
// STEP 1 — SUBJECT SELECTOR
// ─────────────────────────────────────────────────────────

const SubjectSelector = ({ examId, classId, schoolId, onSelect }) => {
  const [subjects,   setSubjects]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const res = await ExamService.getSubmissions({ examId, schoolId });
      const all = res?.submissions || [];

      const forClass = classId
        ? all.filter(
            (s) => String(extractClassId(s) || "") === String(classId)
          )
        : all;

      setSubjects(forClass);
    } catch (err) {
      console.error("SubjectSelector load failed:", err.message);
      setError("Failed to load subjects");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [examId, classId, schoolId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={ss.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={ss.loadingText}>Loading subjects…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={ss.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={ss.errorText}>{error}</Text>
        <TouchableOpacity style={ss.retryBtn} onPress={() => load()}>
          <Text style={ss.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={ss.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => load(true)}
          tintColor="#4F46E5"
          colors={["#4F46E5"]}
        />
      }
    >
      <Text style={ss.hint}>Select a subject to enter marks</Text>

      {subjects.length === 0 ? (
        <View style={ss.empty}>
          <Ionicons name="book-outline" size={48} color="#D1D5DB" />
          <Text style={ss.emptyText}>No subjects for this class</Text>
          <Text style={ss.emptySubText}>
            Assign subjects to this class from the exam detail screen
          </Text>
        </View>
      ) : (
        subjects.map((s) => {
          const statusColor =
            s.submissionStatus === "approved"  ? "#059669" :
            s.submissionStatus === "submitted" ? "#4F46E5" :
            s.submissionStatus === "rejected"  ? "#DC2626" : "#D97706";

          const statusBg =
            s.submissionStatus === "approved"  ? "#ECFDF5" :
            s.submissionStatus === "submitted" ? "#EEF2FF" :
            s.submissionStatus === "rejected"  ? "#FEF2F2" : "#FEF3C7";

          return (
            <TouchableOpacity
              key={s._id || s.id}
              style={ss.card}
              onPress={() => onSelect(s)}
              activeOpacity={0.7}
            >
              <View style={ss.cardIcon}>
                <Ionicons name="book" size={20} color="#4F46E5" />
              </View>
              <View style={ss.cardInfo}>
                <Text style={ss.cardName}>
                  {s.subjectName || "Unknown Subject"}
                </Text>
                <Text style={ss.cardSub}>
                  {s.teacherName || "No teacher"} · Max: {s.maxScore} · Pass: {s.passMark}
                </Text>
                <Text style={ss.scoresEntered}>
                  {s.totalScoresEntered ?? 0} score(s) entered
                </Text>
              </View>
              <View style={ss.cardRight}>
                <View style={[ss.statusBadge, { backgroundColor: statusBg }]}>
                  <Text style={[ss.statusText, { color: statusColor }]}>
                    {(s.submissionStatus || "pending").charAt(0).toUpperCase() +
                     (s.submissionStatus || "pending").slice(1)}
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color="#D1D5DB"
                  style={{ marginTop: 4 }}
                />
              </View>
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );
};

const ss = StyleSheet.create({
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  errorText:   { fontSize: 14, color: "#DC2626", textAlign: "center" },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         4,
  },
  retryText:    { color: "#FFF", fontWeight: "700", fontSize: 14 },
  list:         { padding: 16, gap: 10, paddingBottom: 40 },
  hint:         { fontSize: 13, color: "#9CA3AF", marginBottom: 4 },
  empty:        { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyText:    { fontSize: 14, color: "#9CA3AF", textAlign: "center", fontWeight: "600" },
  emptySubText: { fontSize: 12, color: "#D1D5DB", textAlign: "center" },
  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardIcon: {
    width:           44,
    height:          44,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  cardInfo:      { flex: 1 },
  cardName:      { fontSize: 15, fontWeight: "700", color: "#111827" },
  cardSub:       { fontSize: 12, color: "#6B7280", marginTop: 2 },
  scoresEntered: { fontSize: 11, color: "#059669", fontWeight: "600", marginTop: 2 },
  cardRight:     { alignItems: "flex-end", gap: 4 },
  statusBadge:   { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusText:    { fontSize: 11, fontWeight: "700" },
});

// ─────────────────────────────────────────────────────────
// STEP 2 — SCORE ENTRY
// ─────────────────────────────────────────────────────────

const ScoreEntry = ({
  examId,
  examSubjectId,
  subjectId,
  classId,
  schoolId,
  role,
  maxScore,
  passMark,
  subjectName,
  onSaved,
  saveRef,
}) => {
  const [students,   setStudents]   = useState([]);
  const [scores,     setScores]     = useState({});
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      if (!classId) {
        Alert.alert("Error", "No class selected. Please go back and select a class.");
        return;
      }
      if (!examId) {
        Alert.alert("Error", "No exam selected. Please go back and select an exam.");
        return;
      }

      const [studentList, scoresRes] = await Promise.all([
        fetchStudentsForClass(schoolId, classId, role),
        ExamService.getScores({ examId, subjectId, classId, schoolId }),
      ]);

      setStudents(studentList);

      const existingScores = scoresRes?.scores || [];
      const map = {};
      for (const s of existingScores) {
        map[String(s.studentId)] = {
          score:         s.score ?? "",
          teacherRemark: s.teacherRemark || "",
          isAbsent:      s.isAbsent ?? false,
        };
      }
      setScores(map);
    } catch (err) {
      console.error("ScoreEntry load failed:", err.message);
      Alert.alert("Load Failed", "Could not load students. Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [examId, subjectId, classId, schoolId, role]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateScore = useCallback((studentId, field, value) => {
    setScores((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], [field]: value },
    }));
  }, []);

  const toggleAbsent = useCallback((studentId) => {
    setScores((prev) => {
      const wasAbsent = prev[studentId]?.isAbsent ?? false;
      return {
        ...prev,
        [studentId]: {
          ...prev[studentId],
          isAbsent: !wasAbsent,
          score:    !wasAbsent ? "" : prev[studentId]?.score ?? "",
        },
      };
    });
  }, []);

  const markAllPresent = useCallback(() => {
    setScores((prev) => {
      const updated = {};
      for (const s of students) {
        updated[s._id] = { ...(prev[s._id] || {}), isAbsent: false };
      }
      return { ...prev, ...updated };
    });
  }, [students]);

  const handleSave = useCallback(async () => {
    if (students.length === 0) {
      Alert.alert("No Students", "There are no students to save scores for.");
      return;
    }

    const records = students.map((s) => {
      const entry    = scores[s._id] || {};
      const rawScore = String(entry.score ?? "").trim();
      const score    = rawScore === "" ? null : Number(rawScore);
      return {
        studentId:     s._id,
        score,
        maxScore,
        teacherRemark: entry.teacherRemark || null,
        isAbsent:      entry.isAbsent ?? false,
      };
    });

    const invalid = records.filter(
      (r) => !r.isAbsent && r.score !== null && (r.score < 0 || r.score > maxScore)
    );

    if (invalid.length > 0) {
      Alert.alert(
        "Invalid Scores",
        `${invalid.length} score(s) are out of range (0–${maxScore}).`
      );
      return;
    }

    const unentered = records.filter((r) => !r.isAbsent && r.score === null);

    const doSave = async () => {
      try {
        setSaving(true);
        const saveRes = await ExamService.saveBulkScores({
          examId, classId, subjectId, examSubjectId,
          scores: records, schoolId,
        });
        Alert.alert(
          saveRes?.queued ? "Saved Offline" : "Saved",
          `Scores saved for ${records.length} student(s).` +
          (saveRes?.queued
            ? "\n\nStored on this device — they will upload automatically when you're back online."
            : ""),
          [
            { text: "Enter Another Subject", onPress: () => onSaved("back") },
            { text: "Done", style: "cancel", onPress: () => onSaved("exit") },
          ]
        );
      } catch (err) {
        Alert.alert("Save Failed", err.message || "Please try again");
      } finally {
        setSaving(false);
      }
    };

    if (unentered.length > 0) {
      Alert.alert(
        "Unentered Scores",
        `${unentered.length} student(s) have no score entered. They will be saved as blank. Continue?`,
        [
          { text: "Cancel",      style: "cancel" },
          { text: "Save Anyway", onPress: doSave },
        ]
      );
    } else {
      await doSave();
    }
  }, [students, scores, maxScore, examId, classId, subjectId, examSubjectId, schoolId, onSaved]);

  useEffect(() => {
    if (saveRef) saveRef.current = handleSave;
  }, [handleSave, saveRef]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return students;
    return students.filter(
      (s) =>
        s.studentName?.toLowerCase().includes(q) ||
        s.admissionNo?.toLowerCase().includes(q)  ||
        s.email?.toLowerCase().includes(q)
    );
  }, [students, search]);

  const enteredCount = useMemo(
    () =>
      Object.values(scores).filter(
        (s) => s.isAbsent || (s.score !== "" && s.score !== null && s.score !== undefined)
      ).length,
    [scores]
  );

  const progressPct = students.length > 0
    ? Math.round((enteredCount / students.length) * 100)
    : 0;

  if (loading) {
    return (
      <View style={se.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={se.loadingText}>Loading students…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={se.container}>

        {/* Progress bar */}
        <View style={se.progress}>
          <View style={se.progressInfo}>
            <Text style={se.progressText}>
              {enteredCount} / {students.length} entered
            </Text>
            <Text style={se.progressPct}>{progressPct}%</Text>
          </View>
          <View style={se.progressBarBg}>
            <View style={[se.progressBarFill, { width: `${progressPct}%` }]} />
          </View>
          <View style={se.progressRow}>
            <Text style={se.subjectLabel}>
              {subjectName} · Max: {maxScore} · Pass: {passMark}
            </Text>
            <TouchableOpacity onPress={markAllPresent}>
              <Text style={se.markAllText}>Mark All Present</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={se.searchBox}>
          <Ionicons name="search-outline" size={16} color="#9CA3AF" />
          <TextInput
            style={se.searchInput}
            placeholder="Search student…"
            placeholderTextColor="#9CA3AF"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>

        {/* Student list */}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item._id}
          contentContainerStyle={se.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadData(true)}
              tintColor="#4F46E5"
              colors={["#4F46E5"]}
            />
          }
          renderItem={({ item }) => {
            const entry    = scores[item._id] || {};
            const rawScore = String(entry.score ?? "");
            const numScore = rawScore !== "" ? Number(rawScore) : null;
            const scorePct = numScore !== null
              ? Math.round((numScore / maxScore) * 100)
              : null;
            const color = scorePct !== null ? rateColor(scorePct) : "#9CA3AF";

            return (
              <View style={[se.row, entry.isAbsent && se.rowAbsent]}>
                <View style={[se.avatar, { backgroundColor: color + "20" }]}>
                  <Text style={[se.avatarText, { color }]}>
                    {(item.studentName || "?").charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={se.studentInfo}>
                  <Text style={se.studentName} numberOfLines={1}>
                    {item.studentName}
                  </Text>
                  <Text style={se.studentSub}>
                    {item.admissionNo ? `#${item.admissionNo}` : item.email || ""}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[se.absentBtn, entry.isAbsent && se.absentBtnActive]}
                  onPress={() => toggleAbsent(item._id)}
                  activeOpacity={0.7}
                >
                  <Text style={[se.absentBtnText, entry.isAbsent && se.absentBtnTextActive]}>
                    ABS
                  </Text>
                </TouchableOpacity>
                <View style={se.scoreBox}>
                  <TextInput
                    style={[
                      se.scoreInput,
                      entry.isAbsent && se.scoreInputAbsent,
                      numScore !== null && !entry.isAbsent && {
                        borderColor: color,
                        borderWidth: 1.5,
                      },
                    ]}
                    value={entry.isAbsent ? "ABS" : rawScore}
                    onChangeText={(v) => {
                      if (!entry.isAbsent) updateScore(item._id, "score", v);
                    }}
                    keyboardType="numeric"
                    editable={!entry.isAbsent}
                    placeholder="—"
                    placeholderTextColor="#D1D5DB"
                    selectTextOnFocus
                    maxLength={5}
                  />
                  {scorePct !== null && !entry.isAbsent && (
                    <Text style={[se.scorePct, { color }]}>{scorePct}%</Text>
                  )}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={se.empty}>
              <Ionicons name="people-outline" size={48} color="#D1D5DB" />
              <Text style={se.emptyTitle}>
                {search ? "No students match your search" : "No students found in this class"}
              </Text>
              {!search && (
                <Text style={se.emptySub}>
                  Make sure students are enrolled and assigned to this class
                </Text>
              )}
            </View>
          }
        />
      </View>
    </KeyboardAvoidingView>
  );
};

const se = StyleSheet.create({
  container:   { flex: 1 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  progress: {
    backgroundColor:   "#FFF",
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  progressInfo: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   6,
  },
  progressText:    { fontSize: 13, color: "#374151", fontWeight: "600" },
  progressPct:     { fontSize: 13, color: "#4F46E5", fontWeight: "700" },
  progressBarBg: {
    height:          5,
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
    marginBottom:    8,
  },
  progressBarFill: { height: 5, backgroundColor: "#4F46E5", borderRadius: 3 },
  progressRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
  },
  subjectLabel: { fontSize: 11, color: "#6B7280" },
  markAllText:  { fontSize: 11, color: "#4F46E5", fontWeight: "700" },
  searchBox: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F9FAFB",
    borderRadius:      10,
    paddingHorizontal: 12,
    height:            40,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               8,
    margin:            12,
    marginBottom:      4,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },
  list:        { padding: 12, paddingTop: 8, gap: 6, paddingBottom: 40 },
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         10,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             8,
  },
  rowAbsent:   { backgroundColor: "#FEF2F2", borderColor: "#FEE2E2" },
  avatar: {
    width:          36,
    height:         36,
    borderRadius:   18,
    alignItems:     "center",
    justifyContent: "center",
  },
  avatarText:          { fontSize: 14, fontWeight: "800" },
  studentInfo:         { flex: 1 },
  studentName:         { fontSize: 13, fontWeight: "700", color: "#111827" },
  studentSub:          { fontSize: 11, color: "#9CA3AF" },
  absentBtn: {
    paddingHorizontal: 8,
    paddingVertical:   5,
    borderRadius:      8,
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    backgroundColor:   "transparent",
  },
  absentBtnActive:     { backgroundColor: "#DC2626", borderColor: "#DC2626" },
  absentBtnText:       { fontSize: 10, fontWeight: "700", color: "#9CA3AF" },
  absentBtnTextActive: { color: "#FFF" },
  scoreBox:            { alignItems: "center", minWidth: 64 },
  scoreInput: {
    backgroundColor:   "#F9FAFB",
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    paddingHorizontal: 8,
    paddingVertical:   6,
    fontSize:          15,
    fontWeight:        "700",
    color:             "#111827",
    textAlign:         "center",
    width:             60,
  },
  scoreInputAbsent: { backgroundColor: "#F3F4F6", color: "#9CA3AF", borderColor: "#E5E7EB" },
  scorePct:         { fontSize: 10, fontWeight: "600", marginTop: 2 },
  empty:            { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyTitle:       { fontSize: 14, color: "#9CA3AF", textAlign: "center", fontWeight: "600" },
  emptySub:         { fontSize: 12, color: "#D1D5DB", textAlign: "center" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function MarkEntryScreen() {
  const router = useRouter();
  const {
    examId:        paramExamId,
    examName:      paramExamName,
    classId:       paramClassId,
    className:     paramClassName,
    subjectId:     paramSubjectId,
    subjectName:   paramSubjectName,
    examSubjectId: paramExamSubjectId,
    maxScore:      paramMaxScore,
    passMark:      paramPassMark,
  } = useLocalSearchParams();

  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;
  const role     = user?.role || "";

  const [selectedExam, setSelectedExam] = useState(
    paramExamId
      ? { _id: paramExamId, name: paramExamName || "Exam" }
      : null
  );

  const [selectedClass, setSelectedClass] = useState(
    paramClassId
      ? { classId: paramClassId, className: paramClassName || "" }
      : null
  );

  const [selectedSubject, setSelectedSubject] = useState(
    paramSubjectId
      ? {
          subjectId:     paramSubjectId,
          subjectName:   paramSubjectName   || "Subject",
          examSubjectId: paramExamSubjectId || null,
          maxScore:      Number(paramMaxScore)  || 100,
          passMark:      Number(paramPassMark)  || 50,
        }
      : null
  );

  const saveRef = useRef(null);

  // Resolve className when missing from params
  useEffect(() => {
    if (!paramClassId || !schoolId) return;
    if (selectedClass?.className && selectedClass.className !== "") return;

    const resolve = async () => {
      const allClasses = await fetchClasses(schoolId, role);
      const match      = allClasses.find((c) => c.id === String(paramClassId));
      setSelectedClass({
        classId:   paramClassId,
        className: match?.name || `Class …${String(paramClassId).slice(-4)}`,
      });
    };
    resolve();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramClassId, schoolId, role]);

  const step =
    selectedSubject ? 3 :
    selectedClass   ? 2 :
    selectedExam    ? 1 :
                      0;

  const handleBack = useCallback(() => {
    if (step === 3 && !paramSubjectId) setSelectedSubject(null);
    else if (step === 2 && !paramClassId) setSelectedClass(null);
    else if (step === 1 && !paramExamId) setSelectedExam(null);
    else router.back();
  }, [step, paramSubjectId, paramClassId, paramExamId, router]);

  const handleSaved = useCallback((action) => {
    if (action === "back" && !paramSubjectId) setSelectedSubject(null);
    else router.back();
  }, [paramSubjectId, router]);

  const headerTitle =
    step === 3 ? selectedSubject?.subjectName :
    step === 2 ? "Select Subject"             :
    step === 1 ? selectedExam?.name           :
                 "Mark Entry";

  const headerSub =
    step === 3
      ? `${selectedExam?.name || "Exam"} · ${displayClass(selectedClass)}` :
    step === 2
      ? `${displayClass(selectedClass)} — pick a subject`                   :
    step === 1
      ? "Select a class"                                                    :
      "Select an exam to start";

  return (
    <View style={ms.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Header */}
      <View style={ms.header}>
        <TouchableOpacity
          style={ms.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={ms.headerCenter}>
          <Text style={ms.headerTitle} numberOfLines={1}>{headerTitle}</Text>
          <Text style={ms.headerSub}   numberOfLines={1}>{headerSub}</Text>
        </View>

        {step === 3 && (
          <TouchableOpacity
            style={ms.saveBtn}
            onPress={() => saveRef.current?.()}
            activeOpacity={0.8}
          >
            <Text style={ms.saveBtnText}>Save</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Breadcrumb */}
      {step > 0 && (
        <View style={ms.breadcrumb}>
          <TouchableOpacity
            disabled={!!paramExamId}
            onPress={() => {
              if (!paramExamId) {
                setSelectedSubject(null);
                setSelectedClass(null);
                setSelectedExam(null);
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={[ms.crumb, !paramExamId && ms.crumbLink]}>
              Exams
            </Text>
          </TouchableOpacity>

          <Ionicons name="chevron-forward" size={13} color="#D1D5DB" />

          <TouchableOpacity
            disabled={step <= 1 || !!paramClassId}
            onPress={() => {
              if (!paramClassId) {
                setSelectedSubject(null);
                setSelectedClass(null);
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={[
              ms.crumb,
              step > 1 && !paramClassId && ms.crumbLink,
              step === 1 && ms.crumbActive,
            ]}
              numberOfLines={1}
            >
              {selectedExam?.name || "Exam"}
            </Text>
          </TouchableOpacity>

          {step >= 2 && (
            <>
              <Ionicons name="chevron-forward" size={13} color="#D1D5DB" />
              <TouchableOpacity
                disabled={step <= 2 || !!paramSubjectId}
                onPress={() => {
                  if (!paramSubjectId) setSelectedSubject(null);
                }}
                activeOpacity={0.7}
              >
                <Text style={[
                  ms.crumb,
                  step > 2 && !paramSubjectId && ms.crumbLink,
                  step === 2 && ms.crumbActive,
                ]}
                  numberOfLines={1}
                >
                  {displayClass(selectedClass)}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {step === 3 && (
            <>
              <Ionicons name="chevron-forward" size={13} color="#D1D5DB" />
              <Text style={[ms.crumb, ms.crumbActive]} numberOfLines={1}>
                {selectedSubject?.subjectName}
              </Text>
            </>
          )}
        </View>
      )}

      {/* Step content */}
      {step === 0 && (
        <ExamSelector
          schoolId={schoolId}
          role={role}
          onSelect={(exam) =>
            setSelectedExam({
              _id:  String(exam._id || exam.id),
              name: exam.name,
            })
          }
        />
      )}

      {step === 1 && (
        <ClassSelector
          examId={selectedExam._id}
          examName={selectedExam.name}
          schoolId={schoolId}
          role={role}
          onSelect={(cls) => setSelectedClass(cls)}
        />
      )}

      {step === 2 && (
        <SubjectSelector
          examId={selectedExam._id}
          classId={selectedClass.classId}
          schoolId={schoolId}
          onSelect={(submission) => {
            setSelectedSubject({
              subjectId:     String(submission.subjectId),
              subjectName:   submission.subjectName  || "Subject",
              examSubjectId: String(submission._id   || submission.id),
              maxScore:      submission.maxScore      ?? 100,
              passMark:      submission.passMark      ?? 50,
            });
          }}
        />
      )}

      {step === 3 && (
        <ScoreEntry
          examId={selectedExam?._id    || paramExamId}
          examSubjectId={selectedSubject.examSubjectId}
          subjectId={selectedSubject.subjectId}
          classId={selectedClass?.classId || paramClassId}
          schoolId={schoolId}
          role={role}
          maxScore={selectedSubject.maxScore ?? 100}
          passMark={selectedSubject.passMark ?? 50}
          subjectName={selectedSubject.subjectName}
          onSaved={handleSaved}
          saveRef={saveRef}
        />
      )}
    </View>
  );
}

const ms = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
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
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  saveBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 18,
  },
  saveBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  breadcrumb: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    flexWrap:          "wrap",
  },
  crumb:       { fontSize: 13, color: "#9CA3AF", fontWeight: "600" },
  crumbLink:   { color: "#4F46E5" },
  crumbActive: { color: "#111827", fontWeight: "700" },
});