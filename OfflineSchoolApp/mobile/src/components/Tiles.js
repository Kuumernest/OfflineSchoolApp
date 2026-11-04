// src/components/Tiles.js
//
// The app's cards, in one place. A card is white; colour lives only on its
// icon box, picked by `kind` ("students", "fees"…) from src/theme/colors.js.
// A card that means something takes a `tone` (warning, error, info, success)
// and becomes a light tint of it — never a solid fill.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, TILE, SEMANTIC, TILE_SHAPE } from "../theme/colors";

/** The colours a card wears: its kind's accent, or its tone's tint. */
const look = (kind, tone) => {
  const sem = tone ? SEMANTIC[tone] : null;
  if (sem) return { bg: sem.bg, box: sem.box, icon: sem.icon, value: sem.text, label: sem.text };
  const accent = TILE[kind] ?? TILE.students;
  return { bg: COLORS.surface, box: accent.box, icon: accent.icon, value: COLORS.text, label: COLORS.textSecondary };
};

/** A number and what it counts. */
export function StatTile({ kind, tone, icon, value, label, onPress, style }) {
  const c = look(kind, tone);
  const Box = onPress ? TouchableOpacity : View;
  return (
    <Box
      style={[styles.stat, { backgroundColor: c.bg }, tone && { borderColor: c.box }, style]}
      {...(onPress ? { onPress, activeOpacity: 0.8, accessibilityRole: "button" } : {})}
    >
      {icon ? (
        <View style={[styles.box, { backgroundColor: c.box }]}>
          <Ionicons name={icon} size={18} color={c.icon} />
        </View>
      ) : null}
      <Text style={[styles.statValue, { color: c.value }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: c.label }]} numberOfLines={2}>{label}</Text>
    </Box>
  );
}

/**
 * A shortcut. Every one is white with a blue icon box, except the single
 * `primary` action a screen leads with, which is solid blue.
 */
export function ActionTile({ icon, label, onPress, badge = 0, primary = false, style }) {
  return (
    <TouchableOpacity
      style={[styles.action, primary && styles.actionPrimary, style]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
    >
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : null}
      <View style={[styles.box, primary ? styles.boxOnPrimary : { backgroundColor: COLORS.primaryLight }]}>
        <Ionicons name={icon} size={20} color={primary ? COLORS.onPrimary : COLORS.primary} />
      </View>
      <Text style={[styles.actionLabel, primary && { color: COLORS.onPrimary }]} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

/** The accent icon box at the head of a list row. */
export function TileIcon({ kind, icon, size = 40 }) {
  const accent = TILE[kind] ?? TILE.students;
  return (
    <View style={[styles.chip, { width: size, height: size, backgroundColor: accent.box }]}>
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={accent.icon} />
    </View>
  );
}

const styles = StyleSheet.create({
  stat: {
    ...TILE_SHAPE,
    flex: 1,
    paddingHorizontal: 10,
  },
  box: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  boxOnPrimary: { backgroundColor: COLORS.onPrimaryBox },
  statValue: { fontSize: 22, fontWeight: "700", marginTop: 10, letterSpacing: -0.3 },
  statLabel: { fontSize: 11, fontWeight: "500", marginTop: 2 },
  action: {
    ...TILE_SHAPE,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 92,
  },
  actionPrimary: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  actionLabel: { fontSize: 12, fontWeight: "600", textAlign: "center", color: COLORS.text },
  badge: {
    position: "absolute", top: 6, right: 6, minWidth: 20, height: 20, borderRadius: 10,
    paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.danger,
  },
  badgeText: { fontSize: 11, fontWeight: "700", color: COLORS.onPrimary },
  chip: { borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
