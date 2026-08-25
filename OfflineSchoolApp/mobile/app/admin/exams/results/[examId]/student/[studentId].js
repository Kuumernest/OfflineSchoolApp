// app/admin/exams/results/[examId]/student/[studentId].js
"use strict";

import React, {
  useEffect, useState, useCallback, useMemo,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, StatusBar, Share, TextInput,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons }                     from "@expo/vector-icons";
import { useAuthStore }                 from "../../../../../../src/store/auth.store";
import api                              from "../../../../../../src/services/api";
import ReportCard                       from "../../../../components/ReportCard";

// ─────────────────────────────────────────────────────────
// COLORS
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
  purple:    "#7C3AED",
  purpleBg:  "#F5F3FF",
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
// TABS
// ─────────────────────────────────────────────────────────

const TABS = [
  { key: "setup",   label: "Setup",       icon: "settings-outline"      },
  { key: "preview", label: "Report Card", icon: "document-text-outline" },
];

// ─────────────────────────────────────────────────────────
// SUBJECT ROW EDITOR
// ─────────────────────────────────────────────────────────

function SubjectEditor({ subject, onChange }) {
  const isAbsent   = subject.isAbsent || subject.isExempt;
  const scoreColor = isAbsent
    ? C.gray400
    : subject.isPassing === true  ? C.success
    : subject.isPassing === false ? C.error
    : C.gray700;

  return (
    <View style={se.row}>
      <View style={se.nameCol}>
        <Text style={se.name} numberOfLines={1}>
          {subject.subjectName || "Unknown"}
        </Text>
        {!!subject.teacherName && (
          <Text style={se.teacher}>{subject.teacherName}</Text>
        )}
        {isAbsent && (
          <View style={se.absentBadge}>
            <Text style={se.absentText}>
              {subject.isAbsent ? "ABSENT" : "EXEMPT"}
            </Text>
          </View>
        )}
      </View>

      <View style={se.scoreCol}>
        <Text style={[se.score, { color: scoreColor }]}>
          {isAbsent ? "—" : subject.score ?? "—"}
        </Text>
        <Text style={se.maxScore}>/{subject.maxScore}</Text>
      </View>

      <View style={se.coeffCol}>
        <TextInput
          style={[se.coeffInput, isAbsent && se.coeffDisabled]}
          value={String(subject.coefficient ?? 1)}
          onChangeText={(v) => {
            const num = parseFloat(v) || 0;
            onChange({ ...subject, coefficient: num });
          }}
          keyboardType="decimal-pad"
          editable={!isAbsent}
          selectTextOnFocus
        />
      </View>

      <View style={se.normCol}>
        <Text style={[se.norm, { color: scoreColor }]}>
          {isAbsent
            ? "—"
            : subject.normalizedMark != null
            ? subject.normalizedMark.toFixed(2)
            : "—"}
        </Text>
        <Text style={se.normLabel}>/20</Text>
      </View>

      <View style={se.weightedCol}>
        <Text style={[se.weighted, { color: scoreColor }]}>
          {isAbsent || subject.weightedScore == null
            ? "—"
            : subject.weightedScore.toFixed(2)}
        </Text>
      </View>
    </View>
  );
}

const se = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               6,
  },
  nameCol:     { flex: 1.8 },
  name:        { fontSize: 13, fontWeight: "600", color: C.gray900 },
  teacher:     { fontSize: 10, color: C.gray400, marginTop: 1 },
  absentBadge: {
    marginTop:         3,
    alignSelf:         "flex-start",
    backgroundColor:   C.gray100,
    borderRadius:      4,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  absentText:  { fontSize: 9, fontWeight: "700", color: C.gray500 },
  scoreCol: {
    flex:          0.8,
    flexDirection: "row",
    alignItems:    "baseline",
    gap:           2,
  },
  score:    { fontSize: 14, fontWeight: "700" },
  maxScore: { fontSize: 10, color: C.gray400 },
  coeffCol: { flex: 0.7, alignItems: "center" },
  coeffInput: {
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      6,
    paddingVertical:   4,
    paddingHorizontal: 8,
    fontSize:          13,
    fontWeight:        "700",
    color:             C.primary,
    textAlign:         "center",
    backgroundColor:   C.primaryBg,
    width:             52,
  },
  coeffDisabled: {
    backgroundColor: C.gray100,
    color:           C.gray400,
    borderColor:     C.gray100,
  },
  normCol: {
    flex:           0.8,
    flexDirection:  "row",
    alignItems:     "baseline",
    justifyContent: "center",
    gap:            1,
  },
  norm:        { fontSize: 13, fontWeight: "700" },
  normLabel:   { fontSize: 10, color: C.gray400 },
  weightedCol: { flex: 0.8, alignItems: "flex-end" },
  weighted:    { fontSize: 13, fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────
// SUMMARY BAR
// ─────────────────────────────────────────────────────────

function SummaryBar({ computed, passMark, outOf }) {
  if (!computed) return null;
  const {
    average, isPassing, totalCoefficients,
    subjectsPassed, subjectsFailed,
  } = computed;
  const color = isPassing ? C.success : C.error;

  return (
    <View style={[sb.bar, {
      borderColor:     color + "40",
      backgroundColor: color + "08",
    }]}>
      <View style={sb.item}>
        <Text style={[sb.val, { color }]}>{average?.toFixed(2)}</Text>
        <Text style={sb.lbl}>Avg /{outOf}</Text>
      </View>
      <View style={sb.divider} />
      <View style={sb.item}>
        <Text style={[sb.val, { color: C.primary }]}>{totalCoefficients}</Text>
        <Text style={sb.lbl}>Total Coeff</Text>
      </View>
      <View style={sb.divider} />
      <View style={sb.item}>
        <Text style={[sb.val, { color: C.success }]}>{subjectsPassed ?? 0}</Text>
        <Text style={sb.lbl}>Passed</Text>
      </View>
      <View style={sb.divider} />
      <View style={sb.item}>
        <Text style={[sb.val, { color: C.error }]}>{subjectsFailed ?? 0}</Text>
        <Text style={sb.lbl}>Failed</Text>
      </View>
      <View style={sb.divider} />
      <View style={[sb.badge, { backgroundColor: color + "18" }]}>
        <Text style={[sb.badgeText, { color }]}>
          {isPassing ? "PASS" : "FAIL"}
        </Text>
      </View>
    </View>
  );
}

const sb = StyleSheet.create({
  bar: {
    flexDirection:     "row",
    alignItems:        "center",
    borderRadius:      12,
    borderWidth:       1,
    padding:           12,
    marginHorizontal:  16,
    marginBottom:      12,
    gap:               8,
  },
  item:    { alignItems: "center", flex: 1 },
  val:     { fontSize: 16, fontWeight: "800" },
  lbl:     { fontSize: 9, color: C.gray500, marginTop: 2, fontWeight: "600" },
  divider: { width: 1, height: 28, backgroundColor: C.gray200 },
  badge: {
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  badgeText: { fontSize: 12, fontWeight: "800" },
});

// ─────────────────────────────────────────────────────────
// LIVE STAT
// ─────────────────────────────────────────────────────────

function LiveStat({ label, value, color }) {
  return (
    <View style={ls.item}>
      <Text style={[ls.val, { color }]}>{value ?? "—"}</Text>
      <Text style={ls.lbl}>{label}</Text>
    </View>
  );
}

const ls = StyleSheet.create({
  item: { alignItems: "center", flex: 1 },
  val:  { fontSize: 18, fontWeight: "800" },
  lbl:  { fontSize: 10, color: C.gray500, marginTop: 2, textAlign: "center" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function StudentReportCardScreen() {
  const { examId, studentId } = useLocalSearchParams();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [activeTab,   setActiveTab]   = useState("setup");
  const [loading,     setLoading]     = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [sharing,     setSharing]     = useState(false);
  const [error,       setError]       = useState(null);

  const [reportData,  setReportData]  = useState(null);
  const [computed,    setComputed]    = useState(null);
  const [subjects,    setSubjects]    = useState([]);

  const [outOf,    setOutOf]    = useState("20");
  const [passMark, setPassMark] = useState("10");

  // ── Load report card data ─────────────────────────────

  const loadReportCard = useCallback(async () => {
    if (!examId || !studentId) return;
    try {
      setLoading(true);
      setError(null);

      const { data } = await api.get(
        `/results/${examId}/student/${studentId}/reportcard`
      );

      if (!data?.success) throw new Error(data?.error || "Failed to load");

      setReportData(data.data);
      setSubjects((data.data.subjects || []).map((s) => ({ ...s })));

      if (data.data.summary) {
        setComputed(data.data.summary);
        setActiveTab("preview");
      }
    } catch (err) {
      console.error("loadReportCard:", err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [examId, studentId]);

  useEffect(() => { loadReportCard(); }, [loadReportCard]);

  // ── Live calculation ──────────────────────────────────

  const liveComputed = useMemo(() => {
    if (!subjects.length) return null;

    const out  = parseFloat(outOf)    || 20;
    const pass = parseFloat(passMark) || 10;

    let totalWeighted = 0;
    let totalCoeff    = 0;
    let passed        = 0;
    let failed        = 0;

    const rows = subjects.map((s) => {
      if (s.isAbsent || s.isExempt || s.score == null) {
        return { ...s, normalizedMark: null, weightedScore: null };
      }
      const max      = s.maxScore || 100;
      const norm     = Math.round((s.score / max) * out * 100) / 100;
      const weighted = Math.round(norm * (s.coefficient ?? 1) * 100) / 100;
      totalWeighted += weighted;
      totalCoeff    += s.coefficient ?? 1;
      const isPass   = norm >= pass;
      if (isPass) passed++; else failed++;
      return { ...s, normalizedMark: norm, weightedScore: weighted, isPassing: isPass };
    });

    const avg    = totalCoeff > 0
      ? Math.round((totalWeighted / totalCoeff) * 100) / 100
      : 0;
    const isPass = avg >= pass;
    const pct    = out > 0 ? Math.round((avg / out) * 100) : 0;

    return {
      rows,
      average:           avg,
      outOf:             out,
      passMark:          pass,
      percentage:        pct,
      isPassing:         isPass,
      totalCoefficients: totalCoeff,
      subjectsPassed:    passed,
      subjectsFailed:    failed,
    };
  }, [subjects, outOf, passMark]);

  const displaySubjects = liveComputed?.rows ?? subjects;

  // ── Subject change ────────────────────────────────────

  const handleSubjectChange = useCallback((updated) => {
    setSubjects((prev) =>
      prev.map((s) =>
        s.subjectId === updated.subjectId ? updated : s
      )
    );
  }, []);

  // ── Calculate & save ──────────────────────────────────

  const handleCalculate = useCallback(async () => {
    try {
      setCalculating(true);
      const out  = parseFloat(outOf)    || 20;
      const pass = parseFloat(passMark) || 10;

      const { data } = await api.post(
        `/results/${examId}/student/${studentId}/reportcard/calculate`,
        {
          subjects: subjects.map((s) => ({
            subjectId:   s.subjectId,
            subjectName: s.subjectName,
            score:       s.score,
            maxScore:    s.maxScore,
            coefficient: s.coefficient ?? 1,
            isAbsent:    s.isAbsent,
            isExempt:    s.isExempt,
          })),
          outOf:    out,
          passMark: pass,
        }
      );

      if (!data?.success) throw new Error(data?.error || "Calculation failed");

      setComputed(data.data);
      setActiveTab("preview");
      Alert.alert("Done", "Report card calculated and saved.");
    } catch (err) {
      Alert.alert("Error", err.message || "Calculation failed");
    } finally {
      setCalculating(false);
    }
  }, [examId, studentId, subjects, outOf, passMark]);

  // ── Share ─────────────────────────────────────────────

  const handleShare = useCallback(async () => {
    try {
      setSharing(true);
      const d = reportData;
      const c = computed || liveComputed;
      const msg =
        `📋 REPORT CARD\n` +
        `Student: ${d?.studentName || "—"}\n` +
        `Admission: ${d?.admissionNo ? "#" + d.admissionNo : "—"}\n` +
        `Class: ${d?.className || "—"}\n` +
        `Exam: ${d?.examName || "—"} · ${d?.term || ""} ${d?.academicYear || ""}\n\n` +
        `RESULTS:\n` +
        `Average: ${c?.average?.toFixed(2) ?? "—"}/${c?.outOf ?? outOf}\n` +
        `Grade: ${c?.overallGrade || "—"}\n` +
        `Result: ${c?.isPassing ? "✅ PASS" : "❌ FAIL"}\n` +
        `Pass Mark: ${c?.passMark ?? passMark}/${c?.outOf ?? outOf}`;
      await Share.share({ message: msg });
    } catch (err) {
      Alert.alert("Share Failed", err.message);
    } finally {
      setSharing(false);
    }
  }, [reportData, computed, liveComputed, outOf, passMark]);

  // ── Build ReportCard result object ────────────────────

  const reportCardResult = useMemo(() => {
    if (!reportData) return null;
    const c = computed || liveComputed;
    return {
      studentName:      reportData.studentName,
      admissionNo:      reportData.admissionNo,
      className:        reportData.className,
      percentage:       c?.percentage  ?? liveComputed?.percentage,
      average:          c?.average     ?? liveComputed?.average,
      overallGrade:     c?.overallGrade,
      overallRemark:    c?.overallRemark,
      gpa:              c?.gpa,
      isPassing:        c?.isPassing   ?? liveComputed?.isPassing,
      subjectsPassed:   c?.subjectsPassed ?? liveComputed?.subjectsPassed,
      subjectsFailed:   c?.subjectsFailed ?? liveComputed?.subjectsFailed,
      subjectsTotal:    subjects.length,
      totalScore:       null,
      maxTotalScore:    null,
      classPosition:    c?.classPosition,
      gradePosition:    c?.gradePosition,
      schoolPosition:   c?.schoolPosition,
      totalInClass:     c?.totalInClass,
      totalInGrade:     c?.totalInGrade,
      totalInSchool:    c?.totalInSchool,
      promotionStatus:  c?.promotionStatus,
      isPublished:      false,
      subjectBreakdown: displaySubjects.map((s) => ({
        subjectId:      s.subjectId,
        subjectName:    s.subjectName,
        score:          s.score,
        maxScore:       s.maxScore,
        normalizedMark: s.normalizedMark,
        grade:          s.grade,
        points:         s.coefficient,
        isPassing:      s.isPassing,
        isAbsent:       s.isAbsent,
        remark:         s.teacherRemark,
      })),
    };
  }, [reportData, computed, liveComputed, displaySubjects, subjects]);

  const examObj = useMemo(() => ({
    name:         reportData?.examName,
    academicYear: reportData?.academicYear,
    term:         reportData?.term,
  }), [reportData]);

  // ─────────────────────────────────────────────────────
  // RENDER GUARDS
  // ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={s.loadingText}>Loading report card…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.centered}>
        <Ionicons name="alert-circle-outline" size={48} color={C.error} />
        <Text style={s.errorText}>{error}</Text>
        <TouchableOpacity style={s.primaryBtn} onPress={loadReportCard}>
          <Text style={s.primaryBtnText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.grayBtn} onPress={() => router.back()}>
          <Text style={s.grayBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!reportData) {
    return (
      <View style={s.centered}>
        <Ionicons name="document-outline" size={48} color={C.gray200} />
        <Text style={s.emptyText}>No scores found</Text>
        <Text style={s.emptySub}>Enter marks for this student first</Text>
        <TouchableOpacity style={s.grayBtn} onPress={() => router.back()}>
          <Text style={s.grayBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const outOfNum    = parseFloat(outOf)    || 20;
  const passMarkNum = parseFloat(passMark) || 10;

  // ─────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={s.container}>
        <StatusBar barStyle="dark-content" backgroundColor={C.white} />

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity
            style={s.headerBack}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={C.gray900} />
          </TouchableOpacity>

          <View style={s.headerCenter}>
            <Text style={s.headerTitle} numberOfLines={1}>
              {reportData.studentName || "Report Card"}
            </Text>
            <Text style={s.headerSub} numberOfLines={1}>
              {reportData.className} · {reportData.examName}
            </Text>
          </View>

          {/* Share button — hidden on preview tab (ReportCard has its own) */}
          {activeTab === "setup" && (
            <TouchableOpacity
              style={s.shareBtn}
              onPress={handleShare}
              disabled={sharing}
              activeOpacity={0.8}
            >
              {sharing
                ? <ActivityIndicator size="small" color={C.primary} />
                : <Ionicons name="share-outline" size={22} color={C.primary} />
              }
            </TouchableOpacity>
          )}
        </View>

        {/* Tab Bar */}
        <View style={s.tabBar}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[s.tab, activeTab === tab.key && s.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={tab.icon}
                size={15}
                color={activeTab === tab.key ? C.primary : C.gray400}
              />
              <Text style={[
                s.tabText,
                activeTab === tab.key && s.tabTextActive,
              ]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ══ SETUP TAB ══ */}
        {activeTab === "setup" && (
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Student info */}
            <View style={s.card}>
              <View style={s.studentRow}>
                <View style={s.studentAvatar}>
                  <Ionicons name="person" size={22} color={C.primary} />
                </View>
                <View style={s.studentInfo}>
                  <Text style={s.studentName}>
                    {reportData.studentName || "Unknown Student"}
                  </Text>
                  <Text style={s.studentMeta}>
                    {[
                      reportData.admissionNo && `#${reportData.admissionNo}`,
                      reportData.className,
                      reportData.academicYear,
                      reportData.term,
                    ].filter(Boolean).join("  ·  ")}
                  </Text>
                </View>
              </View>
            </View>

            {/* Calculation settings */}
            <View style={s.card}>
              <Text style={s.cardTitle}>Calculation Settings</Text>
              <View style={s.settingsRow}>
                <View style={s.settingItem}>
                  <Text style={s.settingLabel}>Normalize Out Of</Text>
                  <TextInput
                    style={s.settingInput}
                    value={outOf}
                    onChangeText={setOutOf}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
                <View style={s.settingItem}>
                  <Text style={s.settingLabel}>Pass Mark</Text>
                  <TextInput
                    style={s.settingInput}
                    value={passMark}
                    onChangeText={setPassMark}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>
              </View>
              <Text style={s.settingHint}>
                Scores normalize to /{outOf}. Pass mark is {passMark}/{outOf}.
                Weighted avg = Σ(normalized × coeff) ÷ Σcoeff
              </Text>
            </View>

            {/* Live summary bar */}
            <SummaryBar
              computed={liveComputed}
              passMark={passMarkNum}
              outOf={outOfNum}
            />

            {/* Subject table */}
            <View style={s.card}>
              <Text style={s.cardTitle}>Subject Marks & Coefficients</Text>

              <View style={s.tableHead}>
                <Text style={[s.th, { flex: 1.8 }]}>Subject</Text>
                <Text style={[s.th, { flex: 0.8 }]}>Score</Text>
                <Text style={[s.th, { flex: 0.7, textAlign: "center" }]}>
                  Coeff
                </Text>
                <Text style={[s.th, { flex: 0.8, textAlign: "center" }]}>
                  /{outOf}
                </Text>
                <Text style={[s.th, { flex: 0.8, textAlign: "right" }]}>
                  Wtd
                </Text>
              </View>

              {displaySubjects.length === 0 ? (
                <View style={s.emptyTable}>
                  <Text style={s.emptyTableText}>No scores entered yet</Text>
                </View>
              ) : (
                displaySubjects.map((sub, i) => (
                  <SubjectEditor
                    key={sub.subjectId || i}
                    subject={sub}
                    onChange={handleSubjectChange}
                  />
                ))
              )}
            </View>

            {/* Live result card */}
            {liveComputed && (
              <View style={[
                s.card,
                {
                  borderColor: liveComputed.isPassing
                    ? C.success + "40"
                    : C.error + "40",
                },
              ]}>
                <Text style={s.cardTitle}>Live Calculation</Text>
                <View style={s.liveRow}>
                  <LiveStat
                    label={`Average /${outOfNum}`}
                    value={liveComputed.average?.toFixed(2)}
                    color={liveComputed.isPassing ? C.success : C.error}
                  />
                  <LiveStat
                    label="Percentage"
                    value={`${liveComputed.percentage}%`}
                    color={C.primary}
                  />
                  <LiveStat
                    label="Passed"
                    value={liveComputed.subjectsPassed}
                    color={C.success}
                  />
                  <LiveStat
                    label="Failed"
                    value={liveComputed.subjectsFailed}
                    color={C.error}
                  />
                </View>
              </View>
            )}

            {/* Calculate button */}
            <TouchableOpacity
              style={[
                s.calcBtn,
                (calculating || subjects.length === 0) && { opacity: 0.6 },
              ]}
              onPress={handleCalculate}
              disabled={calculating || subjects.length === 0}
              activeOpacity={0.8}
            >
              {calculating
                ? <ActivityIndicator size="small" color={C.white} />
                : <Ionicons name="calculator-outline" size={20} color={C.white} />
              }
              <Text style={s.calcBtnText}>
                {calculating
                  ? "Calculating…"
                  : "Calculate & Generate Report Card"}
              </Text>
            </TouchableOpacity>

            <View style={{ height: 40 }} />
          </ScrollView>
        )}

        {/* ══ PREVIEW TAB ══ */}
        {activeTab === "preview" && (
          <>
            {reportCardResult ? (
              // showExportBar=true — ReportCard owns Print/Share PDF buttons
              <ReportCard
                result={reportCardResult}
                exam={examObj}
                schoolName={user?.schoolName || user?.school?.name}
                examId={String(examId)}
                studentId={String(studentId)}
                schoolId={schoolId}
                showRankings={!!(computed?.classPosition)}
                showExportBar
              />
            ) : (
              <View style={s.centered}>
                <Ionicons
                  name="calculator-outline"
                  size={48}
                  color={C.gray200}
                />
                <Text style={s.emptyText}>No report card yet</Text>
                <Text style={s.emptySub}>
                  Go to Setup and tap "Calculate" to generate
                </Text>
                <TouchableOpacity
                  style={s.calcBtn}
                  onPress={() => setActiveTab("setup")}
                >
                  <Ionicons name="settings-outline" size={18} color={C.white} />
                  <Text style={s.calcBtnText}>Go to Setup</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.gray50 },
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    gap:             12,
    padding:         24,
    backgroundColor: C.gray50,
  },
  loadingText: { fontSize: 14, color: C.gray500 },
  errorText:   { fontSize: 14, color: C.error, textAlign: "center" },
  emptyText:   { fontSize: 16, fontWeight: "700", color: C.gray900 },
  emptySub:    { fontSize: 13, color: C.gray500, textAlign: "center" },

  primaryBtn: {
    backgroundColor:   C.primary,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
  },
  primaryBtnText: { color: C.white, fontWeight: "700" },
  grayBtn: {
    backgroundColor:   C.gray100,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
  },
  grayBtnText: { color: C.gray700, fontWeight: "700" },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  headerBack: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 16, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 11, color: C.gray500, marginTop: 2 },
  shareBtn:     { padding: 8 },

  tabBar: {
    flexDirection:     "row",
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  tab: {
    flex:              1,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               6,
    paddingVertical:   12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive:     { borderBottomColor: C.primary },
  tabText:       { fontSize: 13, color: C.gray400, fontWeight: "600" },
  tabTextActive: { color: C.primary },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, gap: 14 },

  card: {
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         16,
    borderWidth:     1,
    borderColor:     C.gray200,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardTitle: {
    fontSize:     14,
    fontWeight:   "700",
    color:        C.gray900,
    marginBottom: 12,
  },

  studentRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  studentAvatar: {
    width:           48,
    height:          48,
    borderRadius:    14,
    backgroundColor: C.primaryBg,
    alignItems:      "center",
    justifyContent:  "center",
  },
  studentInfo: { flex: 1 },
  studentName: { fontSize: 16, fontWeight: "700", color: C.gray900 },
  studentMeta: { fontSize: 12, color: C.gray500, marginTop: 3 },

  settingsRow: { flexDirection: "row", gap: 12, marginBottom: 10 },
  settingItem: { flex: 1 },
  settingLabel: {
    fontSize:      11,
    fontWeight:    "600",
    color:         C.gray500,
    marginBottom:  6,
    textTransform: "uppercase",
  },
  settingInput: {
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      8,
    paddingVertical:   10,
    paddingHorizontal: 12,
    fontSize:          15,
    fontWeight:        "700",
    color:             C.primary,
    backgroundColor:   C.primaryBg,
    textAlign:         "center",
  },
  settingHint: { fontSize: 11, color: C.gray400, lineHeight: 16 },

  tableHead: {
    flexDirection:     "row",
    paddingVertical:   8,
    paddingHorizontal: 12,
    backgroundColor:   C.gray50,
    borderRadius:      6,
    marginBottom:      4,
  },
  th: {
    fontSize:      10,
    fontWeight:    "700",
    color:         C.gray500,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  emptyTable:     { alignItems: "center", paddingVertical: 24 },
  emptyTableText: { fontSize: 13, color: C.gray400 },

  liveRow: { flexDirection: "row", justifyContent: "space-around" },

  calcBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    backgroundColor: C.primary,
    borderRadius:    14,
    paddingVertical: 16,
  },
  calcBtnText: { color: C.white, fontWeight: "700", fontSize: 15 },
});