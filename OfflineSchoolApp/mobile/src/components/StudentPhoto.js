// src/components/StudentPhoto.js
//
// A pupil's passport photo, or their initial when there is none.
//
// The one renderer for Student.photoUrl on the phone. Order of preference:
//
//   1. the copy on the phone (photoCache.service.js) — works offline;
//   2. the server's file, WITH the token (a photo is a private upload, and an
//      <Image> without the Authorization header gets a 401), while the copy
//      is fetched in the background for next time;
//   3. the initial.
//
// A content-hashed name means a replaced photo is a new photoUrl, so the
// component never shows a stale face after an upload.

import React, { useEffect, useState } from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { COLORS } from "../theme/colors";
import { absoluteFileUrl } from "../utils/storedFile";
import { useAuthStore } from "../store/auth.store";
import { cachedPhotoUri, cachePhoto, photoFileName } from "../services/photoCache.service";

const SIZES = {
  sm: { w: 40,  h: 40,  font: 16 },
  md: { w: 64,  h: 64,  font: 24 },
  lg: { w: 96,  h: 120, font: 36 },
  xl: { w: 120, h: 150, font: 44 },
};

export default function StudentPhoto({ photoUrl, name, size = "sm", shape = "circle", style }) {
  const token = useAuthStore((s) => s.token);
  const dim   = SIZES[size] || SIZES.sm;
  const [local, setLocal]   = useState(() => cachedPhotoUri(photoUrl));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const have = cachedPhotoUri(photoUrl);
    setLocal(have);
    setFailed(false);
    if (!have && photoFileName(photoUrl) && token) {
      cachePhoto(photoUrl).then((uri) => { if (alive && uri) setLocal(uri); });
    }
    return () => { alive = false; };
  }, [photoUrl, token]);

  const remote = !local && photoUrl && token && !failed
    ? { uri: absoluteFileUrl(photoUrl), headers: { Authorization: `Bearer ${token}` } }
    : null;
  const source = local ? { uri: local } : remote;

  const box = {
    width: dim.w,
    height: shape === "circle" ? dim.w : dim.h,
    borderRadius: shape === "circle" ? dim.w / 2 : 12,
  };

  return (
    <View style={[styles.box, box, style]}>
      {source
        ? <Image source={source} style={styles.img} onError={() => { if (!local) setFailed(true); }}
            accessibilityLabel={name || undefined} />
        : <Text style={[styles.initial, { fontSize: dim.font }]}>
            {(String(name || "").trim()[0] || "?").toUpperCase()}
          </Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box:     { overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: COLORS?.primaryLight || "#DBEAFE" },
  img:     { width: "100%", height: "100%" },
  initial: { fontWeight: "700", color: COLORS?.primary || "#1D4ED8" },
});
