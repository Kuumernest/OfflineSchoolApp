// web/src/services/announcement.service.ts
"use strict";

import api from "@/lib/axios";
import { unwrapList, unwrapSingle } from "@/utils/unwrap";
import type {
  Announcement,
  AnnouncementFilters,
  AnnouncementListResult,
  Audience,
  CreateAnnouncementPayload,
  Priority,
  UpdateAnnouncementPayload,
} from "@/types/announcement.types";

const BASE = "/announcements";

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

const normalise = (raw: Record<string, unknown>): Announcement => {
  const author = raw.author;

  return {
    _id:      String(raw._id ?? raw.id ?? ""),
    title:    String(raw.title ?? ""),
    body:     String(raw.body ?? ""),
    audience: (String(raw.audience ?? "all") as Audience),
    priority: (String(raw.priority ?? "normal") as Priority),
    isPinned: Boolean(raw.isPinned),
    isActive: raw.isActive !== false,

    author: author as Announcement["author"],
    // `author` is populated to an object by the list endpoint but stays a raw
    // id elsewhere, so the display name is read from authorName first and only
    // falls back to digging into the populated object.
    authorName:
      (raw.authorName as string) ??
      (author && typeof author === "object"
        ? ((author as Record<string, unknown>).name as string)
        : null) ??
      null,
    authorRole: (raw.authorRole as string) ?? null,

    targetClasses: Array.isArray(raw.targetClasses)
      ? (raw.targetClasses as Announcement["targetClasses"])
      : [],

    subjectId:   (raw.subjectId as string) ?? null,
    subjectName: (raw.subjectName as string) ?? null,

    publishAt: (raw.publishAt as string) ?? null,
    expiresAt: (raw.expiresAt as string) ?? null,
    createdAt: raw.createdAt as string | undefined,
    updatedAt: raw.updatedAt as string | undefined,

    readCount:
      raw.readCount !== undefined
        ? Number(raw.readCount)
        : Array.isArray(raw.readBy)
          ? raw.readBy.length
          : undefined,
    acknowledgeCount:
      raw.acknowledgeCount !== undefined
        ? Number(raw.acknowledgeCount)
        : Array.isArray(raw.acknowledgedBy)
          ? raw.acknowledgedBy.length
          : undefined,
    isRead:           raw.isRead           !== undefined ? Boolean(raw.isRead)           : undefined,
    isAcknowledged:   raw.isAcknowledged   !== undefined ? Boolean(raw.isAcknowledged)   : undefined,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Class names for the audience chip, whether populated or still raw ids. */
export const targetClassNames = (a: Announcement): string[] =>
  a.targetClasses.map((c) =>
    typeof c === "string"
      ? c
      : [c.name, c.section].filter(Boolean).join(" "),
  );

/**
 * An announcement is live when it is active, published, and not expired.
 *
 * The list endpoint filters on isActive but NOT on publishAt/expiresAt, so a
 * scheduled or long-lapsed notice comes back looking current. Labelling those
 * separately is why an admin can tell a draft from something parents can see.
 */
export const lifecycleOf = (
  a: Announcement,
  now: Date = new Date(),
): "scheduled" | "expired" | "inactive" | "live" => {
  if (!a.isActive) return "inactive";
  if (a.publishAt && new Date(a.publishAt) > now) return "scheduled";
  if (a.expiresAt && new Date(a.expiresAt) < now) return "expired";
  return "live";
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAnnouncements(
  filters: AnnouncementFilters = {},
): Promise<AnnouncementListResult> {
  const { data } = await api.get(BASE, {
    params: {
      page:  filters.page  ?? 1,
      limit: filters.limit ?? 25,
      ...(filters.audience ? { audience: filters.audience } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
    },
  });

  const body = (data ?? {}) as Record<string, unknown>;
  const list = unwrapList<Record<string, unknown>>(body, "announcements").map(normalise);
  const pg   = (body.pagination ?? {}) as Record<string, unknown>;

  return {
    announcements: list,
    total: Number(pg.total ?? list.length),
    page:  Number(pg.page  ?? filters.page ?? 1),
    pages: Number(pg.pages ?? 1),
  };
}

export async function fetchAnnouncement(id: string): Promise<Announcement> {
  const { data } = await api.get(`${BASE}/${id}`);
  return normalise(unwrapSingle<Record<string, unknown>>(data, "announcement"));
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `targetClasses` is only sent for a class-targeted notice.
 *
 * The server rejects audience:"class" with an empty array (400) and ignores the
 * array otherwise, so leaving a stale selection in the payload after switching
 * audience back to "all" is at best noise and at worst a validation failure.
 */
const buildBody = (
  payload: CreateAnnouncementPayload | UpdateAnnouncementPayload,
): Record<string, unknown> => {
  const body: Record<string, unknown> = { ...payload };

  if (payload.audience === "class") {
    body.targetClasses = payload.targetClasses ?? [];
  } else if ("targetClasses" in body) {
    delete body.targetClasses;
  }

  if (payload.title) body.title = payload.title.trim();
  if (payload.body)  body.body  = payload.body.trim();

  return body;
};

export async function createAnnouncement(
  payload: CreateAnnouncementPayload,
): Promise<Announcement> {
  const { data } = await api.post(BASE, buildBody(payload));
  return normalise(unwrapSingle<Record<string, unknown>>(data, "announcement"));
}

export async function updateAnnouncement(
  id:      string,
  payload: UpdateAnnouncementPayload,
): Promise<Announcement> {
  const { data } = await api.put(`${BASE}/${id}`, buildBody(payload));
  return normalise(unwrapSingle<Record<string, unknown>>(data, "announcement"));
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

/**
 * Admin-only. The route is a toggle, not a setter.
 *
 * It answers `{ success, isPinned }` — NOT the announcement — so this returns
 * the new pinned state rather than pretending to return a full record. The
 * previous signature claimed Promise<Announcement> and, because unwrapSingle
 * falls back to the whole body, handed callers an object with an empty _id and
 * an empty title.
 */
export async function togglePin(id: string): Promise<boolean> {
  const { data } = await api.post(`${BASE}/${id}/pin`);
  const body = (data ?? {}) as Record<string, unknown>;
  return Boolean(body.isPinned);
}

export async function markRead(id: string): Promise<void> {
  await api.post(`${BASE}/${id}/read`);
}

export async function acknowledge(id: string): Promise<void> {
  await api.post(`${BASE}/${id}/acknowledge`);
}

/**
 * `schoolId` is required in the BODY, not inferred from the token.
 *
 * The handler destructures req.body, so calling this with no body is a 500 —
 * and if it did get through, `find({ schoolId: undefined })` drops the filter
 * and would mark announcements read across every school on the server. Passing
 * it explicitly is both the working call and the tenant-safe one.
 */
export async function markAllRead(schoolId: string): Promise<number> {
  const { data } = await api.post(`${BASE}/read-all`, { schoolId });
  return Number((data as Record<string, unknown>)?.marked ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────

export interface AnnouncementStats {
  total:        number;
  pinned:       number;
  urgent:       number;
  /** The endpoint reports a MONTH, not a week — named to match. */
  thisMonth:    number;
  fromTeachers: number;
}

export async function fetchAnnouncementStats(): Promise<AnnouncementStats> {
  const { data } = await api.get(`${BASE}/stats/summary`);
  const s = unwrapSingle<Record<string, unknown>>(data, "stats") ?? {};
  return {
    total:        Number(s.total        ?? 0),
    pinned:       Number(s.pinned       ?? 0),
    urgent:       Number(s.urgent       ?? 0),
    thisMonth:    Number(s.thisMonth    ?? 0),
    fromTeachers: Number(s.fromTeachers ?? 0),
  };
}
