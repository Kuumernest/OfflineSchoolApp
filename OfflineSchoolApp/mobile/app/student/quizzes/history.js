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
  if (percentage >= passingScore) return "#059669";
  if (percentage >= passingScore * 0.7) return "#D97706";
  return "#DC2626";
};

const getScoreBg = (percentage, passingScore = 70) => {
  if (percentage >= passingScore) return "#ECFDF5";
  if (percentage >= passingScore * 0.7) return "#FEF3C7";
  return "#FEE2E2";
};

// ─────────────────────────────────────────────────────────────
// ATTEMPT CARD
// ─────────────────────────────────────────────────────────────

const AttemptCard = ({ item }) => {
  const pct          = Math.round(item.percentage || 0);
  const passingScore = item.passing_score ?? 70;
  const scoreColor   = getScoreColor(pct, passingScore);
  const scoreBg      = getScoreBg(pct, passingScore);
  const duration     = formatDuration(item.time_taken_secs);

  return (
    <View style={styles.card}>
      {/* Score circle + title */}
      <View style={styles.cardTop}>
        <View style={[styles.scoreBg, { backgroundColor: scoreBg }]}>
          <Text style={[styles.scoreText, { color: scoreColor }]}>
            {pct}%
          </Text>
          <Text style={[styles.scoreLabel, { color: scoreColor }]}>
            {item.is_passed ? "Pass" : "Fail"}
          </Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.quizTitle} numberOfLines={2}>
            {item.title ?? "Quiz"}
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
                { backgroundColor: item.is_passed ? "#ECFDF5" : "#FEE2E2" },
              ]}
            >
              <Ionicons
                name={item.is_passed ? "checkmark-circle" : "close-circle"}
                size={12}
                color={item.is_passed ? "#059669" : "#DC2626"}
              />
              <Text
                style={[
                  styles.badgeText,
                  { color: item.is_passed ? "#059669" : "#DC2626" },
                ]}
              >
                {item.is_passed ? "Passed" : "Failed"}
              </Text>
            </View>

            {/* Attempt number */}
            <View style={styles.badge}>
              <Ionicons name="refresh-outline" size={12} color="#6B7280" />
              <Text style={styles.badgeText}>
                Attempt {item.attempt_number || 1}
              </Text>
            </View>

            {/* Duration */}
            {duration ? (
              <View style={styles.badge}>
                <Ionicons name="time-outline" size={12} color="#6B7280" />
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
            <Ionicons name="star-outline" size={13} color="#9CA3AF" />
            <Text style={styles.breakdownText}>
              {item.raw_score} / {item.max_score} pts
            </Text>
          </View>
        ) : null}

        {item.passing_score != null ? (
          <View style={styles.breakdownItem}>
            <Ionicons name="ribbon-outline" size={13} color="#9CA3AF" />
            <Text style={styles.breakdownText}>
              Pass mark: {item.passing_score}%
            </Text>
          </View>
        ) : null}
      </View>

      {/* Date */}
      {(item.submitted_at || item.started_at) ? (
        <View style={styles.dateRow}>
          <Ionicons name="calendar-outline" size={12} color="#9CA3AF" />
          <Text style={styles.dateText}>
            {formatDate(item.submitted_at || item.started_at)}
            {item.submitted_at
              ? `  at  ${formatTime(item.submitted_at)}`
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
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading quiz history…</Text>
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
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Quiz History</Text>
          <Text style={styles.headerSub}>
            {stats.total} attempt{stats.total !== 1 ? "s" : ""}
          </Text>
        </View>
      </View>

      {/* Stats row */}
      {attempts.length > 0 && (
        <View style={styles.statsRow}>
          {[
            { label: "Total",     value: stats.total,                                color: "#4F46E5", bg: "#EEF2FF" },
            { label: "Passed",    value: stats.passed,                               color: "#059669", bg: "#ECFDF5" },
            { label: "Failed",    value: stats.failed,                               color: "#DC2626", bg: "#FEE2E2" },
            { label: "Avg Score", value: stats.avgPct != null ? `${stats.avgPct}%` : "—", color: "#D97706", bg: "#FEF3C7" },
          ].map((s) => (
            <View
              key={s.label}
              style={[styles.statCard, { backgroundColor: s.bg }]}
            >
              <Text style={[styles.statValue, { color: s.color }]}>
                {s.value}
              </Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {[
          { id: "all",    label: `All (${stats.total})`     },
          { id: "passed", label: `Passed (${stats.passed})` },
          { id: "failed", label: `Failed (${stats.failed})` },
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
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
        renderItem={({ item }) => <AttemptCard item={item} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={56} color="#D1D5DB" />
            <Text style={styles.emptyTitle}>
              {filter === "all"
                ? "No quiz attempts yet"
                : `No ${filter} attempts`}
            </Text>
            <Text style={styles.emptySubtitle}>
              {filter === "all"
                ? "Complete a quiz to see your history here"
                : "Try a different filter"}
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
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F3F4F6" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 14,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 1 },

  statsRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  statCard: {
    flex: 1, borderRadius: 10,
    paddingVertical: 10, alignItems: "center", gap: 2,
  },
  statValue: { fontSize: 16, fontWeight: "800" },
  statLabel: { fontSize: 9, color: "#6B7280", fontWeight: "500" },

  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6", gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, backgroundColor: "#F3F4F6",
    borderWidth: 1, borderColor: "transparent",
  },
  filterChipActive:     { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  filterChipText:       { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  filterChipTextActive: { color: "#4F46E5", fontWeight: "700" },

  listContent: { padding: 16, paddingBottom: 32 },

  card: {
    backgroundColor: "#FFF", borderRadius: 16,
    padding: 14, marginBottom: 12,
    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
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

  quizTitle: { fontSize: 14, fontWeight: "700", color: "#111827" },
  quizMeta:  { fontSize: 11, color: "#9CA3AF", marginTop: 2 },

  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 6 },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "#F3F4F6", borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  badgeText: { fontSize: 10, color: "#6B7280", fontWeight: "600" },

  breakdown: {
    flexDirection: "row", gap: 12,
    paddingTop: 10,
    borderTopWidth: 1, borderTopColor: "#F3F4F6",
    marginBottom: 8,
  },
  breakdownItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  breakdownText: { fontSize: 11, color: "#6B7280" },

  dateRow: {
    flexDirection: "row", alignItems: "center", gap: 4,
    marginBottom: 10,
  },
  dateText: { fontSize: 11, color: "#9CA3AF" },

  barBg: {
    height: 6, backgroundColor: "#F3F4F6",
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
    backgroundColor: "#374151",
    borderRadius: 1,
    transform: [{ translateX: -1 }],
  },

  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 24, gap: 8,
  },
  emptyTitle:    { fontSize: 16, fontWeight: "700", color: "#374151" },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});