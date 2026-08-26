// app/admin/periods/index.js

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Alert,
  ScrollView,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { PeriodsService } from "../../../src/services/periods.service";

const PeriodCard = React.memo(({ period, onEdit, onToggle, onMoveUp, onMoveDown, isFirst, isLast }) => {
                                const { t } = useTranslation();
                                return (
  <View style={[styles.card, !period.isActive && styles.cardInactive]}>
    <View style={[styles.cardAccent, !period.isActive && styles.cardAccentInactive]} />

    <View style={styles.cardInfo}>
      <View style={styles.cardTitleRow}>
        <Text style={[styles.cardName, !period.isActive && styles.cardNameInactive]}>
          {period.name}
        </Text>
        {period.isBreak && (
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
        <Ionicons name="time-outline" size={13} color="#6B7280" />
        <Text style={styles.timeText}>
          {period.startTime} – {period.endTime}
        </Text>
      </View>
    </View>

    <View style={styles.reorderButtons}>
      <TouchableOpacity
        onPress={() => onMoveUp(period.id)}
        disabled={isFirst}
        style={[styles.reorderBtn, isFirst && styles.reorderBtnDisabled]}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons
          name="chevron-up"
          size={16}
          color={isFirst ? "#D1D5DB" : "#6B7280"}
        />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onMoveDown(period.id)}
        disabled={isLast}
        style={[styles.reorderBtn, isLast && styles.reorderBtnDisabled]}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons
          name="chevron-down"
          size={16}
          color={isLast ? "#D1D5DB" : "#6B7280"}
        />
      </TouchableOpacity>
    </View>

    <View style={styles.cardActions}>
      <TouchableOpacity
        onPress={() => onToggle(period.id, period.isActive)}
        style={styles.actionBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons
          name={period.isActive ? "eye-off-outline" : "eye-outline"}
          size={18}
          color={period.isActive ? "#D97706" : "#059669"}
        />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onEdit(period)}
        style={styles.actionBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="pencil-outline" size={18} color="#4F46E5" />
      </TouchableOpacity>
    </View>
  </View>
);
                              });

export default function PeriodsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const isMountedRef = useRef(true);

  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadPeriods = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const data = await PeriodsService.getAll(true);
      if (!isMountedRef.current) return;
      setPeriods(data || []);
    } catch (err) {
      console.error("Failed to load periods:", err);
      if (isMountedRef.current) {
        setError(t("periodsAdmin.loadFailed"));
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  const handleToggle = useCallback(async (id, currentlyActive) => {
    Alert.alert(
      currentlyActive ? t("periodsAdmin.deactivateTitle") : t("periodsAdmin.activateTitle"),
      currentlyActive
        ? t("periodsAdmin.deactivateBody")
        : t("periodsAdmin.activateBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: currentlyActive ? t("periodsAdmin.deactivate") : t("periodsAdmin.activate"),
          style: currentlyActive ? "destructive" : "default",
          onPress: async () => {
            try {
              await PeriodsService.toggleActive(id);
              if (isMountedRef.current) loadPeriods();
            } catch (err) {
              Alert.alert(t("periodsAdmin.errorTitle"), err.message || t("periodsAdmin.updateFailed"));
            }
          },
        },
      ]
    );
  }, [loadPeriods]);

  const handleMove = useCallback(async (id, direction) => {
    try {
      await PeriodsService.reorder(id, direction);
      if (isMountedRef.current) loadPeriods();
    } catch (err) {
      Alert.alert(t("periodsAdmin.errorTitle"), t("periodsAdmin.reorderFailed"));
    }
  }, [loadPeriods]);

  const handleEdit = useCallback((period) => {
    router.push({
      pathname: "/admin/periods/edit",
      params: { id: period.id },
    });
  }, [router]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("periodsAdmin.loadingPeriods")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("periodsAdmin.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {periods.filter((p) => p.isActive).length} active
            {periods.length > 0 ? ` of ${periods.length}` : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/admin/periods/add")}
          style={styles.addButton}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadPeriods(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.infoBanner}>
          <Ionicons name="information-circle-outline" size={16} color="#4F46E5" />
          <Text style={styles.infoBannerText}>
            {t("periodsAdmin.infoBanner")}
          </Text>
        </View>

        {periods.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="time-outline" size={36} color="#9CA3AF" />
            </View>
            <Text style={styles.emptyTitle}>{t("periodsAdmin.noPeriodsYet")}</Text>
            <Text style={styles.emptySubtitle}>
              {t("periodsAdmin.noPeriodsHint")}
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => router.push("/admin/periods/add")}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={20} color="#FFFFFF" />
              <Text style={styles.emptyButtonText}>{t("periodsAdmin.addFirst")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {periods.map((period, index) => (
              <PeriodCard
                key={period.id}
                period={period}
                isFirst={index === 0}
                isLast={index === periods.length - 1}
                onEdit={handleEdit}
                onToggle={handleToggle}
                onMoveUp={(id) => handleMove(id, "up")}
                onMoveDown={(id) => handleMove(id, "down")}
              />
            ))}

            <TouchableOpacity
              style={styles.addMoreButton}
              onPress={() => router.push("/admin/periods/add")}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={20} color="#4F46E5" />
              <Text style={styles.addMoreText}>{t("periodsAdmin.addAnother")}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: "#6B7280",
    fontWeight: "500",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#4F46E5",
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEE2E2",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    gap: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: "#991B1B",
    fontWeight: "500",
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#EEF2FF",
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    gap: 8,
  },
  infoBannerText: {
    flex: 1,
    fontSize: 12,
    color: "#3730A3",
    lineHeight: 18,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    overflow: "hidden",
  },
  cardInactive: {
    opacity: 0.6,
    backgroundColor: "#F9FAFB",
  },
  cardAccent: {
    width: 5,
    alignSelf: "stretch",
    backgroundColor: "#4F46E5",
  },
  cardAccentInactive: {
    backgroundColor: "#D1D5DB",
  },
  cardInfo: {
    flex: 1,
    paddingVertical: 14,
    paddingLeft: 14,
    paddingRight: 8,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  cardName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
  },
  cardNameInactive: {
    color: "#9CA3AF",
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  timeText: {
    fontSize: 13,
    color: "#6B7280",
    fontWeight: "500",
  },
  breakBadge: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  breakBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#D97706",
  },
  inactiveBadge: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  inactiveBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#9CA3AF",
  },
  reorderButtons: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 2,
  },
  reorderBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: "#F3F4F6",
  },
  reorderBtnDisabled: {
    backgroundColor: "transparent",
  },
  cardActions: {
    flexDirection: "column",
    alignItems: "center",
    paddingRight: 12,
    paddingLeft: 4,
    gap: 8,
  },
  actionBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: "#F9FAFB",
  },
  addMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#4F46E5",
    borderStyle: "dashed",
    marginTop: 4,
  },
  addMoreText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#4F46E5",
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#4F46E5",
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  emptyButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
});
import { useTranslation } from "../../../src/i18n/useTranslation";