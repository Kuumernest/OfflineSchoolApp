// src/components/NeedsInternetNote.js
"use strict";

/**
 * The line shown beside an online-only action while the phone is offline:
 * "This needs an internet connection." Renders nothing when online, so a
 * screen can place it unconditionally next to the button it disables.
 */

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "../i18n/useTranslation";
import { useIsOnline, NEEDS_INTERNET_KEY } from "../hooks/useNeedsInternet";

export const NeedsInternetNote = ({ style, online, textKey = NEEDS_INTERNET_KEY }) => {
  const { t } = useTranslation();
  const live = useIsOnline();
  const isOnline = online ?? live;
  if (isOnline) return null;
  return (
    <View style={[styles.note, style]} accessibilityRole="text">
      <Ionicons name="cloud-offline-outline" size={15} color="#92400E" />
      <Text style={styles.text}>{t(textKey)}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginVertical: 8,
  },
  text: { flex: 1, color: "#92400E", fontSize: 13, fontWeight: "600" },
});

export default NeedsInternetNote;
