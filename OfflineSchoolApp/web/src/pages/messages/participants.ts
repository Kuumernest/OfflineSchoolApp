import type { Participant } from "@/services/message.service";

/**
 * Naming and searching the people in a conversation.
 *
 * Shared by the message list and the audit list, which had drifted: one showed
 * every participant by name, the other showed none, and neither could be
 * searched by a parent's child.
 */

const MAX_NAMED = 3;

/** Everything a person in a thread can be found by. */
export const searchableNames = (p: Participant): string[] => [
  p.name ?? "",
  ...(p.childNames ?? []),
].filter(Boolean);

/**
 * The participants of a thread, in a line that fits.
 *
 * A class conversation holds every pupil in the class. Joining forty-two names
 * with commas produced a single unbreakable line that pushed the table off the
 * page — and it was not readable anyway, because the answer to "who is in
 * this?" for a class thread is the class, not a roll call.
 *
 * So: up to three names, then a count. Fewer than three and it reads as the
 * list it is.
 */
export const summariseParticipants = (
  participants: Participant[],
  t: (key: string, vars?: Record<string, unknown>) => string,
): string => {
  const names = participants
    .map((p) => p.name || p.id)
    .filter(Boolean) as string[];

  if (names.length === 0) return "";
  if (names.length <= MAX_NAMED) return names.join(", ");

  return t("messages.andMore", {
    names: names.slice(0, MAX_NAMED).join(", "),
    count: names.length - MAX_NAMED,
  });
};

/**
 * Does this conversation match what somebody typed?
 *
 * Matches the thread's own title, every participant's name, and the children
 * behind a guardian — so typing a pupil's name finds the thread with their
 * parent, which is how a school looks for it.
 */
export const conversationMatches = (
  conversation: { title?: string | null; participants?: Participant[] },
  query: string,
): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if ((conversation.title ?? "").toLowerCase().includes(q)) return true;

  return (conversation.participants ?? []).some((p) =>
    searchableNames(p).some((n) => n.toLowerCase().includes(q))
  );
};
