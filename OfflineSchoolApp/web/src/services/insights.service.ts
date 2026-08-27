// web/src/services/insights.service.ts
//
// Cross-module reads — the early-warning watch list. The server does all the
// joining and scoring; this file only names the shapes.

import api from "@/services/api";

export type WatchTier = "high" | "medium" | "low";

export type WatchSignalCode =
  | "absence"
  | "late"
  | "failed_exam"
  | "grade_drop"
  | "subjects_failed"
  | "missing_homework"
  | "fees_outstanding";

export interface WatchSignal {
  code:   WatchSignalCode;
  points: number;
  /** The numbers behind the signal — the client owns the wording. */
  data:   Record<string, number | string | null>;
}

export interface WatchStudent {
  studentId:    string;
  name:         string | null;
  enrollmentNo: string | null;
  classId:      string | null;
  className:    string | null;
  score:        number;
  tier:         WatchTier;
  signals:      WatchSignal[];
}

export interface Watchlist {
  generatedAt: string;
  windowDays:  number;
  counts: { high: number; medium: number; low: number; students: number };
  students: WatchStudent[];
}

export async function fetchWatchlist(
  schoolId: string, days: number
): Promise<Watchlist> {
  const { data } = await api.get("/insights/early-warning", {
    params: { schoolId, days },
  });
  return (data as { data: Watchlist }).data;
}
