// app/_layout.js
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useRef, useState }   from "react";
import {
  View,
  ActivityIndicator,
  StyleSheet,
  Text,
} from "react-native";

import { getDatabase }  from "../src/db/database";
import { useAuthStore } from "../src/store/auth.store";
import { getRoleRoute } from "../src/services/routes";
import { SyncManager }  from "../src/services/syncManager";
import { loadStoredLanguage } from "../src/i18n";

export default function RootLayout() {
  const router   = useRouter();
  const segments = useSegments();

  // ✅ Read every possible "auth is done" flag the store might set.
  //    We don't know which one the store uses until we see it fire.
  const hydrated       = useAuthStore((s) => s.hydrated        ?? false);
  const hasInitialized = useAuthStore((s) => s.hasInitialized  ?? false);
  const isLoading      = useAuthStore((s) => s.isLoading       ?? false);
  const user           = useAuthStore((s) => s.user);
  const token          = useAuthStore((s) => s.token);
  const initAuth       = useAuthStore((s) => s.initAuth);
  const setSyncError   = useAuthStore((s) => s.setSyncError);

  // ✅ Auth is ready when EITHER flag is true AND we are not mid-login
  const authReady = (hydrated || hasInitialized) && !isLoading;

  const [dbReady,    setDbReady]    = useState(false);
  const [forceReady, setForceReady] = useState(false);

  const authInitiated = useRef(false);

  // ── Debug — log every state change so we can see what's blocking ───────
  useEffect(() => {
    if (!__DEV__) return;
    console.log("[layout] state →", {
      dbReady,
      hydrated,
      hasInitialized,
      isLoading,
      authReady,
      forceReady,
      hasUser:  !!user,
      hasToken: !!token,
    });
  }, [dbReady, hydrated, hasInitialized, isLoading, authReady, forceReady, user, token]);

  // ── Language ───────────────────────────────────────────────────────────
  // The device locale is already applied synchronously at import, so the first
  // frame is in the right language; this only applies a saved override. It is
  // deliberately not awaited by anything — a language preference must never be
  // able to hold up app start.
  useEffect(() => {
    loadStoredLanguage().catch(() => { /* keep the device language */ });
  }, []);

  // ── Boot — open SQLite ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        await getDatabase();
        if (!cancelled) {
          console.log("[layout] ✅ DB ready");
          setDbReady(true);
        }
      } catch (err) {
        console.error("[layout] DB init failed:", err.message);
        if (!cancelled) setDbReady(true); // always unblock
      }
    };
    boot();
    return () => { cancelled = true; };
  }, []);

  // ── Hydrate — restore auth from SecureStore ────────────────────────────
  useEffect(() => {
    if (!dbReady) return;
    if (authInitiated.current) return;
    authInitiated.current = true;

    console.log("[layout] calling initAuth…");
    initAuth()
      .then((result) => console.log("[layout] initAuth resolved:", result))
      .catch((err)   => console.warn("[layout] initAuth failed:", err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReady]);

  // ── Safety net — if auth never resolves, unblock after 5 s ────────────
  // ✅ This is the fix for the infinite spinner. If the Zustand store
  //    never updates `hydrated` or `hasInitialized` (e.g. because the
  //    store field names don't match what the selector reads), the app
  //    would spin forever. After 5 s we force-unblock and let the
  //    navigation guard decide what to do with whatever state exists.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!authReady) {
        console.warn(
          "[layout] ⚠️  Auth did not resolve in 5 s — force-unblocking.\n" +
          "         Check that auth.store sets `hydrated` or `hasInitialized`.\n" +
          "         Current store state:",
          useAuthStore.getState()
        );
        setForceReady(true);
      }
    }, 5_000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  // ── Sync engine ────────────────────────────────────────────────────────
  // Lives here, not in app/index.js. index is a route, and several flows
  // never pass through it — auth/set-password replaces straight to a role
  // dashboard, and the guard below redirects out of the auth group directly.
  // Since logout() calls SyncManager.destroy(), any of those paths left the
  // session with no interval, no reconnect listener, and no sync at all
  // until the app was killed and reopened.
  //
  // ensureStarted() is idempotent and de-duplicates concurrent calls, so
  // re-running it on every session change is cheap.
  useEffect(() => {
    if (!dbReady)               return;
    if (!user || !token)        return;
    if (user.mustResetPassword) return;   // password wall — no data access yet

    SyncManager.ensureStarted().catch((err) => {
      console.warn("[layout] sync engine failed to start:", err.message);
      // Surface it — the screens below are about to render cached data with
      // no indication that it is stale.
      setSyncError?.("Data sync failed. Some information may be outdated.");
    });
  }, [dbReady, user?.id, token, user?.mustResetPassword, setSyncError]);

  // ── Navigation guard ───────────────────────────────────────────────────
  const canNavigate = dbReady && (authReady || forceReady);

  useEffect(() => {
    if (!canNavigate) return;

    const path           = "/" + (segments?.join("/") || "");
    const isAuthGroup    = segments[0] === "auth";
    const onSetPassword  = segments[0] === "auth" && segments[1] === "set-password";
    const onProfileSetup = segments[1] === "profile";

    if (onProfileSetup) {
      console.log("🔓 Profile setup screen — guard bypassed");
      return;
    }

    if (!user) {
      if (!isAuthGroup) {
        console.log("🚫 No user — redirecting to /auth/login");
        router.replace("/auth/login");
      }
      return;
    }

    if (user.mustResetPassword && !onSetPassword) {
      console.log("🔑 mustResetPassword — redirecting to /auth/set-password");
      router.replace("/auth/set-password");
      return;
    }

    if (isAuthGroup && !onSetPassword) {
      const target = getRoleRoute(user);
      console.log("🔄 On auth screen — redirecting to:", target);
      router.replace(target || "/auth/login");
      return;
    }

    const target         = getRoleRoute(user);
    const currentSection = path.split("/")[1];
    const targetSection  = (target || "").split("/")[1];

    // Sections every signed-in role may open, regardless of their home
    // section. Without this the guard would bounce a user straight back out
    // of /sync/pending the moment they tapped the offline banner.
    const SHARED_SECTIONS = new Set(["sync"]);

    if (
      currentSection &&
      targetSection  &&
      currentSection !== targetSection &&
      !SHARED_SECTIONS.has(currentSection) &&
      !onSetPassword
    ) {
      console.log("🚦 Wrong section — redirecting to:", target);
      router.replace(target || "/auth/login");
      return;
    }

    console.log("✅ Navigation guard passed:", path);
  }, [canNavigate, user, segments, router]);

  // ── Splash ─────────────────────────────────────────────────────────────
  if (!canNavigate) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#4F46E5" />
        {/* ✅ Show debug text in dev so you can see what's blocking */}
        {__DEV__ && (
          <Text style={styles.debugText}>
            {!dbReady
              ? "Opening database…"
              : isLoading
                ? "Restoring session…"
                : !hydrated && !hasInitialized
                  ? "Waiting for auth store…"
                  : "Navigating…"}
          </Text>
        )}
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

const styles = StyleSheet.create({
  splash: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
    gap:             12,
  },
  debugText: {
    fontSize:  13,
    color:     "#6B7280",
    marginTop: 8,
  },
});