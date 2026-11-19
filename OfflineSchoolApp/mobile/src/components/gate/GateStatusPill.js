// src/components/gate/GateStatusPill.js
//
// A pupil's fee status at the gate, as a badge. Never colour alone: each of
// the four statuses has its own colour AND icon AND word, so an operator who
// cannot tell amber from green — or is reading in full sun — still reads it.
//
//   compliant      green   check           "Compliant"
//   due            amber   clock           "Due"
//   non_compliant  red     alert           "Non-compliant"
//   authorized     indigo  shield          "Authorized"
//
// `size="lg"` is the card's badge; the default is the history row's pill.

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SEMANTIC, ACCENT } from "../../theme/colors";
import { useTranslation } from "../../i18n/useTranslation";
import { lookOf } from "./gateRules";

/** The colours for a look's tone. Authorized takes indigo — not a SEMANTIC tone. */
export const statusColours = (status) => {
  const look = lookOf(status);
  if (!look) return null;
  if (look.tone === "indigo") {
    return { bg: ACCENT.indigo.wash, border: "#C7D2FE", fg: ACCENT.indigo.deep, icon: ACCENT.indigo.base, edge: ACCENT.indigo.base };
  }
  const s = SEMANTIC[look.tone];
  return { bg: s.bg, border: s.box, fg: s.text, icon: s.icon, edge: s.icon };
};

export default function GateStatusPill({ status, size = "sm", short = false, style }) {
  const { t } = useTranslation();
  const look = lookOf(status);
  const c = statusColours(status);
  if (!look || !c) return null;
  const big = size === "lg";
  const label = short ? t(`gate.statusShort.${status}`) : t(look.key);
  return (
    <View
      style={[styles.pill, big && styles.pillLg, { backgroundColor: c.bg, borderColor: c.border }, style]}
      accessibilityRole="text"
      accessibilityLabel={t(look.key)}
    >
      <Ionicons name={look.icon} size={big ? 22 : 12} color={c.icon} />
      <Text style={[styles.text, big && styles.textLg, { color: c.fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, borderWidth: 1,
  },
  pillLg: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, gap: 8, alignSelf: "stretch", justifyContent: "center", borderWidth: 2 },
  text:   { fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  textLg: { fontSize: 18, letterSpacing: 0.6 },
});
