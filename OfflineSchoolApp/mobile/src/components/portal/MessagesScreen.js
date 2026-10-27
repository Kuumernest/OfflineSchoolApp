// src/components/portal/MessagesScreen.js
//
// Messages: the family's conversations, the school's notices about each
// child, and the school's news, one segment each with its unread count. For
// the whole family rather than one child: a notice says which child it is
// about. The phone's copy of web/src/pages/portal/MessagesScreen.tsx; a
// conversation opens in the phone's own thread screen (portal/messages/[id]).
//
// The lists are the shell's tab-tagged section (`data`), so one list's shape
// can never reach another's markup. The expressions the portal checks read
// (the empty states, the news map, the notice statuses) are written here.

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { formatDate } from "../../i18n/format";
import { conversationName } from "../../utils/participantName";
import { Card, Skeleton, EmptyState, ChildAvatar, said } from "./ui";
import { C, TAP } from "./theme";

export const MSG_VIEWS = ["messages", "notices", "news"];
const VIEW_LABEL = { messages: "tabMessages", notices: "tabNotices", news: "tabNews" };

// One row per notification kind the portal is allowed to show. Keyed on the
// kind the server sends, so a kind that is added server-side and not listed
// here falls back rather than rendering a blank card.
const NOTICE_META = {
  "gate.arrival":     { icon: "log-in-outline",       fg: C.success,  bg: C.successBg, labelKey: "portal.noticeArrival" },
  "gate.departure":   { icon: "log-out-outline",      fg: C.primary,  bg: C.primaryBg, labelKey: "portal.noticeDeparture" },
  "attendance.absent":{ icon: "alert-circle-outline", fg: C.danger,   bg: C.dangerBg,  labelKey: "portal.noticeAbsent" },
  "fee.reminder":     { icon: "wallet-outline",       fg: C.warning,  bg: C.warningBg, labelKey: "portal.noticeFeeReminder" },
  "fee.payment":      { icon: "receipt-outline",      fg: C.success,  bg: C.successBg, labelKey: "portal.noticePayment" },
  "result.published": { icon: "school-outline",       fg: C.primary,  bg: C.primaryBg, labelKey: "portal.noticeResults" },
  "announcement":     { icon: "megaphone-outline",    fg: C.primary,  bg: C.primaryBg, labelKey: "portal.noticeAnnouncement" },
  // Not a row in the Notification queue: derived by the server from threads
  // with something unread, so a message is not a message per message.
  "message":          { icon: "chatbubble-outline",   fg: C.primary,  bg: C.primaryBg, labelKey: "portal.noticeMessage" },
  default:            { icon: "notifications-outline", fg: C.inkMuted, bg: C.canvas,   labelKey: "portal.noticeOther" },
};

const nameOf = (family, id) =>
  id ? (family ?? []).find((c) => String(c._id) === String(id))?.name ?? null : null;

export default function MessagesScreen({ tab, onView, data, loading, me, markNotice, markAllNotices }) {
  const { t } = useTranslation();
  const router = useRouter();
  const family = me?.children ?? [];
  const many = family.length > 1;

  return (
    <View style={styles.stack}>
      <Text style={styles.h1} accessibilityRole="header">{t("portal.messages")}</Text>

      {/* Three lists, each with its count. Messages counts unread threads,
          Notices unread school notices: disjoint, so no number is shown twice. */}
      <View style={styles.segment} accessibilityRole="tablist" accessibilityLabel={t("portal.messages")}>
        {MSG_VIEWS.map((key) => {
          const label = t(`portal.messagesScreen.${VIEW_LABEL[key]}`);
          const unread =
            key === "messages" ? (me?.unreadMessages ?? 0) :
            key === "notices"  ? (me?.unreadNotices  ?? 0) : 0;
          const on = tab === key;
          return (
            <Pressable
              key={key}
              testID={`portal-msg-${key}`}
              style={[styles.segmentBtn, on && styles.segmentBtnOn]}
              onPress={() => onView(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={unread > 0 ? said(label, t("portal.unreadCount", { count: unread })) : label}
            >
              <Text style={[styles.segmentText, on && styles.segmentTextOn]} numberOfLines={1}>{label}</Text>
              {unread > 0 ? (
                <View style={[styles.count, on && styles.countOn]}>
                  <Text style={styles.countText}>{unread > 9 ? "9+" : unread}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {loading && !data ? <ListSkeleton /> : (
        <>
          {/* ── News ── */}
          {tab === "news" && (
            (data?.length ?? 0) === 0 ? (
              <Card><EmptyState icon="megaphone-outline" title={t("portal.noNews")} hint={t("portal.messagesScreen.noNewsHint")} /></Card>
            ) : (
              data.map((a) => {
                // Which of this parent's children it names, when it names any:
                // "bring PE kit on Thursday" needs to say whose Thursday.
                const about = (a.forStudents ?? []).map((id) => nameOf(family, id)).filter(Boolean);
                return (
                  <Card key={a._id} style={styles.newsCard}>
                    <View style={styles.newsRow}>
                      <View style={[styles.round, { backgroundColor: C.primaryBg }]}>
                        <Ionicons name="megaphone-outline" size={18} color={C.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.title}>{a.title || "—"}</Text>
                        <Text style={styles.meta}>
                          {formatDate(a.createdAt)}
                          {about.length ? ` · ${t("portal.messagesScreen.about", { names: about.join(", ") })}` : ""}
                        </Text>
                        {a.body ? <Text style={styles.body}>{a.body}</Text> : null}
                      </View>
                    </View>
                  </Card>
                );
              })
            )
          )}

          {/* ── Conversations ── */}
          {tab === "messages" && (
            <>
              <Pressable
                style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.9 }]}
                onPress={() => router.push("/portal/messages/new")}
                accessibilityRole="button"
              >
                <Ionicons name="create-outline" size={18} color="#FFFFFF" />
                <Text style={styles.newText}>{t("msgMobile.newMessage")}</Text>
              </Pressable>

              {(data ?? []).length === 0 ? (
                <Card><EmptyState icon="chatbubbles-outline" title={t("msgMobile.emptyTitle")} hint={t("portal.messagesScreen.noConversationsHint")} /></Card>
              ) : (
                <Card>
                  {(data ?? []).map((c, i) => {
                    // otherParticipants excludes this guardian: joining every
                    // participant showed a parent their own name over a
                    // message from the school.
                    const name = conversationName(c, c.otherParticipants || c.participants, t);
                    const n = c.unread ?? 0;
                    return (
                      <Pressable
                        key={c._id}
                        style={({ pressed }) => [styles.row, i > 0 && styles.rowLine, pressed && { backgroundColor: C.canvas }]}
                        onPress={() => router.push(`/portal/messages/${c._id}`)}
                        accessibilityRole="button"
                        accessibilityLabel={n > 0 ? said(name, t("portal.unreadCount", { count: n })) : name}
                      >
                        <ChildAvatar name={name} index={i} size={40} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={styles.rowHead}>
                            <Text style={[styles.title, { flex: 1 }, n > 0 && { fontWeight: "800" }]} numberOfLines={1}>{name}</Text>
                            {c.lastMessageAt ? <Text style={styles.date}>{formatDate(c.lastMessageAt)}</Text> : null}
                          </View>
                          <View style={styles.rowHead}>
                            <Text style={[styles.preview, n > 0 && { color: C.ink }]} numberOfLines={1}>
                              {c.lastMessagePreview || t("portal.noMessages")}
                            </Text>
                            {n > 0 ? (
                              <View style={[styles.count, styles.countOn, { backgroundColor: C.primary }]}>
                                <Text style={styles.countText}>{n}</Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </Card>
              )}
            </>
          )}

          {/* ── Notices ── what the school has already sent by email or SMS. */}
          {tab === "notices" && (data?.length ?? 0) > 0 && (me?.unreadNotices ?? 0) > 0 && (
            <Pressable style={styles.markAll} onPress={markAllNotices} accessibilityRole="button">
              <Ionicons name="checkmark-done-outline" size={17} color={C.primary} />
              <Text style={styles.markAllText}>{t("portal.markAllRead")}</Text>
            </Pressable>
          )}

          {tab === "notices" && (
            (data?.length ?? 0) === 0 ? (
              <Card><EmptyState icon="notifications-outline" title={t("portal.noNotices")} hint={t("portal.messagesScreen.noNoticesHint")} /></Card>
            ) : (
              <Card>
                {data.map((n, i) => {
                  const meta = NOTICE_META[n.kind] ?? NOTICE_META.default;
                  // Whose notice it is: the list covers every child, so an
                  // absence needs a name against it when there are two.
                  const about = many ? nameOf(family, n.studentId) : null;
                  // Tapping is what marks a notice read; a message notice
                  // also opens its thread. Thread rows carry no `read` of
                  // their own: opening the thread clears them.
                  const isNotice = !n.conversationId;
                  const unreadCard = isNotice && n.read === false;
                  const isNew = unreadCard || (n.unread ?? 0) > 0;
                  return (
                    <Pressable
                      key={n._id}
                      style={({ pressed }) => [styles.notice, i > 0 && styles.rowLine, unreadCard && styles.cardUnread, pressed && { backgroundColor: C.canvas }]}
                      onPress={() => {
                        if (n.conversationId) {
                          router.push(`/portal/messages/${n.conversationId}`);
                          return;
                        }
                        if (unreadCard) markNotice(n._id);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={said(t(meta.labelKey), unreadCard ? t("portal.unreadNotice") : null, n.subject, about)}
                    >
                      {/* On the unread tint a tinted circle would vanish. */}
                      <View style={[styles.round, { backgroundColor: unreadCard && meta.bg === C.primaryBg ? C.surface : meta.bg }]}>
                        <Ionicons name={meta.icon} size={18} color={meta.fg} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={styles.rowHead}>
                          <Text style={styles.kind} numberOfLines={1}>{t(meta.labelKey)}</Text>
                          {/* A dot rather than a number for a notice: there is
                              only ever one of it. A thread row has a count. */}
                          {unreadCard ? <View style={styles.unreadDot} /> : null}
                          {(n.unread ?? 0) > 0 ? (
                            <View style={[styles.count, styles.countOn, { backgroundColor: C.primary }]}>
                              <Text style={styles.countText}>{n.unread}</Text>
                            </View>
                          ) : null}
                          <Text style={[styles.date, { marginLeft: "auto" }]}>{formatDate(n.sentAt || n.createdAt)}</Text>
                        </View>
                        {n.subject ? <Text style={[styles.title, isNew && { fontWeight: "800" }]}>{n.subject}</Text> : null}
                        {n.body ? <Text style={styles.body} numberOfLines={3}>{n.body}</Text> : null}
                        {about ? <Text style={styles.meta}>{t("portal.messagesScreen.about", { names: about })}</Text> : null}
                        {/* Only while the school is still trying, or has
                            failed. A skipped notice is one the school never
                            tried to send, and has no wording. */}
                        {n.status === "pending" || n.status === "failed" ? (
                          <Text style={[styles.status, n.status === "failed" && { color: C.danger, backgroundColor: C.dangerBg }]}>
                            {t(`portal.noticeStatus_${n.status}`)}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </Card>
            )
          )}
        </>
      )}
    </View>
  );
}

function ListSkeleton() {
  return (
    <Card>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.row, i > 0 && styles.rowLine]}>
          <Skeleton width={40} height={40} radius={20} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={110} height={12} /><Skeleton width={200} height={14} /><Skeleton height={12} />
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  h1:    { fontSize: 22, fontWeight: "700", color: C.ink },

  segment: {
    flexDirection: "row", gap: 4, padding: 4, borderRadius: 14,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
  },
  segmentBtn: {
    flex: 1, minHeight: TAP, borderRadius: 10, paddingHorizontal: 4,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  segmentBtnOn:  { backgroundColor: C.primary },
  segmentText:   { flexShrink: 1, fontSize: 13, fontWeight: "600", color: C.inkBody },
  segmentTextOn: { color: "#FFFFFF" },
  count: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
    backgroundColor: C.danger, alignItems: "center", justifyContent: "center",
  },
  countOn:   { backgroundColor: "rgba(255,255,255,0.28)" },
  countText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },

  newBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    minHeight: TAP + 4, borderRadius: 12, backgroundColor: C.primary,
  },
  newText: { fontSize: 15, fontWeight: "700", color: "#FFFFFF" },

  row:     { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 68, paddingHorizontal: 16, paddingVertical: 12 },
  rowLine: { borderTopWidth: 1, borderTopColor: C.line },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  title:   { fontSize: 14, fontWeight: "600", color: C.ink },
  preview: { flex: 1, marginTop: 2, fontSize: 13, color: C.inkMuted },
  date:    { fontSize: 12, color: C.inkFaint },
  meta:    { marginTop: 3, fontSize: 12, color: C.inkMuted },
  body:    { marginTop: 4, fontSize: 13, color: C.inkBody, lineHeight: 19 },

  round: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },

  newsCard: { padding: 16 },
  newsRow:  { flexDirection: "row", gap: 12 },

  notice: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  kind:   { flexShrink: 1, fontSize: 12, fontWeight: "700", color: C.inkMuted },
  status: {
    alignSelf: "flex-start", marginTop: 6, fontSize: 12, fontWeight: "600", color: C.warning,
    backgroundColor: C.warningBg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden",
  },
  // An unread notice: a tinted edge and a dot by the kind. Colour is not
  // carrying this alone; the dot is a second cue.
  cardUnread: { borderLeftWidth: 3, borderLeftColor: C.primary, backgroundColor: C.primaryBg },
  unreadDot:  { width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary },

  markAll: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, alignSelf: "flex-end",
    minHeight: TAP, paddingHorizontal: 12, borderRadius: 10,
  },
  markAllText: { fontSize: 14, fontWeight: "600", color: C.primary },
});
