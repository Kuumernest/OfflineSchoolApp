// mobile/src/services/idMap.js

/**
 * Rewriting local ids into server ids, just before a queued request goes out.
 *
 * A phone with no signal invents its own ids so that work can continue: a pupil
 * is created, a payment is recorded against that pupil, and a document is filed
 * for them, all before the server has heard of any of it. When the queue
 * finally drains, the pupil is created first and the server may answer with a
 * different id — so every request still waiting that refers to the old one has
 * to be rewritten before it is sent.
 *
 * Get it wrong and the payment is filed against a pupil who does not exist. The
 * request succeeds, the screen says saved, and the money is attached to
 * nothing.
 *
 * This is the whole of that rewrite, kept separate from the queue so it can be
 * exercised without a device: it takes a `lookup` rather than a database, and
 * knows nothing about SQLite. The queue supplies a lookup backed by the id map
 * table; the checks supply one backed by a Map.
 */

/**
 * Which path segments are identifiers.
 *
 * Length alone was the test, at eight characters, and that is not a test at
 * all: "students" is eight, and so are "payments", "settings", "teachers" and
 * "approvals". If any of those ever reached the id map — a stray mapId call, a
 * server answering with a word — the rewrite would substitute it INTO THE URL
 * and the request would go somewhere nobody serves.
 *
 * So the shape has to be checked too. Every id in this system is either a uuid
 * (hyphens and digits), a prefixed uuid, or a Mongo ObjectId (hex, so digits in
 * all but a vanishingly unlikely case). No route word in this codebase carries
 * a digit or a hyphen. That is the distinction.
 *
 * Erring towards not rewriting is the safe direction: a missed rewrite is
 * refused by the server and visible, while a wrong one is a request to an
 * endpoint that does not exist, or worse, one that does.
 */
const MIN_ID_LENGTH = 8;

const looksLikeId = (segment) =>
  segment.length >= MIN_ID_LENGTH &&
  (/[-_]/.test(segment) || /\d/.test(segment));

/**
 * @param {object}   args
 * @param {string}   args.endpoint  the path the request will be sent to
 * @param {object}   args.payload   the body, possibly carrying `__resolve`
 * @param {Function} args.lookup    async (localId) => serverId | localId
 * @returns {Promise<{endpoint: string, payload: object, rewrote: string[]}>}
 */
export async function remapPayload({ endpoint, payload, lookup }) {
  const fields  = Array.isArray(payload?.__resolve) ? payload.__resolve : [];
  const next    = { ...payload };
  const rewrote = [];

  let path = String(endpoint ?? "");

  // Named foreign keys first. The caller lists them because only the caller
  // knows which of its fields hold an id — guessing by name would rewrite a
  // note that happens to contain one.
  for (const field of fields) {
    const current = next[field];
    if (typeof current !== "string" || !current) continue;

    const mapped = await lookup(current);
    if (mapped && mapped !== current) {
      next[field] = mapped;
      rewrote.push(field);
      // The path frequently embeds the same id — /exams/:id/scores/bulk.
      path = path.split(current).join(mapped);
    }
  }

  // Then anything left in the path itself: a PUT or DELETE addressed by id.
  for (const segment of path.split("/").filter(Boolean)) {
    if (!looksLikeId(segment)) continue;
    const mapped = await lookup(segment);
    if (mapped && mapped !== segment) {
      path = path.split(segment).join(mapped);
      rewrote.push(`path:${segment}`);
    }
  }

  return { endpoint: path, payload: next, rewrote };
}

export default { remapPayload, MIN_ID_LENGTH };
