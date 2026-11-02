// web/src/lib/offline/unsent.ts
//
// How many changes recorded on this computer are still waiting to reach the
// server for the person signed in.
//
// The outbox is per account (the engine sends only the signed-in account's
// rows), so the number that matters is this person's — `mine`, counted by the
// main process. A main process older than that field reports only the whole
// queue, which is then the honest upper bound.

import type { OutboxSummary } from "./bridge";

export const unsentForSession = (outbox: OutboxSummary | null | undefined): number =>
  outbox ? (outbox.mine ?? outbox.pending + outbox.blocked) : 0;
