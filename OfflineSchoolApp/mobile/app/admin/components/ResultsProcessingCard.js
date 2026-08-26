// app/admin/components/ResultsProcessingCard.js
"use strict";

import React, { useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert,
} from "react-native";
import { router }      from "expo-router";
import { Ionicons }    from "@expo/vector-icons";
import { ExamService } from "../../../src/services/exam.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  success:   "#059669",
  successBg: "#D1FAE5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEE2E2",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// No Redux — uses local state + ExamService directly.
// ─────────────────────────────────────────────────────────

export default function ResultsProcessingCard({
  examId,
  exam,
  onProcessed,
}) {
  const { t } = useTranslation();

  const [processing,     setProcessing]     = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [processSuccess, setProcessSuccess] = useState(false);
  const [processData,    setProcessData]    = useState(null);
  const [processError,   setProcessError]   = useState(null);
  const [showConfirm,    setShowConfirm]    = useState(false);

  // ── Handlers ──────────────────────────────────────────

  const handleProcess = () => setShowConfirm(true);

  const confirmProcess = async () => {
    setShowConfirm(false);
    setProcessing(true);
    setProcessError(null);
    try {
      const res = await ExamService.processResults({
        examId,
        schoolId: exam?.schoolId,
      });
      setProcessSuccess(true);
      setProcessData(res);
      if (onProcessed) onProcessed();
    } catch (err) {
      setProcessError(err.message || t("resultsCard.processingFailed"));
    } finally {
      setProcessing(false);
    }
  };

  const handlePublish = () => {
    Alert.alert(
      t("examDetail.publishTitle"),
      t("resultsCard.publishBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:    t("examDetail.publish"),
          style:   "destructive",
          onPress: async () => {
            try {
              setPublishLoading(true);
              await ExamService.updateExamStatus(
                examId, "published", exam?.schoolId
              );
              if (onProcessed) onProcessed();
            } catch (err) {
              Alert.alert(t("examDetail.errorTitle"), err.message);
            } finally {
              setPublishLoading(false);
            }
          },
        },
      ]
    );
  };

  const handleDismiss = () => {
    setProcessSuccess(false);
    setProcessData(null);
    setProcessError(null);
  };

  const handleViewRankings = () =>
    router.push({
      pathname: "/admin/exams/results/[examId]",
      params:   { examId },
    });

  const handleGenerateReports = () =>
    router.push({
      pathname: "/admin/reports/generate",
      params: {
        examId,
        examName:     exam?.name         || "",
        term:         exam?.term         || "",
        academicYear: exam?.academicYear || "",
      },
    });

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <View style={s.card}>

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerIcon}>
          <Ionicons name="calculator-outline" size={22} color={C.primary} />
        </View>
        <View style={s.headerText}>
          <Text style={s.headerTitle}>{t("resultsCard.title")}</Text>
          <Text style={s.headerSub}>
            {t("resultsCard.subtitle")}
          </Text>
        </View>
      </View>

      {/* ── Success state ── */}
      {processSuccess && processData && (
        <View style={s.successBox}>
          <View style={s.successHeader}>
            <Ionicons name="checkmark-circle" size={20} color={C.success} />
            <Text style={s.successTitle}>{t("resultsCard.complete")}</Text>
            <TouchableOpacity onPress={handleDismiss} style={s.dismissBtn}>
              <Ionicons name="close" size={18} color={C.gray400} />
            </TouchableOpacity>
          </View>

          <View style={s.statsGrid}>
            <StatItem
              label={t("resultsCard.statProcessed")}
              value={processData.processed ?? 0}
            />
            <StatItem
              label={t("examResults.passed")}
              value={processData.stats?.passed ?? 0}
              color={C.success}
            />
            <StatItem
              label={t("examResults.failed")}
              value={processData.stats?.failed ?? 0}
              color={C.error}
            />
            <StatItem
              label={t("exams.passRate")}
              value={`${processData.stats?.passRate ?? 0}%`}
              color={C.primary}
            />
          </View>

          {processData.isPartial && (
            <View style={s.warningBox}>
              <Ionicons name="warning" size={16} color={C.warning} />
              <Text style={s.warningText}>
                {processData.warnings?.[0] || t("resultsCard.partial")}
              </Text>
            </View>
          )}

          {processData.warnings
            ?.slice(processData.isPartial ? 1 : 0)
            .map((w, i) => (
              <Text key={i} style={s.warningDetail}>• {w}</Text>
            ))}

          <View style={s.actionRow}>
            <TouchableOpacity
              style={s.outlineBtn}
              onPress={handleViewRankings}
              activeOpacity={0.8}
            >
              <Ionicons name="trophy-outline" size={15} color={C.primary} />
              <Text style={s.outlineBtnText}>{t("resultsCard.viewRankings")}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.solidBtn, publishLoading && s.disabled]}
              onPress={handlePublish}
              disabled={publishLoading}
              activeOpacity={0.8}
            >
              {publishLoading ? (
                <ActivityIndicator size="small" color={C.white} />
              ) : (
                <>
                  <Ionicons name="globe-outline" size={15} color={C.white} />
                  <Text style={s.solidBtnText}>
                    {t("resultsCard.publishResults")}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={s.reportCardsBtn}
            onPress={handleGenerateReports}
            activeOpacity={0.8}
          >
            <Ionicons name="print-outline" size={15} color={C.success} />
            <Text style={s.reportCardsBtnText}>
              {t("resultsCard.reportCards")}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={C.success} />
          </TouchableOpacity>

          <View style={s.hintBox}>
            <Ionicons
              name="information-circle-outline"
              size={14}
              color={C.primary}
            />
            <Text style={s.hintText}>
              {t("resultsCard.hint")}
            </Text>
          </View>
        </View>
      )}

      {/* ── Error state ── */}
      {processError && !processSuccess && (
        <View style={s.errorBox}>
          <Ionicons name="alert-circle" size={20} color={C.error} />
          <Text style={s.errorText}>{processError}</Text>
          <TouchableOpacity onPress={handleDismiss}>
            <Text style={s.dismissText}>{t("common.dismiss")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Confirm dialog ── */}
      {showConfirm && (
        <View style={s.confirmBox}>
          <Text style={s.confirmTitle}>{t("resultsCard.confirmTitle")}</Text>
          <Text style={s.confirmText}>
            {t("resultsCard.confirmBody")}
          </Text>
          <View style={s.confirmActions}>
            <TouchableOpacity
              style={s.cancelBtn}
              onPress={() => setShowConfirm(false)}
            >
              <Text style={s.cancelBtnText}>{t("common.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.confirmBtn} onPress={confirmProcess}>
              <Text style={s.confirmBtnText}>{t("resultsCard.processNow")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Process button (idle) ── */}
      {!showConfirm && !processSuccess && (
        <TouchableOpacity
          style={[s.processBtn, processing && s.disabled]}
          onPress={handleProcess}
          disabled={processing}
          activeOpacity={0.8}
        >
          {processing ? (
            <>
              <ActivityIndicator size="small" color={C.white} />
              <Text style={s.processBtnText}>{t("resultsCard.processing")}</Text>
            </>
          ) : (
            <>
              <Ionicons name="play-circle" size={20} color={C.white} />
              <Text style={s.processBtnText}>{t("examDetail.processResults")}</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STAT ITEM
// ─────────────────────────────────────────────────────────

function StatItem({ label, value, color }) {
  return (
    <View style={s.statItem}>
      <Text style={[s.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    backgroundColor: C.white,
    borderRadius:    16,
    padding:         20,
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.06,
    shadowRadius:    8,
    elevation:       3,
  },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  headerIcon: {
    width:           40,
    height:          40,
    borderRadius:    10,
    backgroundColor: "#EFF6FF",
    justifyContent:  "center",
    alignItems:      "center",
    marginRight:     12,
  },
  headerText:  { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: C.gray900 },
  headerSub:   { fontSize: 13, color: C.gray500, marginTop: 2 },
  successBox: {
    backgroundColor: C.successBg,
    borderRadius:    12,
    padding:         16,
    marginBottom:    12,
    gap:             10,
  },
  successHeader: { flexDirection: "row", alignItems: "center" },
  successTitle: {
    fontSize:   15,
    fontWeight: "600",
    color:      C.success,
    marginLeft: 8,
    flex:       1,
  },
  dismissBtn:  { padding: 4 },
  statsGrid:   { flexDirection: "row", justifyContent: "space-around" },
  statItem:    { alignItems: "center" },
  statValue:   { fontSize: 22, fontWeight: "800", color: C.gray900 },
  statLabel:   { fontSize: 11, color: C.gray500, marginTop: 2 },
  warningBox: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: C.warningBg,
    borderRadius:    8,
    padding:         10,
    gap:             8,
  },
  warningText:   { fontSize: 12, color: C.warning, flex: 1, lineHeight: 18 },
  warningDetail: { fontSize: 11, color: C.gray600, marginLeft: 4 },
  actionRow:     { flexDirection: "row", gap: 8 },
  outlineBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    backgroundColor: C.white,
    borderRadius:    10,
    paddingVertical: 11,
    borderWidth:     1.5,
    borderColor:     C.primary,
  },
  outlineBtnText: { fontSize: 13, fontWeight: "700", color: C.primary },
  solidBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    backgroundColor: C.success,
    borderRadius:    10,
    paddingVertical: 12,
  },
  solidBtnText: { fontSize: 13, fontWeight: "600", color: C.white },
  reportCardsBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   C.white,
    borderRadius:      10,
    paddingVertical:   11,
    paddingHorizontal: 14,
    borderWidth:       1.5,
    borderColor:       C.success,
  },
  reportCardsBtnText: {
    flex:       1,
    fontSize:   13,
    fontWeight: "700",
    color:      C.success,
  },
  hintBox: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             6,
    backgroundColor: "#EFF6FF",
    borderRadius:    8,
    padding:         10,
  },
  hintText: { flex: 1, fontSize: 11, color: C.primary, lineHeight: 16 },
  errorBox: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: C.errorBg,
    borderRadius:    10,
    padding:         12,
    marginBottom:    12,
    gap:             8,
  },
  errorText:   { fontSize: 13, color: C.error, flex: 1 },
  dismissText: { fontSize: 13, fontWeight: "600", color: C.primary },
  confirmBox: {
    backgroundColor: C.gray50,
    borderRadius:    12,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     C.gray200,
  },
  confirmTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        C.gray900,
    marginBottom: 8,
  },
  confirmText: {
    fontSize:     13,
    color:        C.gray600,
    lineHeight:   20,
    marginBottom: 16,
  },
  confirmActions: { flexDirection: "row", gap: 12 },
  cancelBtn: {
    flex:            1,
    paddingVertical: 10,
    borderRadius:    8,
    borderWidth:     1,
    borderColor:     C.gray200,
    alignItems:      "center",
  },
  cancelBtnText: { fontSize: 14, fontWeight: "500", color: C.gray600 },
  confirmBtn: {
    flex:            1,
    paddingVertical: 10,
    borderRadius:    8,
    backgroundColor: C.primary,
    alignItems:      "center",
  },
  confirmBtnText: { fontSize: 14, fontWeight: "600", color: C.white },
  processBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: C.primary,
    borderRadius:    12,
    paddingVertical: 14,
    gap:             8,
  },
  processBtnText: { fontSize: 15, fontWeight: "600", color: C.white },
  disabled:       { opacity: 0.6 },
});