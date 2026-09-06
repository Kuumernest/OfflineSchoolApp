// app/messages/[id].js
//
// One conversation.
//
// Composing works with no connection: the message is written locally, shown
// at once, and handed to the mutation outbox. Its state is visible on the
// bubble — a clock while it waits, a tick once the server has it — so nobody
// has to guess whether what they typed on the bus actually went.
//
// Order comes from the server's `seq` and never from a timestamp. Phones in
// this deployment often have wrong clocks, and a message composed offline on
// Monday must still land in the place the server gives it, not wherever its
// own clock claims.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, StatusBar, Alert,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import * as DocumentPicker from "expo-document-picker";

import { useAuthStore } from "../../src/store/auth.store";
import MessageService   from "../../src/services/message.service";
import { useTranslation } from "../../src/i18n/useTranslation";
import { errorText } from "../../src/utils/appError";

const C = {
  primary: "#2563EB", primaryBg: "#EFF6FF", white: "#FFFFFF",

  // The outgoing bubble, and deliberately not `primary`.
  //
  // It was primary, #2563EB, and everything that has to be read ON it was
  // fighting for room above it: the read tick could only be white, the
  // delivered tick had to be so pale it was nearly white too, and the two
  // states people most need to tell apart differed by almost nothing. The
  // first fix here got the read tick from 1.41:1 to 5.17:1, which was a real
  // improvement and still not enough to see at 14px.
  //
  // Taking the bubble two steps darker gives every mark on it room. Nothing
  // else moves: primary still draws the avatars, the spinner and the reply
  // rule, so the screen keeps its colour and only the bubble deepens.
  //
  //   body      #FFFFFF  10.36:1
  //   read      #FFFFFF  10.36:1   full white, 15px
  //   delivered #93C5FD   5.74:1   a real blue now, not a pale white
  //   failed    #FECACA   7.16:1
  //
  // Delivered and read share a shape, so colour is all that separates them —
  // and on the old bubble the only colours that cleared the floor were all
  // within a shade of each other. This is the gap that was missing.
  sent: "#1E3A8A",
  gray50: "#F9FAFB", gray100: "#F3F4F6", gray200: "#E5E7EB",
  gray300: "#D1D5DB", gray400: "#9CA3AF", gray500: "#6B7280",
  gray700: "#374151", gray900: "#111827",
  danger: "#DC2626", dangerBg: "#FEF2F2",
};

const timeLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * Read receipts on an outgoing bubble.
 *
 *   ✓       sent (server has it)
 *   ✓✓      delivered (recipient's device confirmed receiving)
 *   ✓✓ white read (recipient has seen it)
 *
 * The "queued" and "failed" states use their own icons — those are about
 * the sender's device, not the recipient's.
 *
 * ── Why read is white and not blue ──────────────────────────────────────
 *
 * Every one of these sits on the outgoing bubble, which is C.primary,
 * #2563EB. A blue tick on a blue bubble measured 1.41:1 — WCAG asks 3:1 of
 * a graphical indicator, and 1.41 is not dim, it is invisible. The state
 * that matters most was the one nobody could see. The failed marker was
 * scarcely better at 2.72:1, on the one message a sender must notice.
 *
 * The tick shape already separates sent from delivered — one mark against
 * two — so colour only has to separate delivered from read: a real blue
 * against full white, which is a difference you can see at 14px rather than
 * one you can measure.
 *
 *   queued    #93C5FD   5.74:1
 *   failed    #FECACA   7.16:1
 *   sent      #93C5FD   5.74:1
 *   delivered #93C5FD   5.74:1
 *   read      #FFFFFF  10.36:1
 *
 * checkScreenEdges re-measures these against the bubble, so a colour that
 * looked right in a swatch cannot quietly drop below the floor again.
 */
function StateMark({ state, seq, participantRead }) {
  if (state === "queued")  return <Ionicons name="time-outline"    size={13} color="#93C5FD" />;
  if (state === "failed")  return <Ionicons name="alert-circle"    size={14} color="#FECACA" />;

  // No seq yet — treat as sent.
  if (seq == null) return <Ionicons name="checkmark" size={13} color="#93C5FD" />;

  const isRead      = (participantRead?.lastReadSeq      || 0) >= seq;
  const isDelivered = (participantRead?.lastDeliveredSeq || 0) >= seq;

  if (isRead) {
    // Full white, and a shade larger than the delivered pair: the two
    // states share a shape, so this is the only thing telling them apart.
    return (
      <View style={{ flexDirection: "row", marginLeft: 2 }}>
        <Ionicons name="checkmark-done" size={15} color="#FFFFFF" />
      </View>
    );
  }
  if (isDelivered) {
    // Gray double check.
    return (
      <View style={{ flexDirection: "row", marginLeft: 2 }}>
        <Ionicons name="checkmark-done" size={14} color="#93C5FD" />
      </View>
    );
  }
  // Sent — single gray check.
  return (
    <View style={{ flexDirection: "row", marginLeft: 2 }}>
      <Ionicons name="checkmark" size={13} color="#93C5FD" />
    </View>
  );
}

export default function ThreadScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams();
  const user   = useAuthStore((s) => s.user);
  const myId   = String(user?._id ?? "");

  const [messages, setMessages] = useState([]);
  const [draft,    setDraft]    = useState("");
  const [loading,  setLoading]  = useState(true);
  const [sending,  setSending]  = useState(false);
  const [pending,  setPending]  = useState([]);   // uploaded, not yet sent
  const [attaching, setAttaching] = useState(false);
  const [participantRead, setParticipantRead] = useState({ lastReadSeq: 0, lastDeliveredSeq: 0 });

  const listRef = useRef(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadLocal = useCallback(async () => {
    try {
      const rows = await MessageService.listMessages(id, { limit: 100 });
      setMessages(rows);

      // Advance the read marker to whatever is now on screen. Only server
      // messages carry a seq; a queued one of ours is not something to mark.
      const newest = rows.filter((m) => m.seq != null).pop();
      if (newest) await MessageService.markRead(id, newest.seq);
    } catch (err) {
      console.warn("[thread] local read failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const refresh = useCallback(async () => {
    await MessageService.syncMessages(id, myId);
    await loadLocal();
    // Fetch the other participant's read state for read receipts.
    const readState = await MessageService.getParticipantReadState(id);
    setParticipantRead(readState);
  }, [id, loadLocal, myId]);

  useEffect(() => {
    loadLocal().then(refresh);
  }, [loadLocal, refresh]);

  // Poll while the thread is open. There is no socket layer, and a message
  // arriving unseen is worse than a request every fifteen seconds.
  useEffect(() => {
    const poll = setInterval(refresh, 15000);
    return () => clearInterval(poll);
  }, [refresh]);

  // ── Attach ────────────────────────────────────────────────────────────────

  /**
   * Pick a file and upload it now, holding the result until the message is
   * sent.
   *
   * Uploading needs a connection even though sending does not — the outbox
   * carries JSON, and retrying a multipart upload would leave orphaned copies
   * on the server. So the file goes up first and the message that references
   * it can still be composed and queued offline afterwards.
   */
  const handleAttach = useCallback(async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;

      const asset = picked.assets?.[0];
      if (!asset) return;

      setAttaching(true);
      const attachment = await MessageService.uploadAttachment(id, {
        uri:      asset.uri,
        name:     asset.name,
        mimeType: asset.mimeType,
      });

      if (attachment) setPending((p) => [...p, attachment]);
    } catch (err) {
      Alert.alert(
        t("msgMobile.attachFailTitle"),
        err?.response?.data?.error ||
          t("msgMobile.attachFailBody")
      );
    } finally {
      setAttaching(false);
    }
  }, [id, t]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    // An attachment on its own is a message; text is not required.
    if ((!body && pending.length === 0) || sending) return;

    setSending(true);
    setDraft("");
    const attachments = pending;
    setPending([]);

    try {
      await MessageService.sendMessage({
        conversationId: id,
        body,
        attachments,
        sender: { kind: "user", id: myId, name: user?.name ?? null },
      });
      await loadLocal();
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      // The local write failed, which is not the same as the network being
      // down — the outbox handles that silently. Put the text and the
      // already-uploaded attachments back so neither is lost.
      setDraft(body);
      setPending(attachments);
      Alert.alert(t("msgMobile.saveFailTitle"), errorText(t, err));
    } finally {
      setSending(false);
    }
  }, [draft, pending, sending, id, myId, user?.name, loadLocal, t]);

  // ── Render ────────────────────────────────────────────────────────────────

  const renderItem = ({ item }) => {
    const mine = String(item.sender?.id) === myId;

    return (
      <View style={[s.bubbleRow, mine ? s.rowRight : s.rowLeft]}>
        <View
          style={[
            s.bubble,
            mine ? s.bubbleMine : s.bubbleTheirs,
            item.isDeleted && s.bubbleDeleted,
            item.state === "failed" && s.bubbleFailed,
          ]}
        >
          {!mine && !item.isDeleted && (
            <Text style={s.senderName}>{item.sender?.name || t("msgMobile.unknownSender")}</Text>
          )}

          <Text
            style={[
              s.bubbleText,
              mine && s.bubbleTextMine,
              item.isDeleted && s.bubbleTextDeleted,
            ]}
          >
            {item.isDeleted ? t("msgMobile.deletedMessage") : item.body}
          </Text>

          {!item.isDeleted && (item.attachments?.length ?? 0) > 0 && (
            <View>
              {item.attachments.map((a) => (
                <View key={a.url} style={s.attachmentRow}>
                  <Ionicons
                    name={a.kind === "image" ? "image-outline" : "document-outline"}
                    size={13}
                    color={mine ? "#DBEAFE" : C.primary}
                  />
                  <Text
                    style={[
                      s.attachmentName,
                      { color: mine ? "#DBEAFE" : C.primary },
                    ]}
                    numberOfLines={1}
                  >
                    {a.name || "attachment"}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <View style={s.bubbleMeta}>
            <Text style={[s.bubbleTime, mine && s.bubbleTimeMine]}>
              {timeLabel(item.createdAt)}
            </Text>
            {mine && !item.isDeleted && (
              <StateMark
                state={item.state}
                seq={item.seq}
                participantRead={participantRead}
              />
            )}
          </View>

          {item.state === "failed" && (
            <Text style={s.failedNote}>{t("msgMobile.failedNote")}</Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{t("msgMobile.conversation")}</Text>
        <View style={s.backBtn} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m._id}
          renderItem={renderItem}
          contentContainerStyle={s.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>{t("msgMobile.emptyThread")}</Text>
            </View>
          }
        />
      )}

      {pending.length > 0 && (
        <View style={s.pendingStrip}>
          {pending.map((a, i) => (
            <View key={a.url} style={s.chip}>
              <Ionicons
                name={a.kind === "image" ? "image-outline" : "document-outline"}
                size={13}
                color={C.primary}
              />
              <Text style={s.chipText} numberOfLines={1}>
                {a.name || "attachment"}
              </Text>
              <TouchableOpacity
                onPress={() => setPending((p) => p.filter((_, j) => j !== i))}
                hitSlop={8}
              >
                <Ionicons name="close" size={13} color={C.gray500} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      <View style={s.composer}>
        <TouchableOpacity
          onPress={handleAttach}
          disabled={attaching || sending}
          style={s.attachBtn}
          activeOpacity={0.7}
        >
          {attaching
            ? <ActivityIndicator size="small" color={C.gray500} />
            : <Ionicons name="attach" size={22} color={C.gray500} />}
        </TouchableOpacity>

        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("msgMobile.writeMessagePh")}
          placeholderTextColor={C.gray400}
          style={s.input}
          multiline
          maxLength={4000}
        />

        <TouchableOpacity
          onPress={handleSend}
          disabled={(!draft.trim() && pending.length === 0) || sending}
          style={[
            s.sendBtn,
            (!draft.trim() && pending.length === 0) || sending
              ? s.sendBtnOff
              : null,
          ]}
          activeOpacity={0.8}
        >
          {sending
            ? <ActivityIndicator size="small" color={C.white} />
            : <Ionicons name="send" size={18} color={C.white} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.gray50 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.white,
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.gray200,
  },
  backBtn:     { width: 40, alignItems: "center" },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: C.gray900, textAlign: "center" },

  listContent: { padding: 12, gap: 8 },

  bubbleRow: { flexDirection: "row" },
  rowLeft:   { justifyContent: "flex-start" },
  rowRight:  { justifyContent: "flex-end" },

  bubble: {
    maxWidth: "78%", borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  bubbleMine:    { backgroundColor: C.sent, borderBottomRightRadius: 4 },
  bubbleTheirs:  { backgroundColor: C.white, borderBottomLeftRadius: 4,
                   borderWidth: 1, borderColor: C.gray200 },
  bubbleDeleted: { backgroundColor: C.gray100, borderColor: C.gray200 },
  bubbleFailed:  { backgroundColor: C.danger },

  senderName: { fontSize: 11, fontWeight: "700", color: C.gray500, marginBottom: 2 },

  bubbleText:        { fontSize: 15, color: C.gray900, lineHeight: 20 },
  bubbleTextMine:    { color: C.white },
  bubbleTextDeleted: { color: C.gray400, fontStyle: "italic" },

  bubbleMeta:     { flexDirection: "row", alignItems: "center", justifyContent: "flex-end",
                    gap: 4, marginTop: 3 },
  bubbleTime:     { fontSize: 10, color: C.gray400 },
  bubbleTimeMine: { color: "#BFDBFE" },

  failedNote: { fontSize: 10, color: C.white, marginTop: 3 },

  empty:     { alignItems: "center", paddingTop: 60 },
  emptyText: { fontSize: 13, color: C.gray400 },

  composer: {
    flexDirection: "row", alignItems: "flex-end", gap: 8,
    backgroundColor: C.white, paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: C.gray200,
  },
  input: {
    flex: 1, maxHeight: 120, borderRadius: 20,
    backgroundColor: C.gray50, borderWidth: 1, borderColor: C.gray200,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: C.gray900,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: C.primary,
    alignItems: "center", justifyContent: "center",
  },
  sendBtnOff: { backgroundColor: C.gray300 },
  attachBtn: {
    width: 42, height: 42, alignItems: "center", justifyContent: "center",
  },

  pendingStrip: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    backgroundColor: C.white, paddingHorizontal: 12, paddingTop: 8,
  },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%",
    backgroundColor: C.primaryBg, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  chipText: { flexShrink: 1, fontSize: 12, color: C.gray700 },

  attachmentRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  attachmentName: { flexShrink: 1, fontSize: 12, textDecorationLine: "underline" },
});
