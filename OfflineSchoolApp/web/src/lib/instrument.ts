// web/src/lib/instrument.ts
//
// Browser error reporting. Imported first in main.tsx, before the app.
//
// ── Inert without a DSN ───────────────────────────────────────────────────────
//
// No VITE_SENTRY_DSN means init() is never called: no network, no listeners, no
// bundle cost beyond the import. Development, CI and any deployment that has not
// been given a DSN behave exactly as before.
//
// ── What is deliberately NOT sent ─────────────────────────────────────────────
//
// The console is where this app talks about pupils: request logs, sync traces,
// the offline adapter narrating what it answered locally. Sentry's default
// breadcrumbs would forward all of it, so console and fetch/xhr breadcrumbs are
// dropped and the URL is stripped of its query — schoolId and studentId live
// there. What survives is the shape of the failure: the component that threw,
// the route, the stack.
//
// ── The desktop is the reason this matters ────────────────────────────────────
//
// This same bundle runs inside Electron in a school office. A crash there has no
// browser console anyone will read and no user who will file a report; without
// this it is simply a screen that stopped working.

import * as Sentry from "@sentry/react";

const dsn = (import.meta.env.VITE_SENTRY_DSN ?? "").trim();

export const errorReportingEnabled = Boolean(dsn);

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,

    // Off: this would attach IP addresses and user identifiers to every event.
    sendDefaultPii: false,

    // Opt-in and off by default. A school on a metered connection should not be
    // spending it on performance traces nobody asked for.
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),

    // Session replay is not enabled and should not be: it would record a screen
    // showing children's names and marks.
    integrations: [],

    beforeBreadcrumb(crumb) {
      // console breadcrumbs carry whatever the app logged, which here includes
      // pupil rows and sync payloads. fetch/xhr crumbs carry the URLs.
      if (crumb.category === "console") return null;
      if (crumb.category === "fetch" || crumb.category === "xhr") {
        if (crumb.data && typeof crumb.data.url === "string") {
          crumb.data.url = crumb.data.url.split("?")[0] + "?[redacted]";
        }
      }
      return crumb;
    },

    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = event.request.url.split("?")[0] + "?[redacted]";
      }
      delete event.request?.cookies;
      if (event.request?.headers) delete event.request.headers.Authorization;
      return event;
    },
  });
}
