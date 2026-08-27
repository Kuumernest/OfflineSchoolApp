// app/teacher/exams/subjects.js
"use strict";

import React, {
  useState, useCallback, useEffect, useRef, useMemo,
} from "react";
import {
  View, Text, StyleSheet, FlatList, SectionList, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import AsyncStorage     from "@react-native-async-storage/async-storage";
import { useAuthStore } from "../../../src/store/auth.store";
import { useTranslation } from "../../../src/i18n/useTranslation";
import api              from "../../../src/services/api";
import { DB }           from "../../../src/db/dbService";
import { getDatabase }  from "../../../src/db/database";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

const STATUS_META = {
  pending:   { color: C.warning, bg: C.warningBg, labelKey: "teacherExamSubjects.statusPending",   icon: "time-outline"             },
  submitted: { color: C.primary, bg: C.primaryBg, labelKey: "teacherExamSubjects.statusSubmitted", icon: "cloud-upload-outline"     },
  approved:  { color: C.success, bg: C.successBg, labelKey: "teacherExamSubjects.statusApproved",  icon: "checkmark-circle-outline" },
  rejected:  { color: C.error,   bg: C.errorBg,   labelKey: "teacherExamSubjects.statusRejected",  icon: "close-circle-outline"     },
};

const SUBJECT_FILTERS = [
  { id: "all",       labelKey: "teacherExamSubjects.filterAll",        icon: "apps-outline"             },
  { id: "pending",   labelKey: "teacherExamSubjects.statusPending",    icon: "time-outline"             },
  { id: "rejected",  labelKey: "teacherExamSubjects.statusRejected",   icon: "close-circle-outline"     },
  { id: "submitted", labelKey: "teacherExamSubjects.statusSubmitted",  icon: "cloud-upload-outline"     },
  { id: "approved",  labelKey: "teacherExamSubjects.statusApproved",   icon: "checkmark-circle-outline" },
];

const CLASS_COLORS = [
  { bg: "#EEF2FF", color: "#4F46E5", icon: "school-outline"  },
  { bg: "#ECFDF5", color: "#059669", icon: "book-outline"    },
  { bg: "#FEF3C7", color: "#D97706", icon: "library-outline" },
  { bg: "#FEF2F2", color: "#DC2626", icon: "reader-outline"  },
  { bg: "#F0F9FF", color: "#0284C7", icon: "school-outline"  },
  { bg: "#FDF4FF", color: "#A855F7", icon: "book-outline"    },
  { bg: "#FFF7ED", color: "#EA580C", icon: "library-outline" },
  { bg: "#F0FDF4", color: "#16A34A", icon: "reader-outline"  },
];

const ROW_HEIGHT = 62;
const draftKey   = (examId, subjectId) => `exam_draft_${examId}_${subjectId}`;
const rateColor  = (pct) => pct >= 70 ? C.success : pct >= 50 ? C.warning : C.error;

// ─────────────────────────────────────────────────────────
// EXTRACT TEACHER ID — handles object or string
// ─────────────────────────────────────────────────────────

const extractTeacherId = (submission) => {
  if (typeof submission.teacherId === "string" && submission.teacherId) {
    return submission.teacherId;
  }
  if (submission.teacher && typeof submission.teacher === "object") {
    return String(submission.teacher._id || submission.teacher.id || "");
  }
  if (typeof submission.teacher === "string" && submission.teacher) {
    return submission.teacher;
  }
  if (submission.teacherId && typeof submission.teacherId === "object") {
    return String(submission.teacherId._id || submission.teacherId.id || "");
  }
  return "";
};

// ─────────────────────────────────────────────────────────
// CLASS NAME LOOKUP
// ─────────────────────────────────────────────────────────

const fetchClassNameMap = async (schoolId, classIds) => {
  const map = {};
  if (!classIds.length) return map;

  // Strategy 1: SQLite with deleted_at filter
  try {
    const placeholders = classIds.map(() => "?").join(", ");
    const rows = await DB.query(
      `SELECT id, name FROM classes
       WHERE id IN (${placeholders})
         AND (deleted_at IS NULL OR deleted_at = '')`,
      classIds
    );
    for (const r of rows) {
      if (r.id && r.name) map[String(r.id)] = r.name;
    }
    console.log(
      `[fetchClassNameMap] SQLite → ${Object.keys(map).length} / ${classIds.length} resolved`
    );
  } catch (err) {
    console.warn("[fetchClassNameMap] SQLite query failed:", err.message);
    try {
      const placeholders = classIds.map(() => "?").join(", ");
      const rows = await DB.query(
        `SELECT id, name FROM classes WHERE id IN (${placeholders})`,
        classIds
      );
      for (const r of rows) {
        if (r.id && r.name) map[String(r.id)] = r.name;
      }
    } catch (err2) {
      console.warn("[fetchClassNameMap] SQLite retry failed:", err2.message);
    }
  }

  // Strategy 2: API fallback for missing ones
  const missing = classIds.filter((id) => !map[id]);
  if (missing.length) {
    const teacherEndpoints = [
      "/teacher/classes",
      "/teacher/my-classes",
      "/classes",
    ];
    for (const url of teacherEndpoints) {
      if (!classIds.some((id) => !map[id])) break;
      try {
        const res = await api.get(url, { params: { schoolId, limit: 200 } });
        const list =
          res.data?.classes ||
          res.data?.data    ||
          (Array.isArray(res.data) ? res.data : []);
        for (const c of list) {
          const id = String(c._id || c.id || "");
          if (id) map[id] = c.name || c.className || c.title || id;
        }
      } catch {
        // ignore
      }
    }
  }

  // Strategy 3: broader SQLite scan
  const stillMissing = classIds.filter((id) => !map[id]);
  if (stillMissing.length) {
    try {
      const placeholders = stillMissing.map(() => "?").join(", ");
      const rows = await DB.query(
        `SELECT id, name FROM classes WHERE id IN (${placeholders})`,
        stillMissing
      );
      for (const r of rows) {
        if (r.id && r.name) map[String(r.id)] = r.name;
      }
    } catch {
      // ignore
    }
  }

  console.log("[fetchClassNameMap] final map:", map);
  return map;
};

// ─────────────────────────────────────────────────────────
// STUDENT FETCHER
// Strategy 0: SQLite local DB first (offline-capable, fastest)
// Strategy 1+: API fallback attempts
// ─────────────────────────────────────────────────────────

const fetchStudentsForClass = async (schoolId, classId, role) => {
  if (!classId) {
    console.warn("[fetchStudents] classId is missing");
    return [];
  }

  console.log(
    `[fetchStudents] classId=${classId} schoolId=${schoolId} role=${role}`
  );

  // ── Strategy 0: SQLite local DB ──────────────────────────────────
  try {
    const db       = await getDatabase();
    const colRows  = await db.getAllAsync(
      "PRAGMA table_info(students)"
    ).catch(() => []);
    const colNames = colRows.map((c) => c.name);

    const classCol =
      colNames.includes("classId")  ? "classId"  :
      colNames.includes("class_id") ? "class_id" :
      colNames.includes("class")    ? "class"     :
      null;

    if (classCol) {
      const nameCol =
        colNames.includes("studentName") ? "studentName" :
        colNames.includes("name")        ? "name"        :
        colNames.includes("fullName")    ? "fullName"    :
        null;

      const total = await db.getFirstAsync(
        "SELECT COUNT(*) AS cnt FROM students"
      ).catch(() => null);
      console.log(`[fetchStudents] SQLite total students: ${total?.cnt}`);

      const localStudents = await db.getAllAsync(
        `SELECT * FROM students
         WHERE ${classCol} = ?
           AND (is_active = 1 OR is_active IS NULL)
         ORDER BY ${nameCol || "rowid"} ASC`,
        [classId]
      ).catch(() => []);

      console.log(
        `[fetchStudents] SQLite (${classCol}="${classId}") → ${localStudents.length} students`
      );

      if (localStudents.length > 0) {
        return localStudents.map((s) => ({
          _id:         String(s._id || s.id || ""),
          studentName: s.studentName || s.name || s.fullName || "",
          admissionNo: s.admissionNo || s.admissionNumber || s.regNo || null,
          email:       s.email || null,
        }));
      }
    } else {
      console.warn(
        "[fetchStudents] SQLite students table has no class column.",
        "Columns:", colNames
      );
    }
  } catch (err) {
    console.warn("[fetchStudents] SQLite failed:", err.message);
  }

  // ── Strategy 1+: API attempts ─────────────────────────────────────
  const attempts = [
    { url: "/teacher/students/roster",    params: { schoolId, classId } },
    { url: "/teacher/my-students",        params: { schoolId, classId } },
    { url: "/teacher/my-students",        params: { schoolId, classId, role: "student" } },
    { url: "/teacher/class-students",     params: { schoolId, classId } },
    { url: "/students",                   params: { schoolId, classId } },
    { url: "/admin/students",             params: { schoolId, classId } },
    { url: "/attendance/students/roster", params: { schoolId, classId } },
    { url: "/attendance/students/roster", params: { schoolId, classId, type: "student" } },
  ];

  for (const { url, params } of attempts) {
    try {
      const res = await api.get(url, { params });
      const raw =
        res.data?.students ||
        res.data?.roster   ||
        res.data?.data     ||
        (Array.isArray(res.data) ? res.data : []);

      const students = raw.filter((s) => {
        const r = (s.role || s.userType || "").toLowerCase();
        return !r || r === "student" || r === "pupil";
      });

      console.log(
        `[fetchStudents] ${url} → raw=${raw.length} filtered=${students.length}`
      );

      if (students.length > 0) {
        return students.map((s) => ({
          _id:         String(s._id || s.id),
          studentName: s.studentName || s.name || s.fullName || "",
          admissionNo: s.admissionNo || s.admissionNumber || s.regNo || null,
          email:       s.email || null,
        }));
      }
    } catch (err) {
      if (err?.response?.status && err.response.status >= 500) break;
      console.log(
        `[fetchStudents] ${url} → ${err?.response?.status ?? err.message}`
      );
    }
  }

  console.warn("[fetchStudents] all attempts exhausted — returning []");
  return [];
};

// ─────────────────────────────────────────────────────────
// useStableLoader
// ─────────────────────────────────────────────────────────

function useStableLoader(asyncFn, deps) {
  const { t } = useTranslation();
  const [state, setState] = useState({
    data:       [],
    loading:    true,
    error:      null,
    refreshing: false,
  });

  const fnRef     = useRef(asyncFn);
  const activeRef = useRef(false);

  useEffect(() => { fnRef.current = asyncFn; }, [asyncFn]);

  const run = useCallback((isRefresh = false) => {
    if (activeRef.current && !isRefresh) return () => {};

    let cancelled = false;
    activeRef.current = true;

    setState((prev) => ({
      ...prev,
      loading:    !isRefresh,
      refreshing: isRefresh,
      error:      null,
    }));

    fnRef.current()
      .then((data) => {
        if (!cancelled) {
          setState({
            data:       data ?? [],
            loading:    false,
            refreshing: false,
            error:      null,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            data:       [],
            loading:    false,
            refreshing: false,
            error:      errorText(t, err, "teacherExamSubjects.genericError"),
          });
        }
      })
      .finally(() => { activeRef.current = false; });

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cancel = run(false);
    return cancel;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => run(true), [run]);
  return { ...state, refresh };
}

// ─────────────────────────────────────────────────────────
// SCORE ENTRY
// ─────────────────────────────────────────────────────────

function ScoreEntry({
  examId, examSubjectId, subjectId,
  classId, schoolId, role,
  maxScore, passMark,
  subjectName, onSaved,
  saveRef, saving, setSaving, dirtyRef,
}) {
  const { t } = useTranslation();

  const [scores,       setScores]       = useState({});
  const [isDirty,      setIsDirty]      = useState(false);
  const [search,       setSearch]       = useState("");
  const [draftHandled, setDraftHandled] = useState(false);

  const inputRefs = useRef({});

  useEffect(() => {
    if (dirtyRef) dirtyRef.current = isDirty;
  }, [isDirty, dirtyRef]);

  const loadStudents = useCallback(
    () => fetchStudentsForClass(schoolId, classId, role),
    [schoolId, classId, role]
  );

  const {
    data:       students,
    loading:    studentsLoading,
    refreshing: studentsRefreshing,
    error:      studentsError,
    refresh:    refreshStudents,
  } = useStableLoader(loadStudents, [schoolId, classId, role]);

  const safeStudents = Array.isArray(students) ? students : [];

  const loadScores = useCallback(async () => {
    if (!examId) return {};
    const res = await api
      .get(`/exams/${examId}/scores`, {
        params: { subjectId, classId, schoolId },
      })
      .catch(() => ({ data: { scores: [] } }));

    const existing = res?.data?.scores || [];
    const map = {};
    for (const s of existing) {
      map[String(s.studentId)] = {
        score:    s.score ?? "",
        isAbsent: s.isAbsent ?? false,
      };
    }
    return map;
  }, [examId, subjectId, classId, schoolId]);

  const {
    data:    serverScores,
    loading: scoresLoading,
  } = useStableLoader(loadScores, [examId, subjectId, classId, schoolId]);

  useEffect(() => {
    if (scoresLoading || draftHandled || serverScores == null) return;

    const applyScores = async () => {
      setDraftHandled(true);
      try {
        const rawDraft = await AsyncStorage.getItem(
          draftKey(examId, subjectId)
        );
        if (rawDraft) {
          const draft = JSON.parse(rawDraft);
          if (draft && typeof draft === "object" && Object.keys(draft).length) {
            Alert.alert(
              t("teacherExamSubjects.draftFoundTitle"),
              t("teacherExamSubjects.draftFoundBody"),
              [
                {
                  text:  t("teacherExamSubjects.discard"),
                  style: "destructive",
                  onPress: async () => {
                    await AsyncStorage.removeItem(
                      draftKey(examId, subjectId)
                    ).catch(() => {});
                    setScores(serverScores ?? {});
                  },
                },
                {
                  text: t("teacherExamSubjects.restore"),
                  onPress: () => {
                    setScores({ ...(serverScores ?? {}), ...draft });
                    setIsDirty(true);
                  },
                },
              ]
            );
            return;
          }
        }
      } catch (_) {}
      setScores(serverScores ?? {});
    };

    applyScores();
  }, [scoresLoading, serverScores, draftHandled, examId, subjectId, t]);

  const updateScore = useCallback((sid, value) => {
    setIsDirty(true);
    setScores((p) => ({ ...p, [sid]: { ...p[sid], score: value } }));
  }, []);

  const toggleAbsent = useCallback((sid) => {
    setIsDirty(true);
    setScores((p) => {
      const was = p[sid]?.isAbsent ?? false;
      return {
        ...p,
        [sid]: {
          ...p[sid],
          isAbsent: !was,
          score:    !was ? "" : p[sid]?.score ?? "",
        },
      };
    });
  }, []);

  const markAllPresent = useCallback(() => {
    setIsDirty(true);
    setScores((p) => {
      const updated = {};
      for (const s of safeStudents) {
        updated[s._id] = { ...(p[s._id] || {}), isAbsent: false };
      }
      return { ...p, ...updated };
    });
  }, [safeStudents]);

  useEffect(() => {
    if (!isDirty || !examId || !subjectId) return;
    const timer = setTimeout(() => {
      AsyncStorage.setItem(
        draftKey(examId, subjectId),
        JSON.stringify(scores)
      ).catch(() => {});
    }, 30_000);
    return () => clearTimeout(timer);
  }, [scores, isDirty, examId, subjectId]);

  const handleSave = useCallback(async () => {
    if (!safeStudents.length) {
      Alert.alert(
        t("teacherExamSubjects.noStudentsAlertTitle"),
        t("teacherExamSubjects.noStudentsAlertBody")
      );
      return;
    }
    if (!examId) {
      Alert.alert(
        t("teacherExamSubjects.errorTitle"),
        t("teacherExamSubjects.examIdMissing")
      );
      return;
    }

    const records = safeStudents.map((s) => {
      const entry = scores[s._id] || {};
      const raw   = String(entry.score ?? "").trim();
      return {
        studentId: s._id,
        score:     raw === "" ? null : Number(raw),
        maxScore,
        isAbsent:  entry.isAbsent ?? false,
      };
    });

    const invalid = records.filter(
      (r) =>
        !r.isAbsent &&
        r.score !== null &&
        (r.score < 0 || r.score > maxScore)
    );
    if (invalid.length) {
      Alert.alert(
        t("teacherExamSubjects.invalidScoresTitle"),
        t("teacherExamSubjects.invalidScoresBody", {
          count: invalid.length,
          max:   maxScore,
        })
      );
      return;
    }

    const unentered = records.filter(
      (r) => !r.isAbsent && r.score === null
    );

    const doSave = async () => {
      try {
        setSaving(true);
        await api.post(`/exams/${examId}/scores/bulk`, {
          classId, subjectId, examSubjectId,
          scores: records, schoolId,
        });
        await AsyncStorage.removeItem(
          draftKey(examId, subjectId)
        ).catch(() => {});
        setIsDirty(false);
        Alert.alert(
          t("teacherExamSubjects.savedTitle"),
          t("teacherExamSubjects.savedBody", { count: records.length }),
          [
            {
              text:    t("teacherExamSubjects.enterAnotherSubject"),
              onPress: () => onSaved("back"),
            },
            {
              text:    t("teacherExamSubjects.done"),
              style:   "cancel",
              onPress: () => onSaved("exit"),
            },
          ]
        );
      } catch (err) {
        Alert.alert(
          t("teacherExamSubjects.saveFailedTitle"),
          errorText(t, err, "teacherExamSubjects.tryAgain")
        );
      } finally {
        setSaving(false);
      }
    };

    if (unentered.length) {
      Alert.alert(
        t("teacherExamSubjects.unenteredTitle"),
        t("teacherExamSubjects.unenteredBody", { count: unentered.length }),
        [
          {
            text:  t("teacherExamSubjects.cancel"),
            style: "cancel",
          },
          {
            text:    t("teacherExamSubjects.saveAnyway"),
            onPress: doSave,
          },
        ]
      );
    } else {
      await doSave();
    }
  }, [
    safeStudents, scores, maxScore,
    examId, classId, subjectId, examSubjectId,
    schoolId, onSaved, setSaving, t,
  ]);

  useEffect(() => {
    if (saveRef) saveRef.current = handleSave;
  }, [handleSave, saveRef]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return safeStudents;
    return safeStudents.filter(
      (s) =>
        s.studentName?.toLowerCase().includes(q) ||
        s.admissionNo?.toLowerCase().includes(q)
    );
  }, [safeStudents, search]);

  const focusNext = useCallback((currentId) => {
    const idx = filtered.findIndex((s) => s._id === currentId);
    for (let i = idx + 1; i < filtered.length; i++) {
      const next = filtered[i];
      if (!(scores[next._id]?.isAbsent) && inputRefs.current[next._id]) {
        inputRefs.current[next._id].focus();
        return;
      }
    }
  }, [filtered, scores]);

  const enteredCount = useMemo(
    () =>
      Object.values(scores).filter(
        (s) =>
          s.isAbsent ||
          (s.score !== "" && s.score !== null && s.score !== undefined)
      ).length,
    [scores]
  );

  const pct =
    safeStudents.length > 0
      ? Math.round((enteredCount / safeStudents.length) * 100)
      : 0;

  const isLoading = studentsLoading || scoresLoading;

  if (isLoading) {
    return (
      <View style={se.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={se.hint}>
          {t("teacherExamSubjects.loadingStudents")}
        </Text>
      </View>
    );
  }

  if (studentsError) {
    return (
      <View style={se.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={C.error} />
        <Text style={[se.hint, { color: C.error }]}>{studentsError}</Text>
        <TouchableOpacity style={se.retryBtn} onPress={refreshStudents}>
          <Text style={se.retryText}>
            {t("teacherExamSubjects.retry")}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!safeStudents.length) {
    return (
      <View style={se.centered}>
        <Ionicons name="people-outline" size={48} color={C.gray200} />
        <Text style={[se.hint, { fontWeight: "700", color: C.gray700 }]}>
          {t("teacherExamSubjects.noStudentsTitle")}
        </Text>
        <Text style={[se.hint, { textAlign: "center" }]}>
          {t("teacherExamSubjects.noStudentsBody", { classId })}
        </Text>
        <TouchableOpacity style={se.retryBtn} onPress={refreshStudents}>
          <Text style={se.retryText}>
            {t("teacherExamSubjects.retry")}
          </Text>
        </TouchableOpacity>
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
          <View style={se.progressTop}>
            <Text style={se.progressText}>
              {t("teacherExamSubjects.enteredCount", {
                entered: enteredCount,
                total:   safeStudents.length,
              })}
            </Text>
            <View style={se.progressRight}>
              {isDirty && (
                <View style={se.dirtyDot}>
                  <Text style={se.dirtyText}>
                    {t("teacherExamSubjects.unsavedBadge")}
                  </Text>
                </View>
              )}
              <Text style={se.progressPct}>{pct}%</Text>
            </View>
          </View>
          <View style={se.barBg}>
            <View style={[se.barFill, { width: `${pct}%` }]} />
          </View>
          <View style={se.progressBottom}>
            <Text style={se.subLabel}>
              {t("teacherExamSubjects.scoreMeta", {
                subject: subjectName,
                max:     maxScore,
                pass:    passMark,
              })}
            </Text>
            <TouchableOpacity onPress={markAllPresent}>
              <Text style={se.markAll}>
                {t("teacherExamSubjects.markAllPresent")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={se.searchWrap}>
          <Ionicons name="search-outline" size={16} color={C.gray400} />
          <TextInput
            style={se.searchInput}
            placeholder={t("teacherExamSubjects.searchPlaceholder")}
            placeholderTextColor={C.gray400}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color={C.gray400} />
            </TouchableOpacity>
          )}
        </View>

        {/* Student list */}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item._id}
          contentContainerStyle={se.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          initialNumToRender={15}
          getItemLayout={(_, index) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * index,
            index,
          })}
          refreshControl={
            <RefreshControl
              refreshing={studentsRefreshing}
              onRefresh={refreshStudents}
              tintColor={C.primary}
              colors={[C.primary]}
            />
          }
          ListEmptyComponent={
            <View style={se.empty}>
              <Ionicons name="people-outline" size={48} color={C.gray200} />
              <Text style={se.emptyText}>
                {search
                  ? t("teacherExamSubjects.emptySearch")
                  : t("teacherExamSubjects.emptyStudents")}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const entry    = scores[item._id] || {};
            const raw      = String(entry.score ?? "");
            const numScore = raw !== "" ? Number(raw) : null;
            const scorePct =
              numScore !== null
                ? Math.round((numScore / maxScore) * 100)
                : null;
            const color =
              scorePct !== null ? rateColor(scorePct) : C.gray400;

            return (
              <View style={[se.row, entry.isAbsent && se.rowAbsent]}>
                <View
                  style={[se.avatar, { backgroundColor: color + "20" }]}
                >
                  <Text style={[se.avatarLetter, { color }]}>
                    {(item.studentName || "?").charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={se.info}>
                  <Text style={se.name} numberOfLines={1}>
                    {item.studentName ||
                      t("teacherExamSubjects.unknownStudent")}
                  </Text>
                  <Text style={se.sub}>
                    {item.admissionNo
                      ? `#${item.admissionNo}`
                      : item.email || ""}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[se.absBtn, entry.isAbsent && se.absBtnActive]}
                  onPress={() => toggleAbsent(item._id)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      se.absBtnText,
                      entry.isAbsent && se.absBtnTextActive,
                    ]}
                  >
                    {t("teacherExamSubjects.absShort")}
                  </Text>
                </TouchableOpacity>
                <View style={se.scoreWrap}>
                  <TextInput
                    ref={(el) => { inputRefs.current[item._id] = el; }}
                    style={[
                      se.scoreInput,
                      entry.isAbsent && se.scoreInputAbsent,
                      numScore !== null && !entry.isAbsent && {
                        borderColor: color,
                        borderWidth: 1.5,
                      },
                    ]}
                    value={
                      entry.isAbsent
                        ? t("teacherExamSubjects.absShort")
                        : raw
                    }
                    onChangeText={(v) => {
                      if (!entry.isAbsent) updateScore(item._id, v);
                    }}
                    keyboardType="numeric"
                    editable={!entry.isAbsent}
                    placeholder="—"
                    placeholderTextColor={C.gray200}
                    selectTextOnFocus
                    maxLength={5}
                    returnKeyType="next"
                    onSubmitEditing={() => focusNext(item._id)}
                    blurOnSubmit={false}
                  />
                  {scorePct !== null && !entry.isAbsent && (
                    <Text style={[se.scorePct, { color }]}>
                      {scorePct}%
                    </Text>
                  )}
                </View>
              </View>
            );
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// SCORE ENTRY STYLES
// ─────────────────────────────────────────────────────────

const se = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1, alignItems: "center", justifyContent: "center",
    gap: 12, padding: 32,
  },
  hint:     { fontSize: 14, color: C.gray500, textAlign: "center" },
  retryBtn: {
    marginTop: 8, backgroundColor: C.primary, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 24,
  },
  retryText: { color: C.white, fontWeight: "700", fontSize: 14 },
  progress: {
    backgroundColor: C.white, paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  progressTop: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 6,
  },
  progressText:  { fontSize: 13, fontWeight: "600", color: C.gray700 },
  progressRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  progressPct:   { fontSize: 13, fontWeight: "700", color: C.primary },
  dirtyDot: {
    backgroundColor: C.error, borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  dirtyText: {
    fontSize: 9, fontWeight: "800", color: C.white, letterSpacing: 0.5,
  },
  barBg: {
    height: 5, backgroundColor: C.gray100, borderRadius: 3,
    overflow: "hidden", marginBottom: 8,
  },
  barFill:        { height: 5, backgroundColor: C.primary, borderRadius: 3 },
  progressBottom: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center",
  },
  subLabel: { fontSize: 11, color: C.gray500 },
  markAll:  { fontSize: 11, color: C.primary, fontWeight: "700" },
  searchWrap: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.gray50,
    borderRadius: 10, paddingHorizontal: 12, height: 40,
    borderWidth: 1, borderColor: C.gray200, gap: 8, margin: 12, marginBottom: 4,
  },
  searchInput:  { flex: 1, fontSize: 14, color: C.gray900 },
  list:         { padding: 12, paddingTop: 8, gap: 6, paddingBottom: 40 },
  empty:        { alignItems: "center", paddingVertical: 60, gap: 8 },
  emptyText:    { fontSize: 14, color: C.gray400, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.white,
    borderRadius: 12, padding: 10, borderWidth: 1, borderColor: C.gray100,
    gap: 8, height: ROW_HEIGHT - 6,
  },
  rowAbsent:        { backgroundColor: C.errorBg, borderColor: "#FECACA" },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
  },
  avatarLetter:     { fontSize: 14, fontWeight: "800" },
  info:             { flex: 1 },
  name:             { fontSize: 13, fontWeight: "700", color: C.gray900 },
  sub:              { fontSize: 11, color: C.gray400 },
  absBtn: {
    paddingHorizontal: 8, paddingVertical: 5,
    borderRadius: 8, borderWidth: 1.5, borderColor: C.gray200,
  },
  absBtnActive:     { backgroundColor: C.error, borderColor: C.error },
  absBtnText:       { fontSize: 10, fontWeight: "700", color: C.gray400 },
  absBtnTextActive: { color: C.white },
  scoreWrap:        { alignItems: "center", minWidth: 64 },
  scoreInput: {
    backgroundColor: C.gray50, borderRadius: 8, borderWidth: 1,
    borderColor: C.gray200, paddingHorizontal: 8, paddingVertical: 6,
    fontSize: 15, fontWeight: "700", color: C.gray900,
    textAlign: "center", width: 60,
  },
  scoreInputAbsent: {
    backgroundColor: C.gray100, color: C.gray400, borderColor: C.gray200,
  },
  scorePct: { fontSize: 10, fontWeight: "600", marginTop: 2 },
});

// ─────────────────────────────────────────────────────────
// SUBJECT LIST — grouped by class
// ─────────────────────────────────────────────────────────

function SubjectListView({ examId, schoolId, teacherId, onSelect }) {
  const { t } = useTranslation();
  const [subjectFilter, setSubjectFilter] = useState("all");

  const loadSubjects = useCallback(async () => {
    if (!examId) return [];

    const res = await api.get(`/exams/${examId}/submissions`, {
      params: { schoolId },
    });
    const all = res.data?.submissions || [];

    console.log(`[SubjectListView] ${all.length} total submissions`);

    // ── Step 1: filter to this teacher ────────────────────
    const mine = all.filter((s) => extractTeacherId(s) === teacherId);

    console.log(
      `[SubjectListView] ${all.length} total → ${mine.length} mine`,
      `(teacherId: ${teacherId})`
    );

    if (mine.length === 0 && all.length > 0) {
      console.warn(
        "[SubjectListView] No matches! Sample teacher IDs from server:",
        all.slice(0, 5).map((s) => ({
          raw_teacherId: s.teacherId,
          raw_teacher:   s.teacher,
          extracted:     extractTeacherId(s),
        }))
      );
      return [];
    }

    if (!mine.length) return [];

    // ── Step 2: cross-check against teacher's assigned subjects ──
    let assignedSubjectIds = null;
    try {
      const db   = await getDatabase();
      const rows = await db.getAllAsync(
        `SELECT DISTINCT subjectId
         FROM teacher_assignments
         WHERE teacherId = ?
           AND (deleted_at IS NULL OR deleted_at = '')
           AND (id NOT LIKE 'server_%'
                AND id NOT LIKE 'local_%'
                AND id NOT LIKE 'legacy_%')`,
        [teacherId]
      ).catch(() => []);

      assignedSubjectIds = new Set(
        rows.map((r) => String(r.subjectId)).filter(Boolean)
      );
      console.log(
        `[SubjectListView] teacher has ${assignedSubjectIds.size}` +
        ` assigned subjects in SQLite`
      );
    } catch (err) {
      console.warn(
        "[SubjectListView] could not load assigned subjects:", err.message
      );
    }

    const verified = assignedSubjectIds
      ? mine.filter((s) => {
          const sId        = String(s.subjectId || "");
          const isAssigned = assignedSubjectIds.has(sId);
          if (!isAssigned) {
            console.warn(
              `[SubjectListView] skipping unassigned subject:` +
              ` ${sId} (${s.subjectName})`
            );
          }
          return isAssigned;
        })
      : mine;

    console.log(
      `[SubjectListView] after assignment check: ${verified.length} valid` +
      ` (removed ${mine.length - verified.length} unassigned)`
    );

    if (!verified.length) return [];

    // ── Step 3: deduplicate by subjectId + classId ─────────
    const seen    = new Set();
    const deduped = [];

    for (const s of verified) {
      const key = `${String(s.subjectId || "")}::${String(s.classId || "")}`;
      if (seen.has(key)) {
        console.warn(
          `[SubjectListView] duplicate skipped —` +
          ` subjectId: ${s.subjectId}, classId: ${s.classId}`
        );
        continue;
      }
      seen.add(key);
      deduped.push(s);
    }

    console.log(
      `[SubjectListView] after dedup: ${deduped.length} unique subject+class` +
      ` (removed ${verified.length - deduped.length} duplicates)`
    );

    if (!deduped.length) return [];

    // ── Step 4: resolve class names ────────────────────────
    const uniqueClassIds = [
      ...new Set(deduped.map((s) => s.classId).filter(Boolean)),
    ];

    const classNameMap = await fetchClassNameMap(schoolId, uniqueClassIds);

    return deduped.map((s) => ({
      ...s,
      className:
        classNameMap[s.classId] ||
        (s.classId
          ? t("teacherExamSubjects.classShort", {
              suffix: String(s.classId).slice(-6),
            })
          : t("teacherExamSubjects.unknownClass")),
    }));
  }, [examId, schoolId, teacherId, t]);

  const {
    data:       subjects,
    loading,
    refreshing,
    error,
    refresh,
  } = useStableLoader(loadSubjects, [examId, schoolId, teacherId]);

  const safeSubjects = Array.isArray(subjects) ? subjects : [];

  const filteredSubjects = useMemo(() => {
    if (!safeSubjects.length) return [];
    if (subjectFilter === "all") return safeSubjects;
    return safeSubjects.filter(
      (s) => (s.submissionStatus || "pending") === subjectFilter
    );
  }, [safeSubjects, subjectFilter]);

  const sections = useMemo(() => {
    const classMap = {};
    for (const sub of filteredSubjects) {
      const key = sub.className || t("teacherExamSubjects.unknownClass");
      if (!classMap[key]) classMap[key] = { title: key, data: [] };
      classMap[key].data.push(sub);
    }
    return Object.values(classMap).sort((a, b) =>
      a.title.localeCompare(b.title)
    );
  }, [filteredSubjects, t]);

  const filterCounts = useMemo(() => ({
    all:       safeSubjects.length,
    pending:   safeSubjects.filter(
      (s) => (s.submissionStatus || "pending") === "pending"
    ).length,
    rejected:  safeSubjects.filter(
      (s) => s.submissionStatus === "rejected"
    ).length,
    submitted: safeSubjects.filter(
      (s) => s.submissionStatus === "submitted"
    ).length,
    approved:  safeSubjects.filter(
      (s) => s.submissionStatus === "approved"
    ).length,
  }), [safeSubjects]);

  if (loading) {
    return (
      <View style={sv.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={sv.loadingText}>
          {t("teacherExamSubjects.loadingSubjects")}
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={sv.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={C.error} />
        <Text style={sv.errorText}>{error}</Text>
        <TouchableOpacity style={sv.retryBtn} onPress={refresh}>
          <Text style={sv.retryText}>
            {t("teacherExamSubjects.retry")}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!safeSubjects.length) {
    return (
      <View style={sv.centered}>
        <Ionicons name="book-outline" size={48} color={C.gray200} />
        <Text style={sv.emptyTitle}>
          {t("teacherExamSubjects.noSubjectsTitle")}
        </Text>
        <Text style={sv.emptyText}>
          {t("teacherExamSubjects.noSubjectsBody")}
        </Text>
        <TouchableOpacity style={sv.retryBtn} onPress={refresh}>
          <Text style={sv.retryText}>
            {t("teacherExamSubjects.refresh")}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>

      {/* Filter chips */}
      <View style={sv.filterBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={sv.filterScrollContent}
        >
          {SUBJECT_FILTERS.map((f) => {
            const isActive = subjectFilter === f.id;
            const count    = filterCounts[f.id] ?? 0;
            return (
              <TouchableOpacity
                key={f.id}
                style={[sv.filterChip, isActive && sv.filterChipActive]}
                onPress={() => setSubjectFilter(f.id)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={f.icon}
                  size={13}
                  color={isActive ? C.white : C.gray500}
                />
                <Text
                  style={[
                    sv.filterChipText,
                    isActive && sv.filterChipTextActive,
                  ]}
                >
                  {t(f.labelKey)}
                </Text>
                {count > 0 && (
                  <View
                    style={[
                      sv.filterChipBadge,
                      isActive && sv.filterChipBadgeActive,
                    ]}
                  >
                    <Text
                      style={[
                        sv.filterChipBadgeText,
                        isActive && sv.filterChipBadgeTextActive,
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
      </View>

      {sections.length === 0 ? (
        <View style={sv.filterEmpty}>
          <Ionicons name="funnel-outline" size={40} color={C.gray200} />
          <Text style={sv.filterEmptyText}>
            {t("teacherExamSubjects.noFilterMatch")}
          </Text>
          <TouchableOpacity
            style={sv.filterEmptyBtn}
            onPress={() => setSubjectFilter("all")}
          >
            <Text style={sv.filterEmptyBtnText}>
              {t("teacherExamSubjects.showAll")}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item._id || item.id)}
          contentContainerStyle={sv.list}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={C.primary}
              colors={[C.primary]}
            />
          }

          renderSectionHeader={({ section }) => {
            const idx =
              sections.findIndex((s) => s.title === section.title) %
              CLASS_COLORS.length;
            const cls = CLASS_COLORS[Math.max(0, idx)];
            return (
              <View style={sv.sectionHeader}>
                <View
                  style={[sv.sectionIconBg, { backgroundColor: cls.bg }]}
                >
                  <Ionicons name={cls.icon} size={16} color={cls.color} />
                </View>
                <View style={sv.sectionHeaderText}>
                  <Text style={sv.sectionTitle}>{section.title}</Text>
                  <Text style={sv.sectionMeta}>
                    {t("teacherExamSubjects.subjectCount", {
                      count: section.data.length,
                    })}
                  </Text>
                </View>
                <View
                  style={[sv.sectionBadge, { backgroundColor: cls.bg }]}
                >
                  <Text
                    style={[sv.sectionBadgeText, { color: cls.color }]}
                  >
                    {section.data.length}
                  </Text>
                </View>
              </View>
            );
          }}

          renderItem={({ item: sub, index, section }) => {
            const isLast     = index === section.data.length - 1;
            const status     = sub.submissionStatus || "pending";
            const meta       = STATUS_META[status] || STATUS_META.pending;
            const isRejected = status === "rejected";
            const isApproved = status === "approved";
            const sIdx =
              sections.findIndex((s) => s.title === section.title) %
              CLASS_COLORS.length;
            const cls = CLASS_COLORS[Math.max(0, sIdx)];

            return (
              <TouchableOpacity
                style={[
                  sv.card,
                  isRejected && sv.cardRejected,
                  isApproved && sv.cardApproved,
                  isLast     && sv.cardLast,
                ]}
                onPress={() => onSelect(sub)}
                activeOpacity={0.7}
                disabled={isApproved}
              >
                <View
                  style={[sv.cardAccent, { backgroundColor: cls.color }]}
                />
                <View
                  style={[
                    sv.iconWrap,
                    { backgroundColor: isRejected ? C.errorBg : cls.bg },
                  ]}
                >
                  <Ionicons
                    name="book"
                    size={20}
                    color={isRejected ? C.error : cls.color}
                  />
                </View>
                <View style={sv.cardInfo}>
                  <Text style={sv.cardName}>
                    {sub.subjectName ||
                      t("teacherExamSubjects.unknownSubject")}
                  </Text>
                  <Text style={sv.cardSub}>
                    {[
                      t("teacherExamSubjects.maxLabel", { max: sub.maxScore }),
                      t("teacherExamSubjects.passLabel", { pass: sub.passMark }),
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  </Text>
                  <Text style={sv.scoresText}>
                    {t("teacherExamSubjects.scoresEntered", {
                      count: sub.totalScoresEntered ?? 0,
                    })}
                  </Text>
                  {isRejected && sub.rejectionReason && (
                    <View style={sv.rejectionBox}>
                      <Ionicons
                        name="alert-circle"
                        size={12}
                        color={C.error}
                      />
                      <Text style={sv.rejectionText} numberOfLines={2}>
                        {sub.rejectionReason}
                      </Text>
                    </View>
                  )}
                  {isApproved && (
                    <Text style={sv.approvedText}>
                      {t("teacherExamSubjects.approvedLocked")}
                    </Text>
                  )}
                </View>
                <View style={sv.cardRight}>
                  <View
                    style={[sv.statusBadge, { backgroundColor: meta.bg }]}
                  >
                    <Text style={[sv.statusText, { color: meta.color }]}>
                      {t(meta.labelKey)}
                    </Text>
                  </View>
                  {!isApproved && (
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={C.gray400}
                      style={{ marginTop: 4 }}
                    />
                  )}
                </View>
              </TouchableOpacity>
            );
          }}

          renderSectionFooter={() => <View style={{ height: 16 }} />}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// SUBJECT LIST STYLES
// ─────────────────────────────────────────────────────────

const sv = StyleSheet.create({
  centered: {
    flex: 1, alignItems: "center", justifyContent: "center",
    gap: 12, padding: 32,
  },
  loadingText: { fontSize: 14, color: C.gray500 },
  errorText:   { fontSize: 14, color: C.error, textAlign: "center" },
  emptyTitle:  { fontSize: 16, fontWeight: "700", color: C.gray700 },
  emptyText: {
    fontSize: 13, color: C.gray500, textAlign: "center", lineHeight: 20,
  },
  retryBtn: {
    backgroundColor: C.primary, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 24,
  },
  retryText: { color: C.white, fontWeight: "700", fontSize: 14 },

  filterBar: {
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  filterScrollContent: {
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
  },
  filterChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    backgroundColor: C.gray100, borderWidth: 1, borderColor: C.gray200,
  },
  filterChipActive:          { backgroundColor: C.primary, borderColor: C.primary },
  filterChipText:            { fontSize: 12, fontWeight: "600", color: C.gray700 },
  filterChipTextActive:      { color: C.white },
  filterChipBadge: {
    backgroundColor: C.white, borderRadius: 10,
    minWidth: 20, paddingHorizontal: 6, paddingVertical: 1,
    alignItems: "center",
  },
  filterChipBadgeActive:     { backgroundColor: "rgba(255,255,255,0.25)" },
  filterChipBadgeText:       { fontSize: 10, fontWeight: "700", color: C.gray700 },
  filterChipBadgeTextActive: { color: C.white },

  filterEmpty: {
    flex: 1, alignItems: "center", justifyContent: "center",
    gap: 12, padding: 40,
  },
  filterEmptyText: { fontSize: 13, color: C.gray500, fontWeight: "500" },
  filterEmptyBtn: {
    backgroundColor: C.primary, borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 20,
  },
  filterEmptyBtnText: { color: C.white, fontSize: 12, fontWeight: "700" },

  list: { padding: 16, paddingBottom: 40 },

  sectionHeader: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: C.white, borderRadius: 14,
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
    padding: 14, borderWidth: 1, borderBottomWidth: 0,
    borderColor: C.gray200, shadowColor: "#000",
    shadowOpacity: 0.03, shadowRadius: 4, elevation: 1, marginTop: 4,
  },
  sectionIconBg: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  sectionHeaderText: { flex: 1 },
  sectionTitle:      { fontSize: 15, fontWeight: "700", color: C.gray900 },
  sectionMeta:       { fontSize: 11, color: C.gray500, marginTop: 2 },
  sectionBadge: {
    width: 26, height: 26, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  sectionBadgeText: { fontSize: 12, fontWeight: "800" },

  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.white, borderLeftWidth: 1,
    borderRightWidth: 1, borderBottomWidth: 1,
    borderColor: C.gray200, overflow: "hidden", gap: 10,
  },
  cardLast: {
    borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 4, elevation: 1,
  },
  cardRejected: { borderColor: "#FECACA" },
  cardApproved: { borderColor: "#A7F3D0", opacity: 0.85 },
  cardAccent:   { width: 4, alignSelf: "stretch" },
  iconWrap: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  cardInfo:   { flex: 1, paddingVertical: 12 },
  cardName:   { fontSize: 14, fontWeight: "700", color: C.gray900 },
  cardSub:    { fontSize: 11, color: C.gray500, marginTop: 2 },
  scoresText: {
    fontSize: 11, color: C.success, fontWeight: "600", marginTop: 3,
  },
  rejectionBox: {
    flexDirection: "row", alignItems: "flex-start", gap: 4,
    marginTop: 6, backgroundColor: C.errorBg, borderRadius: 6, padding: 6,
  },
  rejectionText: { fontSize: 11, color: C.error, flex: 1 },
  approvedText:  {
    fontSize: 11, color: C.success, fontWeight: "600", marginTop: 4,
  },
  cardRight:   { alignItems: "flex-end", gap: 4, paddingRight: 12 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusText:  { fontSize: 11, fontWeight: "700" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TeacherExamSubjectsScreen() {
  const { examId, examName } = useLocalSearchParams();
  const { t }     = useTranslation();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId;
  const teacherId = String(user?._id || user?.id || "");
  const role      = user?.role || "";

  const [selectedSubject, setSelectedSubject] = useState(null);
  const [saving,          setSaving]          = useState(false);

  const saveRef  = useRef(null);
  const dirtyRef = useRef(false);

  const step = selectedSubject ? 1 : 0;

  const handleBack = useCallback(() => {
    const goBack = () => {
      dirtyRef.current = false;
      if (step === 1) setSelectedSubject(null);
      else            router.back();
    };

    if (step === 1 && dirtyRef.current) {
      Alert.alert(
        t("teacherExamSubjects.unsavedTitle"),
        t("teacherExamSubjects.unsavedBody"),
        [
          {
            text:  t("teacherExamSubjects.keepEditing"),
            style: "cancel",
          },
          {
            text:    t("teacherExamSubjects.discard"),
            style:   "destructive",
            onPress: goBack,
          },
        ]
      );
    } else {
      goBack();
    }
  }, [step, t]);

  const handleSaved = useCallback((action) => {
    dirtyRef.current = false;
    if (action === "back") setSelectedSubject(null);
    else                   router.back();
  }, []);

  const confirmDiscard = useCallback((onConfirm) => {
    if (step === 1 && dirtyRef.current) {
      Alert.alert(
        t("teacherExamSubjects.unsavedTitle"),
        t("teacherExamSubjects.unsavedBody"),
        [
          {
            text:  t("teacherExamSubjects.keepEditing"),
            style: "cancel",
          },
          {
            text:    t("teacherExamSubjects.discard"),
            style:   "destructive",
            onPress: () => {
              dirtyRef.current = false;
              onConfirm();
            },
          },
        ]
      );
    } else {
      onConfirm();
    }
  }, [step, t]);

  const headerTitle =
    step === 1
      ? selectedSubject?.subjectName
      : examName || t("teacherExamSubjects.screenTitle");

  const headerSub =
    step === 1
      ? t("teacherExamSubjects.headerSubEntry", {
          exam:  examName || t("teacherExamSubjects.examFallback"),
          class: selectedSubject?.className || "",
        })
      : t("teacherExamSubjects.headerSubList", {
          exam: examName || t("teacherExamSubjects.examFallback"),
        });

  return (
    <View style={ms.container}>

      {/* Header */}
      <View style={ms.header}>
        <TouchableOpacity
          style={ms.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
          disabled={saving}
        >
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={ms.headerCenter}>
          <Text style={ms.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <Text style={ms.headerSub} numberOfLines={1}>
            {headerSub}
          </Text>
        </View>
        {step === 1 && (
          <TouchableOpacity
            style={[ms.saveBtn, saving && ms.saveBtnDisabled]}
            onPress={() => saveRef.current?.()}
            activeOpacity={0.8}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator size="small" color={C.white} />
              : <Text style={ms.saveBtnText}>
                  {t("teacherExamSubjects.save")}
                </Text>
            }
          </TouchableOpacity>
        )}
      </View>

      {/* Breadcrumb */}
      <View style={ms.breadcrumb}>
        <TouchableOpacity
          onPress={() => confirmDiscard(() => router.back())}
          activeOpacity={0.7}
        >
          <Text style={ms.crumbLink}>
            {t("teacherExamSubjects.myExams")}
          </Text>
        </TouchableOpacity>
        <Ionicons name="chevron-forward" size={13} color={C.gray200} />
        <TouchableOpacity
          onPress={() => confirmDiscard(() => setSelectedSubject(null))}
          disabled={step === 0}
          activeOpacity={0.7}
        >
          <Text
            style={[
              ms.crumb,
              step === 0 && ms.crumbActive,
              step === 1 && ms.crumbLink,
            ]}
            numberOfLines={1}
          >
            {examName || t("teacherExamSubjects.examFallback")}
          </Text>
        </TouchableOpacity>
        {step === 1 && (
          <>
            <Ionicons name="chevron-forward" size={13} color={C.gray200} />
            <Text style={[ms.crumb, ms.crumbActive]} numberOfLines={1}>
              {selectedSubject?.subjectName}
            </Text>
          </>
        )}
      </View>

      {/* Content */}
      {step === 0 && (
        <SubjectListView
          examId={examId}
          schoolId={schoolId}
          teacherId={teacherId}
          onSelect={(sub) =>
            setSelectedSubject({
              subjectId:     String(sub.subjectId || sub._id),
              subjectName:   sub.subjectName  ||
                             t("teacherExamSubjects.subjectFallback"),
              examSubjectId: String(sub._id   || sub.id),
              classId:       String(sub.classId || ""),
              className:     sub.className    || "",
              maxScore:      sub.maxScore     ?? 100,
              passMark:      sub.passMark     ?? 50,
            })
          }
        />
      )}

      {step === 1 && (
        <ScoreEntry
          examId={examId}
          examSubjectId={selectedSubject.examSubjectId}
          subjectId={selectedSubject.subjectId}
          classId={selectedSubject.classId}
          schoolId={schoolId}
          role={role}
          maxScore={selectedSubject.maxScore}
          passMark={selectedSubject.passMark}
          subjectName={selectedSubject.subjectName}
          onSaved={handleSaved}
          saveRef={saveRef}
          saving={saving}
          setSaving={setSaving}
          dirtyRef={dirtyRef}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// MAIN SCREEN STYLES
// ─────────────────────────────────────────────────────────

const ms = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.gray50 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: C.white, borderBottomWidth: 1,
    borderBottomColor: C.gray100, gap: 10,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: C.gray100,
    alignItems: "center", justifyContent: "center",
  },
  headerCenter:    { flex: 1 },
  headerTitle:     { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:       { fontSize: 12, color: C.gray500, marginTop: 2 },
  saveBtn: {
    backgroundColor: C.primary, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 18,
    minWidth: 70, alignItems: "center",
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText:     { color: C.white, fontWeight: "700", fontSize: 14 },
  breadcrumb: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: C.white, borderBottomWidth: 1,
    borderBottomColor: C.gray100, flexWrap: "wrap",
  },
  crumb:       { fontSize: 13, color: C.gray400, fontWeight: "600" },
  crumbLink:   { fontSize: 13, color: C.primary, fontWeight: "600" },
  crumbActive: { color: C.gray900, fontWeight: "700" },
});