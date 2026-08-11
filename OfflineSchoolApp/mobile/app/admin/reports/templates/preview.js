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

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray900:   "#111827",
  error:     "#DC2626",
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TemplatePreviewScreen() {
  const { templateId, examId, studentId } = useLocalSearchParams();

  const [html,    setHtml]    = useState(null);
  const [name,    setName]    = useState("Preview");
  const [isRaw,   setIsRaw]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!templateId) {
      setError("No template ID provided.");
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
        setName(res.templateName || "Preview");
        setIsRaw(res.isRaw       || false);
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err.message);
      })
      .finally(() => setLoading(false));
  }, [templateId, examId, studentId]);

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
        <View style={s.headerCenter}>
          <Text style={s.headerTitle} numberOfLines={1}>{name}</Text>
          <Text style={s.headerSub}>
            {examId ? "Live Preview" : "Layout Preview"}
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
            Showing layout only — placeholders are still visible.
            Open with a real student to see filled data.
          </Text>
        </View>
      )}

      {/* Loading */}
      {loading && (
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadingText}>Rendering preview…</Text>
        </View>
      )}

      {/* Error */}
      {error && !loading && (
        <View style={s.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={C.error} />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => router.back()}
            activeOpacity={0.7}
          >
            <Text style={s.retryBtnText}>Go Back</Text>
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
    backgroundColor:   C.primaryBg,
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: C.primary + "20",
  },
  rawBannerText: { flex: 1, fontSize: 12, color: C.primary, lineHeight: 18 },
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