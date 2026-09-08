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

type T = (key: string, vars?: Record<string, unknown>) => string;

const childList = (p: Pick<Participant, "childNames">): string | null => {
  const names = (p.childNames ?? []).filter(Boolean);
  return names.length ? names.join(", ") : null;
};

/**
 * What to call a guardian.
 *
 * A guardian has no name in this system. They are a GuardianAccess row — a
 * code, a list of children, and an optional label the office typed — so the
 * server composes something to show. For an unnamed guardian that something
 * is the English phrase "Parent/Guardian", with the children in brackets after
 * it, and it stayed English on a French console: the string had never been a
 * key, because it was assembled on the server.
 *
 * `officeLabel` is what lets the two cases be told apart. Set, it is a
 * person's name and is rendered exactly as the office typed it. Null, nobody
 * named them and the whole label is ours to write.
 *
 * Absent — a server predating the field — falls back to `name`. An English
 * label is a worse outcome than a translated one and a much better one than a
 * blank row where a name should be.
 */
export const guardianName = (p: Participant, t: T): string => {
  const children = childList(p);

  if (p.officeLabel) {
    return children ? `${p.officeLabel} (${children})` : p.officeLabel;
  }
  if (p.officeLabel === undefined && p.name) return p.name;

  return children
    ? t("messages.guardianOf", { children })
    : t("messages.guardian");
};

/**
 * What to call anyone in a thread.
 *
 * Staff and students carry a real User.name, which is theirs and is returned
 * untouched. Only guardians need composing.
 */
export const participantName = (p: Participant, t: T): string =>
  p.kind === "guardian" ? guardianName(p, t) : (p.name ?? "");

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
    .map((p) => participantName(p, t) || p.id)
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
