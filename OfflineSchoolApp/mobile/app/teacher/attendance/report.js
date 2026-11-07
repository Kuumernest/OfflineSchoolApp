// app/teacher/attendance/report.js

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  TextInput,
  ScrollView,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }          from "@expo/vector-icons";
import { useAuthStore }      from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";
import { COLORS as THEME, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const todayStr   = () => new Date().toISOString().slice(0, 10);
const monthStart = (offset = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() - offset, 1);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (offset = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() - offset + 1, 0);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** A rate's tone: 80%+ success, 60%+ warning, below that error. */
const rateTone = (rate) => {
  if (rate >= 80) return SEMANTIC.success;
  if (rate >= 60) return SEMANTIC.warning;
  return SEMANTIC.error;
};
const rateColor = (rate) => rateTone(rate).text;

const DATE_PRESETS = [
  { labelKey: "attTeacher.rangeToday",      start: todayStr(),    end: todayStr()    },
  { labelKey: "attTeacher.rangeThisMonth", start: monthStart(0), end: monthEnd(0)   },
  { labelKey: "attTeacher.rangeLastMonth", start: monthStart(1), end: monthEnd(1)   },
  { labelKey: "attTeacher.rangeLast3",  start: monthStart(2), end: monthEnd(0)   },
];

// ─────────────────────────────────────────────────────────────
// DATA — build per-student summaries from flat records array
// ─────────────────────────────────────────────────────────────

const buildStudentSummaries = (records, t) => {
  const byStudent = {};

  for (const r of records) {
    const id =
      r.studentId  ||
      r.student_id ||
      (typeof r.student === "string" ? r.student : null) ||
      r.student?._id ||
      null;

    if (!id) continue;

    if (!byStudent[id]) {
      byStudent[id] = {
        studentId:    id,
        studentName:  r.studentName  || r.student_name || r.student?.studentName || r.student?.name || t("attTeacher.unknownStudent"),
        studentEmail: r.studentEmail || r.email        || "",
        admissionNo:  r.admissionNo  || null,
        records:      [],
        summary: { present: 0, absent: 0, late: 0, excused: 0, total: 0 },
      };
    }

    byStudent[id].records.push({
      date:   r.date,
      status: r.status,
      note:   r.note || null,
    });

    const key = r.status || "present";
    if (key in byStudent[id].summary) byStudent[id].summary[key]++;
    byStudent[id].summary.total++;
  }

  return Object.values(byStudent).map((s) => ({
    ...s,
    rate: s.summary.total > 0
      ? Math.round((s.summary.present / s.summary.total) * 100)
      : 0,
  }));
};

// ─────────────────────────────────────────────────────────────
// STAT CHIP
// ─────────────────────────────────────────────────────────────

const StatChip = ({ label, value, accent }) => (
  <View style={[chipS.chip, { backgroundColor: accent.wash }]}>
    <Text style={[chipS.val, { color: accent.deep }]}>{value}</Text>
    <Text style={chipS.lbl}>{label}</Text>
  </View>
);

const chipS = StyleSheet.create({
  chip: { flex: 1, borderRadius: 10, padding: 8, alignItems: "center", gap: 2 },
  val:  { fontSize: 14, fontWeight: "800" },
  lbl:  { fontSize: 9, color: THEME.textSecondary, fontWeight: "600", textTransform: "uppercase" },
});

// ─────────────────────────────────────────────────────────────
// SUMMARY BAR
// ─────────────────────────────────────────────────────────────

const SummaryBar = ({ students }) => {
  const { t } = useTranslation();
  const totals = useMemo(() => {
    const t = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    for (const s of students) {
      t.present += s.summary?.present ?? 0;
      t.absent  += s.summary?.absent  ?? 0;
      t.late    += s.summary?.late    ?? 0;
      t.excused += s.summary?.excused ?? 0;
      t.total   += s.summary?.total   ?? 0;
    }
    t.rate = t.total > 0 ? Math.round((t.present / t.total) * 100) : 0;
    return t;
  }, [students]);

  const color = rateColor(totals.rate);

  return (
    <View style={summaryS.card}>
      <View style={summaryS.header}>
        <Text style={summaryS.title}>
          {t("academic.studentCount", { count: students.length })}
        </Text>
        <View style={[summaryS.badge, { backgroundColor: rateTone(totals.rate).bg, borderColor: rateTone(totals.rate).icon + "4D" }]}>
          <Text style={[summaryS.badgeText, { color }]}>
            {totals.rate}% overall
          </Text>
        </View>
      </View>

      <View style={summaryS.pills}>
        {/*
          * labelKey, not label. These carried `label:` already translated and
          * were then rendered with t(p.labelKey) — t(undefined), which i18n-js
          * prints as [missing "en." translation]. Five of those across the top
          * of the attendance report, and key={p.labelKey} made every React key
          * undefined besides.
          */}
        {[
          { labelKey: "attStatus.present", val: totals.present, bg: SEMANTIC.success.bg, color: SEMANTIC.success.text },
          { labelKey: "attStatus.absent",  val: totals.absent,  bg: SEMANTIC.error.bg,   color: SEMANTIC.error.text },
          { labelKey: "attStatus.late",    val: totals.late,    bg: SEMANTIC.warning.bg, color: SEMANTIC.warning.text },
          { labelKey: "attStatus.excused", val: totals.excused, bg: SEMANTIC.info.bg,    color: SEMANTIC.info.text },
          { labelKey: "common.total",      val: totals.total,   bg: ACCENT.slate.wash,   color: ACCENT.slate.deep },
        ].map((p) => (
          <View
            key={p.labelKey}
            style={[summaryS.pill, { backgroundColor: p.bg }]}
          >
            <Text style={[summaryS.pillVal, { color: p.color }]}>{p.val}</Text>
            <Text style={summaryS.pillLbl}>{t(p.labelKey)}</Text>
          </View>
        ))}
      </View>

      <View style={summaryS.barBg}>
        <View
          style={[
            summaryS.barFill,
            { width: `${Math.min(totals.rate, 100)}%`, backgroundColor: rateTone(totals.rate).icon },
          ]}
        />
      </View>
    </View>
  );
};

const summaryS = StyleSheet.create({
  card: {
    backgroundColor: ACCENT.green.wash,
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     THEME.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.green.base,
    shadowColor:     THEME.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  header: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   12,
  },
  title:     { fontSize: 15, fontWeight: "700", color: THEME.text },
  badge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  badgeText: { fontSize: 13, fontWeight: "700" },
  pills:     { flexDirection: "row", gap: 6, marginBottom: 10 },
  pill:      { flex: 1, borderRadius: 10, padding: 8, alignItems: "center", gap: 2 },
  pillVal:   { fontSize: 15, fontWeight: "800" },
  pillLbl:   { fontSize: 9, color: THEME.textSecondary, fontWeight: "600", textTransform: "uppercase" },
  barBg: {
    height:          6,
    backgroundColor: THEME.border,
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

// ─────────────────────────────────────────────────────────────
// STUDENT CARD
// ─────────────────────────────────────────────────────────────

const StudentCard = React.memo(({ student, isExpanded, onPress }) => {
  const { t } = useTranslation();
  const { summary, rate } = student;
  const color = rateColor(rate);

  return (
    <TouchableOpacity
      style={[cardS.card, isExpanded && cardS.cardExpanded]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={cardS.top}>
        <View style={cardS.avatar}>
          <Text style={cardS.avatarText}>
            {(student.studentName || "?").charAt(0).toUpperCase()}
          </Text>
        </View>

        <View style={cardS.info}>
          <Text style={cardS.name} numberOfLines={1}>
            {student.studentName}
          </Text>
          <Text style={cardS.sub} numberOfLines={1}>
            {student.admissionNo
              ? `#${student.admissionNo}`
              : student.studentEmail || ""}
          </Text>
        </View>

        <View style={[cardS.rateBadge, { backgroundColor: rateTone(rate).bg, borderColor: rateTone(rate).icon + "4D" }]}>
          <Text style={[cardS.rateNum, { color }]}>{rate}%</Text>
          <Text style={[cardS.rateLbl, { color }]}>rate</Text>
        </View>

        <Ionicons
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={THEME.textSecondary}
          style={{ marginLeft: 4 }}
        />
      </View>

      <View style={cardS.stats}>
        <StatChip label={t("attStatus.present")} value={summary?.present ?? 0} accent={ACCENT.green} />
        <StatChip label={t("attStatus.absent")}  value={summary?.absent  ?? 0} accent={ACCENT.red} />
        <StatChip label={t("attStatus.late")}    value={summary?.late    ?? 0} accent={ACCENT.amber} />
        <StatChip label={t("attStatus.excused")} value={summary?.excused ?? 0} accent={ACCENT.indigo} />
        <StatChip label={t("common.total")}   value={summary?.total   ?? 0} accent={ACCENT.slate} />
      </View>

      <View style={cardS.barBg}>
        <View
          style={[
            cardS.barFill,
            { width: `${Math.min(rate, 100)}%`, backgroundColor: rateTone(rate).icon },
          ]}
        />
      </View>
    </TouchableOpacity>
  );
});

const cardS = StyleSheet.create({
  // A pupil's row: students are blue, a left edge on their wash.
  card: {
    backgroundColor: ACCENT.blue.wash,
    borderRadius:    16,
    padding:         16,
    marginBottom:    4,
    borderWidth:     1,
    borderColor:     THEME.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.blue.base,
    shadowColor:     THEME.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardExpanded: {
    borderBottomLeftRadius:  0,
    borderBottomRightRadius: 0,
    borderBottomColor:       "transparent",
  },
  top:        { flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 10 },
  avatar: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: ACCENT.blue.solid,
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText: { fontSize: 18, fontWeight: "800", color: THEME.onPrimary },
  info:       { flex: 1 },
  name:       { fontSize: 15, fontWeight: "700", color: THEME.text },
  sub:        { fontSize: 12, color: THEME.textSecondary, marginTop: 2 },
  rateBadge:  { alignItems: "center", borderRadius: 10, padding: 8, minWidth: 50, borderWidth: 1 },
  rateNum:    { fontSize: 18, fontWeight: "800" },
  rateLbl:    { fontSize: 9, fontWeight: "600", textTransform: "uppercase" },
  stats:      { flexDirection: "row", gap: 6, marginBottom: 10 },
  barBg: {
    height:          6,
    backgroundColor: THEME.border,
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

// ─────────────────────────────────────────────────────────────
// DETAIL PANEL
// ─────────────────────────────────────────────────────────────

// A record's status badge: present success, absent error, late warning,
// excused and on leave info.
const STATUS_TONES = {
  present:  SEMANTIC.success,
  absent:   SEMANTIC.error,
  late:     SEMANTIC.warning,
  excused:  SEMANTIC.info,
  on_leave: SEMANTIC.info,
};

const DetailPanel = React.memo(({ student }) => {
  const { t } = useTranslation();
  if (!student?.records?.length) {
    return (
      <View style={detailS.empty}>
        <IconSquare icon="calendar-outline" accent="green" size={40} />
        <Text style={detailS.emptyText}>{t("attTeacher.repNonePeriod")}</Text>
      </View>
    );
  }

  const sorted = [...student.records].sort(
    (a, b) => b.date.localeCompare(a.date)
  );

  return (
    <View style={detailS.container}>
      <Text style={detailS.title}>
        Records ({student.records.length})
      </Text>
      {sorted.map((rec, i) => {
        const tone = STATUS_TONES[rec.status] || SEMANTIC.info;
        return (
          <View key={`${rec.date}-${i}`} style={detailS.row}>
            <Text style={detailS.date}>{fmtDate(rec.date)}</Text>
            <View style={[detailS.badge, { backgroundColor: tone.bg, borderColor: tone.icon + "4D" }]}>
              <Text style={[detailS.badgeText, { color: tone.text }]}>
                {(rec.status || "").replace("_", " ").toUpperCase()}
              </Text>
            </View>
            {!!rec.note && (
              <Text style={detailS.note} numberOfLines={1}>
                {rec.note}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
});

const detailS = StyleSheet.create({
  container: {
    backgroundColor:      THEME.surface,
    borderRadius:         16,
    borderTopLeftRadius:  0,
    borderTopRightRadius: 0,
    padding:              14,
    marginBottom:         12,
    borderWidth:          1,
    borderTopWidth:       0,
    borderColor:          THEME.border,
  },
  title: { fontSize: 13, fontWeight: "700", color: THEME.text, marginBottom: 10 },
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
    gap:               10,
  },
  date:      { fontSize: 13, color: THEME.text, fontWeight: "500", flex: 1 },
  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  note:      { fontSize: 11, color: THEME.textSecondary, flex: 1 },
  empty: {
    alignItems:      "center",
    padding:         20,
    gap:             8,
    backgroundColor: ACCENT.green.wash,
    borderRadius:    12,
    marginBottom:    12,
  },
  emptyText: { fontSize: 13, color: THEME.textSecondary },
});

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function TeacherAttendanceReportScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams();
  const user   = useAuthStore((s) => s.user);

  const schoolId  = user?.schoolId;
  const classId   = params.classId;
  const className = params.className || t("attTeacher.klass");

  const [students,   setStudents]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");
  const [preset,     setPreset]     = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [sortBy,     setSortBy]     = useState("name");

  const selectedPreset = DATE_PRESETS[preset];

  // ── Load ─────────────────────────────────────────────────

  const loadReport = useCallback(async (isRefresh = false) => {
    if (!classId || !schoolId) {
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const data = await AttendanceService.getClassReport(classId, {
        schoolId,
        startDate: selectedPreset.start,
        endDate:   selectedPreset.end,
      });

      // ── Server format: { students: [{ student, present, absent, ... }] }
      if (data?.students?.length) {
        const mapped = data.students.map((s) => {
                                           return ({
          studentId:    String(s.student._id || s.student.id),
          studentName:  s.student.studentName || s.student.name || t("attTeacher.unknown"),
          studentEmail: s.student.email || "",
          admissionNo:  s.student.admissionNo || null,
          records:      [],
          summary: {
            present:  s.present  ?? 0,
            absent:   s.absent   ?? 0,
            late:     s.late     ?? 0,
            excused:  s.excused  ?? 0,
            total:    s.total    ?? 0,
          },
          rate: s.rate ?? 0,
        });
                                         });
        setStudents(mapped);
        return;
      }

      // ── Local fallback: flat records array
      const rawRecords =
        data?.records ||
        data?.data    ||
        (Array.isArray(data) ? data : []);

      setStudents(buildStudentSummaries(rawRecords, t));
    } catch (err) {
      console.error("[TeacherReport] loadReport failed:", err?.message || err);
      setError(t("attTeacher.repLoadPull"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [classId, schoolId, selectedPreset.end, selectedPreset.start, t]);

  useEffect(() => { loadReport(); }, [loadReport]);

  // ── Derived ───────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = q
      ? students.filter(
          (s) =>
            (s.studentName  || "").toLowerCase().includes(q) ||
            (s.studentEmail || "").toLowerCase().includes(q) ||
            (s.admissionNo  || "").toLowerCase().includes(q)
        )
      : [...students];

    if (sortBy === "rate") {
      list.sort((a, b) => b.rate - a.rate);
    } else if (sortBy === "absent") {
      list.sort(
        (a, b) => (b.summary?.absent ?? 0) - (a.summary?.absent ?? 0)
      );
    } else {
      list.sort((a, b) =>
        (a.studentName || "").localeCompare(b.studentName || "")
      );
    }

    return list;
  }, [students, search, sortBy]);

  const toggleExpand = useCallback((studentId) => {
    setExpandedId((prev) => (prev === studentId ? null : studentId));
  }, []);

  // ── Loading ───────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attTeacher.repLoading")}</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={THEME.page} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={THEME.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t("attTeacher.classReport", { className })}
          </Text>
          <Text style={styles.headerSub}>
            {selectedPreset.label} · {t("academic.studentCount", { count: filtered.length })}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => loadReport(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={20} color={ACCENT.green.solid} />
        </TouchableOpacity>
      </View>

      {/* Date presets */}
      <View style={styles.presetsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.presetsScroll}
        >
          {DATE_PRESETS.map((p, i) => (
            <TouchableOpacity
              key={p.labelKey}
              style={[
                styles.presetBtn,
                preset === i && styles.presetBtnActive,
              ]}
              onPress={() => setPreset(i)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.presetText,
                  preset === i && styles.presetTextActive,
                ]}
              >
                {t(p.labelKey)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={16} color={THEME.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder={t("attTeacher.repSearchPh")}
            placeholderTextColor={THEME.textMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color={THEME.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Sort */}
      <View style={styles.sortRow}>
        {[
          { key: "name",   label: "A – Z"       },
          { key: "rate",   labelKey: "attTeacher.sortByRate"     },
          { key: "absent", labelKey: "attTeacher.sortMostAbsent" },
        ].map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[
              styles.sortBtn,
              sortBy === s.key && styles.sortBtnActive,
            ]}
            onPress={() => setSortBy(s.key)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.sortText,
                sortBy === s.key && styles.sortTextActive,
              ]}
            >
              {s.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.studentId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadReport(true)}
            tintColor={ACCENT.green.solid}
            colors={[ACCENT.green.solid]}
          />
        }
        ListHeaderComponent={
          filtered.length > 0 ? <SummaryBar students={filtered} /> : null
        }
        renderItem={({ item }) => (
          <View>
            <StudentCard
              student={item}
              isExpanded={expandedId === item.studentId}
              onPress={() => toggleExpand(item.studentId)}
            />
            {expandedId === item.studentId && (
              <DetailPanel student={item} />
            )}
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <IconSquare icon="people-outline" accent="green" size={56} radius={16} />
            <Text style={styles.emptyTitle}>
              {error
                ? t("attTeacher.repLoadFailed")
                : search
                ? t("attTeacher.noStudentMatch")
                : t("attTeacher.repNoRecords")}
            </Text>
            <Text style={styles.emptySub}>
              {!error && !search
                ? t("attTeacher.repEmptyHint")
                : ""}
            </Text>
            {!!error && (
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => loadReport()}
                activeOpacity={0.8}
              >
                <Text style={styles.retryText}>{t("attTeacher.tryAgainBtn")}</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: THEME.page },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: THEME.page,
  },
  loadingText: { color: THEME.textSecondary, marginTop: 12, fontSize: 14 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.slate.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:    { marginLeft: 12, marginRight: 0 },
  headerCenter:  { flex: 1, marginLeft: 12 },
  headerTitle:   { fontSize: 18, fontWeight: "700", color: THEME.text },
  headerSub:     { fontSize: 12, color: THEME.textSecondary, marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.green.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },

  presetsRow: {
    backgroundColor:   THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  presetsScroll: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  presetBtn: {
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      20,
    backgroundColor:   THEME.surface,
    borderWidth:       1,
    borderColor:       THEME.border,
  },
  presetBtnActive:  { backgroundColor: ACCENT.green.wash, borderColor: ACCENT.green.base },
  presetText:       { fontSize: 13, fontWeight: "600", color: THEME.textSecondary },
  presetTextActive: { color: ACCENT.green.deep },

  searchRow: {
    paddingHorizontal: 16,
    paddingTop:        12,
    paddingBottom:     8,
    backgroundColor:   THEME.surface,
  },
  searchBox: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   THEME.surface,
    borderRadius:      10,
    paddingHorizontal: 12,
    height:            42,
    borderWidth:       1,
    borderColor:       THEME.border,
    gap:               8,
  },
  searchInput: { flex: 1, fontSize: 14, color: THEME.text },

  sortRow: {
    flexDirection:     "row",
    paddingHorizontal: 16,
    paddingBottom:     12,
    backgroundColor:   THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
    gap:               6,
  },
  sortBtn: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   THEME.surface,
    borderWidth:       1,
    borderColor:       THEME.border,
  },
  sortBtnActive:  { backgroundColor: ACCENT.green.wash, borderColor: ACCENT.green.base },
  sortText:       { fontSize: 11, fontWeight: "600", color: THEME.textSecondary },
  sortTextActive: { color: ACCENT.green.deep },

  list: { padding: 16, paddingBottom: 60 },

  empty: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   80,
    gap:               12,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: THEME.text, textAlign: "center" },
  emptySub:   { fontSize: 13, color: THEME.textSecondary, textAlign: "center" },
  retryBtn: {
    backgroundColor:   ACCENT.green.solid,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         8,
  },
  retryText: { color: THEME.onPrimary, fontWeight: "700", fontSize: 14 },
});
import { useTranslation } from "../../../src/i18n/useTranslation";