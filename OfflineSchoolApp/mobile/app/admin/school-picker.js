// app/admin/school-picker.js
//
// Which school a super_admin is working inside.
//
// The account belongs to no school, and every admin screen on the phone works
// on one school — so the school is chosen here and mirrored into the session
// (auth.store enterSchool), the same arrangement as the web console's school
// bar. The navigation guard sends a super_admin here until one is chosen.
//
// The list needs a connection: it is the platform's list of schools, not
// something this phone holds.

import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import api                from "../../src/services/api";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useAuthStore }   from "../../src/store/auth.store";
import { errorText }      from "../../src/utils/appError";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
  ink:       "#0D1220",
  inkBody:   "#343D4F",
  inkMuted:  "#4F5A70",
  inkFaint:  "#666F84",
  line:      "#E9EBF0",
  surface:   "#FFFFFF",
  canvas:    "#F4F5F8",
  danger:    "#B42318",
};

export default function SchoolPickerScreen() {
  const router = useRouter();
  const { t }  = useTranslation();
  const pad    = useScreenInsets({ top: 12, bottom: 16 });
  const current     = useAuthStore((s) => s.activeSchool);
  const enterSchool = useAuthStore((s) => s.enterSchool);
  const leaveSchool = useAuthStore((s) => s.leaveSchool);
  const logout      = useAuthStore((s) => s.logout);

  const [query, setQuery]     = useState("");
  const [schools, setSchools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [busyId, setBusyId]   = useState(null);

  const load = useCallback(async (search) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get("/super-admin/schools", {
        params: { search: search || undefined, status: "active", limit: 100 },
      });
      setSchools(Array.isArray(data?.schools) ? data.schools : []);
    } catch (err) {
      setError(errorText(t, err) || t("schoolPick.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Searched on the server, after a pause in typing: a platform can hold more
  // schools than one page.
  useEffect(() => {
    const timer = setTimeout(() => load(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query, load]);

  const refused = (reason) => {
    if (reason === "pendingUploads") {
      Alert.alert(t("schoolPick.title"), t("schoolPick.pendingUploads"), [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("schoolPick.openPending"), onPress: () => router.push("/sync/pending") },
      ]);
    } else {
      Alert.alert(t("schoolPick.title"), t("schoolPick.failed"));
    }
  };

  const choose = async (school) => {
    setBusyId(school._id);
    try {
      const res = await enterSchool(school);
      if (!res.ok) { refused(res.reason); return; }
      router.replace("/admin/dashboard");
    } finally {
      setBusyId(null);
    }
  };

  const leave = async () => {
    const res = await leaveSchool();
    if (!res.ok) refused(res.reason);
  };

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={[styles.header, { paddingTop: pad.paddingTop }]}>
        {current ? (
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color={C.inkBody} />
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{t("schoolPick.title")}</Text>
          <Text style={styles.subtitle} numberOfLines={2}>{t("schoolPick.blurb")}</Text>
        </View>
        {!current ? (
          <TouchableOpacity onPress={logout} hitSlop={10}>
            <Ionicons name="log-out-outline" size={22} color={C.inkBody} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.body}>
        {current ? (
          <View style={styles.currentRow}>
            <Text style={styles.currentText} numberOfLines={1}>
              {t("schoolPick.current", { name: current.name })}
            </Text>
            <TouchableOpacity onPress={leave} hitSlop={8}>
              <Text style={styles.leave}>{t("schoolPick.leave")}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder={t("schoolPick.search")}
          placeholderTextColor={C.inkFaint}
          autoCorrect={false}
        />

        {loading ? (
          <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
        ) : error ? (
          <View style={styles.centre}>
            <Text style={styles.error}>{error}</Text>
            <TouchableOpacity onPress={() => load(query.trim())} style={styles.retry}>
              <Text style={styles.retryText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={schools}
            keyExtractor={(s) => String(s._id)}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: pad.paddingBottom }}
            ListEmptyComponent={<Text style={styles.empty}>{t("schoolPick.none")}</Text>}
            renderItem={({ item }) => {
              const on = current?._id === String(item._id);
              return (
                <TouchableOpacity
                  style={[styles.option, on && styles.optionOn]}
                  onPress={() => choose(item)}
                  disabled={Boolean(busyId)}
                  activeOpacity={0.8}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.optionTitle} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.optionHint} numberOfLines={1}>
                      {[item.code, item.city].filter(Boolean).join(" · ") || " "}
                    </Text>
                  </View>
                  {busyId === item._id
                    ? <ActivityIndicator color={C.primary} />
                    : on
                      ? <Ionicons name="checkmark-circle" size={20} color={C.primary} />
                      : <Ionicons name="chevron-forward" size={18} color={C.inkFaint} />}
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  centre: { alignItems: "center", marginTop: 24, gap: 10 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },

  body: { flex: 1, padding: 16 },

  currentRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: C.primaryBg, borderRadius: 9, padding: 10, marginBottom: 10,
  },
  currentText: { flex: 1, fontSize: 13, color: C.ink, fontWeight: "600" },
  leave:       { fontSize: 13, color: C.primary, fontWeight: "700" },

  input: {
    height: 42, borderRadius: 9, borderWidth: 1, borderColor: "#D5D9E2",
    paddingHorizontal: 12, fontSize: 15, color: C.ink,
    backgroundColor: C.surface, marginBottom: 6,
  },

  option: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: 9,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, marginTop: 6,
  },
  optionOn:    { borderColor: C.primary, backgroundColor: C.primaryBg },
  optionTitle: { fontSize: 14, fontWeight: "600", color: C.ink },
  optionHint:  { marginTop: 1, fontSize: 11, color: C.inkMuted },

  error:     { fontSize: 13, color: C.danger, textAlign: "center" },
  retry:     { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: C.primary },
  retryText: { color: C.primary, fontWeight: "600" },
  empty:     { fontSize: 12, color: C.inkFaint, paddingVertical: 12, textAlign: "center" },
});
