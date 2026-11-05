// app/admin/exports/index.js
//
// Spreadsheet exports on a phone.
//
// Same workbooks as the web console — the server builds them, so a file sent
// from here is the file a bursar would have downloaded at a desk. The ending
// differs: a phone hands the file to a share sheet, because it is far more
// likely to have WhatsApp than a spreadsheet program.
//
// The tile list comes from the server, so a teacher sees the roster and no
// Payroll tile at all rather than one that fails when tapped.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import ExportService      from "../../../src/services/export.service";
import { ClassService }   from "../../../src/services/class.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useAuthStore }   from "../../../src/store/auth.store";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC, categoryAccent, levelAccent } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const C = {
  primary:   ACCENT.slate.solid,
  primaryBg: ACCENT.slate.wash,
  success:   SEMANTIC.success.text,
  warning:   SEMANTIC.warning.text,
  warningBg: SEMANTIC.warning.bg,
  ink:       COLORS.text,
  inkBody:   COLORS.text,
  inkMuted:  COLORS.textSecondary,
  inkFaint:  COLORS.textSubtle,
  line:      COLORS.border,
  surface:   COLORS.surface,
  canvas:    COLORS.page,
};

/** Which filters each export understands — mirrors the web page. */
const FILTERS = {
  students:    ["classId"],
  arrears:     ["academicYear"],
  payments:    ["academicYear"],
  expenses:    [],
  payroll:     ["periodMonth"],
  enrollments: ["academicYear"],
};

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

export default function ExportsScreen() {
  const router          = useRouter();
  const { t, language } = useTranslation();
  const schoolId        = useAuthStore((s) => s.user?.schoolId ?? "");

  const [kinds, setKinds]     = useState([]);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed]   = useState(false);
  const [busy, setBusy]       = useState(false);

  const [selected, setSelected] = useState(null);
  const [params, setParams]     = useState({});

  useEffect(() => {
    (async () => {
      try {
        const [list, cls] = await Promise.all([
          ExportService.listExports(),
          ClassService.getAll().catch(() => []),
        ]);
        setKinds(list);
        setClasses(Array.isArray(cls) ? cls : (cls?.classes ?? []));
      } catch {
        // Exports need a connection; say so instead of showing an empty page
        // that looks like the feature is missing.
        setFailed(true);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const pick = useCallback((kind) => {
    setSelected(kind);
    // Cleared on switch: a year left over from Arrears would silently narrow
    // an Expenses export.
    setParams(
      (FILTERS[kind] ?? []).includes("academicYear")
        ? { academicYear: currentAcademicYear() }
        : {}
    );
  }, []);

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { fileName, shared } = await ExportService.shareExport({
        schoolId, kind: selected, lang: language ?? "en", params,
      });
      if (!shared) Alert.alert(t("exp.title"), fileName);
    } catch (err) {
      Alert.alert(t("exp.failed"), errorText(t, err) || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  const active = selected ? (FILTERS[selected] ?? []) : [];

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("exp.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={2}>{t("exp.blurb")}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {failed && (
          <View style={styles.banner}>
            <Ionicons name="cloud-offline-outline" size={15} color={C.warning} />
            <Text style={styles.bannerText}>{t("exp.onlineOnly")}</Text>
          </View>
        )}

        {kinds.map((kind) => {
          const accent = categoryAccent(kind);
          const a = ACCENT[accent];
          return (
            <TouchableOpacity
              key={kind}
              style={[
                styles.option,
                { backgroundColor: a.wash, borderLeftColor: a.base },
                selected === kind && { borderColor: a.base, borderWidth: 2, borderLeftWidth: 3 },
              ]}
              onPress={() => pick(kind)}
              activeOpacity={0.85}
            >
              <IconSquare icon="document-text" accent={accent} size={32} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.optionTitle}>{t(`exp.${kind}`)}</Text>
                <Text style={styles.optionHint}>{t(`exp.${kind}Hint`)}</Text>
              </View>
              {selected === kind && (
                <Ionicons name="checkmark-circle" size={18} color={a.solid} />
              )}
            </TouchableOpacity>
          );
        })}

        {active.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <IconSquare icon="funnel" accent="slate" size={28} />
              <Text style={[styles.cardTitle, styles.cardTitleInHead]}>{t("exp.filters")}</Text>
            </View>

            {active.includes("classId") && (
              <>
                <Text style={styles.label}>{t("academic.class")}</Text>
                <View style={styles.chips}>
                  <TouchableOpacity
                    style={[styles.chip, !params.classId && styles.chipOn]}
                    onPress={() => setParams((p) => ({ ...p, classId: undefined }))}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.chipText, !params.classId && styles.chipTextOn]}>
                      {t("exp.allClasses")}
                    </Text>
                  </TouchableOpacity>
                  {classes.map((c) => {
                    const ca = ACCENT[levelAccent(c.level)];
                    const on = params.classId === c._id;
                    return (
                      <TouchableOpacity
                        key={c._id}
                        style={[styles.chip, on && { backgroundColor: ca.wash, borderColor: ca.base }]}
                        onPress={() => setParams((p) => ({ ...p, classId: c._id }))}
                        activeOpacity={0.8}
                      >
                        <Text style={[
                          styles.chipText, on && { color: ca.deep, fontWeight: "700" },
                        ]}>
                          {c.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}

            {active.includes("academicYear") && (
              <>
                <Text style={styles.label}>{t("fees.academicYear")}</Text>
                <TextInput
                  style={styles.input}
                  value={params.academicYear ?? ""}
                  onChangeText={(v) =>
                    setParams((p) => ({ ...p, academicYear: v || undefined }))
                  }
                  placeholder={t("exp.allYears")}
                  placeholderTextColor={C.inkFaint}
                />
              </>
            )}

            {active.includes("periodMonth") && (
              <>
                <Text style={styles.label}>{t("payroll.month")}</Text>
                <TextInput
                  style={styles.input}
                  value={params.periodMonth ?? ""}
                  onChangeText={(v) =>
                    setParams((p) => ({ ...p, periodMonth: v || undefined }))
                  }
                  placeholder="2026-08"
                  placeholderTextColor={C.inkFaint}
                />
              </>
            )}
          </View>
        )}

        <TouchableOpacity
          style={[styles.submit, (!selected || busy) && styles.submitOff]}
          onPress={run}
          disabled={!selected || busy}
          activeOpacity={0.85}
        >
          {busy
            ? <ActivityIndicator color={COLORS.onPrimary} />
            : (
              <>
                <Ionicons name="share-outline" size={16} color={COLORS.onPrimary} />
                <Text style={styles.submitText}>{t("exp.share")}</Text>
              </>
            )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },
  headerIcon: { marginRight: 0 },

  body: { padding: 16, gap: 10, paddingBottom: 40 },

  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: SEMANTIC.warning.box,
  },
  bannerText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  option: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 14, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
    borderLeftWidth: 3,
  },
  optionTitle: { fontSize: 14, fontWeight: "700", color: C.ink },
  optionHint:  { marginTop: 2, fontSize: 11, color: C.inkMuted },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 6 },
  cardHead:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardTitleInHead: { marginBottom: 0, flex: 1 },

  label: { fontSize: 12, fontWeight: "600", color: C.inkBody, marginBottom: 5, marginTop: 8 },
  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: 12, fontSize: 15, color: C.ink, backgroundColor: C.surface,
  },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: C.surface,
  },
  chipOn:     { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base },
  chipText:   { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  chipTextOn: { color: ACCENT.slate.deep, fontWeight: "700" },

  submit: {
    marginTop: 6, height: 48, borderRadius: 10, backgroundColor: C.primary,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  submitOff:  { opacity: 0.45 },
  submitText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "600" },
});
