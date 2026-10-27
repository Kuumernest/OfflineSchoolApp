// src/components/portal/ChildSwitcher.js
//
// Whose results, attendance or fees are on screen: avatar, first name, class.
// Shown only when there is a choice to make; a parent with one child is never
// shown a control with one option in it. Home shows every child at once and
// Messages covers the whole family, so neither has it.

import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";

import { useTranslation } from "../../i18n/useTranslation";
import { ChildAvatar } from "./ui";
import { C, TAP } from "./theme";

export default function ChildSwitcher({ family, selected, onSelect }) {
  const { t } = useTranslation();
  if ((family?.length ?? 0) < 2) return null;

  return (
    <View style={s.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
        accessibilityRole="radiogroup"
        accessibilityLabel={t("portal.childSwitcher")}
      >
        {family.map((c, i) => {
          const on = String(selected) === String(c._id);
          return (
            <Pressable
              key={c._id}
              testID={`portal-child-${i}`}
              onPress={() => onSelect(c._id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={[c.name || c.enrollmentNo, c.className].filter(Boolean).join(", ")}
              style={[s.chip, on && s.chipOn]}
            >
              <ChildAvatar name={c.name} index={i} size={32} />
              <View style={{ minWidth: 0 }}>
                <Text style={[s.name, on && s.nameOn]} numberOfLines={1}>
                  {(c.name || c.enrollmentNo || "").split(" ")[0]}
                </Text>
                {c.className ? <Text style={s.cls} numberOfLines={1}>{c.className}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line },
  row:  { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    minHeight: TAP + 4, paddingLeft: 5, paddingRight: 14, borderRadius: 999,
    borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface,
  },
  chipOn: { borderColor: C.primary, backgroundColor: C.primaryBg },
  name:   { fontSize: 14, fontWeight: "600", color: C.ink },
  nameOn: { color: C.primary },
  cls:    { fontSize: 11, color: C.inkMuted, marginTop: 1 },
});
