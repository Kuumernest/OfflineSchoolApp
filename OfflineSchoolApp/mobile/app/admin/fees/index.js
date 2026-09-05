// app/admin/fees/index.js
//
// Pick a student to take fees from.
//
// Reads the local roster, so it opens with no signal. Balances come from the
// local ledger tables and already include payments this device has taken but
// not yet synced — a bursar must never be shown a pre-payment figure, because
// that is how the same fee gets collected twice.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ActivityIndicator, RefreshControl, StatusBar,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { StudentService }   from "../../../src/services/student.service";
import FeeService           from "../../../src/services/fee.service";
import { useTranslation }   from "../../../src/i18n/useTranslation";
import { formatMoney }      from "../../../src/i18n/format";
import { useAuthStore }     from "../../../src/store/auth.store";

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
  danger:    "#9F2318",
  dangerBg:  "#FDF2F1",
  success:   "#12683A",
  successBg: "#EEF7F1",
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

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

export default function FeesIndexScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [students, setStudents]   = useState([]);
  const [balances, setBalances]   = useState({});
  const [loading,  setLoading]    = useState(true);
  const [refreshing, setRefresh]  = useState(false);
  const [query, setQuery]         = useState("");
  const [pendingCount, setPending] = useState(0);

  const year = useMemo(currentAcademicYear, []);

  const load = useCallback(async () => {
    try {
      const list = await StudentService.getApprovedStudentsLocal();
      const rows = Array.isArray(list) ? list : (list?.students ?? []);
      setStudents(rows);

      // One account read per student. The roster on a phone is a class or two,
      // not the whole school, so this stays cheap.
      const next = {};
      for (const s of rows) {
        const id = s._id || s.id;
        if (!id) continue;
        const acct = await FeeService.getStudentAccount(id, year);
        next[id] = acct.totals;
      }
      setBalances(next);

      const pending = await FeeService.listPendingPayments();
      setPending(pending.length);
    } catch (err) {
      console.warn("[fees] load failed:", err.message);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      (s.name || "").toLowerCase().includes(q) ||
      (s.enrollmentNo || "").toLowerCase().includes(q)
    );
  }, [students, query]);

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
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("fees.title")}</Text>
          <Text style={styles.subtitle}>{year}</Text>
        </View>

        {/* The fee schedule itself. There was no way to it from the phone —
            structures were only ever visible on the desktop. */}
        <TouchableOpacity
          style={styles.structuresBtn}
          onPress={() => router.push("/admin/fees/structures")}
          activeOpacity={0.8}
        >
          <Ionicons name="document-text-outline" size={16} color="#4F46E5" />
          <Text style={styles.structuresText}>{t("feeStructures.short")}</Text>
        </TouchableOpacity>
      </View>

      {/* Anything this device is still holding. Shown before the list so a
          bursar closing up for the day can see it without scrolling. */}
      {pendingCount > 0 && (
        <View style={styles.pendingBanner}>
          <Ionicons name="cloud-upload-outline" size={16} color={C.warning} />
          <Text style={styles.pendingText}>
            {t("fees.pendingSync", { count: pendingCount })}
          </Text>
        </View>
      )}

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={C.inkFaint} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t("students.searchPh")}
          placeholderTextColor={C.inkFaint}
          autoCorrect={false}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item._id || item.id)}
        contentContainerStyle={filtered.length ? styles.list : styles.listEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefresh(true); load(); }}
            tintColor={C.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.centre}>
            <Ionicons name="people-outline" size={28} color={C.inkFaint} />
            <Text style={styles.emptyText}>{t("students.none")}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const id      = String(item._id || item.id);
          const totals  = balances[id];
          const balance = totals?.balance ?? 0;
          const owes    = balance > 0;

          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => router.push(`/admin/fees/${id}?year=${encodeURIComponent(year)}`)}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name || t("academic.student")}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.enrollmentNo || "—"}
                </Text>
              </View>

              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.rowAmount,
                    { color: owes ? C.danger : C.success },
                  ]}
                >
                  {formatMoney(balance)}
                </Text>
                <Text style={styles.rowLabel}>
                  {owes ? t("fees.owes") : t("fees.settled")}
                </Text>
              </View>

              <Ionicons name="chevron-forward" size={16} color={C.inkFaint} />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: C.canvas },
  centre:   { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText:{ marginTop: 8, color: C.inkMuted, fontSize: 13 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8,
  },
  structuresBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    borderWidth: 1, borderColor: "#C7D2FE", borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 7, backgroundColor: "#EEF2FF",
  },
  structuresText: { color: "#4F46E5", fontWeight: "700", fontSize: 12.5 },
  title:    { fontSize: 22, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 2, fontSize: 12, color: C.inkMuted },

  pendingBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 10, backgroundColor: C.warningBg,
    borderWidth: 1, borderColor: "#F0DCBB",
  },
  pendingText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 8,
    paddingHorizontal: 12, height: 40,
    borderRadius: 10, backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.line,
  },
  search: { flex: 1, fontSize: 14, color: C.inkBody, padding: 0 },

  list:      { paddingHorizontal: 16, paddingBottom: 24 },
  listEmpty: { flexGrow: 1 },

  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: C.surface, borderRadius: 10,
    borderWidth: 1, borderColor: C.line,
    paddingHorizontal: 12, paddingVertical: 12, marginBottom: 8,
  },
  rowMain:  { flex: 1, minWidth: 0 },
  rowName:  { fontSize: 14, fontWeight: "600", color: C.ink },
  rowMeta:  { marginTop: 2, fontSize: 11, color: C.inkFaint },
  rowRight: { alignItems: "flex-end" },
  rowAmount:{ fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowLabel: { marginTop: 1, fontSize: 10, color: C.inkFaint, textTransform: "uppercase" },
});
