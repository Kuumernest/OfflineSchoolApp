import { useRef } from "react";

/**
 * A stable id for one attempt at one write, so a retry is not a second record.
 *
 * The mobile and desktop apps push their writes through an outbox that sends an
 * Idempotency-Key, so a request that succeeded on the server but never reached
 * the client is answered rather than repeated. The web has no outbox and sent
 * nothing, which left the case a bursar meets on a bad line: the payment is
 * recorded, the reply is lost, they press the button again, and the parent is
 * charged twice. The unique index on schoolId+receiptNo does not catch it —
 * each attempt mints its own receipt number, so both rows are valid.
 *
 * The server already accepts a client-chosen `_id` on payments and expenses and
 * answers a repeat with the record it already has. This supplies one.
 *
 * ── Why it is keyed on the payload, not on the form being open ──────────────
 *
 * The id has to identify the INTENT, not the session. Holding one id for as
 * long as the dialog is open would mean that a failed payment of 5,000,
 * corrected to 7,000 and sent again, reuses the id — and the server, seeing an
 * id it already has, answers with the 5,000 it stored. The bursar would be
 * shown a success for a figure nobody entered.
 *
 * So the id is derived from the payload: identical payload, same id, and the
 * retry is deduplicated; change any field and it is a different payment, which
 * it is.
 */

const newId = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  // randomUUID needs a secure context. A plain-HTTP deployment on a school's
  // own LAN is a real possibility here, and falling back to something unique
  // is better than throwing inside a payment.
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`;
};

/**
 * Returns a function that maps a payload to a stable id.
 *
 *   const attemptId = useAttemptId();
 *   recordPayment({ _id: attemptId(payload), ...payload })
 */
export function useAttemptId(): (payload: unknown) => string {
  const ref = useRef<{ signature: string; id: string } | null>(null);

  return (payload: unknown) => {
    const signature = JSON.stringify(payload ?? null);
    if (ref.current?.signature !== signature) {
      ref.current = { signature, id: newId() };
    }
    return ref.current.id;
  };
}

export default useAttemptId;
