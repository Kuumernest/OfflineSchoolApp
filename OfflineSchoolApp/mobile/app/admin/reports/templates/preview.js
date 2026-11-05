// app/admin/reports/templates/preview.js
"use strict";

import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { WebView }         from "react-native-webview";
import { Ionicons }        from "@expo/vector-icons";
import { TemplateService } from "../../../../src/services/template.service";
import { COLORS, SEMANTIC } from "../../../../src/theme/colors";
import { HeaderIcon } from "../../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   COLORS.primary,
  primaryBg: COLORS.primaryLight,
  white:     COLORS.surface,
  gray50:    COLORS.page,
  gray100:   COLORS.border,
  gray400:   COLORS.textSubtle,
  gray500:   COLORS.textSecondary,
  gray900:   COLORS.text,
  error:     SEMANTIC.error.text,
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TemplatePreviewScreen() {
  const { t } = useTranslation();
  const { templateId, examId, studentId } = useLocalSearchParams();

  const [html,    setHtml]    = useState(null);
  const [name,    setName]    = useState(t("templates.previewTitle"));
  const [isRaw,   setIsRaw]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!templateId) {
      setError(t("templatesList.noTemplateId"));
      setLoading(false);
      return;
    }

    TemplateService.preview(
      templateId,
      examId    || null,
      studentId || null,
    )
      .then((res) => {
        setHtml(res.renderedHtml);
        setName(res.templateName || t("templates.previewTitle"));
        setIsRaw(res.isRaw       || false);
      })
      .catch((err) => {
        setError(err?.response?.data?.error || needsInternetFailureText(t, err));
      })
      .finally(() => setLoading(false));
  }, [templateId, examId, studentId, t]);

  return (
    <View style={s.screen}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={s.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <HeaderIcon style={s.headerIcon} />
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>{name}</Text>
          <Text style={s.headerSub}>
            {examId ? t("templatesList.livePreview") : t("templatesList.layoutPreview")}
          </Text>
        </View>
        {templateId && (
          <TouchableOpacity
            style={s.editBtn}
            onPress={() =>
              router.replace({
                pathname: "/admin/reports/templates/builder",
                params:   { templateId },
              })
            }
            activeOpacity={0.7}
          >
            <Ionicons name="create-outline" size={18} color={C.primary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Raw HTML banner */}
      {isRaw && !loading && !error && (
        <View style={s.rawBanner}>
          <Ionicons
            name="information-circle-outline"
            size={16}
            color={C.primary}
          />
          <Text style={s.rawBannerText}>
            {t("templatesList.previewNote1")}{" "}
            {t("templatesList.previewNote2")}
          </Text>
        </View>
      )}

      {/* Loading */}
      {loading && (
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadingText}>{t("templatesList.rendering")}</Text>
        </View>
      )}

      {/* Error */}
      {error && !loading && (
        <View style={s.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={SEMANTIC.error.icon} />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <Text style={s.retryBtnText}>{t("common.goBack")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* WebView */}
      {html && !loading && !error && (
        <WebView
          source={{ html }}
          style={{ flex: 1 }}
          scrollEnabled
          showsVerticalScrollIndicator
          originWhitelist={["*"]}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: C.gray50 },
  centered:{
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    gap:            12,
    padding:        24,
  },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:   { marginRight: 0 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  editBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.primaryBg,
    alignItems:      "center",
    justifyContent:  "center",
  },
  rawBanner: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    gap:               8,
    backgroundColor:   SEMANTIC.info.bg,
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.info.box,
  },
  rawBannerText: { flex: 1, fontSize: 12, color: SEMANTIC.info.text, lineHeight: 18 },
  loadingText:   { fontSize: 14, color: C.gray500 },
  errorText: {
    fontSize:   14,
    color:      C.error,
    textAlign:  "center",
    lineHeight: 20,
  },
  retryBtn: {
    backgroundColor:   C.primary,
    borderRadius:      10,
    paddingHorizontal: 20,
    paddingVertical:   10,
    marginTop:         8,
  },
  retryBtnText: { fontSize: 14, fontWeight: "600", color: C.white },
});
import { useTranslation } from "../../../../src/i18n/useTranslation";
// Templates are kept on the server (online-only): offline failures say so.
import { needsInternetFailureText } from "../../../../src/hooks/useNeedsInternet";