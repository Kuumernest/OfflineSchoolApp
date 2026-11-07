// app/admin/attendance/report/teachers.js

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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore }      from "../../../../src/store/auth.store";
import { AttendanceService } from "../../../../src/services/attendance.service";
import { COLORS, ACCENT, SEMANTIC } from "../../../../src/theme/colors";
import { HeaderIcon, Badge, EmptyState } from "../../../../src/components/Tinted";

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const todayStr = () => new Date().toISOString().slice(0, 10);

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

const rateTone = (rate) => {
  if (rate >= 80) return "success";
  if (rate >= 60) return "warning";
  return "error";
};
const rateColor = (rate) => SEMANTIC[rateTone(rate)].text;
// A row's left edge follows the rate badge: ≥ 80% green, ≥ 60% amber, else red.
const rateEdge = (rate) => {
  if (rate >= 80) return ACCENT.green.base;
  if (rate >= 60) return ACCENT.amber.base;
  return ACCENT.red.base;
};

const DATE_PRESETS = [
  { labelKey: "attAdmin.today",      start: todayStr(),    end: todayStr()    },
  { labelKey: "attAdmin.repThisMonth", start: monthStart(0), end: monthEnd(0)   },
  { labelKey: "attAdmin.repLastMonth", start: monthStart(1), end: monthEnd(1)   },
  { labelKey: "attAdmin.repLast3Mo",  start: monthStart(2), end: monthEnd(0)   },
];

const buildTeacherSummaries = (records, teacherMap, t) => {
  const byTeacher = {};

  for (const r of records) {
    const id =
      r.teacherId  ||
      r.teacher_id ||
      r.userId     ||
      r.user_id    ||
      r.id         ||
      null;

    if (!id) continue;

    if (!byTeacher[id]) {
      const info = teacherMap[id] || {};

      const name =
        info.name             ||
        r.teacherName         ||
        r.teacher_name        ||
        r.name                ||
        r.fullName            ||
        r.full_name           ||
        r.displayName         ||
        r.display_name        ||
        (r.firstName && r.lastName
          ? `${r.firstName} ${r.lastName}`.trim()
          : null)             ||
        (r.first_name && r.last_name
          ? `${r.first_name} ${r.last_name}`.trim()
          : null)             ||
        r.firstName           ||
        r.first_name          ||
        t("attAdmin.unknownTeacher");

      const email =
        info.email      ||
        r.teacherEmail  ||
        r.teacher_email ||
        r.email         ||
        "";

      byTeacher[id] = {
        teacherId:    id,
        teacherName:  name,
        teacherEmail: email,
        records:      [],
        summary: { present: 0, absent: 0, late: 0, on_leave: 0, total: 0 },
      };
    }

    byTeacher[id].records.push({
      date:   r.date,
      status: r.status,
      note:   r.note || null,
    });

    const key = r.status || "present";
    if (key in byTeacher[id].summary) {
      byTeacher[id].summary[key]++;
    }
    byTeacher[id].summary.total++;
  }

  return Object.values(byTeacher).map((t) => ({
    ...t,
    rate: t.summary.total > 0
      ? Math.round((t.summary.present / t.summary.total) * 100)
      : 0,
  }));
};

const StatChip = ({ label, value, color, bg }) => (
  <View style={[chipS.chip, { backgroundColor: bg }]}>
    <Text style={[chipS.val, { color }]}>{value}</Text>
    <Text style={chipS.lbl}>{label}</Text>
  </View>
);

const chipS = StyleSheet.create({
  chip: {
    flex:         1,
    borderRadius: 10,
    padding:      8,
    alignItems:   "center",
    gap:          2,
  },
  val: { fontSize: 15, fontWeight: "800" },
  lbl: {
    fontSize:      9,
    color:         COLORS.textSecondary,
    fontWeight:    "600",
    textTransform: "uppercase",
  },
});

const TeacherReportCard = React.memo(({ teacher, isExpanded, onPress }) => {
  const { t } = useTranslation();
  const { summary, rate } = teacher;
  const color = rateColor(rate);
  const tone  = rateTone(rate);

  return (
    <TouchableOpacity
      style={[cardS.card, { borderLeftColor: rateEdge(rate) }, isExpanded && cardS.cardExpanded]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={cardS.top}>
        <View style={cardS.avatar}>
          <Text style={cardS.avatarText}>
            {teacher.teacherName?.charAt(0)?.toUpperCase() || "?"}
          </Text>
        </View>

        <View style={cardS.info}>
          <Text style={cardS.name} numberOfLines={1}>
            {teacher.teacherName}
          </Text>
          <Text style={cardS.email} numberOfLines={1}>
            {teacher.teacherEmail || t("attAdmin.noEmail")}
          </Text>
        </View>

        <View style={[cardS.rateBadge, { backgroundColor: SEMANTIC[tone].bg }]}>
          <Text style={[cardS.rateNum, { color }]}>{rate}%</Text>
          <Text style={[cardS.rateLbl, { color }]}>rate</Text>
        </View>

        <Ionicons
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={COLORS.textSecondary}
          style={{ marginLeft: 4 }}
        />
      </View>

      <View style={cardS.stats}>
        <StatChip label={t("attStatus.present")}  value={summary?.present  ?? 0} color={SEMANTIC.success.text} bg={SEMANTIC.success.bg} />
        <StatChip label={t("attStatus.absent")}   value={summary?.absent   ?? 0} color={SEMANTIC.error.text}   bg={SEMANTIC.error.bg} />
        <StatChip label={t("attStatus.late")}     value={summary?.late     ?? 0} color={SEMANTIC.warning.text} bg={SEMANTIC.warning.bg} />
        <StatChip label={t("attAdmin.leaveShort")}    value={summary?.on_leave ?? 0} color={SEMANTIC.info.text} bg={SEMANTIC.info.bg} />
        <StatChip label={t("common.total")}    value={summary?.total    ?? 0} color={ACCENT.green.deep} bg={ACCENT.green.wash} />
      </View>

      <View style={cardS.barBg}>
        <View
          style={[
            cardS.barFill,
            { width: `${Math.min(rate, 100)}%`, backgroundColor: SEMANTIC[tone].icon },
          ]}
        />
      </View>
    </TouchableOpacity>
  );
});

const cardS = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    padding:         16,
    marginBottom:    4,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardExpanded: {
    borderBottomLeftRadius:  0,
    borderBottomRightRadius: 0,
    borderBottomColor:       "transparent",
  },
  top: {
    flexDirection:  "row",
    alignItems:     "center",
    marginBottom:   12,
    gap:            10,
  },
  avatar: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: ACCENT.violet.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText:  { fontSize: 18, fontWeight: "800", color: ACCENT.violet.deep },
  info:        { flex: 1 },
  name:        { fontSize: 15, fontWeight: "700", color: COLORS.text },
  email:       { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  rateBadge: {
    alignItems:   "center",
    borderRadius: 10,
    padding:      8,
    minWidth:     50,
  },
  rateNum:  { fontSize: 18, fontWeight: "800" },
  rateLbl:  { fontSize: 9,  fontWeight: "600", textTransform: "uppercase" },
  stats:    { flexDirection: "row", gap: 6, marginBottom: 10 },
  barBg: {
    height:          6,
    backgroundColor: COLORS.border,
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

const STATUS_TONES = {
  present:  "success",
  absent:   "error",
  late:     "warning",
  on_leave: "info",
  excused:  "info",
};

const TeacherDetailPanel = React.memo(({ teacher }) => {
  const { t } = useTranslation();
  if (!teacher?.records?.length) {
    return (
      <EmptyState
        icon="calendar-outline"
        kind="attendance"
        message={t("attAdmin.noRecordsPeriod")}
        style={detailS.empty}
      />
    );
  }

  const sorted = [...teacher.records].sort(
    (a, b) => b.date.localeCompare(a.date)
  );

  return (
    <View style={detailS.container}>
      <Text style={detailS.title}>
        Attendance Records ({teacher.records.length})
      </Text>

      {sorted.map((rec, i) => {
        const tone = STATUS_TONES[rec.status];
        return (
          <View key={`${rec.date}-${i}`} style={detailS.row}>
            <Text style={detailS.date}>{fmtDate(rec.date)}</Text>
            <Badge
              label={(rec.status || "").replace("_", " ").toUpperCase()}
              tone={tone}
              accent={tone ? undefined : "slate"}
              style={detailS.badge}
              textStyle={detailS.badgeText}
            />
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
    backgroundColor:      COLORS.page,
    borderRadius:         16,
    borderTopLeftRadius:  0,
    borderTopRightRadius: 0,
    padding:              14,
    marginBottom:         12,
    borderWidth:          1,
    borderTopWidth:       0,
    borderColor:          COLORS.border,
  },
  title:     { fontSize: 13, fontWeight: "700", color: COLORS.text, marginBottom: 10 },
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               10,
  },
  date:      { fontSize: 13, color: COLORS.text, fontWeight: "500", flex: 1 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
    alignSelf:         "auto",
  },
  badgeText: { fontSize: 10, fontWeight: "700" },
  note:      { fontSize: 11, color: COLORS.textSecondary, flex: 1 },
  empty: {
    alignItems:      "center",
    padding:         20,
    gap:             8,
    backgroundColor: COLORS.page,
    borderRadius:    12,
    marginBottom:    12,
  },
  emptyText: { fontSize: 13, color: COLORS.textSecondary },
});

const SummaryBar = ({ teachers }) => {
  const { t } = useTranslation();
  const totals = useMemo(() => {
    const t = { present: 0, absent: 0, late: 0, on_leave: 0, total: 0 };
    for (const teacher of teachers) {
      t.present  += teacher.summary?.present  ?? 0;
      t.absent   += teacher.summary?.absent   ?? 0;
      t.late     += teacher.summary?.late     ?? 0;
      t.on_leave += teacher.summary?.on_leave ?? 0;
      t.total    += teacher.summary?.total    ?? 0;
    }
    t.rate = t.total > 0 ? Math.round((t.present / t.total) * 100) : 0;
    return t;
  }, [teachers]);

  const tone = rateTone(totals.rate);

  return (
    <View style={summaryS.card}>
      <View style={summaryS.header}>
        <Text style={summaryS.title}>
          {t("academic.teacherCount", { count: teachers.length })}
        </Text>
        <View style={[summaryS.badge, { backgroundColor: SEMANTIC[tone].bg, borderColor: SEMANTIC[tone].icon }]}>
          <Text style={[summaryS.badgeText, { color: SEMANTIC[tone].text }]}>
            {totals.rate}% overall
          </Text>
        </View>
      </View>

      <View style={summaryS.pills}>
        {[
          { labelKey: "attStatus.present",  val: totals.present,  color: SEMANTIC.success.text, bg: SEMANTIC.success.box },
          { labelKey: "attStatus.absent",   val: totals.absent,   color: SEMANTIC.error.text,   bg: SEMANTIC.error.box },
          { labelKey: "attStatus.late",     val: totals.late,     color: SEMANTIC.warning.text, bg: SEMANTIC.warning.box },
          { labelKey: "attAdmin.leaveShort",    val: totals.on_leave, color: SEMANTIC.info.text, bg: SEMANTIC.info.box },
          { labelKey: "common.total",    val: totals.total,    color: ACCENT.green.deep, bg: COLORS.surface },
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
            { width: `${Math.min(totals.rate, 100)}%`, backgroundColor: SEMANTIC[tone].icon },
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
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.green.base,
    shadowColor:     COLORS.shadow,
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
  title:     { fontSize: 15, fontWeight: "700", color: COLORS.text },
  badge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  badgeText: { fontSize: 13, fontWeight: "700" },
  pills:     { flexDirection: "row", gap: 6, marginBottom: 10 },
  pill: {
    flex:         1,
    borderRadius: 10,
    padding:      8,
    alignItems:   "center",
    gap:          2,
  },
  pillVal: { fontSize: 15, fontWeight: "800" },
  pillLbl: {
    fontSize:      9,
    color:         COLORS.textSecondary,
    fontWeight:    "600",
    textTransform: "uppercase",
  },
  barBg: {
    height:          6,
    backgroundColor: COLORS.surface,
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

export default function TeacherAttendanceReportScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [teachers,   setTeachers]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");
  const [preset,     setPreset]     = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [sortBy,     setSortBy]     = useState("name");

  const selectedPreset = DATE_PRESETS[preset];

  const loadReport = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const data = await AttendanceService.getTeacherAttendance({
        schoolId,
        startDate: selectedPreset.start,
        endDate:   selectedPreset.end,
      });

      const rawRecords =
        data?.records ||
        data?.data    ||
        (Array.isArray(data) ? data : []);

      console.log(`📋 Raw records count: ${rawRecords.length}`);

      if (rawRecords.length === 0) {
        setTeachers([]);
        return;
      }

      const teacherMap = await AttendanceService.buildTeacherMap(schoolId);

      console.log(
        `🗺️ Teacher map has ${Object.keys(teacherMap).length} entries:`,
        teacherMap
      );

      const summaries = buildTeacherSummaries(rawRecords, teacherMap, t);
      setTeachers(summaries);

      console.log(
        `📊 Teacher report: ${rawRecords.length} records → ${summaries.length} teachers`
      );

      if (summaries.length > 0) {
        console.log(
          "👤 First teacher resolved:",
          summaries[0].teacherName,
          "|",
          summaries[0].teacherEmail
        );
      }

    } catch (err) {
      console.error("Teacher report load failed:", err.message);
      setError(t("attAdmin.reportLoadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, selectedPreset.end, selectedPreset.start, t]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = q
      ? teachers.filter(
          (t) =>
            t.teacherName?.toLowerCase().includes(q) ||
            t.teacherEmail?.toLowerCase().includes(q)
        )
      : [...teachers];

    if (sortBy === "rate") {
      list.sort((a, b) => b.rate - a.rate);
    } else if (sortBy === "absent") {
      list.sort(
        (a, b) => (b.summary?.absent ?? 0) - (a.summary?.absent ?? 0)
      );
    } else {
      list.sort((a, b) =>
        (a.teacherName || "").localeCompare(b.teacherName || "")
      );
    }

    return list;
  }, [teachers, search, sortBy]);

  const toggleExpand = useCallback((teacherId) => {
    setExpandedId((prev) => (prev === teacherId ? null : teacherId));
  }, []);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attAdmin.loadingTeacherReport")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("attAdmin.teacherReportTitle")}</Text>
          <Text style={styles.headerSub}>
            {t(selectedPreset.labelKey)} · {t("academic.teacherCount", { count: filtered.length })}
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

      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={16} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            placeholder={t("attAdmin.searchTeacherReport")}
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

      <View style={styles.sortRow}>
        {[
          { key: "name",   label: "A – Z"      },
          { key: "rate",   labelKey: "attAdmin.sortByRate"     },
          { key: "absent", labelKey: "attAdmin.sortMostAbsent" },
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
              {t(s.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.teacherId}
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
          filtered.length > 0
            ? <SummaryBar teachers={filtered} />
            : null
        }
        renderItem={({ item }) => (
          <View>
            <TeacherReportCard
              teacher={item}
              isExpanded={expandedId === item.teacherId}
              onPress={() => toggleExpand(item.teacherId)}
            />
            {expandedId === item.teacherId && (
              <TeacherDetailPanel teacher={item} />
            )}
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            icon="person-outline"
            kind={error ? undefined : "teachers"}
            accent={error ? "red" : undefined}
            title={error
              ? t("attAdmin.reportLoadFailedShort")
              : search
              ? t("attAdmin.noTeachersMatch")
              : t("attAdmin.noRecords")}
            message={!error && !search
              ? t("attAdmin.markTeachersFirst")
              : ""}
            action={error ? (
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => loadReport()}
                activeOpacity={0.8}
              >
                <Text style={styles.retryText}>{t("attAdmin.tryAgain")}</Text>
              </TouchableOpacity>
            ) : null}
            style={styles.empty}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: COLORS.page,
  },
  loadingText: { color: COLORS.textSecondary, marginTop: 12, fontSize: 14 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.page,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:    { marginLeft: 12, marginRight: 0 },
  headerCenter:  { flex: 1, marginLeft: 12 },
  headerTitle:   { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:     { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.green.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },

  presetsRow: {
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  presetsScroll: {
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
  },
  presetBtn: {
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      20,
    backgroundColor:   COLORS.surface,
    borderWidth:       1,
    borderColor:       COLORS.border,
  },
  presetBtnActive:  { backgroundColor: ACCENT.green.wash, borderColor: ACCENT.green.base },
  presetText:       { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  presetTextActive: { color: ACCENT.green.deep },

  searchRow: {
    paddingHorizontal: 16,
    paddingTop:        12,
    paddingBottom:     8,
    backgroundColor:   COLORS.surface,
  },
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
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  sortRow: {
    flexDirection:     "row",
    paddingHorizontal: 16,
    paddingBottom:     12,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               8,
  },
  sortBtn: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   COLORS.surface,
    borderWidth:       1,
    borderColor:       COLORS.border,
  },
  sortBtnActive:  { backgroundColor: ACCENT.green.wash, borderColor: ACCENT.green.base },
  sortText:       { fontSize: 12, fontWeight: "600", color: COLORS.textSecondary },
  sortTextActive: { color: ACCENT.green.deep },

  list: { padding: 16, paddingBottom: 60 },

  empty: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   80,
    gap:               12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize:   16,
    fontWeight: "600",
    color:      COLORS.text,
    textAlign:  "center",
  },
  emptySub: {
    fontSize:  13,
    color:     COLORS.textSecondary,
    textAlign: "center",
  },
  retryBtn: {
    backgroundColor:   ACCENT.green.solid,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         8,
  },
  retryText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
});
import { useTranslation } from "../../../../src/i18n/useTranslation";