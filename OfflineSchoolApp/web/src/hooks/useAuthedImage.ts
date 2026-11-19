// web/src/hooks/useAuthedImage.ts
//
// A stored private image (a pupil photo) as an <img src>.
//
// Logos are public, but a photo needs the signed-in user's token
// (backend/src/storage/fileAccess.js), and an <img> tag cannot send one. So
// the photo is fetched through the API client — token, refresh and all — and
// shown from a blob: URL, released when the image changes or the component
// goes away. A data: or blob: value is passed through as it is.
//
// ── Shared, not per component ────────────────────────────────────────────
//
// A list of fifty pupils, the profile and the gate screen all ask for photos,
// often the same one. Each component used to fetch on its own, every mount.
// The fetched bytes are now kept once per URL for the page's life: a photo's
// name carries a hash of its content (backend utils/photoStorage.js), so a
// replaced photo is a NEW url and a kept Blob can never be the wrong face.
// Each component still makes — and revokes — its own object URL from the Blob,
// so one component unmounting never blanks another's image.

import { useEffect, useState } from "react";
import api from "@/lib/axios";
import { resolveLogoSrc } from "@/utils/logoSrc";
import { useAuthStore } from "@/store/auth.store";

/** Most photos kept in memory; a 400 px JPEG is ~20–40 KB. */
const MAX_KEPT = 300;

const kept = new Map<string, Promise<Blob>>();

function blobFor(url: string): Promise<Blob> {
  const hit = kept.get(url);
  if (hit) {
    // Refresh recency (Map keeps insertion order).
    kept.delete(url);
    kept.set(url, hit);
    return hit;
  }
  // baseURL "": the file lives at the server root, not under /api.
  const p = api.get(url, { baseURL: "", responseType: "blob" })
    .then((res) => {
      // The server's stand-in for a lost file is shown, never kept: it would
      // outlive the upload that replaces it.
      if (res.headers?.["x-upload-missing"]) kept.delete(url);
      return res.data as Blob;
    });
  // A failure is not kept either — the next mount tries again (offline now,
  // online later).
  p.catch(() => kept.delete(url));
  kept.set(url, p);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
  return p;
}

/** Forget every kept image — on sign-out, so the next account starts clean. */
export function clearAuthedImages(): void {
  kept.clear();
}

// Whatever ends the session — sign-out, expiry, a forced logout — the next
// account must not be shown photos fetched with the last one's token.
useAuthStore.subscribe((state, prev) => {
  if (prev.token && !state.token) clearAuthedImages();
});

export function useAuthedImage(raw: string | null | undefined): string | null {
  const url    = resolveLogoSrc(raw);
  // Nothing to fetch: no image, or a data:/blob: value usable as it is.
  const direct = !url || /^(data|blob):/i.test(url);

  // The last fetched image, remembered with the URL it belongs to. What the
  // hook returns is derived from it during render — the image only when it
  // is for the current URL — so a change of URL never has to clear state
  // synchronously inside the effect (react-hooks/set-state-in-effect), and
  // the previous pupil's photo is never shown under the next pupil's name.
  const [loaded, setLoaded] = useState<{ url: string; src: string | null } | null>(null);

  useEffect(() => {
    if (direct || !url) return;

    let objectUrl: string | null = null;
    let cancelled = false;
    blobFor(url)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ url, src: objectUrl });
      })
      .catch(() => { if (!cancelled) setLoaded({ url, src: null }); });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        // Forget a blob once it is revoked, so returning to this same URL
        // later shows nothing until the refetch lands, not a dead blob: URL.
        const revoked = objectUrl;
        setLoaded((cur) => (cur?.src === revoked ? null : cur));
      }
    };
  }, [url, direct]);

  if (direct) return url ?? null;
  return loaded?.url === url ? loaded.src : null;
}
