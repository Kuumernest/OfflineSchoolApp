// src/store/announcement.store.js
"use strict";

import { create } from "zustand";
import {
  getAnnouncements,
  getAnnouncementStats,
  createAnnouncement,
  deleteAnnouncement,
  markAsRead,
  acknowledgeAnnouncement,
  getTeacherAnnouncementClasses,
  pullAnnouncements,
} from "../services/announcement.service";

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const toId   = (v) => (v == null ? "" : String(v).trim());
const toRole = (v) => String(v || "").toLowerCase().trim();

const getUserId = (user) =>
  toId(user?._id || user?.id || user?.userId);

// ✅ Pure helper — recomputes unread count from inbox array
const computeUnreadCount = (inbox) =>
  (inbox || []).filter((a) => !a.isRead).length;

// ✅ Robust author-match: normalise both sides before comparing
//    Prevents false mismatches from whitespace, case, or "undefined" strings
const isSameAuthor = (announcementAuthorId, userId) => {
  const aId = toId(announcementAuthorId);
  const uId = toId(userId);
  if (!aId || !uId) return false;
  return aId.toLowerCase() === uId.toLowerCase();
};

export const useAnnouncementStore = create((set, get) => ({

  // ── State ──────────────────────────────────────────────────────────────────
  inbox:           [],
  sent:            [],
  assignedClasses: [],
  unreadCount:     0,
  stats: {
    total:        0,
    unread:       0,
    urgentUnack:  0,
    pinned:       0,
    fromTeachers: 0,
  },
  loadingInbox:   false,
  loadingSent:    false,
  loadingClasses: false,
  submitting:     false,
  error:          null,

  // ── Fetch inbox ────────────────────────────────────────────────────────────
  fetchInbox: async (user) => {
    set({ loadingInbox: true, error: null });
    try {
      const userId = getUserId(user);
      const role   = toRole(user?.role);

      if (__DEV__) {
        console.log("[announcement.store] fetchInbox →", {
          userId,
          role,
          classId:      user?.classId,
          currentClass: user?.currentClass,
        });
      }

      // ── Students: pull fresh data from server BEFORE reading local cache ──
      // This ensures the local SQLite DB has the latest announcements.
      // Without this, the student would only see what was cached from a
      // previous session — missing any new teacher announcements.
      if (role === "student") {
        try {
          const pulled = await pullAnnouncements(null);
          if (__DEV__) {
            console.log(`[fetchInbox] student pull: ${pulled} item(s) from server`);
          }
        } catch (pullErr) {
          console.warn("[fetchInbox] student pull failed:", pullErr.message);
        }
      }

      const data = await getAnnouncements({ limit: 100 });

      if (__DEV__) {
        console.log(
          `[fetchInbox] getAnnouncements → ${(data || []).length} item(s):`,
          (data || []).map((a) => ({
            id: a.id, title: a.title, audience: a.audience, isRead: a.isRead,
          }))
        );
      }

      // ── Inbox filtering by role ────────────────────────────────────────────
      //
      // STUDENTS: show everything the service returns.
      //   The service's buildStudentWhereClause already enforces visibility:
      //   audience=all / audience=students / audience=class+classId match.
      //   We must NOT filter by authorId — teacher announcements to students
      //   must always appear in the student inbox.
      //
      // TEACHERS / ADMINS: exclude announcements they AUTHORED.
      //   Those belong in the "Sent" tab, not the inbox.
      //   We check ALL possible author id fields for robustness.
      let inbox;

      if (role === "student") {
        inbox = data || [];
      } else {
        inbox = (data || []).filter((a) => {
          const candidateAuthorIds = [
            a.authorId,
            a.author_id,
            a.author?.id,
            a.author?._id,
          ];
          const isOwn = candidateAuthorIds.some((cid) =>
            isSameAuthor(cid, userId)
          );
          return !isOwn;
        });
      }

      if (__DEV__) {
        console.log(
          `[announcement.store] fetchInbox result: ${inbox.length} item(s)`,
          inbox.map((a) => ({
            id:       a.id,
            title:    a.title,
            audience: a.audience,
            isRead:   a.isRead,
          }))
        );
      }

      set({
        inbox,
        unreadCount:  computeUnreadCount(inbox),
        loadingInbox: false,
      });
    } catch (err) {
      console.warn("[announcement.store] fetchInbox failed:", err.message);
      set({ error: err.message, loadingInbox: false });
    }
  },

  // ── Fetch sent ─────────────────────────────────────────────────────────────
  // Loads only announcements authored by this user — shown in Sent tab
  fetchSent: async (user) => {
    set({ loadingSent: true, error: null });
    try {
      const userId = getUserId(user);
      if (!userId) {
        set({ loadingSent: false });
        return;
      }
      const data = await getAnnouncements({ authorId: userId, limit: 100 });
      if (__DEV__) {
        console.log(
          `[announcement.store] fetchSent: ${(data || []).length} item(s) ` +
          `for authorId=${userId}`
        );
      }
      set({ sent: data || [], loadingSent: false });
    } catch (err) {
      console.warn("[announcement.store] fetchSent failed:", err.message);
      set({ error: err.message, loadingSent: false });
    }
  },

  // ── Fetch stats ────────────────────────────────────────────────────────────
  fetchStats: async () => {
    try {
      const stats = await getAnnouncementStats();
      set({ stats });
    } catch (err) {
      console.warn("[announcement.store] fetchStats failed:", err.message);
    }
  },

  // ── Fetch assigned classes ─────────────────────────────────────────────────
  fetchClasses: async () => {
    set({ loadingClasses: true, error: null });
    try {
      const raw = await getTeacherAnnouncementClasses();
      const classes = (raw || [])
        .map((c) => ({
          ...c,
          id:   String(c.id || c._id || ""),
          name: c.name || "Unnamed Class",
        }))
        .filter((c) => c.id);

      if (__DEV__) {
        console.log(
          `[announcement.store] fetchClasses: ${classes.length} class(es)`,
          classes.map((c) => `${c.name} [${c.id}]`).join(", ")
        );
      }
      set({ assignedClasses: classes, loadingClasses: false });
    } catch (err) {
      console.warn("[announcement.store] fetchClasses failed:", err.message);
      set({ assignedClasses: [], loadingClasses: false, error: err.message });
    }
  },

  // ── Fetch everything at once ───────────────────────────────────────────────
  fetchAll: async (user) => {
    const role = toRole(user?.role);
    const { fetchInbox, fetchSent, fetchStats, fetchClasses } = get();

    const tasks = [fetchInbox(user), fetchStats()];

    if (
      role === "teacher"      ||
      role === "admin"        ||
      role === "school_admin" ||
      role === "super_admin"
    ) {
      tasks.push(fetchSent(user), fetchClasses());
    }

    await Promise.allSettled(tasks);
  },

  // ── Create ─────────────────────────────────────────────────────────────────
  createNew: async (payload) => {
    if (get().submitting) {
      console.warn("[announcement.store] createNew already in progress");
      return null;
    }

    set({ submitting: true, error: null });

    try {
      const sanitised = {
        ...payload,
        targetClasses: (payload.targetClasses || [])
          .map((id) => String(id).trim())
          .filter(Boolean),
      };

      if (__DEV__) {
        console.log(
          "[announcement.store] createNew payload:",
          JSON.stringify({
            title:         sanitised.title,
            audience:      sanitised.audience,
            targetClasses: sanitised.targetClasses,
            priority:      sanitised.priority,
          }, null, 2)
        );
      }

      const result = await createAnnouncement(sanitised);

      // ✅ Add to sent (not inbox) — teacher sees own posts in Sent tab only
      set((state) => ({ sent: [result, ...state.sent] }));
      get().fetchStats().catch(() => {});

      return result;
    } catch (err) {
      console.error("[announcement.store] createNew failed:", err.message);
      set({ error: err.message });
      throw err;
    } finally {
      set({ submitting: false });
    }
  },

  // ── Delete (optimistic) ────────────────────────────────────────────────────
  remove: async (id) => {
    if (!id) return;

    set((state) => {
      const newInbox = state.inbox.filter((a) => (a.id || a._id) !== id);
      return {
        sent:        state.sent.filter((a) => (a.id || a._id) !== id),
        inbox:       newInbox,
        unreadCount: computeUnreadCount(newInbox),
      };
    });

    try {
      await deleteAnnouncement(id);
      get().fetchStats().catch(() => {});
    } catch (err) {
      console.error("[announcement.store] remove failed:", err.message);
      set({ error: err.message });
      throw err;
    }
  },

  // ── Mark read (optimistic) ─────────────────────────────────────────────────
  markRead: async (id) => {
    if (!id) return;

    const alreadyRead = get().inbox.some(
      (a) => (a.id || a._id) === id && a.isRead
    );
    if (alreadyRead) return;

    set((state) => {
      const wasUnread = state.inbox.some(
        (a) => (a.id || a._id) === id && !a.isRead
      );
      const newInbox = state.inbox.map((a) =>
        (a.id || a._id) === id ? { ...a, isRead: true } : a
      );
      return {
        inbox:       newInbox,
        unreadCount: computeUnreadCount(newInbox),
        stats: {
          ...state.stats,
          unread: wasUnread
            ? Math.max(0, state.stats.unread - 1)
            : state.stats.unread,
        },
      };
    });

    markAsRead(id).catch((err) =>
      console.warn("[announcement.store] markAsRead background failed:", err.message)
    );
  },

  // ── Acknowledge ────────────────────────────────────────────────────────────
  acknowledge: async (id) => {
    if (!id) return;

    const alreadyAck = get().inbox.some(
      (a) => (a.id || a._id) === id && a.isAcknowledged
    );
    if (alreadyAck) return;

    set((state) => {
      const wasUnread = state.inbox.some(
        (a) => (a.id || a._id) === id && !a.isRead
      );
      const newInbox = state.inbox.map((a) =>
        (a.id || a._id) === id
          ? { ...a, isRead: true, isAcknowledged: true }
          : a
      );
      return {
        inbox:       newInbox,
        unreadCount: computeUnreadCount(newInbox),
        stats: {
          ...state.stats,
          urgentUnack: Math.max(0, state.stats.urgentUnack - 1),
          unread: wasUnread
            ? Math.max(0, state.stats.unread - 1)
            : state.stats.unread,
        },
      };
    });

    acknowledgeAnnouncement(id).catch((err) =>
      console.warn("[announcement.store] acknowledge background failed:", err.message)
    );
  },

  // ── Helpers ────────────────────────────────────────────────────────────────
  getUnreadCount: () => get().unreadCount,
  clearError:     () => set({ error: null }),

  reset: () =>
    set({
      inbox:           [],
      sent:            [],
      assignedClasses: [],
      unreadCount:     0,
      stats: {
        total: 0, unread: 0, urgentUnack: 0, pinned: 0, fromTeachers: 0,
      },
      loadingInbox:    false,
      loadingSent:     false,
      loadingClasses:  false,
      submitting:      false,
      error:           null,
    }),
}));