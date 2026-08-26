// app/admin/timetable/periods.js
import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  TextInput,
  Platform,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { PeriodsService } from "../../../src/services/periods.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

// Format a Date object → "HH:MM"
const dateToHHMM = (date) => {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
};

// Parse "HH:MM" → Date (today)
const hhmmToDate = (str) => {
  const d = new Date();
  if (str && /^\d{2}:\d{2}$/.test(str)) {
    const [h, m] = str.split(":").map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
};

// Pretty 12-hour display
const formatDisplay = (hhmm) => {
  if (!hhmm) return "--:--";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
};

export default function PeriodsManager() {
  const router = useRouter();
  const { t } = useTranslation();

  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  // Modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("08:40");
  const [isBreak, setIsBreak] = useState(false);
  const [saving, setSaving] = useState(false);

  // Time picker state
  const [picker, setPicker] = useState({ visible: false, field: null });

  const isMountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (isRefresh = false) => {
      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);

        const rows = await PeriodsService.getAll(showInactive);
        if (isMountedRef.current) setPeriods(rows || []);
      } catch (err) {
        console.error("Load periods error:", err);
        if (isMountedRef.current) {
          Alert.alert(t("ttAdmin.errorTitle"), t("periods.loadFailed"));
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [showInactive, t]
  );

  useFocusEffect(
    useCallback(() => {
      const isRefresh = hasLoadedRef.current;
      load(isRefresh);
      hasLoadedRef.current = true;
    }, [load])
  );

  useEffect(() => {
    if (hasLoadedRef.current) load(true);
  }, [showInactive, load]);

  const openCreate = () => {
    setEditingId(null);
    setName("");
    setStartTime("08:00");
    setEndTime("08:40");
    setIsBreak(false);
    setModalVisible(true);
  };

  const openEdit = (period) => {
    setEditingId(period.id);
    setName(period.name);
    setStartTime(period.startTime);
    setEndTime(period.endTime);
    setIsBreak(!!period.isBreak);
    setModalVisible(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalVisible(false);
  };

  const handleSave = async () => {
    try {
      setSaving(true);

      if (editingId) {
        await PeriodsService.update(editingId, {
          name,
          startTime,
          endTime,
          isBreak,
        });
      } else {
        await PeriodsService.create({ name, startTime, endTime, isBreak });
      }

      if (isMountedRef.current) {
        setModalVisible(false);
        await load(true);
      }
    } catch (err) {
      if (isMountedRef.current) {
        Alert.alert(t("ttAdmin.errorTitle"), err?.message || t("ttAdmin.savePeriodFailed"));
      }
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const handleToggleActive = (period) => {
    Alert.alert(
      period.isActive ? t("ttAdmin.deactivateTitle") : t("ttAdmin.activateTitle"),
      period.isActive
        ? t("ttAdmin.deactivateConfirm", { name: period.name })
        : t("ttAdmin.activateConfirm", { name: period.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.confirm"),
          onPress: async () => {
            try {
              await PeriodsService.toggleActive(period.id);
              await load(true);
            } catch (err) {
              Alert.alert(t("ttAdmin.errorTitle"), err?.message || t("ttAdmin.updateFailed"));
            }
          },
        },
      ]
    );
  };

  const handleDelete = (period) => {
    Alert.alert(t("ttAdmin.deletePeriodTitle"), t("ttAdmin.deletePeriodBody", { name: period.name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await PeriodsService.delete(period.id);
            await load(true);
          } catch (err) {
            Alert.alert(t("ttAdmin.cannotDelete"), err?.message || t("ttAdmin.deleteFailed"));
          }
        },
      },
    ]);
  };

  const handleReorder = async (period, direction) => {
    try {
      const ok = await PeriodsService.reorder(period.id, direction);
      if (ok) await load(true);
    } catch (err) {
      Alert.alert(t("ttAdmin.errorTitle"), err?.message || t("ttAdmin.reorderFailed"));
    }
  };

  const onPickerChange = (event, selected) => {
    // Android closes automatically; iOS stays open
    if (Platform.OS === "android") {
      setPicker({ visible: false, field: null });
    }
    if (event.type === "dismissed" || !selected) return;

    const value = dateToHHMM(selected);
    if (picker.field === "start") setStartTime(value);
    else if (picker.field === "end") setEndTime(value);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("ttAdmin.loadingPeriods")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("ttAdmin.periodsTitle")}</Text>
          <Text style={styles.headerSubtitle}>
            {t("ttAdmin.periodCount", { count: periods.length })}
          </Text>
        </View>
        <TouchableOpacity style={styles.addButton} onPress={openCreate}>
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* Filter */}
      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.filterChip, !showInactive && styles.filterChipActive]}
          onPress={() => setShowInactive(false)}
        >
          <Text style={[styles.filterText, !showInactive && styles.filterTextActive]}>
            {t("common.active")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterChip, showInactive && styles.filterChipActive]}
          onPress={() => setShowInactive(true)}
        >
          <Text style={[styles.filterText, showInactive && styles.filterTextActive]}>
            {t("common.all")}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#4F46E5"
          />
        }
      >
        {periods.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="time-outline" size={64} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>{t("ttAdmin.noPeriodsYet")}</Text>
            <Text style={styles.emptySubtitle}>
              {t("ttAdmin.noPeriodsHint")}
            </Text>
            <TouchableOpacity style={styles.emptyButton} onPress={openCreate}>
              <Ionicons name="add-circle" size={20} color="#4F46E5" />
              <Text style={styles.emptyButtonText}>{t("periods.add")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          periods.map((period, index) => (
            <View
              key={period.id}
              style={[styles.card, !period.isActive && styles.cardInactive]}
            >
              {/* Order controls */}
              <View style={styles.orderControls}>
                <TouchableOpacity
                  onPress={() => handleReorder(period, "up")}
                  disabled={index === 0}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Ionicons
                    name="chevron-up"
                    size={18}
                    color={index === 0 ? "#D1D5DB" : "#6B7280"}
                  />
                </TouchableOpacity>
                <Text style={styles.orderNum}>{index + 1}</Text>
                <TouchableOpacity
                  onPress={() => handleReorder(period, "down")}
                  disabled={index === periods.length - 1}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Ionicons
                    name="chevron-down"
                    size={18}
                    color={index === periods.length - 1 ? "#D1D5DB" : "#6B7280"}
                  />
                </TouchableOpacity>
              </View>

              {/* Info */}
              <View style={styles.cardInfo}>
                <View style={styles.cardTitleRow}>
                  <Text
                    style={[
                      styles.periodName,
                      !period.isActive && styles.dimText,
                    ]}
                  >
                    {period.name}
                  </Text>
                  {!!period.isBreak && (
                    <View style={styles.breakBadge}>
                      <Text style={styles.breakBadgeText}>{t("timetable.break")}</Text>
                    </View>
                  )}
                  {!period.isActive && (
                    <View style={styles.inactiveBadge}>
                      <Text style={styles.inactiveBadgeText}>{t("common.inactive")}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.timeRow}>
                  <Ionicons name="time-outline" size={14} color="#6B7280" />
                  <Text style={styles.timeText}>
                    {formatDisplay(period.startTime)} –{" "}
                    {formatDisplay(period.endTime)}
                  </Text>
                </View>
              </View>

              {/* Actions */}
              <View style={styles.cardActions}>
                <TouchableOpacity
                  onPress={() => openEdit(period)}
                  style={styles.iconBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="create-outline" size={20} color="#4F46E5" />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleToggleActive(period)}
                  style={styles.iconBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name={
                      period.isActive
                        ? "pause-circle-outline"
                        : "play-circle-outline"
                    }
                    size={20}
                    color={period.isActive ? "#D97706" : "#059669"}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleDelete(period)}
                  style={styles.iconBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="trash-outline" size={20} color="#DC2626" />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Create/Edit Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />

            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingId ? t("ttAdmin.editPeriod") : t("ttAdmin.newPeriod")}
              </Text>
              <TouchableOpacity onPress={closeModal} disabled={saving}>
                <Ionicons name="close" size={22} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled">
              {/* Name */}
              <Text style={styles.label}>{t("ttAdmin.periodName")}</Text>
              <TextInput
                style={styles.input}
                placeholder={t("periods.namePh")}
                placeholderTextColor="#9CA3AF"
                value={name}
                onChangeText={setName}
                editable={!saving}
              />

              {/* Times */}
              <View style={styles.timePickerRow}>
                <View style={styles.timePickerCol}>
                  <Text style={styles.label}>{t("periods.starts")}</Text>
                  <TouchableOpacity
                    style={styles.timeButton}
                    onPress={() => setPicker({ visible: true, field: "start" })}
                    disabled={saving}
                  >
                    <Ionicons name="time-outline" size={18} color="#4F46E5" />
                    <Text style={styles.timeButtonText}>
                      {formatDisplay(startTime)}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.timePickerCol}>
                  <Text style={styles.label}>{t("periods.ends")}</Text>
                  <TouchableOpacity
                    style={styles.timeButton}
                    onPress={() => setPicker({ visible: true, field: "end" })}
                    disabled={saving}
                  >
                    <Ionicons name="time-outline" size={18} color="#4F46E5" />
                    <Text style={styles.timeButtonText}>
                      {formatDisplay(endTime)}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Break toggle */}
              <TouchableOpacity
                style={styles.breakToggle}
                onPress={() => setIsBreak((p) => !p)}
                disabled={saving}
              >
                <Ionicons
                  name={isBreak ? "checkbox" : "square-outline"}
                  size={22}
                  color="#4F46E5"
                />
                <Text style={styles.breakToggleText}>
                  {t("periods.isBreak")}
                </Text>
              </TouchableOpacity>

              {/* Save */}
              <TouchableOpacity
                style={[styles.saveButton, saving && { opacity: 0.6 }]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={18} color="#FFFFFF" />
                    <Text style={styles.saveButtonText}>
                      {editingId ? t("ttAdmin.saveChanges") : t("ttAdmin.createPeriod")}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <View style={{ height: 12 }} />
            </ScrollView>
          </View>
        </View>

        {/* Native time picker */}
        {picker.visible && (
          <DateTimePicker
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            value={hhmmToDate(picker.field === "start" ? startTime : endTime)}
            is24Hour={false}
            onChange={onPickerChange}
          />
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F3F4F6",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  backButton: { padding: 4, marginRight: 12 },
  headerTitle: { fontSize: 24, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#4F46E5",
    alignItems: "center",
    justifyContent: "center",
  },

  filterBar: { flexDirection: "row", paddingHorizontal: 20, marginBottom: 12, gap: 8 },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  filterChipActive: { backgroundColor: "#4F46E5", borderColor: "#4F46E5" },
  filterText: { fontSize: 13, fontWeight: "600", color: "#6B7280" },
  filterTextActive: { color: "#FFFFFF" },

  scrollContent: { paddingHorizontal: 20, paddingTop: 4 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
  },
  cardInactive: { opacity: 0.65 },
  orderControls: { alignItems: "center", marginRight: 12 },
  orderNum: { fontSize: 12, fontWeight: "700", color: "#9CA3AF", marginVertical: 2 },

  cardInfo: { flex: 1 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  periodName: { fontSize: 16, fontWeight: "700", color: "#111827" },
  dimText: { color: "#9CA3AF" },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  timeText: { fontSize: 13, color: "#6B7280", fontWeight: "500" },

  breakBadge: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  breakBadgeText: { fontSize: 11, fontWeight: "700", color: "#92400E" },
  inactiveBadge: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  inactiveBadgeText: { fontSize: 11, fontWeight: "600", color: "#6B7280" },

  cardActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconBtn: { padding: 6 },

  emptyState: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 16 },
  emptySubtitle: {
    fontSize: 14,
    color: "#6B7280",
    marginTop: 6,
    textAlign: "center",
    lineHeight: 20,
  },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 20,
    gap: 6,
  },
  emptyButtonText: { fontSize: 15, fontWeight: "600", color: "#4F46E5" },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(17,24,39,0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 24,
    maxHeight: "85%",
  },
  modalHandle: {
    width: 44,
    height: 5,
    borderRadius: 99,
    backgroundColor: "#D1D5DB",
    alignSelf: "center",
    marginBottom: 14,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: "800", color: "#111827" },

  label: { fontSize: 14, fontWeight: "600", color: "#374151", marginBottom: 8 },
  input: {
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: "#111827",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 16,
  },

  timePickerRow: { flexDirection: "row", gap: 12 },
  timePickerCol: { flex: 1 },
  timeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 16,
  },
  timeButtonText: { fontSize: 15, fontWeight: "600", color: "#111827" },

  breakToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  breakToggleText: { fontSize: 14, color: "#374151", fontWeight: "500" },

  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#4F46E5",
    borderRadius: 12,
    paddingVertical: 16,
    gap: 8,
    marginTop: 4,
  },
  saveButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});