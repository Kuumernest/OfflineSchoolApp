// backend/src/controllers/syncFeed.controller.js
"use strict";

/**
 * The change feed an offline client mirrors from.
 *
 *   GET /api/sync/changes?collections=student,feeCharge&cursor=<json>&limit=500
 *
 * ── Why a new endpoint rather than extending /sync/pull ───────────────────
 *
 * /sync/pull returns six collections in one bespoke shape, scoped by tenant and
 * — deliberately, for compatibility — barely by role. Every mobile device in
 * every school depends on that shape. Widening it to forty collections and
 * tightening its scoping at the same time would mean rewriting the payload the
 * entire phone fleet is built on, to serve a client that does not exist yet.
 *
 * So this is a second door, opened correctly: capability-scoped from the first
 * commit, uniform in shape, and used only by the desktop. /sync/pull is left
 * exactly as it is.
 *
 * ── The cursor, which is where feeds like this go wrong ───────────────────
 *
 * The obvious design is "give me everything with updatedAt > T". It is broken,
 * and it breaks in a way testing rarely catches: updatedAt is not unique.
 * Applying a fee structure to a class writes several hundred charges in the
 * same operation, and Mongo will happily stamp many of them within the same
 * millisecond. With a page size of 500 and 700 charges sharing a timestamp:
 *
 *   using >   the last page's timestamp equals the next page's, so either the
 *             remaining 200 are skipped for ever, or
 *   using >=  the same 500 come back for ever and the sync never advances.
 *
 * Neither announces itself. The first quietly loses records — a family's
 * payment simply absent from the local mirror — and the second looks like a
 * slow connection.
 *
 * The cursor is therefore a PAIR, (updatedAt, _id), and the filter is
 *
 *   updatedAt > t  OR  (updatedAt = t AND _id > id)
 *
 * with a matching sort. _id is unique, so the pair is a total order and every
 * document has exactly one position in it. No skipping, no looping, whatever
 * the timestamps collide on.
 */

const mongoose = require("mongoose");

const { byCollection, FEED, required, satisfies } = require("../config/syncFeed");
const permissions = require("../services/permissions.service");

/**
 * How many documents one page may carry.
 *
 * A first sync of a large school is tens of thousands of rows, and it has to
 * happen over a connection that may not survive a minute. Smaller pages mean
 * more round trips; larger ones mean a dropped connection wasting more work.
 * 500 keeps a page comfortably under a megabyte for the widest collection here.
 */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT     = 2000;

/** Decode ?cursor= — a client-supplied string, so trusted for nothing. */
const parseCursor = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    // Both halves or neither. A cursor with only a timestamp is the broken
    // design this endpoint exists to avoid, and accepting one would reintroduce
    // it through the query string.
    if (!parsed.at || !parsed.id) return null;
    return { at: new Date(parsed.at), id: String(parsed.id) };
  } catch {
    return null;
  }
};

/**
 * Where a client has read up to, as an opaque string.
 *
 * ── A high-water mark is only as good as updatedAt ────────────────────────
 *
 * The cursor is a position in the (updatedAt, _id) order, and the compound key
 * is what makes it safe when several documents share a timestamp — a single-key
 * cursor either skips rows or loops on them.
 *
 * What it cannot survive is a document dated in the FUTURE. One row whose
 * updatedAt is ahead of the clock — a data import that preserved original
 * timestamps, a machine whose clock was wrong when it wrote, a record entered
 * with a deliberate future date — moves the cursor past it, and every row
 * written afterwards sorts BEFORE the cursor and is never offered again. The
 * client goes blind to that collection, silently, and stays that way until real
 * time passes the bad timestamp.
 *
 * Not guarded here, because the obvious guard is worse: clamping the cursor to
 * "now" would re-send the future-dated document on every single pull, for as
 * long as it stayed in the future. Recorded instead, because the failure is
 * invisible from both ends and nobody would think to look here.
 *
 * scripts/check-desktop-parity.js hits this on purpose — its fixtures are dated
 * across a school year, so it clears the cursor before the sections that need a
 * pull, with a note saying why.
 */
const encodeCursor = (doc) =>
  Buffer.from(JSON.stringify({
    at: new Date(doc.updatedAt).toISOString(),
    id: String(doc._id),
  })).toString("base64url");

/**
 * The tenant filter.
 *
 * Taken from the TOKEN, never from the query string. A super_admin may name a
 * school; nobody else may, and for everybody else the parameter is ignored
 * rather than validated — there is no reading of it that should change what
 * they get.
 *
 * A super_admin who names NO school mirrors nothing. The filter used to be
 * empty for them, which was every school's rows on one machine; an operator
 * who has not entered a school has no school's data to carry (docs/36).
 */
const tenantFilter = (req) => {
  const { ROLES } = require("../config/roles");
  if (req.user?.role === ROLES.SUPER_ADMIN) {
    const asked = req.query.schoolId ? String(req.query.schoolId).trim() : null;
    return { schoolId: asked ?? "__no-school-selected__" };
  }
  return { schoolId: req.user?.schoolId ?? "__never-matches__" };
};

/**
 * What this caller may mirror, and what they may not.
 *
 * Both halves are returned. A collection the caller cannot have must be
 * reported as REFUSED rather than as empty: a desktop that cannot tell the
 * difference shows a teacher "no payroll runs" instead of "not for you", and a
 * screen that is empty for a reason nobody can see is how people conclude the
 * software has lost their data.
 */
const partition = async (req, wanted) => {
  const held = new Set(await permissions.effectiveFor(req.user?.role, req.user?.schoolId));
  const { ROLES } = require("../config/roles");
  const isRoot = req.user?.role === ROLES.SUPER_ADMIN;

  const allowed = [];
  const refused = [];

  for (const name of wanted) {
    const entry = byCollection.get(name);
    if (!entry) { refused.push({ collection: name, reason: "UNKNOWN_COLLECTION" }); continue; }
    if (isRoot || satisfies(entry, held)) allowed.push(entry);
    else refused.push({
      collection: name, reason: "FORBIDDEN",
      // All of the alternatives, so a client can say which one is missing
      // rather than reporting a capability the user might already hold.
      permission: required(entry).join("|"),
    });
  }

  return { allowed, refused };
};

// ─────────────────────────────────────────────────────────────────────────────

exports.changes = async (req, res) => {
  try {
    const models = mongoose.models;

    // No ?collections= means "everything I am allowed to have", which is what a
    // first sync asks and saves the client hard-coding the list.
    const wanted = req.query.collections
      ? String(req.query.collections).split(",").map((s) => s.trim()).filter(Boolean)
      : FEED.map((e) => e.collection);

    const { allowed, refused } = await partition(req, wanted);

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );

    // Cursors arrive per collection, since each is at its own position.
    let cursors = {};
    if (req.query.cursors) {
      try { cursors = JSON.parse(String(req.query.cursors)); } catch { cursors = {}; }
    }

    const tenant = tenantFilter(req);
    const out    = {};

    for (const entry of allowed) {
      const Model = models[entry.model];
      if (!Model) {
        // The model file exists — syncFeed's boot check proves that — but it has
        // not been registered on this connection. Reported rather than skipped.
        out[entry.collection] = { error: "MODEL_NOT_REGISTERED", documents: [], hasMore: false };
        continue;
      }

      const cursor = parseCursor(cursors[entry.collection]);
      const scoped = entry.scope ? await entry.scope(req, models) : {};

      const filter = { ...tenant, ...scoped };

      if (cursor) {
        // The pair comparison. See the note at the top of the file for why this
        // is not simply { updatedAt: { $gt: t } }.
        filter.$or = [
          { updatedAt: { $gt: cursor.at } },
          { updatedAt: cursor.at, _id: { $gt: cursor.id } },
        ];
      }

      // Soft deletes are INCLUDED on purpose. A row the school removed must
      // reach the mirror as a deletion, or the desktop keeps showing a waived
      // charge and chasing a family for it. The client reads deletedAt.
      const query = Model.find(filter)
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit + 1)          // one extra, purely to learn whether more exist
        .lean();

      if (entry.omit?.length) query.select(entry.omit.map((f) => `-${f}`).join(" "));

      const rows    = await query;
      const hasMore = rows.length > limit;
      const page    = hasMore ? rows.slice(0, limit) : rows;

      out[entry.collection] = {
        documents: page,
        hasMore,
        // The cursor to send next time. Null on an empty page so the client
        // keeps the one it had rather than resetting to the beginning.
        cursor: page.length ? encodeCursor(page[page.length - 1]) : (cursors[entry.collection] ?? null),
      };
    }

    return res.json({
      success: true,
      // The server's clock, so a client can tell how stale it is without
      // trusting its own — a school office machine's clock is frequently wrong,
      // and "last synced" computed against a wrong clock is worse than absent.
      serverTime: new Date().toISOString(),
      collections: out,
      refused,
    });
  } catch (err) {
    console.error("🔴 sync/changes:", err.message);
    return res.status(500).json({ success: false, message: "Could not read changes" });
  }
};

exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT     = MAX_LIMIT;
exports.parseCursor   = parseCursor;
exports.encodeCursor  = encodeCursor;
