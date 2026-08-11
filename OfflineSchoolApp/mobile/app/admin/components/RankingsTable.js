// app/admin/components/RankingsTable.js
"use strict";

import React, { useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  gold:      "#F59E0B",
  silver:    "#9CA3AF",
  bronze:    "#CD7F32",
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
  return COLORS.gray400;
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

export default function RankingsTable({
  rankings       = [],
  scope          = "class",
  onStudentPress,
  refreshing     = false,
  onRefresh,
}) {
  const [expandedId, setExpandedId] = useState(null);
  const positionField = getPositionField(scope);

  if (__DEV__ && rankings.length > 0) {
    console.log("[RankingsTable] scope:", scope);
    console.log("[RankingsTable] first item:", JSON.stringify(rankings[0], null, 2));
  }

  const tableTitle =
    scope === "school" ? "School Rankings"       :
    scope === "grade"  ? "Grade/Stream Rankings" :
                         "Class Rankings";

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
            { backgroundColor: medalColor + "20" },
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
              {item.studentName || item.name || "Unknown Student"}
            </Text>
            {subLabel ? (
              <Text style={styles.subLabel} numberOfLines={1}>{subLabel}</Text>
            ) : item.admissionNo ? (
              <Text style={styles.subLabel}>#{item.admissionNo}</Text>
            ) : null}
            <View style={styles.classTag}>
              <Ionicons name="school-outline" size={10} color={COLORS.primary} />
              <Text style={styles.classTagText} numberOfLines={1}>
                {resolvedClass ?? "No class"}
              </Text>
            </View>
          </View>

          {/* Score + grade */}
          <View style={styles.scoreSection}>
            <Text style={styles.averageScore}>
              {item.average != null
                ? `${item.average.toFixed(1)}%`
                : item.percentage != null
                ? `${item.percentage.toFixed(1)}%`
                : "—"}
            </Text>
            <View style={[
              styles.gradeBadge,
              { backgroundColor: item.isPassing ? "#D1FAE5" : "#FEE2E2" },
            ]}>
              <Text style={[
                styles.gradeText,
                item.isPassing ? styles.passingGrade : styles.failingGrade,
              ]}>
                {item.overallGrade || "—"}
              </Text>
            </View>
          </View>

          {/* GPA */}
          <View style={styles.gpaSection}>
            <Text style={styles.gpaValue}>
              {item.gpa != null ? item.gpa.toFixed(1) : "—"}
            </Text>
            <Text style={styles.gpaLabel}>GPA</Text>
          </View>

          <Ionicons
            name={isExpanded ? "chevron-up" : "chevron-down"}
            size={18}
            color={COLORS.gray400}
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
        <Text style={styles.tableTitle}>{tableTitle}</Text>
        <Text style={styles.tableCount}>{rankings.length} students</Text>
      </View>

      {rankings.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="trophy-outline" size={48} color={COLORS.gray200} />
          <Text style={styles.emptyText}>No rankings available</Text>
          <Text style={styles.emptySubtext}>
            Process results first to generate rankings
          </Text>
        </View>
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
  return (
    <View style={styles.expandedDetail}>
      <View style={styles.detailSummaryRow}>
        <DetailStat
          label="Total"
          value={`${item.totalScore ?? "—"}/${item.maxTotalScore ?? "—"}`}
        />
        <DetailStat
          label="Percentage"
          value={item.percentage != null
            ? `${item.percentage.toFixed(1)}%`
            : "—"}
        />
        <DetailStat
          label="Pass/Fail"
          value={`${item.subjectsPassed ?? 0}P / ${item.subjectsFailed ?? 0}F`}
          valueColor={item.isPassing ? COLORS.success : COLORS.error}
        />
        <DetailStat label="Class" value={resolvedClass || "—"} />
      </View>

      <View style={styles.rankingsRow}>
        <RankBadge
          label="Class"
          position={item.classPosition}
          total={item.totalInClass}
          color="#4F46E5"
        />
        <RankBadge
          label="Grade"
          position={item.gradePosition}
          total={item.totalInGrade}
          color="#059669"
        />
        <RankBadge
          label="School"
          position={item.schoolPosition}
          total={item.totalInSchool}
          color="#D97706"
        />
      </View>

      {item.subjectBreakdown?.length > 0 && (
        <View style={styles.subjectBreakdown}>
          <Text style={styles.breakdownTitle}>Subject Breakdown</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={styles.breakdownHeader}>
                <Text style={[styles.breakdownCell, styles.colSubject]}>Subject</Text>
                <Text style={[styles.breakdownCell, styles.colScore]}>Score</Text>
                <Text style={[styles.breakdownCell, styles.colScore]}>/20</Text>
                <Text style={[styles.breakdownCell, styles.colGrade]}>Grade</Text>
                <Text style={[styles.breakdownCell, styles.colGrade]}>Pts</Text>
                <Text style={[styles.breakdownCell, styles.colStatus]}>Status</Text>
              </View>

              {item.subjectBreakdown.map((s, si) => (
                <View
                  key={si}
                  style={[
                    styles.breakdownRow,
                    si % 2 === 0 && { backgroundColor: COLORS.gray50 },
                  ]}
                >
                  <Text
                    style={[styles.breakdownCell, styles.colSubject]}
                    numberOfLines={1}
                  >
                    {s.subjectName || `Subject ${si + 1}`}
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
                    s.isAbsent  ? { color: COLORS.gray400 } :
                    s.isPassing ? { color: COLORS.success  } :
                                  { color: COLORS.error    },
                  ]}>
                    {s.isAbsent ? "AB" : s.grade || "—"}
                  </Text>
                  <Text style={[styles.breakdownCell, styles.colGrade]}>
                    {s.isAbsent ? "—" : s.points?.toFixed(1) ?? "—"}
                  </Text>
                  <View style={[styles.breakdownCell, styles.colStatus]}>
                    <View style={[
                      styles.statusPill,
                      {
                        backgroundColor:
                          s.isAbsent  ? COLORS.gray100 :
                          s.isPassing ? "#D1FAE5"      : "#FEE2E2",
                      },
                    ]}>
                      <Text style={[
                        styles.statusPillText,
                        {
                          color:
                            s.isAbsent  ? COLORS.gray500 :
                            s.isPassing ? COLORS.success  : COLORS.error,
                        },
                      ]}>
                        {s.isAbsent ? "Absent" : s.isPassing ? "Pass" : "Fail"}
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
          <Ionicons name="chatbubble-ellipses-outline" size={14} color={COLORS.gray400} />
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

function RankBadge({ label, position, total, color }) {
  const hasData = position != null && total != null;
  return (
    <View style={[
      styles.rankBadge,
      { borderColor: color + "40", backgroundColor: color + "08" },
    ]}>
      <Text style={[styles.rankBadgePosition, { color }]}>
        {hasData ? `#${position}` : "—"}
      </Text>
      <Text style={styles.rankBadgeLabel}>{label}</Text>
      {hasData && (
        <Text style={styles.rankBadgeTotal}>of {total}</Text>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.white,
    borderRadius:    16,
    padding:         16,
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
  tableTitle: { fontSize: 16, fontWeight: "700", color: COLORS.gray900 },
  tableCount: { fontSize: 13, color: COLORS.gray500 },
  rowWrapper: { marginBottom: 4 },
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   12,
    paddingHorizontal: 8,
    borderRadius:      10,
    backgroundColor:   COLORS.white,
  },
  topRow:     { backgroundColor: COLORS.gray50 },
  partialRow: { borderLeftWidth: 3, borderLeftColor: "#D97706" },
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
  studentName:  { fontSize: 14, fontWeight: "600", color: COLORS.gray900 },
  subLabel:     { fontSize: 11, color: COLORS.gray500, marginTop: 2 },
  classTag: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    marginTop:         4,
    backgroundColor:   COLORS.primaryBg,
    alignSelf:         "flex-start",
    borderRadius:      4,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  classTagText: {
    fontSize:   10,
    fontWeight: "600",
    color:      COLORS.primary,
    maxWidth:   110,
  },
  scoreSection:  { alignItems: "center", marginRight: 12 },
  averageScore:  { fontSize: 15, fontWeight: "700", color: COLORS.gray900 },
  gradeBadge: {
    paddingHorizontal: 6,
    paddingVertical:   2,
    borderRadius:      4,
    marginTop:         2,
  },
  gradeText:    { fontSize: 11, fontWeight: "700" },
  passingGrade: { color: COLORS.success },
  failingGrade: { color: COLORS.error   },
  gpaSection:   { alignItems: "center", marginRight: 10, minWidth: 36 },
  gpaValue:     { fontSize: 14, fontWeight: "700", color: COLORS.primary },
  gpaLabel:     { fontSize: 10, color: COLORS.gray400 },
  expandedDetail: {
    backgroundColor:         COLORS.gray50,
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
    borderBottomColor: COLORS.gray200,
  },
  detailStat:      { alignItems: "center", flex: 1 },
  detailStatValue: {
    fontSize:   13,
    fontWeight: "700",
    color:      COLORS.gray900,
    textAlign:  "center",
  },
  detailStatLabel: { fontSize: 10, color: COLORS.gray500, marginTop: 2 },
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
  rankBadgeLabel:    { fontSize: 10, color: COLORS.gray500, marginTop: 2 },
  rankBadgeTotal:    { fontSize: 10, color: COLORS.gray400 },
  subjectBreakdown:  { marginBottom: 8 },
  breakdownTitle: {
    fontSize:     13,
    fontWeight:   "600",
    color:        COLORS.gray700,
    marginBottom: 8,
  },
  breakdownHeader: {
    flexDirection:     "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray200,
    paddingBottom:     6,
    marginBottom:      2,
    backgroundColor:   COLORS.gray100,
    borderRadius:      4,
    paddingHorizontal: 4,
  },
  breakdownRow: {
    flexDirection:     "row",
    paddingVertical:   4,
    paddingHorizontal: 4,
    borderRadius:      4,
  },
  breakdownCell: { fontSize: 12, color: COLORS.gray700, paddingHorizontal: 4 },
  colSubject:    { width: 120 },
  colScore:      { width: 50  },
  colGrade:      { width: 44  },
  colStatus:     { width: 64  },
  statusPill: {
    borderRadius:      4,
    paddingHorizontal: 6,
    paddingVertical:   2,
    alignSelf:         "flex-start",
  },
  statusPillText: { fontSize: 10, fontWeight: "700" },
  remarkBox: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: COLORS.white,
    borderRadius:    8,
    padding:         10,
    marginTop:       8,
  },
  remarkText: {
    fontSize:   12,
    color:      COLORS.gray600,
    marginLeft: 8,
    flex:       1,
    lineHeight: 18,
    fontStyle:  "italic",
  },
  emptyState:   { alignItems: "center", paddingVertical: 40 },
  emptyText:    { fontSize: 15, fontWeight: "600", color: COLORS.gray500, marginTop: 12 },
  emptySubtext: { fontSize: 13, color: COLORS.gray400, marginTop: 4 },
});