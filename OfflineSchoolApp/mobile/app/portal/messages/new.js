// app/portal/messages/new.js
//
// A guardian choosing who to write to.
//
// The list comes from the server, which filters it through the school's
// communication policy — teachers, the office, and their own child. Nothing
// here decides who is reachable, so a parent is never shown somebody the send
// path would then refuse.
//
// Needs a connection. Reading a thread works offline; discovering a new person
// to write to does not.

import { useState, useCallback, useEffect } from "react";
import {
  View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import * as PortalService from "../../../src/services/portal.service";

const C = {
  ink: "#111827", inkBody: "#374151", inkMuted: "#6B7280", inkFaint: "#9CA3AF",
  line: "#E9EBF0", canvas: "#F7F8FA", surface: "#FFFFFF", danger: "#DC2626",
};

export default function PortalNewMessageScreen() {
  const router = useRouter();

  const [query,   setQuery]   = useState("");
  const [people,  setPeople]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);
  const [error,   setError]   = useState(null);

  const load = useCallback(async (q) => {
    setLoading(true);
    setError(null);
    try {
      setPeople(await PortalService.fetchRecipients(q));
    } catch (err) {
      setPeople([]);
      setError(
        err?.response
          ? err.response.data?.message || "Could not load the list."
          : "Starting a new conversation needs a connection."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced so a fast typist does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  const pick = useCallback(async (r) => {
    const key = `${r.kind}:${r.id}`;
    setOpening(key);
    try {
      const c = await PortalService.openConversation(r.id, r.kind);
      if (c?._id) router.replace(`/portal/messages/${c._id}`);
    } catch (err) {
      // A 403 carries the policy's own words — show them, because they
      // usually name a school setting rather than a fault.
      Alert.alert(
        "Cannot start that conversation",
        err?.response?.data?.message || "Please try again."
      );
    } finally {
      setOpening(null);
    }
  }, [router]);

  const renderItem = ({ item }) => {
    const key = `${item.kind}:${item.id}`;
    return (
      <TouchableOpacity
        style={s.row}
        activeOpacity={0.7}
        disabled={opening !== null}
        onPress={() => pick(item)}
      >
        <View style={s.avatar}>
          <Text style={s.avatarText}>
            {(item.name || "?").slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{item.name}</Text>
          {item.subtitle ? (
            <Text style={s.sub} numberOfLines={1}>{item.subtitle}</Text>
          ) : null}
        </View>
        {opening === key
          ? <ActivityIndicator size="small" color={C.ink} />
          : <Ionicons name="chevron-forward" size={17} color={C.inkFaint} />}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.surface} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn}>
          <Ionicons name="close" size={23} color={C.ink} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>New message</Text>
        <View style={s.iconBtn} />
      </View>

      <View style={s.searchWrap}>
        <Ionicons name="search" size={15} color={C.inkFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search teachers or the office…"
          placeholderTextColor={C.inkFaint}
          style={s.search}
          autoFocus
        />
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={C.ink} /></View>
      ) : (
        <FlatList
          data={people}
          keyExtractor={(r) => `${r.kind}:${r.id}`}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            !error ? (
              <Text style={s.empty}>
                {query.trim()
                  ? "Nobody matches that name."
                  : "There is nobody available to write to."}
              </Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  iconBtn:     { width: 40, alignItems: "center" },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: C.ink, textAlign: "center" },

  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    margin: 12, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: C.canvas, borderRadius: 10,
    borderWidth: 1, borderColor: C.line,
  },
  search: { flex: 1, fontSize: 14, color: C.ink, padding: 0 },

  error: {
    fontSize: 12, color: C.danger, backgroundColor: "#FEF2F2",
    marginHorizontal: 12, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8,
  },

  row: {
    flexDirection: "row", alignItems: "center", gap: 11,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  avatar: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: C.canvas,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 15, fontWeight: "700", color: C.ink },
  name:       { fontSize: 14, fontWeight: "600", color: C.ink },
  sub:        { fontSize: 12, color: C.inkMuted, marginTop: 1 },

  empty: {
    textAlign: "center", paddingTop: 50, paddingHorizontal: 40,
    fontSize: 13, color: C.inkFaint, lineHeight: 19,
  },
});
