// web/src/lib/offline/outboxOwnership.ts
//
// Which queued changes the person signed in may act on from the sync panel.
//
// The owner's decision: Discard, Try again and Save a copy are for the
// signed-in account's OWN entries. Another account's, and an entry from before
// the queue recorded who made it, are shown read-only with the reason. The main
// process enforces the same rule and refuses otherwise (desktop/src/main/db/
// outbox.js ownOutboxActions); hiding the buttons here is so nobody is offered
// an action that will be refused, not the protection itself.

import type { OutboxSummary } from "./bridge";

export type StuckEntry = OutboxSummary["stuck"][number];

/**
 * May the signed-in account act on this entry?
 *
 * No `owner` at all is a main process older than the field, which also does no
 * refusing: the panel behaves as it did with it.
 */
export const canActOn = (item: StuckEntry): boolean =>
  item.owner === undefined || item.owner === "mine";

/** Why an entry is read-only, as an i18n key — or null when it is not. */
export const readOnlyReasonKey = (item: StuckEntry): string | null =>
  item.owner === "other" ? "sync.readOnlyOtherAccount"
  : item.owner === "none" ? "sync.readOnlyOwnerless"
  : null;

/**
 * A refusal from the main process, as an i18n key — or null for any other
 * failure. Accepts a thrown Error (unblock, discard: Electron forwards only its
 * message, which starts with the code) or Save a copy's `{ ok: false, error }`.
 */
export const refusalKey = (err: unknown): string | null => {
  const text =
    err instanceof Error ? err.message
    : typeof err === "string" ? err
    : err && typeof err === "object" && "error" in err ? String((err as { error?: unknown }).error ?? "")
    : "";
  if (/\bOUTBOX_OTHER_ACCOUNT\b/.test(text)) return "sync.readOnlyOtherAccount";
  if (/\bOUTBOX_OWNERLESS\b/.test(text))     return "sync.readOnlyOwnerless";
  if (/\bNOT_SIGNED_IN\b/.test(text))         return "sync.refusedSignedOut";
  return null;
};
