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
import { getTeacherClasses } from "../../../src/services/teacherScope.service";
import { COLORS, ACCENT, SEMANTIC, levelAccent, accentBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

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

// The classes this teacher teaches, from the one place that knows: the
// server's TeacherAssignment rows through teacherScope.service, cached for
// offline. The mirror's teacher_assignments ⋈ classes join below is what this
// screen used to read; a teacher's mirror does not receive those rows (the
// sync feed excludes them for the role), so offline it listed nothing. It is
// kept as the last resort for a phone never online since the scope shipped.
const getTeacherAssignedClasses = async (teacherId, schoolId, t) => {
  try {
    const classes = await getTeacherClasses(teacherId, schoolId);
    if (classes.length) {
      return classes.map((c) => ({
        id:   String(c.id),
        name: c.name || t("attTeacher.unnamedClass"),
        sub:  [c.level, c.section].filter(Boolean).join(" · "),
      }));
    }
  } catch (err) {
    console.warn("[getTeacherAssignedClasses] scope failed:", err?.message);
  }
  return getTeacherAssignedClassesFromMirror(teacherId, schoolId, t);
};

const getTeacherAssignedClassesFromMirror = async (teacherId, schoolId, t) => {
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

// Status pills: present success, absent error, late warning; a count with
// no status (total, unmarked) in slate. Never grey.
const PILL = {
  present:  statusPill("success"),
  absent:   statusPill("error"),
  late:     statusPill("warning"),
  neutral:  { bg: accentBadge("slate").bg, text: accentBadge("slate").text, border: accentBadge("slate").border },
};
function statusPill(tone) {
  return { bg: SEMANTIC[tone].bg, text: SEMANTIC[tone].text, border: SEMANTIC[tone].icon + "4D" };
}
/** A rate's tone: 75%+ success, 50%+ warning, below that error. */
const rateTone = (rate) => (rate >= 75 ? "success" : rate >= 50 ? "warning" : "error");

const StatPill = ({ label, value, pal }) => (
  <View style={[pillS.pill, { backgroundColor: pal.bg, borderColor: pal.border }]}>
    <Text style={[pillS.val, { color: pal.text }]}>{value}</Text>
    <Text style={pillS.lbl}>{label}</Text>
  </View>
);

const pillS = StyleSheet.create({
  pill: { flex: 1, borderRadius: 10, padding: 10, alignItems: "center", gap: 2, borderWidth: 1 },
  val:  { fontSize: 18, fontWeight: "800" },
  lbl:  { fontSize: 9, color: COLORS.textSecondary, fontWeight: "600", textTransform: "uppercase" },
});

// ─────────────────────────────────────────────────────────────
// CLASS CARD
// ─────────────────────────────────────────────────────────────

const ClassCard = ({ cls, summary, onMark, onReport }) => {
  const { t } = useTranslation();
  const rate  = summary?.rate  ?? 0;
  const tone  = SEMANTIC[rateTone(rate)];
  const color = tone.text;
  const accent = levelAccent(cls.sub || cls.name);
  const tint   = ACCENT[accent];

  return (
    <View style={[cardS.card, { backgroundColor: tint.wash, borderTopColor: tint.base }]}>
      <View style={cardS.header}>
        <IconSquare icon="school" accent={accent} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={cardS.name}>{cls.name}</Text>
          {!!cls.sub && <Text style={cardS.sub}>{cls.sub}</Text>}
          <Text style={cardS.meta}>
            {t("attAdmin.markedOfTotalToday", { marked: summary?.marked ?? 0, total: summary?.total ?? 0 })}
          </Text>
        </View>

        <View style={[cardS.rateBadge, { backgroundColor: tone.bg, borderColor: tone.icon + "4D" }]}>
          <Text style={[cardS.rateNum, { color }]}>{rate}%</Text>
          <Text style={[cardS.rateLbl, { color }]}>rate</Text>
        </View>
      </View>

      <View style={cardS.barBg}>
        <View
          style={[
            cardS.barFill,
            { width: `${Math.min(rate, 100)}%`, backgroundColor: tone.icon },
          ]}
        />
      </View>

      <View style={cardS.pills}>
        <StatPill label={t("attStatus.present")}  value={summary?.present  ?? 0} pal={PILL.present} />
        <StatPill label={t("attStatus.absent")}   value={summary?.absent   ?? 0} pal={PILL.absent} />
        <StatPill label={t("attStatus.late")}     value={summary?.late     ?? 0} pal={PILL.late} />
        <StatPill label={t("attStatus.unmarked")} value={summary?.unmarked ?? 0} pal={PILL.neutral} />
      </View>

      <View style={cardS.actions}>
        <TouchableOpacity
          style={[cardS.btn, { backgroundColor: ACCENT.green.solid }]}
          onPress={() => onMark(cls)}
          activeOpacity={0.8}
        >
          <Ionicons name="create-outline" size={15} color={COLORS.onPrimary} />
          <Text style={cardS.btnText}>{t("attTeacher.markAttendance")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[cardS.btn, cardS.btnOutline]}
          onPress={() => onReport(cls)}
          activeOpacity={0.8}
        >
          <Ionicons name="bar-chart-outline" size={15} color={ACCENT.green.deep} />
          <Text style={[cardS.btnText, { color: ACCENT.green.deep }]}>{t("attTeacher.report")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const cardS = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    shadowColor:     COLORS.shadow,
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
  name:      { fontSize: 16, fontWeight: "700", color: COLORS.text },
  sub:       { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  meta:      { fontSize: 12, color: COLORS.textSecondary, marginTop: 4 },
  rateBadge: { alignItems: "center", borderRadius: 10, padding: 10, minWidth: 56, borderWidth: 1 },
  rateNum:   { fontSize: 20, fontWeight: "800" },
  rateLbl:   { fontSize: 9, fontWeight: "600", textTransform: "uppercase" },
  barBg: {
    height:          6,
    backgroundColor: COLORS.border,
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
    backgroundColor: COLORS.surface,
    borderWidth:     1.5,
    borderColor:     ACCENT.green.base,
  },
  btnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 13 },
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
        schoolId,
        t
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
  }, [teacherId, schoolId, t]);

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
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attTeacher.loading")}</Text>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────

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
          <Text style={styles.headerTitle}>{t("attTeacher.title")}</Text>
          <Text style={styles.headerSub}>{formatDate(today)}</Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => loadData(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={20} color={ACCENT.green.solid} />
        </TouchableOpacity>
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

        {/* Overall summary card */}
        {classes.length > 0 && (
          <View style={styles.overallCard}>
            <Text style={styles.overallTitle}>
              {t("attTeacher.myClassesToday", { count: classes.length })}
            </Text>

            <View style={styles.overallPills}>
              <StatPill label={t("common.total")}   value={totals.total}   pal={PILL.neutral} />
              <StatPill label={t("attStatus.present")} value={totals.present} pal={PILL.present} />
              <StatPill label={t("attStatus.absent")}  value={totals.absent}  pal={PILL.absent} />
              <StatPill label={t("attStatus.late")}    value={totals.late}    pal={PILL.late} />
            </View>

            <View style={styles.overallBarBg}>
              <View
                style={[
                  styles.overallBarFill,
                  {
                    width: `${Math.min(totals.rate, 100)}%`,
                    backgroundColor: SEMANTIC[rateTone(totals.rate)].icon,
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
            <IconSquare icon="school-outline" accent="green" size={56} radius={16} />
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
    backgroundColor: ACCENT.slate.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:   { marginLeft: 12, marginRight: 0 },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  refreshBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: ACCENT.green.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },

  scroll: { padding: 16, paddingBottom: 40 },

  errorBanner: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: SEMANTIC.error.bg,
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
    gap:             8,
  },
  errorText: { flex: 1, fontSize: 13, color: SEMANTIC.error.text },

  overallCard: {
    backgroundColor: ACCENT.green.wash,
    borderRadius:    16,
    padding:         16,
    marginBottom:    20,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.green.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.05,
    shadowRadius:    8,
    elevation:       2,
  },
  overallTitle:  { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 12 },
  overallPills:  { flexDirection: "row", gap: 6, marginBottom: 12 },
  overallBarBg: {
    height:          8,
    backgroundColor: COLORS.border,
    borderRadius:    4,
    overflow:        "hidden",
    marginBottom:    8,
  },
  overallBarFill: { height: 8, borderRadius: 4 },
  overallRate:   { fontSize: 12, color: ACCENT.green.deep, textAlign: "center", fontWeight: "600" },

  sectionTitle: { fontSize: 15, fontWeight: "700", color: COLORS.text, marginBottom: 12 },

  empty: {
    alignItems:        "center",
    justifyContent:    "center",
    paddingVertical:   80,
    gap:               12,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: COLORS.text, textAlign: "center" },
  emptySub:   { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";