// desktop/src/main/api/handlers/announcements.js
"use strict";

/**
 * What the school has said to itself, read offline.
 *
 * ── The per-user state is on the announcement, not beside it ──────────────
 *
 * "Have I read this" and "have I acknowledged this" are `readBy` and
 * `acknowledgedBy`: arrays of { user, readAt } embedded in the announcement
 * document. There is no separate receipts collection, and syncFeed.js mirrors
 * Announcement whole — no `omit`, no `scope` — so the mirror holds every
 * receipt for every reader in the school. isRead, isAcknowledged and the admin
 * read counts are therefore all answerable locally. That is the reason the
 * read/acknowledge writes can be queued at all (see ../writes/announcements.js).
 *
 * It also means the mirror carries who-has-read-what for the whole school on a
 * machine in the office. That is a consequence of the feed entry, not of these
 * handlers, and it is what announcements.view is gating.
 *
 * ── Why nearly every read here needs the `user` collection ────────────────
 *
 * GET / and GET /:id both `.populate("author", "name email role")`, and GET /:id
 * populates `readBy.user` and `acknowledgedBy.user` as well. populate() yields
 * null when it cannot resolve a ref — so a mirror missing the author's row would
 * answer `author: null` where the server answers an object, and there is no way
 * to tell that apart from the case where the server ALSO answers null because
 * the account was deleted.
 *
 * The feed gates `user` on users.manage, which is ADMIN_ROLES. So on a teacher's
 * or a bursar's machine there are no user rows, and these handlers decline
 * rather than guess. In practice the announcement reads answer locally for an
 * administrator and go to the network for everybody else. Declining is the safe
 * half of that: the request behaves exactly as it does today.
 *
 * ── The visibility rules are the endpoint's, including where they look wrong ──
 *
 * Two of them look wrong and are reproduced anyway, because a mirror that
 * disagrees with the server about who may see a notice is a worse and quieter
 * problem than the server's own bug:
 *
 *   GET /:id applies NO tenancy filter and NO isActive/deletedAt filter, so any
 *   signed-in account can fetch a soft-deleted announcement, or one belonging to
 *   another school, by id. The mirror only ever holds this school's rows, so the
 *   cross-school half is simply unreachable here and those ids fall through to
 *   the network.
 *
 *   GET /:id's student and teacher checks read the LEGACY `audience` field only
 *   and ignore `audiences` entirely. Every multi-select row carries the schema
 *   default audience:"all" underneath it, so `isForAll` is true for a notice
 *   written as audiences:["teachers"] — and a student may open it. The list route
 *   guards this (audienceMatch's legacy-only clause); the detail route does not.
 *   Reported upward; reproduced here.
 *
 * ── The order is the endpoint's, and the tie is not ───────────────────────
 *
 * `.sort({ isPinned: -1, createdAt: -1 })` with no third key. Two announcements
 * pinned in the same millisecond have no defined order on either side, so _id
 * breaks the tie locally for stability only — compare that pair by key, not by
 * position.
 */

/**
 * The two roles the router calls admin.
 *
 * Written out as the router writes it — ["super_admin", "school_admin"] — and
 * NOT the ADMIN_ROLES set plus the legacy "admin" string. authenticate()
 * canonicalises "admin" to "school_admin" before any guard sees it, so the
 * third name would match nothing on either side.
 */
const ADMIN_ROLES = ["super_admin", "school_admin"];

/**
 * Ids that are really other endpoints.
 *
 * Express matches the router's static paths first, so a request for
 * /api/announcements/student reaches handleStudentAnnouncements and NEVER the
 * reserved-name guard inside GET /:id. This table has no such ordering
 * guarantee across files, so /:id would answer for it — with an announcement
 * shape where the server sends a paginated student feed.
 *
 * Declining rather than 404ing: "student" is a real endpoint that this file does
 * not mirror, and the other three are the server's own 404 to give.
 */
const RESERVED_IDS = ["student", "stats", "public", "read-all"];

/**
 * Schema defaults, applied when reading ONE announcement.
 *
 * GET /:id is the only endpoint here that answers with a HYDRATED mongoose
 * document (`announcement.toObject()`); GET / and the writes all answer from
 * `.lean()`. Hydration fills in every missing path from its schema default, so
 * a legacy row stored without `priority` comes back from the server as
 * "normal" — while the feed sent the raw document and the mirror has no
 * priority at all. Without this the two answers differ on every field a row
 * predates.
 *
 * `audiences` is deliberately absent: its default is `undefined`, so a row
 * without it stays without it, and that absence is what audienceMatch's
 * legacy-only clause tests.
 */
const DEFAULTS = {
  author:         null,
  authorName:     null,
  authorRole:     null,
  audience:       "all",
  targetClasses:  [],
  subjectId:      null,
  subjectName:    null,
  priority:       "normal",
  isPinned:       false,
  publishAt:      null,
  expiresAt:      null,
  readBy:         [],
  acknowledgedBy: [],
  isActive:       true,
  deletedAt:      null,
  version:        1,
};

const withDefaults = (row) => {
  const out = { ...row };
  for (const [field, value] of Object.entries(DEFAULTS)) {
    if (out[field] === undefined) out[field] = Array.isArray(value) ? [] : value;
  }
  return out;
};

/**
 * An id out of a ref that may or may not be populated — the router's own idOf.
 *
 * It is needed here for a second reason the router does not have. When a PUT is
 * pushed, sync/engine.js copies the endpoint's response into the mirror, and
 * that response has `author` populated to an object. Between the push and the
 * pull of the same cycle the mirrored row therefore holds an object where the
 * feed puts a string. Reading it with idOf means that window answers the same
 * as any other, instead of declining because String({}) resolves nothing.
 */
const idOf = (ref) => {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return (ref._id ?? ref.id ?? ref)?.toString() ?? null;
};

/** parseInt, as the endpoint parses these — "3abc" is 3 there and must be here. */
const intOr = (raw, fallback) =>
  raw === undefined ? fallback : Number.parseInt(String(raw), 10);

/**
 * page and limit, or nothing.
 *
 * `?page=` is an empty string, which parseInt makes NaN, which the endpoint
 * hands to .skip() — a 500 from the driver. Raising that is the server's job,
 * so the request goes out rather than being answered differently here.
 */
const paging = (query) => {
  const page  = intOr(query.page, 1);
  const limit = intOr(query.limit, 50);
  if (!Number.isFinite(page) || !Number.isFinite(limit)) return null;
  if (page < 1 || limit < 1) return null;
  return { page, limit, skip: (page - 1) * limit };
};

/** The fields a `.select("a b c")` would have sent, and only those. */
const project = (row, fields) => {
  const out = { _id: row._id };
  for (const field of fields) {
    // `field in row` rather than a null test: a stored null is sent as null and
    // an absent field is absent, and the class fixtures have no `section` at
    // all — so a handler that emitted `section: null` would differ on every
    // class-targeted announcement.
    if (field in row) out[field] = row[field];
  }
  return out;
};

/**
 * populate("author", "name email role").
 *
 * Returns { resolved: false } when the ref names a row the mirror does not
 * hold. The caller declines on that: `author: null` is also what the server
 * answers for an account that was deleted, and answering it for an account that
 * merely was not mirrored would put a wrong author on the screen with nothing
 * to reveal it.
 */
const populateAuthor = (docs, ref) => {
  const id = idOf(ref);
  if (!id) return { resolved: true, value: null };
  const user = docs.get("user", id);
  if (!user) return { resolved: false, value: null };
  return { resolved: true, value: project(user, ["name", "email", "role"]) };
};

/**
 * populate("targetClasses", "name section").
 *
 * Mongoose DROPS an id it cannot resolve from a populated array, so the server's
 * array can be shorter than the stored one. Null here means "cannot tell whether
 * the server would have dropped it" and the caller declines.
 */
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

/**
 * populate("readBy.user", "name") — a ref inside a subdocument array.
 *
 * Unlike an array of refs, an unresolvable one here is left as null rather than
 * dropped, so the row survives with no name on it. Same rule: the mirror cannot
 * tell that from a deleted account, so null means decline.
 */
const populateReceipts = (docs, rows, stamp) => {
  const out = [];
  for (const row of rows ?? []) {
    const id   = idOf(row.user);
    const user = id ? docs.get("user", id) : null;
    if (!user) return null;
    out.push({ user: project(user, ["name"]), [stamp]: row[stamp] });
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIENCE MATCHING
//
// A port of Announcement.audienceMatch(), condition for condition, in the same
// order and with the same names. It is written as separate predicates rather
// than one boolean so that a change on the server can be checked against it by
// reading down the list.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `$or: [{ audiences: { $size: 0 } }, { audiences: { $exists: false } }]`
 * clause the legacy conditions carry.
 *
 * It is what stops a multi-select row being judged by its legacy field: every
 * such row also has audience:"all" sitting underneath it from the schema
 * default, so without this a staff-only notice would match every reader.
 */
const legacyOnly = (row) =>
  !Array.isArray(row.audiences) || row.audiences.length === 0;

/** `{ audiences: audience, $or: [{ targetClasses: { $size: 0 } }, … ] }` */
const unscopedNew = (row, audience) =>
  Array.isArray(row.audiences) &&
  row.audiences.includes(audience) &&
  (row.targetClasses === undefined ||
    (Array.isArray(row.targetClasses) && row.targetClasses.length === 0));

/** `{ audiences: audience, targetClasses: classId }` */
const scopedNew = (row, audience, classId) =>
  Array.isArray(row.audiences) &&
  row.audiences.includes(audience) &&
  Array.isArray(row.targetClasses) &&
  row.targetClasses.map(idOf).includes(classId);

/**
 * The conditions Announcement.audienceMatch returns, as { audience?, test }
 * pairs.
 *
 * The `audience` key is carried because the list route FILTERS this array by it
 * — `teacherConditions.filter((c) => !c.audience || c.audience === filter.audience)`
 * — and a port that flattened the conditions into one predicate could not
 * reproduce that step.
 */
const audienceMatch = ({ audience, classId }) => {
  const conditions = [
    { audience: null,      test: (row) => unscopedNew(row, audience) },
    { audience: "all",     test: (row) => row.audience === "all" && legacyOnly(row) },
    { audience,            test: (row) => row.audience === audience && legacyOnly(row) },
  ];

  if (classId) {
    conditions.push({
      audience: "class",
      test: (row) =>
        row.audience === "class" &&
        Array.isArray(row.targetClasses) &&
        row.targetClasses.map(idOf).includes(classId) &&
        legacyOnly(row),
    });
    conditions.push({ audience: null, test: (row) => scopedNew(row, audience, classId) });
  }

  return conditions;
};

// ─────────────────────────────────────────────────────────────────────────────
// ENRICHMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * enrichForUser(), including the two things about it that are easy to get wrong.
 *
 * The author is EXCLUDED from readCount — they get an ordinary receipt now so
 * their own announcement can be dismissed from the bell, and counting it would
 * make "N read" mean "N read, plus me".
 *
 * And the count is of DISTINCT users, not of receipt rows: the read-modify-save
 * this endpoint used to do could write the same user twice, there are such rows
 * in existing data, and a duplicate would inflate the label.
 */
const enrichForUser = (row, userId, isAdmin) => {
  const enriched = {
    ...row,
    isRead:         (row.readBy         ?? []).some((r) => idOf(r.user) === userId),
    isAcknowledged: (row.acknowledgedBy ?? []).some((r) => idOf(r.user) === userId),
  };

  if (isAdmin) {
    const authorId = idOf(row.author);
    const distinct = (rows) => {
      const seen = new Set();
      for (const receipt of rows ?? []) {
        const id = idOf(receipt.user);
        if (id && id !== authorId) seen.add(id);
      }
      return seen.size;
    };
    enriched.readCount         = distinct(row.readBy);
    enriched.acknowledgedCount = distinct(row.acknowledgedBy);
  } else {
    delete enriched.readBy;
    delete enriched.acknowledgedBy;
    delete enriched.readCount;
    delete enriched.acknowledgedCount;
  }

  return enriched;
};

/** The isLive virtual, which only GET /:id exposes (it is the only hydrated read). */
const isLiveOf = (row) => {
  const now = new Date();
  if (row.publishAt && new Date(row.publishAt) > now) return false;
  if (row.expiresAt && new Date(row.expiresAt) < now) return false;
  return row.isActive && !row.deletedAt;
};

/**
 * isPinned first, then newest — and _id only to settle a tie the server leaves
 * open.
 *
 * A missing createdAt sorts last, which is where Mongo puts a missing value on a
 * descending sort. Compared as strings because the mirror holds ISO-8601 with
 * milliseconds and a Z, which collates in the same order as the dates it spells.
 */
const byPinnedThenNewest = (a, b) => {
  // Three ranks, not two. Mongo orders missing/null below false below true, so a
  // descending sort puts pinned first, then unpinned, then rows stored before
  // isPinned existed — and collapsing the last two into one would reorder a
  // page for a school with legacy rows in it.
  const rank = (row) => (row.isPinned === undefined || row.isPinned === null ? 0 : row.isPinned ? 2 : 1);
  const ap = rank(a);
  const bp = rank(b);
  if (ap !== bp) return bp - ap;

  const ac = String(a.createdAt ?? "");
  const bc = String(b.createdAt ?? "");
  if (ac !== bc) return bc.localeCompare(ac);

  return String(a._id).localeCompare(String(b._id));
};

const ok = (data) => ({ status: 200, data });

module.exports = [
  {
    // Before GET /:id in this file for the same reason the router declares it
    // first: three segments cannot match a one-segment :id, but the order says
    // out loud which one is meant to win.
    route: "GET /api/announcements/stats/summary",

    /**
     * The five tiles on the announcements screen.
     *
     * Answerable entirely from the mirror: they are counts over the local
     * announcement rows with no join and no per-user state.
     *
     * `thisMonth` is thirty days, not a calendar month. Named for what the
     * screen calls it rather than for what it counts, which is the endpoint's
     * choice and not one to correct here.
     */
    handler: (_req, { docs, session }) => {
      const schoolId = session?.schoolId;
      if (!schoolId) return null;

      // adminOnly = requirePermission("announcements.manage"). Refusing is the
      // server's to do; this only declines to answer in its place.
      if (!session.permissions?.includes("announcements.manage")) return null;

      const base = { schoolId, isActive: true, deletedAt: null };
      const thirtyDaysAgo =
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      return ok({
        success: true,
        data: {
          total:        docs.count("announcement", base),
          thisMonth:    docs.count("announcement", { ...base, createdAt: { gte: thirtyDaysAgo } }),
          urgent:       docs.count("announcement", { ...base, priority: "urgent" }),
          pinned:       docs.count("announcement", { ...base, isPinned: true }),
          fromTeachers: docs.count("announcement", { ...base, authorRole: "teacher" }),
        },
      });
    },
  },

  {
    route: "GET /api/announcements",

    /**
     * The console's list.
     *
     * ── schoolId comes from the session and NOWHERE else ───────────────────
     *
     * The endpoint reads req.user.schoolId and ignores any schoolId in the query
     * string. So does this — a handler that honoured the query parameter would
     * answer for a school the server would not.
     *
     * ── An admin and a teacher are asked two different questions ───────────
     *
     * An admin gets the school's announcements unfiltered. A teacher gets the
     * ones addressed to teachers plus the ones they wrote, and the endpoint
     * builds that with audienceMatch — reproduced above.
     *
     * Two things about the teacher branch look wrong and are reproduced:
     *
     *   ?audience=… does not really filter for them. The endpoint keeps every
     *   condition with no `audience` key, which is the multi-select clause and
     *   the "I wrote it" clause, so a teacher asking for students' notices still
     *   receives staff ones. They were allowed to see those anyway, so it is a
     *   filter that does not filter rather than a leak.
     *
     *   ?authorRole=… is ignored for them entirely (`if (authorRole && isAdmin)`).
     *
     * And one about the ADMIN branch: the audience filter tests the legacy
     * `audience` field only, so ?audience=students matches nothing written with
     * the multi-select picker — every such row has audience:"all" underneath.
     * Reported upward.
     */
    handler: ({ query }, { docs, session }) => {
      const userId   = session?.userId;
      const schoolId = session?.schoolId;
      if (!userId || !schoolId) return null;

      // adminOrTeacher = requirePermission("announcements.create"). A bursar
      // holds announcements.view — so they mirror these rows — and does NOT hold
      // create, so the server answers them 403 on this route.
      if (!session.permissions?.includes("announcements.create")) return null;

      const page = paging(query);
      if (!page) return null;

      const isAdmin = ADMIN_ROLES.includes(session.role);

      const filter = { schoolId, isActive: true, deletedAt: null };

      if (query.since) {
        const since = new Date(String(query.since));
        // The endpoint hands an Invalid Date to Mongo, which casts and throws.
        // Its 500 to raise, not a different answer to give.
        if (Number.isNaN(since.getTime())) return null;
        filter.updatedAt = { gte: since.toISOString() };
      }
      if (query.priority)  filter.priority  = String(query.priority);
      if (query.subjectId) filter.subjectId = String(query.subjectId);

      const audience =
        query.audience && query.audience !== "all" ? String(query.audience) : null;

      if (query.authorRole && isAdmin) filter.authorRole = String(query.authorRole);

      // For an admin the audience narrows the query. For a teacher it is folded
      // into the $or below and then DELETED from the filter, so it must not be
      // applied here.
      if (isAdmin && audience) filter.audience = audience;

      let rows = docs.find("announcement", filter);

      if (!isAdmin) {
        const conditions = [
          ...audienceMatch({ audience: "teachers" }),
          { audience: null, test: (row) => idOf(row.author) === userId },
        ];

        // filter((c) => !c.audience || c.audience === filter.audience), which
        // drops the legacy "all" and "teachers" clauses and keeps the rest.
        const kept = audience
          ? conditions.filter((c) => !c.audience || c.audience === audience)
          : conditions;

        rows = rows.filter((row) => kept.some((c) => c.test(row)));
      }

      const total   = rows.length;
      const ordered = rows.slice().sort(byPinnedThenNewest);
      const slice   = ordered.slice(page.skip, page.skip + page.limit);

      // Populated for the PAGE only, as the endpoint does — a row nobody is
      // being shown is a row whose author the server never resolved either.
      const enriched = [];
      for (const row of slice) {
        const author = populateAuthor(docs, row.author);
        if (!author.resolved) return null;          // see the file note

        const targetClasses = populateClasses(docs, row.targetClasses);
        if (targetClasses === null) return null;

        enriched.push(
          enrichForUser(
            { ...row, author: author.value, targetClasses },
            userId,
            isAdmin
          )
        );
      }

      // `announcements` and `data` are the same list under two names, which is
      // what the endpoint sends and what two different screens read.
      return ok({
        success:       true,
        announcements: enriched,
        data:          enriched,
        pagination: {
          page:  page.page,
          limit: page.limit,
          total,
          pages: Math.ceil(total / page.limit),
        },
      });
    },
  },

  {
    route: "GET /api/announcements/:id",

    /**
     * One announcement, with its receipts.
     *
     * ── The only hydrated read in this file ────────────────────────────────
     *
     * It answers with `announcement.toObject()` and the schema sets
     * toObject: { virtuals: true }, so the response carries three fields no
     * other announcement response has: `id`, `isLive`, and — before
     * enrichForUser overwrites or deletes them — the readCount virtuals. It is
     * also the only read that goes through mongoose hydration, which fills in
     * schema defaults the feed never sent. Both are reproduced above.
     *
     * ── What it does not filter ────────────────────────────────────────────
     *
     * Not isActive, not deletedAt, not schoolId. A soft-deleted announcement is
     * still readable by id, by anyone signed in, in any school. The first is
     * reproduced. The last is unreachable here — the mirror holds one school —
     * so those ids fall through to the network, and the tenancy check below is a
     * belt this endpoint does not wear.
     */
    handler: ({ params }, { docs, session }) => {
      const userId = session?.userId;
      const role   = session?.role;
      if (!userId || !role) return null;
      if (RESERVED_IDS.includes(params.id)) return null;

      const stored = docs.get("announcement", String(params.id));
      if (!stored) return null;                     // the server's 404 to give

      // Not the endpoint's rule — it has none. The mirror is single-tenant, so
      // this can only fire on a machine that changed schools, and declining
      // sends the request to the server that does allow it.
      if (session.schoolId && String(stored.schoolId) !== String(session.schoolId)) {
        return null;
      }

      const row     = withDefaults(stored);
      const isAdmin = ADMIN_ROLES.includes(role);

      /**
       * ── The visibility checks, ignoring `audiences` exactly as they do ────
       *
       * A student is allowed through when audience is "all", "students", or a
       * class they are in. A teacher when they wrote it, or audience is "all" or
       * "teachers", or it is class-scoped to a class they teach. A bursar or an
       * admin is not checked at all.
       *
       * `audiences` is never consulted. Since every multi-select row keeps
       * audience:"all" from the schema default, `isForAll` is true for a notice
       * addressed only to teachers — so a student who has its id may read it.
       * That is the endpoint's behaviour and this reproduces it; it is the first
       * item in the report that goes with this file.
       */
      if (role === "student") {
        // resolveStudentClassId reads the Student collection and then falls back
        // to User.classId. A student holds neither students.view nor
        // announcements.view, so a student's mirror has no announcements to
        // reach this line and no rows to answer it with. Declining says so
        // rather than pretending.
        return null;
      }

      if (role === "teacher") {
        const isOwn         = idOf(row.author) === userId;
        const isForAll      = row.audience === "all";
        const isForTeachers = row.audience === "teachers";

        if (!isOwn && !isForAll && !isForTeachers) {
          // The remaining case is audience:"class" scoped to a class they teach,
          // which needs resolveTeacherClassIds: TeacherAssignment, and then
          // User.assignedClasses when there are none. The feed gates
          // teacherAssignment on subjects.view and user on users.manage, both
          // ADMIN_ROLES, so a teacher's machine holds neither and cannot decide
          // this. Guessing either way is wrong — allow and it is a leak, refuse
          // and a teacher cannot open their own class's notice.
          return null;
        }
      }

      const author = populateAuthor(docs, row.author);
      if (!author.resolved) return null;

      const targetClasses = populateClasses(docs, row.targetClasses);
      if (targetClasses === null) return null;

      const populated = { ...row, author: author.value, targetClasses };

      // readBy.user and acknowledgedBy.user are populated by the endpoint and
      // then DELETED again for anybody who is not an admin, so resolving them
      // for a teacher would decline over a field they were never going to see.
      if (isAdmin) {
        const readBy = populateReceipts(docs, row.readBy, "readAt");
        if (readBy === null) return null;
        const acknowledgedBy = populateReceipts(docs, row.acknowledgedBy, "acknowledgedAt");
        if (acknowledgedBy === null) return null;
        populated.readBy         = readBy;
        populated.acknowledgedBy = acknowledgedBy;
      }

      // The virtuals toObject exposes. readCount and acknowledgedCount are also
      // virtuals, and enrichForUser replaces them for an admin and removes them
      // for everybody else — so they are never set from here.
      populated.id     = String(row._id);
      populated.isLive = isLiveOf(row);

      const enriched = enrichForUser(populated, userId, isAdmin);

      return ok({ success: true, data: enriched, announcement: enriched });
    },
  },
];
