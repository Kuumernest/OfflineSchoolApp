// web/src/layouts/DashboardLayout.tsx
import { useState, useCallback } from "react";
import { Outlet, useLocation }   from "react-router-dom";
import { useTranslation }        from "react-i18next";
import Sidebar                   from "@/components/layout/Sidebar";
import TopBar                    from "@/components/layout/TopBar";
import { NAV_ITEMS }             from "@/config/navigation";

// ── Derive page title from current path ───────────────────
function usePageTitle(): string {
  const { pathname } = useLocation();
  const { t }        = useTranslation();

  const flatten = (items: typeof NAV_ITEMS): typeof NAV_ITEMS =>
    items.flatMap((i) => (i.children ? [i, ...flatten(i.children)] : [i]));

  const all   = flatten(NAV_ITEMS);
  const match = all
    .filter((i) => i.path)
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .find((i) => i.path && pathname.startsWith(i.path));

  if (!match) return t("nav.dashboard");
  return match.labelKey
    ? t(match.labelKey, { defaultValue: match.label })
    : match.label;
}

// ─────────────────────────────────────────────────────────
export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const title = usePageTitle();

  // Stable identity: Sidebar closes itself on navigation via an effect, so an
  // inline arrow here would change every render and re-fire it in a loop.
  const closeSidebar  = useCallback(() => setSidebarOpen(false),  []);
  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">

      <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

        <TopBar onMenuClick={toggleSidebar} title={title} />

        {/*
          Capped at 1600px and centred. Left unbounded, a data table on a
          32-inch monitor stretches a five-column layout across a metre of
          glass and the eye loses the row it was following.
        */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-5 lg:px-6 lg:py-6">
            <Outlet />
          </div>
        </main>

      </div>
    </div>
  );
}
