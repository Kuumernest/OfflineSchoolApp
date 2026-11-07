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
import { useTranslation } from "../../../src/i18n/useTranslation";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { tileShell } from "../../../src/components/Tiles";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const STATUS_COLORS = {
  present:  { bg: "#ECFDF5", text: "#059669", icon: "checkmark-circle" },
  absent:   { bg: "#FEF2F2", text: "#DC2626", icon: "close-circle"     },
  late:     { bg: "#FEF3C7", text: "#D97706", icon: "time"             },
  excused:  { bg: "#EEF2FF", text: "#4F46E5", icon: "shield-checkmark" },
  on_leave: { bg: "#F3F4F6", text: "#6B7280", icon: "calendar"         },
};

const dayKey   = (d) => `attAdmin.day${d.getDay()}`;
const monthKey = (d) => `attAdmin.mon${d.getMonth()}`;

const todayStr = () => new Date().toISOString().slice(0, 10);

const formatDate = (dateStr, t) => {
  const d = new Date(dateStr);
  return `${t(dayKey(d))}, ${t(monthKey(d))} ${d.getDate()}`;
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

const StatPill = ({ label, value, color, bg }) => (
  <View style={[pillStyles.pill, { backgroundColor: bg }]}>
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
  label: { fontSize: 10, color: COLORS.textSecondary, fontWeight: "600", textTransform: "uppercase" },
});

const AttendanceSummaryCard = ({
  title,
  icon,
  accent,
  summary,
  onMarkAll,
  onViewDetail,
}) => {
  const { t } = useTranslation();
  const a = ACCENT[accent];

  const { total, marked, present, absent, late, unmarked, rate } =
    summary || {};

  return (
    <View style={[cardStyles.card, { backgroundColor: a.wash, borderTopColor: a.base }]}>
      <View style={cardStyles.header}>
        <View style={cardStyles.titleRow}>
          <IconSquare icon={icon} accent={accent} size={40} />
          <View>
            <Text style={cardStyles.title}>{title}</Text>
            <Text style={cardStyles.sub}>
              {t("attAdmin.markedOfTotalToday", {
                marked: marked ?? 0,
                total:  total  ?? 0,
              })}
            </Text>
          </View>
        </View>
        <RateRing rate={rate ?? 0} color={a.deep} size={72} />
      </View>

      <View style={cardStyles.pillRow}>
        <StatPill label={t("academic.present")} value={present ?? 0} color={SEMANTIC.success.text} bg={SEMANTIC.success.box} />
        <StatPill label={t("academic.absent")}  value={absent  ?? 0} color={SEMANTIC.error.text} bg={SEMANTIC.error.box} />
        <StatPill label={t("academic.late")}    value={late    ?? 0} color={SEMANTIC.warning.text} bg={SEMANTIC.warning.box} />
        <StatPill label={t("attendance.unmarked")} value={unmarked?? 0} color={ACCENT.slate.deep} bg={COLORS.surface} />
      </View>

      <View style={cardStyles.actions}>
        <TouchableOpacity
          style={[cardStyles.btn, { backgroundColor: a.solid }]}
          onPress={onMarkAll}
          activeOpacity={0.8}
        >
          <Ionicons name="create-outline" size={16} color={COLORS.onPrimary} />
          <Text style={cardStyles.btnText}>{t("attAdmin.markAttendance")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[cardStyles.btn, cardStyles.btnOutline, { borderColor: a.solid }]}
          onPress={onViewDetail}
          activeOpacity={0.8}
        >
          <Ionicons name="bar-chart-outline" size={16} color={a.solid} />
          <Text style={[cardStyles.btnText, { color: a.deep }]}>{t("attAdmin.viewReport")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 3,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: COLORS.shadow,
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
  title:    { fontSize: 17, fontWeight: "700", color: COLORS.text },
  sub:      { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
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
  btnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 13 },
});

const WeeklyChart = ({ trend }) => {
  const { t } = useTranslation();

  if (!trend?.length) return null;

  return (
    <View style={chartStyles.container}>
      <Text style={chartStyles.title}>{t("attAdmin.trend7d")}</Text>

      <View style={chartStyles.legend}>
        <View style={chartStyles.legendItem}>
          <View style={[chartStyles.legendDot, { backgroundColor: ACCENT.blue.solid }]} />
          <Text style={chartStyles.legendText}>{t("academic.student_other")}</Text>
        </View>
        <View style={chartStyles.legendItem}>
          <View style={[chartStyles.legendDot, { backgroundColor: ACCENT.violet.solid }]} />
          <Text style={chartStyles.legendText}>{t("academic.teacher_other")}</Text>
        </View>
      </View>

      <View style={chartStyles.chart}>
        {trend.map((day, i) => {
          const sRate = day.students?.rate ?? 0;
          const tRate = day.teachers?.rate ?? 0;
          const d     = new Date(day.date);
          const label = t(dayKey(d));

          return (
            <View key={day.date} style={chartStyles.bar}>
              <View style={chartStyles.barGroup}>
                <View style={chartStyles.barWrapper}>
                  <View
                    style={[
                      chartStyles.barFill,
                      {
                        height:          `${sRate}%`,
                        backgroundColor: ACCENT.blue.solid,
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
                        backgroundColor: ACCENT.violet.solid,
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
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  title:     { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 12 },
  legend:    { flexDirection: "row", gap: 16, marginBottom: 16 },
  legendItem:{ flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText:{ fontSize: 12, color: COLORS.textSecondary },
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
    backgroundColor: ACCENT.slate.wash,
  },
  barFill: {
    width:        "100%",
    borderRadius: 4,
  },
  barLabel: { fontSize: 11, color: COLORS.textSecondary, fontWeight: "600" },
});

export default function AttendanceReportScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
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
      setError(t("attAdmin.loadFailedPull"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, today, t]);

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
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attAdmin.loadingOverview")}</Text>
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
          <Text style={styles.headerTitle}>{t("attendance.title")}</Text>
          <Text style={styles.headerSub}>{formatDate(today, t)}</Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => loadData(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={20} color={ACCENT.green.solid} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabBar}>
        {[
          { key: "overview", label: t("attAdmin.today"),  icon: "today-outline"     },
          { key: "weekly",   label: t("attAdmin.weekly"), icon: "bar-chart-outline" },
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
              color={activeTab === tab.key ? ACCENT.green.solid : COLORS.textSubtle}
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
            tintColor={ACCENT.green.solid}
            colors={[ACCENT.green.solid]}
          />
        }
      >
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={SEMANTIC.error.icon} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {activeTab === "overview" && (
          <>
            <View style={styles.rateSummary}>
              <View style={styles.rateCard}>
                <RateRing
                  rate={overview?.students?.rate ?? 0}
                  color={ACCENT.blue.deep}
                  size={80}
                />
                <Text style={styles.rateLabel}>{t("attAdmin.rateStudents")}</Text>
              </View>
              <View style={styles.rateDivider} />
              <View style={styles.rateCard}>
                <RateRing
                  rate={overview?.teachers?.rate ?? 0}
                  color={ACCENT.violet.deep}
                  size={80}
                />
                <Text style={styles.rateLabel}>{t("attAdmin.rateTeachers")}</Text>
              </View>
            </View>

            <AttendanceSummaryCard
              title={t("academic.student_other")}
              icon="people"
              accent="blue"
              summary={overview?.students}
              onMarkAll={handleMarkStudentAttendance}
              onViewDetail={handleViewStudentReport}
            />

            <AttendanceSummaryCard
              title={t("academic.teacher_other")}
              icon="person"
              accent="violet"
              summary={overview?.teachers}
              onMarkAll={handleMarkTeacherAttendance}
              onViewDetail={handleViewTeacherReport}
            />

            <View style={styles.quickActions}>
              <Text style={styles.sectionTitle}>{t("attAdmin.quickActions")}</Text>

              {[
                {
                  label:  t("attAdmin.qaMarkStudents"),
                  sub:    t("attAdmin.qaMarkStudentsSub"),
                  icon:   "people-outline",
                  color:  ACCENT.indigo.solid,
                  route:  "/admin/attendance/students",
                },
                {
                  label:  t("attAdmin.qaMarkTeachers"),
                  sub:    t("attAdmin.qaMarkTeachersSub"),
                  icon:   "person-outline",
                  color:  ACCENT.green.solid,
                  route:  "/admin/attendance/teachers",
                },
                {
                  label:  t("attAdmin.qaStudentReports"),
                  sub:    t("attAdmin.qaStudentReportsSub"),
                  icon:   "document-text-outline",
                  color:  ACCENT.violet.solid,
                  route:  "/admin/attendance/report/students",
                },
                {
                  label:  t("attAdmin.qaTeacherReports"),
                  sub:    t("attAdmin.qaTeacherReportsSub"),
                  icon:   "bar-chart-outline",
                  color:  ACCENT.amber.solid,
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
                      { backgroundColor: action.color },
                    ]}
                  >
                    <Ionicons
                      name={action.icon}
                      size={20}
                      color={COLORS.onPrimary}
                    />
                  </View>
                  <View style={styles.actionInfo}>
                    <Text style={styles.actionLabel}>{action.label}</Text>
                    <Text style={styles.actionSub}>{action.sub}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {activeTab === "weekly" && (
          <>
            <WeeklyChart trend={weekly?.trend} />

            <View style={styles.tableCard}>
              <Text style={styles.sectionTitle}>{t("attAdmin.dailyBreakdown")}</Text>

              <View style={[styles.tableRow, styles.tableHeader]}>
                <Text style={[styles.tableCell, styles.tableCellDay]}>
                  {t("attAdmin.colDay")}
                </Text>
                <Text style={styles.tableCell}>{t("attAdmin.colSPresent")}</Text>
                <Text style={styles.tableCell}>{t("attAdmin.colSRate")}</Text>
                <Text style={styles.tableCell}>{t("attAdmin.colTPresent")}</Text>
                <Text style={styles.tableCell}>{t("attAdmin.colTRate")}</Text>
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
                      {t(dayKey(d))}
                      {"\n"}
                      <Text style={styles.tableCellSub}>
                        {d.getDate()} {t(monthKey(d))}
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
                              ? SEMANTIC.success.text
                              : (day.students?.rate ?? 0) >= 50
                              ? SEMANTIC.warning.text
                              : SEMANTIC.error.text,
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
                              ? SEMANTIC.success.text
                              : (day.teachers?.rate ?? 0) >= 50
                              ? SEMANTIC.warning.text
                              : SEMANTIC.error.text,
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
  container: { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: COLORS.page,
  },
  loadingText: { color: COLORS.textSecondary, marginTop: 12, fontSize: 14 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.page,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon: { marginLeft: 12, marginRight: 0 },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.green.wash,
    alignItems: "center",
    justifyContent: "center",
  },

  tabBar: {
    flexDirection:   "row",
    backgroundColor: COLORS.surface,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
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
  tabActive: { borderBottomColor: ACCENT.green.base },
  tabText: { fontSize: 14, color: COLORS.textSubtle, fontWeight: "600" },
  tabTextActive: { color: ACCENT.green.deep },

  scroll: { padding: 16, paddingBottom: 40 },

  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: SEMANTIC.error.bg,
    borderRadius: 10,
    padding:         12,
    marginBottom:    16,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text },

  rateSummary: {
    flexDirection: "row",
    backgroundColor: ACCENT.green.wash,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 3,
    borderTopColor: ACCENT.green.base,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    alignItems: "center",
    shadowColor: COLORS.shadow,
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
    height: 80,
    backgroundColor: COLORS.border,
    marginHorizontal: 16,
  },
  rateLabel: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 18,
  },

  sectionTitle: {
    fontSize:     15,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: 12,
  },

  quickActions: {
    borderWidth:     1,
    ...tileShell("attendance"),
    borderRadius:    16,
    padding:         20,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  actionRow: {
    flexDirection: "row",
    alignItems:    "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
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
  actionLabel: { fontSize: 14, fontWeight: "600", color: COLORS.text },
  actionSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },

  tableCard: {
    backgroundColor: ACCENT.green.wash,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 3,
    borderTopColor: ACCENT.green.base,
    borderRadius: 16,
    padding: 20,
    shadowColor: COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  tableRow: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tableHeader: {
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1.5,
  },
  tableRowToday: { backgroundColor: COLORS.surface, borderRadius: 8 },
  tableCell: {
    flex:      1,
    fontSize: 13,
    color: COLORS.text,
    textAlign: "center",
    fontWeight: "500",
  },
  tableCellDay: {
    flex:      1.2,
    textAlign: "left",
    fontWeight: "700",
    color: COLORS.text,
  },
  tableCellSub: {
    fontSize: 10,
    color: COLORS.textSecondary,
    fontWeight: "400",
  },
  tableCellRate: { fontWeight: "700" },
});