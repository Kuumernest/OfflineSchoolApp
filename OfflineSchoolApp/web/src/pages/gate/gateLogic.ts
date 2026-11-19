// web/src/pages/gate/gateLogic.ts
//
// The gate screen's pure parts: finding a pupil in the snapshot and asking the
// shared engine about them. No React, no network — what the screen falls back
// on when the server cannot be reached, so it has to be the boring part.

import { compliance, type CompliancePayment } from "../../../../shared/compliance.js";
import type {
  GateSnapshot, GateStudentCard, SnapshotStudent, WireCompliance,
} from "@/services/gate.service";

/** Lower-case, accents gone: "Élodie" is found by "elodie". */
const fold = (s: string | null | undefined): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const findByToken = (snapshot: GateSnapshot | null, token: string): SnapshotStudent | null =>
  snapshot?.students.find((s) => s.token && s.token === token) ?? null;

export const findById = (snapshot: GateSnapshot | null, studentId: string): SnapshotStudent | null =>
  snapshot?.students.find((s) => s.studentId === studentId) ?? null;

/**
 * Name / admission-number search over the snapshot — the offline twin of
 * GET /gate/search. Every word typed must appear somewhere, so "ngo mar" finds
 * "Marie Ngo"; siblings share a surname and all of them are listed.
 */
export function searchSnapshot(snapshot: GateSnapshot | null, q: string, limit = 20): SnapshotStudent[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!snapshot || !words.length || fold(q).length < 2) return [];
  const out: SnapshotStudent[] = [];
  for (const s of snapshot.students) {
    const hay = `${fold(s.name)} ${fold(s.enrollmentNo)}`;
    if (words.every((w) => hay.includes(w))) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export const cardOf = (s: SnapshotStudent): GateStudentCard => ({
  _id:          s.studentId,
  name:         s.name,
  enrollmentNo: s.enrollmentNo,
  classId:      s.classId,
  className:    s.className,
  photoUrl:     s.photoUrl,
});

/**
 * The engine, run on this device from the snapshot.
 *
 * Snapshot payments are server rows and so confirmed; `pending` are payments
 * this desktop recorded and has not uploaded, which the engine reports beside
 * the result and never counts as paid. `dataAsOf` is the snapshot's own time,
 * so a copy more than a day old says it is stale.
 */
export function localCompliance(
  s: SnapshotStudent,
  generatedAt: string,
  pending: CompliancePayment[] = [],
): WireCompliance {
  return compliance({
    charges:        s.charges ?? [],
    payments:       [
      ...(s.payments ?? []).map((p) => ({ ...p, state: "confirmed" as const })),
      ...pending,
    ],
    plan:           s.plan ?? null,
    authorizations: s.authorizations ?? [],
    asOf:           new Date(),
    dataAsOf:       generatedAt,
  });
}

/** What the card shows for the latest scan or lookup. */
export interface GateResult {
  /** The scan's client id — also what the history marks as "waiting to upload". */
  id:         string;
  /** Null only for a card this device does not know and could not ask about. */
  student:    GateStudentCard | null;
  token:      string | null;
  method:     "card" | "manual";
  at:         string;
  /** Null when the server has not decided yet (an offline scan with no override). */
  direction:  "in" | "out" | null;
  duplicate:  boolean;
  replay:     boolean;
  notified:   boolean;
  /** The server's answer when there is one, else this device's. Null without gate.verify. */
  compliance: WireCompliance | null;
  /** Computed here from the snapshot, not by the server. */
  computedLocally: boolean;
  /** This device's pending payments, kept when the server's answer is shown (it cannot know them). */
  localPending: WireCompliance["pending"] | null;
  /** In the upload queue. */
  queued:     boolean;
}
