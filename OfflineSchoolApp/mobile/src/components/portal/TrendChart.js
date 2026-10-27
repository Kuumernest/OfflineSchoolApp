// src/components/portal/TrendChart.js
//
// A child's average /20 across published results, oldest to newest: the
// phone's copy of web/src/pages/portal/TrendChart.tsx. One series, so no
// legend; the card's title names it. Drawn with Views (the app has no SVG
// library): a recessive /20 grid, a 2 px line, markers with a surface ring,
// the latest value labelled directly, and the same figures as a table behind
// a toggle, which is also what a screen reader is pointed at.

import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { C, TAP, on20 } from "./theme";

const H = 168;
const PAD = { top: 12, right: 48, bottom: 26, left: 26 };
const GRID = [0, 5, 10, 15, 20];
const OUT_OF = "/20";

export default function TrendChart({ points }) {
  const { t } = useTranslation();
  const [W, setW] = useState(0);
  const [table, setTable] = useState(false);
  if ((points?.length ?? 0) < 2) return null;

  const x = (i) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1);
  const y = (v) => PAD.top + ((20 - v) / 20) * (H - PAD.top - PAD.bottom);
  const last = points[points.length - 1];
  // What a screen reader says for the drawing: the title, then every point.
  const spoken = [t("portal.resultsScreen.trendLabel"), ...points.map((p) => [p.label, on20(p.value), OUT_OF].join(" "))].join(", ");

  return (
    <View>
      <View
        onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}
        style={{ height: H }}
        accessible
        accessibilityRole="image"
        accessibilityLabel={spoken}
      >
        {W > 0 && (
          <>
            {GRID.map((g) => (
              <View key={g} style={[s.gridLine, { top: y(g), left: PAD.left, right: PAD.right }]}>
                <Text style={[s.gridLabel, { left: -PAD.left, width: PAD.left - 6 }]}>{g}</Text>
              </View>
            ))}

            {/* The line: one rotated bar per pair of neighbours. */}
            {points.slice(1).map((p, i) => {
              const x1 = x(i), y1 = y(points[i].value), x2 = x(i + 1), y2 = y(p.value);
              const len = Math.hypot(x2 - x1, y2 - y1);
              const angle = Math.atan2(y2 - y1, x2 - x1);
              return (
                <View
                  key={`seg-${p.key}`}
                  style={[s.segment, {
                    width: len, left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1,
                    transform: [{ rotate: `${angle}rad` }],
                  }]}
                />
              );
            })}

            {points.map((p, i) => (
              <View key={p.key} style={[s.dot, { left: x(i) - 6, top: y(p.value) - 6 }]} />
            ))}

            <Text style={[s.lastValue, { left: x(points.length - 1) + 10, top: y(last.value) - 9 }]}>
              {on20(last.value)}
            </Text>

            {/* First and last exam named under the axis; the table has the rest. */}
            <Text style={[s.axisLabel, { left: PAD.left - 4, top: H - 18 }]} numberOfLines={1}>{points[0].label}</Text>
            <Text style={[s.axisLabel, s.axisRight, { right: PAD.right - 4, top: H - 18 }]} numberOfLines={1}>{last.label}</Text>
          </>
        )}
      </View>

      <Pressable
        onPress={() => setTable((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: table }}
        style={s.toggle}
      >
        <Ionicons name={table ? "chevron-up" : "chevron-down"} size={16} color={C.primary} />
        <Text style={s.toggleText}>{t("portal.resultsScreen.showTable")}</Text>
      </Pressable>

      {table && (
        <View>
          <View style={s.row}>
            <Text style={[s.th, { flex: 1 }]}>{t("portal.resultsScreen.exam")}</Text>
            <Text style={s.th}>{t("portal.resultsScreen.average")}</Text>
          </View>
          {points.map((p) => (
            <View key={p.key} style={s.row}>
              <Text style={[s.td, { flex: 1 }]}>{p.label}</Text>
              <Text style={[s.td, s.num]}>{on20(p.value)}{OUT_OF}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  gridLine:  { position: "absolute", height: 1, backgroundColor: C.line },
  gridLabel: { position: "absolute", top: -7, fontSize: 11, color: C.inkFaint, textAlign: "right" },
  segment:   { position: "absolute", height: 2, borderRadius: 1, backgroundColor: C.primary },
  dot: {
    position: "absolute", width: 12, height: 12, borderRadius: 6,
    backgroundColor: C.primary, borderWidth: 2, borderColor: C.surface,
  },
  lastValue: { position: "absolute", fontSize: 12, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  axisLabel: { position: "absolute", maxWidth: "45%", fontSize: 11, color: C.inkMuted },
  axisRight: { textAlign: "right" },

  toggle:     { flexDirection: "row", alignItems: "center", gap: 6, minHeight: TAP, alignSelf: "flex-start" },
  toggleText: { fontSize: 14, fontWeight: "600", color: C.primary },
  row: { flexDirection: "row", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line },
  th:  { fontSize: 12, fontWeight: "600", color: C.inkMuted },
  td:  { fontSize: 13, color: C.inkBody },
  num: { fontVariant: ["tabular-nums"], color: C.ink },
});
