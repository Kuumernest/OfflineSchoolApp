// app/index.js

import React, { useEffect } from "react";
import { useRouter, useRootNavigationState } from "expo-router";
import { View, ActivityIndicator, StatusBar } from "react-native";

import { useAuthStore } from "../src/store/auth.store";
import { getRoleRoute } from "../src/services/routes";

export default function Index() {
  const router              = useRouter();
  const rootNavigationState = useRootNavigationState();

  const user           = useAuthStore((state) => state.user);
  const initAuth       = useAuthStore((state) => state.initAuth);
  const isLoading      = useAuthStore((state) => state.isLoading);
  const hasInitialized = useAuthStore((state) => state.hasInitialized);

  // ─────────────────────────────────────────────────────────
  // 1. Initialise auth store once on mount
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasInitialized) {
      initAuth();
    }
  }, [initAuth, hasInitialized]);

  // NOTE: starting the sync engine used to live here. It moved to
  // app/_layout.js — index is a route, and the flows that replace straight to
  // a role dashboard (auth/set-password, and the layout's own auth-group
  // redirect) never mount it, so those sessions never got a sync engine.

  // ─────────────────────────────────────────────────────────
  // 2. Navigate based on auth state (runs after every relevant
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