// app/student/quizzes/history.js

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter }        from "expo-router";
import { Ionicons }         from "@expo/vector-icons";
import { useAuthStore }     from "../../../src/store/auth.store";
import { getUserAttempts }  from "../../../src/services/quiz.service";
import { useTranslation }   from "../../../src/i18n/useTranslation";
import { StatTile } from "../../../src/components/Tiles";
import { COLORS, ACCENT, SEMANTIC, accentBadge, statusBadge } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatDate = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
  });
};

const formatTime = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour:   "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const formatDuration = (secs) => {
  if (!secs) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const getScoreColor = (percentage, passingScore = 70) => {
  if (percentage >= passingScore) return SEMANTIC.success.text;
  if (percentage >= passingScore * 0.7) return SEMANTIC.warning.text;
  return SEMANTIC.error.text;
};

const getScoreBg = (percentage, passingScore = 70) => {
  if (percentage >= passingScore) return SEMANTIC.success.box;
  if (percentage >= passingScore * 0.7) return SEMANTIC.warning.box;
  return SEMANTIC.error.box;
};

// ─────────────────────────────────────────────────────────────
// ATTEMPT CARD
// ─────────────────────────────────────────────────────────────

const AttemptCard = ({ item }) => {
  const { t }          = useTranslation();
  const pct            = Math.round(item.percentage || 0);
  const passingScore   = item.passing_score ?? 70;
  const scoreColor     = getScoreColor(pct, passingScore);
  const scoreBg        = getScoreBg(pct, passingScore);
  const duration       = formatDuration(item.time_taken_secs);

  return (
    <View style={[styles.card, { borderLeftColor: item.is_passed ? SEMANTIC.success.icon : SEMANTIC.error.icon }]}>
      {/* Score circle + title */}
      <View style={styles.cardTop}>
        <View style={[styles.scoreBg, { backgroundColor: scoreBg }]}>
          <Text style={[styles.scoreText, { color: scoreColor }]}>
            {pct}%
          </Text>
          <Text style={[styles.scoreLabel, { color: scoreColor }]}>
            {item.is_passed ? t("quizHistory.scoreLabel") : t("quizHistory.failBadge")}
          </Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.quizTitle} numberOfLines={2}>
            {item.title ?? t("quizHistory.quizFallback")}
          </Text>

          {(item.subject_name || item.class_name) ? (
            <Text style={styles.quizMeta}>
              {[item.subject_name, item.class_name]
                .filter(Boolean)
                .join("  ·  ")}
            </Text>
          ) : null}

          <View style={styles.badgeRow}>
            {/* Pass / Fail badge */}
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: statusBadge(item.is_passed ? "success" : "error").bg,
                  borderColor:     statusBadge(item.is_passed ? "success" : "error").border,
                },
              ]}
            >
              <Ionicons
                name={item.is_passed ? "checkmark-circle" : "close-circle"}
                size={12}
                color={item.is_passed ? SEMANTIC.success.text : SEMANTIC.error.text}
              />
              <Text
                style={[
                  styles.badgeText,
                  { color: item.is_passed ? SEMANTIC.success.text : SEMANTIC.error.text },
                ]}
              >
                {item.is_passed ? t("quizHistory.passBadge") : t("quizHistory.failBadge")}
              </Text>
            </View>

            {/* Attempt number */}
            <View style={styles.badge}>
              <Ionicons name="refresh-outline" size={12} color={ACCENT.indigo.deep} />
              <Text style={styles.badgeText}>
                {t("quizHistory.attemptBadge", { number: item.attempt_number || 1 })}
              </Text>
            </View>

            {/* Duration */}
            {duration ? (
              <View style={styles.badge}>
                <Ionicons name="time-outline" size={12} color={ACCENT.indigo.deep} />
                <Text style={styles.badgeText}>{duration}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* Score breakdown */}
      <View style={styles.breakdown}>
        {item.raw_score != null && item.max_score != null ? (
          <View style={styles.breakdownItem}>
            <Ionicons name="star-outline" size={13} color={ACCENT.indigo.solid} />
            <Text style={styles.breakdownText}>
              {item.raw_score} / {item.max_score} pts
            </Text>
          </View>
        ) : null}

        {item.passing_score != null ? (
          <View style={styles.breakdownItem}>
            <Ionicons name="ribbon-outline" size={13} color={ACCENT.indigo.solid} />
            <Text style={styles.breakdownText}>
              {t("quizHistory.passMark", { mark: item.passing_score })}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Date */}
      {(item.submitted_at || item.started_at) ? (
        <View style={styles.dateRow}>
          <Ionicons name="calendar-outline" size={12} color={ACCENT.indigo.solid} />
          <Text style={styles.dateText}>
            {formatDate(item.submitted_at || item.started_at)}
            {item.submitted_at
              ? `  ${t("quizHistory.atTime")}  ${formatTime(item.submitted_at)}`
              : ""}
          </Text>
        </View>
      ) : null}

      {/* Score bar */}
      <View style={styles.barBg}>
        <View
          style={[
            styles.barFill,
            {
              width:           `${Math.min(pct, 100)}%`,
              backgroundColor: scoreColor,
            },
          ]}
        />
        <View
          style={[
            styles.barMarker,
            { left: `${Math.min(passingScore, 100)}%` },
          ]}
        />
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────

export default function QuizHistoryScreen() {
  const router  = useRouter();
  const userId  = useAuthStore(
    (s) => s.user?._id || s.user?.id || s.user?.userId
  );
  const { t }   = useTranslation();

  const [attempts,   setAttempts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter,     setFilter]     = useState("all");

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    if (!userId) { setLoading(false); return; }

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      const data = await getUserAttempts(userId);

      if (isMounted.current) {
        setAttempts(
          (data ?? []).sort(
            (a, b) =>
              new Date(b.submitted_at || b.started_at || 0) -
              new Date(a.submitted_at || a.started_at || 0)
          )
        );
      }
    } catch (err) {
      console.warn("[QuizHistory] load error:", err.message);
    } finally {
      if (isMounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [userId]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = attempts.filter((a) => {
    if (filter === "passed") return !!a.is_passed;
    if (filter === "failed") return !a.is_passed;
    return true;
  });

  const stats = {
    total:  attempts.length,
    passed: attempts.filter((a) =>  a.is_passed).length,
    failed: attempts.filter((a) => !a.is_passed).length,
    avgPct: attempts.length
      ? Math.round(
          attempts.reduce((s, a) => s + (a.percentage || 0), 0) /
          attempts.length
        )
      : null,
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.indigo.solid} />
        <Text style={styles.loadingText}>{t("quizHistory.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={{ marginRight: 0 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("quizHistory.title")}</Text>
          <Text style={styles.headerSub}>
            {stats.total === 1
              ? t("quizHistory.oneAttempt")
              : t("quizHistory.manyAttempts", { count: stats.total })}
          </Text>
        </View>
      </View>

      {/* Stats row */}
      {attempts.length > 0 && (
        <View style={styles.statsRow}>
          {[
            { key: "total",   label: t("quizHistory.totalStat"),      value: stats.total },
            { key: "passed",  label: t("quizHistory.passedStat"),     value: stats.passed, tone: "success" },
            { key: "failed",  label: t("quizHistory.failedStat"),     value: stats.failed, tone: "error" },
            { key: "avg",     label: t("quizHistory.avgStat"),        value: stats.avgPct != null ? `${stats.avgPct}%` : "—" },
          ].map((s) => (
            <StatTile key={s.key} kind="quizzes" tone={s.tone} value={s.value} label={s.label} />
          ))}
        </View>
      )}

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {[
          { id: "all",    label: t("quizHistory.filterAll",    { count: stats.total }) },
          { id: "passed", label: t("quizHistory.filterPassed", { count: stats.passed }) },
          { id: "failed", label: t("quizHistory.filterFailed", { count: stats.failed }) },
        ].map((f) => (
          <TouchableOpacity
            key={f.id}
            style={[
              styles.filterChip,
              filter === f.id && styles.filterChipActive,
            ]}
            onPress={() => setFilter(f.id)}
          >
            <Text
              style={[
                styles.filterChipText,
                filter === f.id && styles.filterChipTextActive,
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id || item._id)}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor={ACCENT.indigo.solid}
            colors={[ACCENT.indigo.solid]}
          />
        }
        renderItem={({ item }) => <AttemptCard item={item} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <IconSquare icon="document-text-outline" accent="indigo" size={56} radius={16} />
            <Text style={styles.emptyTitle}>
              {filter === "all"
                ? t("quizHistory.allEmptyTitle")
                : t("quizHistory.filterEmptyTitle", { filter })}
            </Text>
            <Text style={styles.emptySubtitle}>
              {filter === "all"
                ? t("quizHistory.allEmptySub")
                : t("quizHistory.filterEmptySub")}
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: COLORS.page },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: COLORS.page },
  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.textSecondary, fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: ACCENT.slate.wash,
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },

  statsRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },

  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
  },
  filterChipActive:     { backgroundColor: ACCENT.indigo.wash, borderColor: ACCENT.indigo.base },
  filterChipText:       { fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  filterChipTextActive: { color: ACCENT.indigo.deep, fontWeight: "700" },

  listContent: { padding: 16, paddingBottom: 32 },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 16,
    padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.border, borderLeftWidth: 3,
    shadowColor: COLORS.shadow, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  cardTop: {
    flexDirection: "row", alignItems: "flex-start",
    gap: 12, marginBottom: 10,
  },
  scoreBg: {
    width: 58, height: 58, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  scoreText:  { fontSize: 16, fontWeight: "800" },
  scoreLabel: { fontSize: 10, fontWeight: "700", marginTop: 1 },

  quizTitle: { fontSize: 14, fontWeight: "700", color: COLORS.text },
  quizMeta:  { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },

  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 6 },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: accentBadge("indigo").bg, borderRadius: 6,
    borderWidth: 1, borderColor: accentBadge("indigo").border,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  badgeText: { fontSize: 10, color: accentBadge("indigo").text, fontWeight: "600" },

  breakdown: {
    flexDirection: "row", gap: 12,
    paddingTop: 10,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    marginBottom: 8,
  },
  breakdownItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  breakdownText: { fontSize: 11, color: COLORS.textSecondary },

  dateRow: {
    flexDirection: "row", alignItems: "center", gap: 4,
    marginBottom: 10,
  },
  dateText: { fontSize: 11, color: COLORS.textSecondary },

  barBg: {
    height: 6, backgroundColor: ACCENT.slate.wash,
    borderRadius: 3, overflow: "visible",
    position: "relative",
  },
  barFill: {
    height: 6, borderRadius: 3,
    position: "absolute", left: 0, top: 0,
  },
  barMarker: {
    position: "absolute", top: -3,
    width: 2, height: 12,
    backgroundColor: COLORS.text,
    borderRadius: 1,
    transform: [{ translateX: -1 }],
  },

  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: COLORS.text },
  emptySubtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center" },
});