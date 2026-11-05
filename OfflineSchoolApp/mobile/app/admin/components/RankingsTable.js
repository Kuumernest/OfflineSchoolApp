// app/admin/components/RankingsTable.js
"use strict";

import React, { useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../../src/i18n/useTranslation";
import { COLORS as THEME, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";
import { IconSquare, Badge, EmptyState } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  // The medals, in theme colours: gold amber, silver slate, bronze deep amber.
  gold:      ACCENT.amber.base,
  silver:    ACCENT.slate.solid,
  bronze:    ACCENT.amber.deep,
  success:   "#059669",
  error:     "#DC2626",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function getMedalColor(position) {
  if (position === 1) return COLORS.gold;
  if (position === 2) return COLORS.silver;
  if (position === 3) return COLORS.bronze;
  return ACCENT.slate.deep;
}

/** A position square's fill: white for a medal (its row is amber), the rest slate. */
function getMedalBg(position) {
  if (position >= 1 && position <= 3) return THEME.surface;
  return ACCENT.slate.wash;
}

function getPositionField(scope) {
  if (scope === "school") return "schoolPosition";
  if (scope === "grade")  return "gradePosition";
  return "classPosition";
}

function resolveClassName(item) {
  if (!item) return null;
  if (typeof item.className === "string" && item.className.trim())
    return item.className.trim();
  if (typeof item.class === "string" && item.class.trim())
    return item.class.trim();
  if (typeof item.stream === "string" && item.stream.trim())
    return item.stream.trim();
  if (item.className && typeof item.className === "object")
    return item.className.name || item.className.className || null;
  if (item.class && typeof item.class === "object")
    return item.class.name || item.class.className || null;
  if (item.classInfo) {
    if (typeof item.classInfo === "string") return item.classInfo;
    return item.classInfo.name || item.classInfo.className || null;
  }
  if (item.student) {
    const st = item.student;
    if (typeof st.className === "string" && st.className.trim()) return st.className.trim();
    if (st.className && typeof st.className === "object") return st.className.name || null;
    if (typeof st.class === "string" && st.class.trim()) return st.class.trim();
    if (st.class && typeof st.class === "object") return st.class.name || null;
  }
  if (typeof item.grade === "string" && item.grade.trim()) return item.grade.trim();
  if (typeof item.level === "string" && item.level.trim()) return item.level.trim();
  return null;
}

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

/** The school's remark for the pupil's average, in the reader's language. */
const remarkIn = (item, language) =>
  (String(language || "").startsWith("fr") ? item.remarkFr : item.remark) ?? item.remark ?? null;

export default function RankingsTable({
  rankings       = [],
  scope          = "class",
  onStudentPress,
  refreshing     = false,
  onRefresh,
}) {
  const { t, language } = useTranslation();
  const [expandedId, setExpandedId] = useState(null);
  const positionField = getPositionField(scope);

  if (__DEV__ && rankings.length > 0) {
    console.log("[RankingsTable] scope:", scope);
    console.log("[RankingsTable] first item:", JSON.stringify(rankings[0], null, 2));
  }

  const tableTitle =
    scope === "school" ? t("examResults.schoolRankings") :
    scope === "grade"  ? t("rankTable.titleGrade")       :
                         t("examResults.classRankings");

  const renderItem = ({ item, index }) => {
    const position      = item[positionField] ?? index + 1;
    const isExpanded    = expandedId === (item._id || item.studentId);
    const medalColor    = getMedalColor(position);
    const resolvedClass = resolveClassName(item);

    const subParts = [];
    if (item.admissionNo)                   subParts.push(`#${item.admissionNo}`);
    if (scope !== "class" && resolvedClass) subParts.push(resolvedClass);
    const subLabel = subParts.join("  •  ") || null;

    const rowKey = item._id || item.studentId || String(index);

    return (
      <View style={styles.rowWrapper}>
        <TouchableOpacity
          style={[
            styles.row,
            position <= 3  && styles.topRow,
            item.isPartial && styles.partialRow,
          ]}
          onPress={() => {
            setExpandedId(isExpanded ? null : rowKey);
            onStudentPress?.(item);
          }}
          activeOpacity={0.7}
        >
          {/* Position badge */}
          <View style={[
            styles.positionBadge,
            { backgroundColor: getMedalBg(position) },
          ]}>
            {position <= 3 ? (
              <Ionicons name="medal" size={16} color={medalColor} />
            ) : (
              <Text style={[styles.positionText, { color: medalColor }]}>
                {position}
              </Text>
            )}
          </View>

          {/* Student info */}
          <View style={styles.studentInfo}>
            <Text style={styles.studentName} numberOfLines={1}>
              {item.studentName || item.name || t("examDetail.unknownStudent")}
            </Text>
            {subLabel ? (
              <Text style={styles.subLabel} numberOfLines={1}>{subLabel}</Text>
            ) : item.admissionNo ? (
              <Text style={styles.subLabel}>#{item.admissionNo}</Text>
            ) : null}
            <View style={styles.classTag}>
              <Ionicons name="school-outline" size={10} color={accentBadge("indigo").text} />
              <Text style={styles.classTagText} numberOfLines={1}>
                {resolvedClass ?? t("rankTable.noClass")}
              </Text>
            </View>
          </View>

          {/* Average /20 and the school's remark — no percentage, letter or
              GPA. The server reads the average on /20 and judges it against
              the school's pass mark (shared/examAnalytics, shared/passRate). */}
          <View style={styles.scoreSection}>
            <Text style={styles.averageScore}>
              {item.average20 != null ? `${item.average20.toFixed(2)}/20` : "—"}
            </Text>
            <View style={[
              styles.gradeBadge,
              {
                backgroundColor: statusBadge((item.passes ?? item.isPassing) ? "success" : "error").bg,
                borderColor:     statusBadge((item.passes ?? item.isPassing) ? "success" : "error").border,
              },
            ]}>
              <Text style={[
                styles.gradeText,
                (item.passes ?? item.isPassing) ? styles.passingGrade : styles.failingGrade,
              ]} numberOfLines={1}>
                {remarkIn(item, language) || "—"}
              </Text>
            </View>
          </View>

          <Ionicons
            name={isExpanded ? "chevron-up" : "chevron-down"}
            size={18}
            color={THEME.textSecondary}
          />
        </TouchableOpacity>

        {isExpanded && (
          <ExpandedDetail item={item} resolvedClass={resolvedClass} />
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.tableHeader}>
        <View style={styles.tableTitleRow}>
          <IconSquare icon="trophy" accent="slate" size={28} />
          <Text style={styles.tableTitle}>{tableTitle}</Text>
        </View>
        <Badge
          label={t("rankTable.studentCount", { count: rankings.length })}
          accent="slate"
          style={styles.tableCount}
        />
      </View>

      {rankings.length === 0 ? (
        <EmptyState
          icon="trophy-outline"
          accent="slate"
          title={t("results.noRankings")}
          message={t("results.processFirst")}
          style={styles.emptyState}
        />
      ) : (
        <FlatList
          data={rankings}
          keyExtractor={(item, index) =>
            item._id || item.studentId || String(index)
          }
          renderItem={renderItem}
          scrollEnabled={false}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// EXPANDED DETAIL
// ─────────────────────────────────────────────────────────

function ExpandedDetail({ item, resolvedClass }) {
  const { t } = useTranslation();

  return (
    <View style={styles.expandedDetail}>
      <View style={styles.detailSummaryRow}>
        <DetailStat
          label={t("common.total")}
          value={`${item.totalScore ?? "—"}/${item.maxTotalScore ?? "—"}`}
        />
        <DetailStat
          label={t("rankTable.average20")}
          value={item.average20 != null ? `${item.average20.toFixed(2)}/20` : "—"}
        />
        <DetailStat
          label={t("rankTable.passFail")}
          value={`${item.subjectsPassed ?? 0}P / ${item.subjectsFailed ?? 0}F`}
          valueColor={item.isPassing ? SEMANTIC.success.text : SEMANTIC.error.text}
        />
        <DetailStat
          label={t("examDetail.classFallback")}
          value={resolvedClass || "—"}
        />
      </View>

      <View style={styles.rankingsRow}>
        <RankBadge
          label={t("examResults.tabs.class")}
          position={item.classPosition}
          total={item.totalInClass}
          accent="indigo"
        />
        <RankBadge
          label={t("examResults.tabs.grade")}
          position={item.gradePosition}
          total={item.totalInGrade}
          accent="green"
        />
        <RankBadge
          label={t("examResults.tabs.school")}
          position={item.schoolPosition}
          total={item.totalInSchool}
          accent="amber"
        />
      </View>

      {item.subjectBreakdown?.length > 0 && (
        <View style={styles.subjectBreakdown}>
          <Text style={styles.breakdownTitle}>{t("rankTable.breakdown")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={styles.breakdownHeader}>
                <Text style={[styles.breakdownCell, styles.colSubject]}>
                  {t("rankTable.colSubject")}
                </Text>
                <Text style={[styles.breakdownCell, styles.colScore]}>
                  {t("rankTable.colScore")}
                </Text>
                <Text style={[styles.breakdownCell, styles.colScore]}>/20</Text>
                <Text style={[styles.breakdownCell, styles.colGrade]}>
                  {t("rankTable.colGrade")}
                </Text>
                <Text style={[styles.breakdownCell, styles.colGrade]}>
                  {t("rankTable.colPts")}
                </Text>
                <Text style={[styles.breakdownCell, styles.colStatus]}>
                  {t("common.status")}
                </Text>
              </View>

              {item.subjectBreakdown.map((s, si) => (
                <View
                  key={si}
                  style={[
                    styles.breakdownRow,
                    si % 2 === 0 && { backgroundColor: THEME.surface },
                  ]}
                >
                  <Text
                    style={[styles.breakdownCell, styles.colSubject]}
                    numberOfLines={1}
                  >
                    {s.subjectName || `${t("teacherExamSubjects.subjectFallback")} ${si + 1}`}
                  </Text>
                  <Text style={[styles.breakdownCell, styles.colScore]}>
                    {s.isAbsent ? "—" : s.score ?? "—"}
                  </Text>
                  <Text style={[styles.breakdownCell, styles.colScore]}>
                    {s.isAbsent ? "—" : s.normalizedMark?.toFixed(1) ?? "—"}
                  </Text>
                  <Text style={[
                    styles.breakdownCell,
                    styles.colGrade,
                    { fontWeight: "700" },
                    s.isAbsent  ? { color: THEME.textSecondary   } :
                    s.isPassing ? { color: SEMANTIC.success.text } :
                                  { color: SEMANTIC.error.text   },
                  ]}>
                    {s.isAbsent ? t("rankTable.abShort") : s.grade || "—"}
                  </Text>
                  <Text style={[styles.breakdownCell, styles.colGrade]}>
                    {s.isAbsent ? "—" : s.points?.toFixed(1) ?? "—"}
                  </Text>
                  <View style={[styles.breakdownCell, styles.colStatus]}>
                    <View style={[
                      styles.statusPill,
                      {
                        backgroundColor:
                          statusBadge(s.isPassing && !s.isAbsent ? "success" : "error").bg,
                        borderColor:
                          statusBadge(s.isPassing && !s.isAbsent ? "success" : "error").border,
                      },
                    ]}>
                      <Text style={[
                        styles.statusPillText,
                        {
                          color:
                            statusBadge(s.isPassing && !s.isAbsent ? "success" : "error").text,
                        },
                      ]}>
                        {s.isAbsent
                          ? t("rankTable.absent")
                          : s.isPassing
                          ? t("examDetail.resultPass")
                          : t("examDetail.resultFail")}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {!!item.overallRemark && (
        <View style={styles.remarkBox}>
          <Ionicons name="chatbubble-ellipses-outline" size={14} color={ACCENT.slate.solid} />
          <Text style={styles.remarkText}>{item.overallRemark}</Text>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────

function DetailStat({ label, value, valueColor }) {
  return (
    <View style={styles.detailStat}>
      <Text
        style={[styles.detailStatValue, valueColor && { color: valueColor }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.detailStatLabel}>{label}</Text>
    </View>
  );
}

function RankBadge({ label, position, total, accent }) {
  const { t } = useTranslation();
  const hasData = position != null && total != null;
  const a = ACCENT[accent] ?? ACCENT.slate;
  return (
    <View style={[
      styles.rankBadge,
      { borderColor: a.base + "40", backgroundColor: a.wash },
    ]}>
      <Text style={[styles.rankBadgePosition, { color: a.deep }]}>
        {hasData ? `#${position}` : "—"}
      </Text>
      <Text style={styles.rankBadgeLabel}>{label}</Text>
      {hasData && (
        <Text style={styles.rankBadgeTotal}>
          {t("rankTable.ofTotal", { total })}
        </Text>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: THEME.surface,
    borderRadius:    16,
    padding:         16,
    borderWidth:     1,
    borderColor:     THEME.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.slate.base,
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.05,
    shadowRadius:    6,
    elevation:       2,
  },
  tableHeader: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   12,
  },
  tableTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  tableTitle: { fontSize: 16, fontWeight: "700", color: THEME.text, flexShrink: 1 },
  tableCount: { alignSelf: "center" },
  rowWrapper: { marginBottom: 4 },
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   12,
    paddingHorizontal: 8,
    borderRadius:      10,
    backgroundColor:   THEME.surface,
  },
  topRow:     { backgroundColor: ACCENT.amber.wash },
  partialRow: { borderLeftWidth: 3, borderLeftColor: ACCENT.amber.base },
  positionBadge: {
    width:          32,
    height:         32,
    borderRadius:   8,
    justifyContent: "center",
    alignItems:     "center",
    marginRight:    10,
  },
  positionText: { fontSize: 14, fontWeight: "800" },
  studentInfo:  { flex: 1, marginRight: 8 },
  studentName:  { fontSize: 14, fontWeight: "600", color: THEME.text },
  subLabel:     { fontSize: 11, color: THEME.textSecondary, marginTop: 2 },
  classTag: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    marginTop:         4,
    backgroundColor:   accentBadge("indigo").bg,
    borderWidth:       1,
    borderColor:       accentBadge("indigo").border,
    alignSelf:         "flex-start",
    borderRadius:      4,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  classTagText: {
    fontSize:   10,
    fontWeight: "600",
    color:      accentBadge("indigo").text,
    maxWidth:   110,
  },
  scoreSection:  { alignItems: "center", marginRight: 12 },
  averageScore:  { fontSize: 15, fontWeight: "700", color: ACCENT.slate.deep },
  gradeBadge: {
    borderWidth:       1,
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      4,
    marginTop:         2,
  },
  gradeText:    { fontSize: 11, fontWeight: "700" },
  passingGrade: { color: SEMANTIC.success.text },
  failingGrade: { color: SEMANTIC.error.text   },
  gpaSection:   { alignItems: "center", marginRight: 10, minWidth: 36 },
  gpaValue:     { fontSize: 14, fontWeight: "700", color: COLORS.primary },
  gpaLabel:     { fontSize: 10, color: COLORS.gray400 },
  expandedDetail: {
    backgroundColor:         ACCENT.slate.wash,
    borderBottomLeftRadius:  10,
    borderBottomRightRadius: 10,
    padding:                 12,
    marginTop:               -4,
  },
  detailSummaryRow: {
    flexDirection:     "row",
    justifyContent:    "space-around",
    marginBottom:      12,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  detailStat:      { alignItems: "center", flex: 1 },
  detailStatValue: {
    fontSize:   13,
    fontWeight: "700",
    color:      ACCENT.slate.deep,
    textAlign:  "center",
  },
  detailStatLabel: { fontSize: 10, color: THEME.textSecondary, marginTop: 2 },
  rankingsRow: {
    flexDirection:  "row",
    justifyContent: "space-around",
    marginBottom:   12,
    gap:            8,
  },
  rankBadge: {
    flex:              1,
    alignItems:        "center",
    borderRadius:      8,
    borderWidth:       1,
    paddingVertical:   8,
    paddingHorizontal: 4,
  },
  rankBadgePosition: { fontSize: 18, fontWeight: "800" },
  rankBadgeLabel:    { fontSize: 10, color: THEME.textSecondary, marginTop: 2 },
  rankBadgeTotal:    { fontSize: 10, color: THEME.textSecondary },
  subjectBreakdown:  { marginBottom: 8 },
  breakdownTitle: {
    fontSize:     13,
    fontWeight:   "600",
    color:        THEME.text,
    marginBottom: 8,
  },
  breakdownHeader: {
    flexDirection:     "row",
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
    paddingBottom:     6,
    marginBottom:      2,
    backgroundColor:   THEME.surface,
    borderRadius:      4,
    paddingHorizontal: 4,
  },
  breakdownRow: {
    flexDirection:     "row",
    paddingVertical:   4,
    paddingHorizontal: 4,
    borderRadius:      4,
  },
  breakdownCell: { fontSize: 12, color: THEME.text, paddingHorizontal: 4 },
  colSubject:    { width: 120 },
  colScore:      { width: 50  },
  colGrade:      { width: 44  },
  colStatus:     { width: 64  },
  statusPill: {
    borderWidth:       1,
    borderRadius:      4,
    paddingHorizontal: 6,
    paddingVertical:   2,
    alignSelf:         "flex-start",
  },
  statusPillText: { fontSize: 10, fontWeight: "700" },
  remarkBox: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: THEME.surface,
    borderRadius:    8,
    padding:         10,
    marginTop:       8,
  },
  remarkText: {
    fontSize:   12,
    color:      THEME.textSecondary,
    marginLeft: 8,
    flex:       1,
    lineHeight: 18,
    fontStyle:  "italic",
  },
  emptyState:   { alignItems: "center", paddingVertical: 40 },
});