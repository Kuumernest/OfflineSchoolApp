// src/components/portal/ui.js
//
// The parent portal's small parts, the phone's copy of web/src/pages/portal/
// ui.tsx: a card, a loading placeholder, a kind empty state, a child's avatar
// and the EN | FR toggle. Every control here is at least 44 px tall.

import React, { useEffect, useRef } from "react";
import { View, Text, Pressable, Animated, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { SUPPORTED_LANGUAGES } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { C, TAP } from "./theme";

/** A screen reader's label from its parts, in order, skipping the empty ones. */
export const said = (...parts) => parts.filter((x) => x != null && x !== "").join(", ");

/** The portal's card. */
export function Card({ style, children, ...rest }) {
  return <View style={[s.card, style]} {...rest}>{children}</View>;
}

/** A card's heading row: a line icon and a title. */
export function CardTitle({ icon, children, style }) {
  return (
    <View style={[s.cardTitleRow, style]}>
      {icon ? <Ionicons name={icon} size={16} color={C.primary} /> : null}
      <Text style={s.cardTitle} accessibilityRole="header">{children}</Text>
    </View>
  );
}

/** A grey block standing in for content while it loads: never a blank page. */
export function Skeleton({ width = "100%", height = 14, radius = 6, style }) {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1,    duration: 650, useNativeDriver: Platform.OS !== "web" }),
      Animated.timing(pulse, { toValue: 0.55, duration: 650, useNativeDriver: Platform.OS !== "web" }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: C.line, opacity: pulse }, style]}
    />
  );
}

/** Nothing to show yet, said kindly, with an icon rather than an empty box. */
export function EmptyState({ icon, title, hint }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Ionicons name={icon} size={24} color={C.primary} />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

const AVATAR_TONES = [
  { bg: "#E0E6FA", fg: "#2C3778" },
  { bg: C.successBg, fg: C.success },
  { bg: C.warningBg, fg: C.warning },
];

/** Initials in a circle; the same child keeps the same colour everywhere. */
export function ChildAvatar({ name, index = 0, size = 40 }) {
  const initials = (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]?.toUpperCase()).join("");
  const tone = AVATAR_TONES[index % AVATAR_TONES.length];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg,
        alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{ color: tone.fg, fontWeight: "700", fontSize: Math.round(size * 0.36) }}>
        {initials || "?"}
      </Text>
    </View>
  );
}

/** EN | FR: two 44 px targets, the current one filled. */
export function LanguageToggle() {
  const { t, language, setLanguage } = useTranslation();
  return (
    <View style={s.lang} accessibilityRole="radiogroup" accessibilityLabel={t("common.language")}>
      {SUPPORTED_LANGUAGES.map((lang) => {
        const on = language === lang.code;
        return (
          <Pressable
            key={lang.code}
            testID={`portal-lang-${lang.code}`}
            onPress={() => { if (!on) void setLanguage(lang.code); }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={lang.label}
            hitSlop={4}
            style={[s.langBtn, on && s.langBtnOn]}
          >
            <Text style={[s.langText, on && s.langTextOn]}>{lang.code.toUpperCase()}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface, borderRadius: 14,
    borderWidth: 1, borderColor: C.line, overflow: "hidden",
  },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle:    { fontSize: 14, fontWeight: "700", color: C.ink },

  empty:     { alignItems: "center", paddingHorizontal: 24, paddingVertical: 36 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: C.primaryBg,
    alignItems: "center", justifyContent: "center", marginBottom: 12,
  },
  emptyTitle: { fontSize: 14, fontWeight: "600", color: C.ink, textAlign: "center" },
  emptyHint:  { marginTop: 4, fontSize: 13, color: C.inkMuted, textAlign: "center", lineHeight: 19, maxWidth: 300 },

  lang: {
    flexDirection: "row", padding: 2, borderRadius: 10,
    borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface,
  },
  langBtn:    { minWidth: 40, height: TAP - 4, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  langBtnOn:  { backgroundColor: C.primary },
  langText:   { fontSize: 12, fontWeight: "700", color: C.inkMuted, letterSpacing: 0.5 },
  langTextOn: { color: "#FFFFFF" },
});
