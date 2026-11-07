// web/src/utils/portalRoutes.ts
//
// The guardian portal's sections as URLs, its Messages badge, and its tab
// title. Pure, so scripts/check-portal-routes.mjs can run it under node.
//
// The sections used to be in-page state: a refresh dropped the parent back on
// Home, a link could not point at Fees, and the browser's back button left the
// portal altogether. Each section is now a path under /portal, and the page
// reads which one it is showing from the URL.

export type PortalScreen = "home" | "results" | "attendance" | "fees" | "messages";

/** Every section but Home, which is /portal itself. */
export const PORTAL_SECTIONS = ["results", "attendance", "fees", "messages"] as const;

export const PORTAL_BASE = "/portal";

/** The URL of a section. */
export function portalPath(screen: PortalScreen): string {
  return screen === "home" ? PORTAL_BASE : `${PORTAL_BASE}/${screen}`;
}

/**
 * The section a URL shows, or null when it names none (the page sends that
 * back to /portal rather than showing a blank one). A trailing slash is the
 * same page.
 */
export function portalScreenFromPath(pathname: string): PortalScreen | null {
  const rest = pathname.replace(/\/+$/, "");
  if (rest === PORTAL_BASE) return "home";
  if (!rest.startsWith(`${PORTAL_BASE}/`)) return null;
  const section = rest.slice(PORTAL_BASE.length + 1);
  return (PORTAL_SECTIONS as readonly string[]).includes(section) ? (section as PortalScreen) : null;
}

/** What /portal/me says is unread in the Messages section. */
export interface PortalUnread {
  unread?: { messages?: number; notices?: number; total?: number } | null;
  unreadMessages?: number;
  unreadNotices?: number;
}

const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);

/**
 * The Messages section's badge: the server's own total. A server from before
 * `unread` existed sends the two halves, which are summed instead.
 */
export function messagesBadge(me: PortalUnread | null | undefined): number {
  if (!me) return 0;
  if (me.unread && typeof me.unread.total === "number") return n(me.unread.total);
  return n(me.unreadMessages) + n(me.unreadNotices);
}

/**
 * The tab the Messages section opens on: the one holding what the badge
 * counted. It opened on Conversations whatever the badge said, so one unread
 * notice drew a 1 over a screen saying "No conversations yet".
 */
export function messagesLanding(me: PortalUnread | null | undefined): "messages" | "notices" {
  const messages = n(me?.unread?.messages ?? me?.unreadMessages);
  const notices  = n(me?.unread?.notices ?? me?.unreadNotices);
  return messages === 0 && notices > 0 ? "notices" : "messages";
}

/** The browser tab's title in the portal: the school, or what it already said. */
export function portalTitle(schoolName: string | null | undefined, fallback: string): string {
  const name = (schoolName ?? "").trim();
  return name || fallback;
}
