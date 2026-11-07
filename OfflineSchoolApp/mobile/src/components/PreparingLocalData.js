// mobile/src/components/PreparingLocalData.js
"use strict";

/**
 * Shown while this account's own local data has its first full sync
 * (docs/40, per-user local data). No data screen is mounted meanwhile, so
 * nobody ever reads a half-filled store. "Use the app now" stops the sync and
 * returns to the shared data this phone has always used; the next online
 * sign-in tries again.
 */

import React, { useState } from "react";
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet } from "react-native";
import { useAuthStore } from "../store/auth.store";
import { useTranslation } from "../i18n/useTranslation";

export default function PreparingLocalData() {
  const { t } = useTranslation();
  const skip = useAuthStore((s) => s.skipPreparingLocalData);
  const [stopping, setStopping] = useState(false);

  return (
    <View style={styles.wrap} accessibilityRole="progressbar">
      <ActivityIndicator size="large" color="#4F46E5" />
      <Text style={styles.title}>{t("localData.preparingTitle")}</Text>
      <Text style={styles.body}>{t("localData.preparingBody")}</Text>
      <TouchableOpacity
        style={[styles.button, stopping && styles.disabled]}
        disabled={stopping}
        onPress={() => { setStopping(true); skip?.(); }}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>
          {stopping ? t("localData.preparingStopping") : t("localData.preparingSkip")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:       { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14, backgroundColor: "#F9FAFB" },
  title:      { fontSize: 18, fontWeight: "700", color: "#111827", textAlign: "center" },
  body:       { fontSize: 14, color: "#4B5563", textAlign: "center", lineHeight: 20 },
  button:     { marginTop: 12, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: "#4F46E5" },
  disabled:   { opacity: 0.6 },
  buttonText: { color: "#4F46E5", fontWeight: "600" },
});
