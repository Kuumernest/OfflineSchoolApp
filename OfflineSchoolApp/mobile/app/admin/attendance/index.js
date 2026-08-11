// app/admin/attendance/index.js

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
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";

const STATUS_COLORS = {
  present:  { bg: "#ECFDF5", text: "#059669", icon: "checkmark-circle" },
  absent:   { bg: "#FEF2F2", text: "#DC2626", icon: "close-circle"     },
  late:     { bg: "#FEF3C7", text: "#D97706", icon: "time"             },
  excused:  { bg: "#EEF2FF", text: "#4F46E5", icon: "shield-checkmark" },
  on_leave: { bg: "#F3F4F6", text: "#6B7280", icon: "calendar"         },
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

const todayStr = () => new Date().toISOString().slice(0, 10);

const formatDate = (dateStr) => {
  const d = new Date(dateStr);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const pct = (n, total) =>
  total > 0 ? Math.round((n / total) * 100) : 0;

const RateRing = ({ rate, color, size = 80 }) => {
  const strokeWidth = 8;

  return (
    <View
      style={{
        width:           size,
        height:          size,
        borderRadius:    size / 2,
        borderWidth:     strokeWidth,
        borderColor:     color + "30",
        alignItems:      "center",
        justifyContent:  "center",
        backgroundColor: color + "10",
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: "800", color }}>
        {rate}%
      </Text>
    </View>
  );
};

const StatPill = ({ label, value, color }) => (
  <View style={[pillStyles.pill, { backgroundColor: color + "15" }]}>
    <Text style={[pillStyles.value, { color }]}>{value}</Text>
    <Text style={pillStyles.label}>{label}</Text>
  </View>
);

const pillStyles = StyleSheet.create({
  pill: {
    flex:           1,
    borderRadius:   12,
    padding:        10,
    alignItems:     "center",
    gap:            2,
  },
  value: { fontSize: 20, fontWeight: "800" },
  label: { fontSize: 10, color: "#6B7280", fontWeight: "600", textTransform: "uppercase" },
});

const AttendanceSummaryCard = ({
  title,
  emoji,
  color,
  summary,
  onMarkAll,
  onViewDetail,
}) => {
  const { total, marked, present, absent, late, unmarked, rate } =
    summary || {};

  return (
    <View style={[cardStyles.card, { borderLeftColor: color, borderLeftWidth: 4 }]}>
      <View style={cardStyles.header}>
        <View style={cardStyles.titleRow}>
          <Text style={cardStyles.emoji}>{emoji}</Text>
          <View>
            <Text style={cardStyles.title}>{title}</Text>
            <Text style={cardStyles.sub}>
              {marked ?? 0} of {total ?? 0} marked today
            </Text>
          </View>
        </View>
        <RateRing rate={rate ?? 0} color={color} size={72} />
      </View>

      <View style={cardStyles.pillRow}>
        <StatPill label="Present" value={present ?? 0} color="#059669" />
        <StatPill label="Absent"  value={absent  ?? 0} color="#DC2626" />
        <StatPill label="Late"    value={late    ?? 0} color="#D97706" />
        <StatPill label="Unmarked"value={unmarked?? 0} color="#9CA3AF" />
      </View>

      <View style={cardStyles.actions}>
        <TouchableOpacity
          style={[cardStyles.btn, { backgroundColor: color }]}
          onPress={onMarkAll}
          activeOpacity={0.8}
        >
          <Ionicons name="create-outline" size={16} color="#FFF" />
          <Text style={cardStyles.btnText}>Mark Attendance</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[cardStyles.btn, cardStyles.btnOutline, { borderColor: color }]}
          onPress={onViewDetail}
          activeOpacity={0.8}
        >
          <Ionicons name="bar-chart-outline" size={16} color={color} />
          <Text style={[cardStyles.btnText, { color }]}>View Report</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         20,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  header: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    marginBottom:   16,
  },
  titleRow:  { flexDirection: "row", alignItems: "center", gap: 10 },
  emoji:     { fontSize: 28 },
  title:     { fontSize: 17, fontWeight: "700", color: "#111827" },
  sub:       { fontSize: 12, color: "#6B7280", marginTop: 2 },
  pillRow:   { flexDirection: "row", gap: 8, marginBottom: 16 },
  actions:   { flexDirection: "row", gap: 10 },
  btn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    borderRadius:    10,
    paddingVertical: 10,
  },
  btnOutline: {
    backgroundColor: "transparent",
    borderWidth:     1.5,
  },
  btnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
});

const WeeklyChart = ({ trend }) => {
  if (!trend?.length) return null;

  return (
    <View style={chartStyles.container}>
      <Text style={chartStyles.title}>7-Day Attendance Trend</Text>

      <View style={chartStyles.legend}>
        <View style={chartStyles.legendItem}>
          <View style={[chartStyles.legendDot, { backgroundColor: "#4F46E5" }]} />
          <Text style={chartStyles.legendText}>Students</Text>
        </View>
        <View style={chartStyles.legendItem}>
          <View style={[chartStyles.legendDot, { backgroundColor: "#059669" }]} />
          <Text style={chartStyles.legendText}>Teachers</Text>
        </View>
      </View>

      <View style={chartStyles.chart}>
        {trend.map((day, i) => {
          const sRate = day.students?.rate ?? 0;
          const tRate = day.teachers?.rate ?? 0;
          const d     = new Date(day.date);
          const label = DAYS[d.getDay()];

          return (
            <View key={day.date} style={chartStyles.bar}>
              <View style={chartStyles.barGroup}>
                <View style={chartStyles.barWrapper}>
                  <View
                    style={[
                      chartStyles.barFill,
                      {
                        height:          `${sRate}%`,
                        backgroundColor: "#4F46E5",
                        minHeight:       sRate > 0 ? 4 : 0,
                      },
                    ]}
                  />
                </View>
                <View style={chartStyles.barWrapper}>
                  <View
                    style={[
                      chartStyles.barFill,
                      {
                        height:          `${tRate}%`,
                        backgroundColor: "#059669",
                        minHeight:       tRate > 0 ? 4 : 0,
                      },
                    ]}
                  />
                </View>
              </View>
              <Text style={chartStyles.barLabel}>{label}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
};

const chartStyles = StyleSheet.create({
  container: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         20,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  title:     { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 12 },
  legend:    { flexDirection: "row", gap: 16, marginBottom: 16 },
  legendItem:{ flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText:{ fontSize: 12, color: "#6B7280" },
  chart: {
    flexDirection:  "row",
    alignItems:     "flex-end",
    height:         120,
    gap:            8,
  },
  bar: {
    flex:           1,
    alignItems:     "center",
    gap:            4,
  },
  barGroup: {
    flex:           1,
    flexDirection:  "row",
    alignItems:     "flex-end",
    gap:            2,
    width:          "100%",
  },
  barWrapper: {
    flex:           1,
    height:         "100%",
    justifyContent: "flex-end",
    borderRadius:   4,
    overflow:       "hidden",
    backgroundColor: "#F3F4F6",
  },
  barFill: {
    width:        "100%",
    borderRadius: 4,
  },
  barLabel: { fontSize: 11, color: "#6B7280", fontWeight: "600" },
});

export default function AttendanceReportScreen() {
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [overview,   setOverview]   = useState(null);
  const [weekly,     setWeekly]     = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [activeTab,  setActiveTab]  = useState("overview");

  const today = useMemo(() => todayStr(), []);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      let overviewData = null;
      let weeklyData   = { trend: [] };

      try {
        overviewData = await AttendanceService.getOverviewReport(
          schoolId,
          today
        );
      } catch (overviewErr) {
        console.warn("Overview failed:", overviewErr.message);
        overviewData = {
          date:     today,
          students: { total: 0, marked: 0, unmarked: 0, present: 0, absent: 0, late: 0, rate: 0 },
          teachers: { total: 0, marked: 0, unmarked: 0, present: 0, absent: 0, late: 0, rate: 0 },
        };
      }

      try {
        weeklyData = await AttendanceService.getWeeklyReport(schoolId);
      } catch (weeklyErr) {
        console.warn("Weekly report failed:", weeklyErr.message);
        weeklyData = { trend: [] };
      }

      setOverview(overviewData);
      setWeekly(weeklyData);
    } catch (err) {
      console.error("Attendance report load failed:", err.message);
      setError("Failed to load attendance data. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, today]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleMarkTeacherAttendance = useCallback(() => {
    router.push("/admin/attendance/teachers");
  }, [router]);

  const handleMarkStudentAttendance = useCallback(() => {
    router.push("/admin/attendance/students");
  }, [router]);

  const handleViewStudentReport = useCallback(() => {
    router.push("/admin/attendance/report/students");
  }, [router]);

  const handleViewTeacherReport = useCallback(() => {
    router.push("/admin/attendance/report/teachers");
  }, [router]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading attendance data…</Text>
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
          <Text style={styles.headerTitle}>Attendance</Text>
          <Text style={styles.headerSub}>{formatDate(today)}</Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => loadData(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={20} color="#4F46E5" />
        </TouchableOpacity>
      </View>

      <View style={styles.tabBar}>
        {[
          { key: "overview", label: "Today",  icon: "today-outline"    },
          { key: "weekly",   label: "Weekly", icon: "bar-chart-outline" },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[
              styles.tab,
              activeTab === tab.key && styles.tabActive,
            ]}
            onPress={() => setActiveTab(tab.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={tab.icon}
              size={16}
              color={activeTab === tab.key ? "#4F46E5" : "#9CA3AF"}
            />
            <Text
              style={[
                styles.tabText,
                activeTab === tab.key && styles.tabTextActive,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {activeTab === "overview" && (
          <>
            <View style={styles.rateSummary}>
              <View style={styles.rateCard}>
                <RateRing
                  rate={overview?.students?.rate ?? 0}
                  color="#4F46E5"
                  size={80}
                />
                <Text style={styles.rateLabel}>Student{"\n"}Attendance</Text>
              </View>
              <View style={styles.rateDivider} />
              <View style={styles.rateCard}>
                <RateRing
                  rate={overview?.teachers?.rate ?? 0}
                  color="#059669"
                  size={80}
                />
                <Text style={styles.rateLabel}>Teacher{"\n"}Attendance</Text>
              </View>
            </View>

            <AttendanceSummaryCard
              title="Students"
              emoji="🎒"
              color="#4F46E5"
              summary={overview?.students}
              onMarkAll={handleMarkStudentAttendance}
              onViewDetail={handleViewStudentReport}
            />

            <AttendanceSummaryCard
              title="Teachers"
              emoji="👩‍🏫"
              color="#059669"
              summary={overview?.teachers}
              onMarkAll={handleMarkTeacherAttendance}
              onViewDetail={handleViewTeacherReport}
            />

            <View style={styles.quickActions}>
              <Text style={styles.sectionTitle}>Quick Actions</Text>

              {[
                {
                  label:  "Mark Student Attendance",
                  sub:    "Take register for a class",
                  icon:   "people-outline",
                  color:  "#4F46E5",
                  route:  "/admin/attendance/students",
                },
                {
                  label:  "Mark Teacher Attendance",
                  sub:    "Record staff attendance for today",
                  icon:   "person-outline",
                  color:  "#059669",
                  route:  "/admin/attendance/teachers",
                },
                {
                  label:  "Student Reports",
                  sub:    "View per-class or per-student history",
                  icon:   "document-text-outline",
                  color:  "#7C3AED",
                  route:  "/admin/attendance/report/students",
                },
                {
                  label:  "Teacher Reports",
                  sub:    "View teacher attendance history",
                  icon:   "bar-chart-outline",
                  color:  "#D97706",
                  route:  "/admin/attendance/report/teachers",
                },
              ].map((action) => (
                <TouchableOpacity
                  key={action.route}
                  style={styles.actionRow}
                  onPress={() => router.push(action.route)}
                  activeOpacity={0.7}
                >
                  <View
                    style={[
                      styles.actionIcon,
                      { backgroundColor: action.color + "15" },
                    ]}
                  >
                    <Ionicons
                      name={action.icon}
                      size={20}
                      color={action.color}
                    />
                  </View>
                  <View style={styles.actionInfo}>
                    <Text style={styles.actionLabel}>{action.label}</Text>
                    <Text style={styles.actionSub}>{action.sub}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {activeTab === "weekly" && (
          <>
            <WeeklyChart trend={weekly?.trend} />

            <View style={styles.tableCard}>
              <Text style={styles.sectionTitle}>Daily Breakdown</Text>

              <View style={[styles.tableRow, styles.tableHeader]}>
                <Text style={[styles.tableCell, styles.tableCellDay]}>Day</Text>
                <Text style={styles.tableCell}>S.Present</Text>
                <Text style={styles.tableCell}>S.Rate</Text>
                <Text style={styles.tableCell}>T.Present</Text>
                <Text style={styles.tableCell}>T.Rate</Text>
              </View>

              {(weekly?.trend || []).map((day) => {
                const d = new Date(day.date);
                return (
                  <View
                    key={day.date}
                    style={[
                      styles.tableRow,
                      day.date === today && styles.tableRowToday,
                    ]}
                  >
                    <Text style={[styles.tableCell, styles.tableCellDay]}>
                      {DAYS[d.getDay()]}
                      {"\n"}
                      <Text style={styles.tableCellSub}>
                        {d.getDate()} {MONTHS[d.getMonth()]}
                      </Text>
                    </Text>
                    <Text style={styles.tableCell}>
                      {day.students?.present ?? 0}
                    </Text>
                    <Text
                      style={[
                        styles.tableCell,
                        styles.tableCellRate,
                        {
                          color:
                            (day.students?.rate ?? 0) >= 75
                              ? "#059669"
                              : (day.students?.rate ?? 0) >= 50
                              ? "#D97706"
                              : "#DC2626",
                        },
                      ]}
                    >
                      {day.students?.rate ?? 0}%
                    </Text>
                    <Text style={styles.tableCell}>
                      {day.teachers?.present ?? 0}
                    </Text>
                    <Text
                      style={[
                        styles.tableCell,
                        styles.tableCellRate,
                        {
                          color:
                            (day.teachers?.rate ?? 0) >= 75
                              ? "#059669"
                              : (day.teachers?.rate ?? 0) >= 50
                              ? "#D97706"
                              : "#DC2626",
                        },
                      ]}
                    >
                      {day.teachers?.rate ?? 0}%
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
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
  headerSub:     { fontSize: 13, color: "#6B7280", marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },

  tabBar: {
    flexDirection:   "row",
    backgroundColor: "#FFF",
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  tab: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             6,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: "#4F46E5" },
  tabText:   { fontSize: 14, color: "#9CA3AF", fontWeight: "600" },
  tabTextActive: { color: "#4F46E5" },

  scroll: { padding: 16, paddingBottom: 40 },

  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FEF2F2",
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: "#DC2626" },

  rateSummary: {
    flexDirection:   "row",
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         20,
    marginBottom:    16,
    alignItems:      "center",
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  rateCard: {
    flex:           1,
    alignItems:     "center",
    gap:            10,
  },
  rateDivider: {
    width:           1,
    height:          80,
    backgroundColor: "#F3F4F6",
    marginHorizontal: 16,
  },
  rateLabel: {
    fontSize:   12,
    color:      "#6B7280",
    fontWeight: "600",
    textAlign:  "center",
    lineHeight: 18,
  },

  sectionTitle: {
    fontSize:     15,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 12,
  },

  quickActions: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         20,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  actionRow: {
    flexDirection: "row",
    alignItems:    "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
    gap: 12,
  },
  actionIcon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  actionInfo:  { flex: 1 },
  actionLabel: { fontSize: 14, fontWeight: "600", color: "#111827" },
  actionSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 2 },

  tableCard: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         20,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  tableRow: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  tableHeader: {
    borderBottomColor: "#E5E7EB",
    borderBottomWidth: 1.5,
  },
  tableRowToday: { backgroundColor: "#EEF2FF", borderRadius: 8 },
  tableCell: {
    flex:      1,
    fontSize:  13,
    color:     "#374151",
    textAlign: "center",
    fontWeight: "500",
  },
  tableCellDay: {
    flex:      1.2,
    textAlign: "left",
    fontWeight: "700",
    color:     "#111827",
  },
  tableCellSub: {
    fontSize:   10,
    color:      "#9CA3AF",
    fontWeight: "400",
  },
  tableCellRate: { fontWeight: "700" },
});