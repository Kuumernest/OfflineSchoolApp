// app/_layout.js
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";

import { initDatabase } from "../src/db/initDatabase";
import { useAuthStore } from "../src/store/auth.store";
import { getRoleRoute } from "../src/services/routes";

export default function RootLayout() {
  const router   = useRouter();
  const segments = useSegments();

  const user           = useAuthStore((s) => s.user);
  const initAuth       = useAuthStore((s) => s.initAuth);
  const isLoading      = useAuthStore((s) => s.isLoading);
  const hasInitialized = useAuthStore((s) => s.hasInitialized); // ✅ ADD THIS

  const [dbReady, setDbReady] = useState(false);

  // ── Boot — initialise SQLite ────────────────────────────
  useEffect(() => {
    const boot = async () => {
      try {
        await initDatabase();
        setDbReady(true);
      } catch (e) {
        console.error("DB init failed:", e);
        setDbReady(true);
      }
    };
    boot();
  }, []);

  // ── Hydrate — restore auth from storage ─────────────────
  useEffect(() => {
    if (dbReady) {
      initAuth(); // ✅ only run AFTER db is ready
    }
  }, [dbReady]); // ✅ removed initAuth from deps to avoid re-runs

  // ── Navigation guard ────────────────────────────────────
  useEffect(() => {
    // ✅ Wait for BOTH db AND auth to finish
    if (!dbReady || !hasInitialized || isLoading) return;

    const path    = "/" + (segments?.join("/") || "");
    const isAuthGroup    = segments[0] === "auth";
    const onSetPassword  = segments[0] === "auth" && segments[1] === "set-password";
    const onProfileSetup = segments[1] === "profile";

    if (onProfileSetup) {
      console.log("🔓 Profile setup screen — guard bypassed");
      return;
    }

    // 1. Not logged in
    if (!user) {
      if (!isAuthGroup) {
        console.log("🚫 No user — redirecting to login");
        router.replace("/auth/login");
      }
      return;
    }

    // 2. Must reset password
    if (user.mustResetPassword && !onSetPassword) {
      console.log("🔑 mustResetPassword — redirecting to /auth/set-password");
      router.replace("/auth/set-password");
      return;
    }

    // 3. Logged in but on an auth screen
    if (isAuthGroup && !onSetPassword) {
      const target = getRoleRoute(user);
      console.log("🔄 On auth screen — redirecting to:", target);
      router.replace(target || "/auth/login");
      return;
    }

    // 4. Wrong role section
    const target         = getRoleRoute(user);
    const currentSection = path.split("/")[1];
    const targetSection  = (target || "").split("/")[1];

    if (
      currentSection &&
      targetSection &&
      currentSection !== targetSection &&
      !onSetPassword
    ) {
      console.log("🚦 Wrong section — redirecting to:", target);
      router.replace(target || "/auth/login");
      return;
    }

    console.log("✅ Navigation guard passed:", path);
  }, [
    dbReady,
    hasInitialized, // ✅ added
    isLoading,
    user,
    segments,
    router,
  ]);

  // ── Splash — show loader until BOTH are ready ───────────
  if (!dbReady || !hasInitialized || isLoading) { // ✅ added hasInitialized
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}

const styles = StyleSheet.create({
  splash: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
  },
});