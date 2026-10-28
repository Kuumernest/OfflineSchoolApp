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
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const url = resolveLogoSrc(raw);
    if (!url || /^(data|blob):/i.test(url)) {
      setSrc(url);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;
    setSrc(null);
    // baseURL "": the file lives at the server root, not under /api.
    api.get(url, { baseURL: "", responseType: "blob" })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      })
      .catch(() => { if (!cancelled) setSrc(null); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [raw]);

  return src;
}
