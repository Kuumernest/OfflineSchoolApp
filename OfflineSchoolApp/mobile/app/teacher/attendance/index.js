// app/teacher/attendance/index.js

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
} from "react-native";
import { useRouter }         from "expo-router";
import { Ionicons }          from "@expo/vector-icons";
import { useAuthStore }      from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";
import { getDatabase }       from "../../../src/db/database";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);
const DAYS     = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const formatDate = (d) => {
  const dt = new Date(d);
  return `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
};

// ─────────────────────────────────────────────────────────────
// FETCH TEACHER'S ASSIGNED CLASSES FROM SQLITE
// ─────────────────────────────────────────────────────────────

const getTeacherAssignedClasses = async (teacherId, schoolId) => {
  const { t } = useTranslation();
  try {
    const db = await getDatabase();

    const taCols = await db
      .getAllAsync(`PRAGMA table_info(teacher_assignments)`, [])
      .catch(() => []);
    const taColNames = new Set(taCols.map((c) => c.name));

    const tidCol = ["teacherId", "teacher_id"].find((c) => taColNames.has(c));
    const clsCol = ["classId",   "class_id"  ].find((c) => taColNames.has(c));
    const sidCol = ["schoolId",  "school_id" ].find((c) => taColNames.has(c));

    if (!tidCol || !clsCol) {
      console.warn("[getTeacherAssignedClasses] missing columns");
      return [];
    }

    const delFilter = taColNames.has("deleted_at")
      ? `AND (ta.deleted_at IS NULL OR ta.deleted_at = '')`
      : "";
    const sidFilter = sidCol && schoolId ? `AND ta.${sidCol} = ?` : "";
    const params    = sidCol && schoolId
      ? [String(teacherId), String(schoolId)]
      : [String(teacherId)];

    const rows = await db
      .getAllAsync(
        `SELECT DISTINCT
           c.id,
           c.name,
           c.level,
           c.section
         FROM teacher_assignments ta
         JOIN classes c ON c.id = ta.${clsCol}
         WHERE ta.${tidCol} = ?
           ${sidFilter}
           ${delFilter}
           AND (c.deleted_at IS NULL OR c.deleted_at = '')
           AND c.is_active = 1
         ORDER BY c.name ASC`,
        params
      )
      .catch(() => []);

    return rows.map((r) => {
                      return ({
      id:   r.id,
      name: r.name || t("attTeacher.unnamedClass"),
      sub:  [r.level, r.section].filter(Boolean).join(" · "),
    });
                    });
  } catch (err) {
    console.warn("[getTeacherAssignedClasses] failed:", err?.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────
// STAT PILL
// ─────────────────────────────────────────────────────────────

const StatPill = ({ label, value, color }) => (
  <View style={[pillS.pill, { backgroundColor: color + "15" }]}>
    <Text style={[pillS.val, { color }]}>{value}</Text>
    <Text style={pillS.lbl}>{label}</Text>
  </View>
);

const pillS = StyleSheet.create({
  pill: { flex: 1, borderRadius: 10, padding: 10, alignItems: "center", gap: 2 },
  val:  { fontSize: 18, fontWeight: "800" },
  lbl:  { fontSize: 9, color: "#6B7280", fontWeight: "600", textTransform: "uppercase" },
});

// ─────────────────────────────────────────────────────────────
// CLASS CARD
// ─────────────────────────────────────────────────────────────

const ClassCard = ({ cls, summary, onMark, onReport }) => {
  const { t } = useTranslation();
  const rate  = summary?.rate  ?? 0;
  const color = rate >= 75 ? "#059669" : rate >= 50 ? "#D97706" : "#DC2626";

  return (
    <View style={[cardS.card, { borderLeftColor: color, borderLeftWidth: 4 }]}>
      <View style={cardS.header}>
        <View style={{ flex: 1 }}>
          <Text style={cardS.name}>{cls.name}</Text>
          {!!cls.sub && <Text style={cardS.sub}>{cls.sub}</Text>}
          <Text style={cardS.meta}>
            {summary?.marked ?? 0} of {summary?.total ?? 0} marked today
          </Text>
        </View>

        <View style={[cardS.rateBadge, { backgroundColor: color + "15" }]}>
          <Text style={[cardS.rateNum, { color }]}>{rate}%</Text>
          <Text style={[cardS.rateLbl, { color }]}>rate</Text>
        </View>
      </View>

      <View style={cardS.barBg}>
        <View
          style={[
            cardS.barFill,
            { width: `${Math.min(rate, 100)}%`, backgroundColor: color },
          ]}
        />
      </View>

      <View style={cardS.pills}>
        <StatPill label={t("attStatus.present")}  value={summary?.present  ?? 0} color="#059669" />
        <StatPill label={t("attStatus.absent")}   value={summary?.absent   ?? 0} color="#DC2626" />
        <StatPill label={t("attStatus.late")}     value={summary?.late     ?? 0} color="#D97706" />
        <StatPill label={t("attStatus.unmarked")} value={summary?.unmarked ?? 0} color="#9CA3AF" />
      </View>

      <View style={cardS.actions}>
        <TouchableOpacity
          style={[cardS.btn, { backgroundColor: "#4F46E5" }]}
          onPress={() => onMark(cls)}
          activeOpacity={0.8}
        >
          <Ionicons name="create-outline" size={15} color="#FFF" />
          <Text style={cardS.btnText}>{t("attTeacher.markAttendance")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[cardS.btn, cardS.btnOutline]}
          onPress={() => onReport(cls)}
          activeOpacity={0.8}
        >
          <Ionicons name="bar-chart-outline" size={15} color="#4F46E5" />
          <Text style={[cardS.btnText, { color: "#4F46E5" }]}>{t("attTeacher.report")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const cardS = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  header: {
    flexDirection: "row",
    alignItems:    "flex-start",
    marginBottom:  10,
    gap:           10,
  },
  name:      { fontSize: 16, fontWeight: "700", color: "#111827" },
  sub:       { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  meta:      { fontSize: 12, color: "#6B7280", marginTop: 4 },
  rateBadge: { alignItems: "center", borderRadius: 10, padding: 10, minWidth: 56 },
  rateNum:   { fontSize: 20, fontWeight: "800" },
  rateLbl:   { fontSize: 9, fontWeight: "600", textTransform: "uppercase" },
  barBg: {
    height:          6,
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
    marginBottom:    12,
  },
  barFill:    { height: 6, borderRadius: 3 },
  pills:      { flexDirection: "row", gap: 6, marginBottom: 12 },
  actions:    { flexDirection: "row", gap: 8 },
  btn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    borderRadius:    10,
    paddingVertical: 9,
  },
  btnOutline: {
    backgroundColor: "transparent",
    borderWidth:     1.5,
    borderColor:     "#4F46E5",
  },
  btnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
});

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function TeacherAttendanceScreen() {
  const { t } = useTranslation();
  const router    = useRouter();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;
  const today     = useMemo(() => todayStr(), []);

  const [classes,    setClasses]    = useState([]);
  const [summaries,  setSummaries]  = useState({});
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  // ── Load ─────────────────────────────────────────────────

  const loadData = useCallback(async (isRefresh = false) => {
    if (!teacherId || !schoolId) {
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      // 1. Get teacher's assigned classes from SQLite
      const assignedClasses = await getTeacherAssignedClasses(
        teacherId,
        schoolId
      );
      setClasses(assignedClasses);

      if (!assignedClasses.length) return;

      // 2. Fetch today's summary for each class in parallel
      const summaryMap = {};

      await Promise.all(
        assignedClasses.map(async (cls) => {
          try {
            const data = await AttendanceService.getStudentAttendanceToday(
              cls.id,
              schoolId
            );

            const s       = data?.summary || {};
            const total   = s.total   ?? 0;
            const present = s.present ?? 0;
            const marked  = s.marked  ?? 0;

            summaryMap[cls.id] = {
              total,
              marked,
              present,
              absent:   s.absent  ?? 0,
              late:     s.late    ?? 0,
              excused:  s.excused ?? 0,
              unmarked: Math.max(0, total - marked),
              rate:     total > 0 ? Math.round((present / total) * 100) : 0,
            };
          } catch {
            summaryMap[cls.id] = {
              total: 0, marked: 0, present: 0,
              absent: 0, late: 0, excused: 0,
              unmarked: 0, rate: 0,
            };
          }
        })
      );

      setSummaries(summaryMap);
    } catch (err) {
      console.error("[TeacherAttendance] loadData failed:", err?.message);
      setError(t("attTeacher.loadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, schoolId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Totals across all classes ─────────────────────────────

  const totals = useMemo(() => {
    const t = { total: 0, marked: 0, present: 0, absent: 0, late: 0, unmarked: 0 };
    for (const s of Object.values(summaries)) {
      t.total    += s.total    ?? 0;
      t.marked   += s.marked   ?? 0;
      t.present  += s.present  ?? 0;
      t.absent   += s.absent   ?? 0;
      t.late     += s.late     ?? 0;
      t.unmarked += s.unmarked ?? 0;
    }
    t.rate = t.total > 0 ? Math.round((t.present / t.total) * 100) : 0;
    return t;
  }, [summaries]);

  // ── Navigation ────────────────────────────────────────────

  const handleMark = useCallback((cls) => {
    router.push({
      pathname: "/teacher/attendance/mark",
      params:   { classId: cls.id, className: cls.name },
    });
  }, [router]);

  const handleReport = useCallback((cls) => {
    router.push({
      pathname: "/teacher/attendance/report",
      params:   { classId: cls.id, className: cls.name },
    });
  }, [router]);

  // ── Loading ───────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("attTeacher.loading")}</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────

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
          <Text style={styles.headerTitle}>{t("attTeacher.title")}</Text>
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

        {/* Overall summary card */}
        {classes.length > 0 && (
          <View style={styles.overallCard}>
            <Text style={styles.overallTitle}>
              My Classes Today — {classes.length} class
              {classes.length !== 1 ? "es" : ""}
            </Text>

            <View style={styles.overallPills}>
              <StatPill label={t("common.total")}   value={totals.total}   color="#6B7280" />
              <StatPill label={t("attStatus.present")} value={totals.present} color="#059669" />
              <StatPill label={t("attStatus.absent")}  value={totals.absent}  color="#DC2626" />
              <StatPill label={t("attStatus.late")}    value={totals.late}    color="#D97706" />
            </View>

            <View style={styles.overallBarBg}>
              <View
                style={[
                  styles.overallBarFill,
                  {
                    width: `${Math.min(totals.rate, 100)}%`,
                    backgroundColor:
                      totals.rate >= 75
                        ? "#059669"
                        : totals.rate >= 50
                        ? "#D97706"
                        : "#DC2626",
                  },
                ]}
              />
            </View>

            <Text style={styles.overallRate}>
              {totals.rate}% overall attendance rate
            </Text>
          </View>
        )}

        {/* Per-class cards */}
        {classes.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="school-outline" size={56} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>{t("attTeacher.noClasses")}</Text>
            <Text style={styles.emptySub}>
              {t("attTeacher.noClassesHint")}
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>{t("attTeacher.yourClasses")}</Text>
            {classes.map((cls) => (
              <ClassCard
                key={cls.id}
                cls={cls}
                summary={summaries[cls.id]}
                onMark={handleMark}
                onReport={handleReport}
              />
            ))}
          </>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
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
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 13, color: "#6B7280", marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },

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

  overallCard: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    20,
    shadowColor:     "#000",
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  overallTitle:  { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 12 },
  overallPills:  { flexDirection: "row", gap: 6, marginBottom: 12 },
  overallBarBg: {
    height:          8,
    backgroundColor: "#F3F4F6",
    borderRadius:    4,
    overflow:        "hidden",
    marginBottom:    8,
  },
  overallBarFill: { height: 8, borderRadius: 4 },
  overallRate:   { fontSize: 12, color: "#6B7280", textAlign: "center", fontWeight: "600" },

  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 12 },

  empty: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   80,
    gap:               12,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#374151", textAlign: "center" },
  emptySub:   { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";