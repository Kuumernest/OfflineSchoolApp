// web/src/lib/clientId.ts
//
// The id a new class, subject or teacher assignment is created under, chosen
// here rather than by the server.
//
// The server stores the row under it and answers a repeat with the row it
// already has (POST /admin/classes, /admin/subjects, /admin/assignments). On
// the desktop it is what lets the create be answered offline at all: the local
// database stores the row under this id and the queued POST is replayed under
// the same one, so both sides agree which row it is (desktop/src/main/api/
// writes/{classes,subjects,assignments}.js). Without it those handlers decline
// and the create goes to a network that is not there.
//
// One id per ATTEMPT AT ONE CREATE, as pages/messages/clientId.ts does for
// messages: kept while the same payload is retried after a failure, replaced
// once it succeeds. Keyed by payload so a form that creates several rows in
// one submission (a subject in each of three classes) keeps one id per row.
// No imports, so scripts/check-create-ids.mjs runs it as is.

export const newClientId = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // randomUUID needs a secure context; a school LAN on plain HTTP is real.
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`;
};

export interface CreateIds {
  /** The id for this payload: the same one while it is retried unchanged. */
  forAttempt(payload: unknown): string;
  /** That payload was created: the next identical one is a new row. No
   *  argument forgets every pending attempt. */
  created(payload?: unknown): void;
}

const signatureOf = (payload: unknown): string => JSON.stringify(payload ?? null);

export const createIds = (): CreateIds => {
  const pending = new Map<string, string>();
  return {
    forAttempt(payload) {
      const sig = signatureOf(payload);
      let id = pending.get(sig);
      if (!id) { id = newClientId(); pending.set(sig, id); }
      return id;
    },
    created(payload) {
      if (payload === undefined) pending.clear();
      else pending.delete(signatureOf(payload));
    },
  };
};

/** The payload with an id: the caller's, or a fresh one. */
export const withClientId = <T extends object>(payload: T & { id?: string }): T & { id: string } => ({
  ...payload,
  id: payload.id || newClientId(),
});
