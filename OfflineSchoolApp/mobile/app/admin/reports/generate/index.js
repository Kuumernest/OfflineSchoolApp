// app/admin/reports/generate/index.js
"use strict";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Modal, FlatList, StatusBar,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }    from "@expo/vector-icons";
import { useAuthStore } from "../../../../src/store/auth.store";
import { getDatabase }  from "../../../../src/db/database";
import api              from "../../../../src/services/api";
import * as Print       from "expo-print";
import * as Sharing     from "expo-sharing";

import { tableExists as _tableExists } from "../../../../src/db/dbHelpers";
import { useTranslation } from "../../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
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
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

const TERMS       = ["First Term", "Second Term", "Third Term"];
const currentYear = new Date().getFullYear();
const YEARS       = Array.from({ length: 5 }, (_, i) => String(currentYear - 2 + i));
/** The id is the stored value the API expects and stays English; only the
 *  displayed name is localised, via termLabel() below. */
const TERM_KEYS = {
  "First Term":  "reportGen.termFirst",
  "Second Term": "reportGen.termSecond",
  "Third Term":  "reportGen.termThird",
};
const termLabel = (t, term) => (TERM_KEYS[term] ? t(TERM_KEYS[term]) : term);
const termItems = (t) => TERMS.map((term) => ({ id: term, name: termLabel(t, term) }));
const YEAR_ITEMS  = YEARS.map((y) => ({ id: y, name: y }));

// ─────────────────────────────────────────────────────────
// SCHEMA HELPERS
// ─────────────────────────────────────────────────────────

const resolveCol = (tableInfo, candidates) => {
  const names = new Set(tableInfo.map((c) => c.name));
  return candidates.find((c) => names.has(c)) ?? null;
};

const SCHOOL_COL_CANDIDATES  = ["schoolId", "school_id"];
const CLASS_COL_CANDIDATES   = ["classId",  "class_id"];
const DELETED_COL_CANDIDATES = ["deleted_at", "deletedAt"];
const STATUS_COL_CANDIDATES  = ["is_active", "isActive", "status"];

// ─────────────────────────────────────────────────────────
// DATABASE HELPERS
// ─────────────────────────────────────────────────────────

const dbQuery = async (sql, params = []) => {
  try {
    const db = await getDatabase();
    return (await db.getAllAsync(sql, params)) ?? [];
  } catch (err) {
    console.warn("[dbQuery] failed:", err.message, "\nSQL:", sql);
    return [];
  }
};

const dbRun = async (sql, params = []) => {
  try {
    const db = await getDatabase();
    return await db.runAsync(sql, params);
  } catch (err) {
    console.warn("[dbRun] failed:", err.message);
    return null;
  }
};

const getTableInfo = async (tableName) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(`PRAGMA table_info(${tableName})`).catch(() => []);
    return rows || [];
  } catch { return []; }
};

const tableExists = async (tableName) => {
  try {
    const db = await getDatabase();
    return _tableExists(db, tableName);
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────
// LOAD CLASSES
// ─────────────────────────────────────────────────────────

const loadClasses = async (schoolId) => {
  if (!(await tableExists("classes"))) return [];

  const info       = await getTableInfo("classes");
  const schoolCol  = resolveCol(info, SCHOOL_COL_CANDIDATES);
  const deletedCol = resolveCol(info, DELETED_COL_CANDIDATES);

  const conditions = [];
  const params     = [];

  if (schoolCol && schoolId) {
    conditions.push(`${schoolCol} = ?`);
    params.push(schoolId);
  }
  if (deletedCol) {
    conditions.push(`(${deletedCol} IS NULL OR ${deletedCol} = '')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows  = await dbQuery(
    `SELECT id, name FROM classes ${where} ORDER BY name ASC`,
    params
  );

  console.log(`[loadClasses] ${rows.length} class(es) for schoolId=${schoolId}`);
  return rows;
};

// ─────────────────────────────────────────────────────────
// LOAD STUDENTS
// ─────────────────────────────────────────────────────────

const loadStudents = async (classId, schoolId) => {
  if (!(await tableExists("students"))) return [];

  const info     = await getTableInfo("students");
  const colNames = info.map((c) => c.name);
  const colSet   = new Set(colNames);

  const schoolCol  = resolveCol(info, SCHOOL_COL_CANDIDATES);
  const classCol   = resolveCol(info, CLASS_COL_CANDIDATES);
  const deletedCol = resolveCol(info, DELETED_COL_CANDIDATES);
  const statusCol  = resolveCol(info, STATUS_COL_CANDIDATES);

  if (!classCol) {
    console.warn("[loadStudents] No class ID column found");
    return [];
  }

  const conditions = [];
  const params     = [];

  conditions.push(`${classCol} = ?`);
  params.push(classId);

  if (schoolCol && schoolId) {
    conditions.push(`${schoolCol} = ?`);
    params.push(schoolId);
  }
  if (deletedCol) {
    conditions.push(`(${deletedCol} IS NULL OR ${deletedCol} = '')`);
  }
  if (statusCol === "is_active" || statusCol === "isActive") {
    conditions.push(`${statusCol} = 1`);
  } else if (statusCol === "status") {
    conditions.push(`${statusCol} IN ('approved', 'active', 'enrolled')`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const nameCol =
    colSet.has("name")        ? "name"        :
    colSet.has("studentName") ? "studentName" :
    colSet.has("fullName")    ? "fullName"    :
    colSet.has("full_name")   ? "full_name"   : null;

  const firstCol = colSet.has("firstName") ? "firstName" : colSet.has("first_name") ? "first_name" : null;
  const lastCol  = colSet.has("lastName")  ? "lastName"  : colSet.has("last_name")  ? "last_name"  : null;

  let nameExpr;
  if (nameCol) {
    nameExpr = nameCol;
  } else if (firstCol && lastCol) {
    nameExpr = `TRIM(${firstCol} || ' ' || COALESCE(${lastCol}, ''))`;
  } else if (firstCol) {
    nameExpr = firstCol;
  } else {
    nameExpr = "'Unknown'";
  }

  const userIdCol  = colSet.has("user_id") ? "user_id" : colSet.has("userId") ? "userId" : null;
  const groupByCol = userIdCol ?? "id";

  const sql = `
    SELECT
      MIN(id)     AS id,
      ${nameExpr} AS name,
      ${classCol} AS classId
      ${userIdCol ? `, MIN(${userIdCol}) AS userId` : ""}
    FROM students
    ${where}
    GROUP BY ${groupByCol}
    ORDER BY name ASC
  `;

  const rows = await dbQuery(sql, params);

  const seen   = new Set();
  const unique = rows.filter((r) => {
    const key = (r.name || "").toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[loadStudents] ${rows.length} raw → ${unique.length} unique for classId=${classId}`);
  return unique;
};

// ─────────────────────────────────────────────────────────
// LOAD TEMPLATES
// ─────────────────────────────────────────────────────────

const loadTemplates = async (schoolId) => {
  if (!(await tableExists("report_templates"))) return [];

  const info       = await getTableInfo("report_templates");
  const schoolCol  = resolveCol(info, SCHOOL_COL_CANDIDATES);
  const deletedCol = resolveCol(info, DELETED_COL_CANDIDATES);

  const conditions = [];
  const params     = [];

  if (schoolCol && schoolId) {
    conditions.push(`${schoolCol} = ?`);
    params.push(schoolId);
  }
  if (deletedCol) {
    conditions.push(`(${deletedCol} IS NULL OR ${deletedCol} = '')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return dbQuery(
    `SELECT id, name, is_default FROM report_templates
     ${where}
     ORDER BY is_default DESC, name ASC`,
    params
  );
};

// ─────────────────────────────────────────────────────────
// SYNC TEMPLATES FROM API
// ─────────────────────────────────────────────────────────

const syncTemplatesFromApi = async (schoolId) => {
  try {
    const res  = await api.get("/templates", { params: { schoolId }, timeout: 8000 });
    const rows =
      res.data?.templates ||
      res.data?.data      ||
      (Array.isArray(res.data) ? res.data : []);

    if (!rows.length) return;

    if (!(await tableExists("report_templates"))) {
      const db = await getDatabase();
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS report_templates (
          id          TEXT PRIMARY KEY,
          schoolId    TEXT,
          school_id   TEXT,
          name        TEXT,
          html        TEXT,
          css         TEXT,
          is_default  INTEGER DEFAULT 0,
          version     INTEGER DEFAULT 1,
          _synced     INTEGER DEFAULT 1,
          updated_at  TEXT,
          created_at  TEXT
        )
      `).catch(() => {});
    }

    for (const tpl of rows) {
      const id = tpl._id || tpl.id;
      if (!id) continue;
      await dbRun(
        `INSERT OR REPLACE INTO report_templates
           (id, schoolId, school_id, name, html, css, is_default, version, _synced, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id, schoolId, schoolId,
          tpl.name || "Template",
          tpl.html || "",
          tpl.css  || "",
          (tpl.isDefault || tpl.is_default) ? 1 : 0,
          tpl.version || 1,
          tpl.updatedAt || tpl.updated_at || new Date().toISOString(),
          tpl.createdAt || tpl.created_at || new Date().toISOString(),
        ]
      );
    }
    console.log(`[syncTemplates] synced ${rows.length} template(s)`);
  } catch (err) {
    console.warn("[syncTemplates] API sync failed (offline?):", err.message);
  }
};

// ── Phase 2: all HTML rendering is centralized in the backend
//    reportHtml.service.js (GET /results/:examId/student/:studentId/reportcard/html)
// ─────────────────────────────────────────────────────────

const generateAndSharePdf = async (html, filename = "report", t) => {
  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType:    "application/pdf",
      dialogTitle: `Share ${filename}`,
    });
  } else {
    Alert.alert(t("reportGen.pdfSaved"), t("reportGen.savedTo", { uri }));
  }
  return uri;
};

const generateAndPrintPdf = async (html) => {
  await Print.printAsync({ html });
};

const fetchReportCardHtml = async (studentId, examId, schoolId, schoolName) => {
  try {
    const res  = await api.get(
      `/results/${examId}/student/${studentId}/reportcard/html`,
      { params: { schoolId, schoolName } }
    );
    const body = res?.data;
    const html = typeof res === "string"
      ? res
      : body?.data?.html || body?.html || res?.html || "";
    return html || null;
  } catch (err) {
    console.warn("[fetchReportCardHtml] failed:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ReportGeneratorScreen() {
  const { t } = useTranslation();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;
  const params   = useLocalSearchParams();

  const [classes,     setClasses]     = useState([]);
  const [students,    setStudents]    = useState([]);
  const [templates,   setTemplates]   = useState([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [selectedClass,    setSelectedClass]    = useState(null);
  const [selectedStudent,  setSelectedStudent]  = useState(null);
  const [selectedExam,     setSelectedExam]     = useState(
    params.examId ? { id: params.examId, name: params.examName || t("reportGen.examFallback") } : null
  );
  const [selectedTerm,     setSelectedTerm]     = useState(params.term        || "First Term");
  const [selectedYear,     setSelectedYear]     = useState(params.academicYear || String(currentYear));
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  const [generating,    setGenerating]    = useState(false);
  const [progress,      setProgress]      = useState(0);
  const [totalStudents, setTotalStudents] = useState(0);
  const [result,        setResult]        = useState(null);
  const [lastReport,    setLastReport]    = useState(null);

  const [picker, setPicker] = useState(null);

  const templateItems = useMemo(() => [
    { id: "__builtin__", name: `📄 ${t("reportGen.builtinTemplate")}` },
    ...templates.map((tpl) => ({
      ...tpl,
      name: tpl.name + (tpl.is_default ? " ⭐" : ""),
    })),
  ], [templates, t]);

  // ── Initial load ──────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        setDataLoading(true);
        syncTemplatesFromApi(schoolId).catch(() => {});

        const [cls, tmpl] = await Promise.all([
          loadClasses(schoolId),
          loadTemplates(schoolId),
        ]);

        if (!mounted) return;
        setClasses(cls);
        setTemplates(tmpl);

        if (params.examId && params.examName) {
          setSelectedExam({ id: params.examId, name: params.examName });
        }
      } catch (err) {
        console.error("[ReportGenerator] load error:", err.message);
        if (mounted) Alert.alert(t("reportGen.loadError"), err.message);
      } finally {
        if (mounted) setDataLoading(false);
      }
    };

    load();
    return () => { mounted = false; };
  }, [schoolId]);

  // ── Load students when class changes ──────────────────
  useEffect(() => {
    if (!selectedClass) {
      setStudents([]);
      setSelectedStudent(null);
      return;
    }

    let mounted = true;

    loadStudents(selectedClass.id, schoolId)
      .then((sts) => {
        if (mounted) {
          setStudents(sts);
          setSelectedStudent(null);
        }
      })
      .catch((err) => {
        console.error("[ReportGenerator] load students error:", err.message);
      });

    return () => { mounted = false; };
  }, [selectedClass, schoolId]);

  // ── Generate ───────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!selectedClass) {
      Alert.alert(t("reportGen.missing"), t("reportGen.pickClass"));
      return;
    }
    if (!selectedTerm || !selectedYear) {
      Alert.alert(t("reportGen.missing"), t("reportGen.pickTermYear"));
      return;
    }

    setGenerating(true);
    setResult(null);
    setLastReport(null);
    setProgress(0);

    try {
      const schoolName = user?.schoolName || user?.school?.name || t("reportGen.schoolFallback");
      const examId     = selectedExam?.id || params.examId;

      if (selectedStudent) {
        setTotalStudents(1);

        const html = examId
          ? await fetchReportCardHtml(selectedStudent.id, examId, schoolId, schoolName)
          : null;

        if (!html) {
          Alert.alert(
            t("reportGen.noResult"),
            t("reportGen.noResultStudent")
          );
          setProgress(1);
          return;
        }

        await generateAndSharePdf(html, selectedStudent.name, t);
        setProgress(1);
        setLastReport({ studentName: selectedStudent.name });

      } else {
        const classStudents = students.length > 0
          ? students
          : await loadStudents(selectedClass.id, schoolId);

        setTotalStudents(classStudents.length);

        if (classStudents.length === 0) {
          Alert.alert(t("reportGen.noStudents"), t("reportGen.noStudentsBody"));
          return;
        }

        const successful = [];
        const errors     = [];

                for (let i = 0; i < classStudents.length; i++) {
          const student = classStudents[i];
      try {
            const html = examId
              ? await fetchReportCardHtml(student.id, examId, schoolId, schoolName)
              : null;

            if (!html) {
              errors.push({
                studentName: student.name,
                error: "No processed result found. Run Results → Compute first.",
              });
              setProgress(i + 1);
              continue;
            }

            const { uri } = await Print.printToFileAsync({ html });
            successful.push({ studentName: student.name, uri });
          } catch (err) {
            errors.push({ studentName: student.name, error: err.message });
          }
          setProgress(i + 1);
        }

        setResult({
          total:        classStudents.length,
          successCount: successful.length,
          errorCount:   errors.length,
          successful,
          errors,
        });

        if (successful.length > 0 && (await Sharing.isAvailableAsync())) {
          Alert.alert(
            t("reportGen.generated"),
            t("reportGen.generatedBody", {
              done:  successful.length,
              total: classStudents.length,
            }),
            [
              { text: t("reportGen.skip"), style: "cancel" },
              {
                text:    t("reportGen.share"),
                onPress: () =>
                  Sharing.shareAsync(successful[0].uri, {
                    mimeType:    "application/pdf",
                    dialogTitle: t("reportGen.shareTitle"),
                  }),
              },
            ]
          );
        }
      }
    } catch (err) {
      Alert.alert(t("reportGen.errTitle"), err.message);
    } finally {
      setGenerating(false);
    }
  }, [
    selectedClass, selectedStudent, selectedExam, selectedTerm,
    selectedYear, selectedTemplate, schoolId, students, user, params.examId,
  ]);

  // ── Print single ───────────────────────────────────────
  const handlePrintSingle = useCallback(async () => {
    if (!selectedStudent && !selectedClass) {
      Alert.alert("", t("reportGen.pickClassOrStudent"));
      return;
    }
    try {
      const examId = selectedExam?.id || params.examId;
      const school  = user?.schoolName || t("reportGen.schoolFallback");
      const html    = examId
        ? await fetchReportCardHtml(
            selectedStudent?.id || selectedClass?.id,
            examId, schoolId, school
          )
        : null;
      if (!html) {
        Alert.alert(t("reportGen.noResult"), t("reportGen.noResultExam"));
        return;
      }

      await generateAndPrintPdf(html);
    } catch (err) {
      Alert.alert(t("reportGen.printError"), err.message);
    }
  }, [selectedStudent, selectedClass, selectedExam, user]);

  // ─────────────────────────────────────────────────────────
  // RENDER — Loading
  // ─────────────────────────────────────────────────────────

  if (dataLoading) {
    return (
      <View style={s.screen}>
        <StatusBar barStyle="dark-content" backgroundColor={C.white} />
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={24} color={C.gray900} />
          </TouchableOpacity>
          <View style={s.headerCenter}>
            <Text style={s.headerTitle}>{t("reportGen.headerTitle")}</Text>
            <Text style={s.headerSub}>{t("reportGen.headerSub")}</Text>
          </View>
        </View>
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadingText}>{t("reportGen.loadingSchool")}</Text>
        </View>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — Main
  // ─────────────────────────────────────────────────────────

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>{t("reportGen.headerTitle")}</Text>
          <Text style={s.headerSub}>{t("reportGen.headerSub")}</Text>
        </View>
        <TouchableOpacity onPress={handlePrintSingle} style={s.printBtn} activeOpacity={0.7}>
          <Ionicons name="print-outline" size={20} color={C.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Exam info banner */}
        {selectedExam && (
          <View style={s.examBanner}>
            <Ionicons name="document-text-outline" size={16} color={C.primary} />
            <Text style={s.examBannerText} numberOfLines={1}>
              Exam: {selectedExam.name}
            </Text>
            <TouchableOpacity onPress={() => setSelectedExam(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={C.gray400} />
            </TouchableOpacity>
          </View>
        )}

        {/* Step 1: Class */}
        <StepCard step={1} title={t("reportGen.stepClass")}>
          <Selector
            label={selectedClass?.name || t("reportGen.tapClass")}
            hasValue={!!selectedClass}
            onPress={() => setPicker("class")}
          />
          {classes.length === 0 && (
            <Text style={s.warnText}>
              ⚠️ {t("reportGen.noClassesWarn")}
            </Text>
          )}
        </StepCard>

        {/* Step 2: Student */}
        <StepCard step={2} title={t("reportGen.stepStudent")}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Selector
                label={
                  selectedStudent?.name ||
                  (students.length > 0
                    ? `All ${students.length} students`
                    : selectedClass
                      ? t("reportGen.loadingStudents")
                      : t("reportGen.selectClassFirst"))
                }
                hasValue={!!selectedStudent}
                onPress={() => {
                  if (!selectedClass) {
                    Alert.alert("", t("reportGen.pickClassFirst"));
                    return;
                  }
                  setPicker("student");
                }}
              />
            </View>
            {selectedStudent && (
              <TouchableOpacity
                style={s.clearBtn}
                onPress={() => setSelectedStudent(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={20} color={C.error} />
              </TouchableOpacity>
            )}
          </View>
          <Text style={s.hint}>{t("reportGen.wholeClassHint")}</Text>
          {selectedClass && students.length > 0 && !selectedStudent && (
            <View style={s.studentCountBadge}>
              <Ionicons name="people-outline" size={12} color={C.success} />
              <Text style={s.studentCountText}>
                {students.length} unique student{students.length !== 1 ? "s" : ""} loaded
              </Text>
            </View>
          )}
        </StepCard>

        {/* Step 3: Term & Year */}
        <StepCard step={3} title={t("reportGen.stepTerm")}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Selector
                label={termLabel(t, selectedTerm)}
                hasValue
                onPress={() => setPicker("term")}
              />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Selector
                label={selectedYear}
                hasValue
                onPress={() => setPicker("year")}
              />
            </View>
          </View>
        </StepCard>

        {/* Step 4: Template */}
        <StepCard step={4} title={t("reportGen.stepTemplate")}>
          <Selector
            label={
              selectedTemplate?.name ||
              (templates.length
                ? `Built-in (${templates.length} custom available)`
                : t("reportGen.builtinShort"))
            }
            hasValue={!!selectedTemplate}
            onPress={() => setPicker("template")}
          />
          <Text style={s.hint}>
            {templates.length === 0
              ? t("reportGen.usingBuiltin")
              : `${templates.length} custom template(s) available`}
          </Text>
          <TouchableOpacity
            style={s.designerLink}
            onPress={() => router.push("/admin/reports/templates")}
            activeOpacity={0.7}
          >
            <Ionicons name="color-palette-outline" size={14} color={C.primary} />
            <Text style={s.designerLinkText}>
              {templates.length === 0
                ? t("reportGen.createTemplate")
                : t("reportGen.manageTemplates")}
            </Text>
          </TouchableOpacity>
        </StepCard>

        {/* Progress */}
        {generating && (
          <View style={s.progressCard}>
            <ActivityIndicator color={C.primary} />
            <Text style={s.progressText}>
              Generating {progress} of {totalStudents || "…"}
            </Text>
            {totalStudents > 0 && (
              <View style={s.progressBar}>
                <View style={[
                  s.progressFill,
                  { width: `${Math.round((progress / totalStudents) * 100)}%` },
                ]} />
              </View>
            )}
          </View>
        )}

        {/* Single student result */}
        {lastReport && !generating && (
          <View style={s.resultCard}>
            <View style={s.resultHeader}>
              <Ionicons name="checkmark-circle" size={24} color={C.success} />
              <Text style={s.resultTitle}>
                Report generated for {lastReport.studentName}
              </Text>
            </View>
            <Text style={s.resultInfo}>{t("reportGen.pdfShared")}</Text>
          </View>
        )}

        {/* Batch result */}
        {result && !generating && (
          <View style={s.resultCard}>
            <View style={s.resultHeader}>
              <Ionicons
                name={result.errorCount > 0 ? "warning-outline" : "checkmark-circle"}
                size={24}
                color={result.errorCount > 0 ? C.warning : C.success}
              />
              <Text style={s.resultTitle}>
                {result.successCount} of {result.total} reports generated
              </Text>
            </View>

            {result.errorCount > 0 && (
              <View style={s.errorBox}>
                <Text style={s.errorBoxTitle}>{result.errorCount} failed:</Text>
                {result.errors.slice(0, 5).map((e, i) => (
                  <Text key={i} style={s.errorBoxItem}>
                    • {e.studentName}: {e.error}
                  </Text>
                ))}
                {result.errors.length > 5 && (
                  <Text style={s.errorBoxItem}>
                    …and {result.errors.length - 5} more
                  </Text>
                )}
              </View>
            )}

            {result.successful.length > 0 && (
              <View style={s.resultActions}>
                <TouchableOpacity
                  style={s.resultBtn}
                  onPress={() =>
                    Sharing.shareAsync(result.successful[0].uri, {
                      mimeType:    "application/pdf",
                      dialogTitle: t("reportGen.shareTitle"),
                    })
                  }
                  activeOpacity={0.7}
                >
                  <Ionicons name="share-outline" size={16} color={C.primary} />
                  <Text style={s.resultBtnText}>{t("reportGen.shareFirst")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.resultBtn}
                  onPress={() => Print.printAsync({ uri: result.successful[0].uri })}
                  activeOpacity={0.7}
                >
                  <Ionicons name="print-outline" size={16} color={C.primary} />
                  <Text style={s.resultBtnText}>{t("reportGen.print")}</Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={s.resultInfo}>
              {result.successCount} PDF{result.successCount !== 1 ? "s" : ""} saved to device.
            </Text>
          </View>
        )}

        {/* Generate button */}
        <TouchableOpacity
          style={[s.generateBtn, generating && { opacity: 0.6 }]}
          onPress={handleGenerate}
          disabled={generating}
          activeOpacity={0.8}
        >
          {generating ? (
            <ActivityIndicator color={C.white} />
          ) : (
            <>
              <Ionicons name="document-text-outline" size={20} color={C.white} />
              <Text style={s.generateBtnText}>
                {selectedStudent
                  ? `Generate Report for ${selectedStudent.name}`
                  : students.length > 0
                    ? `Generate All ${students.length} Reports`
                    : t("reportGen.generateCta")}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Picker Modals */}
      <PickerModal
        visible={picker === "class"}
        title={t("reportGen.stepClass")}
        items={classes}
        onSelect={(item) => { setSelectedClass(item); setPicker(null); }}
        onClose={() => setPicker(null)}
        emptyText={t("reportGen.noClasses")}
      />
      <PickerModal
        visible={picker === "student"}
        title={t("reportGen.pickerStudent")}
        items={students}
        onSelect={(item) => { setSelectedStudent(item); setPicker(null); }}
        onClose={() => setPicker(null)}
        emptyText={t("reportGen.noStudentsInClass")}
      />
      <PickerModal
        visible={picker === "term"}
        title={t("reportGen.pickerTerm")}
        items={termItems(t)}
        onSelect={(item) => { setSelectedTerm(item.name); setPicker(null); }}
        onClose={() => setPicker(null)}
      />
      <PickerModal
        visible={picker === "year"}
        title={t("reportGen.pickerYear")}
        items={YEAR_ITEMS}
        onSelect={(item) => { setSelectedYear(item.name); setPicker(null); }}
        onClose={() => setPicker(null)}
      />
      <PickerModal
        visible={picker === "template"}
        title={t("reportGen.pickerTemplate")}
        items={templateItems}
        onSelect={(item) => {
          setSelectedTemplate(item.id === "__builtin__" ? null : item);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function StepCard({ step, title, children }) {
  return (
    <View style={s.stepCard}>
      <View style={s.stepHeader}>
        <View style={s.stepBadge}>
          <Text style={s.stepBadgeText}>{step}</Text>
        </View>
        <Text style={s.stepTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Selector({ label, hasValue, onPress }) {
  return (
    <TouchableOpacity
      style={[s.selector, hasValue && s.selectorActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text
        style={[s.selectorText, hasValue && s.selectorTextActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Ionicons
        name="chevron-down"
        size={16}
        color={hasValue ? C.primary : C.gray400}
      />
    </TouchableOpacity>
  );
}

function PickerModal({ visible, title, items, onSelect, onClose, emptyText }) {
  const { t } = useTranslation();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={pm.overlay}>
        <View style={pm.sheet}>
          <View style={pm.header}>
            <Text style={pm.title}>{title}</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={22} color={C.gray700} />
            </TouchableOpacity>
          </View>

          {items.length === 0 ? (
            <View style={pm.empty}>
              <Ionicons name="folder-open-outline" size={36} color={C.gray300} />
              <Text style={pm.emptyText}>{emptyText || t("reportGen.noItems")}</Text>
            </View>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(item, i) => String(item.id ?? i)}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={pm.item}
                  onPress={() => onSelect(item)}
                  activeOpacity={0.7}
                >
                  <Text style={pm.itemText}>{item.name}</Text>
                  {item.is_default ? (
                    <View style={pm.defaultBadge}>
                      <Text style={pm.defaultBadgeText}>{t("reportGen.default")}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => (
                <View style={{ height: 1, backgroundColor: C.gray100 }} />
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  printBtn:     { padding: 8 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  body:         { padding: 16, gap: 12, paddingBottom: 40 },
  examBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             8,
    backgroundColor: C.primaryBg,
    borderRadius:    10,
    padding:         12,
    borderWidth:     1,
    borderColor:     C.primary + "30",
  },
  examBannerText: { flex: 1, fontSize: 13, fontWeight: "600", color: C.primary },
  stepCard: {
    backgroundColor: C.white,
    borderRadius:    14,
    padding:         16,
    gap:             12,
    borderWidth:     1,
    borderColor:     C.gray200,
    shadowColor:     "#000",
    shadowOpacity:   0.03,
    shadowRadius:    4,
    elevation:       1,
  },
  stepHeader:    { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBadge: {
    width:           26,
    height:          26,
    borderRadius:    13,
    backgroundColor: C.primary,
    alignItems:      "center",
    justifyContent:  "center",
  },
  stepBadgeText: { fontSize: 12, fontWeight: "700", color: C.white },
  stepTitle:     { fontSize: 14, fontWeight: "700", color: C.gray900 },
  selector: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   12,
    backgroundColor:   C.gray50,
  },
  selectorActive:     { borderColor: C.primary, backgroundColor: C.primaryBg },
  selectorText:       { fontSize: 14, color: C.gray400, flex: 1 },
  selectorTextActive: { color: C.primary, fontWeight: "600" },
  row:      { flexDirection: "row", alignItems: "center" },
  clearBtn: { padding: 8, marginLeft: 4 },
  hint:     { fontSize: 11, color: C.gray400, fontStyle: "italic" },
  warnText: { fontSize: 12, color: C.warning, marginTop: 4, fontStyle: "italic" },
  studentCountBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   C.successBg,
    borderRadius:      6,
    paddingVertical:   4,
    paddingHorizontal: 10,
    alignSelf:         "flex-start",
  },
  studentCountText: { fontSize: 11, color: C.success, fontWeight: "600" },
  designerLink:     { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  designerLinkText: { fontSize: 12, color: C.primary, fontWeight: "600" },
  progressCard: {
    backgroundColor: C.primaryBg,
    borderRadius:    12,
    padding:         16,
    gap:             10,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     C.primary + "30",
  },
  progressText: { fontSize: 14, color: C.primary, fontWeight: "600" },
  progressBar: {
    width:           "100%",
    height:          6,
    borderRadius:    3,
    backgroundColor: C.gray200,
    overflow:        "hidden",
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: C.primary },
  resultCard: {
    backgroundColor: C.white,
    borderRadius:    14,
    padding:         16,
    gap:             10,
    borderWidth:     1.5,
    borderColor:     C.success,
    borderLeftWidth: 4,
    borderLeftColor: C.success,
  },
  resultHeader:  { flexDirection: "row", alignItems: "center", gap: 10 },
  resultTitle:   { fontSize: 14, fontWeight: "700", color: C.gray900, flex: 1 },
  resultActions: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  resultBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderRadius:      8,
    borderWidth:       1.5,
    borderColor:       C.primary,
    backgroundColor:   C.primaryBg,
  },
  resultBtnText: { fontSize: 13, fontWeight: "700", color: C.primary },
  resultInfo:    { fontSize: 11, color: C.gray500, fontStyle: "italic", lineHeight: 16 },
  errorBox:      { backgroundColor: C.errorBg, borderRadius: 8, padding: 10, gap: 4 },
  errorBoxTitle: { fontSize: 12, fontWeight: "700", color: C.error },
  errorBoxItem:  { fontSize: 11, color: C.error },
  generateBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    backgroundColor: C.primary,
    borderRadius:    14,
    paddingVertical: 16,
    marginTop:       8,
    shadowColor:     C.primary,
    shadowOpacity:   0.3,
    shadowRadius:    8,
    elevation:       4,
  },
  generateBtnText: { fontSize: 16, fontWeight: "700", color: C.white },
});

const pm = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      C.white,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    maxHeight:            "70%",
    paddingBottom:        32,
  },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    padding:           16,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  title:            { fontSize: 16, fontWeight: "700", color: C.gray900 },
  empty:            { alignItems: "center", paddingVertical: 40, paddingHorizontal: 32, gap: 10 },
  emptyText:        { fontSize: 14, color: C.gray400, textAlign: "center" },
  item: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   14,
  },
  itemText:         { fontSize: 15, color: C.gray900 },
  defaultBadge:     { backgroundColor: C.primaryBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  defaultBadgeText: { fontSize: 10, fontWeight: "700", color: C.primary },
});
