// web/src/pages/messages/clientId.ts
//
// The id a message is sent under, chosen here so a retry cannot post twice.
//
// The server stores the message under it and answers a repeat with the one it
// already has. On the desktop it is also what makes an offline send safe: the
// queued POST is replayed under the same id (desktop/src/main/api/handlers/
// messages.js).
//
// One id per ATTEMPT AT ONE MESSAGE: kept while the same text is retried after
// a failure, replaced once a send succeeds — two identical "ok"s in a row are
// two messages, and reusing the id would swallow the second. No imports, so
// scripts/check-connectivity.mjs runs it as is.

const newId = (): string => {
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

export interface ClientIds {
  /** The id for this payload: the same one while it is retried unchanged. */
  forAttempt(payload: unknown): string;
  /** The message went: the next send is a new message. */
  sent(): void;
}

export const clientIds = (): ClientIds => {
  let current: { signature: string; id: string } | null = null;
  return {
    forAttempt(payload) {
      const signature = JSON.stringify(payload ?? null);
      if (current?.signature !== signature) current = { signature, id: newId() };
      return current.id;
    },
    sent() { current = null; },
  };
};
