// web/src/hooks/useAuthedImage.ts
//
// A stored private image (a pupil photo) as an <img src>.
//
// Logos are public, but a photo needs the signed-in user's token
// (backend/src/storage/fileAccess.js), and an <img> tag cannot send one. So
// the photo is fetched through the API client — token, refresh and all — and
// shown from a blob: URL, released when the image changes or the component
// goes away. A data: or blob: value is passed through as it is.

import { useEffect, useState } from "react";
import api from "@/lib/axios";
import { resolveLogoSrc } from "@/utils/logoSrc";

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
    // baseURL "": the file lives at the server root, not under /api.
    api.get(url, { baseURL: "", responseType: "blob" })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
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
