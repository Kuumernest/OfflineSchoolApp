// mobile/src/components/UpdateRequired.js
"use strict";

/**
 * Shown instead of every screen when this build may not go on (docs/40 §8.9):
 *
 *   - "server": the school's data needs a newer app (426 APP_UPDATE_REQUIRED).
 *     "Check again" lets the app try once more (the school may have turned the
 *     switch off); the sync stays stopped until then.
 *   - "local-data-format": a newer build wrote this phone's data. Nothing is
 *     opened, changed or sent; only installing that newer build helps.
 *
 * Nothing is signed out or deleted: the session, the local data and every
 * unsent change are kept for the updated app.
 */

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useAuthStore } from "../store/auth.store";
import { useTranslation } from "../i18n/useTranslation";

export default function UpdateRequired() {
  const { t } = useTranslation();
  const reason = useAuthStore((s) => s.updateRequiredReason);
  const checkAgain = useAuthStore((s) => s.clearUpdateRequired);
  const fromServer = reason !== "local-data-format";

  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Text style={styles.title}>{t("updateRequired.title")}</Text>
      <Text style={styles.body}>
        {fromServer ? t("updateRequired.bodyServer") : t("updateRequired.bodyLocal")}
      </Text>
      <Text style={styles.kept}>{t("updateRequired.kept")}</Text>
      {fromServer && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => checkAgain?.()}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>{t("updateRequired.checkAgain")}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:       { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14, backgroundColor: "#F9FAFB" },
  title:      { fontSize: 18, fontWeight: "700", color: "#111827", textAlign: "center" },
  body:       { fontSize: 14, color: "#4B5563", textAlign: "center", lineHeight: 20 },
  kept:       { fontSize: 13, color: "#6B7280", textAlign: "center", lineHeight: 18 },
  button:     { marginTop: 12, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: "#4F46E5" },
  buttonText: { color: "#4F46E5", fontWeight: "600" },
});
