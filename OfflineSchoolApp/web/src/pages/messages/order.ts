// web/src/pages/messages/order.ts
//
// The order a thread is drawn in, and the newest seq it is safe to mark read.
//
// By seq, the number the server assigns — never by a timestamp (see the note
// at the top of index.tsx). On the desktop a message written offline has no
// seq yet (null) until its outbox sends it: it goes after everything the
// server has ordered, and among themselves such messages keep the order they
// were written in. No imports, so scripts/check-connectivity.mjs runs it as is.

interface Ordered {
  seq:        number | null;
  createdAt?: string | null;
}

/** Oldest at the top; unsent last, in the order they were written. */
export const threadOrder = (a: Ordered, b: Ordered): number => {
  if (a.seq != null && b.seq != null) return a.seq - b.seq;
  if (a.seq != null) return -1;
  if (b.seq != null) return 1;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
};

/**
 * The highest seq the server has given any message here, or null.
 *
 * What a read receipt may claim: an unsent message has no seq, and inventing
 * one would move the marker past messages the server has not ordered.
 */
export const newestSeq = (messages: readonly Ordered[]): number | null => {
  let newest: number | null = null;
  for (const m of messages) if (m.seq != null && (newest == null || m.seq > newest)) newest = m.seq;
  return newest;
};
