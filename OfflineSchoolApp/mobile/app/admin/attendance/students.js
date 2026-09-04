// app/admin/attendance/students.js

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
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
import { useRouter } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useAuthStore }    from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";
import { PeriodsService }  from "../../../src/services/periods.service";
import api                 from "../../../src/services/api";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";

const STATUS_OPTIONS = [
  { value: "present", labelKey: "academic.present", color: "#059669", icon: "checkmark-circle" },
  { value: "absent",  labelKey: "academic.absent",  color: "#DC2626", icon: "close-circle"     },
  { value: "late",    labelKey: "academic.late",    color: "#D97706", icon: "time"             },
  { value: "excused", labelKey: "academic.excused", color: "#4F46E5", icon: "shield-checkmark" },
];

const todayStr = () => new Date().toISOString().slice(0, 10);

const formatDate = (d, t) => {
  const dt = new Date(d);
  return `${t(`attAdmin.day${dt.getDay()}`)}, ${t(`attAdmin.mon${dt.getMonth()}`)} ${dt.getDate()}`;
};

const PeriodSelector = ({ schoolId, selected, onSelect }) => {
  const { t } = useTranslation();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await PeriodsService.getAll();
        if (!cancelled) setPeriods(data || []);
      } catch (err) {
        console.warn("Failed to load periods:", err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [schoolId]);

  if (loading || periods.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6" }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: "#6B7280", marginBottom: 6 }}>
        {t("attAdmin.selectPeriod", "Select period")}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <TouchableOpacity
          style={[
            ps.chip,
            !selected && ps.chipActive,
          ]}
          onPress={() => onSelect(null)}
          activeOpacity={0.7}
        >
          <Text style={[ps.chipText, !selected && ps.chipTextActive]}>
            {t("attAdmin.allPeriods", "All")}
          </Text>
        </TouchableOpacity>
        {periods.filter(p => p.isActive !== false).map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[
              ps.chip,
              selected === p.id && ps.chipActive,
            ]}
            onPress={() => onSelect(p.id)}
            activeOpacity={0.7}
          >
            <Text style={[ps.chipText, selected === p.id && ps.chipTextActive]}>
              {p.name}
            </Text>
            {!!p.startTime && (
              <Text style={[ps.chipTime, selected === p.id && ps.chipTimeActive]}>
                {p.startTime}
              </Text>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const ps = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  chipActive: {
    backgroundColor: "#EEF2FF",
    borderColor: "#4F46E5",
  },
  chipText: { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  chipTextActive: { color: "#4F46E5" },
  chipTime: { fontSize: 11, color: "#9CA3AF" },
  chipTimeActive: { color: "#818CF8" },
});

const ClassSelector = ({ schoolId, onSelect }) => {
  const { t } = useTranslation();

  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");
  const [error,   setError]   = useState(null);

  const fetchClasses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await api.get("/admin/classes", {
        params: { schoolId },
      });

      const list =
        response.data?.classes ||
        response.data?.data    ||
        (Array.isArray(response.data) ? response.data : []);

      const active = list.filter((c) => c.isActive !== false);

      active.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      );

      setClasses(active);
    } catch (err) {
      console.error("fetchClasses failed:", err.message);
      setError(t("attAdmin.classesLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [schoolId, t]);

  useEffect(() => { fetchClasses(); }, [fetchClasses]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return classes;
    return classes.filter(
      (c) =>
        (c.name    || "").toLowerCase().includes(q) ||
        (c.level   || "").toLowerCase().includes(q) ||
        (c.section || "").toLowerCase().includes(q)
    );
  }, [classes, search]);

  if (loading) {
    return (
      <View style={cs.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={cs.loadingText}>{t("attAdmin.loadingClasses")}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={cs.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={cs.errorText}>{error}</Text>
        <TouchableOpacity style={cs.retryBtn} onPress={fetchClasses}>
          <Text style={cs.retryText}>{t("common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={cs.container}>
      <View style={cs.searchBox}>
        <Ionicons name="search-outline" size={16} color="#9CA3AF" />
        <TextInput
          style={cs.searchInput}
          placeholder={t("attAdmin.searchClass")}
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

      <Text style={cs.hint}>
        {filtered.length} class{filtered.length !== 1 ? "es" : ""} · tap to mark attendance
      </Text>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={cs.list}
      >
        {filtered.length === 0 ? (
          <View style={cs.empty}>
            <Ionicons name="school-outline" size={48} color="#D1D5DB" />
            <Text style={cs.emptyText}>
              {search ? t("attAdmin.noClassesMatch") : t("attAdmin.noClassesFound")}
            </Text>
          </View>
        ) : (
          filtered.map((cls) => {
            const name = cls.name || t("attAdmin.unnamedClass");
            const sub  = [cls.level, cls.section]
              .filter(Boolean)
              .join(" · ");

            return (
              <TouchableOpacity
                key={String(cls._id || cls.id)}
                style={cs.classCard}
                onPress={() =>
                  onSelect({
                    id:   String(cls._id || cls.id),
                    name,
                    sub,
                  })
                }
                activeOpacity={0.7}
              >
                <View style={cs.classIcon}>
                  <Ionicons name="school" size={22} color="#4F46E5" />
                </View>

                <View style={cs.classInfo}>
                  <Text style={cs.className}>{name}</Text>
                  {!!sub && <Text style={cs.classSub}>{sub}</Text>}
                </View>

                <Ionicons name="chevron-forward" size={20} color="#D1D5DB" />
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

const cs = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    gap:            12,
    padding:        32,
  },
  loadingText: { fontSize: 14, color: "#6B7280" },
  errorText:   { fontSize: 14, color: "#DC2626", textAlign: "center" },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
  },
  retryText:  { color: "#FFF", fontWeight: "700" },
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
    margin:            16,
    marginBottom:      8,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },
  hint: {
    fontSize:         13,
    color:            "#9CA3AF",
    marginHorizontal: 16,
    marginBottom:     12,
  },
  list:  { paddingHorizontal: 16, paddingBottom: 40, gap: 8 },
  empty: {
    alignItems:      "center",
    paddingVertical: 60,
    gap:             12,
  },
  emptyText:  { fontSize: 14, color: "#9CA3AF", textAlign: "center" },
  classCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  classIcon: {
    width:           48,
    height:          48,
    borderRadius:    12,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  classInfo: { flex: 1 },
  className: { fontSize: 15, fontWeight: "700", color: "#111827" },
  classSub:  { fontSize: 12, color: "#9CA3AF", marginTop: 3 },
});

const MarkAttendance = React.forwardRef(({
  schoolId,
  selectedClass,
  periodId,
  today,
  onSaved,
}, ref) => {
  const { t } = useTranslation();
  const [roster,     setRoster]     = useState([]);
  const [attendance, setAttendance] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");

  const loadRoster = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const data = await AttendanceService.getStudentAttendanceToday(
        selectedClass.id,
        schoolId,
        periodId
      );

      const rosterData = data?.roster || [];
      setRoster(rosterData);

      const existing = {};
      for (const row of rosterData) {
        if (row.attendance?.status) {
          existing[String(row.student._id)] = row.attendance.status;
        }
      }
      setAttendance(existing);

    } catch (err) {
      console.error("loadRoster failed:", err.message);
      Alert.alert(t("attAdmin.errorTitle"), t("attAdmin.loadRosterFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedClass.id, schoolId, periodId, t]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const handleSave = useCallback(async () => {
    const records = Object.entries(attendance).map(
      ([studentId, status]) => ({ studentId, status })
    );

    if (!records.length) {
      Alert.alert(t("attAdmin.nothingToSave"), t("attAdmin.markOneStudent"));
      return;
    }

    const unmarked = roster.length - records.length;

    const doSave = async () => {
      try {
        setSaving(true);
        await AttendanceService.markClassAttendanceBulk({
          schoolId,
          classId: selectedClass.id,
          periodId: periodId || undefined,
          date:    today,
          records,
        });

        Alert.alert(
          t("attAdmin.savedTitle"),
          `Attendance saved for ${records.length} student(s).${
            unmarked > 0 ? `\n${unmarked} student(s) not marked.` : ""
          }`,
          [{ text: "OK", onPress: onSaved }]
        );
      } catch (err) {
        Alert.alert(t("attAdmin.saveFailed"), errorText(t, err, "attAdmin.pleaseTryAgain"));
      } finally {
        setSaving(false);
      }
    };

    if (unmarked > 0) {
      Alert.alert(
        t("attAdmin.unmarkedStudentsTitle"),
        `${unmarked} student(s) have not been marked. Save anyway?`,
        [
          { text: "Cancel",      style: "cancel" },
          { text: t("attAdmin.saveAnyway"), onPress: doSave  },
        ]
      );
    } else {
      doSave();
    }
  }, [attendance, roster.length, t, schoolId, selectedClass.id, periodId, today, onSaved]);

  React.useImperativeHandle(ref, () => ({ save: handleSave, saving }));

  const markAll = useCallback((status) => {
    const all = {};
    for (const row of roster) {
      all[String(row.student._id)] = status;
    }
    setAttendance(all);
  }, [roster]);

  const toggleStatus = useCallback((studentId, status) => {
    setAttendance((prev) => ({ ...prev, [studentId]: status }));
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return roster;
    return roster.filter(
      (row) =>
        row.student.studentName?.toLowerCase().includes(q) ||
        row.student.email?.toLowerCase().includes(q)       ||
        row.student.admissionNo?.toLowerCase().includes(q)
    );
  }, [roster, search]);

  const markedCount  = Object.keys(attendance).length;
  const presentCount = Object.values(attendance).filter((s) => s === "present").length;
  const absentCount  = Object.values(attendance).filter((s) => s === "absent").length;
  const lateCount    = Object.values(attendance).filter((s) => s === "late").length;
  const excusedCount = Object.values(attendance).filter((s) => s === "excused").length;
  const pct          = roster.length > 0
    ? Math.round((markedCount / roster.length) * 100)
    : 0;

  if (loading) {
    return (
      <View style={ms.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={ms.loadingText}>{t("attAdmin.loadingStudents")}</Text>
      </View>
    );
  }

  return (
    <View style={ms.container}>

      <View style={ms.progress}>
        <View style={ms.progressInfo}>
          <Text style={ms.progressText}>
            {markedCount} / {roster.length} marked
          </Text>
          <Text style={ms.progressPct}>{pct}%</Text>
        </View>
        <View style={ms.progressBarBg}>
          <View style={[ms.progressBarFill, { width: `${pct}%` }]} />
        </View>

        <View style={ms.statusCounts}>
          {[
            { label: "P", value: presentCount, color: "#059669" },
            { label: "A", value: absentCount,  color: "#DC2626" },
            { label: "L", value: lateCount,    color: "#D97706" },
            { label: "E", value: excusedCount, color: "#4F46E5" },
          ].map((s) => (
            <View
              key={s.label}
              style={[ms.countChip, { backgroundColor: s.color + "15" }]}
            >
              <Text style={[ms.countVal, { color: s.color }]}>{s.value}</Text>
              <Text style={[ms.countLbl, { color: s.color }]}>{s.label}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={ms.markAllRow}>
        <Text style={ms.markAllLabel}>{t("attAdmin.markAllColon")}</Text>
        {STATUS_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              ms.markAllBtn,
              { backgroundColor: opt.color + "15", borderColor: opt.color },
            ]}
            onPress={() => markAll(opt.value)}
            activeOpacity={0.7}
          >
            <Ionicons name={opt.icon} size={12} color={opt.color} />
            <Text style={[ms.markAllBtnText, { color: opt.color }]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={ms.searchBox}>
        <Ionicons name="search-outline" size={16} color="#9CA3AF" />
        <TextInput
          style={ms.searchInput}
          placeholder={t("attAdmin.searchStudent")}
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

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.student._id)}
        contentContainerStyle={ms.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadRoster(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        renderItem={({ item }) => {
          const studentId     = String(item.student._id);
          const currentStatus = attendance[studentId];
          const wasMarked     = !!item.attendance?.status;
          const statusColor   =
            STATUS_OPTIONS.find((o) => o.value === currentStatus)?.color;

          return (
            <View
              style={[
                ms.studentRow,
                currentStatus && {
                  borderLeftWidth: 3,
                  borderLeftColor: statusColor,
                },
              ]}
            >
              <View
                style={[
                  ms.avatar,
                  currentStatus && {
                    backgroundColor: statusColor + "20",
                  },
                ]}
              >
                <Text style={ms.avatarText}>
                  {item.student.studentName?.charAt(0)?.toUpperCase() || "?"}
                </Text>
              </View>

              <View style={ms.studentInfo}>
                <View style={ms.nameRow}>
                  <Text style={ms.studentName} numberOfLines={1}>
                    {item.student.studentName}
                  </Text>
                  {wasMarked && (
                    <View style={ms.savedBadge}>
                      <Text style={ms.savedBadgeText}>✓ saved</Text>
                    </View>
                  )}
                </View>
                <Text style={ms.studentSub} numberOfLines={1}>
                  {item.student.admissionNo
                    ? `#${item.student.admissionNo}`
                    : item.student.email || ""}
                </Text>
              </View>

              <View style={ms.statusButtons}>
                {STATUS_OPTIONS.map((opt) => {
                  const isActive = currentStatus === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        ms.statusBtn,
                        isActive
                          ? { backgroundColor: opt.color, borderColor: opt.color }
                          : { backgroundColor: "transparent", borderColor: "#E5E7EB" },
                      ]}
                      onPress={() => toggleStatus(studentId, opt.value)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={opt.icon}
                        size={16}
                        color={isActive ? "#FFF" : "#9CA3AF"}
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={ms.empty}>
            <Ionicons name="people-outline" size={48} color="#D1D5DB" />
            <Text style={ms.emptyTitle}>
              {search
                ? t("attAdmin.noStudentsMatch")
                : t("attAdmin.noStudentsInClass")}
            </Text>
            {!search && (
              <Text style={ms.emptyText}>
                {t("attAdmin.enrolFirst")}
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
});

const ms = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    gap:            12,
  },
  loadingText: { fontSize: 14, color: "#6B7280" },

  progress: {
    backgroundColor:   "#FFF",
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  progressInfo: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   6,
  },
  progressText: { fontSize: 13, color: "#374151", fontWeight: "600" },
  progressPct:  { fontSize: 13, color: "#4F46E5", fontWeight: "700" },
  progressBarBg: {
    height:          6,
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
    marginBottom:    10,
  },
  progressBarFill: {
    height:          6,
    backgroundColor: "#4F46E5",
    borderRadius:    3,
  },
  statusCounts: { flexDirection: "row", gap: 8 },
  countChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      8,
  },
  countVal: { fontSize: 13, fontWeight: "800" },
  countLbl: { fontSize: 11, fontWeight: "600" },

  markAllRow: {
    flexDirection:     "row",
    alignItems:        "center",
    flexWrap:          "wrap",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               8,
  },
  markAllLabel:   { fontSize: 12, color: "#6B7280", fontWeight: "600" },
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
    backgroundColor:   "#F9FAFB",
    borderRadius:      10,
    paddingHorizontal: 12,
    height:            40,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    gap:               8,
    margin:            12,
    marginBottom:      4,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  list: { padding: 12, paddingTop: 8, gap: 6, paddingBottom: 40 },

  studentRow: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             10,
  },
  avatar: {
    width:           40,
    height:          40,
    borderRadius:    20,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText:  { fontSize: 16, fontWeight: "800", color: "#4F46E5" },
  studentInfo: { flex: 1 },
  nameRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    flexWrap:      "wrap",
  },
  studentName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  savedBadge: {
    backgroundColor:   "#D1FAE5",
    borderRadius:      4,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  savedBadgeText: { fontSize: 9, color: "#059669", fontWeight: "700" },
  studentSub:     { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  statusButtons:  { flexDirection: "row", gap: 5 },
  statusBtn: {
    width:          30,
    height:         30,
    borderRadius:   8,
    borderWidth:    1.5,
    alignItems:     "center",
    justifyContent: "center",
  },

  empty: {
    alignItems:      "center",
    paddingVertical: 60,
    gap:             10,
  },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: "#374151" },
  emptyText:  { fontSize: 13, color: "#9CA3AF" },
});

export default function MarkStudentAttendanceScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;
  const today    = useMemo(() => todayStr(), []);

  const [selectedClass, setSelectedClass] = useState(null);
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [saving,        setSaving]        = useState(false);

  const markRef = useRef(null);

  const handleClassSelect = useCallback((cls) => {
    setSelectedClass(cls);
  }, []);

  const handleBack = useCallback(() => {
    if (selectedClass) {
      setSelectedClass(null);
    } else {
      router.back();
    }
  }, [selectedClass, router]);

  const handleSaved = useCallback(() => {
    router.back();
  }, [router]);

  const handleSavePress = useCallback(async () => {
    if (!markRef.current) return;
    setSaving(true);
    try {
      await markRef.current.save();
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <View style={mainS.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={mainS.header}>
        <TouchableOpacity
          style={mainS.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={mainS.headerCenter}>
          <Text style={mainS.headerTitle}>
            {selectedClass ? selectedClass.name : t("attAdmin.studentAttendanceTitle")}
          </Text>
          <Text style={mainS.headerSub}>
            {selectedClass
              ? formatDate(today)
              : t("attAdmin.selectClassToBegin")}
          </Text>
        </View>

        {selectedClass ? (
          <TouchableOpacity
            style={[mainS.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSavePress}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving
              ? <ActivityIndicator size="small" color="#FFF" />
              : <Text style={mainS.saveBtnText}>{t("common.save")}</Text>
            }
          </TouchableOpacity>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      {selectedClass && (
        <TouchableOpacity
          style={mainS.breadcrumb}
          onPress={() => setSelectedClass(null)}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={14} color="#4F46E5" />
          <Text style={mainS.breadcrumbBack}>{t("attAdmin.allClasses")}</Text>
          <Ionicons name="chevron-forward" size={14} color="#9CA3AF" />
          <Text style={mainS.breadcrumbCurrent}>{selectedClass.name}</Text>
          {!!selectedClass.sub && (
            <Text style={mainS.breadcrumbSub}> · {selectedClass.sub}</Text>
          )}
        </TouchableOpacity>
      )}

      {selectedClass && (
        <PeriodSelector
          schoolId={schoolId}
          selected={selectedPeriod}
          onSelect={setSelectedPeriod}
        />
      )}

      {selectedClass ? (
        <MarkAttendance
          key={`${selectedClass.id}-${selectedPeriod ?? "all"}`}
          ref={markRef}
          schoolId={schoolId}
          selectedClass={selectedClass}
          periodId={selectedPeriod}
          today={today}
          onSaved={handleSaved}
        />
      ) : (
        <ClassSelector
          schoolId={schoolId}
          onSelect={handleClassSelect}
        />
      )}
    </View>
  );
}

const mainS = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },

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
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  saveBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 18,
    minWidth:          60,
    alignItems:        "center",
  },
  saveBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  breadcrumb: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  breadcrumbBack:    { fontSize: 13, color: "#4F46E5", fontWeight: "600" },
  breadcrumbCurrent: { fontSize: 13, color: "#111827", fontWeight: "700" },
  breadcrumbSub:     { fontSize: 13, color: "#9CA3AF" },
});