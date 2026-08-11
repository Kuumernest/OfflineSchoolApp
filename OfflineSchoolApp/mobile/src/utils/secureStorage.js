// src/utils/secureStorage.js

import { Platform } from "react-native";

/**
 * Cross-platform secure storage wrapper.
 *
 * - iOS / Android → expo-secure-store (encrypted native keychain)
 * - Web           → localStorage fallback (no native keychain available)
 *
 * Usage:
 *   import secureStorage from "../utils/secureStorage";
 *   await secureStorage.setItem("auth_token", token);
 *   const token = await secureStorage.getItem("auth_token");
 *   await secureStorage.deleteItem("auth_token");
 */

const secureStorage = {
  /**
   * Retrieve a stored value by key.
   * Returns null if not found or on error.
   */
  async getItem(key) {
    if (Platform.OS === "web") {
      try {
        return localStorage.getItem(key);
      } catch (err) {
        console.warn(`secureStorage.getItem failed for key "${key}":`, err);
        return null;
      }
    }

    try {
      const SecureStore = await import("expo-secure-store");
      return await SecureStore.getItemAsync(key);
    } catch (err) {
      console.warn(`secureStorage.getItem failed for key "${key}":`, err);
      return null;
    }
  },

  /**
   * Store a string value under the given key.
   * Value must be a string — JSON.stringify objects before storing.
   */
  async setItem(key, value) {
    if (Platform.OS === "web") {
      try {
        localStorage.setItem(key, value);
      } catch (err) {
        console.warn(`secureStorage.setItem failed for key "${key}":`, err);
      }
      return;
    }

    try {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.setItemAsync(key, value);
    } catch (err) {
      console.warn(`secureStorage.setItem failed for key "${key}":`, err);
    }
  },

  /**
   * Remove a stored value by key.
   */
  async deleteItem(key) {
    if (Platform.OS === "web") {
      try {
        localStorage.removeItem(key);
      } catch (err) {
        console.warn(`secureStorage.deleteItem failed for key "${key}":`, err);
      }
      return;
    }

    try {
      const SecureStore = await import("expo-secure-store");
      await SecureStore.deleteItemAsync(key);
    } catch (err) {
      console.warn(`secureStorage.deleteItem failed for key "${key}":`, err);
    }
  },
};

export default secureStorage;