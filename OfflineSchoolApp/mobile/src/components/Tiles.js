// src/components/Tiles.js
//
// The app's tiles, in one place. A tile takes a `kind` ("students", "fees"…)
// and wears that kind's colour from src/theme/colors.js — screens never pass
// a hex, which is what keeps the same thing the same colour everywhere.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TILE, TILE_SHAPE, PALETTE } from "../theme/colors";

const tone = (kind) => TILE[kind] ?? TILE.students;

/**
 * A number and what it counts. `alert` marks a count that needs someone —
 * a cream dot in the corner, so the tile keeps its kind's colour.
 */
export function StatTile({ kind, icon, value, label, onPress, alert = false, style }) {
  const { bg, fg } = tone(kind);
  const Box = onPress ? TouchableOpacity : View;
  return (
    <Box
      style={[styles.stat, { backgroundColor: bg }, style]}
      {...(onPress ? { onPress, activeOpacity: 0.8, accessibilityRole: "button" } : {})}
    >
      {alert ? <View style={styles.alertDot} /> : null}
      {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.statValue, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: fg }]} numberOfLines={2}>{label}</Text>
    </Box>
  );
}

/** A shortcut: an icon and a short label on the kind's colour, and a count if any. */
export function ActionTile({ kind, icon, label, onPress, badge = 0, style }) {
  const { bg, fg } = tone(kind);
  return (
    <TouchableOpacity
      style={[styles.action, { backgroundColor: bg }, style]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
    >
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : null}
      <Ionicons name={icon} size={24} color={fg} />
      <Text style={[styles.actionLabel, { color: fg }]} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

/** The solid colour chip at the head of a list row. */
export function TileIcon({ kind, icon, size = 40 }) {
  const { bg, fg } = tone(kind);
  return (
    <View style={[styles.chip, { width: size, height: size, backgroundColor: bg }]}>
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={fg} />
    </View>
  );
}

const styles = StyleSheet.create({
  stat: {
    ...TILE_SHAPE,
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 6,
  },
  statValue: { fontSize: 24, fontWeight: "800", marginTop: 6, letterSpacing: -0.3 },
  statLabel: { fontSize: 11, fontWeight: "600", marginTop: 2, textAlign: "center" },
  alertDot: {
    position: "absolute", top: 8, right: 8, width: 10, height: 10, borderRadius: 5,
    backgroundColor: PALETTE.cream, borderWidth: 2, borderColor: PALETTE.inkWarm,
  },
  action: {
    ...TILE_SHAPE,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 92,
  },
  actionLabel: { fontSize: 12, fontWeight: "700", textAlign: "center" },
  badge: {
    position: "absolute", top: 6, right: 6, minWidth: 20, height: 20, borderRadius: 10,
    paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: PALETTE.cream,
  },
  badgeText: { fontSize: 11, fontWeight: "800", color: PALETTE.inkWarm },
  chip: { borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
