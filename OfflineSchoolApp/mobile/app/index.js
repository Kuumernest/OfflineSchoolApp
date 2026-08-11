// app/index.js

import React, { useEffect, useRef } from "react";
import { useRouter, useRootNavigationState } from "expo-router";
import { View, ActivityIndicator, StatusBar } from "react-native";

import { useAuthStore } from "../src/store/auth.store";
import { getRoleRoute } from "../src/services/routes";
import { SyncManager } from "../src/services/syncManager";

export default function Index() {
  const router              = useRouter();
  const rootNavigationState = useRootNavigationState();

  const user           = useAuthStore((state) => state.user);
  const token          = useAuthStore((state) => state.token);
  const initAuth       = useAuthStore((state) => state.initAuth);
  const isLoading      = useAuthStore((state) => state.isLoading);
  const hasInitialized = useAuthStore((state) => state.hasInitialized);
  const setSyncError   = useAuthStore((state) => state.setSyncError);

  // ── Tracks whether sync has been started for the current session.
  // Stored in a ref so changing it never triggers a re-render.
  // Reset whenever the user identity changes (logout → new login).
  const syncStarted = useRef(false);

  // ─────────────────────────────────────────────────────────
  // 1. Initialise auth store once on mount
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasInitialized) {
      initAuth();
    }
  }, [initAuth, hasInitialized]);

  // ─────────────────────────────────────────────────────────
  // 2. Reset sync gate when the logged-in user changes.
  //    Without this, a second user logging in on the same
  //    device would skip sync because the ref still holds
  //    true from the previous session.
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    syncStarted.current = false;
  }, [user?.id]);

  // ─────────────────────────────────────────────────────────
  // 3. Start background sync.
  //    Blocked until:
  //      • A user and token exist
  //      • The user has set their permanent password
  //      • Sync has not already been started this session
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user || !token)        return;
    if (user.mustResetPassword) return; // password wall — no data access yet
    if (syncStarted.current)    return;

    syncStarted.current = true;
    console.log("🔄 Starting full sync…");

    SyncManager.syncAll().catch((error) => {
      console.error("⚠️ Sync failed:", error.message);

      // Surface the failure so the UI can warn the user that
      // data may be stale.
      if (typeof setSyncError === "function") {
        setSyncError(
          "Data sync failed. Some information may be outdated."
        );
      }
    });
  }, [user, token, setSyncError]);

  // ─────────────────────────────────────────────────────────
  // 4. Navigate based on auth state (runs after every relevant
  //    state change; no-ops until navigation is ready).
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    // Wait for the navigator to mount
    if (!rootNavigationState?.key)    return;
    // Wait for auth initialisation to complete
    if (isLoading || !hasInitialized) return;

    // Not logged in → login screen
    if (!user) {
      router.replace("/auth/login");
      return;
    }

    // Any user whose password has not been changed yet goes to
    // the set-password screen regardless of role.
    if (user.mustResetPassword) {
      console.log("🔒 mustResetPassword=true → /auth/set-password");
      router.replace("/auth/set-password");
      return;
    }

    // Role-based routing
    try {
      const route = getRoleRoute(user);
      console.log(`✅ Navigation guard passed, rendering route`);
      router.replace(route || "/auth/login");
    } catch (err) {
      console.error("❌ Route resolution failed:", err);
      router.replace("/auth/login");
    }
  }, [
    user,
    isLoading,
    hasInitialized,
    router,
    rootNavigationState?.key,
  ]);

  // ─────────────────────────────────────────────────────────
  // RENDER — splash / loading indicator
  // ─────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: "#F9FAFB" }}>
      <StatusBar barStyle="dark-content" />
      <View
        style={{
          flex:           1,
          justifyContent: "center",
          alignItems:     "center",
        }}
      >
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    </View>
  );
}