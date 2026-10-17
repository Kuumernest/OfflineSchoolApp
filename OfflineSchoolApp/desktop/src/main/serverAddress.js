// desktop/src/main/serverAddress.js
"use strict";

/**
 * The school's server address, as typed on the first-run screen.
 *
 * Stored as the bare origin (https://api.example.cm): every path the desktop
 * sends already starts with /api or /uploads (appProtocol.js,
 * sync/client.js), so an address typed with "/api" on the end would make
 * /api/api/…. That suffix — the form the web and mobile builds use — is taken
 * off rather than refused, since it is what a school will have been given.
 */

/** @returns {{ ok: true, url: string } | { ok: false, error: string }} */
function normaliseServerUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter the server address." };
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { ok: false, error: "That is not a web address." }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The address must start with https://" };
  }
  // Plain http only for this machine or a school's own network, where a local
  // server is the deployment; anywhere else it would send the password in clear.
  const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  if (url.protocol === "http:" && !local) {
    return { ok: false, error: "Use https:// for a server on the internet." };
  }
  if (url.username || url.password) return { ok: false, error: "The address cannot contain a username or password." };
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/api$/i.test(pathname)) pathname = pathname.slice(0, -4);
  return { ok: true, url: `${url.protocol}//${url.host}${pathname}` };
}

/**
 * Is there a school server at this address? Asks /api/health (liveness:
 * answers whenever the API is up, database or not).
 *
 * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
 */
async function checkServer(input, fetchImpl, timeoutMs = 10000) {
  const n = normaliseServerUrl(input);
  if (!n.ok) return n;
  let res;
  try {
    res = await fetchImpl(`${n.url}/api/health`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, url: n.url, error: "Could not reach that address. Check it, and the connection." };
  }
  let body = null;
  try { body = await res.json(); } catch { /* not this API */ }
  if (!res.ok || body?.status !== "ok") {
    return { ok: false, url: n.url, error: "Something answered there, but it is not the school server." };
  }
  return { ok: true, url: n.url };
}

module.exports = { normaliseServerUrl, checkServer };
