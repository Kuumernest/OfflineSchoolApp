// desktop/src/main/unsentCopy.js
"use strict";

/**
 * A copy of a queued change the server refused, saved before it is discarded.
 *
 * The outbox blocks on a refusal and offers Try again and Discard. For a 410
 * RECORD_DELETED — a change to, or a create under the id of, a record the
 * server has deleted — Try again can never succeed, and Discard deletes the
 * queued request and its local row: what the person typed was lost with no
 * copy. This writes that request to a file first, readable by a person: what
 * was sent, where, when, and why the server refused it.
 */

const fs = require("fs");

/** The file's contents for one outbox row. */
function unsentCopy(row, now = new Date()) {
  let body = row.body ?? null;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* kept as text */ } }
  return {
    kind:        "OfflineSchoolApp — a change that was not applied",
    savedAt:     now.toISOString(),
    queuedAt:    row.created_at ?? null,
    request:     { method: row.method, path: row.path, body },
    refused:     { status: row.last_status ?? null, message: row.last_error ?? null },
    record:      row.collection ? { collection: row.collection, id: row.doc_id ?? null } : null,
  };
}

/** Writes it to the path the person chose in the Save dialog. */
function writeUnsentCopy(row, filePath, now = new Date()) {
  fs.writeFileSync(filePath, JSON.stringify(unsentCopy(row, now), null, 2) + "\n", { encoding: "utf8" });
  return filePath;
}

/** A file name that says what it is and sorts by date. */
const suggestedName = (row, now = new Date()) =>
  `unsent-change-${now.toISOString().slice(0, 10)}-${row.seq}.json`;

module.exports = { unsentCopy, writeUnsentCopy, suggestedName };
