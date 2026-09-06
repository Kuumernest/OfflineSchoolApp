// app/admin/exams/marks.js
"use strict";

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, StatusBar, RefreshControl, BackHandler,
  TextInput, ScrollView, KeyboardAvoidingView, Modal,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { ExamService }  from "../../../src/services/exam.service";
import api              from "../../../src/services/api";
import { getDatabase }  from "../../../src/db/database";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const rateColor = (pct) => {
  if (pct >= 70) return "#059669";
  if (pct >= 50) return "#D97706";
  return "#DC2626";
};

// Keep a score box to digits plus at most one decimal point. Numeric
// keypads still offer "-" and "." on Android, and pasting bypasses them
// entirely, so the text is cleaned on the way in rather than trusted.
const sanitizeScore = (v) => {
  const cleaned = String(v ?? "").replace(/[^0-9.]/g, "");
  const parts   = cleaned.split(".");
  return parts.length <= 2 ? cleaned : `${parts[0]}.${parts.slice(1).join("")}`;
};

// The status/type maps hold translation KEYS, not text: they live at module
// scope where the hook cannot run, so the component resolves them at render.
const STATUS_META = {
  draft:     { color: "#6B7280", bg: "#F3F4F6", labelKey: "examStatus.draft"     },
  scheduled: { color: "#4F46E5", bg: "#EEF2FF", labelKey: "examStatus.scheduled" },
  ongoing:   { color: "#D97706", bg: "#FEF3C7", labelKey: "examStatus.ongoing"   },
  completed: { color: "#059669", bg: "#ECFDF5", labelKey: "examStatus.completed" },
  published: { color: "#7C3AED", bg: "#F5F3FF", labelKey: "examStatus.published" },
  archived:  { color: "#9CA3AF", bg: "#F9FAFB", labelKey: "examStatus.archived"  },
};

const EXAM_TYPE_KEYS = {
  test:               "examType.test",
  practical:          "examType.practical",
  promotion_exam:     "examType.promotion_exam",
};

const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];
const isAdminRole = (role) => ADMIN_ROLES.includes(role);

const extractClassId = (s) =>
  s.classId || s.class_id || s.class?._id || s.class?.id || null;

const displayClass = (cls, t) => {
  if (!cls) return t("examDetail.classFallback");
  if (cls.className && cls.className !== t("marksEntry.unknownClass")) return cls.className;
  if (cls.classId)
    return t("teacherExamSubjects.classShort", {
      suffix: String(cls.classId).slice(-4),
    });
  return t("examDetail.classFallback");
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

const classesFromCache = async (schoolId, t) => {
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
      name: c.name || t("teacherExamSubjects.classShort", {
        suffix: String(c.id).slice(-4),
      }),
    }));
  } catch (err) {
    console.warn("[classesFromCache] failed:", err.message);
    return [];
  }
};

const studentsFromCache = async (classId, t) => {
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
      studentName: s.studentName || s.name || t("teacherExamSubjects.unknownStudent"),
      admissionNo: s.admissionNo || s.admissionNumber || null,
      email:       s.email || null,
      classId:     String(s.classId || s.class_id || classId),
    }));
  } catch (err) {
    console.warn("[studentsFromCache] failed:", err.message);
    return [];
  }
};

const fetchClasses = async (schoolId, role, t) => {
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
      name: c.name || c.className || t("teacherExamSubjects.classShort", {
        suffix: String(c._id || c.id).slice(-4),
      }),
    }));
    if (list.length) return list;
    return classesFromCache(schoolId, t);
  } catch (err) {
    console.warn("[fetchClasses] network failed, using cache:", err.message);
    return classesFromCache(schoolId, t);
  }
};

// ─────────────────────────────────────────────────────────
// ROLE-AWARE STUDENT FETCHER
// ─────────────────────────────────────────────────────────

const fetchStudentsForClass = async (schoolId, classId, role, t) => {
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
        studentName: s.studentName || s.name || t("teacherExamSubjects.unknownStudent"),
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
        studentName: s.studentName || s.name || t("teacherExamSubjects.unknownStudent"),
        admissionNo: s.admissionNo || null,
        email:       s.email || null,
        classId:     String(s.classId || classId),
      }));
    }
  } catch (err) {
    console.warn("[fetchStudents] roster fallback failed:", err.message);
  }

  // Last resort: the locally synced roster.
  return studentsFromCache(classId, t);
};

// ─────────────────────────────────────────────────────────
// STEP 0 — EXAM SELECTOR
// ─────────────────────────────────────────────────────────

const ExamSelector = ({ schoolId, role, onSelect }) => {
  const { t } = useTranslation();
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
      setError(t("marksEntry.loadExamsFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, t]);

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
        <Text style={ex.loadingText}>{t("marksEntry.loadingExams")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={ex.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={ex.errorText}>{error}</Text>
        <TouchableOpacity style={ex.retryBtn} onPress={() => load()}>
          <Text style={ex.retryText}>{t("common.retry")}</Text>
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
            placeholder={t("exams.searchPh")}
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
          { key: "all",       labelKey: "marksEntry.filterAllExams" },
          { key: "ongoing",   labelKey: "examStatus.ongoing"        },
          { key: "scheduled", labelKey: "examStatus.scheduled"      },
          { key: "draft",     labelKey: "examStatus.draft"          },
          { key: "completed", labelKey: "examStatus.completed"      },
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
              {t(f.labelKey)}
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
                ? t("marksEntry.emptyFiltered")
                : t("marksEntry.emptyNone")}
            </Text>
            <Text style={ex.emptySub}>
              {search || filter !== "all"
                ? t("marksEntry.emptyFilteredSub")
                : t("marksEntry.emptyNoneSub")}
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
                      {t(meta.labelKey)}
                    </Text>
                  </View>
                </View>
                <View style={ex.cardMeta}>
                  <View style={ex.cardMetaItem}>
                    <Ionicons name="grid-outline" size={12} color="#9CA3AF" />
                    <Text style={ex.cardMetaText}>
                      {EXAM_TYPE_KEYS[item.type]
                        ? t(EXAM_TYPE_KEYS[item.type])
                        : item.type}
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
                    {t("examDetail.maxLabel", { value: item.totalMarks })}
                    {" · "}
                    {t("examDetail.passLabel", { value: item.passMark })}
                  </Text>
                  <View style={ex.enterBtn}>
                    <Ionicons name="create-outline" size={13} color="#4F46E5" />
                    <Text style={ex.enterBtnText}>{t("exams.enterMarks")}</Text>
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
// STEP 1 — CLASS + SUBJECT SELECTOR (subjects grouped by class)
//
// Single screen: the exam is already chosen, so the teacher / admin can
// immediately see every class in that exam and the subject mark-sheets
// under it. Tapping a subject row opens the mark sheet for that class +
// subject, where they fill in the marks for ALL students before the one
// Save button.
// ─────────────────────────────────────────────────────────

const SUB_STATUS_META = {
  pending:   { color: "#D97706", bg: "#FEF3C7", labelKey: "results.pending",   },
  submitted: { color: "#4F46E5", bg: "#EEF2FF", labelKey: "results.submitted", },
  approved:  { color: "#059669", bg: "#ECFDF5", labelKey: "results.approved",  },
  rejected:  { color: "#DC2626", bg: "#FEF2F2", labelKey: "results.rejected",  },
};

const ClassSubjectPicker = ({
  examId, examName, schoolId, role,
  initialClassId = "", onSelect,
}) => {
  const { t } = useTranslation();
  const [sections,   setSections]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const [submissionsRes, allClasses] = await Promise.all([
        ExamService.getSubmissions({ examId, schoolId }),
        fetchClasses(schoolId, role),
      ]);

      const submissions = submissionsRes?.submissions || [];

      const classMap = {};
      for (const c of allClasses) classMap[String(c.id)] = c.name;

      const grouped = {};
      for (const s of submissions) {
        const cidStr = String(extractClassId(s) || "");
        if (!cidStr) continue;
        if (!grouped[cidStr]) {
          grouped[cidStr] = {
            classId:   cidStr,
            className: classMap[cidStr] || s.className || ("Class …" + cidStr.slice(-4)),
            subjects:  [],
          };
        }
        grouped[cidStr].subjects.push({
          id:                 String(s._id || s.id),
          examSubjectId:      String(s._id || s.id),
          subjectId:          String(s.subjectId || ""),
          subjectName:        s.subjectName  || t("marksEntry.unknownSubject"),
          className:          grouped[cidStr].className,
          classId:            cidStr,
          teacherName:        s.teacherName || t("marksEntry.noTeacher"),
          maxScore:           s.maxScore ?? 100,
          passMark:           s.passMark ?? 50,
          submissionStatus:   s.submissionStatus || "pending",
          totalScoresEntered: s.totalScoresEntered ?? 0,
          totalStudents:      s.totalStudents ?? 0,
        });
      }

      const list = Object.values(grouped).sort((a, b) =>
        a.className.localeCompare(b.className)
      );

      setSections(list);
    } catch (err) {
      console.error("ClassSubjectPicker load failed:", err.message);
      setError(t("marksEntry.loadClassesFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [examId, schoolId, role, t]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = sections;
    if (initialClassId) list = list.filter((sc) => sc.classId === String(initialClassId));
    if (!q) return list;
    return list
      .map((sc) => ({
        ...sc,
        subjects: sc.subjects.filter(
          (s) =>
            s.subjectName.toLowerCase().includes(q) ||
            sc.className.toLowerCase().includes(q)
        ),
      }))
      .filter((sc) => sc.subjects.length > 0);
  }, [sections, search, initialClassId]);

  if (loading) {
    return (
      <View style={cs.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={cs.loadingText}>{t("marksEntry.loadingClasses")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={cs.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={cs.errorText}>{error}</Text>
        <TouchableOpacity style={cs.retryBtn} onPress={() => load()}>
          <Text style={cs.retryText}>{t("common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (filtered.length === 0) {
    return (
      <View style={cs.centered}>
        <Ionicons name="school-outline" size={48} color="#D1D5DB" />
        <Text style={cs.emptyTitle}>{t("marksEntry.noSubjectsTitle")}</Text>
        <Text style={cs.emptyText}>
          This exam has no subjects assigned to a class yet.{"\n"}
          Add subjects from the exam detail screen.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Search */}
      <View style={cs.searchWrap}>
        <Ionicons name="search-outline" size={16} color="#9CA3AF" />
        <TextInput
          style={cs.searchInput}
          placeholder={t("marksEntry.searchSubjectClass")}
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

      <Text style={cs.hint}>
        {examName} — choose a subject for a class to enter its marks
      </Text>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={cs.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {filtered.map((sc) => (
          <View key={sc.classId}>
            {/* Class header */}
            <View style={cs.classHeader}>
              <View style={cs.classIconBg}>
                <Ionicons name="school-outline" size={16} color="#4F46E5" />
              </View>
              <View style={cs.classHeaderText}>
                <Text style={cs.className}>{sc.className}</Text>
                <Text style={cs.classMeta}>
                  {sc.subjects.length} subject
                  {sc.subjects.length !== 1 ? "s" : ""}
                </Text>
              </View>
            </View>

            {sc.subjects.map((s) => {
              const meta = SUB_STATUS_META[s.submissionStatus] || SUB_STATUS_META.pending;
              const isApproved = s.submissionStatus === "approved";
              const isRejected = s.submissionStatus === "rejected";
              const pctEntered = s.totalStudents > 0
                ? Math.round((s.totalScoresEntered / s.totalStudents) * 100)
                : s.totalScoresEntered > 0 ? 100 : 0;

              return (
                <TouchableOpacity
                  key={s.id}
                  style={cs.card}
                  onPress={() => onSelect(s)}
                  activeOpacity={0.7}
                  disabled={isApproved}
                >
                  <View style={cs.cardAccent} />
                  <View style={cs.cardIcon}>
                    <Ionicons name="book" size={20} color="#4F46E5" />
                  </View>
                  <View style={cs.cardInfo}>
                    <Text style={cs.cardName}>{s.subjectName}</Text>
                    <Text style={cs.cardSub}>
                      {s.teacherName} · Max: {s.maxScore} · Pass: {s.passMark}
                    </Text>
                    {s.totalStudents > 0 && (
                      <View style={cs.progressRow}>
                        <View style={cs.progressBg}>
                          <View style={[cs.progressFill, { width: `${pctEntered}%` }]} />
                        </View>
                        <Text style={cs.progressText}>
                          {s.totalScoresEntered}/{s.totalStudents} entered
                        </Text>
                      </View>
                    )}
                    {isRejected && (
                      <Text style={cs.rejectText} numberOfLines={2}>
                        ★ rejected — re-enter marks
                      </Text>
                    )}
                  </View>
                  <View style={cs.cardRight}>
                    <View style={[cs.statusBadge, { backgroundColor: meta.bg }]}>
                      <Text style={[cs.statusText, { color: meta.color }]}>{t(meta.labelKey)}</Text>
                    </View>
                    {!isApproved && (
                      <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
};

const cs = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  loadingText: { fontSize: 14, color: "#6B7280" },
  errorText:   { fontSize: 14, color: "#DC2626", textAlign: "center" },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         4,
  },
  retryText:   { color: "#FFF", fontWeight: "700", fontSize: 14 },
  emptyTitle:  { fontSize: 16, fontWeight: "700", color: "#374151", textAlign: "center" },
  emptyText:   { fontSize: 13, color: "#9CA3AF", textAlign: "center", lineHeight: 20 },
  searchWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#F9FAFB", borderRadius: 10, paddingHorizontal: 12, height: 40,
    borderWidth: 1, borderColor: "#E5E7EB", gap: 8, margin: 12, marginBottom: 4,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },
  hint:        { fontSize: 12, color: "#6B7280", marginHorizontal: 16, marginTop: 4, marginBottom: 2 },
  list:        { paddingHorizontal: 16, paddingBottom: 48, gap: 4 },
  classHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#F3F4F6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 6,
  },
  classIconBg: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center",
  },
  classHeaderText: { flex: 1 },
  className: { fontSize: 14, fontWeight: "700", color: "#111827" },
  classMeta: { fontSize: 11, color: "#6B7280", marginTop: 1 },
  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             10,
    marginBottom:    6,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       1,
  },
  cardAccent: { width: 4, borderRadius: 2, alignSelf: "stretch", backgroundColor: "#EEF2FF" },
  cardIcon: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center",
  },
  cardInfo:  { flex: 1 },
  cardName:  { fontSize: 14, fontWeight: "700", color: "#111827" },
  cardSub:   { fontSize: 11, color: "#6B7280", marginTop: 2 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
  progressBg: {
    height: 5, borderRadius: 3, flex: 1, backgroundColor: "#F3F4F6", overflow: "hidden",
  },
  progressFill:       { height: 5, borderRadius: 3, backgroundColor: "#059669" },
  progressText:       { fontSize: 10, color: "#6B7280", fontWeight: "600" },
  rejectText:         { fontSize: 11, color: "#DC2626", marginTop: 2, fontWeight: "600" },
  cardRight:          { alignItems: "flex-end", gap: 4 },
  statusBadge:        { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusText:         { fontSize: 11, fontWeight: "700" },
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
  onSavingChange,
  onDirtyChange,
}) => {
  const { t } = useTranslation();
  const [students,   setStudents]   = useState([]);
  const [scores,     setScores]     = useState({});
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");
  const [dirty,      setDirty]      = useState(false);

  // Correcting a published or locked result. The server refuses the write and
  // an administrator may override it, but only by recording why — and there
  // was nowhere on this screen to say. The strings existed in both locale
  // files and nothing rendered them.
  const [reasonPrompt, setReasonPrompt] = useState(null);   // "locked" | "published"
  const [reasonText,   setReasonText]   = useState("");

  // doSave is rebuilt inside handleSave, so the dialog reaches the current one
  // through a ref rather than closing over a stale copy.
  const saveWithReasonRef = useRef(null);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      if (!classId) {
        Alert.alert(t("marksEntry.errTitle"), t("marksEntry.noClassSelected"));
        return;
      }
      if (!examId) {
        Alert.alert(t("marksEntry.errTitle"), t("marksEntry.noExamSelected"));
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
      setDirty(false);
    } catch (err) {
      console.error("ScoreEntry load failed:", err.message);
      Alert.alert(t("marksEntry.loadFailedTitle"), t("marksEntry.loadStudentsFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [classId, examId, schoolId, role, subjectId, t]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateScore = useCallback((studentId, field, value) => {
    setDirty(true);
    setScores((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], [field]: value },
    }));
  }, []);

  const toggleAbsent = useCallback((studentId) => {
    setDirty(true);
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
    setDirty(true);
    setScores((prev) => {
      const updated = {};
      for (const s of students) {
        updated[s._id] = { ...(prev[s._id] || {}), isAbsent: false };
      }
      return { ...prev, ...updated };
    });
  }, [students]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    if (students.length === 0) {
      Alert.alert(t("marksEntry.noStudentsTitle"), t("marksEntry.noStudentsToSave"));
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

    // Number("abc") is NaN, and NaN fails BOTH range comparisons, so an
    // unparseable box would otherwise sail through and reach the server.
    const invalid = records.filter(
      (r) =>
        !r.isAbsent && r.score !== null &&
        (!Number.isFinite(r.score) || r.score < 0 || r.score > maxScore)
    );

    if (invalid.length > 0) {
      const names = invalid
        .map((r) => students.find((s) => s._id === r.studentId)?.studentName)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
      Alert.alert(
        t("marksEntry.invalidTitle"),
        `${invalid.length} score(s) must be a number between 0 and ${maxScore}.` +
        (names ? `

Check: ${names}${invalid.length > 3 ? " …" : ""}` : "")
      );
      return;
    }

    const unentered = records.filter((r) => !r.isAbsent && r.score === null);

    const doSave = async (changeReason) => {
      try {
        setSaving(true);
        const saveRes = await ExamService.saveBulkScores({
          examId, classId, subjectId, examSubjectId,
          scores: records, schoolId,
          ...(changeReason ? { changeReason } : {}),
        });
        setDirty(false);
        Alert.alert(
          saveRes?.queued ? t("marksEntry.savedOffline") : t("marksEntry.saved"),
          `Scores saved for ${records.length} student(s).` +
          (saveRes?.queued
            ? "\n\nStored on this device — they will upload automatically when you're back online."
            : ""),
          [
            { text: t("marksEntry.enterAnother"), onPress: () => onSaved("back") },
            { text: t("common.done"), style: "cancel", onPress: () => onSaved("exit") },
          ]
        );
        setReasonPrompt(null);
        setReasonText("");
      } catch (err) {
        // 423 is the server asking for something the person can give, not a
        // failure to report and stop at. The marks were rolled back in the
        // service, so the sheet still shows what was typed and nothing on the
        // device is left pretending it was saved.
        const status = err?.response?.status;
        const code   = err?.response?.data?.code;

        if (status === 423 && code === "REASON_REQUIRED") {
          setReasonPrompt("published");
        } else if (status === 423 && code === "RESULTS_LOCKED") {
          setReasonPrompt("locked");
        } else {
          // Including a 423 this account may not override at all, which no
          // reason would get past.
          Alert.alert(t("marksEntry.saveFailed"), errorText(t, err, "marksEntry.tryAgain"));
        }
      } finally {
        setSaving(false);
      }
    };

    saveWithReasonRef.current = doSave;

    if (unentered.length > 0) {
      const names = unentered
        .map((r) => students.find((s) => s._id === r.studentId)?.studentName)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
      Alert.alert(
        t("marksEntry.unenteredTitle"),
        t("marksEntry.unenteredBody", { count: unentered.length }) +
          (names ? `\n\n${names}${unentered.length > 3 ? " …" : ""}` : ""),
        [{ text: t("common.done") }]
      );
      return;
    }

    await doSave();
  }, [saving, students, t, scores, maxScore, examId, classId, subjectId, examSubjectId, schoolId, onSaved]);

  useEffect(() => {
    if (saveRef) saveRef.current = handleSave;
  }, [handleSave, saveRef]);

  // The Save button and the back guard live in the parent header, so it
  // needs to know when a save is in flight and whether anything is unsaved.
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);
  useEffect(() => { onDirtyChange?.(dirty);   }, [dirty,  onDirtyChange]);

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
        <Text style={se.loadingText}>{t("marksEntry.loadingStudents")}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
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
              <Text style={se.markAllText}>{t("marksEntry.markAllPresent")}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={se.searchBox}>
          <Ionicons name="search-outline" size={16} color="#9CA3AF" />
          <TextInput
            style={se.searchInput}
            placeholder={t("marksEntry.searchStudent")}
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
                    {t("marksEntry.abs")}
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
                    value={entry.isAbsent ? t("marksEntry.abs") : rawScore}
                    onChangeText={(v) => {
                      if (!entry.isAbsent) {
                        updateScore(item._id, "score", sanitizeScore(v));
                      }
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
                {search ? t("marksEntry.noStudentsMatch") : t("marksEntry.noStudentsInClass")}
              </Text>
              {!search && (
                <Text style={se.emptySub}>
                  {t("marksEntry.noStudentsHint")}
                </Text>
              )}
            </View>
          }
        />
      </View>

      {/* Only an administrator ever sees this: a teacher hitting a published
          result is refused with a different code and no reason would help. */}
      <Modal
        visible={Boolean(reasonPrompt)}
        transparent
        animationType="fade"
        onRequestClose={() => { setReasonPrompt(null); setReasonText(""); }}
      >
        <View style={se.reasonBackdrop}>
          <View style={se.reasonCard}>
            <Text style={se.reasonTitle}>
              {reasonPrompt === "locked"
                ? t("marksEntry.overrideLockTitle")
                : t("marksEntry.correctPublishedTitle")}
            </Text>
            <Text style={se.reasonBody}>
              {reasonPrompt === "locked"
                ? t("results.changeReasonRequired")
                : t("marksEntry.correctPublishedHint")}
            </Text>

            <TextInput
              style={se.reasonInput}
              value={reasonText}
              onChangeText={setReasonText}
              placeholder={t("marksEntry.changeReasonPlaceholder")}
              placeholderTextColor="#9CA3AF"
              multiline
              autoFocus
            />
            <Text style={se.reasonNote}>{t("marksEntry.changeReasonKept")}</Text>

            <View style={se.reasonRow}>
              <TouchableOpacity
                style={se.reasonCancel}
                onPress={() => { setReasonPrompt(null); setReasonText(""); }}
              >
                <Text style={se.reasonCancelText}>{t("common.cancel")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[se.reasonSave, (saving || reasonText.trim().length < 4) && se.reasonSaveOff]}
                disabled={saving || reasonText.trim().length < 4}
                onPress={() => saveWithReasonRef.current?.(reasonText.trim())}
              >
                <Text style={se.reasonSaveText}>
                  {saving ? t("common.saving") : t("marksEntry.saveWithReason")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
};

const se = StyleSheet.create({
  reasonBackdrop: {
    flex: 1, backgroundColor: "rgba(15, 18, 26, 0.55)",
    alignItems: "center", justifyContent: "center", padding: 20,
  },
  reasonCard: {
    width: "100%", maxWidth: 420, backgroundColor: "#FFFFFF",
    borderRadius: 16, padding: 20,
  },
  reasonTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  reasonBody:  { fontSize: 13, color: "#6B7280", marginTop: 6, lineHeight: 19 },
  reasonInput: {
    marginTop: 14, minHeight: 78, borderWidth: 2, borderColor: "#E5E7EB",
    borderRadius: 10, padding: 10, fontSize: 14, color: "#111827",
    textAlignVertical: "top",
  },
  reasonNote:  { fontSize: 11, color: "#9CA3AF", marginTop: 8 },
  reasonRow: {
    flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 18,
  },
  reasonCancel:     { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  reasonCancelText: { fontSize: 14, fontWeight: "600", color: "#6B7280" },
  reasonSave: {
    paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10,
    backgroundColor: "#4F46E5",
  },
  reasonSaveOff:  { opacity: 0.5 },
  reasonSaveText: { fontSize: 14, fontWeight: "700", color: "#FFFFFF" },

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
  const { t } = useTranslation();
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
      ? { _id: paramExamId, name: paramExamName || t("marksEntry.exam") }
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
          subjectName:   paramSubjectName   || t("marksEntry.subject"),
          examSubjectId: paramExamSubjectId || null,
          maxScore:      Number(paramMaxScore)  || 100,
          passMark:      Number(paramPassMark)  || 50,
        }
      : null
  );

  const saveRef = useRef(null);

  // Mirrored up from ScoreEntry so the header can disable Save mid-flight
  // and the back guard knows whether marks would be lost.
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryDirty,  setEntryDirty]  = useState(false);

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
    selectedSubject ? 2 :
    selectedExam    ? 1 :
                      0;

  const leaveStep = useCallback(() => {
    if (step === 2 && !paramSubjectId) setSelectedSubject(null);
    else if (step === 1 && !paramExamId) setSelectedExam(null);
    else router.back();
  }, [step, paramSubjectId, paramExamId, router]);

  const handleBack = useCallback(() => {
    // A whole class's marks live only in ScoreEntry's local state until
    // Save, so leaving step 2 unsaved would silently discard the lot.
    if (step === 2 && entrySaving) return;

    if (step === 2 && entryDirty) {
      Alert.alert(
        t("marksEntry.unsavedTitle"),
        t("marksEntry.unsavedBody"),
        [
          { text: t("marksEntry.keepEditing"), style: "cancel" },
          { text: t("marksEntry.saveNow"),     onPress: () => saveRef.current?.() },
          { text: t("common.discard"),      style: "destructive", onPress: leaveStep },
        ]
      );
      return;
    }

    leaveStep();
  }, [step, entrySaving, entryDirty, leaveStep, t]);

  // Route the Android hardware / gesture back through the same guard.
  useEffect(() => {
    const backSub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleBack();
      return true;
    });
    return () => backSub.remove();
  }, [handleBack]);

  // Leaving the mark sheet retires whatever status it last reported.
  useEffect(() => {
    if (step !== 2) {
      setEntrySaving(false);
      setEntryDirty(false);
    }
  }, [step]);

  const handleSaved = useCallback((action) => {
    if (action === "back" && !paramSubjectId) setSelectedSubject(null);
    else router.back();
  }, [paramSubjectId, router]);

  const headerTitle =
    step === 2 ? selectedSubject?.subjectName :
    step === 1 ? selectedExam?.name           :
                 t("marksEntry.title");

  const headerSub =
    step === 2
      ? `${selectedExam?.name || t("marksEntry.exam")} · ${
          selectedSubject?.className ||
          selectedClass?.className ||
          displayClass(selectedClass)
        }` :
    step === 1
      ? t("marksEntry.subChooseSubject")                                     :
      t("marksEntry.subSelectExam");

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

        {step === 2 && (
          <TouchableOpacity
            style={[ms.saveBtn, entrySaving && ms.saveBtnDisabled]}
            onPress={() => saveRef.current?.()}
            activeOpacity={0.8}
            disabled={entrySaving}
          >
            {entrySaving
              ? <ActivityIndicator size="small" color="#FFF" />
              : <Text style={ms.saveBtnText}>{t("common.save")}</Text>}
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
                setSelectedExam(null);
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={[ms.crumb, !paramExamId && ms.crumbLink]}>
              {t("marksEntry.exams")}
            </Text>
          </TouchableOpacity>

          <Ionicons name="chevron-forward" size={13} color="#D1D5DB" />

          <TouchableOpacity
            disabled={step <= 1 || !!paramSubjectId}
            onPress={() => {
              if (!paramSubjectId) setSelectedSubject(null);
            }}
            activeOpacity={0.7}
          >
            <Text style={[
              ms.crumb,
              step > 1 && !paramSubjectId && ms.crumbLink,
              step === 1 && ms.crumbActive,
            ]}
              numberOfLines={1}
            >
              {selectedExam?.name || t("marksEntry.exam")}
            </Text>
          </TouchableOpacity>

          {step === 2 && (
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
        <ClassSubjectPicker
          examId={selectedExam?._id}
          examName={selectedExam?.name}
          schoolId={schoolId}
          role={role}
          initialClassId={paramClassId || ""}
          onSelect={(sub) => {
            setSelectedClass({ classId: sub.classId, className: sub.className });
            setSelectedSubject({
              examSubjectId: sub.examSubjectId,
              subjectId:     sub.subjectId,
              subjectName:   sub.subjectName,
              classId:       sub.classId,
              className:     sub.className,
              maxScore:      sub.maxScore,
              passMark:      sub.passMark,
            });
          }}
        />
      )}

      {step === 2 && (
        <ScoreEntry
          examId={selectedExam?._id    || paramExamId}
          examSubjectId={selectedSubject.examSubjectId}
          subjectId={selectedSubject.subjectId}
          classId={selectedSubject.classId || selectedClass?.classId || paramClassId}
          schoolId={schoolId}
          role={role}
          maxScore={selectedSubject.maxScore ?? 100}
          passMark={selectedSubject.passMark ?? 50}
          subjectName={selectedSubject.subjectName}
          onSaved={handleSaved}
          saveRef={saveRef}
          onSavingChange={setEntrySaving}
          onDirtyChange={setEntryDirty}
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
    minWidth:          72,
    alignItems:        "center",
    justifyContent:    "center",
  },
  saveBtnDisabled: { opacity: 0.6 },
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