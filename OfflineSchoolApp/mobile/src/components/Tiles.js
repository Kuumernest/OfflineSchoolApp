// src/components/Tiles.js
//
// The app's cards, in one place, in the same look as the web console's
// dashboards: each tile takes its kind's colour ("students", "fees"… from
// src/theme/colors.js) as a light wash, a 3px top edge, a solid icon square
// with a white icon, and the figure in a deeper shade of the same hue. No
// tile is grey.
//
// A `tone` (warning, error, info, success) says the value means something: the
// tile keeps its kind's look, and its border and figure take the tone's colour.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, ACCENT, TILE, SEMANTIC, TONE_EDGE, TILE_SHAPE } from "../theme/colors";

/** The colours a tile wears: its kind's accent, its tone on the border and figure. */
export const tileLook = (kind, tone) => {
  const a   = TILE[kind] ?? TILE.students;
  const sem = tone ? SEMANTIC[tone] : null;
  return {
    bg:     a.wash,
    edge:   sem ? TONE_EDGE[tone] : a.base,
    border: sem ? TONE_EDGE[tone] : COLORS.border,
    box:    a.solid,
    icon:   COLORS.onPrimary,
    value:  sem ? sem.text : a.deep,
    label:  COLORS.textSecondary,
  };
};

/** The tile shell for a kind: the wash, the hairline and the 3px top edge. */
export const tileShell = (kind, tone) => {
  const c = tileLook(kind, tone);
  return { backgroundColor: c.bg, borderColor: c.border, borderTopWidth: 3, borderTopColor: c.edge };
};

/** A number and what it counts. */
export function StatTile({ kind, tone, icon, value, label, onPress, style }) {
  const c = tileLook(kind, tone);
  const Box = onPress ? TouchableOpacity : View;
  return (
    <Box
      style={[styles.stat, tileShell(kind, tone), style]}
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
 * A shortcut: a tinted tile in its kind's colour with a solid icon square.
 * The `primary` action a screen leads with is not filled: it takes the blue
 * tint with a blue border all round and a ringed icon, so no tile in the grid
 * is solid.
 */
export function ActionTile({ kind = "students", icon, label, onPress, badge = 0, primary = false, style }) {
  const c = primary ? tileLook("students") : tileLook(kind);
  return (
    <TouchableOpacity
      style={[styles.action, primary ? styles.actionPrimary : tileShell(kind), style]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
    >
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : null}
      <View style={primary ? styles.ring : null}>
        <View style={[styles.box, { backgroundColor: c.box }]}>
          <Ionicons name={icon} size={20} color={c.icon} />
        </View>
      </View>
      <Text style={styles.actionLabel} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

/** The icon square at the head of a list row: solid, in the kind's colour. */
export function TileIcon({ kind, icon, size = 40 }) {
  const a = TILE[kind] ?? TILE.students;
  return (
    <View style={[styles.chip, { width: size, height: size, backgroundColor: a.solid }]}>
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={COLORS.onPrimary} />
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
  statValue: { fontSize: 22, fontWeight: "700", marginTop: 10, letterSpacing: -0.3 },
  statLabel: { fontSize: 11, fontWeight: "500", marginTop: 2 },
  action: {
    ...TILE_SHAPE,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 92,
  },
  actionPrimary: {
    backgroundColor: ACCENT.blue.wash,
    borderColor: ACCENT.blue.solid,
    borderTopWidth: 3,
    borderTopColor: ACCENT.blue.solid,
  },
  // A 2px blue ring, 2px clear of the square, round the leading action's icon.
  ring: { padding: 2, borderRadius: 12, borderWidth: 2, borderColor: ACCENT.blue.base },
  actionLabel: { fontSize: 12, fontWeight: "600", textAlign: "center", color: COLORS.text },
  badge: {
    position: "absolute", top: 6, right: 6, minWidth: 20, height: 20, borderRadius: 10,
    paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.danger,
  },
  badgeText: { fontSize: 11, fontWeight: "700", color: COLORS.onPrimary },
  chip: { borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
