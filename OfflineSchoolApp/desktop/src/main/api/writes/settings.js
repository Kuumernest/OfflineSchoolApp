// desktop/src/main/api/writes/settings.js
"use strict";

/**
 * Settings changed with no connection: the grading scale, and the ID card and
 * gate block.
 *
 * ── Why only these two ────────────────────────────────────────────────────
 *
 * The other five writes on the settings screens are online-only, and four of
 * them are not close calls:
 *
 *   POST   /admin/settings/admins              creates an account, emails a
 *                                              temporary password, and answers
 *                                              with that password
 *   POST   /admin/settings/admins/:id/reset-password
 *                                              issues a new password, emails it,
 *                                              and answers with it
 *   DELETE /admin/settings/admins/:id          revokes access to the school's
 *                                              records
 *   PUT    /admin/settings/profile             uniqueness decided by a query
 *                                              over every User in the
 *                                              deployment, which no mirror holds
 *
 * The reasoning for each is in coverage.js. The one worth repeating here,
 * because it is the one somebody will be tempted by, is the DELETE: it is a
 * plain deactivation, it is idempotent, and every condition under which it
 * refuses can be checked locally — so it looks queueable and it is not. An
 * admin removes a colleague because something has gone wrong. "Removed" on the
 * screen while the account still signs in for the rest of the afternoon is
 * exactly what that button must never mean, and it is the same rule already
 * applied to revoking a document's verification and withdrawing guardian access.
 *
 * ── What these two have in common ─────────────────────────────────────────
 *
 * Both are configuration documents: one row per school, edited by an admin,
 * with nothing derived from them that a queue delay would falsify. A grading
 * scale saved at ten o'clock and sent at two has been saved. Nobody was told a
 * message went out and nobody's access changed.
 */

const {
  idCardView,
  parseDay,
  resolveSchoolId,
  withoutPending,
  GRADING_TYPES,
} = require("../handlers/settings");

// The same table and pass mark the read side and the server serve.
const { DEFAULT_PASS_MARK } = require("../../../../../shared/gradeScale");

/**
 * The read handlers export these alongside their route array — the array is what
 * index.js spreads, and the helpers ride on it as named properties.
 *
 * Deliberately one definition rather than two: idCardView() is what an empty
 * validUntil MEANS, and the GET and the PUT have to give the same answer or the
 * screen changes its mind about the default the moment somebody saves.
 *
 * At the top of the file, not inside the handler. A require that throws inside a
 * handler is caught by the dispatcher and becomes "not answered here", so a bad
 * path would quietly send every settings write to the network and look fine.
 */

/**
 * gateNotify's enum, from the settings sub-schema in School.js.
 */
const GATE_NOTIFY = ["off", "exceptions", "all"];

/** As the endpoint's own HHMM constant. Empty is allowed; the schema permits ^$. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A number mongoose would cast without complaint, or null.
 *
 * Deliberately narrower than mongoose's cast: it accepts booleans and Dates too,
 * and reproducing that table here would be a second set of coercion rules to
 * keep in step. Anything this refuses declines, and a decline is a request the
 * server validates properly.
 */
const asNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * One grade band, shaped as the schema stores it, or null if it would not cast.
 *
 * gradeBandSchema declares grade, minMark and maxMark required, gpaPoints
 * default 0 and remark default "" — and `_id: false`, so there is no id on a
 * band. Unknown keys are dropped by strict mode, which is why this builds a
 * fresh object rather than spreading what arrived: a screen that round-trips a
 * loaded band would otherwise store fields the server threw away.
 */
const cleanBand = (band) => {
  if (!band || typeof band !== "object") return null;

  const label = band.grade;
  if (typeof label !== "string" && typeof label !== "number") return null;
  // required on a String path fails for "" and does NOT trim, so " " is a
  // legitimate grade name as far as the server is concerned. Matched exactly.
  if (String(label) === "") return null;

  const minMark = asNumber(band.minMark);
  const maxMark = asNumber(band.maxMark);
  if (minMark === null || maxMark === null) return null;

  const gpaPoints = band.gpaPoints === undefined || band.gpaPoints === null
    ? 0
    : asNumber(band.gpaPoints);
  if (gpaPoints === null) return null;

  // Both remarks. This function is the mirror's whole idea of a band, so a
  // field it does not name is a field a desktop save silently drops — and the
  // French remark is exactly the sort of thing nobody notices going missing
  // until a French report card prints in English.
  const text = (v) => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string" && typeof v !== "number") return null;
    return String(v);
  };
  const remark   = text(band.remark);
  const remarkFr = text(band.remarkFr);
  if (remark === null || remarkFr === null) return null;

  return {
    grade: String(label),
    minMark,
    maxMark,
    gpaPoints,
    remark,
    remarkFr,
  };
};

module.exports = [
  {
    route: "PUT /api/admin/school-info",

    /**
     * Updating the school's profile text fields offline.
     *
     * ── Logo is deliberately excluded ──────────────────────────────────────
     *
     * The logo is written to the server's filesystem via fs.writeFileSync.
     * An offline client cannot replicate that, so logoBase64 is stripped from
     * the queued request. The text fields (name, address, etc.) are a plain
     * findByIdAndUpdate and can be queued safely.
     *
     * ── Only what changed goes out ─────────────────────────────────────────
     *
     * Same rule as PUT /exams: sending the whole document would revert
     * changes made on another machine. The body is sent as-is; the local
     * row is merged.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = resolveSchoolId(body.schoolId, session);
      if (!schoolId) return null;

      if (!session?.permissions?.includes("settings.manage")) return null;

      const school = docs.get("school", schoolId);
      if (!school) return null;

      const FIELDS = [
        "name", "code", "address", "city", "state", "country",
        "phone", "email", "website", "motto",
        "postalCode", "schoolType", "termSystem", "registrationNumber",
        "foundedYear", "principalName", "description",
        "academicYearStart", "academicYearEnd", "schoolDays",
        "schoolStartTime", "schoolEndTime",
        "applicationsOpen", "isActive",
      ];

      const updates = {};
      for (const field of FIELDS) {
        if (body[field] === undefined) continue;
        updates[field] = body[field];
      }
      // The settings screens call the form field `schoolCode`; the server
      // stores `code`. Carry the alias through so an offline edit reaches the
      // server under the name it understands.
      if (body.schoolCode !== undefined && body.code === undefined) {
        updates.code = body.schoolCode;
      }

      if (Object.keys(updates).length === 0) return null;

      const existing = withoutPending(school);
      const doc = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      // Strip logoBase64 from the queued request — the server writes it to
      // the filesystem, which is not queueable.
      const { logoBase64, ...bodyForServer } = body;

      return {
        collection: "school",
        doc,
        request: {
          method: "PUT",
          path:   "/api/admin/school-info",
          body:   bodyForServer,
        },
        response: {
          status: 200,
          data: { success: true, school: doc },
        },
      };
    },
  },

  {
    route: "PUT /api/admin/settings/grading",

    /**
     * Saving the grading scale.
     *
     * ── This is not a preferences page ────────────────────────────────────
     *
     * results.controller.js reads this document for every report card:
     * grades.find((g) => pct >= g.minMark && pct <= g.maxMark), first match in
     * ARRAY ORDER. So the bands and the order they arrive in are the school's
     * marking scheme, and a band written wrong is a letter grade printed wrong
     * on every child's report. That is the reason for the casting below being
     * fussy rather than forgiving: a value that reached the local row in a shape
     * the server would have refused would show one grade offline and another
     * after the sync.
     *
     * ── Why a school with no saved config is DECLINED ─────────────────────
     *
     * The endpoint is an upsert keyed on schoolId, and GradingConfig has a
     * MONGO OBJECTID _id — it is one of the two models in this project that
     * does, School being the other — with no way to supply one: the handler
     * destructures grades, passMark, useGpa, gpaScale and gradingType and never
     * looks at req.body._id.
     *
     * So the first save for a school cannot be queued. If it were, this machine
     * would have to invent an _id; the server's upsert would generate a
     * different one; the push would settle the local row under the invented id;
     * and the next pull would deliver the server's row under its own. The mirror
     * would then hold TWO grading configs for one school, findOne would return
     * whichever SQLite reached first, and the wrong one could be the orphan
     * for ever — a school's marking scheme, permanently ambiguous.
     *
     * Once a config exists this is an ordinary update: the server's
     * findOneAndUpdate({ schoolId }) lands on the same document the local row
     * came from, and there is no second id to invent. Making the first save
     * queueable needs a backend change (accept req.body._id via $setOnInsert, or
     * derive the id from schoolId, which already carries a unique index) and it
     * is reported rather than made here.
     *
     * ── grades absent declines too ────────────────────────────────────────
     *
     * The endpoint substitutes its own DEFAULT_GRADES table for a null or
     * missing `grades`. The console never omits it — it sends the whole config
     * back — so rather than carry a second dependency on a table that lives in a
     * route file, an absent grades array is sent to the server.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = resolveSchoolId(body.schoolId, session);
      if (!schoolId) return null;

      // A queued 403 stops the outbox exactly as a 400 does, and this route is
      // settings.manage.
      if (!session?.permissions?.includes("settings.manage")) return null;

      // See the docstring: an upsert this machine cannot name.
      const existing = docs.find("gradingConfig", { schoolId })[0] ?? null;
      if (!existing) return null;

      if (!Array.isArray(body.grades)) return null;
      const grades = body.grades.map(cleanBand);
      if (grades.some((band) => band === null)) return null;

      // `gradingType || "percentage"`: falsy takes the default, and anything
      // truthy outside the enum is a ValidationError the server would answer
      // with — which is a queue-stopper, so it declines here.
      const gradingType = body.gradingType || "percentage";
      if (!GRADING_TYPES.includes(gradingType)) return null;

      // The shared default and `?? 4.0`, so null takes the default and 0 does
      // NOT. A school that sets a pass mark of zero means it. The literal here
      // used to be 50, from when marks were out of 100.
      const passMark = body.passMark === undefined || body.passMark === null
        ? DEFAULT_PASS_MARK
        : asNumber(body.passMark);
      if (passMark === null) return null;

      const gpaScale = body.gpaScale === undefined || body.gpaScale === null
        ? 4.0
        : asNumber(body.gpaScale);
      if (gpaScale === null) return null;

      // `?? false`. A strict boolean when present: mongoose casts "yes" and 1
      // and a handful of others, and a second copy of that table here would be
      // one more thing to keep in step.
      let useGpa = false;
      if (body.useGpa !== undefined && body.useGpa !== null) {
        if (typeof body.useGpa !== "boolean") return null;
        useGpa = body.useGpa;
      }

      // Same treatment, and defaulting to TRUE rather than false: the server's
      // `showGrades ?? true` means an omitted value turns grades back on, so a
      // mirror that defaulted to false would disagree the moment it synced.
      let showGrades = true;
      if (body.showGrades !== undefined && body.showGrades !== null) {
        if (typeof body.showGrades !== "boolean") return null;
        showGrades = body.showGrades;
      }

      const doc = {
        ...withoutPending(existing),
        schoolId,
        grades,
        passMark,
        showGrades,
        useGpa,
        gpaScale,
        gradingType,
        updatedBy: session?.userId ?? null,
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "gradingConfig",
        doc,
        request: {
          method: "PUT",
          path:   "/api/admin/settings/grading",
          // As it arrived. Sending a rebuilt body would write back values
          // nobody touched and revert whatever a colleague changed from the web
          // in the meantime.
          body,
        },
        /**
         * `id` alongside `_id`, which the GET does not send.
         *
         * The GET answers with a .lean() document and the PUT answers with a
         * mongoose one, and GradingConfig sets toJSON: { virtuals: true } — so
         * res.json() adds the default `id` virtual to the PUT's reply and not to
         * the GET's. Two shapes for one object, from one screen's point of view.
         * Reported; reproduced here because the response body is a contract the
         * screen reads and this layer does not get to tidy it.
         */
        response: {
          status: 200,
          data: { success: true, grading: { ...doc, id: String(doc._id) } },
        },
      };
    },
  },

  {
    route: "PUT /api/admin/settings/id-card",

    /**
     * The expiry date on the card, and how chatty the gate is.
     *
     * ── Every field is optional and only what is present is written ────────
     *
     * The endpoint builds a $set of DOTTED PATHS — "settings.gateNotify" and so
     * on — precisely so that a screen editing one setting cannot blank the
     * others by omitting them. The local merge has to do the same thing to the
     * same document: writing a whole `settings` object would drop currency,
     * timezone, the academic year, the messaging policy and the approval
     * thresholds, and the approval thresholds are what writes/approvals.js and
     * the expense write read to decide whether an expense needs a second
     * signature. Blanking them offline would quietly let unapproved money
     * through.
     *
     * ── An empty string is meaningful ─────────────────────────────────────
     *
     * validUntil: "" is not a missing value — it means "go back to the
     * academic-year default", and the endpoint accepts it. So the test is
     * `!== undefined`, never truthiness. Same for the two gate times.
     *
     * ── reprintRequired ───────────────────────────────────────────────────
     *
     * True whenever validUntil was PRESENT in the body, even if it did not
     * change anything. That is what the endpoint says, and it is saying
     * something useful: this changes cards printed from now on and nothing
     * already laminated.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = resolveSchoolId(body.schoolId, session);
      if (!schoolId) return null;

      if (!session?.permissions?.includes("settings.manage")) return null;

      const { validUntil, gateNotify, gateLateAfter, gateEarlyBefore } = body;
      const changes = {};

      if (validUntil !== undefined) {
        const trimmed = String(validUntil ?? "").trim();
        // parseDay rather than the schema's regex, as the endpoint does: the
        // regex accepts 2026-02-30 and Mongo would then store a day that does
        // not exist.
        if (trimmed && !parseDay(trimmed)) return null;
        changes.idCardValidUntil = trimmed;
      }

      if (gateNotify !== undefined) {
        if (!GATE_NOTIFY.includes(gateNotify)) return null;
        changes.gateNotify = gateNotify;
      }

      for (const [key, value] of [
        ["gateLateAfter", gateLateAfter], ["gateEarlyBefore", gateEarlyBefore],
      ]) {
        if (value === undefined) continue;
        const trimmed = String(value ?? "").trim();
        if (trimmed && !HHMM.test(trimmed)) return null;
        changes[key] = trimmed;
      }

      // The endpoint's "Nothing to update" 400.
      if (Object.keys(changes).length === 0) return null;

      // A missing school row is "not synced here yet", not the endpoint's 404
      // "no such school" — and either way there is nothing to merge onto.
      const school = docs.get("school", schoolId);
      if (!school) return null;

      const existing = withoutPending(school);

      const doc = {
        ...existing,
        settings: { ...(existing.settings ?? {}), ...changes },
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "school",
        doc,
        request: {
          method: "PUT",
          path:   "/api/admin/settings/id-card",
          body,
        },
        // Computed from the merged document, through the same function the GET
        // uses — so the screen sees the same three dates it would see on a
        // reload, including the effectiveValidUntil the server derives the same
        // (wrong) way. See the note in handlers/settings.js.
        response: {
          status: 200,
          data: {
            success: true,
            ...idCardView(doc),
            reprintRequired: validUntil !== undefined,
          },
        },
      };
    },
  },
];
