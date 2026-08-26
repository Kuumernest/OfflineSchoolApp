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
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { AttendanceService } from "../../../src/services/attendance.service";

const STATUS_OPTIONS = [
  { value: "present",  labelKey: "attStatus.present",  color: "#059669", icon: "checkmark-circle" },
  { value: "absent",   labelKey: "attStatus.absent",   color: "#DC2626", icon: "close-circle"     },
  { value: "late",     labelKey: "attStatus.late",     color: "#D97706", icon: "time"             },
  { value: "on_leave", labelKey: "attAdmin.onLeave", color: "#6B7280", icon: "calendar"         },
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

  const loadRoster = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const data = await AttendanceService.getTeacherAttendanceToday(schoolId);

      setRoster(data.roster || []);

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
  }, [schoolId]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

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
        `Attendance saved for ${records.length} teacher(s).`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert(t("attAdmin.saveFailed"), err.message || t("attAdmin.pleaseTryAgain"));
    } finally {
      setSaving(false);
    }
  }, [attendance, schoolId, today, router]);

  const markedCount = Object.keys(attendance).length;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#059669" />
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
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("attAdmin.teacherAttendanceTitle")}</Text>
          <Text style={styles.headerSub}>
            {markedCount} of {roster.length} marked
          </Text>
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

      <View style={styles.markAllRow}>
        <Text style={styles.markAllLabel}>{t("attAdmin.markAllAsColon")}</Text>
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
            <Text style={[styles.markAllBtnText, { color: opt.color }]}>
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
            tintColor="#059669"
            colors={["#059669"]}
          />
        }
        renderItem={({ item }) => {
          const teacherId     = String(item.teacher._id);
          const currentStatus = attendance[teacherId];

          return (
            <View style={styles.teacherRow}>
              <View style={styles.teacherAvatar}>
                <Ionicons name="person" size={20} color="#6B7280" />
              </View>

              <View style={styles.teacherInfo}>
                <Text style={styles.teacherName}>{item.teacher.name}</Text>
                <Text style={styles.teacherEmail} numberOfLines={1}>
                  {item.teacher.email}
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
                          borderColor:     "#E5E7EB",
                        },
                      ]}
                      onPress={() => toggleStatus(teacherId, opt.value)}
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
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={40} color="#D1D5DB" />
            <Text style={styles.emptyText}>{t("attAdmin.noTeachers")}</Text>
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
  loadingText: { color: "#6B7280", marginTop: 12 },

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
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  saveBtn: {
    backgroundColor: "#059669",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  saveBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  markAllRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   12,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               8,
  },
  markAllLabel:   { fontSize: 12, color: "#6B7280", fontWeight: "600" },
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
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             12,
  },
  teacherAvatar: {
    width:           44,
    height:          44,
    borderRadius:    22,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  teacherInfo:  { flex: 1 },
  teacherName:  { fontSize: 14, fontWeight: "700", color: "#111827" },
  teacherEmail: { fontSize: 12, color: "#9CA3AF", marginTop: 2 },

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
  emptyText: { fontSize: 14, color: "#9CA3AF" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";