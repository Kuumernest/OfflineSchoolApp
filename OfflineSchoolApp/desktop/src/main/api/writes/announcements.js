// desktop/src/main/api/writes/announcements.js
"use strict";

/**
 * Acting on an announcement with no connection.
 *
 * ── Why these are queueable at all ────────────────────────────────────────
 *
 * Every per-user fact these endpoints write — readBy, acknowledgedBy — is an
 * array embedded in the announcement document, and syncFeed.js mirrors
 * Announcement whole. So the local answer ("you had already read this") is
 * computed from the same data the server computes it from, rather than guessed.
 *
 * ── POST /read-all is NOT here ────────────────────────────────────────────
 *
 * It marks every unread announcement in the school read in one request: one
 * request against an unbounded number of documents, which this layer's write
 * contract cannot express honestly — the same reason PATCH /exams/:id/status
 * declines "published". `also` would have to carry every announcement in the
 * school, and each of those rows becomes pending, which freezes the pull cursor
 * for the whole collection behind one queue entry. Its `marked` count is also
 * computed from the server's state at REPLAY time, so the number shown to the
 * user is not the number the school records. Online-only, with the reason in
 * coverage.js.
 *
 * ── Two guards that exist because .save() is not a field update ────────────
 *
 * POST /:id/read uses updateOne and cannot fail. The other four call
 * `announcement.save()`, and a save runs the model's pre-save hook AND full
 * document validation over paths the request never touched. Both can turn a
 * perfectly ordinary click into a 500 — and a 500 is RETRIED for ever, so it
 * blocks the outbox as surely as a 4xx. See saveWouldThrow() below.
 *
 * ── What none of these endpoints check ────────────────────────────────────
 *
 * Tenancy. They all resolve the announcement with Announcement.findByAnyId(),
 * which filters on nothing but _id — so an administrator of one school can pin,
 * edit or delete another school's announcement by id. The mirror holds one
 * school, so that is unreachable from here; the schoolId comparison in target()
 * is a belt the endpoints do not wear, and declining sends such an id to the
 * server that does allow it.
 */

/** The two roles the router calls admin — written out as the router writes it. */
const ADMIN_ROLES = ["super_admin", "school_admin"];

/** The model's enums, which .save() validates over the WHOLE document. */
const AUDIENCES     = ["all", "students", "teachers", "class", "parents"];
const MULTI         = ["students", "teachers", "parents"];
const PRIORITIES    = ["low", "normal", "high", "urgent"];
const AUTHOR_ROLES  = ["super_admin", "school_admin", "teacher", "system"];

/**
 * Every path carrying a schema default.
 *
 * A save() on a row missing one of these persists the default that mongoose
 * filled in when it hydrated the document — or does not, depending on whether
 * defaults applied at init are marked modified. I could not verify which, and
 * the difference is a field the mirror would hold and the server would not (or
 * the reverse) for ever after. So a row missing any of them is declined rather
 * than guessed at: the endpoint answers it perfectly well over the network.
 */
const DEFAULTED = [
  "author", "authorName", "authorRole", "audience", "targetClasses",
  "subjectId", "subjectName", "priority", "isPinned", "publishAt",
  "expiresAt", "readBy", "acknowledgedBy", "isActive", "deletedAt", "version",
];

/**
 * An id out of a ref that may or may not be populated.
 *
 * Needed here for the same reason as in the read handlers: PUT's response has
 * `author` populated to an object, sync/engine.js copies a write response into
 * the mirror, so between the push and the pull of one cycle the stored row holds
 * an object where the feed puts a string.
 */
const idOf = (ref) => {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return (ref._id ?? ref.id ?? ref)?.toString() ?? null;
};

/**
 * The announcement this request is for, or nothing.
 *
 * No deletedAt filter and no isActive filter, because the endpoints have none:
 * a soft-deleted announcement can still be pinned, edited, deleted again and
 * marked read. Reproduced rather than tidied — the alternative is a screen that
 * offers an action the server accepts and this machine refuses.
 */
const target = (docs, id, session) => {
  const row = docs.get("announcement", String(id));
  if (!row) return null;                                       // its 404
  if (session?.schoolId && String(row.schoolId) !== String(session.schoolId)) return null;
  const { _pending, ...clean } = row;
  return clean;
};

/**
 * Would `announcement.save()` throw on this row, before we change anything?
 *
 * Two separate hazards, both of which produce a 500 that the outbox retries for
 * ever rather than a 4xx it can report:
 *
 *   the pre-save hook throws "targetClasses must not be empty when audience is
 *   'class'" for a legacy row that has audience:"class" and an empty array. Such
 *   a row cannot be created through the API today, but one written before the
 *   hook existed is unreachable by every .save() route on the server — pin,
 *   acknowledge, edit and delete all 500 on it.
 *
 *   full document validation runs over paths the request never touched, so a
 *   stored value outside any of the enums fails a save that had nothing to do
 *   with it.
 */
const saveWouldThrow = (row) => {
  const multi = Array.isArray(row.audiences) && row.audiences.length > 0;

  if (!multi && row.audience === "class" &&
      (!Array.isArray(row.targetClasses) || row.targetClasses.length === 0)) {
    return true;
  }

  if (!String(row.schoolId ?? "")) return true;
  if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 300) return true;
  if (typeof row.body  !== "string" || !row.body.trim())  return true;
  if (!AUDIENCES.includes(row.audience)) return true;
  if (Array.isArray(row.audiences) && !row.audiences.every((a) => MULTI.includes(a))) return true;
  if (!PRIORITIES.includes(row.priority)) return true;
  if (row.authorRole !== null && !AUTHOR_ROLES.includes(row.authorRole)) return true;

  return false;
};

/**
 * The rest of the pre-save hook: targetClasses is CLEARED for a non-class
 * legacy row, on every save.
 *
 * So pinning an announcement can wipe its class scoping. That only bites rows
 * where the two fields disagree — which PUT can create, since it assigns
 * targetClasses whatever the audience is and the hook then clears it on the same
 * save. Reproduced because the mirror has to hold what the server will store; a
 * local row that kept the classes would disagree with the school's copy from the
 * moment the queue drained.
 *
 * Skipped entirely for multi-select rows: `audience` carries a default of "all",
 * so a row written as audiences:["students"] + targetClasses:["5A"] looks like a
 * non-class row here and had its scoping silently wiped until the model learnt
 * to skip it.
 */
const applySaveHook = (row) => {
  const multi = Array.isArray(row.audiences) && row.audiences.length > 0;
  if (!multi && row.audience !== "class") return { ...row, targetClasses: [] };
  return row;
};

/** Every path with a default is present, so save() cannot silently add one. */
const complete = (row) => DEFAULTED.every((field) => row[field] !== undefined);

/** A row a .save() endpoint may act on locally, or nothing. */
const savable = (docs, id, session) => {
  const row = target(docs, id, session);
  if (!row) return null;
  if (!complete(row)) return null;
  if (saveWouldThrow(row)) return null;
  return row;
};

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE, FOR PUT'S REPLY ONLY
//
// A second copy of the two helpers in ../handlers/announcements.js, and it is a
// copy on purpose rather than an import: the handler module's export is the
// route array the dispatcher spreads, and hanging helpers off it would make that
// export two things at once. If the populate rule changes, both files change —
// they are eight lines each and they sit under the same name in sibling
// directories.
//
// Returning null means "the mirror cannot resolve this ref", and every caller
// declines on it: populate() also yields null for an account the school deleted,
// and the mirror cannot tell those apart. Answering the wrong author on a screen
// is worse than answering from the network.
// ─────────────────────────────────────────────────────────────────────────────

const project = (row, fields) => {
  const out = { _id: row._id };
  // `field in row`, not a null test: a stored null is sent as null and an absent
  // field is absent, and a class with no `section` must not gain one.
  for (const field of fields) if (field in row) out[field] = row[field];
  return out;
};

const populateAuthor = (docs, ref) => {
  const id = idOf(ref);
  if (!id) return { resolved: true, value: null };
  const user = docs.get("user", id);
  if (!user) return { resolved: false, value: null };
  return { resolved: true, value: project(user, ["name", "email", "role"]) };
};

/** Mongoose DROPS an unresolvable id from a populated array, so this is all-or-nothing. */
const populateClasses = (docs, refs) => {
  const out = [];
  for (const ref of refs ?? []) {
    const id  = idOf(ref);
    const row = id ? docs.get("class", id) : null;
    if (!row) return null;
    out.push(project(row, ["name", "section"]));
  }
  return out;
};

module.exports = [
  {
    route: "POST /api/announcements/:id/read",

    /**
     * A receipt, from the bell or from opening the notice.
     *
     * ── The only write here that cannot fail ───────────────────────────────
     *
     * `updateOne({ _id, "readBy.user": { $ne: userId } }, { $push: … })`. No
     * hook, no document validation, atomic and idempotent — two taps, or a tap
     * racing the sync engine, cannot write a duplicate receipt. So the only 4xx
     * this endpoint has is the 404, and a row absent from the mirror declines.
     *
     * ── Queued even when the mirror says it was already read ───────────────
     *
     * `alreadyRead` is answered locally, and it would be tempting to stop there
     * and queue nothing. That would lose receipts: the mirror can be behind, and
     * "already read" computed from a stale copy is a guess. The server's
     * $ne guard makes the replay a no-op in the case where the guess was right,
     * which costs one request and risks nothing — while not sending it would
     * silently drop the one case where it was wrong.
     *
     * The author is NOT skipped. They used to be, which left their own
     * announcement permanently unread in the bell; they get an ordinary receipt
     * now and are excluded from readCount instead.
     */
    handler: ({ params }, { docs, session }) => {
      const userId = session?.userId;
      if (!userId) return null;

      const row = target(docs, params.id, session);
      if (!row) return null;

      const already = (row.readBy ?? []).some((r) => idOf(r.user) === userId);
      const now     = new Date().toISOString();

      // No updatedAt bump when nothing is pushed: the server's updateOne matches
      // no document in that case, so its timestamps hook does not run either.
      const doc = already
        ? row
        : {
            ...row,
            readBy:    [...(row.readBy ?? []), { user: userId, readAt: now }],
            updatedAt: now,
          };

      return {
        collection: "announcement",
        doc,
        request: {
          method: "POST",
          path:   `/api/announcements/${row._id}/read`,
          body:   null,
        },
        response: {
          status: 200,
          data: { success: true, message: "Marked as read", alreadyRead: already },
        },
      };
    },
  },

  {
    route: "POST /api/announcements/:id/acknowledge",

    /**
     * "I have seen this and I am telling you so."
     *
     * Three behaviours in one endpoint, and the middle one is easy to miss:
     *
     *   your own announcement    answered 200 with a different message and
     *                            NOTHING written. The author cannot acknowledge
     *                            themselves.
     *   already acknowledged     save() is never reached, so the pre-save hook
     *                            does not run and targetClasses is not cleared.
     *   otherwise                acknowledgedBy gets a row, and readBy too if it
     *                            had none — acknowledging implies reading.
     *
     * Only the third path saves, so only the third path is subject to the hook
     * and to validation. The row is checked for both anyway, because the mirror
     * can be behind: if it says "already acknowledged" and the server disagrees,
     * the replay takes the writing path and would meet whatever this machine
     * declined to look at.
     */
    handler: ({ params }, { docs, session }) => {
      const userId = session?.userId;
      if (!userId) return null;

      const row = savable(docs, params.id, session);
      if (!row) return null;

      const isOwn = idOf(row.author) === userId;

      const queued = {
        collection: "announcement",
        request: {
          method: "POST",
          path:   `/api/announcements/${row._id}/acknowledge`,
          body:   null,
        },
      };

      if (isOwn) {
        // Queued rather than answered and forgotten, for the reason on
        // POST /:id/read: the local decision rests on a mirror that may be
        // behind, and the server's own guard makes the replay harmless.
        return {
          ...queued,
          doc: row,
          response: {
            status: 200,
            data: { success: true, message: "Own announcement — skipped" },
          },
        };
      }

      const already = (row.acknowledgedBy ?? []).some((r) => idOf(r.user) === userId);

      if (already) {
        return {
          ...queued,
          doc: row,
          response: { status: 200, data: { success: true, message: "Acknowledged" } },
        };
      }

      const now  = new Date().toISOString();
      const read = (row.readBy ?? []).some((r) => idOf(r.user) === userId);

      const doc = applySaveHook({
        ...row,
        acknowledgedBy: [...(row.acknowledgedBy ?? []), { user: userId, acknowledgedAt: now }],
        readBy: read ? row.readBy : [...(row.readBy ?? []), { user: userId, readAt: now }],
        // version is NOT bumped. Pin, edit and delete all bump it; acknowledge
        // does not, and neither does read. Not a rule — just what the code does.
        updatedAt: now,
      });

      return {
        ...queued,
        doc,
        response: { status: 200, data: { success: true, message: "Acknowledged" } },
      };
    },
  },

  {
    route: "POST /api/announcements/:id/pin",

    /**
     * Sticking a notice to the top of the list, or unsticking it.
     *
     * A TOGGLE, not a setter — it reads no body and answers with the new state.
     * So two clicks are two toggles and end where they started, offline exactly
     * as online, which is why there is no dedupeKey: suppressing the second
     * request would leave the mirror pinned and the server not.
     *
     * adminOnly = requirePermission("announcements.manage"). The permissions in
     * the session are the resolved set the server sent at sign-in, including
     * whatever this school overrode, so this is the same question the guard asks
     * rather than a role list that happens to agree today.
     */
    handler: ({ params }, { docs, session }) => {
      if (!session?.permissions?.includes("announcements.manage")) return null;

      const row = savable(docs, params.id, session);
      if (!row) return null;

      const isPinned = !row.isPinned;

      const doc = applySaveHook({
        ...row,
        isPinned,
        version:   (row.version || 1) + 1,
        updatedAt: new Date().toISOString(),
      });

      return {
        collection: "announcement",
        doc,
        request: {
          method: "POST",
          path:   `/api/announcements/${row._id}/pin`,
          body:   null,
        },
        // The announcement is NOT in the reply — only the new state.
        response: { status: 200, data: { success: true, isPinned } },
      };
    },
  },

  {
    route: "PUT /api/announcements/:id",

    /**
     * Editing a notice.
     *
     * ── Only what changed goes out ──────────────────────────────────────────
     *
     * The endpoint builds its update from `field !== undefined`, so the queued
     * request carries the body as it arrived. A handler that helpfully sent the
     * whole document would write back values nobody touched and revert whatever
     * a colleague changed from the web in the meantime.
     *
     * ── Every way this endpoint answers 4xx or 500 ──────────────────────────
     *
     *   403  not the author and not an admin
     *   403  a teacher setting audience to "teachers" or "all"
     *   404  no such announcement
     *   500  title/body not a string — `title.trim()` on a number or null
     *   500  title empty after trimming, or longer than 300; body empty
     *   500  audience or priority outside the schema enum
     *   500  targetClasses not an array, or holding something uncastable
     *   500  an unparseable expiresAt
     *   500  the pre-save hook, for a row whose audience is "class" with no
     *        classes left on it
     *
     * All of them are checked below. The 500s matter as much as the 403s here:
     * the outbox retries a 500 for ever, so it blocks the queue rather than
     * reporting itself.
     *
     * ── Two things this endpoint silently cannot do ─────────────────────────
     *
     * It does not read `audiences`, so an announcement written with the
     * multi-select picker cannot have its audience changed: the edit moves the
     * legacy field, and audienceMatch() ignores that field entirely for a row
     * that has `audiences`. The screen reports success and nobody's view of the
     * notice changes. It does not read `publishAt` either, so a scheduled
     * announcement's publish time can never be corrected. Both are the
     * endpoint's, reported upward, and reproduced.
     */
    handler: ({ params, body }, { docs, session }) => {
      const userId = session?.userId;
      if (!userId) return null;

      // adminOrTeacher = requirePermission("announcements.create").
      if (!session.permissions?.includes("announcements.create")) return null;

      const row = savable(docs, params.id, session);
      if (!row) return null;

      const isAdmin = ADMIN_ROLES.includes(session.role);
      if (idOf(row.author) !== userId && !isAdmin) return null;      // its 403

      if (session.role === "teacher" &&
          (body.audience === "teachers" || body.audience === "all")) {
        return null;                                                 // its 403
      }

      const updates = {};

      for (const field of ["title", "body"]) {
        if (body[field] === undefined) continue;
        // `.trim()` on anything but a string throws inside the endpoint, and the
        // required/maxlength validators fire on save. All three are 500s.
        if (typeof body[field] !== "string") return null;
        const value = body[field].trim();
        if (!value) return null;
        if (field === "title" && value.length > 300) return null;
        updates[field] = value;
      }

      if (body.audience !== undefined) {
        if (!AUDIENCES.includes(body.audience)) return null;
        updates.audience = body.audience;
      }

      if (body.targetClasses !== undefined) {
        if (!Array.isArray(body.targetClasses)) return null;
        if (!body.targetClasses.every((c) => typeof c === "string")) return null;
        updates.targetClasses = body.targetClasses;
      }

      if (body.priority !== undefined) {
        if (!PRIORITIES.includes(body.priority)) return null;
        updates.priority = body.priority;
      }

      if (body.expiresAt !== undefined) {
        if (!body.expiresAt) {
          updates.expiresAt = null;
        } else {
          const when = new Date(body.expiresAt);
          if (Number.isNaN(when.getTime())) return null;
          updates.expiresAt = when.toISOString();
        }
      }

      // isPinned is applied ONLY for an admin — `if (isPinned !== undefined &&
      // isAdmin)`. A teacher sending it is not refused; it is ignored.
      if (body.isPinned !== undefined && isAdmin) updates.isPinned = body.isPinned === true;

      if (body.subjectId !== undefined) {
        if (body.subjectId && typeof body.subjectId !== "string") return null;
        updates.subjectId = body.subjectId || null;

        if (body.subjectId && !body.subjectName) {
          // The endpoint looks the name up so the list can print it without a
          // join. Its lookup has no school scope and no deleted filter, so the
          // mirrored row is the same row — but a subject this machine does not
          // hold cannot be told apart from one the server would not find either,
          // and the two give different names.
          const subject = docs.get("subject", String(body.subjectId));
          if (!subject) return null;
          updates.subjectName = subject.name || null;
        } else {
          updates.subjectName = body.subjectName || null;
        }
      }

      const doc = applySaveHook({
        ...row,
        ...updates,
        version:   (row.version || 1) + 1,
        updatedAt: new Date().toISOString(),
      });

      // The reply is a re-fetch with author and targetClasses populated — which
      // means a teacher editing their own notice needs their own user row in the
      // mirror, and the feed gates `user` on users.manage. So this answers
      // locally for an administrator and goes to the network for a teacher.
      const author = populateAuthor(docs, doc.author);
      if (!author.resolved) return null;

      const targetClasses = populateClasses(docs, doc.targetClasses);
      if (targetClasses === null) return null;

      const populated = { ...doc, author: author.value, targetClasses };

      return {
        collection: "announcement",
        doc,
        request: {
          method: "PUT",
          path:   `/api/announcements/${row._id}`,
          // Verbatim. See the note above on sending only what changed.
          body,
        },
        // Under both names, as the endpoint sends it. Note that readBy and
        // acknowledgedBy are in this reply for EVERYBODY — the lean re-fetch is
        // not run through enrichForUser — so a teacher editing their own notice
        // is shown the whole school's receipts. The endpoint's choice.
        response: {
          status: 200,
          data: { success: true, announcement: populated, data: populated },
        },
      };
    },
  },

  {
    route: "DELETE /api/announcements/:id",

    /**
     * Withdrawing a notice. Soft: deletedAt is stamped and isActive goes false,
     * so the list stops showing it and GET /:id still does.
     *
     * ── The one write here a teacher can make offline ───────────────────────
     *
     * It answers with a message rather than the announcement, so nothing is
     * populated and nothing needs the `user` collection. A teacher deleting
     * their own notice therefore works on a machine that mirrors no users, which
     * PUT on the same row does not.
     *
     * ── No dedupeKey ────────────────────────────────────────────────────────
     *
     * A second delete is not a problem to suppress: the endpoint has no
     * already-deleted check, so it stamps the row again and answers 200. Adding
     * a dedupe key would be guarding against something that is not a failure,
     * and target() deliberately does not filter deletedAt for the same reason.
     */
    handler: ({ params }, { docs, session }) => {
      const userId = session?.userId;
      if (!userId) return null;
      if (!session.permissions?.includes("announcements.create")) return null;

      const row = savable(docs, params.id, session);
      if (!row) return null;

      const isAdmin = ADMIN_ROLES.includes(session.role);
      if (idOf(row.author) !== userId && !isAdmin) return null;      // its 403

      const now = new Date().toISOString();

      const doc = applySaveHook({
        ...row,
        deletedAt: now,
        isActive:  false,
        version:   (row.version || 1) + 1,
        updatedAt: now,
      });

      return {
        collection: "announcement",
        doc,
        request: {
          method: "DELETE",
          path:   `/api/announcements/${row._id}`,
          body:   null,
        },
        response: { status: 200, data: { success: true, message: "Announcement deleted" } },
      };
    },
  },
];
