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
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare, Badge } from "../../../src/components/Tinted";

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
          <Badge
            label={t("timetable.break")}
            tone="warning"
            style={styles.breakBadge}
            textStyle={styles.breakBadgeText}
          />
        )}
        {!period.isActive && (
          <Badge
            label={t("common.inactive")}
            tone="error"
            style={styles.inactiveBadge}
            textStyle={styles.inactiveBadgeText}
          />
        )}
      </View>

      <View style={styles.timeRow}>
        <Ionicons name="time-outline" size={13} color={ACCENT.teal.solid} />
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
          color={isFirst ? COLORS.textMuted : COLORS.textSecondary}
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
          color={isLast ? COLORS.textMuted : COLORS.textSecondary}
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
          color={period.isActive ? COLORS.warning : COLORS.success}
        />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onEdit(period)}
        style={styles.actionBtn}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="pencil-outline" size={18} color={ACCENT.teal.solid} />
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
  }, [t]);

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
              Alert.alert(t("periodsAdmin.errorTitle"), errorText(t, err, "periodsAdmin.updateFailed"));
            }
          },
        },
      ]
    );
  }, [loadPeriods, t]);

  const handleMove = useCallback(async (id, direction) => {
    try {
      await PeriodsService.reorder(id, direction);
      if (isMountedRef.current) loadPeriods();
    } catch (err) {
      Alert.alert(t("periodsAdmin.errorTitle"), t("periodsAdmin.reorderFailed"));
    }
  }, [loadPeriods, t]);

  const handleEdit = useCallback((period) => {
    router.push({
      pathname: "/admin/periods/edit",
      params: { id: period.id },
    });
  }, [router]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.teal.solid} />
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
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("periodsAdmin.title")}</Text>
          <Text style={styles.headerSubtitle}>
            {/* Teaching periods only (B2): breaks are rows, not periods. */}
            {periods.filter((p) => p.isActive && !p.isBreak).length} teaching
            {periods.length > 0 ? ` of ${periods.filter((p) => !p.isBreak).length}` : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/admin/periods/add")}
          style={styles.addButton}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={22} color={COLORS.onPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadPeriods(true)}
            tintColor={ACCENT.teal.solid}
            colors={[ACCENT.teal.solid]}
          />
        }
      >
        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color={SEMANTIC.error.icon} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.infoBanner}>
          <Ionicons name="information-circle-outline" size={16} color={SEMANTIC.info.icon} />
          <Text style={styles.infoBannerText}>
            {t("periodsAdmin.infoBanner")}
          </Text>
        </View>

        {periods.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSquare icon="time-outline" accent="teal" size={80} radius={20} style={styles.emptyIconWrap} />
            <Text style={styles.emptyTitle}>{t("periodsAdmin.noPeriodsYet")}</Text>
            <Text style={styles.emptySubtitle}>
              {t("periodsAdmin.noPeriodsHint")}
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => router.push("/admin/periods/add")}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={20} color={COLORS.onPrimary} />
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
              <Ionicons name="add-circle-outline" size={20} color={ACCENT.teal.solid} />
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
    color: COLORS.textSecondary,
    fontWeight: "500",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.page,
    alignItems: "center",
    justifyContent: "center",
  },
  headerIcon: { marginLeft: 12, marginRight: 0 },
  headerCenter: { flex: 1, marginLeft: 12 },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSubtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: ACCENT.teal.solid,
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
    backgroundColor: SEMANTIC.error.box,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    gap: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: SEMANTIC.error.text,
    fontWeight: "500",
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: SEMANTIC.info.bg,
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    gap: 8,
  },
  infoBannerText: {
    flex: 1,
    fontSize: 12,
    color: SEMANTIC.info.text,
    lineHeight: 18,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ACCENT.teal.wash,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  cardInactive: {
    opacity: 0.6,
    backgroundColor: COLORS.page,
  },
  cardAccent: {
    width: 5,
    alignSelf: "stretch",
    backgroundColor: ACCENT.teal.base,
  },
  cardAccentInactive: {
    backgroundColor: COLORS.textMuted,
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
    color: COLORS.text,
  },
  cardNameInactive: {
    color: COLORS.textSecondary,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  timeText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: "500",
  },
  breakBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  breakBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  inactiveBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  inactiveBadgeText: {
    fontSize: 11,
    fontWeight: "700",
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
    backgroundColor: COLORS.surface,
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
    backgroundColor: COLORS.surface,
  },
  addMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: ACCENT.teal.base,
    borderStyle: "dashed",
    marginTop: 4,
  },
  addMoreText: {
    fontSize: 15,
    fontWeight: "700",
    color: ACCENT.teal.deep,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  emptyIconWrap: {
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  emptyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ACCENT.teal.solid,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  emptyButtonText: {
    color: COLORS.onPrimary,
    fontSize: 15,
    fontWeight: "700",
  },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";