// desktop/src/main/api/handlers/settings.js
"use strict";

/**
 * The settings screens, read offline: the office accounts, the grading scale,
 * and what an ID card says.
 *
 * ── What is deliberately NOT in this file ─────────────────────────────────
 *
 * Creating an admin, removing one and resetting a password. All three are
 * online-only and the reasons are recorded in coverage.js. Briefly, because it
 * is the kind of decision somebody will want to reopen:
 *
 *   · A create and a reset both hand back a TEMPORARY PASSWORD the server
 *     invented, and the screen shows it so the office can pass it on. There is
 *     no honest local answer to that — an invented one is a credential that
 *     will not work, written on a piece of paper.
 *   · Both also send an email. Somebody who presses the button and sees it
 *     succeed has been told the email went.
 *   · Removing an admin revokes access to the school's records. "Removed" on
 *     the screen while the account still signs in is the one thing that button
 *     must never mean.
 *
 * GET /admin/settings/analytics is online-only too, and PUT
 * /admin/settings/profile — again with the reasoning in coverage.js.
 *
 * ── The one filter reproduced exactly rather than sensibly ────────────────
 *
 * resolveSchoolId() on the server IGNORES ?schoolId for anybody who is not a
 * super_admin: it answers req.user.schoolId regardless. The sibling handlers in
 * this directory take the query parameter when it is present, which for an
 * ordinary admin passing somebody else's schoolId would ask the mirror a
 * question the server would never have asked. Reproduced properly here.
 */

/**
 * The set of roles the settings screen lists, creates and suspends.
 *
 * A copy of OFFICE_ROLES from backend/src/config/roles.js, as handlers/results.js
 * keeps its own copy of ADMIN_ROLES. Worth knowing what a drift would do: a role
 * missing here is an account the offline list silently does not show, and the
 * bursar is in this set — so the person who handles the school's money is
 * exactly who would disappear.
 */
const OFFICE_ROLES = ["super_admin", "school_admin", "bursar"];

/**
 * The shipped grading scale, returned when a school has never saved one.
 *
 * A copy of DEFAULT_GRADES in backend/src/routes/admin.routes.js. This one is
 * NOT harmless duplication: these bands are what results.controller.js turns a
 * percentage into a letter and a remark with, so a drifted copy would print a
 * different grade on a desktop report card than the school's own server would.
 * It belongs in shared/ and is proposed there; until then the parity check
 * compares this table against the server's for a school with no config, which
 * is what would catch the drift.
 */
const DEFAULT_GRADES = [
  { grade: "A+", minMark:  90, maxMark: 100, gpaPoints: 4.0, remark: "Excellent"     },
  { grade: "A",  minMark:  80, maxMark:  89, gpaPoints: 4.0, remark: "Very Good"     },
  { grade: "B+", minMark:  75, maxMark:  79, gpaPoints: 3.5, remark: "Good"          },
  { grade: "B",  minMark:  70, maxMark:  74, gpaPoints: 3.0, remark: "Above Average" },
  { grade: "C+", minMark:  65, maxMark:  69, gpaPoints: 2.5, remark: "Average"       },
  { grade: "C",  minMark:  60, maxMark:  64, gpaPoints: 2.0, remark: "Satisfactory"  },
  { grade: "D",  minMark:  50, maxMark:  59, gpaPoints: 1.0, remark: "Pass"          },
  { grade: "F",  minMark:   0, maxMark:  49, gpaPoints: 0.0, remark: "Fail"          },
];

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * Which school this request is about, as resolveSchoolId() decides it.
 *
 * The query parameter counts for a super_admin and for nobody else. Returns
 * null when there is no session to ask, which declines: a handler that fell
 * back to the query would answer for whichever school the caller named.
 */
const resolveSchoolId = (provided, session) => {
  if (session?.role === "super_admin" && provided) return String(provided).trim();
  return session?.schoolId ? String(session.schoolId) : null;
};

/** The local flag, off the way out. The server never sends it. */
const withoutPending = (row) => {
  if (!row) return row;
  const { _pending, ...rest } = row;
  return rest;
};

// ─────────────────────────────────────────────────────────────────────────────
// ID CARD EXPIRY
//
// A reimplementation of backend/src/utils/idCardExpiry.js, whose own header says
// two copies of this arithmetic would drift and that the drift would only show
// up on a card already in a child's pocket. That file is in backend/src/utils
// and the desktop cannot require it, so the copy is here and moving the original
// into shared/ is proposed. Until it moves, the parity check on GET
// /admin/settings/id-card is the only thing holding the two together.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The end of the academic year a school is currently in.
 *
 * Noon UTC rather than midnight, as the original: this is a calendar day, and
 * midnight lands on the day before for anyone west of UTC once formatted.
 */
const academicYearEnd = (academicYear) => {
  const match = /(\d{4})\s*[/-]\s*(\d{4})/.exec(String(academicYear ?? ""));
  if (match) return new Date(Date.UTC(Number(match[2]), 7, 31, 12));

  const now = new Date();
  const endYear = now.getUTCMonth() >= 8
    ? now.getUTCFullYear() + 1
    : now.getUTCFullYear();
  return new Date(Date.UTC(endYear, 7, 31, 12));
};

/** A YYYY-MM-DD string as a Date at noon UTC, or null if it is not one. */
const parseDay = (value) => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!day) return null;

  const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12));
  // Rejects 2026-02-30, which the constructor rolls forward to 2 March rather
  // than refusing.
  return Number.isNaN(date.getTime())
      || date.getUTCMonth() !== Number(day[2]) - 1
      || date.getUTCDate() !== Number(day[3])
    ? null
    : date;
};

/**
 * The date that would actually be printed.
 *
 * `school.academicYear`, exactly as the original reads it — and on a School
 * document that field DOES NOT EXIST. The schema puts academicYear inside
 * settings, so this always falls through to the calendar. That is a server bug,
 * not a transcription slip; it is reported, and reproduced here because a mirror
 * that quietly printed a different date from the server's own settings screen
 * would be the worse of the two problems. See the note on the id-card handler.
 */
const expiryFor = (school) =>
  parseDay(school?.settings?.idCardValidUntil) ?? academicYearEnd(school?.academicYear);

/** YYYY-MM-DD, for handing a date back to a date input. */
const toDayString = (date) => date.toISOString().slice(0, 10);

/**
 * The { idCard, gate } block both the GET and the PUT answer with.
 *
 * One function because the two endpoints build it from identical code, and a
 * second copy here would be a third place for the defaults to drift.
 */
const idCardView = (school) => {
  const settings = school.settings ?? {};

  return {
    idCard: {
      validUntil:        settings.idCardValidUntil || "",
      defaultValidUntil: toDayString(academicYearEnd(school.academicYear
                                                     ?? settings.academicYear)),
      effectiveValidUntil: toDayString(expiryFor(school)),
    },
    gate: {
      notify:      settings.gateNotify      ?? "exceptions",
      lateAfter:   settings.gateLateAfter   ?? "07:45",
      earlyBefore: settings.gateEarlyBefore ?? "14:00",
    },
  };
};

module.exports = [
  {
    route: "GET /api/admin/settings/admins",

    /**
     * The office accounts: the admins and the bursar.
     *
     * ── Every part of this filter is a decision, including two absences ────
     *
     *   · role IN OFFICE_ROLES. Teachers are a different screen, and a bursar
     *     IS listed here — this is where an account with school-wide authority
     *     is created and suspended, and a bursar is one of those.
     *
     *   · isActive: true by DEFAULT, and strictly true rather than "not false".
     *     A row that never had the field fails it, and that is the endpoint's
     *     behaviour, not an accident of this translation: statusFilter() writes
     *     { isActive: true }. Two endpoints in admin.routes.js read this field
     *     the two different ways, so it cannot be inferred.
     *
     *   · NO deletedAt filter. The endpoint applies none, so a soft-deleted
     *     office account is still listed. It looks like an oversight and is not
     *     mine to correct — a mirror that showed fewer accounts than the server
     *     is a silent disagreement about who can get into the school's records.
     *
     *   · password and tempPassword REMOVED, because .select() removes them.
     *     Not left to the sync feed's `omit`: the projection is this endpoint's
     *     contract, and tempPassword is not select:false on the model, so it is
     *     a field that genuinely travels unless something drops it. A temporary
     *     password handed to a screen is a credential on a screen.
     *
     * ── The order is not the server's, and cannot be ──────────────────────
     *
     * The endpoint has no .sort(). Mongo answers in storage order, which is not
     * a promise, and SQLite's is a different non-promise. Sorted by _id here so
     * the list does not reshuffle between reads on the same machine — a settings
     * list whose rows move is read as the app being broken. The parity check
     * compares the two sides by key rather than by position, because comparing
     * by position would be asserting something neither side guarantees.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = resolveSchoolId(query.schoolId, session);
      if (!schoolId) return null;

      const status = String(query.status ?? "").toLowerCase();
      const filter = { schoolId, role: { in: OFFICE_ROLES } };
      // statusFilter(): "all" drops the condition, "inactive" inverts it,
      // anything else — including an absent parameter — is active-only.
      if (status === "inactive")   filter.isActive = false;
      else if (status !== "all")   filter.isActive = true;

      const admins = docs.find("user", filter)
        .map((row) => {
          const { password, tempPassword, ...rest } = withoutPending(row);
          return rest;
        })
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));

      return ok({ admins });
    },
  },

  {
    route: "GET /api/admin/settings/grading",

    /**
     * The grading scale.
     *
     * ── Why this one matters more than it looks ───────────────────────────
     *
     * It is not a preferences page. results.controller.js reads this same
     * document to turn a percentage into a letter, a remark and GPA points on
     * every report card — grades.find((g) => pct >= g.minMark && pct <= g.maxMark),
     * FIRST match in array order. So the bands, and the order they are stored
     * in, are the school's marking scheme.
     *
     * ── A school with no config is answered, not declined ─────────────────
     *
     * The endpoint falls back to a shipped default table, so an unconfigured
     * school still gets a scale. Reproduced, from the copy at the top of this
     * file — which is the duplication the note there is about.
     *
     * Nothing distinguishes "this school has not configured grading" from "the
     * gradingConfig collection has not synced yet", and the answer is the same
     * either way: the defaults, which is what the server would say for the first
     * case and what it would not say for the second. Left as it is because
     * declining would take the grading screen offline for every school that has
     * accepted the defaults, which is most of them.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = resolveSchoolId(query.schoolId, session);
      if (!schoolId) return null;

      // findOne({ schoolId }): schoolId carries a unique index, so at most one.
      const stored = docs.find("gradingConfig", { schoolId })[0] ?? null;

      const grading = stored ? withoutPending(stored) : {
        schoolId,
        grades:      DEFAULT_GRADES,
        passMark:    50,
        useGpa:      false,
        gpaScale:    4.0,
        gradingType: "percentage",
      };

      return ok({ grading });
    },
  },

  {
    route: "GET /api/admin/settings/id-card",

    /**
     * What the card says, and what happens when somebody scans it.
     *
     * ── The three dates, and why two of them disagree on the server ───────
     *
     * `validUntil` is what the school typed, "" for "use the default".
     * `defaultValidUntil` is what an empty field means, read from the school's
     * academic year. `effectiveValidUntil` is what would actually be printed.
     *
     * On the server the last two do not agree, and this handler reproduces the
     * disagreement. defaultValidUntil reads
     * `school.academicYear ?? settings.academicYear`; effectiveValidUntil goes
     * through expiryFor(), which reads `school.academicYear` ONLY. School has no
     * top-level academicYear — the schema puts it inside settings — so
     * effectiveValidUntil ignores the school's stated year and falls back to the
     * calendar. Today that means the screen can offer "leave blank and cards
     * expire 2027-08-31" beside an effective date of 2026-08-31.
     *
     * Reported with the file and line. Reproduced rather than fixed because the
     * printing route (documents.routes.js) hands expiryFor a FLATTENED school
     * whose academicYear is at the top level, so it does not have the bug — and
     * a mirror that quietly agreed with the printer while disagreeing with the
     * server's own settings screen would hide the inconsistency instead of
     * showing it.
     *
     * ── A missing school row declines, it does not 404 ────────────────────
     *
     * The endpoint's 404 means "no such school". An absent mirror row means "not
     * synced here yet", which is a different fact, and answering 404 to it would
     * tell an admin their school does not exist.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = resolveSchoolId(query.schoolId, session);
      if (!schoolId) return null;

      const school = docs.get("school", schoolId);
      if (!school) return null;

      return ok(idCardView(withoutPending(school)));
    },
  },
];

// Shared with writes/settings.js, which answers PUT /admin/settings/id-card with
// the same block computed from the school it just changed. Two copies of these
// defaults would be two answers to "what does an empty field mean".
module.exports.idCardView       = idCardView;
module.exports.academicYearEnd  = academicYearEnd;
module.exports.parseDay         = parseDay;
module.exports.toDayString      = toDayString;
module.exports.resolveSchoolId  = resolveSchoolId;
module.exports.withoutPending   = withoutPending;
