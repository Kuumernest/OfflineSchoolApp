// web/src/services/period.service.ts
"use strict";

import api from "@/lib/axios";
import { unwrapList, unwrapSingle } from "@/utils/unwrap";
import type {
  Period,
  CreatePeriodPayload,
  UpdatePeriodPayload,
} from "@/types/timetable.types";

const BASE = "/admin/periods";

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

const normalise = (raw: Record<string, unknown>): Period => ({
  _id:       String(raw._id ?? raw.id ?? ""),
  schoolId:  String(raw.schoolId ?? raw.school_id ?? ""),
  name:      String(raw.name ?? ""),
  startTime: String(raw.startTime ?? raw.start_time ?? ""),
  endTime:   String(raw.endTime   ?? raw.end_time   ?? ""),
  sortOrder: Number(raw.sortOrder ?? raw.sort_order ?? 0),
  isBreak:   Boolean(raw.isBreak  ?? raw.is_break),
  isActive:  raw.isActive !== false && raw.is_active !== 0,
  version:   Number(raw.version ?? 1),
  createdAt: raw.createdAt as string | undefined,
  updatedAt: raw.updatedAt as string | undefined,
});

// ─────────────────────────────────────────────────────────────────────────────
// TIME HELPERS
//
// The server validates "HH:MM" strictly and rejects end <= start with a 400.
// Validating here first turns a round-trip into an inline form error.
// ─────────────────────────────────────────────────────────────────────────────

export const toMinutes = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t?.trim() ?? "");
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Normalises "9:05" to "09:05" — the server's regex demands two digits. */
export const padTime = (t: string): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t?.trim() ?? "");
  if (!m) return t?.trim() ?? "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};

export const formatTimeRange = (p: Pick<Period, "startTime" | "endTime">): string =>
  `${p.startTime}–${p.endTime}`;

/**
 * Returns the first active period whose time range overlaps [start, end),
 * ignoring `excludeId`. Mirrors checkOverlap() in the periods controller so the
 * user sees the clash before the request is made.
 */
export const findOverlap = (
  periods: Period[],
  startTime: string,
  endTime:   string,
  excludeId: string | null = null,
): Period | null => {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;

  return (
    periods.find((p) => {
      if (!p.isActive)          return false;
      if (p._id === excludeId)  return false;
      const ps = toMinutes(p.startTime);
      const pe = toMinutes(p.endTime);
      return s < pe && e > ps;
    }) ?? null
  );
};

/** Human-readable reason the times are invalid, or null when they are fine. */
export const validateTimes = (
  startTime: string,
  endTime:   string,
): string | null => {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  if (Number.isNaN(s) || Number.isNaN(e)) return "Times must be in HH:MM format";
  if (e <= s)                             return "End time must be after start time";
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchPeriods(
  schoolId: string,
  includeInactive = false,
): Promise<Period[]> {
  const { data } = await api.get(BASE, {
    params: { schoolId, includeInactive: String(includeInactive) },
  });
  return unwrapList<Record<string, unknown>>(data, "periods")
    .map(normalise)
    .sort((a, b) =>
      a.sortOrder - b.sortOrder ||
      toMinutes(a.startTime) - toMinutes(b.startTime),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function createPeriod(payload: CreatePeriodPayload): Promise<Period> {
  const { data } = await api.post(BASE, {
    ...payload,
    startTime: padTime(payload.startTime),
    endTime:   padTime(payload.endTime),
  });
  return normalise(unwrapSingle<Record<string, unknown>>(data, "period"));
}

export async function updatePeriod(
  id:      string,
  payload: UpdatePeriodPayload,
): Promise<Period> {
  const body: Record<string, unknown> = { ...payload };
  if (payload.startTime) body.startTime = padTime(payload.startTime);
  if (payload.endTime)   body.endTime   = padTime(payload.endTime);

  const { data } = await api.put(`${BASE}/${id}`, body);
  return normalise(unwrapSingle<Record<string, unknown>>(data, "period"));
}

export async function togglePeriodActive(id: string): Promise<Period> {
  const { data } = await api.patch(`${BASE}/${id}/toggle`);
  return normalise(unwrapSingle<Record<string, unknown>>(data, "period"));
}

/**
 * Moves a period one place up or down.
 *
 * The endpoint is a neighbour SWAP, not an assignment: it finds the adjacent
 * period by sortOrder and exchanges the two values. So there is no way to send
 * a whole new ordering in one call, and the UI offers up/down arrows rather
 * than drag-to-anywhere. Moving past either end answers 400, which the caller
 * should treat as "already at the edge" rather than a failure worth alerting.
 */
export async function movePeriod(
  id:        string,
  direction: "up" | "down",
): Promise<void> {
  await api.post(`${BASE}/${id}/reorder`, { direction });
}

export async function deletePeriod(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}
