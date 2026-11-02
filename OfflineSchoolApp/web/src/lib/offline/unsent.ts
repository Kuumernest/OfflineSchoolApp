// web/src/lib/offline/unsent.ts
//
// How many changes recorded on this computer are still waiting to reach the
// server for the person signed in.
//
// The outbox is per account (the engine sends only the signed-in account's
// rows), so the number that matters is this person's — `mine`, counted by the
// main process. A main process older than that field reports only the whole
// queue, which is then the honest upper bound.

import { desktop, type OutboxSummary } from "./bridge";

export const unsentForSession = (outbox: OutboxSummary | null | undefined): number =>
  outbox ? (outbox.mine ?? outbox.pending + outbox.blocked) : 0;

/**
 * Read now, from the main process. 0 in a browser, which has no outbox — and 0
 * if the queue cannot be read, since a sign-out must never be made impossible
 * by a status read failing.
 */
export const readUnsentForSession = async (): Promise<number> => {
  const bridge = desktop();
  if (!bridge) return 0;
  try {
    return unsentForSession(await bridge.outbox.summary());
  } catch {
    return 0;
  }
};
