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

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
  success:   "#12683A",
  warning:   "#96570B",
  warningBg: "#FDF6EC",
  ink:       "#0D1220",
  inkBody:   "#343D4F",
  inkMuted:  "#4F5A70",
  inkFaint:  "#666F84",
  line:      "#E9EBF0",
  surface:   "#FFFFFF",
  canvas:    "#F4F5F8",
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
      Alert.alert(t("exp.failed"), err?.message ?? String(err));
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

        {kinds.map((kind) => (
          <TouchableOpacity
            key={kind}
            style={[styles.option, selected === kind && styles.optionOn]}
            onPress={() => pick(kind)}
            activeOpacity={0.85}
          >
            <Ionicons
              name="document-text-outline"
              size={18}
              color={selected === kind ? C.primary : C.inkFaint}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.optionTitle}>{t(`exp.${kind}`)}</Text>
              <Text style={styles.optionHint}>{t(`exp.${kind}Hint`)}</Text>
            </View>
            {selected === kind && (
              <Ionicons name="checkmark-circle" size={18} color={C.primary} />
            )}
          </TouchableOpacity>
        ))}

        {active.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t("exp.filters")}</Text>

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
                  {classes.map((c) => (
                    <TouchableOpacity
                      key={c._id}
                      style={[styles.chip, params.classId === c._id && styles.chipOn]}
                      onPress={() => setParams((p) => ({ ...p, classId: c._id }))}
                      activeOpacity={0.8}
                    >
                      <Text style={[
                        styles.chipText, params.classId === c._id && styles.chipTextOn,
                      ]}>
                        {c.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
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
            ? <ActivityIndicator color="#fff" />
            : (
              <>
                <Ionicons name="share-outline" size={16} color="#fff" />
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

  body: { padding: 16, gap: 10, paddingBottom: 40 },

  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: "#F0DCBB",
  },
  bannerText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  option: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 14, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
  },
  optionOn:    { borderColor: C.primary, backgroundColor: C.primaryBg },
  optionTitle: { fontSize: 14, fontWeight: "700", color: C.ink },
  optionHint:  { marginTop: 2, fontSize: 11, color: C.inkMuted },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 6 },

  label: { fontSize: 12, fontWeight: "600", color: C.inkBody, marginBottom: 5, marginTop: 8 },
  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: "#D5D9E2",
    paddingHorizontal: 12, fontSize: 15, color: C.ink, backgroundColor: C.surface,
  },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
  },
  chipOn:     { backgroundColor: C.primary, borderColor: C.primary },
  chipText:   { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  chipTextOn: { color: "#fff" },

  submit: {
    marginTop: 6, height: 48, borderRadius: 10, backgroundColor: C.primary,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  submitOff:  { opacity: 0.45 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
