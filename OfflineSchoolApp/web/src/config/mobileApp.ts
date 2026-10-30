// web/src/config/mobileApp.ts
//
// Where a teacher or a student gets the phone app, shown on the screen the web
// console gives them instead of the dashboard (components/auth/StaffOnly).
//
// Configuration, never a guess: set per deployment in the web build's
// environment (see web/.env.production.example).
//
//   VITE_ANDROID_APP_URL   the APK, or the Play Store listing once there is one
//   VITE_IOS_APP_URL       the App Store listing — none exists yet
//
// An unset or non-http(s) value shows no link, and the screen says to ask the
// school office instead: a dead link on the one screen meant to send someone
// somewhere is worse than an honest sentence.

const httpUrl = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export const MOBILE_APP_LINKS = {
  android: httpUrl(import.meta.env.VITE_ANDROID_APP_URL),
  ios:     httpUrl(import.meta.env.VITE_IOS_APP_URL),
} as const;
