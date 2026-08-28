// desktop/src/main/api/coverage.js
"use strict";

/**
 * What is answered offline, what cannot be, and what is still to do.
 *
 * ── Why this file exists rather than a list in somebody's head ─────────────
 *
 * The goal is every endpoint the console calls. There are 180 of them, so the
 * work is long, and the danger over a long mechanical job is that "not done yet"
 * and "cannot be done" blur into each other. Six months from now nobody
 * remembers which endpoints were considered and rejected and which were simply
 * never reached — and the difference matters, because one is a decision and the
 * other is a gap.
 *
 * So the endpoints that will never be mirrored are listed here WITH the reason,
 * and scripts/coverage.js reports the three numbers: answered, online-only, and
 * remaining. A batch of work moves items from the third to the first, and the
 * total is a figure you can check rather than a feeling.
 *
 * ── What makes something online-only ──────────────────────────────────────
 *
 * Not difficulty. Every entry below is one of three things:
 *
 *   the server is the point   authentication cannot happen on a machine with no
 *                             connection, whatever else it can do
 *   the data is not mirrored   the sync feed excludes it, for reasons recorded in
 *                             backend/src/config/syncFeed.js — and a handler
 *                             cannot answer from data that is not there
 *   it is a file              rendered PDFs, photos and attachments belong in a
 *                             file cache with its own size budget, not in a
 *                             document mirror
 */

/**
 * @typedef  {object} OnlineOnly
 * @property {string} endpoint  "METHOD /path", with :id for parameters.
 * @property {string} because   Why, in terms somebody can act on or overturn.
 */

/** @type {OnlineOnly[]} */
const ONLINE_ONLY = [
  // ── The server is the point ─────────────────────────────────────────────
  {
    endpoint: "POST /auth/login",
    because:
      "Signing in IS reaching the server. A local database cannot verify a " +
      "password it does not hold, and holding one would mean a credential at " +
      "rest on a shared office machine. Somebody must sign in once while online; " +
      "after that the session is what the sync loop uses.",
  },
  {
    endpoint: "POST /auth/refresh",
    because: "As login: a new token can only come from the server that issues them.",
  },
  {
    endpoint: "POST /auth/change-password",
    because:
      "The password lives on the server and the change has to be verified there. " +
      "Queueing it would leave a person believing their password had changed " +
      "while the old one still worked.",
  },
  {
    endpoint: "POST /auth/logout",
    because:
      "Clearing the local session does not need the server and already happens " +
      "locally; the request itself is the server-side half and is not worth " +
      "queueing — a logout replayed hours later tells the server nothing useful.",
  },

  // ── The data is not mirrored ────────────────────────────────────────────
  //
  // Each of these sits on a collection syncFeed.js excludes, and the exclusion
  // is where the reasoning lives. Repeated here only as far as needed to explain
  // the consequence.
  {
    endpoint: "GET /messages/conversations",
    because:
      "Conversation and Message are excluded from the feed: who may read a " +
      "thread is decided per THREAD by services/communication/policy.service, " +
      "and the feed can express one capability per collection. Mirroring every " +
      "message in the school to answer one screen is not the trade.",
  },
  {
    endpoint: "GET /messages/conversations/:id",
    because: "As the conversation list — the collection is not mirrored.",
  },
  {
    endpoint: "GET /messages/conversations/:id/messages",
    because: "As the conversation list — the collection is not mirrored.",
  },
  {
    endpoint: "GET /messages/audit/conversations",
    because:
      "Reading a thread one is not part of, which messages.audit gates and the " +
      "server records. An audit that a local mirror could satisfy silently would " +
      "not be an audit.",
  },
  {
    endpoint: "GET /messages/recipients",
    because:
      "Who may be written to, computed from the messaging policy rather than " +
      "stored — so there is nothing to mirror.",
  },
  {
    endpoint: "POST /messages/conversations/direct",
    because: "Starting a conversation in a collection this machine does not hold.",
  },
  {
    endpoint: "POST /messages/conversations/:id/messages",
    because:
      "Sending a message. It could be queued, and it should not be: somebody who " +
      "types a message to a parent and sees it appear has been told it was sent. " +
      "A message that leaves in four hours is worse than one that visibly did not.",
  },
  {
    endpoint: "POST /messages/conversations/:id/read",
    because: "A read marker on a thread this machine does not mirror.",
  },
  {
    endpoint: "POST /messages/:id/reactions",
    because: "As above — the thread is not here.",
  },
  {
    endpoint: "DELETE /messages/:id",
    because: "As above — the thread is not here.",
  },
  {
    endpoint: "POST /messages/conversations/:id/attachments",
    because: "An upload. Files are not in the document mirror.",
  },
  {
    endpoint: "GET /documents/verifications",
    because:
      "DocumentVerification is excluded from the feed: these records are reached " +
      "by their own unauthenticated route and are the public check on a printed " +
      "document, so a stale local copy is worse than none.",
  },
  {
    endpoint: "POST /documents/verifications/:id/revoke",
    because:
      "Revoking a document's validity. The whole value of a revocation is that it " +
      "takes effect where the document is checked, which is the server — a " +
      "revocation waiting in a queue is a document still passing verification.",
  },
  {
    endpoint: "POST /documents/verifications/:id/restore",
    because: "As revoke: the effect is at the point of verification, not here.",
  },
  {
    endpoint: "PUT /documents/guardian-access/:id",
    because:
      "GuardianAccess is excluded from the feed for exactly this reason: a stale " +
      "mirrored copy of who may see a child's records is the one kind of " +
      "staleness that must not happen.",
  },
  {
    endpoint: "DELETE /documents/guardian-access/:id",
    because: "As above — withdrawing access must not wait in a queue.",
  },

  // ── It is a file ────────────────────────────────────────────────────────
  {
    endpoint: "PUT /documents/student-photo/:id",
    because:
      "An image upload. Files belong in a cache with its own size budget rather " +
      "than in the document mirror, and nothing has built that yet.",
  },
  {
    endpoint: "DELETE /documents/student-photo/:id",
    because: "As above — the photo store is not mirrored.",
  },
  {
    endpoint: "GET /exports/:id",
    because:
      "A generated spreadsheet, produced server-side from a query. Reproducing " +
      "the file format offline is a second implementation of an export, and the " +
      "screens that offer it can say it needs a connection.",
  },
  {
    endpoint: "GET /insights/early-warning",
    because:
      "The early-warning list, computed by services/earlyWarning.service across " +
      "attendance, marks and fees. Real logic rather than a shape — and a wrong " +
      "answer here names a child as at risk who is not, or misses one who is.",
  },
];

/**
 * ── Endpoints that are answered offline EXCEPT in a named case ─────────────
 *
 * The count in scripts/coverage.js is per endpoint, so a handler that answers
 * most requests to a path and declines one shape counts as done — which is very
 * nearly true and, left unwritten, becomes a small lie that grows. Somebody
 * reading "answered offline" has no way to know a case falls through.
 *
 * Recorded here and reported, so the number stays a number you can check. A
 * decline is never a failure: the request goes over the network exactly as it
 * did before, and the screen behaves as it does today.
 */

/**
 * @typedef  {object} Partial
 * @property {string} endpoint  "METHOD /path", as in ONLINE_ONLY.
 * @property {string} except    The case that goes to the network.
 * @property {string} because   Why, in terms somebody can act on or overturn.
 */

/** @type {Partial[]} */
const PARTIAL = [
  {
    endpoint: "POST /exams",
    except:   "a create carrying a subjects array",
    because:
      "The endpoint then creates an ExamSubject per entry with ids it generates " +
      "itself — one request and several documents. This layer's write contract " +
      "is one row and one request, and rows written under ids the server will " +
      "not agree with are orphans. POST /exams/:examId/subjects adds them one " +
      "at a time and is queueable, so nothing is out of reach.",
  },
  {
    endpoint: "POST /exams/:id/subjects",
    except:   "one naming a subject or teacher whose row this machine does not hold",
    because:
      "The row stores the subject's name and the teacher's, read from two other " +
      "collections, and they are what a screen prints. The staff directory needs " +
      "users.manage to mirror, so a teacher's own machine does not hold it — and " +
      "an absent row is indistinguishable from no such person. Declining sends " +
      "the request out and lets the server resolve the name, rather than writing " +
      "a blank one that a later pull corrects.",
  },
  {
    endpoint: "PATCH /exams/:id/status",
    except:   'setting the status to "published"',
    because:
      "Publishing also marks every ResultSummary for the exam published — an " +
      "unbounded number of documents from one request. Every other status is " +
      "answered offline.",
  },
];

/** Quick membership tests for the coverage report. */
const isOnlineOnly = (endpoint) => ONLINE_ONLY.some((e) => e.endpoint === endpoint);
const isPartial    = (endpoint) => PARTIAL.some((e) => e.endpoint === endpoint);

module.exports = { ONLINE_ONLY, PARTIAL, isOnlineOnly, isPartial };
