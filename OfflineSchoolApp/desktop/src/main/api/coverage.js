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
    endpoint: "GET /documents/guardian-access",
    because:
      "The list of who may see which pupil. GuardianAccess is excluded from the " +
      "feed in terms that settle this endpoint too: a stale mirrored copy of an " +
      "access grant is the one kind of staleness that must not happen. A handler " +
      "cannot answer from a collection this machine does not hold, and answering " +
      "with an empty list would read as 'nobody has access', which is a sentence " +
      "somebody would act on.",
  },
  {
    endpoint: "POST /documents/guardian-access",
    because:
      "Issuing access to a child's records. Queued, it would tell the office a " +
      "guardian can see their child while the server has never heard of the " +
      "grant — and the guardian, being told, would try. The same reasoning " +
      "already declines revoking a document's validity and withdrawing access: " +
      "the effect is at the point where it is checked, which is the server.",
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
  // ── Deciding an approval ────────────────────────────────────────────────
  //
  // The one place in this application where "queued" would be an outright lie
  // about what has happened.
  {
    endpoint: "POST /approvals/:id/approve",
    because:
      "Approving does not record a decision, it APPLIES one: a per-kind applier " +
      "in services/approvals.service creates the refund payment, lets the pending " +
      "expense count, puts the waiver on the charge. Queueing it would show " +
      "'approved' to a head teacher while the money had not moved and the person " +
      "waiting had not been answered. It also has a state no local copy can " +
      "reproduce — the decision is saved BEFORE the effect is attempted, so a " +
      "failed apply leaves a request genuinely approved and genuinely not applied, " +
      "and collapsing those two facts into one hides whichever is dropped.",
  },
  {
    endpoint: "POST /approvals/:id/reject",
    because:
      "As approve. A refusal is an answer somebody is waiting for, and one that " +
      "leaves this machine in four hours has not been given. The four-eyes rule " +
      "the endpoint enforces — you may not decide what you raised — is the point " +
      "of the whole feature, and its authority is the server's.",
  },

  {
    endpoint: "POST /fees/structures/:id/apply",
    because:
      "Raising the term's charges: one row per pupil per item on the price list, " +
      "so a school of five hundred on a five-item structure is two and a half " +
      "thousand documents from one request, every one of them provisional until " +
      "the request lands. " +
      "That size alone would not settle it. FeeCharge has a unique index on " +
      "(studentId, structureId, code, term), which is a genuine natural key — " +
      "so the derived-id treatment in shared/attendance.js would apply here and " +
      "would make a replay safe by construction. What does settle it is the " +
      "ANSWER: the endpoint reports how many charges it raised and how many it " +
      "skipped, and skipped means 'already on the server'. A machine that has " +
      "not synced cannot know that number, and a bursar reading '0 skipped' " +
      "where the server would have said '500 skipped' has been told the term was " +
      "billed when it was billed twice over. " +
      "Worth revisiting if the endpoint is ever given a client-supplied id " +
      "scheme AND an answer that does not depend on the server's prior state.",
  },

  // ── Reminders and late fees ─────────────────────────────────────────────
  //
  // GET /fees/penalties and GET /fees/reminders are now handled locally:
  // grace-period arithmetic and candidate lists are computed from the mirror.
  // POST /fees/reminders and POST /fees/penalties remain online-only because
  // they act on the result (sending messages, raising charges).
  {
    endpoint: "POST /fees/reminders",
    because:
      "Sending them. Queueing this would be the worst kind of wrong: a bursar " +
      "presses send, sees the list go out, and the messages actually leave four " +
      "hours later — by which time some of those families have paid at the " +
      "counter. A reminder that visibly did not send beats one that sends late.",
  },
  {
    endpoint: "POST /fees/penalties",
    because:
      "Raising them: money added to families' bills, one charge per student, " +
      "from the computation above. An unbounded number of documents from one " +
      "request, and every one of them is a real amount somebody has to pay.",
  },

  {
    endpoint: "GET /insights/early-warning",
    because:
      "The early-warning list, computed by services/earlyWarning.service across " +
      "attendance, marks and fees. Real logic rather than a shape — and a wrong " +
      "answer here names a child as at risk who is not, or misses one who is.",
  },

  // ── Pupil records: the writes that carry a credential or a minted number ──
  //
  // The record writes themselves — suspend, restore, move, approve, reject,
  // withdraw — ARE answered offline, in writes/students.js. What remains here
  // is the part of the lifecycle that only the server can do honestly.
  {
    endpoint: "POST /students",
    because:
      "Enrolling a pupil mints two things the desk cannot mint: the enrollment " +
      "number, derived atomically across BOTH student collections so two " +
      "approvals never collide — writes/students.js already declines to queue " +
      "the renumber route for exactly this reason — and the temporary password " +
      "the response carries, which the office hands to the parent as the child's " +
      "login. A local answer would show a credential the server will replace.",
  },
  {
    endpoint: "POST /students/:id/reset-password",
    because:
      "As change-password: the credential lives on the server and only the " +
      "server can issue its replacement. The screen shows the new password so " +
      "somebody can pass it on — an offline answer would show one that does " +
      "not work.",
  },
  {
    endpoint: "POST /admin/students",
    because:
      "DEAD CALL, recorded so it does not read as backlog: no POST /students " +
      "route exists under /api/admin — the admin router has approve, reject, " +
      "suspend, restore, move, delete and renumber only. The console's create " +
      "answers 404 today. The real enrollment endpoint is POST /students, " +
      "listed above. If the endpoint is ever written, its home decision is the " +
      "same one — the credential travels in the response.",
  },
  {
    endpoint: "PUT /admin/students/:id",
    because:
      "DEAD CALL, recorded so it does not read as backlog: the admin router has " +
      "no update route for a pupil — the console's edit answers 404 today, and " +
      "the pupil-self routes in students.routes.js are photo and profile only. " +
      "Mirroring a 404 would be a second implementation of nothing. If the " +
      "update endpoint is written with a tenancy check like its siblings, it is " +
      "a natural offline write: every field it would edit lives in the mirror.",
  },
  // REMOVED: POST /admin/timetable — now handled offline in writes/timetable.js
{
    endpoint: "GET /results/:id/student/:id/reportcard",
    because:
      "The report-card payload is the input to the single shared rendering " +
      "engine — the same coefficients, weighted averages and positions that " +
      "the HTML and PDF paths run. An offline copy of it is a second " +
      "implementation of the computation a child's grade depends on, and no " +
      "console screen consumes it directly: the cards page asks for the " +
      "rendered HTML, which is the next entry.",
  },
  {
    endpoint: "GET /results/:id/student/:id/reportcard/html",
    because:
      "The printable card is the shared template engine (school template or " +
      "built-in layout), the QR verification strip, and an archive to " +
      "GeneratedReport — the single document a parent holds. A subtly " +
      "different render from a local engine is exactly the drift this mirror " +
      "exists to avoid, and printing a wrong grade is worse than the page " +
      "asking for a connection.",
  },
  {
    endpoint: "POST /results/:id/student/:id/reportcard/reissue",
    because:
      "Reissuing re-renders through the same engine and deliberately " +
      "supersedes an archived document a parent may already hold — an " +
      "admin-only act that records who did it. Both the render and the " +
      "supersede need the server; a local answer would forge the record.",
  },

  // ── Office accounts and the profile: credentials and authority ──────────
  //
  // The settings screens' writes for the office accounts are the two kinds of
  // never-offline: credentials the server invents, and authority the screen can
  // claim but only the server can revoke. Both reading handlers — the accounts
  // list and the analytics summary — ARE answered offline; it is the writes
  // that stay online.
  {
    endpoint: "POST /admin/settings/admins",
    because:
      "Creates an office account, emails a temporary password only the " +
      "server can invent, and answers with that password so the office can " +
      "hand it on. A locally invented one is a credential that will not " +
      "work, written on a piece of paper; and 'email sent' on the screen is " +
      "a claim only the server can make true.",
  },
  {
    endpoint: "POST /admin/settings/admins/:id/reset-password",
    because:
      "Same two facts as the create: only the server can invent the " +
      "replacement password, and the reply that says it went out by email " +
      "has to be real. The account also signs in with this password from " +
      "other machines, which a local answer would not know about.",
  },
  {
    endpoint: "DELETE /admin/settings/admins/:id",
    because:
      "Removing an admin revokes access to the school's records from every " +
      "machine at once. 'Removed' on the screen while the account still " +
      "signs in for the rest of the afternoon is exactly what that button " +
      "must never mean. Deactivation is a plain, idempotent write — which " +
      "is why it is tempting — and authority changes are only real when the " +
      "server has applied them.",
  },
  {
    endpoint: "PUT /admin/settings/profile",
    because:
      "The email uniqueness check is a query over every User in the " +
      "deployment, and the mirror holds only this school's people. A " +
      "locally-passed check can still collide with another school's account " +
      "on replay, leaving the queue parked on a 409 the screen never saw " +
      "coming.",
  },

  // ── Permissions: the definitions are code ─────────────────────────────────
  //
  // GET /admin/permissions serves the full permission matrix: a static defs
  // list (backend/src/config/permissions.js, 300+ lines) plus the effective
  // grants per role computed from the School document's overrides. The defs
  // are code, not data — replicating them here would be a second source of
  // truth that drifts when a developer adds a permission. The screen that
  // consumes this endpoint is admin-only and rare enough to be online-only.
  {
    endpoint: "GET /admin/permissions",
    because:
      "The permission definitions are code in backend/src/config/permissions.js " +
      "(300+ lines of structured data). Replicating them here would be a second " +
      "source of truth that drifts whenever a developer adds a permission. " +
      "The permissions screen is admin-only and infrequent.",
  },
  {
    endpoint: "PUT /admin/permissions/:id",
    because:
      "Same as the read: the write applies overrides against the defs list. " +
      "The server's permissions.service is the authority on what each role may " +
      "hold, and granting a permission the local copy does not know about " +
      "would silently succeed and then be undone by the next pull.",
  },

  // ── Assignments and periods: backend generates ids ────────────────────────
  //
  // Both endpoints always call uuidv4() for the new document's _id and do not
  // accept req.body._id. A local write would invent an id the server does not
  // agree with, creating an orphan that the next pull duplicates. The fix is a
  // backend change (accept client-supplied _id), not a local workaround.
  {
    endpoint: "POST /admin/assignments",
    because:
      "The backend always generates _id via uuidv4() and does not accept " +
      "req.body._id. A locally-invented id would not survive the server's " +
      "own insert, and the outbox would settle the document under a wrong id.",
  },
  {
    endpoint: "DELETE /admin/assignments/:id",
    because:
      "Deleting by server-assigned id. The delete itself is a plain " +
      "findByIdAndDelete, but it depends on the id the server gave the " +
      "document, which a local write cannot know.",
  },
  {
    endpoint: "POST /admin/periods",
    because:
      "As assignments: backend always generates _id via uuidv4() and does " +
      "not accept req.body._id.",
  },

  // ── Announcements create: teacher-class authorization ─────────────────────
  {
    endpoint: "POST /announcements",
    because:
      "Creating an announcement requires authorizing the teacher against " +
      "TeacherAssignment to confirm they teach the selected class. That " +
      "lookup may not be on every machine (it requires users.manage to " +
      "mirror), and a wrong authorization is worse than a decline.",
  },
  // POST /announcements/read-all is NOT handled offline. It marks every unread
  // announcement in the school read in one request against an unbounded number
  // of documents. The write contract cannot express this honestly: `also` would
  // carry every announcement in the school, freezing the pull cursor for the
  // whole collection behind one queue entry. The `marked` count is also computed
  // from the server's state at REPLAY time, so the number shown is not what the
  // school records. See writes/announcements.js for the full reasoning.
  {
    endpoint: "POST /announcements/read-all",
    because:
      "One request against an unbounded number of documents. The write " +
      "contract cannot express this honestly: `also` would carry every " +
      "announcement, freezing the pull cursor. The `marked` count is " +
      "computed from the server's state at REPLAY time.",
  },

  // ── Templates: unknown token vocabulary ───────────────────────────────────
  //
  // ── Payroll: money moves ──────────────────────────────────────────────────
  //
  // Confirming or reversing a payroll payment is a real financial transaction.
  // The confirmation creates a payment record and may trigger disbursement;
  // the reversal creates a reversal payment. Both affect the school's actual
  // finances and must not be faked locally.
  {
    endpoint: "POST /finance/payroll/:id/confirm",
    because:
      "Confirming a payroll payment is a real financial transaction that " +
      "creates a payment record. The school's money moves when this lands.",
  },
  {
    endpoint: "POST /finance/payroll/:id/reverse",
    because:
      "Reversing a confirmed payroll payment is the same transaction in " +
      "reverse — it creates a reversal payment and adjusts balances. " +
      "Both must happen on the server.",
  },
  {
    endpoint: "POST /finance/payroll/generate",
    because:
      "Generating payroll computes amounts from salary scales and attendance, " +
      "which is server-side logic. The computed amounts must be authoritative.",
  },

  // ── Enrollment number: server-minted sequence ─────────────────────────────
  {
    endpoint: "POST /students/:id/enrollment-number",
    because:
      "The enrollment number is a sequential counter minted by the server " +
      "across both student collections to prevent collisions. A locally " +
      "invented number would conflict with the server's sequence.",
  },

  // ── Promotion runs: server-computed decisions ─────────────────────────────
  //
  // The generate, commit and reverse endpoints call promotion.service methods
  // that make complex decisions about every student in the school. The draft
  // DELETE is a simple operation on synced collections, but the other three
  // require the server's full view of the data.
  {
    endpoint: "POST /promotion/runs",
    because:
      "Generating a promotion run drafts decisions for every student based " +
      "on attendance, marks and class structure. This is server-side logic " +
      "that cannot be replicated locally.",
  },
  {
    endpoint: "POST /promotion/runs/:id/commit",
    because:
      "Committing a promotion run modifies Enrollment, Class and StudentStatus " +
      "for every student in the school. The server's transactional logic " +
      "ensures consistency across all these collections.",
  },
  {
    endpoint: "POST /promotion/runs/:id/reverse",
    because:
      "Reversing a committed run undoes the same complex modifications. " +
      "Must happen on the server to maintain data integrity.",
  },
  {
    endpoint: "DELETE /promotion/runs/:id",
    because:
      "HARD deletes on PromotionRun and PromotionDecision. A write here " +
      "can only put a row; there is no way to ask for one to be forgotten. " +
      "The feed only sends documents that exist, so a hard-deleted run " +
      "would sit in the local mirror for ever.",
  },

  // ── Documents and exports: files ──────────────────────────────────────────
  {
    endpoint: "GET /documents:id",
    because:
      "DocumentVerification is excluded from the feed: these records are " +
      "reached by their own unauthenticated route and are the public check " +
      "on a printed document. A stale local copy is worse than none.",
  },
  {
    endpoint: "GET /exports",
    because:
      "Listing generated exports. The files are not in the document mirror, " +
      "and the list is server-maintained.",
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
  // REMOVED: PATCH /exams/:id/status — now fully handled offline including "published"
];

/**
 * ── Call sites whose ":id" is not an id ───────────────────────────────────
 *
 * The register screens call `${BASE}/${kind}` and `${BASE}/${kind}/roster`,
 * where kind is the literal "students" or "teachers" — one screen, two
 * collections. The path parser in scripts/coverage.js cannot know that: it turns
 * every template hole into ":id", so those calls arrive as "/attendance/:id"
 * and "/attendance/:id/roster".
 *
 * Which made the count wrong in BOTH directions at once. The two real endpoints
 * were listed as one line of backlog, and the handler answering
 * /attendance/students matched nothing, so implementing it credited nothing —
 * GET /api/attendance/students had been answered offline for weeks and the
 * report had never counted it.
 *
 * Declared here so the expansion is a stated assumption rather than a guess
 * inside the parser. A family lists the segment position and the literals it can
 * take; the report expands the call sites against it, so the backlog names
 * "/attendance/teachers" rather than something no route could ever match.
 */

/**
 * @typedef  {object} Family
 * @property {string}   prefix   The path up to the composed segment.
 * @property {string[]} values   Every literal that segment can be.
 * @property {string}   because  Why the parser cannot see this.
 */

/** @type {Family[]} */
const PARAMETERISED = [
  {
    prefix: "/attendance/",
    values: ["students", "teachers"],
    because:
      "One set of register screens serves pupils and staff, calling " +
      "`${BASE}/${kind}` with kind as a literal. Only the segment straight " +
      "after /attendance/ is expanded, so /attendance/report/class/:id is left " +
      "alone — the :id there is a real class id.",
  },
];

/** Quick membership tests for the coverage report. */
const isOnlineOnly = (endpoint) => ONLINE_ONLY.some((e) => e.endpoint === endpoint);
const isPartial    = (endpoint) => PARTIAL.some((e) => e.endpoint === endpoint);

module.exports = { ONLINE_ONLY, PARTIAL, PARAMETERISED, isOnlineOnly, isPartial };
