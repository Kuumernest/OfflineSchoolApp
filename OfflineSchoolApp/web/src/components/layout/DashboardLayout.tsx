// web/src/layouts/DashboardLayout.tsx
import { useState }            from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar                 from "@/components/layout/Sidebar";
import TopBar                  from "@/components/layout/TopBar";
import { NAV_ITEMS }           from "@/config/navigation";

// ── Derive page title from current path ───────────────────
function usePageTitle(): string {
  const { pathname } = useLocation();

  const flatten = (items: typeof NAV_ITEMS): typeof NAV_ITEMS =>
    items.flatMap((i) => (i.children ? [i, ...flatten(i.children)] : [i]));

  const all   = flatten(NAV_ITEMS);
  const match = all
    .filter((i) => i.path)
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .find((i) => i.path && pathname.startsWith(i.path));

  return match?.label ?? "Dashboard";
}

// ─────────────────────────────────────────────────────────
export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const title = usePageTitle();

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">

      {/* Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* TopBar */}
        <TopBar
          onMenuClick={() => setSidebarOpen((o) => !o)}
          title={title}
        />

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>

      </div>
    </div>
  );
}