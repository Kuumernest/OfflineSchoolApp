// app/admin/documents/index.js
//
// The printing desk on a phone.
//
// Same sheets as the web console — they are built by the server, so a register
// run off a phone and one run off a laptop are the same document. What differs
// is the ending: on a phone the usual outcome is a PDF in a share sheet rather
// than a printer, because the printer is in the office and the teacher is not.
//
// Documents are cached per sheet, so a register fetched in the staffroom still
// opens in the corridor.

import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import DocumentService    from "../../../src/services/document.service";
import { ClassService }   from "../../../src/services/class.service";
import { StudentService } from "../../../src/services/student.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useAuthStore }   from "../../../src/store/auth.store";

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
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

const VARIANTS = ["plain", "register", "contacts"];

export default function DocumentsScreen() {
  const router      = useRouter();
  const { t, language } = useTranslation();
  const schoolId    = useAuthStore((s) => s.user?.schoolId ?? "");

  const [tab, setTab]         = useState("classList");
  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);

  const [classId, setClassId]     = useState("");
  const [variant, setVariant]     = useState("plain");
  const [studentId, setStudentId] = useState("");
  const [query, setQuery]         = useState("");

  useEffect(() => {
    (async () => {
      try {
        // Local reads, so the picker fills in with no signal.
        const [cls, stu] = await Promise.all([
          ClassService.getAll(),
          StudentService.getApprovedStudentsLocal(),
        ]);
        setClasses(Array.isArray(cls) ? cls : (cls?.classes ?? []));
        setStudents(Array.isArray(stu) ? stu : (stu?.students ?? []));
      } catch {
        // An empty picker is handled below; a crash is not.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filteredStudents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      `${s.name ?? ""} ${s.enrollmentNo ?? ""}`.toLowerCase().includes(q)
    );
  }, [students, query]);

  const ready = tab === "classList" ? Boolean(classId) : Boolean(studentId);

  const load = useCallback(async () => {
    return tab === "classList"
      ? DocumentService.getClassListHtml({ schoolId, classId, variant, lang: language })
      : DocumentService.getTranscriptHtml({ schoolId, studentId, lang: language });
  }, [tab, schoolId, classId, variant, studentId, language]);

  const run = async (mode) => {
    setBusy(true);
    try {
      const { html, stale } = await load();

      if (mode === "print") await DocumentService.printDocument(html);
      else {
        const name = tab === "classList"
          ? (classes.find((c) => c._id === classId)?.name ?? "class-list")
          : (students.find((s) => s._id === studentId)?.name ?? "transcript");
        await DocumentService.shareDocument(html, name);
      }

      // Said after the fact, not instead of the document: an out-of-date sheet
      // is still better than no sheet, but the teacher should know which it is.
      if (stale) Alert.alert(t("doc.title"), t("doc.offline"));
    } catch (err) {
      Alert.alert(t("doc.print"), err?.message ?? String(err));
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

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={C.inkBody} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("doc.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{t("doc.blurb")}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Which document */}
        <View style={styles.chips}>
          {[["classList", t("cl.title")], ["transcript", t("tr.title")]].map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.chip, tab === key && styles.chipOn]}
              onPress={() => setTab(key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.chipText, tab === key && styles.chipTextOn]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === "classList" ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("cl.pick")}</Text>
              {classes.length === 0 ? (
                <Text style={styles.empty}>{t("classes.none")}</Text>
              ) : (
                <View style={styles.chips}>
                  {classes.map((c) => (
                    <TouchableOpacity
                      key={c._id}
                      style={[styles.chip, classId === c._id && styles.chipOn]}
                      onPress={() => setClassId(c._id)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.chipText, classId === c._id && styles.chipTextOn]}>
                        {c.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("cl.variant")}</Text>
              {VARIANTS.map((v) => (
                <TouchableOpacity
                  key={v}
                  style={[styles.option, variant === v && styles.optionOn]}
                  onPress={() => setVariant(v)}
                  activeOpacity={0.8}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionTitle}>{t(`cl.${v}`)}</Text>
                    <Text style={styles.optionHint}>{t(`cl.${v}Hint`)}</Text>
                  </View>
                  {variant === v && (
                    <Ionicons name="checkmark-circle" size={18} color={C.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t("tr.pick")}</Text>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder={t("tr.searchStudent")}
              placeholderTextColor={C.inkFaint}
            />
            {filteredStudents.length === 0 ? (
              <Text style={styles.empty}>{t("tr.noStudents")}</Text>
            ) : (
              filteredStudents.slice(0, 60).map((s) => (
                <TouchableOpacity
                  key={s._id}
                  style={[styles.option, studentId === s._id && styles.optionOn]}
                  onPress={() => setStudentId(s._id)}
                  activeOpacity={0.8}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.optionTitle} numberOfLines={1}>
                      {s.name || s.enrollmentNo || s._id}
                    </Text>
                    <Text style={styles.optionHint}>{s.enrollmentNo || "—"}</Text>
                  </View>
                  {studentId === s._id && (
                    <Ionicons name="checkmark-circle" size={18} color={C.primary} />
                  )}
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.action, styles.actionGhost, (!ready || busy) && styles.actionOff]}
            onPress={() => run("share")}
            disabled={!ready || busy}
            activeOpacity={0.85}
          >
            <Ionicons name="share-outline" size={16} color={C.primary} />
            <Text style={styles.actionGhostText}>{t("doc.share")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.action, styles.actionSolid, (!ready || busy) && styles.actionOff]}
            onPress={() => run("print")}
            disabled={!ready || busy}
            activeOpacity={0.85}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : (
                <>
                  <Ionicons name="print-outline" size={16} color="#fff" />
                  <Text style={styles.actionSolidText}>{t("doc.print")}</Text>
                </>
              )}
          </TouchableOpacity>
        </View>
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

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink, marginBottom: 10 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
  },
  chipOn:     { backgroundColor: C.primary, borderColor: C.primary },
  chipText:   { fontSize: 12, color: C.inkBody, fontWeight: "500" },
  chipTextOn: { color: "#fff" },

  option: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, paddingHorizontal: 10, borderRadius: 9,
    borderWidth: 1, borderColor: C.line, marginTop: 6,
  },
  optionOn:    { borderColor: C.primary, backgroundColor: C.primaryBg },
  optionTitle: { fontSize: 13, fontWeight: "600", color: C.ink },
  optionHint:  { marginTop: 1, fontSize: 11, color: C.inkMuted },

  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: "#D5D9E2",
    paddingHorizontal: 12, fontSize: 15, color: C.ink,
    backgroundColor: C.surface, marginBottom: 6,
  },

  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  action: {
    flex: 1, height: 46, borderRadius: 10, flexDirection: "row",
    alignItems: "center", justifyContent: "center", gap: 8,
  },
  actionGhost:     { borderWidth: 1, borderColor: C.primary, backgroundColor: C.surface },
  actionGhostText: { color: C.primary, fontSize: 15, fontWeight: "600" },
  actionSolid:     { backgroundColor: C.primary },
  actionSolidText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  actionOff:       { opacity: 0.45 },

  empty: { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },
});
