// web/src/lib/permissions.ts
//
// What the signed-in user may do, on the client.
//
// The list comes from the API — /api/auth/login and /api/auth/me both return
// the caller's effective capabilities — and it is here so a screen can ask
// "may this person do X" instead of "is this person a bursar". The difference
// matters as soon as a school adjusts a permission: a role test would keep
// hiding a button the server would now happily accept.
//
// ── This is a menu, not a lock ────────────────────────────────────────────
//
// Every one of these answers is a copy of a server-side decision, delivered at
// sign-in and stale from that moment on. Use it to decide what to OFFER —
// which button to draw, which tile to enable, which tab to show. Never use it
// as the last word on whether something is allowed: the route checks for
// itself, and a client that trusts this list is one stale token away from
// showing a control that 403s.
//
// A `false` here should therefore always be a hidden or disabled control, and
// never a silent skip of a request the user asked for.

import { useAuthStore } from "@/store/auth.store";

/**
 * Every capability the current user holds.
 *
 * Empty for a signed-out user, and empty for a session that predates the
 * permission layer — which is the safe direction: a client with no list offers
 * nothing extra rather than everything.
 */
export const usePermissions = (): string[] =>
  useAuthStore((s) => s.user?.permissions ?? []);

/**
 * Does the current user hold this capability?
 *
 *   const canSetSalary = usePermission("payroll.setSalary");
 *   <Button disabled={!canSetSalary}>…</Button>
 *
 * Prefer disabling with an explanation over hiding outright where the control
 * is something the user might reasonably expect to find. A missing button reads
 * as a broken page; a disabled one with a reason reads as a boundary.
 */
export const usePermission = (key: string): boolean =>
  useAuthStore((s) => (s.user?.permissions ?? []).includes(key));

/** Does the current user hold at least one of these? */
export const useAnyPermission = (...keys: string[]): boolean =>
  useAuthStore((s) => {
    const held = s.user?.permissions ?? [];
    return keys.some((k) => held.includes(k));
  });

/**
 * Non-hook form, for code outside a component — a react-query `enabled`, a
 * table column builder, a guard inside an event handler.
 */
export const hasPermission = (key: string): boolean =>
  (useAuthStore.getState().user?.permissions ?? []).includes(key);
