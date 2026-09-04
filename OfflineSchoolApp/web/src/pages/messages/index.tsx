// web/src/pages/messages/index.tsx
//
// Messaging: the conversation list beside the open thread.
//
// Two things here are load-bearing rather than cosmetic.
//
// Messages are ordered by `seq`, the number the server assigns, and never by
// any timestamp. Senders on the mobile app compose offline on phones whose
// clocks are frequently wrong, so sorting by a client time would show two
// readers the same conversation in two different orders.
//
// A 403 from the server carries a plain reason — "this school has not
// enabled student-to-student messaging" — and that reason is shown verbatim.
// It usually describes a setting somebody can change rather than a fault.

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Send, Loader2, AlertCircle, Users, Hash, Trash2,
  Plus, Search, X, Paperclip,
} from "lucide-react";

import {
  fetchConversations,
  fetchMessages,
  sendMessage,
  markRead,
  deleteMessage,
  fetchRecipients,
  openDirect,
  uploadAttachment,
  type Conversation,
  type Message,
  type Recipient,
  type Attachment,
  type ParticipantReadState,
} from "@/services/message.service";
import { useUser } from "@/store/auth.store";
import { useTranslation } from "react-i18next";

import { cn } from "@/utils/cn";

// ─────────────────────────────────────────────────────────────────────────────

const errorText = (err: unknown, t: (key: string) => string): string => {
  const res = (err as { response?: { data?: { error?: string; message?: string } } })
    ?.response?.data;
  return (
    res?.error ?? res?.message ?? (err as Error)?.message ?? t("messages.genericError")
  );
};

const timeLabel = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** Direct threads have no title; they are named for the other person. */
const titleFor = (
  c: Conversation,
  myId: string,
  t: (key: string) => string,
): string => {
  if (c.title) return c.title;
  const other = c.participants?.find((p) => String(p.id) !== String(myId));
  return other?.name || t("messages.conversation");
};

const KindIcon = ({ kind }: { kind: Conversation["kind"] }) => {
  if (kind === "group")  return <Users size={14} className="text-gray-400" />;
  if (kind === "class" || kind === "subject") return <Hash size={14} className="text-gray-400" />;
  return <MessageSquare size={14} className="text-gray-400" />;
};

/**
 * WhatsApp-style read receipt checkmarks for a sent message.
 *
 *   ✓       sent (message has a seq, server has it)
 *   ✓✓      delivered (recipient's lastDeliveredSeq >= msg.seq)
 *   ✓✓ blue  read (recipient's lastReadSeq >= msg.seq)
 *
 * Only meaningful in direct (2-person) conversations. In groups, showing
 * "read by N" is a separate feature.
 */
function ReadReceipt({
  msg,
  myId,
  participants,
  conversationKind,
}: {
  msg:           Message;
  myId:          string;
  participants:  ParticipantReadState[];
  conversationKind: Conversation["kind"];
}) {
  // Only show on messages sent by me.
  if (String(msg.sender?.id) !== myId) return null;
  // Only meaningful in direct threads for now.
  if (conversationKind !== "direct") return null;
  // Queued messages (no seq yet) have their own state mark.
  if (msg.seq == null) return null;

  // Find the other participant's read state: anyone who is not me.
  //
  // The kind === "user" this replaces quietly excluded a guardian, so on a
  // parent thread — a direct thread like any other — no receipt rendered at
  // all. This caller signs in as staff, so only a user row can be me.
  const other = participants.find(
    (p) => !(p.kind === "user" && String(p.id) === String(myId)),
  );
  if (!other) return null;

  const isRead      = other.lastReadSeq      >= msg.seq;
  const isDelivered = other.lastDeliveredSeq >= msg.seq;

  // Read = blue double check, delivered = gray double check, sent = gray single check.
  if (isRead) {
    return (
      <svg viewBox="0 0 16 11" width="16" height="11" className="inline-block ml-0.5">
        <path d="M11.07.67l.71.71L5.12 8.04l-2.83-2.83-.71.71L5.12 9.46l7.22-7.22-.27-.57z"
              fill="#3B82F6" />
        <path d="M8.07.67l.71.71L2.12 8.04l-.71-.71L8.07.67z"
              fill="#3B82F6" />
      </svg>
    );
  }
  if (isDelivered) {
    return (
      <svg viewBox="0 0 16 11" width="16" height="11" className="inline-block ml-0.5">
        <path d="M11.07.67l.71.71L5.12 8.04l-2.83-2.83-.71.71L5.12 9.46l7.22-7.22-.27-.57z"
              fill="#9CA3AF" />
        <path d="M8.07.67l.71.71L2.12 8.04l-.71-.71L8.07.67z"
              fill="#9CA3AF" />
      </svg>
    );
  }
  // Sent (single check).
  return (
    <svg viewBox="0 0 10 8" width="10" height="8" className="inline-block ml-0.5">
      <path d="M3.5 7.3L.2 4l-.7.7L3.5 8.7l7-7L9.8 1z" fill="#9CA3AF" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MessagesPage() {
  const { t } = useTranslation();
  const user   = useUser();
  const myId   = String(user?._id ?? "");
  const client = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft,    setDraft]    = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // Uploaded, not yet sent. Held here so a file can be attached before the
  // message it belongs to has been written.
  const [pending,   setPending]   = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  // ── Conversations ─────────────────────────────────────────────────────────

  const conversationsQuery = useQuery<Conversation[], Error>({
    queryKey: ["conversations"],
    queryFn:  fetchConversations,
    // Polled rather than pushed: there is no socket layer here, and a stale
    // thread list is a worse failure than a little extra traffic on a desk.
    refetchInterval: 20_000,
  });

  const conversations = conversationsQuery.data ?? [];

  // Open the first thread once, so the pane is not empty on arrival.
  useEffect(() => {
    if (!activeId && conversations.length) setActiveId(conversations[0]._id);
  }, [conversations, activeId]);

  const active = useMemo(
    () => conversations.find((c) => c._id === activeId) ?? null,
    [conversations, activeId],
  );

  // ── Messages ──────────────────────────────────────────────────────────────

  const messagesQuery = useQuery<{ messages: Message[]; participantReads: ParticipantReadState[] }, Error>({
    queryKey: ["messages", activeId],
    queryFn:  () => fetchMessages(activeId as string, { limit: 100 }),
    enabled:  Boolean(activeId),
    refetchInterval: 10_000,
  });

  // The server returns newest first; a thread reads oldest at the top.
  // Sorted by seq — see the header note.
  const messages = useMemo(
    () => [...(messagesQuery.data?.messages ?? [])].sort((a, b) => a.seq - b.seq),
    [messagesQuery.data],
  );

  const participantReads = useMemo(
    () => messagesQuery.data?.participantReads ?? [],
    [messagesQuery.data],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeId]);

  // Advance the read marker to whatever is now on screen.
  useEffect(() => {
    if (!activeId || !messages.length) return;
    const newest = messages[messages.length - 1].seq;
    markRead(activeId, newest)
      .then(() => client.invalidateQueries({ queryKey: ["conversations"] }))
      .catch(() => { /* a read receipt failing is not worth interrupting anyone */ });
  }, [activeId, messages, client]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const sendMutation = useMutation({
    mutationFn: (payload: { body: string; attachments: Attachment[] }) =>
      sendMessage(activeId as string, payload),
    onSuccess: () => {
      setDraft("");
      setPending([]);
      setSendError(null);
      client.invalidateQueries({ queryKey: ["messages", activeId] });
      client.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => setSendError(errorText(err, t)),
  });

  const handleSend = useCallback(() => {
    const body = draft.trim();
    // An attachment on its own is a message; text is not required.
    if ((!body && pending.length === 0) || !activeId || sendMutation.isPending) return;
    sendMutation.mutate({ body, attachments: pending });
  }, [draft, pending, activeId, sendMutation]);

  const handleAttach = useCallback(async (file: File | undefined) => {
    if (!file || !activeId) return;
    setAttaching(true);
    setSendError(null);
    try {
      const uploaded = await uploadAttachment(activeId, file);
      setPending((p) => [...p, uploaded]);
    } catch (err) {
      setSendError(errorText(err, t));
    } finally {
      setAttaching(false);
      // Reset the input so choosing the same file twice still fires onChange.
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [activeId]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMessage(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["messages", activeId] }),
    onError: (err) => setSendError(errorText(err, t)),
  });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-gray-200
                      bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("messages.title")}</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {t("messages.blurb")}
          </p>
        </div>
        <button
          onClick={() => setComposing(true)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2
                     text-sm font-semibold text-white transition-colors
                     hover:bg-blue-700"
        >
          <Plus size={16} />
          {t("messages.newConversation")}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">

        {/* ── Conversation list ──────────────────────────────────────────── */}
        <aside className="w-72 shrink-0 border-r border-gray-200 bg-white overflow-y-auto">
          {conversationsQuery.isLoading && (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="animate-spin text-blue-600" />
            </div>
          )}

          {conversationsQuery.isError && (
            <div className="m-3 flex items-start gap-2 rounded-lg bg-red-50
                            border border-red-200 p-3 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{errorText(conversationsQuery.error, t)}</span>
            </div>
          )}

          {!conversationsQuery.isLoading && conversations.length === 0 && (
            <div className="p-6 text-center text-sm text-gray-500">
              {t("messages.noneYet")}
            </div>
          )}

          {conversations.map((c) => (
            <button
              key={c._id}
              onClick={() => { setActiveId(c._id); setSendError(null); }}
              className={cn(
                "w-full text-left px-4 py-3 border-b border-gray-100",
                "hover:bg-gray-50 transition-colors",
                c._id === activeId && "bg-blue-50 hover:bg-blue-50",
              )}
            >
              <div className="flex items-center gap-2">
                <KindIcon kind={c.kind} />
                <span className="flex-1 truncate text-sm font-semibold text-gray-900">
                  {titleFor(c, myId, t)}
                </span>
                {Boolean(c.unread) && (
                  <span className="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5
                                   text-[10px] font-bold text-white">
                    {c.unread}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-gray-500">
                  {c.lastMessagePreview || t("messages.noMessagesYet")}
                </span>
                <span className="shrink-0 text-[10px] text-gray-400">
                  {timeLabel(c.lastMessageAt)}
                </span>
              </div>
            </button>
          ))}
        </aside>

        {/* ── Thread ─────────────────────────────────────────────────────── */}
        <section className="flex flex-1 flex-col min-w-0 bg-gray-50">
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              {t("messages.selectOne")}
            </div>
          ) : (
            <>
              <header className="border-b border-gray-200 bg-white px-5 py-3">
                <div className="flex items-center gap-2">
                  <KindIcon kind={active.kind} />
                  <h2 className="font-semibold text-gray-900">
                    {titleFor(active, myId, t)}
                  </h2>
                  {active.isReadOnly && (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-[10px]
                                     font-semibold text-gray-600">
                      {t("messages.readOnly")}
                    </span>
                  )}
                </div>
                {active.kind !== "direct" && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {active.participants?.length ?? 0} participants
                  </p>
                )}
              </header>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {messagesQuery.isLoading && (
                  <div className="flex justify-center py-8">
                    <Loader2 size={20} className="animate-spin text-blue-600" />
                  </div>
                )}

                {messages.map((m) => {
                  const mine = String(m.sender?.id) === myId;
                  return (
                    <div
                      key={m._id}
                      className={cn("flex", mine ? "justify-end" : "justify-start")}
                    >
                      <div
                        className={cn(
                          "group max-w-[70%] rounded-2xl px-3.5 py-2 text-sm",
                          m.isDeleted
                            ? "bg-gray-100 text-gray-400 italic"
                            : mine
                              ? "bg-blue-600 text-white"
                              : "bg-white text-gray-900 border border-gray-200",
                        )}
                      >
                        {!mine && !m.isDeleted && (
                          <div className="mb-0.5 text-[11px] font-semibold text-gray-500">
                            {m.sender?.name || t("messages.unknownSender")}
                          </div>
                        )}

                        <div className="whitespace-pre-wrap break-words">
                          {m.isDeleted ? t("messages.deleted") : m.body}
                        </div>

                        {!m.isDeleted && (m.attachments?.length ?? 0) > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {m.attachments.map((a) => (
                              <li key={a.url}>
                                <a
                                  href={a.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={cn(
                                    "text-xs underline",
                                    mine ? "text-blue-100" : "text-blue-600",
                                  )}
                                >
                                  {a.name || a.url.split("/").pop()}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div
                          className={cn(
                            "mt-1 flex items-center gap-2 text-[10px]",
                            mine ? "text-blue-100" : "text-gray-400",
                          )}
                        >
                          <span>{timeLabel(m.createdAt)}</span>
                          {mine && !m.isDeleted && (
                            <ReadReceipt
                              msg={m}
                              myId={myId}
                              participants={participantReads}
                              conversationKind={active.kind}
                            />
                          )}
                          {mine && !m.isDeleted && (
                            <button
                              onClick={() => deleteMutation.mutate(m._id)}
                              className="opacity-0 transition-opacity group-hover:opacity-100"
                              title={t("messages.deleteMessage")}
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div ref={bottomRef} />
              </div>

              {sendError && (
                <div className="flex items-start gap-2 border-t border-red-200
                                bg-red-50 px-5 py-2 text-sm text-red-700">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span className="flex-1">{sendError}</span>
                  <button
                    onClick={() => setSendError(null)}
                    className="font-bold text-red-500 hover:text-red-700"
                  >
                    ✕
                  </button>
                </div>
              )}

              {!active.isReadOnly && (
                <div className="border-t border-gray-200 bg-white px-5 py-3">
                  {pending.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {pending.map((a, i) => (
                        <span
                          key={a.url}
                          className="flex max-w-full items-center gap-1.5 rounded-full
                                     bg-blue-50 px-2.5 py-1 text-xs text-gray-700"
                        >
                          <Paperclip size={12} className="shrink-0 text-blue-600" />
                          <span className="truncate">{a.name || "attachment"}</span>
                          <button
                            onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                            className="shrink-0 text-gray-400 hover:text-gray-600"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => handleAttach(e.target.files?.[0])}
                    />
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={attaching || sendMutation.isPending}
                      title={t("messages.attach")}
                      className="flex h-[42px] w-[42px] shrink-0 items-center justify-center
                                 rounded-xl text-gray-500 transition-colors
                                 hover:bg-gray-100 disabled:opacity-50"
                    >
                      {attaching
                        ? <Loader2 size={17} className="animate-spin" />
                        : <Paperclip size={17} />}
                    </button>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter sends; Shift+Enter is a newline.
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      rows={1}
                      placeholder={t("messages.writePh")}
                      className="flex-1 resize-none rounded-xl border-2 border-gray-200
                                 bg-gray-50 px-3 py-2.5 text-sm outline-none
                                 transition-colors focus:border-blue-500 focus:bg-white"
                    />
                    <button
                      onClick={handleSend}
                      disabled={
                        (!draft.trim() && pending.length === 0) ||
                        sendMutation.isPending
                      }
                      className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5
                                 text-sm font-semibold text-white transition-colors
                                 hover:bg-blue-700 disabled:opacity-50"
                    >
                      {sendMutation.isPending
                        ? <Loader2 size={15} className="animate-spin" />
                        : <Send size={15} />}
                      Send
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {composing && (
        <NewConversationModal
          onClose={() => setComposing(false)}
          onOpened={(c) => {
            setComposing(false);
            setActiveId(c._id);
            client.invalidateQueries({ queryKey: ["conversations"] });
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW CONVERSATION
//
// The list of people comes from the server, which filters it through the same
// policy the send path uses. Nothing here decides who is reachable — offering
// somebody the server would then refuse is worse than offering nobody.
// ─────────────────────────────────────────────────────────────────────────────

function NewConversationModal({
  onClose,
  onOpened,
}: {
  onClose:  () => void;
  onOpened: (c: Conversation) => void;
}) {
  const { t } = useTranslation();
  const [q,       setQ]       = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  // Debounced so a fast typist does not fire a request per keystroke.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const recipientsQuery = useQuery<Recipient[], Error>({
    queryKey: ["recipients", debounced],
    queryFn:  () => fetchRecipients(debounced),
  });

  const handlePick = async (r: Recipient) => {
    setOpening(r.kind + ":" + r.id);
    setError(null);
    try {
      onOpened(await openDirect(r.id, r.kind));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setOpening(null);
    }
  };

  const recipients = recipientsQuery.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden
                   rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 className="font-bold text-gray-900">{t("messages.newConversation")}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-gray-100 px-5 py-3">
          <div className="flex items-center gap-2 rounded-xl border-2 border-gray-200
                          bg-gray-50 px-3 py-2 focus-within:border-blue-500
                          focus-within:bg-white">
            <Search size={15} className="text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("messages.searchPh")}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 px-5 py-2 text-sm text-red-700">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {recipientsQuery.isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-blue-600" />
            </div>
          )}

          {!recipientsQuery.isLoading && recipients.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-gray-500">
              {debounced
                ? t("messages.noMatch")
                : t("messages.nobodyAvailable")}
            </p>
          )}

          {recipients.map((r) => {
            const key = r.kind + ":" + r.id;
            return (
              <button
                key={key}
                onClick={() => handlePick(r)}
                disabled={opening !== null}
                className="flex w-full items-center gap-3 border-b border-gray-50
                           px-5 py-3 text-left transition-colors hover:bg-gray-50
                           disabled:opacity-50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center
                                rounded-full bg-blue-50 text-xs font-bold text-blue-600">
                  {(r.name || "?").slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-gray-900">
                    {r.name}
                  </div>
                  {r.subtitle && (
                    <div className="truncate text-xs text-gray-500">{r.subtitle}</div>
                  )}
                </div>
                {opening === key && (
                  <Loader2 size={15} className="animate-spin text-blue-600" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
