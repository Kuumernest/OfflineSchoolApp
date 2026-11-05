// app/teacher/attendance/mark.js

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
  Alert,
  StatusBar,
  RefreshControl,
  ScrollView,
  TextInput,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }          from "@expo/vector-icons";
import { useAuthStore }      from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";
import { PeriodsService }    from "../../../src/services/periods.service";
import { fetchTeacherScope } from "../../../src/services/teacherScope.service";
import { resolveRegisterTarget } from "../../../src/utils/attendanceReminders";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Each status in its tone: present success, absent error, late warning,
// excused info. `color` is the solid fill (white icon on it); `tone` the tint.
const STATUS_OPTIONS = [
  { value: "present", labelKey: "attStatus.present", color: ACCENT.green.solid, tone: SEMANTIC.success, icon: "checkmark-circle" },
  { value: "absent",  labelKey: "attStatus.absent",  color: ACCENT.red.solid,   tone: SEMANTIC.error,   icon: "close-circle"     },
  { value: "late",    labelKey: "attStatus.late",    color: ACCENT.amber.solid, tone: SEMANTIC.warning, icon: "time"             },
  { value: "excused", labelKey: "attStatus.excused", color: ACCENT.blue.solid,  tone: SEMANTIC.info,    icon: "shield-checkmark" },
];
const STATUS_TONE = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.tone]));

const todayStr = () => new Date().toISOString().slice(0, 10);
const DAYS     = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const formatDate = (d) => {
  const dt = new Date(d);
  return `${DAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
};

// ─────────────────────────────────────────────────────────────
// STUDENT ROW
// ─────────────────────────────────────────────────────────────

const StudentRow = React.memo(({ item, currentStatus, wasMarked, onToggle }) => {
  const { t } = useTranslation();
  const statusColor = STATUS_OPTIONS.find(
    (o) => o.value === currentStatus
  )?.color;
  const statusTone = STATUS_TONE[currentStatus];

  return (
    <View
      style={[
        rowS.row,
        currentStatus && {
          borderLeftWidth: 3,
          borderLeftColor: statusColor,
        },
      ]}
    >
      {/* Avatar */}
      <View
        style={[
          rowS.avatar,
          statusTone && { backgroundColor: statusTone.box },
        ]}
      >
        <Text style={[rowS.avatarText, statusTone && { color: statusTone.text }]}>
          {(item.student.studentName || item.student.name || "?")
            .charAt(0)
            .toUpperCase()}
        </Text>
      </View>

      {/* Name + admission */}
      <View style={rowS.info}>
        <View style={rowS.nameRow}>
          <Text style={rowS.name} numberOfLines={1}>
            {item.student.studentName || item.student.name || t("attTeacher.unknown")}
          </Text>
          {wasMarked && (
            <View style={rowS.savedBadge}>
              <Text style={rowS.savedBadgeText}>✓ saved</Text>
            </View>
          )}
        </View>
        <Text style={rowS.sub} numberOfLines={1}>
          {item.student.admissionNo
            ? `#${item.student.admissionNo}`
            : item.student.email || ""}
        </Text>
      </View>

      {/* Status buttons */}
      <View style={rowS.statusButtons}>
        {STATUS_OPTIONS.map((opt) => {
          const isActive = currentStatus === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[
                rowS.statusBtn,
                isActive
                  ? { backgroundColor: opt.color, borderColor: opt.color }
                  : { backgroundColor: COLORS.surface, borderColor: COLORS.border },
              ]}
              onPress={() => onToggle(String(item.student._id), opt.value)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={opt.icon}
                size={16}
                color={isActive ? COLORS.onPrimary : opt.tone.icon}
              />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
});

const rowS = StyleSheet.create({
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: COLORS.surface,
    borderRadius:    12,
    padding:         12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    gap:             10,
  },
  avatar: {
    width:           40,
    height:          40,
    borderRadius:    20,
    backgroundColor: ACCENT.blue.wash,
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText:    { fontSize: 16, fontWeight: "800", color: ACCENT.blue.deep },
  info:          { flex: 1 },
  nameRow:       { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  name:          { fontSize: 14, fontWeight: "700", color: COLORS.text },
  savedBadge: {
    backgroundColor:   SEMANTIC.success.bg,
    borderWidth:       1,
    borderColor:       SEMANTIC.success.icon + "4D",
    borderRadius:      4,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  savedBadgeText: { fontSize: 9, color: SEMANTIC.success.text, fontWeight: "700" },
  sub:            { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  statusButtons:  { flexDirection: "row", gap: 5 },
  statusBtn: {
    width:          30,
    height:         30,
    borderRadius:   8,
    borderWidth:    1.5,
    alignItems:     "center",
    justifyContent: "center",
  },
});

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function TeacherMarkAttendanceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams();
  const user   = useAuthStore((s) => s.user);

  const schoolId  = user?.schoolId;
  const teacherId = user?._id || user?.id || user?.userId;
  const today     = useMemo(() => todayStr(), []);

  // ── Which register this screen opens ──────────────────────────────────────
  // Decided once, in order: the route's parameters → the teacher's canonical
  // scope (teacherScope.service, the server's assignments, cached for
  // offline) → the class this teacher may open, on the date the route named.
  // Nothing below loads a roster until this is settled, so the screen cannot
  // run its query with no class and then never recover. A teacher whose scope
  // does not list the class — a stale reminder, a route typed by hand — is
  // shown a safe state; the server would refuse the save regardless.
  const [target, setTarget] = useState(null);
  const paramClassId   = params.classId   ? String(params.classId)   : null;
  const paramClassName = params.className ? String(params.className) : null;
  const paramDate      = params.date      ? String(params.date)      : null;
  const paramPeriodId  = params.periodId  ? String(params.periodId)  : null;

  useEffect(() => {
    let live = true;
    (async () => {
      let scope = null;
      if (teacherId) {
        try { scope = await fetchTeacherScope({ teacherId, schoolId }); }
        catch (err) { console.warn("[TeacherMark] scope failed:", err?.message); }
      }
      if (!live) return;
      setTarget(resolveRegisterTarget({
        params: { classId: paramClassId, className: paramClassName, date: paramDate, periodId: paramPeriodId },
        scope, role: user?.role, today,
      }));
    })();
    return () => { live = false; };
  }, [paramClassId, paramClassName, paramDate, paramPeriodId, teacherId, schoolId, user?.role, today]);

  const classId   = target?.authorized ? target.classId : null;
  const className = target?.className || paramClassName || t("attTeacher.klass");
  const date      = target?.date || today;

  const [roster,     setRoster]     = useState([]);
  const [attendance, setAttendance] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");
  const [error,      setError]      = useState(null);
  const [periods,    setPeriods]    = useState([]);
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [rosterSource, setRosterSource] = useState(null);   // "api" | "local"
  const [rosterKnown,  setRosterKnown]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await PeriodsService.getAll();
        if (cancelled) return;
        setPeriods(data || []);
        // A reminder names the period its class sat; preselect it when the
        // school's periods include it.
        if (paramPeriodId && (data || []).some((p) => String(p.id) === paramPeriodId)) {
          setSelectedPeriod(paramPeriodId);
        }
      } catch (err) {
        console.warn("Failed to load periods:", err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [paramPeriodId]);

  const loadRoster = useCallback(async (isRefresh = false) => {
    if (!target) return;                       // still resolving the class
    if (!classId || !schoolId) {
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const data = await AttendanceService.getStudentAttendanceForDate(
        classId,
        schoolId,
        date,
        selectedPeriod
      );

      const rosterData = data?.roster || [];
      setRosterSource(data?.source || "api");
      setRosterKnown(data?.rosterKnown !== false);
      setRoster(rosterData);

      const existing = {};
      for (const row of rosterData) {
        if (row.attendance?.status) {
          existing[String(row.student._id)] = row.attendance.status;
        }
      }
      setAttendance(existing);
    } catch (err) {
      console.error("[TeacherMark] loadRoster failed:", err?.message);
      setError(t("attTeacher.loadStudentsPull"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [target, classId, schoolId, date, selectedPeriod, t]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const toggleStatus = useCallback((studentId, status) => {
    setAttendance((prev) => {
      if (prev[studentId] === status) {
        const next = { ...prev };
        delete next[studentId];
        return next;
      }
      return { ...prev, [studentId]: status };
    });
  }, []);

  const markAll = useCallback((status) => {
    const all = {};
    for (const row of roster) {
      all[String(row.student._id)] = status;
    }
    setAttendance(all);
  }, [roster]);

  const handleSave = useCallback(async () => {
    const records = Object.entries(attendance).map(
      ([studentId, status]) => ({ studentId, status })
    );

    if (!records.length) {
      Alert.alert(
        t("attTeacher.nothingTitle"),
        t("attTeacher.markOneFirst")
      );
      return;
    }

    const unmarked = roster.length - records.length;

    const doSave = async () => {
      try {
        setSaving(true);
        await AttendanceService.markClassAttendanceBulk({
          schoolId,
          classId,
          periodId: selectedPeriod || undefined,
          date,
          records,
        });

        Alert.alert(
          t("attTeacher.savedTitle"),
          t("attTeacher.savedFor", { count: records.length }) +
          (unmarked > 0
            ? `\n${t("attTeacher.notMarked", { count: unmarked })}`
            : ""),
          [{ text: "OK", onPress: () => router.back() }]
        );
      } catch (err) {
        Alert.alert(t("attTeacher.saveFailedTitle"), errorText(t, err, "attTeacher.tryAgain"));
      } finally {
        setSaving(false);
      }
    };

    if (unmarked > 0) {
      Alert.alert(
        t("attTeacher.unmarkedTitle"),
        t("attTeacher.unmarkedConfirm", { count: unmarked }),
        [
          { text: t("common.cancel"),      style: "cancel" },
          { text: t("attTeacher.saveAnyway"), onPress: doSave  },
        ]
      );
    } else {
      doSave();
    }
  }, [attendance, roster.length, t, schoolId, classId, selectedPeriod, date, router]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return roster;
    return roster.filter((row) => {
      const name  = (row.student.studentName || row.student.name || "").toLowerCase();
      const email = (row.student.email || "").toLowerCase();
      const adm   = (row.student.admissionNo || "").toLowerCase();
      return name.includes(q) || email.includes(q) || adm.includes(q);
    });
  }, [roster, search]);

  const markedCount  = Object.keys(attendance).length;
  const presentCount = Object.values(attendance).filter((s) => s === "present").length;
  const absentCount  = Object.values(attendance).filter((s) => s === "absent").length;
  const lateCount    = Object.values(attendance).filter((s) => s === "late").length;
  const excusedCount = Object.values(attendance).filter((s) => s === "excused").length;
  const pct = roster.length > 0
    ? Math.round((markedCount / roster.length) * 100)
    : 0;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attTeacher.loadingStudents")}</Text>
      </View>
    );
  }

  // The class the route named is not one this teacher may open — or the
  // route named none. A safe state, not a register the server would refuse.
  if (target && !target.authorized) {
    const noClass = target.reason === "no_class";
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <HeaderIcon style={styles.headerIcon} />
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>{className}</Text>
            <Text style={styles.headerSub}>{formatDate(date)}</Text>
          </View>
          <View style={{ width: 64 }} />
        </View>
        <View style={styles.empty}>
          <IconSquare icon={noClass ? "school-outline" : "lock-closed-outline"} accent="green" size={56} radius={16} />
          <Text style={styles.emptyTitle}>
            {t(noClass ? "attTeacher.noClassTitle" : "attTeacher.notAssignedTitle")}
          </Text>
          <Text style={styles.emptySub}>
            {t(noClass ? "attTeacher.noClassBody" : "attTeacher.notAssignedBody")}
          </Text>
          <TouchableOpacity
            style={[styles.saveBtn, { marginTop: 16 }]}
            onPress={() => router.replace("/teacher/attendance")}
            activeOpacity={0.8}
          >
            <Text style={styles.saveBtnText}>{t("attTeacher.backToClasses")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      {/* Header */}
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
          <Text style={styles.headerTitle} numberOfLines={1}>
            {className}
          </Text>
          <Text style={styles.headerSub}>{formatDate(date)}</Text>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color={COLORS.onPrimary} />
          ) : (
            <Text style={styles.saveBtnText}>{t("common.save")}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Error */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle" size={16} color={SEMANTIC.error.icon} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadRoster()}>
            <Text style={styles.errorRetry}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Period selector */}
      {periods.length > 0 && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            <TouchableOpacity
              style={[styles.periodChip, !selectedPeriod && styles.periodChipActive]}
              onPress={() => setSelectedPeriod(null)}
              activeOpacity={0.7}
            >
              <Text style={[styles.periodChipText, !selectedPeriod && styles.periodChipTextActive]}>
                {t("attAdmin.allPeriods")}
              </Text>
            </TouchableOpacity>
            {periods.filter(p => p.isActive !== false).map((p) => (
              <TouchableOpacity
                key={p.id}
                style={[styles.periodChip, selectedPeriod === p.id && styles.periodChipActive]}
                onPress={() => setSelectedPeriod(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[styles.periodChipText, selectedPeriod === p.id && styles.periodChipTextActive]}>
                  {p.name}
                </Text>
                {!!p.startTime && (
                  <Text style={[styles.periodChipTime, selectedPeriod === p.id && styles.periodChipTimeActive]}>
                    {p.startTime}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Progress bar */}
      <View style={styles.progress}>
        <View style={styles.progressInfo}>
          <Text style={styles.progressText}>
            {markedCount} / {roster.length} marked
          </Text>
          <Text style={styles.progressPct}>{pct}%</Text>
        </View>
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${pct}%` }]} />
        </View>
        <View style={styles.statusCounts}>
          {/*
            * labelKey, not label. These four carried `label: "P"` and were
            * rendered with t(s.labelKey) — t(undefined), which i18n-js prints
            * as [missing "en." translation]. Four of those sat across the top
            * of the register, in front of whoever was taking it.
            *
            * The abbreviations are translated rather than hard-coded because
            * they are not the same letters in both languages: late is R for
            * retard and excused is J for justifié.
            */}
          {[
            { labelKey: "attAdmin.abbrPresent", value: presentCount, tone: SEMANTIC.success },
            { labelKey: "attAdmin.abbrAbsent",  value: absentCount,  tone: SEMANTIC.error },
            { labelKey: "attAdmin.abbrLate",    value: lateCount,    tone: SEMANTIC.warning },
            { labelKey: "attAdmin.abbrExcused", value: excusedCount, tone: SEMANTIC.info },
          ].map((s) => (
            <View
              // The key was s.value — four counts that all start at 0, so React
              // saw four children with the same key on first render.
              key={s.labelKey}
              style={[styles.countChip, { backgroundColor: s.tone.bg, borderColor: s.tone.icon + "4D" }]}
            >
              <Text style={[styles.countVal, { color: s.tone.text }]}>{s.value}</Text>
              <Text style={[styles.countLbl, { color: s.tone.text }]}>{t(s.labelKey)}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Mark all row */}
      <View style={styles.markAllRow}>
        <Text style={styles.markAllLabel}>{t("attTeacher.markAllColon")}</Text>
        {STATUS_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.markAllBtn,
              { backgroundColor: opt.tone.bg, borderColor: opt.tone.icon + "4D" },
            ]}
            onPress={() => markAll(opt.value)}
            activeOpacity={0.7}
          >
            <Ionicons name={opt.icon} size={12} color={opt.tone.text} />
            <Text style={[styles.markAllBtnText, { color: opt.tone.text }]}>
              {t(opt.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={16} color={COLORS.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder={t("attTeacher.searchStudentPh")}
          placeholderTextColor={COLORS.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!search && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Student list */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.student._id)}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadRoster(true)}
            tintColor={ACCENT.green.solid}
            colors={[ACCENT.green.solid]}
          />
        }
        renderItem={({ item }) => (
          <StudentRow
            item={item}
            currentStatus={attendance[String(item.student._id)]}
            wasMarked={!!item.attendance?.status}
            onToggle={toggleStatus}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        ListEmptyComponent={
          // A roster the phone does not hold is not a class with no pupils.
          // Offline with no students for this school downloaded, the screen
          // says so, instead of "no students enrolled".
          <View style={styles.empty}>
            <IconSquare
              icon={!error && !search && rosterSource === "local" && !rosterKnown ? "cloud-offline-outline" : "people-outline"}
              accent="green" size={56} radius={16}
            />
            <Text style={styles.emptyTitle}>
              {error
                ? t("attTeacher.loadStudentsFailed")
                : search
                ? t("attTeacher.noStudentMatch")
                : rosterSource === "local" && !rosterKnown
                ? t("attTeacher.offlineNoRosterTitle")
                : t("attTeacher.noStudents")}
            </Text>
            {!error && !search && (
              <Text style={styles.emptySub}>
                {rosterSource === "local" && !rosterKnown
                  ? t("attTeacher.offlineNoRosterBody")
                  : t("attTeacher.enrolFirst")}
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: COLORS.page,
  },
  loadingText: { fontSize: 14, color: COLORS.textSecondary, marginTop: 12 },
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
  headerTitle:  { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  saveBtn: {
    backgroundColor:   ACCENT.green.solid,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 18,
    minWidth:          60,
    alignItems:        "center",
  },
  saveBtnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },
  errorBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   SEMANTIC.error.bg,
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
  },
  errorText:  { flex: 1, fontSize: 13, color: SEMANTIC.error.text },
  errorRetry: { fontSize: 13, color: SEMANTIC.error.text, fontWeight: "700", textDecorationLine: "underline" },
  progress: {
    backgroundColor:   COLORS.surface,
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  progressInfo: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   6,
  },
  progressText:  { fontSize: 13, color: COLORS.text, fontWeight: "600" },
  progressPct:   { fontSize: 13, color: ACCENT.green.deep, fontWeight: "700" },
  progressBarBg: {
    height:          6,
    backgroundColor: COLORS.border,
    borderRadius:    3,
    overflow:        "hidden",
    marginBottom:    10,
  },
  progressBarFill: { height: 6, backgroundColor: ACCENT.green.base, borderRadius: 3 },
  statusCounts:    { flexDirection: "row", gap: 8 },
  countChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      8,
    borderWidth:       1,
  },
  countVal: { fontSize: 13, fontWeight: "800" },
  countLbl: { fontSize: 11, fontWeight: "600" },
  markAllRow: {
    flexDirection:     "row",
    alignItems:        "center",
    flexWrap:          "wrap",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               8,
  },
  markAllLabel:   { fontSize: 12, color: COLORS.textSecondary, fontWeight: "600" },
  markAllBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    borderWidth:       1,
    borderRadius:      8,
    paddingVertical:   5,
    paddingHorizontal: 8,
  },
  markAllBtnText: { fontSize: 11, fontWeight: "700" },
  searchBox: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   COLORS.surface,
    borderRadius:      10,
    paddingHorizontal: 12,
    height:            40,
    borderWidth:       1,
    borderColor:       COLORS.border,
    gap:               8,
    margin:            12,
    marginBottom:      6,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text },
  list:  { padding: 12, paddingTop: 8, paddingBottom: 40 },
  empty: { alignItems: "center", paddingVertical: 60, gap: 10 },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: COLORS.text, textAlign: "center" },
  emptySub:   { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
  periodChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  // A period is teal: the selected chip takes its wash, deep text, base border.
  periodChipActive: {
    backgroundColor: ACCENT.teal.wash,
    borderColor: ACCENT.teal.base,
  },
  periodChipText: { fontSize: 13, fontWeight: "600", color: COLORS.textSecondary },
  periodChipTextActive: { color: ACCENT.teal.deep },
  periodChipTime: { fontSize: 11, color: COLORS.textSecondary },
  periodChipTimeActive: { color: ACCENT.teal.deep },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";