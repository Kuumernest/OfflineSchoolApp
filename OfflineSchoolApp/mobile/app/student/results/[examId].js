// app/student/results/[examId].js
// Student's own report card view for a specific exam

import React, { useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, StatusBar, Share,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useDispatch, useSelector }     from "react-redux";
import { Ionicons }                     from "@expo/vector-icons";
import { useAuthStore }                 from "../../../src/store/auth.store";
import ReportCard                       from "../../admin/components/ReportCard";
import {
  fetchMyExamResult,
  fetchExamById,
  clearMyExamResult,
} from "../../../src/store/slices/resultsSlice";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const COLORS = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  error:     "#DC2626",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function StudentReportCardScreen() {
  const { examId }  = useLocalSearchParams();
  const dispatch    = useDispatch();
  const user        = useAuthStore((s) => s.user);
  const studentId   = user?._id || user?.id;
  const schoolId    = user?.schoolId;

  const {
    myExamResult,
    myExamResultLoading,
    currentExam,
    error,
  } = useSelector((s) => s.results);

  // ── Load data ─────────────────────────────────────────────

  const load = useCallback(() => {
    if (!examId || !studentId) return;

    dispatch(fetchMyExamResult({ examId, studentId, schoolId }));
    dispatch(fetchExamById({ examId, schoolId }));
  }, [examId, studentId, schoolId, dispatch]);

  useEffect(() => {
    load();
    // Clean up when leaving the screen
    return () => { dispatch(clearMyExamResult()); };
  }, [load]);

  // ── Share ─────────────────────────────────────────────────

  const handleShare = async () => {
    try {
      const result = myExamResult;
      const msg    =
        `📋 My Report Card\n` +
        `Exam: ${currentExam?.name || "Examination"}\n` +
        `Score: ${result?.percentage?.toFixed(1) ?? "—"}%\n` +
        `Grade: ${result?.overallGrade || "—"}\n` +
        `Position: ${
          result?.classPosition
            ? `#${result.classPosition} in class`
            : "—"
        }\n` +
        `Result: ${result?.isPassing ? "✅ PASS" : "❌ FAIL"}`;

      await Share.share({ message: msg });
    } catch (err) {
      Alert.alert("Share Failed", err.message);
    }
  };

  // ── Loading ───────────────────────────────────────────────

  if (myExamResultLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading your report card…</Text>
      </View>
    );
  }

  // ── Error / not found ─────────────────────────────────────

  if (error || !myExamResult) {
    return (
      <View style={styles.centered}>
        <Ionicons name="document-outline" size={56} color={COLORS.gray200} />
        <Text style={styles.errorTitle}>
          {error || "Report card not available"}
        </Text>
        <Text style={styles.errorSub}>
          Results may not be published yet. Check back later.
        </Text>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.8}
        >
          <Text style={styles.backBtnText}>Go Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={load}
          activeOpacity={0.8}
        >
          <Ionicons name="refresh-outline" size={16} color={COLORS.primary} />
          <Text style={styles.retryBtnText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.white} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBack}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.gray900} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {currentExam?.name || "Report Card"}
          </Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {[currentExam?.academicYear, currentExam?.term]
              .filter(Boolean)
              .join("  ·  ") || user?.name || "My Results"}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.shareBtn}
          onPress={handleShare}
          activeOpacity={0.8}
        >
          <Ionicons name="share-outline" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {/* Pass/Fail banner */}
      <View style={[
        styles.resultBanner,
        {
          backgroundColor: myExamResult.isPassing
            ? COLORS.success + "15"
            : COLORS.error   + "15",
          borderColor: myExamResult.isPassing
            ? COLORS.success + "40"
            : COLORS.error   + "40",
        },
      ]}>
        <Ionicons
          name={myExamResult.isPassing
            ? "checkmark-circle"
            : "close-circle"}
          size={20}
          color={myExamResult.isPassing ? COLORS.success : COLORS.error}
        />
        <Text style={[
          styles.resultBannerText,
          {
            color: myExamResult.isPassing ? COLORS.success : COLORS.error,
          },
        ]}>
          {myExamResult.isPassing
            ? `You passed with ${myExamResult.percentage?.toFixed(1)}%`
            : `You scored ${myExamResult.percentage?.toFixed(1)}% — not yet passed`}
        </Text>
      </View>

      {/* Report card component */}
      <ReportCard
        result={myExamResult}
        exam={currentExam}
        schoolName={user?.schoolName || user?.school?.name}
        examId={String(examId)}
        studentId={String(studentId)}
        schoolId={schoolId}
        showRankings
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.gray50 },

  // ── Centered (loading / error) ────────────────────────────
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    gap:             12,
    padding:         32,
    backgroundColor: COLORS.gray50,
  },
  loadingText: {
    fontSize:  14,
    color:     COLORS.gray500,
    marginTop: 8,
  },
  errorTitle: {
    fontSize:   15,
    fontWeight: "700",
    color:      COLORS.gray700,
    textAlign:  "center",
  },
  errorSub: {
    fontSize:   13,
    color:      COLORS.gray500,
    textAlign:  "center",
    lineHeight: 20,
  },
  backBtn: {
    backgroundColor:   COLORS.primary,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 28,
    marginTop:         4,
  },
  backBtnText: {
    color:      COLORS.white,
    fontWeight: "700",
    fontSize:   14,
  },
  retryBtn: {
    flexDirection:  "row",
    alignItems:     "center",
    gap:            6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius:   10,
    borderWidth:    1,
    borderColor:    COLORS.primary + "40",
    backgroundColor: COLORS.primaryBg,
  },
  retryBtnText: {
    color:      COLORS.primary,
    fontWeight: "600",
    fontSize:   14,
  },

  // ── Header ───────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray100,
    gap:               10,
  },
  headerBack: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1 },
  headerTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      COLORS.gray900,
  },
  headerSub: {
    fontSize:  11,
    color:     COLORS.gray500,
    marginTop: 2,
  },
  shareBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.primaryBg,
    alignItems:      "center",
    justifyContent:  "center",
  },

  // ── Result banner ─────────────────────────────────────────
  resultBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    marginHorizontal:  16,
    marginTop:         12,
    marginBottom:      4,
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 14,
    borderWidth:       1,
  },
  resultBannerText: {
    fontSize:   13,
    fontWeight: "600",
    flex:       1,
  },
});