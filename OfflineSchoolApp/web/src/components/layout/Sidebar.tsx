// web/src/components/layout/Sidebar.tsx
import { useState, useEffect }          from "react";
import { useTranslation }                from "react-i18next";
import { NavLink, useLocation }         from "react-router-dom";
import { ChevronRight, GraduationCap, X } from "lucide-react";
import { NAV_ITEMS, type NavItem }      from "@/config/navigation";
import { sectionForPath, NAV_GROUPS, groupIndexFor } from "@/config/sections";
import { useUser }                      from "@/store/auth.store";
import { cn }                           from "@/utils/cn";
import { type UserRole }                from "@/types";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const hasAccess = (item: NavItem, role: UserRole) =>
  item.roles.includes(role);

const isParentActive = (item: NavItem, pathname: string) =>
  item.children?.some((c) => c.path && pathname.startsWith(c.path)) ?? false;

/**
 * Translate a nav entry, falling back to its English label.
 *
 * The fallback matters: a new nav item added without a translation key still
 * renders its name rather than an empty row or a raw "nav.foo".
 */
const useNavLabel = () => {
  const { t } = useTranslation();
  return (item: NavItem) =>
    item.labelKey ? t(item.labelKey, { defaultValue: item.label }) : item.label;
};

/* Shared by every row in the rail so a top-level link, a group header and a
   child link are all the same height and share one left edge. Rows are 34px:
   the full nav has to fit without scrolling on a laptop, or the rail becomes a
   second thing to navigate. */
const ROW =
  "group flex w-full items-center gap-2.5 rounded-control " +
  "px-2.5 h-[38px] text-sm font-medium transition-colors";

/** A top-level entry's own path, or the first child's if it is a group. */
const firstPath = (item: NavItem): string | undefined =>
  item.path ?? item.children?.find((c) => c.path)?.path;

// ─────────────────────────────────────────────────────────
// SINGLE ITEM
// ─────────────────────────────────────────────────────────

function SingleItem({
  item,
  depth = 0,
}: {
  item:   NavItem;
  depth?: number;
}) {
  const navLabel = useNavLabel();
  if (!item.path) return null;

  return (
    <NavLink
      to={item.path}
      end={item.path === "/dashboard"}
      className={({ isActive }) =>
        cn(
          ROW,
          isActive
            ? "bg-primary-600 text-nav-text-active"
            : "text-nav-text hover:bg-nav-raised hover:text-nav-text-active"
        )
      }
    >
      {({ isActive }) => (
        <>
          {depth === 0 ? (
            /* The icon carries its section's colour when the row is at rest,
               and turns white when the row is the one you are on. That is the
               whole of the wayfinding: nineteen destinations that used to be
               nineteen identical grey glyphs now differ before you read them.
               See config/sections.ts. */
            <item.icon
              className={cn(
                "h-[18px] w-[18px] shrink-0 transition-colors",
                isActive ? "text-white" : sectionForPath(item.path ?? "").navIcon
              )}
              aria-hidden="true"
            />
          ) : (
            /* Children get a dot rather than a second icon. Two icon columns
               at different sizes made the nesting read as noise; one dot that
               brightens when active reads as a child. */
            <span
              className={cn(
                "ml-1 h-1.5 w-1.5 shrink-0 rounded-full transition-colors",
                isActive
                  ? "bg-nav-text-active"
                  : "bg-nav-line group-hover:bg-nav-text"
              )}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{navLabel(item)}</span>
          {item.badge && (
            <span className="ml-auto rounded-control bg-danger px-1.5 text-[11px] font-semibold leading-5 text-white">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// ─────────────────────────────────────────────────────────
// GROUP ITEM
// ─────────────────────────────────────────────────────────

function GroupItem({
  item,
  role,
}: {
  item: NavItem;
  role: UserRole;
}) {
  const { pathname } = useLocation();
  const navLabel     = useNavLabel();
  const active       = isParentActive(item, pathname);
  const [open, setOpen] = useState(active);

  // Navigating into a section from outside the rail — a dashboard tile, a deep
  // link — has to open the section holding the current page, or the rail gives
  // no indication of where you are.
  //
  // Adjusted during render rather than in an effect: React's documented way to
  // reconcile state with a changed input. An effect would paint the collapsed
  // section first and expand it on a second pass, which the user sees as a
  // flicker on every navigation.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setOpen(true);
  }

  const visibleChildren =
    item.children?.filter((c) => hasAccess(c, role)) ?? [];
  if (!visibleChildren.length) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          ROW,
          active && !open
            ? "text-nav-text-active"
            : "text-nav-text hover:bg-nav-raised hover:text-nav-text-active"
        )}
      >
        <item.icon
          className={cn(
            "h-[18px] w-[18px] shrink-0 transition-colors",
            active ? "text-white" : sectionForPath(firstPath(item) ?? "").navIcon
          )}
          aria-hidden="true"
        />
        <span className="flex-1 truncate text-left">{navLabel(item)}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-nav-line transition-transform duration-150",
            "group-hover:text-nav-text",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="relative mt-0.5 space-y-0.5 pb-1">
          {/* Guide rail: ties the children to their parent so an indented list
              reads as one group instead of four loose links. */}
          <span
            className="absolute left-[18px] top-0 bottom-1 w-px bg-nav-line"
            aria-hidden="true"
          />
          {visibleChildren.map((child) => (
            <SingleItem key={child.path} item={child} depth={1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────

interface SidebarProps {
  isOpen:  boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { t } = useTranslation();
  const user = useUser();
  const role = (user?.role ?? "student") as UserRole;
  const { pathname } = useLocation();

  // Tapping a link on mobile should dismiss the overlay; on desktop the rail
  // is static and this is a no-op. DashboardLayout passes a stable onClose so
  // listing it here cannot loop.
  useEffect(() => { onClose(); }, [pathname, onClose]);

  const initial = user?.name?.charAt(0).toUpperCase() ?? "?";

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-20 bg-ink/40 backdrop-blur-[1px] lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-30 flex h-full w-60 flex-col bg-nav-bg",
          "transition-transform duration-200 ease-[var(--ease-out-quiet)]",
          "lg:static lg:z-auto lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Brand — same 56px as the top bar, so the two align across the seam */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-nav-line px-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-primary-600">
            <GraduationCap className="h-4 w-4 text-white" aria-hidden="true" />
          </div>
          <p className="truncate font-display text-[17px] text-nav-text-active">
            SchoolAdmin
          </p>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-control p-1 text-nav-text hover:text-nav-text-active lg:hidden"
            aria-label={t("nav.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        {/*
          * Nineteen destinations with a labelled break every few rows.
          *
          * Nothing moves: an entry is exactly where whoever learned this rail
          * last week left it. What changes is that the eye lands on "Money"
          * and reads three entries, instead of scanning nineteen identical
          * rows for the one it wants. A heading is only drawn when a group has
          * a visible entry, so a bursar — who sees six of the nineteen — gets
          * three headings rather than seven with gaps between them.
          */}
        <nav className="scrollbar-hide flex-1 overflow-y-auto px-2 py-3">
          {NAV_GROUPS.map((group, gi) => {
            const items = NAV_ITEMS.filter(
              (item) => hasAccess(item, role) && groupIndexFor(firstPath(item)) === gi
            );
            if (!items.length) return null;

            return (
              <div key={group.labelKey} className={cn(gi > 0 && "mt-5")}>
                <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase
                              tracking-[0.1em] text-nav-text/70">
                  {t(group.labelKey, { defaultValue: group.label })}
                </p>
                <div className="space-y-0.5">
                  {items.map((item) =>
                    item.children ? (
                      <GroupItem key={item.label} item={item} role={role} />
                    ) : (
                      <SingleItem key={item.path} item={item} />
                    )
                  )}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Signed-in user */}
        <div className="shrink-0 border-t border-nav-line p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nav-raised text-xs font-semibold text-nav-text-active">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-nav-text-active">
                {user?.name}
              </p>
              <p className="truncate text-[11px] capitalize text-nav-text">
                {role.replace("_", " ")}
              </p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
