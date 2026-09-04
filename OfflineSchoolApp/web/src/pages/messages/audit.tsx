// web/src/pages/messages/audit.tsx
//
// Message audit, for administrators.
//
// This screen exists because a safeguarding question starts with "what has
// this pupil been sending" and has to be answerable. It is deliberately not
// comfortable to use: you search for a person, you see the threads they are
// in, and reading one is a separate click that the server logs.
//
// Two properties are load-bearing:
//
//   - The list returns metadata only. No message bodies appear until an
//     administrator explicitly opens a thread.
//   - Opening a thread is recorded server-side as an audit read. Being able
//     to look is not the same as looking unobserved.
//
// A school can switch auditing off entirely, in which case every request here
// is refused and the screen says so rather than pretending to be empty.

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldAlert, Search, Loader2, AlertCircle, ArrowLeft, Eye,
} from "lucide-react";

import {
  auditConversations,
  fetchMessages,
  type Conversation,
  type Message,
} from "@/services/message.service";
import { useUser } from "@/store/auth.store";
import { useTranslation } from "react-i18next";

import { cn } from "@/utils/cn";

// ─────────────────────────────────────────────────────────────────────────────

const errorText = (err: unknown, t: (key: string) => string): string => {
  const res = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return res?.error ?? (err as Error)?.message ?? t("messages.genericError");
};

const stamp = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];

// ─────────────────────────────────────────────────────────────────────────────

export default function MessageAuditPage() {
  const { t }   = useTranslation();
  const user    = useUser();
  const isAdmin = ADMIN_ROLES.includes(String(user?.role ?? ""));

  const [participantId, setParticipantId] = useState("");
  const [submitted,     setSubmitted]     = useState("");
  const [opened,        setOpened]        = useState<Conversation | null>(null);

  const listQuery = useQuery<Conversation[], Error>({
    queryKey: ["audit-conversations", submitted],
    queryFn:  () => auditConversations(
      submitted ? { participantId: submitted } : {},
    ),
    enabled:  isAdmin,
  });

  const threadQuery = useQuery<Message[], Error>({
    queryKey: ["audit-thread", opened?._id],
    // .messages, because fetchMessages now returns the per-participant read
    // states alongside them for the checkmarks in the main thread view. This
    // page is the compliance read and wants the messages only — spreading the
    // whole object threw "not iterable" the moment a thread was opened.
    queryFn:  async () =>
      (await fetchMessages(opened!._id, { limit: 200 })).messages,
    enabled:  Boolean(opened),
  });

  const submit = useCallback(() => setSubmitted(participantId.trim()), [participantId]);

  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex max-w-sm items-start gap-3 rounded-xl border
                        border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <span>{t("messages.audit.adminOnly")}</span>
        </div>
      </div>
    );
  }

  // ── A single thread, opened deliberately ──────────────────────────────────
  if (opened) {
    const messages = [...(threadQuery.data ?? [])].sort((a, b) => a.seq - b.seq);

    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-4">
          <button
            onClick={() => setOpened(null)}
            className="text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-bold text-gray-900">
              {opened.title || `${opened.kind} conversation`}
            </h1>
            <p className="text-xs text-gray-500">
              {opened.participants?.length ?? 0} participants · opened as an audit
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 border-b border-amber-200
                        bg-amber-50 px-6 py-2 text-xs text-amber-800">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            {t("messages.auditNotice")}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-4">
          {threadQuery.isLoading && (
            <div className="flex justify-center py-10">
              <Loader2 size={20} className="animate-spin text-blue-600" />
            </div>
          )}

          {threadQuery.isError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200
                            bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{errorText(threadQuery.error, t)}</span>
            </div>
          )}

          <table className="w-full border-collapse overflow-hidden rounded-xl bg-white text-sm">
            <thead>
              <tr className="bg-gray-100 text-left text-xs uppercase text-gray-600">
                <th className="px-3 py-2 w-14">{t("messages.audit.seq")}</th>
                <th className="px-3 py-2 w-48">{t("messages.audit.sender")}</th>
                <th className="px-3 py-2 w-40">{t("messages.audit.sent")}</th>
                <th className="px-3 py-2">{t("messages.audit.message")}</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr
                  key={m._id}
                  className={cn(
                    "border-t border-gray-100 align-top",
                    m.isDeleted && "bg-red-50/40",
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs text-gray-400">{m.seq}</td>
                  <td className="px-3 py-2">
                    <div className="font-semibold text-gray-900">
                      {m.sender?.name || t("messages.unknownSender")}
                    </div>
                    <div className="text-xs text-gray-500">
                      {m.sender?.role || m.sender?.kind}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {stamp(m.createdAt)}
                    {/* What the sender's own clock said, when it disagreed.
                        Useful in an audit: it shows a message was composed
                        long before it reached the server. */}
                    {m.deviceCreatedAt &&
                      new Date(m.deviceCreatedAt).toDateString() !==
                        new Date(m.createdAt).toDateString() && (
                        <div className="text-amber-700">
                          composed {stamp(m.deviceCreatedAt)}
                        </div>
                      )}
                  </td>
                  <td className="px-3 py-2 text-gray-800">
                    {m.isDeleted && (
                      <span className="mr-2 rounded bg-red-100 px-1.5 py-0.5
                                       text-[10px] font-bold text-red-700">
                        {t("messages.audit.deleted")}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap break-words">
                      {m.body || (
                        <span className="text-gray-400">
                          {t("messages.audit.noText")}
                        </span>
                      )}
                    </span>
                    {(m.attachments?.length ?? 0) > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {m.attachments.map((a) => (
                          <li key={a.url} className="text-xs">
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 underline"
                            >
                              {a.name || a.url.split("/").pop()}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
              {!threadQuery.isLoading && messages.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-gray-500">
                    {t("messages.audit.noMessages")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── Search ────────────────────────────────────────────────────────────────
  const rows = listQuery.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">{t("messages.audit.title")}</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          {t("messages.audit.blurb")}
        </p>
      </div>

      <div className="border-b border-gray-100 bg-white px-6 py-3">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-xl border-2
                          border-gray-200 bg-gray-50 px-3 py-2
                          focus-within:border-blue-500 focus-within:bg-white">
            <Search size={15} className="text-gray-400" />
            <input
              value={participantId}
              onChange={(e) => setParticipantId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder={t("messages.audit.participantPh")}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <button
            onClick={submit}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold
                       text-white transition-colors hover:bg-blue-700"
          >
            {t("common.search")}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {listQuery.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 size={22} className="animate-spin text-blue-600" />
          </div>
        )}

        {listQuery.isError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200
                          bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{errorText(listQuery.error, t)}</span>
          </div>
        )}

        {!listQuery.isLoading && !listQuery.isError && rows.length === 0 && (
          <p className="py-12 text-center text-sm text-gray-500">
            {t("messages.audit.noneFound")}
          </p>
        )}

        {rows.length > 0 && (
          <table className="w-full border-collapse overflow-hidden rounded-xl
                            bg-white text-sm shadow-sm">
            <thead>
              <tr className="bg-gray-100 text-left text-xs uppercase text-gray-600">
                <th className="px-4 py-2.5">{t("messages.audit.conversation")}</th>
                <th className="px-4 py-2.5 w-24">{t("messages.audit.kind")}</th>
                <th className="px-4 py-2.5 w-24">{t("messages.audit.people")}</th>
                <th className="px-4 py-2.5 w-44">{t("messages.audit.lastActivity")}</th>
                <th className="px-4 py-2.5 w-24" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c._id} className="border-t border-gray-100">
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-gray-900">
                      {c.title || t("messages.audit.directConversation")}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {(c.participants ?? [])
                        .map((p) => p.name || p.id)
                        .join(", ")}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{c.kind}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    {c.participants?.length ?? 0}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">
                    {stamp(c.lastMessageAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setOpened(c)}
                      className="flex items-center gap-1.5 rounded-lg border
                                 border-gray-300 px-2.5 py-1.5 text-xs
                                 font-semibold text-gray-700 transition-colors
                                 hover:bg-gray-50"
                    >
                      <Eye size={13} />
                      {t("messages.audit.read")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
