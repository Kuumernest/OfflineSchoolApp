// app/admin/timetable/components/ConflictTypeBadge.js
"use strict";

import React from "react";
import { View, Text, StyleSheet } from "react-native";

import { useTranslation } from "../../../../src/i18n/useTranslation";

/**
 * The coloured label naming what kind of clash a timetable conflict is.
 * Shared by the conflicts screen and the slot editor's pre-save check.
 */
const BADGES = {
  TEACHER_DOUBLE_BOOKED: { key: "ttConflicts.typeTeacher", bg: "#FEE2E2", fg: "#991B1B" },
  CLASS_DOUBLE_BOOKED:   { key: "ttConflicts.typeClass",   bg: "#FEF3C7", fg: "#92400E" },
  ROOM_DOUBLE_BOOKED:    { key: "ttConflicts.typeRoom",    bg: "#DBEAFE", fg: "#1E40AF" },
  PERIOD_OVERLAP:        { key: "ttConflicts.typePeriod",  bg: "#EDE9FE", fg: "#5B21B6" },
};

export default function ConflictTypeBadge({ type }) {
  const { t } = useTranslation();
  const b = BADGES[type] ?? BADGES.TEACHER_DOUBLE_BOOKED;
  return (
    <View style={[styles.badge, { backgroundColor: b.bg }]}>
      <Text style={[styles.text, { color: b.fg }]}>{t(b.key)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf:         "flex-start",
    paddingVertical:   3,
    paddingHorizontal: 8,
    borderRadius:      6,
  },
  text: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
});
