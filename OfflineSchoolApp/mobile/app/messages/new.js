// app/messages/new.js
//
// Start a conversation.
//
// The list of people comes from the server, which filters it through the same
// policy the send path uses. Nothing is decided here: a picker that guessed
// the rule would offer people the server then refuses, and would be wrong
// the moment a school changed a setting.
//
// This is the one screen in messaging that genuinely needs a connection.
// Reading threads and composing into an existing one both work offline; only
// discovering somebody new does not.

import { useState, useCallback, useEffect } from "react";
import {
  View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar, Alert,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useAuthStore } from "../../src/store/auth.store";
import MessageService   from "../../src/services/message.service";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";
import { participantName, recipientSubtitle } from "../../src/utils/participantName";
import { errorText } from "../../src/utils/appError";

import { HeaderIcon, IconSquare } from "../../src/components/Tinted";
import { COLORS, ACCENT, SEMANTIC, roleAccent } from "../../src/theme/colors";

// The app's theme under this screen's old names.
const C = {
  primary: COLORS.primary, primaryBg: COLORS.primaryLight, white: COLORS.surface,
  gray50: COLORS.page, gray100: COLORS.border, gray200: COLORS.border,
  gray300: COLORS.textMuted, gray400: COLORS.textSubtle, gray500: COLORS.textSecondary,
  gray700: COLORS.text, gray900: COLORS.text, danger: SEMANTIC.error.text,
};

/** A person's colour: a guardian sky, anyone else by role, else sky. */
const personAccent = (p) =>
  ACCENT[p?.kind === "guardian" ? "sky" : p?.role ? roleAccent(p.role) : "sky"];

export default function NewConversationScreen() {
  const { t } = useTranslation();
  // Clear the status bar and the navigation bar (edge-to-edge Android, the iOS notch).
  const pad = useScreenInsets({ top: 0, bottom: 16 });
  const user = useAuthStore((s) => s.user);
  const myId = String(user?._id ?? "");

  const [query,      setQuery]      = useState("");
  const [recipients, setRecipients] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [opening,    setOpening]    = useState(null);
  const [error,      setError]      = useState(null);

  // Debounced so a fast typist does not fire a request per keystroke.
  const load = useCallback(async (q) => {
    setLoading(true);
    setError(null);
    try {
      setRecipients(await MessageService.fetchRecipients(q));
    } catch (err) {
      const msg = err?.response?.data?.error || errorText(t, err);
      setError(
        err?.response
          ? msg
          : t("msgMobile.needsConnection")
      );
      setRecipients([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = setTimeout(() => load(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  const handlePick = useCallback(async (r) => {
    const key = `${r.kind}:${r.id}`;
    setOpening(key);
    try {
      const conversation = await MessageService.openDirect({
        id: r.id, kind: r.kind, myId, myKind: "user",
      });
      if (conversation?._id) {
        // replace, not push: coming "back" from a thread should return to the
        // conversation list, not to this picker.
        router.replace(`/messages/${conversation._id}`);
      }
    } catch (err) {
      // A 403 here carries a plain reason from the policy — show it, because
      // it usually names a setting somebody can change.
      Alert.alert(
        t("msgMobile.cannotStart"),
        err?.response?.data?.error || errorText(t, err)
      );
    } finally {
      setOpening(null);
    }
  }, [myId, t]);

  const renderItem = ({ item }) => {
    const key = `${item.kind}:${item.id}`;
    const who = participantName(item, t) || item.name;
    const sub = recipientSubtitle(item, t);
    const a = personAccent(item);
    return (
      <TouchableOpacity
        style={s.row}
        activeOpacity={0.7}
        disabled={opening !== null}
        onPress={() => handlePick(item)}
      >
        <View style={[s.avatar, { backgroundColor: a.wash }]}>
          <Text style={[s.avatarText, { color: a.deep }]}>
            {(who || "?").slice(0, 1).toUpperCase()}
          </Text>
        </View>

        <View style={s.rowBody}>
          <Text style={s.rowName} numberOfLines={1}>{who}</Text>
          {/* The server's subtitle is English — a role slug for staff. Staff
              may write to any pupil, not only their own child, so ownChild is
              left false here and a student reads as "Student". */}
          {sub ? (
            <Text style={s.rowSub} numberOfLines={1}>{sub}</Text>
          ) : null}
        </View>

        {opening === key
          ? <ActivityIndicator size="small" color={C.primary} />
          : <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <View style={[s.header, { paddingTop: 12 + pad.paddingTop }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="close" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={s.headerTitleRow}>
          <HeaderIcon size={32} style={s.headerIcon} />
          <Text style={s.headerTitle} numberOfLines={1}>{t("msgMobile.newConversation")}</Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <View style={s.searchWrap}>
        <Ionicons name="search" size={16} color={C.gray400} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("msgMobile.searchPeoplePh")}
          placeholderTextColor={C.gray400}
          style={s.searchInput}
          autoFocus
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery("")}>
            <Ionicons name="close-circle" size={16} color={C.gray400} />
          </TouchableOpacity>
        )}
      </View>

      {error && (
        <View style={s.errorBar}>
          <Ionicons name="alert-circle-outline" size={15} color={C.danger} />
          <Text style={s.errorText}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      ) : (
        <FlatList
          contentContainerStyle={{ paddingBottom: pad.paddingBottom }}
          data={recipients}
          keyExtractor={(r) => `${r.kind}:${r.id}`}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            !error ? (
              <View style={s.empty}>
                <IconSquare icon="people-outline" accent="sky" size={56} radius={16} />
                <Text style={s.emptyText}>
                  {query.trim()
                    ? t("msgMobile.noMatch")
                    : t("msgMobile.nobodyAvailable")}
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray200,
  },
  backBtn:     { width: 40, alignItems: "center" },
  headerTitleRow: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  headerIcon:  { marginRight: 8 },
  headerTitle: { flexShrink: 1, fontSize: 17, fontWeight: "700", color: C.gray900, textAlign: "center" },

  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    margin: 12, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: C.gray50, borderRadius: 12,
    borderWidth: 1, borderColor: C.gray200,
  },
  searchInput: { flex: 1, fontSize: 15, color: C.gray900, padding: 0 },

  errorBar: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: SEMANTIC.error.bg, paddingHorizontal: 16, paddingVertical: 10,
    marginHorizontal: 12, marginBottom: 8, borderRadius: 10,
  },
  errorText: { flex: 1, fontSize: 12, color: C.danger },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray100,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.primaryBg,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 15, fontWeight: "700", color: C.primary },
  rowBody:    { flex: 1 },
  rowName:    { fontSize: 15, fontWeight: "600", color: C.gray900 },
  rowSub:     { fontSize: 12, color: C.gray500, marginTop: 1 },

  empty:     { alignItems: "center", paddingTop: 60, paddingHorizontal: 40, gap: 10 },
  emptyText: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center", lineHeight: 19 },
});
