// web/src/main.tsx
//
// Application entry point.
//
// This file previously held a copy of index.css — index.html loads it as the
// module entry, so the app could not boot at all. It now does the four things
// a bootstrap is responsible for and nothing else:
//
//   1. restore the session from localStorage BEFORE the first render, so
//      ProtectedRoute never flashes the login screen at a signed-in user
//   2. install the React Query cache
//   3. install the router
//   4. install the toast/confirm portal
//   5. initialise i18n
//
// initAuth() is synchronous (it only reads localStorage), which is why it can
// run here rather than inside an effect. Doing it before createRoot means the
// very first paint already knows whether there is a session.

import { StrictMode }        from "react";
import { createRoot }        from "react-dom/client";
import { BrowserRouter }     from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
}                            from "@tanstack/react-query";


import App                   from "@/App";
import { ToastProvider }     from "@/components/ui/Toast";
import { useAuthStore }      from "@/store/auth.store";

// Imported for the side effect of calling i18n.init(). It must run before the
// first render, or useTranslation() on the very first paint returns raw keys.
import "@/i18n";
import "@/index.css";

// ─────────────────────────────────────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────────────────────────────────────

useAuthStore.getState().initAuth();

// ─────────────────────────────────────────────────────────────────────────────
// QUERY CLIENT
//
// staleTime is deliberately non-zero. A school dashboard is read-heavy and
// mostly slow-moving data (classes, subjects, periods), so refetching on every
// window focus produced a burst of requests each time an admin alt-tabbed
// back. Mutations invalidate explicitly, which is more precise than polling.
// ─────────────────────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:            60_000,
      gcTime:               5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry a request the server actively rejected — a 401/403/404
        // will not become a 200 on the third attempt, and retrying a 401
        // races the axios refresh interceptor.
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MOUNT
// ─────────────────────────────────────────────────────────────────────────────

const container = document.getElementById("root");
if (!container) throw new Error('index.html is missing <div id="root">');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/*
          One notification system: components/ui/Toast, the in-house context
          that also owns the confirm dialogs. react-hot-toast used to be
          mounted alongside it for the exam hooks; those 19 call sites all
          turned out to sit inside hooks or components, where useToast()
          reaches fine, so they now go through the same provider as every
          other page and the dependency is gone.
        */}
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
