// app/admin/fees/structures/new.js
//
// Define what the school charges.
//
// Written to the local mirror and queued, so a bursar can set next term's fees
// sitting in a classroom with no signal. The id is minted here and sent with
// the request, so a replay finds the row it already made instead of creating a
// second structure.
//
// Validation here is the minimum that catches a typing mistake — a year, a due
// date, at least one line, whole XAF. The real rules (overlapping structures,
// penalty shapes) live in shared/feeStructures.js on the server, which Metro
// cannot resolve from this package; a second copy of financial validation would
// drift from the copy that decides. A structure the server refuses appears in
// the pending-changes screen with its reason.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, StatusBar, Switch, Alert, KeyboardAvoidingView,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import FeeStructureService from "../../../../src/services/feeStructure.service";
import { ClassService }    from "../../../../src/services/class.service";
import { useAuthStore }    from "../../../../src/store/auth.store";
import { useTranslation }  from "../../../../src/i18n/useTranslation";
import { errorText }       from "../../../../src/utils/appError";

const BRAND = "#4F46E5";

const blankItem = () => ({ code: "", label: "", amount: "", isOptional: false });

export default function NewFeeStructureScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId) ?? "";

  const [academicYear, setYear]    = useState("");
  const [term,         setTerm]    = useState("");
  const [dueDate,      setDueDate] = useState("");
  const [items,        setItems]   = useState([blankItem()]);
  const [classIds,     setClassIds] = useState([]);
  const [classes,      setClasses]  = useState([]);
  const [saving,       setSaving]   = useState(false);

  useEffect(() => {
    let alive = true;
    // getAll(includeInactive) — it takes no schoolId, and passing one would
    // read as "include inactive" and offer classes the school has retired.
    ClassService.getAll()
      .then((rows) => { if (alive) setClasses(rows ?? []); })
      .catch(() => { /* the picker degrades to "whole school", which is valid */ });
    return () => { alive = false; };
  }, [schoolId]);

  const setItem = (i, patch) =>
    setItems((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const toggleClass = (id) =>
    setClassIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = useCallback(async () => {
    const draft = {
      academicYear: academicYear.trim(),
      term:         term.trim() || null,
      dueDate:      dueDate.trim(),
      classIds,
      items: items.map((i) => ({
        code:       i.code.trim(),
        label:      i.label.trim(),
        amount:     Number(i.amount),
        isOptional: Boolean(i.isOptional),
      })),
    };

    const problem = FeeStructureService.validate(draft);
    if (problem) {
      Alert.alert(t("common.error"), t(problem));
      return;
    }

    setSaving(true);
    try {
      await FeeStructureService.create(schoolId, draft);
      // "Saved", not "sent": it is on the device and in the outbox, and saying
      // more than that would be a claim about a request that may not have left.
      Alert.alert(t("feeStructures.savedTitle"), t("feeStructures.savedBody"), [
        { text: t("common.ok"), onPress: () => router.back() },
      ]);
    } catch (err) {
      Alert.alert(t("common.error"), errorText(t, err));
    } finally {
      setSaving(false);
    }
  }, [academicYear, term, dueDate, classIds, items, schoolId, t, router]);

  return (
    <KeyboardAvoidingView
      style={st.screen}
      behavior="padding"
    >
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" translucent={false} />

      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={st.headerCenter}>
          <Text style={st.headerTitle}>{t("feeStructures.newTitle")}</Text>
          <Text style={st.headerSub}>{t("feeStructures.newSub")}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        <View style={st.row}>
          <View style={{ flex: 1 }}>
            <Text style={st.label}>{t("feeStructures.year")}</Text>
            <TextInput
              style={st.input}
              value={academicYear}
              onChangeText={setYear}
              placeholder={t("feeStructures.yearPh")}
              placeholderTextColor="#9CA3AF"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={st.label}>{t("feeStructures.term")}</Text>
            <TextInput
              style={st.input}
              value={term}
              onChangeText={setTerm}
              placeholder={t("feeStructures.termPh")}
              placeholderTextColor="#9CA3AF"
            />
          </View>
        </View>

        <Text style={st.label}>{t("feeStructures.dueDate")}</Text>
        <TextInput
          style={st.input}
          value={dueDate}
          onChangeText={setDueDate}
          placeholder="2026-09-15"
          placeholderTextColor="#9CA3AF"
          autoCapitalize="none"
        />
        <Text style={st.hint}>{t("feeStructures.dueHint")}</Text>

        {/* ── Which classes ── */}
        <Text style={st.section}>{t("feeStructures.classes")}</Text>
        <Text style={st.hint}>{t("feeStructures.classesHint")}</Text>
        <View style={st.chips}>
          {classes.map((c) => {
            const on = classIds.includes(String(c.id ?? c._id));
            return (
              <TouchableOpacity
                key={String(c.id ?? c._id)}
                style={[st.chip, on && st.chipOn]}
                onPress={() => toggleClass(String(c.id ?? c._id))}
                activeOpacity={0.8}
              >
                <Text style={[st.chipText, on && st.chipTextOn]}>{c.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── The lines ── */}
        <Text style={st.section}>{t("feeStructures.items")}</Text>

        {items.map((it, i) => (
          <View key={i} style={st.itemCard}>
            <View style={st.row}>
              <View style={{ flex: 1 }}>
                <Text style={st.label}>{t("feeStructures.code")}</Text>
                <TextInput
                  style={st.input}
                  value={it.code}
                  onChangeText={(v) => setItem(i, { code: v })}
                  placeholder="TUITION"
                  placeholderTextColor="#9CA3AF"
                  autoCapitalize="characters"
                />
              </View>
              <View style={{ flex: 2 }}>
                <Text style={st.label}>{t("feeStructures.itemLabel")}</Text>
                <TextInput
                  style={st.input}
                  value={it.label}
                  onChangeText={(v) => setItem(i, { label: v })}
                  placeholder={t("feeStructures.itemLabelPh")}
                  placeholderTextColor="#9CA3AF"
                />
              </View>
            </View>

            <View style={st.row}>
              <View style={{ flex: 1 }}>
                <Text style={st.label}>{t("feeStructures.amount")}</Text>
                <TextInput
                  style={st.input}
                  value={String(it.amount)}
                  onChangeText={(v) => setItem(i, { amount: v.replace(/[^0-9]/g, "") })}
                  placeholder="0"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="number-pad"
                />
              </View>
              <View style={st.optionalBox}>
                <Text style={st.label}>{t("feeStructures.optional")}</Text>
                <Switch
                  value={it.isOptional}
                  onValueChange={(v) => setItem(i, { isOptional: v })}
                  trackColor={{ true: "#C7D2FE", false: "#E5E7EB" }}
                  thumbColor={it.isOptional ? BRAND : "#9CA3AF"}
                />
              </View>
            </View>

            {items.length > 1 && (
              <TouchableOpacity
                onPress={() => setItems((rows) => rows.filter((_, idx) => idx !== i))}
                style={st.removeBtn}
                activeOpacity={0.7}
              >
                <Ionicons name="trash-outline" size={15} color="#B91C1C" />
                <Text style={st.removeText}>{t("common.remove")}</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        <TouchableOpacity
          style={st.addItem}
          onPress={() => setItems((rows) => [...rows, blankItem()])}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={16} color={BRAND} />
          <Text style={st.addItemText}>{t("feeStructures.addItem")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[st.saveBtn, saving && st.saveBtnOff]}
          onPress={save}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving
            ? <ActivityIndicator color="#FFF" />
            : <Text style={st.saveText}>{t("common.save")}</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F9FAFB" },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingTop: 60, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
  },
  backBtn:      { padding: 4 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 2 },

  body: { padding: 16, gap: 4, paddingBottom: 40 },
  row:  { flexDirection: "row", gap: 10 },

  label: { fontSize: 12, fontWeight: "600", color: "#374151", marginBottom: 6, marginTop: 10 },
  input: {
    borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, color: "#111827", backgroundColor: "#FFF",
  },
  hint: { fontSize: 12, color: "#6B7280", marginTop: 6, lineHeight: 17 },

  section: { fontSize: 15, fontWeight: "700", color: "#111827", marginTop: 22 },

  chips:      { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: {
    borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 7, backgroundColor: "#FFF",
  },
  chipOn:     { backgroundColor: "#EEF2FF", borderColor: "#C7D2FE" },
  chipText:   { fontSize: 13, color: "#374151" },
  chipTextOn: { color: "#3730A3", fontWeight: "700" },

  itemCard: {
    backgroundColor: "#FFF", borderRadius: 12, padding: 12, marginTop: 12,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  optionalBox: { width: 110, alignItems: "flex-start" },

  removeBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    alignSelf: "flex-start", marginTop: 12, paddingVertical: 4,
  },
  removeText: { color: "#B91C1C", fontSize: 13, fontWeight: "600" },

  addItem: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderWidth: 1, borderColor: "#C7D2FE", borderStyle: "dashed",
    borderRadius: 10, paddingVertical: 12, marginTop: 14, backgroundColor: "#FFF",
  },
  addItemText: { color: BRAND, fontWeight: "700", fontSize: 14 },

  saveBtn: {
    backgroundColor: BRAND, borderRadius: 12, paddingVertical: 15,
    alignItems: "center", marginTop: 26,
  },
  saveBtnOff: { opacity: 0.6 },
  saveText:   { color: "#FFF", fontWeight: "700", fontSize: 16 },
});
