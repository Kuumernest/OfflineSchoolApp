// web/src/services/message.service.ts
"use strict";

/**
 * Messaging client.
 *
 * The web app is used on a desk with a connection, so unlike the mobile
 * client there is no local store and no outbox — a send either succeeds or
 * reports why it did not. It talks to the same endpoints and obeys the same
 * server-side policy; nothing here decides who may message whom.
 */

import api from "@/services/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PrincipalKind = "user" | "guardian";
export type ConversationKind = "direct" | "class" | "subject" | "group";

export interface Participant {
  kind:              PrincipalKind;
  id:                string;
  name?:             string | null;
  role?:             string | null;
  lastReadSeq?:      number;
  lastDeliveredSeq?: number;
  leftAt?:           string | null;
}

export interface Conversation {
  _id:                 string;
  kind:                ConversationKind;
  title?:              string | null;
  classId?:            string | null;
  subjectId?:          string | null;
  participants:        Participant[];
  lastMessageAt?:      string | null;
  lastMessageSeq?:     number;
  lastMessagePreview?: string | null;
  lastMessageSender?:  string | null;
  isArchived?:         boolean;
  isReadOnly?:         boolean;
  unread?:             number;
}

export interface Attachment {
  kind:      "image" | "document" | "audio" | "video";
  url:       string;
  name?:     string | null;
  mimeType?: string | null;
  size?:     number | null;
  duration?: number | null;
}

export interface Message {
  _id:             string;
  conversationId:  string;
  /** Server-assigned order. The only key worth sorting by. */
  seq:             number;
  sender:          { kind: PrincipalKind; id: string; name?: string | null; role?: string | null };
  body:            string | null;
  attachments:     Attachment[];
  replyTo?:        string | null;
  systemEvent?:    string | null;
  reactions?:      { key: string; kind: PrincipalKind; by: string; at: string }[];
  deviceCreatedAt?: string | null;
  createdAt:       string;
  editedAt?:       string | null;
  isDeleted?:      boolean;
}

/** Per-participant read/delivered state for a conversation. */
export interface ParticipantReadState {
  kind:             PrincipalKind;
  id:               string;
  lastReadSeq:      number;
  lastDeliveredSeq: number;
}

/** Somebody this caller is permitted to start a conversation with. */
export interface Recipient {
  kind:      PrincipalKind;
  id:        string;
  name:      string;
  role?:     string | null;
  subtitle?: string | null;
}

// ─── Recipients ───────────────────────────────────────────────────────────────

/**
 * Who may I write to?
 *
 * Always ask the server. It knows the school's settings and the guardian
 * links; a picker built from a guessed rule would offer people the send path
 * then refuses.
 */
export async function fetchRecipients(
  q = "",
  limit = 40,
): Promise<Recipient[]> {
  const { data } = await api.get("/messages/recipients", { params: { q, limit } });
  return data?.recipients ?? [];
}

// ─── Conversations ────────────────────────────────────────────────────────────

export async function fetchConversations(): Promise<Conversation[]> {
  const { data } = await api.get("/messages/conversations");
  return data?.conversations ?? [];
}

export async function fetchConversation(id: string): Promise<Conversation | null> {
  const { data } = await api.get(`/messages/conversations/${id}`);
  return data?.conversation ?? null;
}

/**
 * Open, or reuse, the thread with one person.
 *
 * The server refuses with 403 and a plain reason when the school's matrix
 * forbids it — surface that reason rather than a generic failure, because
 * "this school has not enabled student-to-student messaging" is a setting
 * somebody can change, not a bug.
 */
export async function openDirect(
  id: string,
  kind: PrincipalKind = "user",
): Promise<Conversation> {
  const { data } = await api.post("/messages/conversations/direct", { id, kind });
  return data.conversation;
}

// Channels are not created from the client.
//
// A class IS a group: the server provisions the conversation for it on demand
// and reconciles its membership against the register, so there is no
// hand-built channel to drift out of step with who is actually in the class.

// ─── Attachments ──────────────────────────────────────────────────────────────

/**
 * Upload one file and get back the metadata to send with a message.
 *
 * Two steps rather than a single multipart send, so the same endpoint serves
 * the mobile client, whose outbox carries JSON and retries it — a retried
 * multipart upload would leave orphaned copies on the server.
 */
export async function uploadAttachment(
  conversationId: string,
  file: File,
): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);

  const { data } = await api.post(
    `/messages/conversations/${conversationId}/attachments`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data.attachment;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** Newest first, as the server returns them. */
export async function fetchMessages(
  conversationId: string,
  opts: { limit?: number; beforeSeq?: number } = {},
): Promise<{ messages: Message[]; participantReads: ParticipantReadState[] }> {
  const { data } = await api.get(
    `/messages/conversations/${conversationId}/messages`,
    { params: { limit: opts.limit, beforeSeq: opts.beforeSeq } },
  );
  return {
    messages:        data?.messages ?? [],
    participantReads: data?.participantReads ?? [],
  };
}

export async function sendMessage(
  conversationId: string,
  payload: {
    body?:        string;
    attachments?: Attachment[];
    replyTo?:     string | null;
    /** Supply to make a retry idempotent rather than posting twice. */
    clientId?:    string;
  },
): Promise<{ message: Message; duplicate: boolean }> {
  const { data } = await api.post(
    `/messages/conversations/${conversationId}/messages`,
    payload,
  );
  return { message: data.message, duplicate: Boolean(data.duplicate) };
}

/** Move this reader's marker. Safe to call often — the server takes the max. */
export async function markRead(
  conversationId: string,
  seq: number,
): Promise<void> {
  await api.post(`/messages/conversations/${conversationId}/read`, { seq });
}

export async function deleteMessage(messageId: string): Promise<void> {
  await api.delete(`/messages/${messageId}`);
}

/** Toggles: sending the same key again removes it. */
export async function toggleReaction(
  messageId: string,
  key: string,
): Promise<Message["reactions"]> {
  const { data } = await api.post(`/messages/${messageId}/reactions`, { key });
  return data?.reactions ?? [];
}

// ─── Administration ───────────────────────────────────────────────────────────

/**
 * Find conversations across the school. Administrators only.
 *
 * Returns metadata, never message bodies — reading those is a second,
 * separately logged request. A safeguarding question starts here.
 */
export async function auditConversations(params: {
  participantId?:    string;
  kind?:             PrincipalKind;
  conversationKind?: ConversationKind;
  limit?:            number;
} = {}): Promise<Conversation[]> {
  const { data } = await api.get("/messages/audit/conversations", { params });
  return data?.conversations ?? [];
}

export default {
  fetchRecipients,
  fetchConversations,
  fetchConversation,
  openDirect,
  uploadAttachment,
  fetchMessages,
  sendMessage,
  markRead,
  deleteMessage,
  toggleReaction,
  auditConversations,
};

export type { ParticipantReadState as ParticipantRead };
