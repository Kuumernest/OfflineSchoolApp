// backend/src/services/communication/policy.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COMMUNICATION POLICY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Who may talk to whom. Pure decision logic — no database, no request, no
 * side effects — so it can be exercised exhaustively in isolation and so
 * every route enforces exactly the same rules.
 *
 * This module is the ONLY place the matrix lives. A route that decides for
 * itself who may message whom is a bug: the client cannot be trusted, and
 * authorisation retrofitted after a messaging feature ships is how schools
 * leak private conversations.
 *
 * ── Two kinds of principal ────────────────────────────────────────────────
 *
 * Staff and students are Users and carry a role. Guardians are NOT users —
 * there is no "parent" role in the User schema. A guardian authenticates
 * through the portal against a GuardianAccess row and is identified only by
 * the students they may see. Everything here therefore speaks in principals:
 *
 *   { kind: "user",     role, id, schoolId }
 *   { kind: "guardian", id, schoolId, studentIds: [] }
 *
 * ── The matrix ────────────────────────────────────────────────────────────
 *
 *   FROM      TO         ALLOWED
 *   student   student    configurable per school, OFF by default
 *   student   teacher    yes
 *   student   admin      yes
 *   student   guardian   no
 *   teacher   student    yes
 *   teacher   teacher    yes
 *   teacher   guardian   yes
 *   teacher   admin      yes
 *   guardian  teacher    yes
 *   guardian  admin      yes
 *   guardian  student    only their own child
 *   guardian  guardian   no
 *   admin     anyone     yes
 *
 * ── Two notes on the defaults ─────────────────────────────────────────────
 *
 * Student-to-student direct messaging is ON by default: pupils talking to
 * each other is a normal part of school life and the product wants it. It
 * remains a per-school switch, so a school that would rather keep peer
 * messaging closed can turn it off without a code change. Admin audit is on
 * by default alongside it — peer messaging a school cannot review is a
 * safeguarding problem, and the two settings belong together.
 *
 * Nothing here grants anyone the right to read a conversation they are not
 * part of. Admin audit access is a separate, explicit capability so that
 * reading someone's messages is always a distinct decision from being
 * allowed to send them.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

/** Unknown roles get no privileges. */
const isAdminRole = (role) => ADMIN_ROLES.has(String(role || ""));

/**
 * Describe a principal in one word, so the matrix reads plainly.
 * @returns {"admin"|"teacher"|"student"|"guardian"|"unknown"}
 */
function principalKind(p) {
  if (!p) return "unknown";
  if (p.kind === "guardian") return "guardian";
  if (p.kind !== "user")     return "unknown";
  if (isAdminRole(p.role))   return "admin";
  if (p.role === "teacher")  return "teacher";
  if (p.role === "student")  return "student";
  return "unknown";
}

const deny  = (reason) => ({ allowed: false, reason });
const allow = (reason = null) => ({ allowed: true, reason });

/**
 * School communication settings with safe defaults applied.
 *
 * Callers pass whatever the School document holds — possibly nothing, for
 * schools created before these settings existed — and get a complete object
 * back. The default is the restrictive choice in every case that matters.
 */
function resolveSettings(raw) {
  const s = raw || {};
  return {
    // On unless a school explicitly turns it off. Everything else here uses
    // `!== false` for the same reason: a school created before these settings
    // existed has no value stored, and must behave like one that accepted the
    // defaults rather than like one that opted out of everything.
    studentToStudent:  s.studentToStudent  !== false,
    studentToAdmin:    s.studentToAdmin    !== false,
    guardianToTeacher: s.guardianToTeacher !== false,
    guardianToAdmin:   s.guardianToAdmin   !== false,
    // Whether an admin may read conversation content during an audit, as
    // opposed to only seeing that a conversation exists.
    adminAudit:        s.adminAudit        !== false,
  };
}

/**
 * Stable identity for a participant across both principal kinds. A guardian
 * and a user could in principle carry the same id string, so the kind is
 * part of the key.
 */
function participantKey(p) {
  if (!p) return "";
  const kind = p.kind === "guardian" ? "guardian" : "user";
  return kind + ":" + String(p.id != null ? p.id : "");
}

/**
 * May `from` open or post to a direct conversation with `to`?
 *
 * @param {object}  from      principal acting
 * @param {object}  to        principal being addressed
 * @param {object} [settings] raw school communication settings
 * @returns {{allowed: boolean, reason: string|null}}
 */
function canMessage(from, to, settings) {
  const cfg = resolveSettings(settings);
  const a   = principalKind(from);
  const b   = principalKind(to);

  if (a === "unknown" || b === "unknown") {
    return deny("Unrecognised sender or recipient");
  }

  // Tenancy first. Checked before the matrix so that even a super_admin
  // cannot cross schools through a mistyped id.
  if (from.schoolId && to.schoolId &&
      String(from.schoolId) !== String(to.schoolId)) {
    return deny("Sender and recipient belong to different schools");
  }

  if (participantKey(from) === participantKey(to)) {
    return deny("Cannot message yourself");
  }

  // Admins reach anyone inside their own school.
  if (a === "admin") return allow();

  if (a === "teacher") {
    if (b === "student" || b === "guardian" || b === "teacher" || b === "admin") {
      return allow();
    }
    return deny("Teachers may not message this kind of recipient");
  }

  if (a === "student") {
    if (b === "teacher") return allow();
    if (b === "admin") {
      return cfg.studentToAdmin
        ? allow()
        : deny("This school has disabled student messages to administrators");
    }
    if (b === "student") {
      return cfg.studentToStudent
        ? allow()
        : deny("This school has not enabled student-to-student messaging");
    }
    // A student talking to somebody else's parent is not school business.
    return deny("Students may not message guardians");
  }

  if (a === "guardian") {
    if (b === "teacher") {
      return cfg.guardianToTeacher
        ? allow()
        : deny("This school has disabled guardian messages to teachers");
    }
    if (b === "admin") {
      return cfg.guardianToAdmin
        ? allow()
        : deny("This school has disabled guardian messages to administrators");
    }
    if (b === "student") {
      const mine = (from.studentIds || []).map(String);
      return mine.includes(String(to.id))
        ? allow()
        : deny("Guardians may only message their own child");
    }
    return deny("Guardians may not message other guardians");
  }

  return deny("Unrecognised sender");
}

/** Is this principal listed on the conversation? */
function isParticipant(principal, conversation) {
  const me = participantKey(principal);
  return (conversation?.participants || []).some(
    (p) => participantKey(p) === me
  );
}

/**
 * May `principal` post into an existing conversation?
 *
 * Membership is the rule for group and class conversations: being allowed to
 * message a teacher does not put you in every class they teach. Admins are
 * NOT exempt — an admin who wants to speak in a class channel joins it, so
 * that the participants can see who is present.
 */
function canPostToConversation(principal, conversation) {
  if (!principal || !conversation) return deny("Unknown conversation");

  if (conversation.schoolId &&
      String(conversation.schoolId) !== String(principal.schoolId || "")) {
    return deny("Conversation belongs to another school");
  }

  if (conversation.isArchived) return deny("This conversation is archived");

  if (conversation.isReadOnly && principalKind(principal) !== "admin") {
    return deny("This conversation is read-only");
  }

  return isParticipant(principal, conversation)
    ? allow()
    : deny("You are not a participant");
}

/**
 * May `principal` READ this conversation?
 *
 * As posting, except that archiving stops posting but not reading for the
 * people who were in it, and an admin auditing their own school may read
 * without being a participant when the school permits it.
 *
 * Deliberately a separate function so that "can read someone's messages" is
 * never granted as a side effect of "can send messages".
 */
function canReadConversation(principal, conversation, settings) {
  if (!principal || !conversation) return deny("Unknown conversation");

  const sameSchool =
    conversation.schoolId &&
    String(conversation.schoolId) === String(principal.schoolId || "");

  if (!sameSchool) return deny("Conversation belongs to another school");

  // Participants keep their history, including after archiving.
  if (isParticipant(principal, conversation)) return allow();

  if (principalKind(principal) === "admin") {
    return resolveSettings(settings).adminAudit
      ? allow("admin-audit")
      : deny("Administrator auditing is disabled for this school");
  }

  return deny("You are not a participant");
}

module.exports = {
  ADMIN_ROLES,
  isAdminRole,
  principalKind,
  participantKey,
  isParticipant,
  resolveSettings,
  canMessage,
  canPostToConversation,
  canReadConversation,
};
