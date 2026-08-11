// src/utils/userStorage.js
"use strict";

/**
 * userStorage.js
 *
 * Persistent storage wrapper for the authenticated user object.
 *
 * Storage strategy:
 *  1. expo-secure-store  — encrypted, used on iOS and Android
 *  2. AsyncStorage       — unencrypted fallback used when:
 *                            a) running on web (SecureStore unavailable)
 *                            b) the serialised user exceeds the 2048-byte
 *                               SecureStore limit (rare but possible if the
 *                               user object has many populated fields)
 *
 * The fallback is transparent — callers use getUser / setUser / clearUser
 * and never need to know which store was used.
 *
 * Fixed issues:
 *  #SEC  — replaced bare AsyncStorage with expo-secure-store so the token
 *           and user PII are encrypted at rest on mobile devices
 *  #WEB  — AsyncStorage fallback retained so the app works on Expo Web
 *  #SIZE — automatic fallback when the payload exceeds SecureStore's 2 KB limit
 *  #KEY  — storage key namespaced to avoid collisions with other AsyncStorage
 *           consumers in the same app
 */

import * as SecureStore from "expo-secure-store";
import AsyncStorage     from "@react-native-async-storage/async-storage";
import { Platform }     from "react-native";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Primary key used in both SecureStore and AsyncStorage.
 * Namespaced so it does not collide with other keys in the same app.
 */
const SECURE_KEY = "auth_user";

/**
 * Fallback key written to AsyncStorage when SecureStore is unavailable or the
 * payload exceeds the 2048-byte limit. Kept distinct so a partial migration
 * (some data in one store, some in the other) can be detected and cleaned up.
 */
const ASYNC_KEY = "@app/auth_user";

/**
 * expo-secure-store has a hard 2048-byte limit per value.
 * We leave a small margin (48 bytes) to account for any internal overhead.
 */
const SECURE_STORE_LIMIT = 2000;

/**
 * True when SecureStore is supported on the current platform.
 * expo-secure-store is unavailable on web.
 */
const SECURE_STORE_AVAILABLE = Platform.OS !== "web";

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to write `value` to SecureStore.
 * Returns true on success, false if SecureStore is unavailable or the value
 * is too large.
 *
 * @param {string} value - Already-serialised JSON string
 * @returns {Promise<boolean>}
 */
const trySecureWrite = async (value) => {
  if (!SECURE_STORE_AVAILABLE) return false;
  if (value.length > SECURE_STORE_LIMIT) {
    console.warn(
      `[userStorage] Payload (${value.length} bytes) exceeds SecureStore limit ` +
      `(${SECURE_STORE_LIMIT} bytes) — falling back to AsyncStorage`
    );
    return false;
  }
  try {
    await SecureStore.setItemAsync(SECURE_KEY, value);
    return true;
  } catch (err) {
    console.warn("[userStorage] SecureStore write failed:", err.message);
    return false;
  }
};

/**
 * Attempts to read from SecureStore.
 * Returns the stored string, or null if unavailable / not found.
 *
 * @returns {Promise<string|null>}
 */
const trySecureRead = async () => {
  if (!SECURE_STORE_AVAILABLE) return null;
  try {
    return await SecureStore.getItemAsync(SECURE_KEY);
  } catch (err) {
    console.warn("[userStorage] SecureStore read failed:", err.message);
    return null;
  }
};

/**
 * Clears the value from SecureStore. Silently no-ops when unavailable.
 *
 * @returns {Promise<void>}
 */
const trySecureDelete = async () => {
  if (!SECURE_STORE_AVAILABLE) return;
  try {
    await SecureStore.deleteItemAsync(SECURE_KEY);
  } catch {
    // Already absent — not an error
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the stored user object.
 *
 * Read order:
 *  1. SecureStore (preferred — encrypted)
 *  2. AsyncStorage fallback key (used when the payload was too large for
 *     SecureStore, or when running on web)
 *
 * @returns {Promise<object|null>}
 */
export const getUser = async () => {
  try {
    // ── 1. Try SecureStore first ───────────────────────────────────────────
    const secure = await trySecureRead();
    if (secure) {
      return JSON.parse(secure);
    }

    // ── 2. Fall back to AsyncStorage ───────────────────────────────────────
    const raw = await AsyncStorage.getItem(ASYNC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("[userStorage] getUser failed:", err.message);
    return null;
  }
};

/**
 * Persists the user object.
 *
 * Write strategy:
 *  1. Attempt SecureStore (encrypted, preferred)
 *  2. On failure or size overflow, write to AsyncStorage
 *  3. When writing to AsyncStorage, delete the SecureStore entry to avoid
 *     a stale value being returned by a future getUser call
 *
 * @param {object} user
 * @returns {Promise<void>}
 */
export const setUser = async (user) => {
  if (!user || typeof user !== "object") {
    console.warn("[userStorage] setUser: invalid user — must be a non-null object");
    return;
  }

  try {
    const serialised = JSON.stringify(user);

    const wroteToSecure = await trySecureWrite(serialised);

    if (wroteToSecure) {
      // Clear any stale AsyncStorage entry from a previous oversized write
      await AsyncStorage.removeItem(ASYNC_KEY).catch(() => {});
    } else {
      // SecureStore unavailable or payload too large — use AsyncStorage
      await AsyncStorage.setItem(ASYNC_KEY, serialised);
      // Remove any stale SecureStore entry so getUser doesn't return old data
      await trySecureDelete();
    }
  } catch (err) {
    console.warn("[userStorage] setUser failed:", err.message);
  }
};

/**
 * Removes the stored user object from both stores.
 * Clears both SecureStore and AsyncStorage so no stale data remains.
 *
 * @returns {Promise<void>}
 */
export const clearUser = async () => {
  try {
    await Promise.all([
      trySecureDelete(),
      AsyncStorage.removeItem(ASYNC_KEY).catch(() => {}),
      // Also clear the old unnamespaced key in case this is an upgrade
      AsyncStorage.removeItem("user").catch(() => {}),
    ]);
  } catch (err) {
    console.warn("[userStorage] clearUser failed:", err.message);
  }
};

/**
 * Returns true if a user is currently persisted in either store.
 * Useful for deciding whether to show an onboarding screen before the
 * Zustand store has been hydrated.
 *
 * @returns {Promise<boolean>}
 */
export const hasUser = async () => {
  const user = await getUser();
  return user !== null;
};