// mobile/src/services/export.service.js
"use strict";

/**
 * Spreadsheet exports on the phone.
 *
 * The workbooks are built server-side, in backend/src/export — the same files
 * the web console downloads. What happens here is the phone's half: get the
 * bytes onto the device and into a share sheet, because a phone rarely has a
 * printer or a spreadsheet app but always has somewhere to send a file.
 *
 * Online only, deliberately. An export is a snapshot of the school's books at
 * one moment; a cached copy handed over days later, with nothing to say it is
 * stale, is worse than an honest "no connection". Everything genuinely needed
 * offline is already a live screen elsewhere in the app.
 */

import { File, Paths } from "expo-file-system";
import * as Sharing    from "expo-sharing";
import * as SecureStore from "expo-secure-store";

import api, { API_URL } from "./api";
import { appError }     from "../utils/appError";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Same key api.js stores the bearer token under. */
const TOKEN_KEY = "auth_token";

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Fetch one export straight to disk.
 *
 * `File.downloadFileAsync` rather than an axios request: React Native has no
 * real binary body type, so pulling a workbook through the HTTP client means
 * base64-encoding it by hand, and any mismatch between what the adapter returns
 * and what the encoder expects produces a file that looks fine until Excel
 * refuses to open it — with nothing in the app able to say why. Writing the
 * bytes directly removes that whole class of failure.
 *
 * @returns {Promise<{ uri: string, fileName: string, size: number }>}
 */
export const fetchExport = async ({ schoolId, kind, lang = "en", params = {} }) => {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  const url   = `${API_URL}/exports/${kind}${qs({ schoolId, lang, ...params })}`;

  // Named here rather than taken from Content-Disposition: downloadFileAsync
  // needs a destination up front, and a predictable name means exporting the
  // same thing twice replaces the file instead of littering the cache.
  const fileName = [kind, params.classId, params.periodMonth, params.academicYear]
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "_") + ".xlsx";

  const dest = new File(Paths.cache, fileName);
  if (dest.exists) {
    try { dest.delete(); } catch { /* a stale handle is not worth failing over */ }
  }

  const downloaded = await File.downloadFileAsync(url, dest, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    idempotent: true,
  });

  const file = new File(downloaded?.uri || dest.uri);

  // A zero-byte file is what an auth failure or a dropped connection leaves
  // behind. Sharing it would hand someone an unopenable attachment.
  if (!file.exists || file.size === 0) {
    try { file.delete(); } catch { /* ignore */ }
    throw appError("svcErr.exportEmpty", "The export came back empty");
  }

  return { uri: file.uri, fileName, size: file.size };
};

/** Fetch, then hand the file to whatever the user wants to do with it. */
export const shareExport = async ({ schoolId, kind, lang = "en", params = {} }) => {
  const result = await fetchExport({ schoolId, kind, lang, params });

  if (!(await Sharing.isAvailableAsync())) {
    return { ...result, shared: false };
  }

  await Sharing.shareAsync(result.uri, {
    mimeType: XLSX_MIME,
    dialogTitle: result.fileName,
    UTI: "org.openxmlformats.spreadsheetml.sheet",
  });

  return { ...result, shared: true };
};

/** Which exports this user may run — the menu is built from the server's list. */
export const listExports = async () => {
  const { data } = await api.get("/exports");
  return data?.data ?? [];
};

export default { fetchExport, shareExport, listExports };
