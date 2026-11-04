// mobile/src/services/syncFeed.client.js
"use strict";

/**
 * The phone's reader for GET /sync/changes?profile=phone.
 *
 * The phone used GET /sync/pull: one timestamp for six collections, and the
 * whole school in one answer. This reads the same six (plus hard deletes)
 * through the change feed the desktop uses — a cursor per collection, pages of
 * `limit`, commit-safe positions (backend config/syncWindow.js) — with the
 * audience /sync/pull had (backend config/syncFeed.js PHONE_FEED).
 *
 * The rules:
 *   - a page is APPLIED before its cursor is stored. A crash between the two
 *     re-fetches the page next time (every apply is an upsert), never skips it;
 *   - only collections that said hasMore are asked for again within a pass, so
 *     a finished collection is not re-read at its resting position;
 *   - cursors are opaque, stored per account (db/syncCursors.js) under
 *     `feed_cursor:<collection>`;
 *   - a server that does not know the phone profile (every collection refused
 *     as UNKNOWN_COLLECTION) is reported as FeedUnavailable, and the caller
 *     falls back to /sync/pull.
 *
 * Re-sent rows (the overlap the server re-reads after each pass) are the same
 * id and updatedAt the phone already has; the apply functions take them as
 * the no-op upsert they are.
 */

import { FEED_PREFIX } from "../db/syncCursors";

export const FEED_PATH = "/sync/changes";

/** In apply order: the things others refer to first, removals last. */
export const PHONE_COLLECTIONS = ["classes", "subjects", "teachers", "periods", "assignments", "students", "tombstones"];

export class FeedUnavailable extends Error {
  constructor(msg = "The server has no phone profile on /sync/changes") { super(msg); this.code = "FEED_UNAVAILABLE"; }
}

/**
 * Pull every phone collection to the end.
 *
 * @param {object}   o
 * @param {object}   o.api       axios-like ({ get })
 * @param {object}   o.store     cursor store (db/syncCursors.cursorStore()), or null to start from the beginning and keep nothing
 * @param {Function} o.apply     async (collection, documents) — writes one page
 * @param {string}   [o.schoolId]
 * @param {number}   [o.limit]
 * @param {number}   [o.maxPages]  a ceiling per pass; what is left comes next sync
 * @param {number}   [o.timeout]   per request, ms
 * @returns {Promise<{ counts: object, refused: object[], serverTime: string|null, pages: number, complete: boolean }>}
 */
export async function pullPhoneFeed({ api, store, apply, schoolId = null, limit = 500, maxPages = 200, timeout = 60_000 }) {
  const cursors = {};
  if (store) {
    for (const c of PHONE_COLLECTIONS) {
      const v = await store.get(`${FEED_PREFIX}${c}`);
      if (v) cursors[c] = v;
    }
  }

  const counts  = Object.fromEntries(PHONE_COLLECTIONS.map((c) => [c, 0]));
  const refused = [];
  let pending   = [...PHONE_COLLECTIONS];
  let serverTime = null;
  let pages = 0;

  while (pending.length && pages < maxPages) {
    const asked = {};
    for (const c of pending) if (cursors[c]) asked[c] = cursors[c];
    const params = { profile: "phone", collections: pending.join(","), limit };
    if (Object.keys(asked).length) params.cursors = JSON.stringify(asked);
    if (schoolId) params.schoolId = schoolId;

    const res  = await api.get(FEED_PATH, { params, timeout });
    const body = res?.data ?? {};
    pages++;
    serverTime = body.serverTime ?? serverTime;

    const unknown = (body.refused ?? []).filter((r) => r.reason === "UNKNOWN_COLLECTION");
    if (!body.collections || (pages === 1 && unknown.length === pending.length)) throw new FeedUnavailable();
    for (const r of body.refused ?? []) refused.push(r);

    const next = [];
    for (const c of PHONE_COLLECTIONS) {
      const slice = body.collections[c];
      if (!slice || slice.error) continue;
      const docs = Array.isArray(slice.documents) ? slice.documents : [];
      if (docs.length) await apply(c, docs);
      counts[c] += docs.length;
      if (slice.cursor) {
        cursors[c] = slice.cursor;
        if (store) await store.set(`${FEED_PREFIX}${c}`, slice.cursor);
      }
      if (slice.hasMore) next.push(c);
    }
    pending = next;
  }

  return { counts, refused, serverTime, pages, complete: pending.length === 0 };
}

/** Hard deletes, grouped as removal rows of the collection each belongs to. */
export const tombstonesByCollection = (rows) => {
  const out = {};
  for (const t of rows ?? []) {
    if (!t?.collection || !t._id) continue;
    (out[t.collection] ??= []).push({ _id: String(t._id), id: String(t._id), schoolId: t.schoolId ?? null, deletedAt: t.deletedAt || new Date().toISOString() });
  }
  return out;
};

export default { pullPhoneFeed, tombstonesByCollection, PHONE_COLLECTIONS, FeedUnavailable, FEED_PATH };
