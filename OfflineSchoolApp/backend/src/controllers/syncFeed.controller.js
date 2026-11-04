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
 * commit, uniform in shape. The desktop reads FEED; since 2026-11 the phone
 * reads its six collections here too, as ?profile=phone (config/syncFeed.js
 * PHONE_FEED — /sync/pull's audience and row shapes, this endpoint's cursor and
 * pages). /sync/pull stays for phone builds from before that.
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

const { byCollection, FEED, PHONE_FEED, phoneByCollection, required, satisfies } = require("../config/syncFeed");
const permissions = require("../services/permissions.service");
const { safeHorizon, safetyWindowMs } = require("../config/syncWindow");

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

const validDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

/**
 * Decode ?cursor= — a client-supplied string, so trusted for nothing.
 *
 * Two shapes:
 *   { at, id [, s] }  a position in the (updatedAt, _id) order — exclusive.
 *                     `s` is the commit-safe floor carried between the pages
 *                     of one pass (see nextCursor).
 *   { at, r: 1 }      a RESUME point: everything with updatedAt >= at. Only the
 *                     server hands these out, at the end of a pass, and only as
 *                     a place to start re-reading from — the pages after it are
 *                     paired positions again.
 */
const parseCursor = (raw) => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const at = validDate(parsed.at);
    if (!parsed.at || !at) return null;
    // `k`: the scope fingerprint the cursor was handed out under (an entry's
    // scopeKey — a teacher phone's roster classes). Kept, never trusted: it
    // is only ever compared with the server's own.
    const k = typeof parsed.k === "string" ? { k: parsed.k } : {};
    if (parsed.r === 1 && !parsed.id) return { at, resume: true, ...k };
    // Both halves or neither. A position with only a timestamp is the broken
    // design this endpoint exists to avoid, and accepting one would reintroduce
    // it through the query string.
    if (!parsed.id) return null;
    const s = parsed.s ? validDate(parsed.s) : null;
    return { at, id: String(parsed.id), ...(s ? { s } : {}), ...k };
  } catch {
    return null;
  }
};

/**
 * Where a client has read up to, as an opaque string.
 *
 * The cursor is a position in the (updatedAt, _id) order, and the compound key
 * is what makes it safe when several documents share a timestamp — a single-key
 * cursor either skips rows or loops on them.
 */
const encodeCursor = (doc, s = null, k = null) =>
  Buffer.from(JSON.stringify({
    at: new Date(doc.updatedAt).toISOString(),
    id: String(doc._id),
    ...(s ? { s: new Date(s).toISOString() } : {}),
    ...(k ? { k } : {}),
  })).toString("base64url");

const encodeResume = (at, k = null) =>
  Buffer.from(JSON.stringify({ at: new Date(at).toISOString(), r: 1, ...(k ? { k } : {}) })).toString("base64url");

/**
 * The cursor handed back for one collection — commit-safe.
 *
 * ── The gap a plain high-water mark leaves ────────────────────────────────
 *
 * updatedAt is stamped by the application clock when the document is BUILT,
 * not when the write commits. A slow write (a transaction, a bulk insert of a
 * class's charges) becomes visible with an updatedAt behind a cursor this
 * endpoint has already handed out, sorts before it, and is never offered to
 * that client again. And a row dated in the FUTURE (an import that kept its
 * timestamps, a wrong clock) carried the cursor past every row written after
 * it — the client went blind to the collection until real time caught up.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * Within one pass (pages while hasMore), the cursor is the page's last row, as
 * before: progress is guaranteed and nothing in the pass is sent twice. It also
 * carries `s`, the commit-safe floor of the pass: the earliest "now − window"
 * (config/syncWindow.js) seen on any of its pages.
 *
 * At the END of a pass (hasMore false) — the position a client keeps until its
 * next sync — the cursor may not rest later than that floor. If the last row is
 * later, the cursor handed back is a RESUME point at the floor, so the next
 * pass re-reads everything since then. Every write that took less than the
 * window to commit is therefore delivered: if it landed after the page that
 * passed its position, its updatedAt is later than that page's clock less the
 * window, which is at or after the floor.
 *
 * The cost is the overlap: rows changed in the last couple of minutes come
 * again next pass, which a client applies as the upsert it already is (same
 * id, same updatedAt). A future-dated row is re-sent on every pass until real
 * time passes it — delivered, never hidden — and counted in `futureDated`.
 *
 * Backward compatible: the cursor is opaque to the desktop, which only stores
 * it, sends it back, and pages while hasMore; a pair it builds itself (a row
 * held back by a pending local write) is still a valid position.
 */
const nextCursor = ({ page, hasMore, cursor, raw, floor, key = null }) => {
  const last = page.length ? page[page.length - 1] : null;
  if (hasMore) return encodeCursor(last, floor, key);
  const restAt = last ? new Date(last.updatedAt) : cursor?.at ?? null;
  if (!restAt) return raw ?? null;                       // nothing seen, nothing to keep
  if (restAt.getTime() > floor.getTime()) return encodeResume(floor, key);
  if (last) return encodeCursor(last, null, key);
  // An empty last page: the position the client sent, as a resting place
  // (a pass's floor does not outlive the pass).
  return cursor.resume ? raw : encodeCursor({ updatedAt: cursor.at, _id: cursor.id }, null, key);
};

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
const partition = async (req, wanted, phone = false) => {
  const held = new Set(await permissions.effectiveFor(req.user?.role, req.user?.schoolId));
  const { ROLES } = require("../config/roles");
  const isRoot = req.user?.role === ROLES.SUPER_ADMIN;

  const allowed = [];
  const refused = [];

  for (const name of wanted) {
    const entry = (phone ? phoneByCollection : byCollection).get(name);
    if (!entry) { refused.push({ collection: name, reason: "UNKNOWN_COLLECTION" }); continue; }
    // The phone profile says who by role, as /sync/pull did (config/syncFeed.js).
    if (phone) {
      if (entry.allow(req, held)) allowed.push(entry);
      else refused.push({ collection: name, reason: "FORBIDDEN" });
      continue;
    }
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
    // profile=phone: the phone's own table (config/syncFeed.js PHONE_FEED).
    // Anything else, including nothing at all, is the desktop feed as it was.
    const phone  = req.query.profile === "phone";
    const wanted = req.query.collections
      ? String(req.query.collections).split(",").map((s) => s.trim()).filter(Boolean)
      : (phone ? PHONE_FEED : FEED).map((e) => e.collection);

    const { allowed, refused } = await partition(req, wanted, phone);

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );

    // Cursors arrive per collection, since each is at its own position.
    let cursors = {};
    if (req.query.cursors) {
      try { cursors = JSON.parse(String(req.query.cursors)); } catch { cursors = {}; }
    }

    const tenant  = tenantFilter(req);
    const out     = {};
    // Read before any query runs, like /sync/pull's pulledAt.
    const now     = new Date();
    const horizon = safeHorizon(now);

    for (const entry of allowed) {
      const Model = models[entry.model];
      if (!Model) {
        // The model file exists — syncFeed's boot check proves that — but it has
        // not been registered on this connection. Reported rather than skipped.
        out[entry.collection] = { error: "MODEL_NOT_REGISTERED", documents: [], hasMore: false };
        continue;
      }

      let cursor = parseCursor(cursors[entry.collection]);
      let rawCursor = cursors[entry.collection];
      // A scope that can change under a client (a teacher phone's roster
      // classes, config/syncFeed.js scopeKey) stamps its cursors with what it
      // admitted. A cursor stamped otherwise — classes gained or lost since,
      // or a cursor from before the stamp — is a position in a different set
      // of rows, and the rows of a gained class are behind it though they never
      // changed: the collection is read again from the start.
      const key = entry.scopeKey ? await entry.scopeKey(req, models) : null;
      if (cursor && (cursor.k ?? null) !== key) { cursor = null; rawCursor = null; }
      // The commit-safe floor of this pass: the earliest "now − window" any
      // of its pages has seen (nextCursor).
      const floor = cursor?.s && cursor.s < horizon ? cursor.s : horizon;
      const scoped = entry.scope ? await entry.scope(req, models) : {};

      const filter = { ...tenant, ...scoped };

      if (cursor) {
        // The pair comparison. See the note at the top of the file for why this
        // is not simply { updatedAt: { $gt: t } }. A resume point (nextCursor)
        // is inclusive: it is where a pass starts re-reading, never where
        // one stops, so the pages after it are pairs again.
        const after = cursor.resume
          ? [{ updatedAt: { $gte: cursor.at } }]
          : [
            { updatedAt: { $gt: cursor.at } },
            { updatedAt: cursor.at, _id: { $gt: cursor.id } },
          ];
        // A scope may carry its own $or (syncTombstone's does). Assigned over
        // it, the cursor would silently REPLACE the scope — every row of the
        // collection, past the cursor, for whoever asked. Both, under $and.
        if (filter.$or) {
          filter.$and = [...(filter.$and || []), { $or: filter.$or }, { $or: after }];
          delete filter.$or;
        } else {
          filter.$or = after;
        }
      }

      // Soft deletes are INCLUDED on purpose. A row the school removed must
      // reach the mirror as a deletion, or the desktop keeps showing a waived
      // charge and chasing a family for it. The client reads deletedAt.
      const query = Model.find(filter)
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit + 1)          // one extra, purely to learn whether more exist
        .lean();

      if (entry.omit?.length) query.select(entry.omit.map((f) => `-${f}`).join(" "));
      // Phone entries: the fields and joins /sync/pull sent (PHONE_FEED).
      // updatedAt and _id are always kept — the cursor is built from them.
      if (entry.project) query.select(`${entry.project(req)} updatedAt`);
      if (entry.populate) entry.populate(query, req);

      const rows    = await query;
      const hasMore = rows.length > limit;
      const page    = hasMore ? rows.slice(0, limit) : rows;
      // An entry may drop rows from what is SENT (syncTombstone: one whose row
      // still exists). The cursor below is still the page's last row, so a
      // dropped row is passed, not re-fetched.
      const kept      = entry.postFilter ? await entry.postFilter(page, models) : page;
      const documents = entry.transform ? entry.transform(kept, req) : kept;

      // Rows dated ahead of the server clock: delivered, re-sent every pass
      // until real time passes them (the cursor never rests beyond the floor),
      // and reported so somebody can find the import that wrote them.
      const futureDated = page.filter((d) => d.updatedAt && new Date(d.updatedAt).getTime() > now.getTime()).length;
      if (futureDated) {
        console.warn(`[sync/changes] ⚠️  ${futureDated} ${entry.collection} row(s) dated in the future — re-sent until the clock passes them`);
      }

      out[entry.collection] = {
        documents,
        hasMore,
        // The cursor to send next time, commit-safe (nextCursor). On an empty
        // first page it stays what the client had rather than resetting.
        cursor: nextCursor({ page, hasMore, cursor, raw: rawCursor, floor, key }),
        ...(futureDated ? { futureDated } : {}),
      };
    }

    return res.json({
      success: true,
      // The server's clock, so a client can tell how stale it is without
      // trusting its own — a school office machine's clock is frequently wrong,
      // and "last synced" computed against a wrong clock is worse than absent.
      serverTime: new Date().toISOString(),
      // How far behind the clock a resting cursor is kept (nextCursor): the
      // overlap a client should expect to see again next pass.
      safetyWindowMs: safetyWindowMs(),
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
exports.encodeResume  = encodeResume;
exports.nextCursor    = nextCursor;
