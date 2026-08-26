// app/admin/components/ReportCard.js
// Shared report card component — used by both admin and student views
"use strict";

import React, { useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, Alert,
} from "react-native";
import { Ionicons }    from "@expo/vector-icons";
import * as Print      from "expo-print";
import * as Sharing    from "expo-sharing";
import api             from "../../../src/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";

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
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const pctColor = (pct) => {
  if (pct >= 70) return C.success;
  if (pct >= 50) return C.warning;
  return C.error;
};

// `t` is passed in: a module-scope helper cannot call the hook, and the
// ordinal suffix is visible text (1st / 1er).
const positionSuffix = (n, t) => {
  if (!n && n !== 0) return "—";
  const s   = ["th", "st", "nd", "rd"];
  const v   = n % 100;
  const key = s[(v - 20) % 10] || s[v] || s[0];
  return `${n}${t(`reportCardDoc.ordinal.${key}`)}`;
};

// ─────────────────────────────────────────────────────────
// CIRCLE PROGRESS  (pure RN — no SVG needed)
// Uses two half-masks rotated by percentage
// ─────────────────────────────────────────────────────────

const CircleProgress = ({ percentage = 0, size = 88, stroke = 8 }) => {
  const pct   = Math.min(Math.max(percentage, 0), 100);
  const color = pctColor(pct);
  const inner = size - stroke * 2;

  // degrees for each half
  const deg1 = pct > 50 ? 180 : (pct / 50) * 180;
  const deg2 = pct > 50 ? ((pct - 50) / 50) * 180 : 0;

  return (
    <View style={{ width: size, height: size }}>
      {/* Background ring */}
      <View style={{
        position:     "absolute",
        width:        size, height: size,
        borderRadius: size / 2,
        borderWidth:  stroke,
        borderColor:  C.gray100,
      }} />

      {/* Left half fill */}
      <View style={{
        position:   "absolute",
        width:      size, height: size,
        overflow:   "hidden",
        left:       0,
      }}>
        <View style={{
          position:     "absolute",
          width:        size, height: size,
          borderRadius: size / 2,
          borderWidth:  stroke,
          borderColor:  "transparent",
          borderTopColor:  color,
          borderRightColor:color,
          transform: [{ rotate: `${-90 + deg1}deg` }],
        }} />
      </View>

      {/* Right half fill (for > 50%) */}
      {pct > 50 && (
        <View style={{
          position:   "absolute",
          width:      size, height: size,
          overflow:   "hidden",
          left:       0,
        }}>
          <View style={{
            position:     "absolute",
            width:        size, height: size,
            borderRadius: size / 2,
            borderWidth:  stroke,
            borderColor:  "transparent",
            borderTopColor:   color,
            borderLeftColor:  color,
            transform: [{ rotate: `${90 + deg2}deg` }],
          }} />
        </View>
      )}

      {/* Inner white circle */}
      <View style={{
        position:        "absolute",
        top:             stroke, left: stroke,
        width:           inner, height: inner,
        borderRadius:    inner / 2,
        backgroundColor: C.white,
        alignItems:      "center",
        justifyContent:  "center",
      }}>
        <Text style={{ fontSize: 14, fontWeight: "800", color }}>
          {Math.round(pct)}%
        </Text>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

const SectionHeader = ({ icon, title, color = C.primary }) => (
  <View style={s.sectionHeader}>
    <View style={[s.sectionIcon, { backgroundColor: color + "18" }]}>
      <Ionicons name={icon} size={16} color={color} />
    </View>
    <Text style={s.sectionTitle}>{title}</Text>
  </View>
);

const InfoRow = ({ label, value, valueColor }) => (
  <View style={s.infoRow}>
    <Text style={s.infoLabel}>{label}</Text>
    <Text
      style={[s.infoValue, valueColor ? { color: valueColor } : null]}
      numberOfLines={1}
    >
      {value ?? "—"}
    </Text>
  </View>
);

const RankBadge = ({ label, position, total, color }) => {
  const { t } = useTranslation();
  return (
    <View style={[s.rankBadge, {
      borderColor:     color + "30",
      backgroundColor: color + "08",
    }]}>
      <Text style={[s.rankPos, { color }]}>
        {positionSuffix(position, t)}
      </Text>
      <Text style={s.rankLabel}>{label}</Text>
      {position != null && total != null && (
        <Text style={s.rankTotal}>
          {t("reportCardDoc.ofTotal", { total })}
        </Text>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// SUBJECT ROW
// ─────────────────────────────────────────────────────────

const SubjectRow = ({ subject, index, maxScore }) => {
  const { t }    = useTranslation();
  const absent   = subject.isAbsent;
  const passing  = subject.isPassing;
  const score    = subject.score ?? subject.rawScore;
  const norm     = subject.normalizedMark ?? subject.normalizedScore;
  const max      = maxScore || subject.maxScore || 100;

  const color = absent  ? C.gray400
              : passing ? C.success
              : C.error;

  return (
    <View style={[
      s.subjectRow,
      index % 2 === 0 && { backgroundColor: C.gray50 },
    ]}>
      {/* Name */}
      <View style={s.col_name}>
        <Text style={s.subjectName} numberOfLines={1}>
          {subject.subjectName
            || t("reportCardDoc.subjectFallback", { index: index + 1 })}
        </Text>
        {subject.teacherName ? (
          <Text style={s.subjectTeacher} numberOfLines={1}>
            {subject.teacherName}
          </Text>
        ) : null}
      </View>

      {/* Score */}
      <View style={s.col_score}>
        <Text style={[s.subjectScore, { color }]}>
          {absent
            ? t("reportCardDoc.absent")
            : score != null ? score : "—"}
        </Text>
        {norm != null && !absent ? (
          <Text style={s.subjectNorm}>/{Math.round(norm)}</Text>
        ) : null}
      </View>

      {/* Grade */}
      <View style={[s.gradePill, { backgroundColor: color + "18" }]}>
        <Text style={[s.gradeText, { color }]}>
          {absent ? t("reportCardDoc.absent") : subject.grade || "—"}
        </Text>
      </View>

      {/* Points */}
      <Text style={[s.col_pts, { color }]}>
        {absent
          ? "—"
          : (subject.points ?? subject.gpaPoints)?.toFixed(1) ?? "—"}
      </Text>

      {/* Status dot */}
      <View style={[s.statusDot, { backgroundColor: color }]} />
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// PDF EXPORT HELPER
//
// Phase 2: the canonical printable HTML now comes from the shared
// backend renderer (GET /results/:examId/student/:studentId/reportcard/html).
// buildPdfHtml is kept ONLY as an offline fallback when the identifiers or
// the network are unavailable — online, every platform prints the same HTML.
// ─────────────────────────────────────────────────────────

const fetchReportCardHtml = async ({ examId, studentId, schoolId, schoolName }) => {
  try {
    const res = await api.get(
      `/results/${examId}/student/${studentId}/reportcard/html`,
      { params: { schoolId, schoolName } }
    );
    const body = res?.data;
    const html = typeof res === "string"
      ? res
      : body?.data?.html || body?.html || res?.html || "";
    return html || null;
  } catch (err) {
    console.warn("[ReportCard] backend HTML fetch failed, falling back to local builder:", err.message);
    return null;
  }
};

// `t` (and the BCP-47 `locale` for the date) are passed in: this is a
// module-scope builder, so it cannot call the hook itself.
function buildPdfHtml({ result, exam, schoolName, t, locale }) {
  const subjects = result.subjectBreakdown || [];
  const abs      = t("reportCardDoc.absent");
  const rows = subjects.map((s) => {
    const score = s.score ?? s.rawScore;
    const color = s.isAbsent ? "#9CA3AF" : s.isPassing ? "#059669" : "#DC2626";
    return `
      <tr>
        <td>${s.subjectName || ""}</td>
        <td style="text-align:center">${s.isAbsent ? abs : score ?? "—"}</td>
        <td style="text-align:center;color:${color};font-weight:700">
          ${s.isAbsent ? abs : s.grade || "—"}
        </td>
        <td style="text-align:center">
          ${s.isAbsent ? "—" : (s.points ?? s.gpaPoints)?.toFixed(1) ?? "—"}
        </td>
        <td style="text-align:center;color:${color}">
          ${s.isAbsent
            ? "—"
            : s.isPassing
              ? t("reportCardDoc.passed")
              : t("reportCardDoc.failed")}
        </td>
      </tr>
    `;
  }).join("");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; font-size: 12px;
               color: #111; padding: 24px; }
        h1   { font-size: 18px; font-weight: 800; }
        h2   { font-size: 13px; font-weight: 700; margin: 16px 0 6px; }
        .banner { background:#2563EB; color:#fff; border-radius:8px;
                  padding:10px 16px; text-align:center; margin:12px 0; }
        .info-grid { display:flex; gap:24px; margin-bottom:12px; }
        .info-table { flex:1; border-collapse:collapse; }
        .info-table td { padding:4px 0; font-size:12px; }
        .info-table td:first-child { color:#6B7280; width:110px; }
        .summary { display:flex; gap:12px; margin:12px 0; }
        .summary-box { flex:1; text-align:center; border:1px solid #E5E7EB;
                       border-radius:8px; padding:10px 4px; }
        .summary-val { font-size:20px; font-weight:800; }
        .summary-lbl { font-size:10px; color:#6B7280; margin-top:2px; }
        table { width:100%; border-collapse:collapse; margin-top:6px; }
        th    { background:#F3F4F6; font-size:11px; font-weight:700;
                padding:6px 8px; text-align:left;
                border:1px solid #E5E7EB; }
        td    { padding:6px 8px; border:1px solid #E5E7EB; font-size:12px; }
        tr:nth-child(even) td { background:#F9FAFB; }
        .footer { margin-top:24px; border-top:1px solid #E5E7EB;
                  padding-top:10px; text-align:center;
                  font-size:10px; color:#9CA3AF; }
        .pass { color:#059669; font-weight:700; }
        .fail { color:#DC2626; font-weight:700; }
      </style>
    </head>
    <body>
      <h1>${schoolName || t("reportCardDoc.school")}</h1>
      <p style="font-size:10px;color:#2563EB;font-weight:700;
                letter-spacing:1.5px;margin-top:2px">
        ${t("reportCardDoc.title")}
      </p>

      <div class="banner">
        <div style="font-weight:700;font-size:14px">
          ${exam?.name || t("reportCardDoc.examination")}
        </div>
        <div style="font-size:11px;opacity:.85;margin-top:2px">
          ${[exam?.academicYear, exam?.term].filter(Boolean).join("  ·  ")}
        </div>
      </div>

      <table class="info-table">
        <tr>
          <td>${t("reportCardDoc.labels.studentName")}</td>
          <td><strong>${result.studentName || ""}</strong></td>
          <td style="width:16px"></td>
          <td>${t("reportCardDoc.labels.admissionNo")}</td>
          <td>${result.admissionNo ? "#" + result.admissionNo : "—"}</td>
        </tr>
        <tr>
          <td>${t("reportCardDoc.labels.class")}</td>
          <td>${result.className || "—"}</td>
          <td></td>
          <td>${t("reportCardDoc.labels.academicYear")}</td>
          <td>${exam?.academicYear || "—"}</td>
        </tr>
        <tr>
          <td>${t("reportCardDoc.labels.term")}</td>
          <td>${exam?.term || "—"}</td>
          <td></td>
          <td>${t("reportCardDoc.labels.status")}</td>
          <td class="${result.isPassing ? "pass" : "fail"}">
            ${result.isPassing
              ? t("reportCardDoc.pass")
              : t("reportCardDoc.fail")}
          </td>
        </tr>
      </table>

      <h2>${t("reportCardDoc.performanceSummary")}</h2>
      <div class="summary">
        <div class="summary-box">
          <div class="summary-val" style="color:${pctColor(result.percentage ?? 0)}">
            ${(result.percentage ?? 0).toFixed(1)}%
          </div>
          <div class="summary-lbl">${t("reportCardDoc.summary.overall")}</div>
        </div>
        <div class="summary-box">
          <div class="summary-val" style="color:#2563EB">
            ${result.average?.toFixed(1) ?? "—"}
          </div>
          <div class="summary-lbl">${t("reportCardDoc.summary.average")}</div>
        </div>
        <div class="summary-box">
          <div class="summary-val" style="color:#7C3AED">
            ${result.overallGrade || "—"}
          </div>
          <div class="summary-lbl">${t("reportCardDoc.summary.grade")}</div>
        </div>
        ${result.gpa != null ? `
        <div class="summary-box">
          <div class="summary-val" style="color:#D97706">
            ${result.gpa.toFixed(2)}
          </div>
          <div class="summary-lbl">${t("reportCardDoc.summary.gpa")}</div>
        </div>` : ""}
      </div>

      <h2>${t("reportCardDoc.subjectBreakdown")}</h2>
      <table>
        <thead>
          <tr>
            <th>${t("reportCardDoc.table.subject")}</th>
            <th style="text-align:center">${t("reportCardDoc.table.score")}</th>
            <th style="text-align:center">${t("reportCardDoc.table.grade")}</th>
            <th style="text-align:center">${t("reportCardDoc.table.points")}</th>
            <th style="text-align:center">${t("reportCardDoc.table.status")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      ${result.overallRemark ? `
        <h2>${t("reportCardDoc.teacherRemark")}</h2>
        <p style="font-style:italic;color:#4B5563;line-height:1.6">
          ${result.overallRemark}
        </p>
      ` : ""}

      <div class="footer">
        ${t("reportCardDoc.generatedOn", {
          date: new Date().toLocaleDateString(locale || "en-GB", {
            day: "numeric", month: "long", year: "numeric",
          }),
        })}
        &nbsp;·&nbsp; ${t("reportCardDoc.officialReport", {
          school: schoolName || t("reportCardDoc.school"),
        })}
      </div>
    </body>
    </html>
  `;
}

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function ReportCard({
  result,
  exam,
  schoolName,
  schoolLogo,           // reserved for future image use
  examId,               // for the shared backend HTML renderer
  studentId,            // for the shared backend HTML renderer
  schoolId,             // for the shared backend HTML renderer
  showRankings  = true,
  showExportBar = true,
  compact       = false,
}) {
  const { t, locale } = useTranslation();

  if (!result) return null;

  const isPassing  = result.isPassing;
  const passColor  = isPassing ? C.success : C.error;
  const percentage = result.percentage ?? 0;
  const subjects   = result.subjectBreakdown || [];

  // ── PDF export ──────────────────────────────────────────
  const resolveHtml = async () => {
    // Primary: shared backend renderer (canonical, translated, coeff-aware).
    if (examId && studentId && schoolId) {
      const html = await fetchReportCardHtml({ examId, studentId, schoolId, schoolName });
      if (html) return html;
    }
    // Fallback: local builder (offline / no identifiers passed down).
    return buildPdfHtml({ result, exam, schoolName, t, locale });
  };

  const handlePrint = useCallback(async () => {
    try {
      const html = await resolveHtml();
      await Print.printAsync({ html });
    } catch (err) {
      Alert.alert(t("reportCardDoc.printError"), err.message);
    }
  }, [result, exam, schoolName, examId, studentId, schoolId]);

  const handleShare = useCallback(async () => {
    try {
      const html          = await resolveHtml();
      const { uri }       = await Print.printToFileAsync({ html });
      const canShare      = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert(t("reportCardDoc.sharingUnavailable"));
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType:    "application/pdf",
        dialogTitle: t("reportCardDoc.shareTitle", {
          name: result.studentName || t("reportCardDoc.studentFallback"),
        }),
      });
    } catch (err) {
      Alert.alert(t("reportCardDoc.shareError"), err.message);
    }
  }, [result, exam, schoolName, examId, studentId, schoolId]);

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <View style={s.root}>

      {/* ── Export bar ───────────────────────────────────── */}
      {showExportBar && (
        <View style={s.exportBar}>
          <TouchableOpacity
            style={s.exportBtn}
            onPress={handlePrint}
            activeOpacity={0.7}
          >
            <Ionicons name="print-outline" size={16} color={C.primary} />
            <Text style={s.exportBtnText}>{t("reportCardDoc.print")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.exportBtn}
            onPress={handleShare}
            activeOpacity={0.7}
          >
            <Ionicons name="share-outline" size={16} color={C.primary} />
            <Text style={s.exportBtnText}>{t("reportCardDoc.sharePdf")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.container}
        showsVerticalScrollIndicator={false}
      >

        {/* ── School header ─────────────────────────────── */}
        <View style={s.schoolHeader}>
          <View style={s.schoolLogoBox}>
            <Ionicons name="school" size={28} color={C.primary} />
          </View>
          <View style={s.schoolInfo}>
            <Text style={s.schoolName} numberOfLines={1}>
              {schoolName || t("reportCardDoc.school")}
            </Text>
            <Text style={s.reportLabel}>{t("reportCardDoc.title")}</Text>
          </View>
        </View>

        {/* ── Exam banner ───────────────────────────────── */}
        <View style={s.examBanner}>
          <Text style={s.examBannerName} numberOfLines={1}>
            {exam?.name || t("reportCardDoc.examination")}
          </Text>
          <Text style={s.examBannerSub}>
            {[exam?.academicYear, exam?.term].filter(Boolean).join("  ·  ")}
          </Text>
        </View>

        {/* ── Student info ──────────────────────────────── */}
        <View style={s.card}>
          <SectionHeader
            icon="person-outline"
            title={t("reportCardDoc.studentInfo")}
          />
          <View style={s.studentInfoGrid}>
            <View style={s.studentInfoLeft}>
              <InfoRow
                label={t("reportCardDoc.labels.name")}
                value={result.studentName}
              />
              <InfoRow
                label={t("reportCardDoc.labels.admissionNo")}
                value={result.admissionNo
                  ? `#${result.admissionNo}` : null}
              />
              <InfoRow
                label={t("reportCardDoc.labels.class")}
                value={result.className}
              />
              <InfoRow
                label={t("reportCardDoc.labels.academicYear")}
                value={exam?.academicYear}
              />
              <InfoRow
                label={t("reportCardDoc.labels.term")}
                value={exam?.term}
              />
            </View>
            <View style={s.perfCircleWrap}>
              <CircleProgress percentage={percentage} size={90} />
              <View style={[
                s.passBadge,
                { backgroundColor: passColor + "15" },
              ]}>
                <Text style={[s.passText, { color: passColor }]}>
                  {isPassing
                    ? t("reportCardDoc.pass")
                    : t("reportCardDoc.fail")}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Performance summary ───────────────────────── */}
        <View style={s.card}>
          <SectionHeader
            icon="bar-chart-outline"
            title={t("reportCardDoc.performanceSummary")}
            color={C.purple}
          />

          <View style={s.summaryGrid}>
            <SummaryBox
              value={`${percentage.toFixed(1)}%`}
              label={t("reportCardDoc.summary.overall")}
              color={passColor}
            />
            <SummaryBox
              value={result.average?.toFixed(1) ?? "—"}
              label={t("reportCardDoc.summary.average")}
              color={C.primary}
            />
            <SummaryBox
              value={result.overallGrade || "—"}
              label={t("reportCardDoc.summary.grade")}
              color={C.purple}
            />
            {result.gpa != null && (
              <SummaryBox
                value={result.gpa.toFixed(2)}
                label={t("reportCardDoc.summary.gpa")}
                color={C.warning}
              />
            )}
          </View>

          <View style={s.scoreLine}>
            <ScorePill
              icon="checkmark-circle"
              color={C.success}
              label={t("reportCardDoc.passedCount", {
                count: result.subjectsPassed ?? 0,
              })}
            />
            <ScorePill
              icon="close-circle"
              color={C.error}
              label={t("reportCardDoc.failedCount", {
                count: result.subjectsFailed ?? 0,
              })}
            />
            <ScorePill
              icon="layers-outline"
              color={C.gray500}
              label={`${result.totalScore ?? "—"}/${result.maxTotalScore ?? "—"}`}
            />
          </View>
        </View>

        {/* ── Rankings ──────────────────────────────────── */}
        {showRankings && (
          <View style={s.card}>
            <SectionHeader
              icon="trophy-outline"
              title={t("reportCardDoc.rankings")}
              color={C.warning}
            />
            <View style={s.rankingsRow}>
              <RankBadge
                label={t("reportCardDoc.rank.class")}
                position={result.classPosition}
                total={result.totalInClass}
                color="#4F46E5"
              />
              <RankBadge
                label={t("reportCardDoc.rank.grade")}
                position={result.gradePosition}
                total={result.totalInGrade}
                color="#059669"
              />
              <RankBadge
                label={t("reportCardDoc.rank.school")}
                position={result.schoolPosition}
                total={result.totalInSchool}
                color="#D97706"
              />
            </View>
          </View>
        )}

        {/* ── Subject breakdown ─────────────────────────── */}
        {subjects.length > 0 && (
          <View style={s.card}>
            <SectionHeader
              icon="book-outline"
              title={t("reportCardDoc.subjectBreakdown")}
            />

            {/* Table header */}
            <View style={s.tableHeader}>
              <Text style={[s.thCell, { flex: 1 }]}>
                {t("reportCardDoc.table.subject")}
              </Text>
              <Text style={[s.thCell, { width: 52 }]}>
                {t("reportCardDoc.table.score")}
              </Text>
              <Text style={[s.thCell, { width: 44 }]}>
                {t("reportCardDoc.table.grade")}
              </Text>
              <Text style={[s.thCell, { width: 36 }]}>
                {t("reportCardDoc.table.pts")}
              </Text>
              <View style={{ width: 14 }} />
            </View>

            {subjects.map((sub, i) => (
              <SubjectRow
                key={`${sub.subjectName}-${i}`}
                subject={sub}
                index={i}
                maxScore={exam?.totalMarks}
              />
            ))}
          </View>
        )}

        {/* ── Teacher remark ────────────────────────────── */}
        {!!result.overallRemark && (
          <View style={s.card}>
            <SectionHeader
              icon="chatbubble-ellipses-outline"
              title={t("reportCardDoc.teacherRemark")}
              color={C.success}
            />
            <Text style={s.remarkText}>{result.overallRemark}</Text>
          </View>
        )}

        {/* ── Promotion status ──────────────────────────── */}
        {!!result.promotionStatus &&
         result.promotionStatus !== "pending" && (
          <View style={[
            s.promotionBanner,
            result.promotionStatus === "promoted"
              ? { backgroundColor: C.successBg,
                  borderColor:     C.success + "40" }
              : { backgroundColor: C.errorBg,
                  borderColor:     C.error + "40" },
          ]}>
            <Ionicons
              name={result.promotionStatus === "promoted"
                ? "arrow-up-circle"
                : "arrow-down-circle"}
              size={22}
              color={result.promotionStatus === "promoted"
                ? C.success : C.error}
            />
            <Text style={[
              s.promotionText,
              { color: result.promotionStatus === "promoted"
                  ? C.success : C.error },
            ]}>
              {result.promotionStatus === "promoted"
                ? t("reportCardDoc.promoted")
                : t("reportCardDoc.notPromoted")}
            </Text>
          </View>
        )}

        {/* ── Footer ───────────────────────────────────── */}
        <View style={s.footer}>
          <Text style={s.footerText}>
            {t("reportCardDoc.generatedOn", {
              date: new Date().toLocaleDateString(locale || "en-GB", {
                day: "numeric", month: "long", year: "numeric",
              }),
            })}
          </Text>
          <Text style={s.footerSub}>
            {t("reportCardDoc.officialReport", {
              school: schoolName || t("reportCardDoc.school"),
            })}
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// TINY HELPERS
// ─────────────────────────────────────────────────────────

const SummaryBox = ({ value, label, color }) => (
  <View style={[s.summaryItem, { backgroundColor: color + "12" }]}>
    <Text style={[s.summaryVal, { color }]}>{value}</Text>
    <Text style={s.summaryLbl}>{label}</Text>
  </View>
);

const ScorePill = ({ icon, color, label }) => (
  <View style={s.scoreLineItem}>
    <Ionicons name={icon} size={14} color={color} />
    <Text style={s.scoreLineText}>{label}</Text>
  </View>
);

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: C.gray50 },
  scroll:{ flex: 1 },
  container: { padding: 16 },

  // ── Export bar ───────────────────────────────────────────
  exportBar: {
    flexDirection:     "row",
    gap:               10,
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  exportBtn: {
    flex:              1,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               6,
    paddingVertical:   9,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       C.primary,
    backgroundColor:   C.primaryBg,
  },
  exportBtnText: {
    fontSize:   13,
    fontWeight: "700",
    color:      C.primary,
  },

  // ── School header ────────────────────────────────────────
  schoolHeader: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    gap:             14,
    borderWidth:     1,
    borderColor:     C.gray200,
  },
  schoolLogoBox: {
    width:           56, height: 56,
    borderRadius:    14,
    backgroundColor: C.primaryBg,
    alignItems:      "center",
    justifyContent:  "center",
  },
  schoolInfo:  { flex: 1 },
  schoolName: {
    fontSize:      16,
    fontWeight:    "800",
    color:         C.gray900,
    letterSpacing: 0.3,
  },
  reportLabel: {
    fontSize:      11,
    fontWeight:    "700",
    color:         C.primary,
    letterSpacing: 1.5,
    marginTop:     3,
  },

  // ── Exam banner ──────────────────────────────────────────
  examBanner: {
    backgroundColor:  C.primary,
    borderRadius:     12,
    paddingVertical:  12,
    paddingHorizontal:16,
    marginBottom:     12,
    alignItems:       "center",
  },
  examBannerName: {
    fontSize:   15,
    fontWeight: "700",
    color:      C.white,
  },
  examBannerSub: {
    fontSize:  12,
    color:     C.white + "CC",
    marginTop: 2,
  },

  // ── Card ─────────────────────────────────────────────────
  card: {
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     C.gray200,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },

  // ── Section header ───────────────────────────────────────
  sectionHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    marginBottom:      12,
    paddingBottom:     10,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  sectionIcon: {
    width:          28, height: 28,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize:   14,
    fontWeight: "700",
    color:      C.gray900,
  },

  // ── Student info ─────────────────────────────────────────
  studentInfoGrid: {
    flexDirection: "row",
    gap:           12,
    alignItems:    "flex-start",
  },
  studentInfoLeft: { flex: 1 },
  infoRow: {
    flexDirection:    "row",
    justifyContent:   "space-between",
    paddingVertical:  5,
    borderBottomWidth:1,
    borderBottomColor:C.gray50,
  },
  infoLabel: { fontSize: 12, color: C.gray500, fontWeight: "500" },
  infoValue: {
    fontSize:   12,
    color:      C.gray900,
    fontWeight: "600",
    textAlign:  "right",
    flex:       1,
    marginLeft: 8,
  },
  perfCircleWrap: { alignItems: "center", gap: 8 },
  passBadge: {
    borderRadius:      8,
    paddingHorizontal: 12,
    paddingVertical:   4,
  },
  passText: { fontSize: 12, fontWeight: "800", letterSpacing: 1 },

  // ── Summary ──────────────────────────────────────────────
  summaryGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           8,
    marginBottom:  12,
  },
  summaryItem: {
    flex:              1,
    minWidth:          "22%",
    alignItems:        "center",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 4,
  },
  summaryVal: { fontSize: 20, fontWeight: "800" },
  summaryLbl: {
    fontSize:   10,
    color:      C.gray500,
    marginTop:  2,
    fontWeight: "600",
  },

  // ── Score line ───────────────────────────────────────────
  scoreLine: {
    flexDirection:   "row",
    justifyContent:  "space-around",
    backgroundColor: C.gray50,
    borderRadius:    8,
    paddingVertical: 8,
  },
  scoreLineItem: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
  },
  scoreLineText: { fontSize: 12, color: C.gray600 },

  // ── Rankings ─────────────────────────────────────────────
  rankingsRow: { flexDirection: "row", gap: 8 },
  rankBadge: {
    flex:            1,
    alignItems:      "center",
    borderRadius:    10,
    borderWidth:     1,
    paddingVertical: 10,
  },
  rankPos:   { fontSize: 20, fontWeight: "800" },
  rankLabel: {
    fontSize:   10,
    color:      C.gray500,
    marginTop:  2,
    fontWeight: "600",
  },
  rankTotal: { fontSize: 10, color: C.gray400 },

  // ── Subject table ────────────────────────────────────────
  tableHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   6,
    paddingHorizontal: 8,
    backgroundColor:   C.gray100,
    borderRadius:      6,
    marginBottom:      4,
  },
  thCell: {
    fontSize:      10,
    fontWeight:    "700",
    color:         C.gray500,
    textTransform: "uppercase",
  },
  subjectRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    paddingHorizontal: 8,
    borderRadius:      6,
  },
  col_name:       { flex: 1, marginRight: 8 },
  subjectName:    { fontSize: 13, fontWeight: "600", color: C.gray900 },
  subjectTeacher: { fontSize: 10, color: C.gray400, marginTop: 1 },
  col_score: {
    width:         52,
    flexDirection: "row",
    alignItems:    "center",
  },
  subjectScore: { fontSize: 14, fontWeight: "700" },
  subjectNorm:  { fontSize: 10, color: C.gray400 },
  gradePill: {
    width:          44,
    alignItems:     "center",
    borderRadius:   6,
    paddingVertical:3,
  },
  gradeText:  { fontSize: 12, fontWeight: "700" },
  col_pts: {
    width:      36,
    fontSize:   12,
    fontWeight: "600",
    textAlign:  "center",
  },
  statusDot: {
    width: 8, height: 8, borderRadius: 4,
  },

  // ── Remark ───────────────────────────────────────────────
  remarkText: {
    fontSize:   13,
    color:      C.gray600,
    lineHeight: 22,
    fontStyle:  "italic",
  },

  // ── Promotion ────────────────────────────────────────────
  promotionBanner: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
    borderRadius:  12,
    padding:       14,
    marginBottom:  12,
    borderWidth:   1,
  },
  promotionText: {
    fontSize:   14,
    fontWeight: "700",
    flex:       1,
  },

  // ── Footer ───────────────────────────────────────────────
  footer: {
    alignItems:     "center",
    paddingTop:     16,
    borderTopWidth: 1,
    borderTopColor: C.gray200,
    gap:            4,
  },
  footerText: { fontSize: 11, color: C.gray400 },
  footerSub:  { fontSize: 10, color: C.gray300 },
});