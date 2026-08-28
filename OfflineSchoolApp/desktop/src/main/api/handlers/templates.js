// desktop/src/main/api/handlers/templates.js
"use strict";

/**
 * Report-card templates.
 *
 * ── Per school, and only per school ───────────────────────────────────────
 *
 * There is no global template and no system default row: ReportTemplate.schoolId
 * is `required: true`, and every query in template.routes.js filters on it. A
 * school sees exactly its own non-deleted templates, so there is no
 * "can a school edit the shared one" question to reproduce. What a school does
 * have is a BUILT-IN layout — backend/src/print/defaultReportTemplate.js — which
 * is code rather than a row, and POST /seed-default is the button that copies it
 * into an editable row. That is why seeding is mostly online-only below: the blob
 * lives in the server package and this machine does not hold it.
 *
 * ── The whole router is reports.manage ────────────────────────────────────
 *
 * `router.use(requirePermission("reports.manage"))` — one guard over every
 * endpoint, held by admins only and NOT delegable, so a bursar and a teacher get
 * 403 on all nine. The feed gates the collection on the same key, so their
 * machines normally hold no templates at all; the check is still made here for
 * the reason results.js gives about published marks — a machine that pulled as an
 * admin and is now being read by a bursar still has the rows on disk, and the
 * feed decides what is stored while this decides what is drawn.
 *
 * ── Two POSTs are answered here, not in writes/ ───────────────────────────
 *
 * POST /:id/preview and POST /seed-default are reads wearing a POST. Neither
 * writes anything on the server in the branches mirrored below, so queueing a
 * request for them would put an entry in the outbox that changes nothing and can
 * only fail. They belong with the reads, and the dispatcher's read path — answer
 * and stop — is the correct shape for them.
 *
 * ── The list carries the whole template, HTML and all ─────────────────────
 *
 * GET / has no `.select()`, so every list load ships the full html and css of
 * every template. The screen reads five fields of it (name, isDefault, version,
 * variables, updatedAt). The seeded layout is about ten kilobytes, so a school
 * with a handful of templates is tens of kilobytes a page load rather than a
 * problem — worth knowing, not worth diverging over. The mirror answers with the
 * whole document because that is what the server sends.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/** The name POST /seed-default recognises its own row by. Exactly this string. */
const SEED_TEMPLATE_NAME = "Default Report Card";

/**
 * resolveSchoolId() from template.routes.js, verbatim in behaviour.
 *
 * Note what it does NOT do: for anybody who is not a super_admin the schoolId in
 * the request is IGNORED and the token's own is used. So a school admin who
 * passes another school's id reads their own school, and a handler that trusted
 * `query.schoolId` would answer for a school the server would never have shown
 * them.
 */
const resolveSchoolId = (session, provided) => {
  if (session?.role === "super_admin" && provided) return String(provided).trim();
  return session?.schoolId ? String(session.schoolId) : null;
};

/** The router's single guard. Without it there is nothing to answer with. */
const mayManage = (session) =>
  Array.isArray(session?.permissions) && session.permissions.includes("reports.manage");

/**
 * One template, as findOne({ _id, schoolId, deletedAt: null }) would find it.
 *
 * Nothing rather than a local 404: every 404 in this router carries
 * { success: false, error: "Template not found" }, and a screen cannot tell that
 * apart from "this machine has not pulled it yet". The server gets to answer.
 */
const target = (docs, id, schoolId) => {
  const row = docs.get("reportTemplate", String(id));
  if (!row) return null;
  if (String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

/**
 * `.sort({ isDefault: -1, updatedAt: -1 })`, plus a tie-break the server has not
 * got.
 *
 * isDefault first, descending: Mongo orders null/missing below false below true,
 * so reversed that is true, false, missing. A row inserted without the field —
 * which the schema default would normally supply — therefore sorts LAST, not
 * with the falses.
 *
 * The tie-break is not decoration. PATCH /:id/default clears the flag with an
 * `updateMany`, and mongoose adds `$set: { updatedAt: now }` to update queries —
 * so setting a default stamps ONE timestamp onto every remaining template of the
 * school at once. Their updatedAt values then tie exactly, `{ updatedAt: -1 }`
 * has nothing left to order them by, and the server's own list can come back in
 * a different order for two identical requests. A mirror cannot reproduce an
 * order that is not defined; what it can do is not reshuffle between renders,
 * which is what _id buys. Where the two differ they differ only inside a tie.
 */
const listOrder = (rows) => {
  const rank = (t) => (t.isDefault === true ? 2 : t.isDefault === false ? 1 : 0);

  return rows.slice().sort((a, b) => {
    const byDefault = rank(b) - rank(a);
    if (byDefault !== 0) return byDefault;

    const au = String(a.updatedAt ?? "");
    const bu = String(b.updatedAt ?? "");
    if (au !== bu) return bu.localeCompare(au);

    return String(a._id).localeCompare(String(b._id));
  });
};

module.exports = [
  {
    route: "GET /api/templates",

    /**
     * Every template the school has, default first.
     *
     * The 400 for a missing schoolId is left to the server, as elsewhere in this
     * layer: reproducing it would be a second implementation of one validation.
     */
    handler: ({ query }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const templates = listOrder(
        docs.find("reportTemplate", { schoolId, deletedAt: null })
      );

      return ok({ count: templates.length, templates });
    },
  },

  {
    route: "GET /api/templates/:id",

    /**
     * One template, with its html and css — this is what the builder loads.
     *
     * ── The schoolId guard is missing on the server, and is applied here ────
     *
     * GET / and POST /seed-default both answer 400 when no schoolId resolves.
     * This one does not check, so for a caller whose token carries no schoolId
     * the filter becomes `{ _id, schoolId: undefined, deletedAt: null }` —
     * mongoose strips the undefined and the lookup matches on _id alone, ACROSS
     * SCHOOLS. Only a super_admin who omits ?schoolId= can reach it, so it is a
     * hole with one occupant rather than a leak, but it is a hole. Reported
     * rather than reproduced: declining here costs that one caller a local
     * answer, and the alternative is a handler that reads another school's
     * template on purpose.
     *
     * This route also matches /api/templates/default and /api/templates/tokens,
     * which the console does not call and which are real endpoints on the server.
     * Both fall through safely, because an id nothing in the mirror answers to
     * declines and goes to the network.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const template = target(docs, params.id, schoolId);
      if (!template) return null;

      return ok({ template });
    },
  },

  {
    route: "POST /api/templates/:id/preview",

    /**
     * The layout with its placeholders still showing.
     *
     * ── Only the raw branch ────────────────────────────────────────────────
     *
     * With examId AND studentId the endpoint loads that pupil's marks and runs
     * them through backend/engine/placeholder.engine.js — 600 lines of
     * conditionals, loops, subject tables, photo and QR substitution. A second
     * copy of that in the desktop would drift from the one that actually prints
     * report cards, and a preview that disagrees with the print is worse than no
     * preview: the admin approves a layout they have not seen. So that branch
     * goes to the network.
     *
     * Without them the endpoint does no rendering at all — it concatenates the
     * css and the html and says isRaw. That is the branch the console uses: the
     * only navigation to /reports/preview is `?id=<template>` with no exam and no
     * pupil, so mirroring this covers the preview button on the templates screen.
     *
     * Nothing is queued. The endpoint writes nothing in either branch, and an
     * outbox entry for a preview could only fail later for no purpose.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, body.schoolId);
      if (!schoolId) return null;

      const template = target(docs, params.id, schoolId);
      if (!template) return null;

      // Both, as the endpoint tests them — one alone still takes the raw branch.
      if (body.examId && body.studentId) return null;

      return ok({
        isRaw:        true,
        templateName: template.name,
        // The endpoint's own concatenation, character for character. An absent
        // css becomes an empty <style>, which is what the server sends too.
        renderedHtml: `<style>${template.css || ""}</style>${template.html}`,
      });
    },
  },

  {
    route: "POST /api/templates/seed-default",

    /**
     * "Start from the built-in layout" — the idempotent half of it.
     *
     * The endpoint has two branches. The second CREATES a row holding
     * DEFAULT_TEMPLATE_HTML and DEFAULT_TEMPLATE_CSS, which live in the server
     * package and are not mirrored anywhere; this machine cannot write a row
     * whose content it does not have, and inventing a layout would put a
     * different report card in front of a parent than the school approved. So
     * that branch is online-only.
     *
     * The first branch is a pure read: a school that already has a template named
     * exactly "Default Report Card" gets that row back with created: false and
     * nothing is written. That is the branch a second press of the button takes,
     * and it is answerable here.
     *
     * ── Why more than one match declines ───────────────────────────────────
     *
     * There is no unique index on (schoolId, name) — nothing stops a school
     * having two templates called "Default Report Card", and POST / will happily
     * create one. The endpoint uses findOne with no sort, so WHICH of them comes
     * back is the storage engine's choice and not a promise. Rather than pick
     * one and be right by luck, this declines and lets the server answer.
     */
    handler: ({ body }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, body.schoolId);
      if (!schoolId) return null;

      const matches = docs.find("reportTemplate", {
        schoolId,
        name:      SEED_TEMPLATE_NAME,
        deletedAt: null,
      });

      if (matches.length !== 1) return null;

      // 200, not 201: the created branch is the one that answers 201, and a
      // screen reading `created` to decide whether to say "already exists" is
      // reading this exact pair.
      return {
        status: 200,
        data:   { success: true, created: false, template: matches[0] },
      };
    },
  },
];
