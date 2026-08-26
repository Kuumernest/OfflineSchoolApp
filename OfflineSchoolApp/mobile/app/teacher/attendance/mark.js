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
  TextInput,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }          from "@expo/vector-icons";
import { useAuthStore }      from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "present", labelKey: "attStatus.present", color: "#059669", icon: "checkmark-circle" },
  { value: "absent",  labelKey: "attStatus.absent",  color: "#DC2626", icon: "close-circle"     },
  { value: "late",    labelKey: "attStatus.late",    color: "#D97706", icon: "time"             },
  { value: "excused", labelKey: "attStatus.excused", color: "#4F46E5", icon: "shield-checkmark" },
];

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
          currentStatus && { backgroundColor: statusColor + "20" },
        ]}
      >
        <Text style={rowS.avatarText}>
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
                  : { backgroundColor: "transparent", borderColor: "#E5E7EB" },
              ]}
              onPress={() => onToggle(String(item.student._id), opt.value)}
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
});

const rowS = StyleSheet.create({
  row: {
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
  avatarText:    { fontSize: 16, fontWeight: "800", color: "#4F46E5" },
  info:          { flex: 1 },
  nameRow:       { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  name:          { fontSize: 14, fontWeight: "700", color: "#111827" },
  savedBadge: {
    backgroundColor:   "#D1FAE5",
    borderRadius:      4,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  savedBadgeText: { fontSize: 9, color: "#059669", fontWeight: "700" },
  sub:            { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
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
  const classId   = params.classId;
  const className = params.className || t("attTeacher.klass");
  const today     = useMemo(() => todayStr(), []);

  const [roster,     setRoster]     = useState([]);
  const [attendance, setAttendance] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search,     setSearch]     = useState("");
  const [error,      setError]      = useState(null);

  const loadRoster = useCallback(async (isRefresh = false) => {
    if (!classId || !schoolId) {
      setLoading(false);
      return;
    }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const data = await AttendanceService.getStudentAttendanceToday(
        classId,
        schoolId
      );

      const rosterData = data?.roster || [];

      if (rosterData.length === 0) {
        console.log("[TeacherMark] Roster is empty for class:", classId);
      }

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
  }, [classId, schoolId]);

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
          date:    today,
          records,
        });

        Alert.alert(
          t("attTeacher.savedTitle"),
          `Saved for ${records.length} student${records.length !== 1 ? "s" : ""}.` +
          (unmarked > 0
            ? `\n${unmarked} student${unmarked !== 1 ? "s" : ""} not marked.`
            : ""),
          [{ text: "OK", onPress: () => router.back() }]
        );
      } catch (err) {
        Alert.alert(t("attTeacher.saveFailedTitle"), err?.message || t("attTeacher.tryAgain"));
      } finally {
        setSaving(false);
      }
    };

    if (unmarked > 0) {
      Alert.alert(
        t("attTeacher.unmarkedTitle"),
        `${unmarked} student${unmarked !== 1 ? "s" : ""} have not been marked.\nSave anyway?`,
        [
          { text: t("common.cancel"),      style: "cancel" },
          { text: t("attTeacher.saveAnyway"), onPress: doSave  },
        ]
      );
    } else {
      doSave();
    }
  }, [attendance, roster, schoolId, classId, today, router]);

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
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("attTeacher.loadingStudents")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {className}
          </Text>
          <Text style={styles.headerSub}>{formatDate(today)}</Text>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.8}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.saveBtnText}>{t("common.save")}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Error */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle" size={16} color="#DC2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadRoster()}>
            <Text style={styles.errorRetry}>{t("common.retry")}</Text>
          </TouchableOpacity>
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
          {[
            { label: "P", value: presentCount, color: "#059669" },
            { label: "A", value: absentCount,  color: "#DC2626" },
            { label: "L", value: lateCount,    color: "#D97706" },
            { label: "E", value: excusedCount, color: "#4F46E5" },
          ].map((s) => (
            <View
              key={s.value}
              style={[styles.countChip, { backgroundColor: s.color + "15" }]}
            >
              <Text style={[styles.countVal, { color: s.color }]}>{s.value}</Text>
              <Text style={[styles.countLbl, { color: s.color }]}>{t(s.labelKey)}</Text>
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
              { backgroundColor: opt.color + "15", borderColor: opt.color },
            ]}
            onPress={() => markAll(opt.value)}
            activeOpacity={0.7}
          >
            <Ionicons name={opt.icon} size={12} color={opt.color} />
            <Text style={[styles.markAllBtnText, { color: opt.color }]}>
              {t(opt.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={16} color="#9CA3AF" />
        <TextInput
          style={styles.searchInput}
          placeholder={t("attTeacher.searchStudentPh")}
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
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
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
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>
              {error
                ? t("attTeacher.loadStudentsFailed")
                : search
                ? t("attTeacher.noStudentMatch")
                : t("attTeacher.noStudents")}
            </Text>
            {!error && !search && (
              <Text style={styles.emptySub}>
                {t("attTeacher.enrolFirst")}
              </Text>
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
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: { fontSize: 14, color: "#6B7280", marginTop: 12 },
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
  errorBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#FEF2F2",
    paddingHorizontal: 16,
    paddingVertical:   10,
    gap:               8,
  },
  errorText:  { flex: 1, fontSize: 13, color: "#DC2626" },
  errorRetry: { fontSize: 13, color: "#DC2626", fontWeight: "700", textDecorationLine: "underline" },
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
  progressText:  { fontSize: 13, color: "#374151", fontWeight: "600" },
  progressPct:   { fontSize: 13, color: "#4F46E5", fontWeight: "700" },
  progressBarBg: {
    height:          6,
    backgroundColor: "#F3F4F6",
    borderRadius:    3,
    overflow:        "hidden",
    marginBottom:    10,
  },
  progressBarFill: { height: 6, backgroundColor: "#4F46E5", borderRadius: 3 },
  statusCounts:    { flexDirection: "row", gap: 8 },
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
    marginBottom:      6,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },
  list:  { padding: 12, paddingTop: 8, paddingBottom: 40 },
  empty: { alignItems: "center", paddingVertical: 60, gap: 10 },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: "#374151", textAlign: "center" },
  emptySub:   { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";