// app/admin/attendance/teachers.js

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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, EmptyState } from "../../../src/components/Tinted";

const STATUS_OPTIONS = [
  { value: "present",  labelKey: "attStatus.present",  color: ACCENT.green.solid,  tone: "success", icon: "checkmark-circle" },
  { value: "absent",   labelKey: "attStatus.absent",   color: ACCENT.red.solid,    tone: "error",   icon: "close-circle"     },
  { value: "late",     labelKey: "attStatus.late",     color: ACCENT.amber.solid,  tone: "warning", icon: "time"             },
  { value: "on_leave", labelKey: "attAdmin.onLeave",   color: ACCENT.indigo.solid, tone: "info",    icon: "calendar"         },
];

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function MarkTeacherAttendanceScreen() {
  const { t } = useTranslation();
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;
  const today    = useMemo(() => todayStr(), []);

  const [roster,      setRoster]      = useState([]);
  const [attendance,  setAttendance]  = useState({});
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  // The register is the timetable's: who is listed follows the period chosen.
  // "" is every period of the day. `available` is false when the phone is
  // offline and holds no timetable — a different fact from an empty list.
  const [periods,     setPeriods]     = useState([]);
  const [periodId,    setPeriodId]    = useState("");
  const [available,   setAvailable]   = useState(true);

  const loadRoster = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const data = await AttendanceService.getTeacherRegister({
        schoolId, date: today, periodId: periodId || null,
      });

      setRoster(data.roster || []);
      setAvailable(data.available !== false);

      const existing = {};
      for (const row of (data.roster || [])) {
        if (row.attendance?.status) {
          existing[String(row.teacher._id)] = row.attendance.status;
        }
      }
      setAttendance(existing);
    } catch (err) {
      Alert.alert(t("attAdmin.errorTitle"), t("attAdmin.teacherRosterFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, today, periodId, t]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  useEffect(() => {
    let alive = true;
    AttendanceService.getPeriods(schoolId)
      .then((list) => { if (alive) setPeriods(list || []); })
      .catch(() => { if (alive) setPeriods([]); });
    return () => { alive = false; };
  }, [schoolId]);

  const markAll = useCallback((status) => {
    const all = {};
    for (const row of roster) {
      all[String(row.teacher._id)] = status;
    }
    setAttendance(all);
  }, [roster]);

  const toggleStatus = useCallback((teacherId, status) => {
    setAttendance((prev) => ({ ...prev, [teacherId]: status }));
  }, []);

  const handleSave = useCallback(async () => {
    const records = Object.entries(attendance).map(([teacherId, status]) => ({
      teacherId,
      status,
    }));

    if (!records.length) {
      Alert.alert(t("attAdmin.nothingToSave"), t("attAdmin.markOneTeacher"));
      return;
    }

    try {
      setSaving(true);
      await AttendanceService.markTeacherAttendanceBulk({
        schoolId,
        date: today,
        records,
      });

      Alert.alert(
        t("attAdmin.savedTitle"),
        t("attAdmin.savedForTeachers", { count: records.length }),
        [{ text: t("common.ok"), onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert(t("attAdmin.saveFailed"), errorText(t, err, "attAdmin.pleaseTryAgain"));
    } finally {
      setSaving(false);
    }
  }, [attendance, t, schoolId, today, router]);

  const markedCount = Object.keys(attendance).length;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.green.solid} />
        <Text style={styles.loadingText}>{t("attAdmin.loadingTeacherRoster")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

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
          <Text style={styles.headerTitle}>{t("attAdmin.teacherAttendanceTitle")}</Text>
          <Text style={styles.headerSub}>
            {t("attAdmin.markedOfTotal", { marked: markedCount, total: roster.length })}
          </Text>
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

      {periods.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.periodRow}
          contentContainerStyle={styles.periodRowContent}
        >
          {[{ id: "", name: t("attAdmin.allPeriods") }, ...periods].map((p) => {
            const active = periodId === p.id;
            return (
              <TouchableOpacity
                key={p.id || "all"}
                style={[styles.periodChip, active && styles.periodChipActive]}
                onPress={() => setPeriodId(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>
                  {p.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.markAllRow}>
        <Text style={styles.markAllLabel}>{t("attAdmin.markAllAsColon")}</Text>
        {STATUS_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.markAllBtn,
              { backgroundColor: SEMANTIC[opt.tone].bg, borderColor: SEMANTIC[opt.tone].icon },
            ]}
            onPress={() => markAll(opt.value)}
            activeOpacity={0.7}
          >
            <Text style={[styles.markAllBtnText, { color: SEMANTIC[opt.tone].text }]}>
              {t(opt.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={roster}
        keyExtractor={(item) => String(item.teacher._id)}
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
        renderItem={({ item }) => {
          const teacherId     = String(item.teacher._id);
          const currentStatus = attendance[teacherId];
          const statusColor   =
            STATUS_OPTIONS.find((o) => o.value === currentStatus)?.color;

          return (
            <View
              style={[
                styles.teacherRow,
                currentStatus && {
                  borderLeftWidth: 3,
                  borderLeftColor: statusColor,
                },
              ]}
            >
              <View style={styles.teacherAvatar}>
                <Ionicons name="person" size={20} color={COLORS.onPrimary} />
              </View>

              <View style={styles.teacherInfo}>
                <Text style={styles.teacherName}>{item.teacher.name}</Text>
                <Text style={styles.teacherEmail} numberOfLines={1}>
                  {(item.teacher.slots ?? [])
                    .map((s) => s.className)
                    .filter((name, i, all) => name && all.indexOf(name) === i)
                    .join(" · ") || item.teacher.email}
                </Text>
              </View>

              <View style={styles.statusButtons}>
                {STATUS_OPTIONS.map((opt) => {
                  const isActive = currentStatus === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        styles.statusBtn,
                        isActive && {
                          backgroundColor: opt.color,
                          borderColor:     opt.color,
                        },
                        !isActive && {
                          backgroundColor: "transparent",
                          borderColor:     COLORS.border,
                        },
                      ]}
                      onPress={() => toggleStatus(teacherId, opt.value)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={opt.icon}
                        size={16}
                        color={isActive ? COLORS.onPrimary : COLORS.textSubtle}
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon="people-outline"
            kind="teachers"
            message={!available
              ? t("attAdmin.timetableUnavailableOffline")
              : periodId
                ? t("attAdmin.noTeachersScheduled")
                : t("attAdmin.noTeachersScheduledToday")}
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
  loadingText: { color: COLORS.textSecondary, marginTop: 12 },

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
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: COLORS.page,
    alignItems: "center", justifyContent: "center",
  },
  headerIcon:   { marginLeft: 12, marginRight: 0 },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:    { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  saveBtn: {
    backgroundColor: ACCENT.green.solid,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  saveBtnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },

  periodRow:        { flexGrow: 0, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  periodRowContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  periodChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface,
  },
  periodChipActive:     { backgroundColor: ACCENT.teal.wash, borderColor: ACCENT.teal.base },
  periodChipText:       { fontSize: 13, fontWeight: "500", color: COLORS.textSecondary },
  periodChipTextActive: { color: ACCENT.teal.deep },
  markAllRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   12,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               8,
  },
  markAllLabel:   { fontSize: 12, color: COLORS.textSecondary, fontWeight: "600" },
  markAllBtn: {
    borderWidth:       1,
    borderRadius:      8,
    paddingVertical:   6,
    paddingHorizontal: 10,
  },
  markAllBtnText: { fontSize: 11, fontWeight: "700" },

  list: { padding: 16, gap: 8 },

  teacherRow: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         14,
    borderWidth:     1,
    borderColor:     COLORS.border,
    gap:             12,
  },
  teacherAvatar: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: ACCENT.violet.solid,
    alignItems:      "center",
    justifyContent:  "center",
  },
  teacherInfo:  { flex: 1 },
  teacherName:  { fontSize: 14, fontWeight: "700", color: COLORS.text },
  teacherEmail: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },

  statusButtons: { flexDirection: "row", gap: 6 },
  statusBtn: {
    width:          32,
    height:         32,
    borderRadius:   8,
    borderWidth:    1.5,
    alignItems:     "center",
    justifyContent: "center",
  },

  empty: {
    alignItems:     "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: { fontSize: 14, color: COLORS.textSecondary },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";