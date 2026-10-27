// src/components/portal/BottomTabs.js
//
// The portal's five sections along the bottom, where a thumb reaches. It
// replaces six tabs in a sideways scroll across the top, where "From the
// school" was always half off-screen at 360 px.
//
// Each label is one line and shrinks before it wraps. The Messages badge
// carries unread conversations and unread notices together: both live behind
// that one tab now.

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n/useTranslation";
import { C, TAP } from "./theme";

export const PORTAL_SCREENS = [
  { key: "home",       icon: "home-outline",           iconOn: "home" },
  { key: "results",    icon: "school-outline",         iconOn: "school" },
  { key: "attendance", icon: "calendar-outline",       iconOn: "calendar" },
  { key: "fees",       icon: "wallet-outline",         iconOn: "wallet" },
  { key: "messages",   icon: "chatbubbles-outline",    iconOn: "chatbubbles" },
];

export default function BottomTabs({ screen, onChange, badges = {} }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[s.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}
      accessibilityRole="tablist"
      accessibilityLabel={t("portal.nav.main")}
    >
      {PORTAL_SCREENS.map(({ key, icon, iconOn }) => {
        const on    = screen === key;
        const count = badges[key] ?? 0;
        const label = t(`portal.nav.${key}`);
        return (
          <Pressable
            key={key}
            testID={`portal-nav-${key}`}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={count > 0 ? `${label} (${t("portal.unreadCount", { count })})` : label}
            style={s.item}
          >
            <View>
              <Ionicons name={on ? iconOn : icon} size={23} color={on ? C.primary : C.inkMuted} />
              {count > 0 ? (
                <View style={s.badge}>
                  <Text style={s.badgeText}>{count > 9 ? "9+" : count}</Text>
                </View>
              ) : null}
            </View>
            <Text
              style={[s.label, on && s.labelOn]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row", backgroundColor: C.surface,
    borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6,
  },
  item: {
    flex: 1, minHeight: TAP + 8, alignItems: "center", justifyContent: "center",
    gap: 3, paddingHorizontal: 2,
  },
  label:   { fontSize: 11, fontWeight: "600", color: C.inkMuted },
  labelOn: { color: C.primary },
  badge: {
    position: "absolute", top: -4, right: -10, minWidth: 18, height: 18,
    borderRadius: 9, paddingHorizontal: 4, backgroundColor: C.danger,
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: C.surface,
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: "#FFFFFF" },
});
