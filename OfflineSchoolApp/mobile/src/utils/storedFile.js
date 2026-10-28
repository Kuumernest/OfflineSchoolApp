// mobile/src/utils/storedFile.js
//
// Files the server stores (backend/src/storage/fileAccess.js): school logos
// are public, but a pupil photo, a message attachment or teacher content needs
// the signed-in user's token. These helpers carry it where axios does not:
//
//   authHeaders()       for an <Image source> or a FileSystem download
//   openStoredFile(url) hands the file to the browser or another app, which
//                       cannot send a token — through a one-hour signed link

import { Linking } from "react-native";
import api, { API_URL, getAuthToken } from "../services/api";

/** The server's root: uploads are served there, not under /api. */
const serverOrigin = () => String(API_URL || "").replace(/\/+$/, "").replace(/\/api$/i, "");

/** A stored path or URL made absolute against the server. */
export const absoluteFileUrl = (value) => {
  if (!value) return null;
  if (/^(https?:|data:|file:)/i.test(value)) return value;
  return `${serverOrigin()}${value.startsWith("/") ? "" : "/"}${value}`;
};

/** { Authorization } for the signed-in user, or {} when there is none. */
export const authHeaders = async () => {
  const token = await getAuthToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Is this one of the server's private stored files (not a logo, not elsewhere)? */
const isPrivateUpload = (value) => {
  const m = /^(?:https?:\/\/[^/]+)?\/uploads\/([^/?#]+)\//i.exec(String(value || ""));
  return !!m && m[1].toLowerCase() !== "logos";
};

/**
 * Open a stored file outside the app. A private one goes through a signed
 * link (GET /api/files/signed-link); anything else opens as it is.
 */
export const openStoredFile = async (value) => {
  let url = absoluteFileUrl(value);
  if (isPrivateUpload(value)) {
    const res = await api.get("/files/signed-link", { params: { url: value } });
    url = absoluteFileUrl(res.data?.url);
  }
  return Linking.openURL(url);
};
