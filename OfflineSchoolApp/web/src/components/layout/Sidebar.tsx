// web/src/components/layout/Sidebar.tsx
import { useState }                       from "react";
import { NavLink, useLocation }           from "react-router-dom";
import { ChevronDown, GraduationCap, X } from "lucide-react";
import { NAV_ITEMS, type NavItem }        from "@/config/navigation";
import { useUser }                        from "@/store/auth.store";
import { cn }                             from "@/utils/cn";
import { type UserRole }                  from "@/types";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const hasAccess = (item: NavItem, role: UserRole) =>
  item.roles.includes(role);

const isParentActive = (item: NavItem, pathname: string) =>
  item.children?.some((c) => c.path && pathname.startsWith(c.path)) ?? false;

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
  if (!item.path) return null;

  return (
    <NavLink
      to={item.path}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150",
          depth === 0 ? "mx-2" : "mx-4 pl-8",
          isActive
            ? "bg-primary-600 text-white shadow-sm"
            : "text-slate-400 hover:text-white hover:bg-slate-700/60"
        )
      }
    >
      <item.icon
        className={cn(
          "flex-shrink-0",
          depth === 0 ? "w-5 h-5" : "w-4 h-4"
        )}
      />
      <span>{item.label}</span>
      {item.badge && (
        <span className="ml-auto bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
          {item.badge}
        </span>
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
  const [open, setOpen] = useState(() => isParentActive(item, pathname));

  const visibleChildren =
    item.children?.filter((c) => hasAccess(c, role)) ?? [];
  if (!visibleChildren.length) return null;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "calc(100% - 1rem)" }}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm font-medium",
          "transition-all duration-150",
          isParentActive(item, pathname)
            ? "text-white bg-slate-700/60"
            : "text-slate-400 hover:text-white hover:bg-slate-700/60"
        )}
      >
        <item.icon className="w-5 h-5 flex-shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown
          className={cn(
            "w-4 h-4 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          open ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="mt-1 space-y-0.5 pb-1">
          {visibleChildren.map((child) => (
            <SingleItem key={child.path} item={child} depth={1} />
          ))}
        </div>
      </div>
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
  const user = useUser();
  const role = (user?.role ?? "student") as UserRole;

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-64 bg-slate-900 z-30 flex flex-col",
          "transform transition-transform duration-300 ease-in-out",
          "lg:translate-x-0 lg:static lg:z-auto",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <GraduationCap className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-none">
                SchoolAdmin
              </p>
              <p className="text-slate-400 text-xs mt-0.5 capitalize">
                {role.replace("_", " ")}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-slate-400 hover:text-white p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 space-y-0.5 scrollbar-hide">
          {NAV_ITEMS.map((item) => {
            if (!hasAccess(item, role)) return null;
            return item.children ? (
              <GroupItem key={item.label} item={item} role={role} />
            ) : (
              <SingleItem key={item.path} item={item} />
            );
          })}
        </nav>

        {/* User info */}
        <div className="border-t border-slate-700/50 p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-xs font-bold">
                {user?.name?.charAt(0).toUpperCase() ?? "?"}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">
                {user?.name}
              </p>
              <p className="text-slate-400 text-xs truncate">{user?.email}</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}