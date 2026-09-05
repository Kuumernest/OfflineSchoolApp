// app/portal/messages/[id].js
//
// One conversation, on a guardian's phone.
//
// The thread itself is cached, so a parent standing in the school yard with
// one bar still sees what was said. Sending is NOT queued: a guardian's phone
// has no outbox, and a message that silently waited would leave a parent
// believing the school had been told something it never received. So a failed
// send says so and keeps the text.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, StatusBar,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import * as PortalService from "../../../src/services/portal.service";
import { useTranslation } from "../../../src/i18n/useTranslation";

const C = {
  ink: "#111827", inkBody: "#374151", inkMuted: "#6B7280", inkFaint: "#9CA3AF",
  line: "#E9EBF0", canvas: "#F7F8FA", surface: "#FFFFFF",
  danger: "#DC2626",
};

const timeLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export default function PortalThreadScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams();
  const router = useRouter();

  const [messages, setMessages] = useState([]);
  const [title,    setTitle]    = useState("");
  const [draft,    setDraft]    = useState("");
  const [loading,  setLoading]  = useState(true);
  const [sending,  setSending]  = useState(false);
  const [stale,    setStale]    = useState(false);
  const [error,    setError]    = useState(null);

  const listRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await PortalService.fetchThread(id);
      const payload = res?.data ?? {};
      setMessages(payload.messages ?? []);
      setStale(Boolean(res?.stale));

      const c = payload.conversation;
      setTitle(
        c?.title ||
        (c?.participants || []).map((p) => p.name).filter(Boolean).join(", ") ||
        t("msgMobile.conversation")
      );

      const newest = (payload.messages ?? [])
        .filter((m) => m.seq != null)
        .sort((a, b) => a.seq - b.seq)
        .pop();
      if (newest) PortalService.markRead(id, newest.seq);
    } catch (err) {
      setError(
        err?.response?.status === 401
          ? t("msgMobile.sessionExpired")
          : t("msgMobile.couldNotLoadThread")
      );
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  // Polled while open. There is no socket layer, and a reply arriving unseen
  // matters more here than the extra request does.
  useEffect(() => {
    const poll = setInterval(load, 20000);
    return () => clearInterval(poll);
  }, [load]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    setDraft("");
    try {
      await PortalService.sendMessage(id, body);
      await load();
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      // Put the text back. Nothing here queues, so losing it would be losing
      // the message.
      setDraft(body);
      setError(
        err?.response?.data?.message ||
        t("msgMobile.sendFailed")
      );
    } finally {
      setSending(false);
    }
  }, [draft, sending, id, load, t]);

  const ordered = [...messages].sort((a, b) => a.seq - b.seq);

  const renderItem = ({ item }) => {
                       return (
    <View style={s.bubble}>
      <Text style={s.sender}>{item.sender?.name || t("msgMobile.schoolSender")}</Text>
      <Text style={s.body}>
        {item.isDeleted ? t("msgMobile.deletedMessage") : item.body}
      </Text>
      {(item.attachments?.length ?? 0) > 0 && (
        <View style={{ marginTop: 4 }}>
          {item.attachments.map((a) => (
            <Text key={a.url} style={s.attachment} numberOfLines={1}>
              {a.name || "attachment"}
            </Text>
          ))}
        </View>
      )}
      <Text style={s.time}>{timeLabel(item.createdAt)}</Text>
    </View>
  );
                     };

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior="padding"
    >
      <StatusBar barStyle="dark-content" backgroundColor={C.surface} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={C.ink} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{title || t("msgMobile.conversation")}</Text>
        <View style={s.iconBtn} />
      </View>

      {stale && (
        <View style={s.note}>
          <Ionicons name="cloud-offline-outline" size={13} color={C.inkMuted} />
          <Text style={s.noteText}>{t("msgMobile.savedCopy")}</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={C.ink} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={ordered}
          keyExtractor={(m) => m._id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <Text style={s.empty}>{t("msgMobile.noMessages")}</Text>
          }
        />
      )}

      {error && <Text style={s.error}>{error}</Text>}

      <View style={s.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("msgMobile.writeMessagePh")}
          placeholderTextColor={C.inkFaint}
          style={s.input}
          multiline
          maxLength={4000}
        />
        <TouchableOpacity
          onPress={send}
          disabled={!draft.trim() || sending}
          style={[s.sendBtn, (!draft.trim() || sending) && s.sendOff]}
          activeOpacity={0.85}
        >
          {sending
            ? <ActivityIndicator size="small" color="#FFFFFF" />
            : <Ionicons name="send" size={17} color="#FFFFFF" />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.surface,
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  iconBtn:     { width: 40, alignItems: "center" },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: C.ink, textAlign: "center" },

  note: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 7, backgroundColor: C.surface,
  },
  noteText: { fontSize: 11, color: C.inkMuted },

  list:  { padding: 12, gap: 8 },
  empty: { textAlign: "center", paddingTop: 40, fontSize: 13, color: C.inkFaint },

  bubble: {
    backgroundColor: C.surface, borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: C.line,
  },
  sender:     { fontSize: 11, fontWeight: "700", color: C.inkMuted, marginBottom: 2 },
  body:       { fontSize: 14, color: C.inkBody, lineHeight: 20 },
  attachment: { fontSize: 12, color: C.ink, textDecorationLine: "underline" },
  time:       { fontSize: 10, color: C.inkFaint, textAlign: "right", marginTop: 3 },

  error: {
    fontSize: 12, color: C.danger, backgroundColor: "#FEF2F2",
    paddingHorizontal: 16, paddingVertical: 8,
  },

  composer: {
    flexDirection: "row", alignItems: "flex-end", gap: 8,
    backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: C.line,
  },
  input: {
    flex: 1, maxHeight: 110, borderRadius: 18, backgroundColor: C.canvas,
    borderWidth: 1, borderColor: C.line,
    paddingHorizontal: 14, paddingVertical: 9, fontSize: 14, color: C.ink,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.ink,
    alignItems: "center", justifyContent: "center",
  },
  sendOff: { backgroundColor: C.inkFaint },
});
