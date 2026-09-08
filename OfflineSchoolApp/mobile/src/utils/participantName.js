// mobile/src/utils/participantName.js
"use strict";

/**
 * Naming the people in a conversation, in the reader's language.
 *
 * A guardian has no name in this system. They are a GuardianAccess row — a
 * code, a list of children, and an optional label the office typed. So the
 * server composes something to show, and for an unnamed guardian that
 * something was the English phrase "Parent/Guardian", sometimes with the
 * children in brackets after it.
 *
 * A francophone parent opening the portal read it over every message they had
 * written themselves. Nothing was wrong with the translation catalogue: the
 * string had never been a key, because it was assembled on the server, and
 * `name` gives a client no way to tell "Mrs Ngu (Bern Constance)" — a person's
 * name, which must be left exactly as typed — from "Parent/Guardian (Bern
 * Constance)", which is a sentence in one language.
 *
 * The server now sends `officeLabel` and `childNames` alongside `name`, and
 * this is where the two cases part:
 *
 *   officeLabel set    → the office named them. Their name, untranslated,
 *                        with the children in brackets as before.
 *   officeLabel null   → nobody named them. The whole label is ours to write,
 *                        so it comes from the catalogue.
 *
 * `name` remains the fallback, for a phone talking to a server that predates
 * officeLabel: an English label is a worse outcome than a blank row, and a far
 * better one than a crash.
 */

/** The children behind a guardian, as one readable string, or null. */
const childList = (p) => {
  const names = (p?.childNames ?? []).filter(Boolean);
  return names.length ? names.join(", ") : null;
};

/**
 * What to call a guardian.
 *
 * @param {object}   p  participant, sender, or recipient row
 * @param {Function} t  translator
 */
export const guardianName = (p, t) => {
  const children = childList(p);

  if (p?.officeLabel) {
    // A person's name. Never translated, never reworded — the office typed it
    // so that the school would recognise it.
    return children ? `${p.officeLabel} (${children})` : p.officeLabel;
  }

  // Unnamed. `officeLabel` being absent rather than null means an older
  // server, and then `name` is all there is.
  if (p?.officeLabel === undefined && p?.name) return p.name;

  return children
    ? t("msgMobile.guardianOf", { children })
    : t("msgMobile.guardian");
};

/**
 * What to call anyone in a thread.
 *
 * Staff and students carry a real User.name, which is theirs and is returned
 * untouched. Only guardians need composing.
 */
export const participantName = (p, t) =>
  p?.kind === "guardian" ? guardianName(p, t) : (p?.name || null);

/**
 * A thread's name, from the point of view of whoever is reading it.
 *
 * A titled thread keeps its title. A direct thread is named for the other
 * side, which is why the caller passes the participants it wants counted —
 * the portal passes `otherParticipants`, so a parent is never shown their own
 * name over a message from a teacher.
 */
export const conversationName = (conversation, participants, t) =>
  conversation?.title ||
  (participants ?? [])
    .map((p) => participantName(p, t))
    .filter(Boolean)
    .join(", ") ||
  t("msgMobile.conversation");

/** "Parent of X" under a name in a picker, or the plain word. */
export const guardianSubtitle = (p, t) => {
  const children = childList(p);
  return children
    ? t("msgMobile.guardianOf", { children })
    : t("msgMobile.guardian");
};

const ROLE_KEYS = {
  teacher:     "msgMobile.roleTeacher",
  admin:       "msgMobile.roleAdmin",
  super_admin: "msgMobile.roleAdmin",
  bursar:      "msgMobile.roleBursar",
  student:     "msgMobile.roleStudent",
};

/**
 * The line under a name in the recipient picker.
 *
 * The server sends `subtitle`, and it is English: a raw role slug for staff
 * ("teacher", "bursar") and the phrase "your child" for a parent's own
 * children. A francophone parent opening the portal's recipient list read
 * both, under a heading and a search box that were correctly in French.
 *
 * The slug is not a translation problem, it is an identifier — so it is used
 * as one here, and the wording comes from the catalogue. An unrecognised role
 * falls through to whatever the server said rather than to nothing: a word in
 * the wrong language still tells a parent who they are writing to.
 *
 * @param {object}  p          recipient row
 * @param {Function} t         translator
 * @param {boolean} [ownChild] true where every student offered is the reader's
 *                             own child, which is the case in the portal and
 *                             is not on the staff side
 */
export const recipientSubtitle = (p, t, ownChild = false) => {
  if (p?.kind === "guardian") return guardianSubtitle(p, t);

  const role = String(p?.role ?? "").toLowerCase();
  if (ownChild && role === "student") return t("msgMobile.yourChild");

  const key = ROLE_KEYS[role];
  return key ? t(key) : (p?.subtitle || null);
};
