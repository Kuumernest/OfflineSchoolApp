// src/services/storage.service.js

import AsyncStorage from "@react-native-async-storage/async-storage";

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABILITY CHECK
// Runs once and caches the result so subsequent calls are instant.
// ─────────────────────────────────────────────────────────────────────────────

let storageAvailable = null;

const checkStorage = async () => {
  if (storageAvailable !== null) return storageAvailable;

  try {
    await AsyncStorage.getItem("__health_check__");
    storageAvailable = true;
  } catch {
    storageAvailable = false;
    console.warn(
      "⚠️ AsyncStorage is not available. " +
      "Persistent storage will not work on this device."
    );
  }

  return storageAvailable;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads a value from AsyncStorage.
 *
 * @param {string} key
 * @param {*}      [defaultValue=null]  Returned when key does not exist or on error.
 * @returns {Promise<*>}
 */
export const getItem = async (key, defaultValue = null) => {
  try {
    const available = await checkStorage();
    if (!available) return defaultValue;

    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return defaultValue;

    try {
      return JSON.parse(raw);
    } catch {
      // Value is a plain string, not JSON — return as-is
      return raw;
    }
  } catch (err) {
    console.error(`❌ getItem("${key}") failed:`, err.message);
    return defaultValue;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes a value to AsyncStorage (JSON-serialised).
 *
 * @param {string} key
 * @param {*}      value
 * @returns {Promise<boolean>}  true on success, false on failure.
 */
export const setItem = async (key, value) => {
  try {
    const available = await checkStorage();
    if (!available) return false;

    await AsyncStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`❌ setItem("${key}") failed:`, err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes a single key from AsyncStorage.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export const removeItem = async (key) => {
  try {
    const available = await checkStorage();
    if (!available) return false;

    await AsyncStorage.removeItem(key);
    return true;
  } catch (err) {
    console.error(`❌ removeItem("${key}") failed:`, err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the key exists in AsyncStorage.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export const hasItem = async (key) => {
  try {
    const available = await checkStorage();
    if (!available) return false;

    const raw = await AsyncStorage.getItem(key);
    return raw !== null;
  } catch (err) {
    console.error(`❌ hasItem("${key}") failed:`, err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CLEAR ALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wipes ALL AsyncStorage data for this app.
 * Use with caution — intended for logout / factory reset flows only.
 *
 * @returns {Promise<boolean>}
 */
export const clearAll = async () => {
  try {
    const available = await checkStorage();
    if (!available) return false;

    await AsyncStorage.clear();
    console.log("🧹 AsyncStorage cleared");
    return true;
  } catch (err) {
    console.error("❌ clearAll() failed:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET MULTIPLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads multiple keys in one call.
 *
 * @param {string[]} keys
 * @returns {Promise<Record<string, *>>}  Object with key → parsed value pairs.
 *                                         Missing keys map to null.
 */
export const getMultipleItems = async (keys) => {
  try {
    const available = await checkStorage();
    if (!available) return Object.fromEntries(keys.map((k) => [k, null]));

    const pairs = await AsyncStorage.multiGet(keys);
    return Object.fromEntries(
      pairs.map(([key, raw]) => {
        if (raw === null) return [key, null];
        try {
          return [key, JSON.parse(raw)];
        } catch {
          return [key, raw];
        }
      })
    );
  } catch (err) {
    console.error("❌ getMultipleItems() failed:", err.message);
    return Object.fromEntries(keys.map((k) => [k, null]));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SET MULTIPLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes multiple key-value pairs in one call.
 *
 * @param {Record<string, *>} items  Object of key → value pairs.
 * @returns {Promise<boolean>}
 */
export const setMultipleItems = async (items) => {
  try {
    const available = await checkStorage();
    if (!available) return false;

    const pairs = Object.entries(items).map(([key, value]) => [
      key,
      JSON.stringify(value),
    ]);

    await AsyncStorage.multiSet(pairs);
    return true;
  } catch (err) {
    console.error("❌ setMultipleItems() failed:", err.message);
    return false;
  }
};