// web/src/utils/logoSrc.ts
//
// The school logo arrives in one of three shapes and only one of them is a
// usable <img src>. Both places that render it had their own copy of this
// logic, and both got the common case wrong.
//
//   1. "/uploads/logos/<school>-<hash>.jpg"
//        A stored file. This is what a migrated school returns today, and the
//        backend flags it with logoIsUrl: true. Being server-relative it is
//        neither a URL nor base64 — the old code fell through to its base64
//        branch and produced `data:image/jpeg;base64,/uploads/logos/...`,
//        which every browser rejects. That is why the banner showed the
//        placeholder even though the file serves fine (HTTP 200, 120 KB).
//
//   2. "https://…" or "data:image/…"
//        Already a usable src. Passed through untouched.
//
//   3. A bare base64 payload
//        Legacy inline storage, ~160 KB inside the school document. Still
//        supported, with the MIME sniffed from the first bytes.

/**
 * Origin the backend is served from, derived from the API base URL.
 *
 * Uploads live at `/uploads/...` on the server root, NOT under `/api`, so the
 * `/api` suffix is stripped. When VITE_API_URL is unset the app is talking to
 * a same-origin path ("/api" via the dev proxy, or a reverse proxy in
 * production) and the relative path is already correct — hence the empty
 * string rather than a guess at a host.
 */
const serverOrigin = (): string => {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  if (!base) return "";

  // Absolute base ("https://api.example.com/api") → strip the /api suffix.
  if (/^https?:\/\//i.test(base)) {
    return base.replace(/\/+$/, "").replace(/\/api$/i, "");
  }

  // Relative base ("/api") → same origin, nothing to prefix.
  return "";
};

/** PNG files start with the bytes that base64-encode to "iVBOR". */
const sniffMime = (b64: string): string =>
  b64.startsWith("iVBOR") ? "image/png" : "image/jpeg";

/**
 * Turn whatever the API returned into something an <img src> accepts.
 * Returns null when there is no logo, so callers can render their fallback.
 */
export function resolveLogoSrc(
  raw: string | null | undefined
): string | null {
  if (!raw || typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value) return null;

  // Already usable.
  if (/^(https?:\/\/|data:)/i.test(value)) return value;

  // A stored file on the API server.
  if (value.startsWith("/")) return `${serverOrigin()}${value}`;

  // Anything else is a bare base64 payload.
  return `data:${sniffMime(value)};base64,${value}`;
}
