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

const rateColor = (rate) => {
  if (rate >= 80) return "#059669";
  if (rate >= 60) return "#D97706";
  return "#DC2626";
};

const DATE_PRESETS = [
  { label: "Today",      start: todayStr(),    end: todayStr()    },
  { label: "This Month", start: monthStart(0), end: monthEnd(0)   },
  { label: "Last Month", start: monthStart(1), end: monthEnd(1)   },
  { label: "Last 3 Mo",  start: monthStart(2), end: monthEnd(0)   },
];

const buildTeacherSummaries = (records, teacherMap) => {
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
        "Unknown Teacher";

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

const StatChip = ({ label, value, color }) => (
  <View style={[chipS.chip, { backgroundColor: color + "15" }]}>
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
    color:         "#6B7280",
    fontWeight:    "600",
    textTransform: "uppercase",
  },
});

const TeacherReportCard = React.memo(({ teacher, isExpanded, onPress }) => {
  const { summary, rate } = teacher;
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
            {teacher.teacherName?.charAt(0)?.toUpperCase() || "?"}
          </Text>
        </View>

        <View style={cardS.info}>
          <Text style={cardS.name} numberOfLines={1}>
            {teacher.teacherName}
          </Text>
          <Text style={cardS.email} numberOfLines={1}>
            {teacher.teacherEmail || "No email"}
          </Text>
        </View>

        <View style={[cardS.rateBadge, { backgroundColor: color + "15" }]}>
          <Text style={[cardS.rateNum, { color }]}>{rate}%</Text>
          <Text style={[cardS.rateLbl, { color }]}>rate</Text>
        </View>

        <Ionicons
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={16}
          color="#9CA3AF"
          style={{ marginLeft: 4 }}
        />
      </View>

      <View style={cardS.stats}>
        <StatChip label="Present"  value={summary?.present  ?? 0} color="#059669" />
        <StatChip label="Absent"   value={summary?.absent   ?? 0} color="#DC2626" />
        <StatChip label="Late"     value={summary?.late     ?? 0} color="#D97706" />
        <StatChip label="Leave"    value={summary?.on_leave ?? 0} color="#6B7280" />
        <StatChip label="Total"    value={summary?.total    ?? 0} color="#4F46E5" />
      </View>

      <View style={cardS.barBg}>
        <View
          style={[
            cardS.barFill,
            { width: `${Math.min(rate, 100)}%`, backgroundColor: color },
          ]}
        />
      </View>
    </TouchableOpacity>
  );
});

const cardS = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    4,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
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
    backgroundColor: "#ECFDF5",
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText:  { fontSize: 18, fontWeight: "800", color: "#059669" },
  info:        { flex: 1 },
  name:        { fontSize: 15, fontWeight: "700", color: "#111827" },
  email:       { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
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
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

const STATUS_COLORS = {
  present:  "#059669",
  absent:   "#DC2626",
  late:     "#D97706",
  on_leave: "#6B7280",
  excused:  "#4F46E5",
};

const TeacherDetailPanel = React.memo(({ teacher }) => {
  if (!teacher?.records?.length) {
    return (
      <View style={detailS.empty}>
        <Ionicons name="calendar-outline" size={32} color="#D1D5DB" />
        <Text style={detailS.emptyText}>No records in this period</Text>
      </View>
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
        const color = STATUS_COLORS[rec.status] || "#9CA3AF";
        return (
          <View key={`${rec.date}-${i}`} style={detailS.row}>
            <Text style={detailS.date}>{fmtDate(rec.date)}</Text>
            <View style={[detailS.badge, { backgroundColor: color + "18" }]}>
              <Text style={[detailS.badgeText, { color }]}>
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
    backgroundColor:      "#F9FAFB",
    borderRadius:         16,
    borderTopLeftRadius:  0,
    borderTopRightRadius: 0,
    padding:              14,
    marginBottom:         12,
    borderWidth:          1,
    borderTopWidth:       0,
    borderColor:          "#F3F4F6",
  },
  title:     { fontSize: 13, fontWeight: "700", color: "#374151", marginBottom: 10 },
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingVertical:   8,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
    gap:               10,
  },
  date:      { fontSize: 13, color: "#374151", fontWeight: "500", flex: 1 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
  },
  badgeText: { fontSize: 10, fontWeight: "700" },
  note:      { fontSize: 11, color: "#9CA3AF", flex: 1 },
  empty: {
    alignItems:      "center",
    padding:         20,
    gap:             8,
    backgroundColor: "#F9FAFB",
    borderRadius:    12,
    marginBottom:    12,
  },
  emptyText: { fontSize: 13, color: "#9CA3AF" },
});

const SummaryBar = ({ teachers }) => {
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

  const color = rateColor(totals.rate);

  return (
    <View style={summaryS.card}>
      <View style={summaryS.header}>
        <Text style={summaryS.title}>
          {teachers.length} Teacher{teachers.length !== 1 ? "s" : ""}
        </Text>
        <View style={[summaryS.badge, { backgroundColor: color + "15" }]}>
          <Text style={[summaryS.badgeText, { color }]}>
            {totals.rate}% overall
          </Text>
        </View>
      </View>

      <View style={summaryS.pills}>
        {[
          { label: "Present",  val: totals.present,  color: "#059669" },
          { label: "Absent",   val: totals.absent,   color: "#DC2626" },
          { label: "Late",     val: totals.late,     color: "#D97706" },
          { label: "Leave",    val: totals.on_leave, color: "#6B7280" },
          { label: "Total",    val: totals.total,    color: "#4F46E5" },
        ].map((p) => (
          <View
            key={p.label}
            style={[summaryS.pill, { backgroundColor: p.color + "10" }]}
          >
            <Text style={[summaryS.pillVal, { color: p.color }]}>{p.val}</Text>
            <Text style={summaryS.pillLbl}>{p.label}</Text>
          </View>
        ))}
      </View>

      <View style={summaryS.barBg}>
        <View
          style={[
            summaryS.barFill,
            { width: `${Math.min(totals.rate, 100)}%`, backgroundColor: color },
          ]}
        />
      </View>
    </View>
  );
};

const summaryS = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
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
  title:     { fontSize: 15, fontWeight: "700", color: "#111827" },
  badge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
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
    color:         "#6B7280",
    fontWeight:    "600",
    textTransform: "uppercase",
  },
  barBg: {
    height:          6,
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
});

export default function TeacherAttendanceReportScreen() {
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

      const summaries = buildTeacherSummaries(rawRecords, teacherMap);
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
      setError("Failed to load report. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, selectedPreset]);

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
        <ActivityIndicator size="large" color="#059669" />
        <Text style={styles.loadingText}>Loading teacher report…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Teacher Report</Text>
          <Text style={styles.headerSub}>
            {selectedPreset.label} · {filtered.length} teacher
            {filtered.length !== 1 ? "s" : ""}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => loadReport(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={20} color="#059669" />
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
              key={p.label}
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
                {p.label}
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
            placeholder="Search teacher name or email…"
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
          { key: "rate",   label: "By Rate"     },
          { key: "absent", label: "Most Absent" },
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

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.teacherId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadReport(true)}
            tintColor="#059669"
            colors={["#059669"]}
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
          <View style={styles.empty}>
            <Ionicons name="person-outline" size={56} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>
              {error
                ? "Failed to load report"
                : search
                ? "No teachers match your search"
                : "No attendance records found"}
            </Text>
            <Text style={styles.emptySub}>
              {!error && !search
                ? "Mark teacher attendance first, then check back here"
                : ""}
            </Text>
            {!!error && (
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => loadReport()}
                activeOpacity={0.8}
              >
                <Text style={styles.retryText}>Try Again</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: { color: "#6B7280", marginTop: 12, fontSize: 14 },

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
  headerCenter:  { flex: 1, marginLeft: 12 },
  headerTitle:   { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:     { fontSize: 12, color: "#6B7280", marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#ECFDF5",
    alignItems:      "center",
    justifyContent:  "center",
  },

  presetsRow: {
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
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
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  presetBtnActive:  { backgroundColor: "#059669", borderColor: "#059669" },
  presetText:       { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  presetTextActive: { color: "#FFF" },

  searchRow: {
    paddingHorizontal: 16,
    paddingTop:        12,
    paddingBottom:     8,
    backgroundColor:   "#FFF",
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
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               8,
  },
  sortBtn: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   "#F3F4F6",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  sortBtnActive:  { backgroundColor: "#059669", borderColor: "#059669" },
  sortText:       { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  sortTextActive: { color: "#FFF" },

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
    color:      "#374151",
    textAlign:  "center",
  },
  emptySub: {
    fontSize:  13,
    color:     "#9CA3AF",
    textAlign: "center",
  },
  retryBtn: {
    backgroundColor:   "#059669",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         8,
  },
  retryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});