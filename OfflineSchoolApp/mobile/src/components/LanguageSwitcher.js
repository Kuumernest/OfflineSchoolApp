// mobile/src/components/LanguageSwitcher.js
"use strict";

/**
 * Language choice, for the phone app.
 *
 * The app shipped fully bilingual and with no way to change language. 5,091
 * keys in each of en.json and fr.json, a working i18n instance, setLanguage()
 * exported and persisted to storage — and no screen anywhere called it. The
 * language came from the device locale and nothing else, so a francophone
 * teacher handed a phone set to English had an English app and no recourse
 * inside it. The web console has had a switcher in its top bar all along.
 *
 * ── A segmented pair, not a dropdown ──────────────────────────────────────
 *
 * With exactly two languages a picker costs a tap just to discover what the
 * options are, and the person who needs this control most is the one who
 * cannot read the interface they are looking at. Both languages are on screen,
 * each written in itself — "English" and "Français", never "French" — because
 * a label somebody cannot read is not a label. That is also why they are not
 * translated: SUPPORTED_LANGUAGES carries them verbatim.
 *
 * ── Why it does not need a spinner ────────────────────────────────────────
 *
 * setLanguage applies the change synchronously and only then writes to
 * AsyncStorage, so the interface has already changed by the time the promise
 * settles. A failed write costs the choice on the next launch, not this one,
 * which is why nothing here awaits it or reports an error: there is nothing
 * useful to say and the switch visibly worked.
 */

import React, { useCallback } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { SUPPORTED_LANGUAGES } from "../i18n";
import { useTranslation }      from "../i18n/useTranslation";

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  white:     "#FFFFFF",
  gray200:   "#E5E7EB",
  gray500:   "#6B7280",
  gray700:   "#374151",
};

export default function LanguageSwitcher({ style }) {
  const { t, language, setLanguage } = useTranslation();

  const choose = useCallback(
    (code) => {
      if (code === language) return;
      // Not awaited: the locale is already applied and the storage write is
      // best-effort. See the note above.
      void setLanguage(code);
    },
    [language, setLanguage]
  );

  return (
    <View style={[s.wrap, style]}>
      <View style={s.labelRow}>
        <Ionicons name="language-outline" size={15} color={C.gray500} />
        <Text style={s.label}>{t("common.language")}</Text>
      </View>

      <View style={s.group} accessibilityRole="radiogroup">
        {SUPPORTED_LANGUAGES.map((lang) => {
          const active = language === lang.code;
          return (
            <Pressable
              key={lang.code}
              onPress={() => choose(lang.code)}
              style={({ pressed }) => [
                s.option,
                active && s.optionOn,
                pressed && !active && s.optionPressed,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, checked: active }}
              // The language name, not "English button" — a screen reader in
              // either language reads the name correctly because it is written
              // in its own language.
              accessibilityLabel={lang.label}
              // 44pt is the smallest reliably tappable target; these rows are
              // used by people holding a phone in one hand in a corridor.
              hitSlop={8}
            >
              {active && (
                <Ionicons name="checkmark" size={14} color={C.white} />
              )}
              <Text
                style={[s.optionText, active && s.optionTextOn]}
                numberOfLines={1}
              >
                {lang.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:     { gap: 8, paddingVertical: 4 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: {
    fontSize: 11, fontWeight: "700", color: C.gray500,
    letterSpacing: 0.6, textTransform: "uppercase",
  },
  group:  { flexDirection: "row", gap: 8 },
  option: {
    flex: 1, minHeight: 44,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: C.gray200, backgroundColor: C.white,
  },
  optionOn:      { backgroundColor: C.primary, borderColor: C.primary },
  optionPressed: { backgroundColor: C.primaryBg },
  optionText:    { fontSize: 13, fontWeight: "600", color: C.gray700 },
  optionTextOn:  { color: C.white },
});
