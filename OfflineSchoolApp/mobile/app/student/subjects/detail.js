// app/student/subjects/detail.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Linking,
  Alert,
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import {
  getSubjectContentForStudent,
  resolveTypeFromItem,
} from "../../../src/services/student.content.service";

let IntentLauncher = null;
try {
  IntentLauncher = require("expo-intent-launcher");
} catch {
  // Not available in Expo Go
}

const SUBJECT_COLORS = [
  { bg: "#EEF2FF", color: "#4F46E5", icon: "calculator-outline"   },
  { bg: "#ECFDF5", color: "#059669", icon: "leaf-outline"          },
  { bg: "#FEF3C7", color: "#D97706", icon: "flask-outline"         },
  { bg: "#FEF2F2", color: "#DC2626", icon: "book-outline"          },
  { bg: "#F5F3FF", color: "#7C3AED", icon: "globe-outline"         },
  { bg: "#FDF2F8", color: "#DB2777", icon: "musical-notes-outline" },
  { bg: "#F0F9FF", color: "#0284C7", icon: "desktop-outline"       },
  { bg: "#FFF7ED", color: "#EA580C", icon: "color-palette-outline" },
  { bg: "#F0FDF4", color: "#16A34A", icon: "fitness-outline"       },
  { bg: "#FFF1F2", color: "#E11D48", icon: "language-outline"      },
];

const FILTER_TABS = [
  { key: "all",      label: "All",      icon: "apps-outline"          },
  { key: "syllabus", label: "Syllabus", icon: "list-outline"          },
  { key: "notes",    label: "Notes",    icon: "document-text-outline" },
  { key: "document", label: "Docs",     icon: "attach-outline"        },
  { key: "video",    label: "Video",    icon: "videocam-outline"      },
  { key: "audio",    label: "Audio",    icon: "musical-notes-outline" },
  { key: "image",    label: "Images",   icon: "image-outline"         },
];

const MIME_TYPES = {
  mp4:  "video/mp4",        mov:  "video/quicktime",
  webm: "video/webm",       avi:  "video/x-msvideo",
  mkv:  "video/x-matroska", m4v:  "video/x-m4v",
  mp3:  "audio/mpeg",       wav:  "audio/wav",
  aac:  "audio/aac",        m4a:  "audio/x-m4a",
  ogg:  "audio/ogg",        flac: "audio/flac",
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:  "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt:  "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  jpg:  "image/jpeg", jpeg: "image/jpeg", png:  "image/png",
  gif:  "image/gif",  webp: "image/webp", txt:  "text/plain",
};

const getMimeType = (url, mimeType) => {
  if (mimeType) return mimeType;
  const ext = (url || "").split("?")[0].split(".").pop()?.toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
};

const stableFileName = (url) => {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash) + url.charCodeAt(i);
    hash = hash & hash;
  }
  const positiveHash = Math.abs(hash).toString(36);
  const ext = (url.split("?")[0].split(".").pop() || "bin").toLowerCase();
  return `content_${positiveHash}.${ext}`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return String(dateStr); }
};

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return null;
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getContentVisuals = (type) => {
  switch (type) {
    case "syllabus":  return { icon: "list",          color: "#7C3AED", bg: "#EDE9FE" };
    case "notes":     return { icon: "document-text", color: "#4F46E5", bg: "#EEF2FF" };
    case "video":     return { icon: "videocam",       color: "#DC2626", bg: "#FEE2E2" };
    case "audio":     return { icon: "musical-notes",  color: "#D97706", bg: "#FEF3C7" };
    case "image":     return { icon: "image",          color: "#0284C7", bg: "#F0F9FF" };
    case "document":  return { icon: "document",       color: "#059669", bg: "#ECFDF5" };
    default:          return { icon: "document-text",  color: "#6B7280", bg: "#F3F4F6" };
  }
};

const getFileExtension = (item) => {
  const src = item.fileName || item.fileUrl || item.title || "";
  const ext = src.split("?")[0].split(".").pop()?.toUpperCase();
  return ext && ext.length <= 5 && !/^HTTP/i.test(ext) ? ext : null;
};

const isVideoType = (item) =>
  item.type === "video" ||
  (item.mimeType || "").startsWith("video/") ||
  ["mp4","mov","webm","avi","mkv","m4v"].includes(
    (item.fileName || item.fileUrl || "").split("?")[0].split(".").pop()?.toLowerCase()
  );

const isAudioType = (item) =>
  item.type === "audio" ||
  (item.mimeType || "").startsWith("audio/") ||
  ["mp3","wav","aac","m4a","ogg","flac"].includes(
    (item.fileName || item.fileUrl || "").split("?")[0].split(".").pop()?.toLowerCase()
  );

const openLocalFile = async (localUri, mime) => {
  if (Platform.OS === "android") {
    if (IntentLauncher) {
      try {
        const contentUri = await FileSystem.getContentUriAsync(localUri);
        await IntentLauncher.startActivityAsync(
          "android.intent.action.VIEW",
          { data: contentUri, type: mime, flags: 1 }
        );
        return;
      } catch (intentErr) {
        console.warn("[openLocalFile] IntentLauncher failed:", intentErr.message);
      }
    }
    try {
      const supported = await Linking.canOpenURL(localUri);
      if (supported) { await Linking.openURL(localUri); return; }
    } catch { /* ignore */ }
    throw new Error(
      "Cannot open this file in Expo Go.\n\n" +
      "Build a development client:\n  npx expo run:android\n\n" +
      "Or install VLC and try again."
    );
  } else {
    try {
      await Linking.openURL(localUri);
    } catch (err) {
      throw new Error("Cannot open file on this device: " + err.message);
    }
  }
};

const downloadAndOpen = async (url, mimeType, onProgress, onDone) => {
  if (!url) {
    Alert.alert("No File", "This content has no file or link attached.");
    return;
  }

  const mime     = getMimeType(url, mimeType);
  const fileName = stableFileName(url);
  const localUri = `${FileSystem.cacheDirectory}${fileName}`;

  try {
    const info = await FileSystem.getInfoAsync(localUri);
    if (info.exists && info.size > 0) {
      console.log("[downloadAndOpen] cache hit →", fileName);
      onDone?.(true);
      await openLocalFile(localUri, mime);
      return;
    }

    console.log("[downloadAndOpen] downloading →", url);
    const downloadResumable = FileSystem.createDownloadResumable(
      url, localUri, {},
      (progress) => {
        if (onProgress && progress.totalBytesExpectedToWrite > 0) {
          onProgress(Math.round(
            (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100
          ));
        }
      }
    );

    const result = await downloadResumable.downloadAsync();
    if (!result?.uri) throw new Error("Download failed — server returned no file");

    onDone?.(false);
    await openLocalFile(result.uri, mime);

  } catch (err) {
    console.warn("[downloadAndOpen]", err.message);
    Alert.alert(
      "Cannot Open File",
      err.message,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open in Browser", onPress: () => Linking.openURL(url).catch(() => {}) },
      ]
    );
  }
};

const MediaCard = ({ item, color, bg, isVideo: isVid }) => {
  const [progress, setProgress] = useState(null);
  const [isCached, setIsCached] = useState(false);

  useEffect(() => {
    if (!item.fileUrl) return;
    const localUri = `${FileSystem.cacheDirectory}${stableFileName(item.fileUrl)}`;
    FileSystem.getInfoAsync(localUri)
      .then((info) => { if (info.exists && info.size > 0) setIsCached(true); })
      .catch(() => {});
  }, [item.fileUrl]);

  const handleOpen = useCallback(async () => {
    if (progress !== null) return;
    setProgress(0);
    try {
      await downloadAndOpen(
        item.fileUrl, item.mimeType,
        (pct) => setProgress(pct),
        () => setIsCached(true)
      );
    } catch { /* Alert shown inside */ } finally {
      setProgress(null);
    }
  }, [item.fileUrl, item.mimeType, progress]);

  const isDownloading = progress !== null;

  return (
    <TouchableOpacity
      style={[mc.container, { backgroundColor: bg, borderColor: color + "40" }]}
      onPress={handleOpen}
      activeOpacity={0.8}
      disabled={isDownloading}
    >
      <View style={[mc.circle, { backgroundColor: color }]}>
        {isDownloading
          ? <ActivityIndicator size="small" color="#FFF" />
          : <Ionicons name={isVid ? "play" : "headset"} size={20} color="#FFF" />
        }
      </View>

      <View style={{ flex: 1 }}>
        {isDownloading ? (
          <>
            <Text style={mc.label}>
              {progress < 100 ? `Downloading… ${progress}%` : "Opening…"}
            </Text>
            <View style={mc.progressTrack}>
              <View style={[mc.progressFill, { width: `${progress}%`, backgroundColor: color }]} />
            </View>
          </>
        ) : (
          <>
            <Text style={mc.label}>
              {isVid ? "Tap to play video" : "Tap to play audio"}
            </Text>
            <Text style={mc.sublabel}>
              {isCached ? "✓ Cached — opens instantly" : "Downloads & opens in media player"}
            </Text>
          </>
        )}
      </View>

      {!isDownloading && (
        <Ionicons
          name={isCached ? "checkmark-circle-outline" : "arrow-forward-circle-outline"}
          size={20}
          color={isCached ? "#059669" : color}
        />
      )}
    </TouchableOpacity>
  );
};

const mc = StyleSheet.create({
  container: {
    flexDirection: "row", alignItems: "center",
    borderRadius: 12, borderWidth: 1,
    padding: 12, gap: 10, marginTop: 4,
  },
  circle: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  label:    { fontSize: 13, fontWeight: "700", color: "#111827" },
  sublabel: { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  progressTrack: {
    height: 4, backgroundColor: "#E5E7EB",
    borderRadius: 2, marginTop: 6, overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 2 },
});

const SourceBadge = ({ source }) => {
  if (!source || source === "api") return null;
  const map = {
    "api-alt": { label: "Live",    color: "#059669", bg: "#ECFDF5" },
    "sqlite":  { label: "Cached",  color: "#D97706", bg: "#FEF3C7" },
    "none":    { label: "Offline", color: "#DC2626", bg: "#FEE2E2" },
  };
  const v = map[source];
  if (!v) return null;
  return (
    <View style={[sbx.badge, { backgroundColor: v.bg }]}>
      <Ionicons
        name={source === "sqlite" ? "cloud-offline-outline" : "cloud-done-outline"}
        size={11} color={v.color}
      />
      <Text style={[sbx.text, { color: v.color }]}>{v.label}</Text>
    </View>
  );
};

const sbx = StyleSheet.create({
  badge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
  },
  text: { fontSize: 10, fontWeight: "700" },
});

const ContentCard = React.memo(({ item }) => {
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState(null);

  const type                = item.type || resolveTypeFromItem(item);
  const { icon, color, bg } = getContentVisuals(type);
  const ext                 = getFileExtension(item);
  const fileSize            = formatFileSize(item.fileSize);
  const hasUrl              = !!item.fileUrl;
  const hasDesc             = !!item.description;
  const isVideo             = isVideoType(item);
  const isAudio             = isAudioType(item);
  const isMedia             = isVideo || isAudio;

  const openIcon =
    isVideo ? "play-circle-outline"  :
    isAudio ? "headset-outline"      :
    type === "image" ? "eye-outline" :
    "cloud-download-outline";

  const openLabel =
    isVideo ? "Play Video"          :
    isAudio ? "Play Audio"          :
    type === "image" ? "View Image" :
    "Open / Download";

  const handleOpen = useCallback(async () => {
    if (progress !== null) return;
    setProgress(0);
    try {
      await downloadAndOpen(
        item.fileUrl, item.mimeType,
        (pct) => setProgress(pct),
        () => {}
      );
    } finally { setProgress(null); }
  }, [item.fileUrl, item.mimeType, progress]);

  return (
    <View style={cc.card}>
      <View style={cc.topRow}>
        <View style={[cc.iconBg, { backgroundColor: bg }]}>
          <Ionicons name={icon} size={22} color={color} />
        </View>

        <View style={cc.titleArea}>
          <Text style={cc.title} numberOfLines={expanded ? 0 : 2}>
            {item.title}
          </Text>
          <View style={cc.metaRow}>
            {!!ext && (
              <View style={[cc.chip, { backgroundColor: color + "18" }]}>
                <Text style={[cc.chipText, { color, fontWeight: "800" }]}>{ext}</Text>
              </View>
            )}
            {!!fileSize && (
              <View style={cc.chip}>
                <Ionicons name="server-outline" size={9} color="#9CA3AF" />
                <Text style={cc.chipText}>{fileSize}</Text>
              </View>
            )}
            {!!item.uploaderName && (
              <View style={cc.chip}>
                <Ionicons name="person-outline" size={9} color="#9CA3AF" />
                <Text style={cc.chipText} numberOfLines={1}>{item.uploaderName}</Text>
              </View>
            )}
            {!!item.createdAt && (
              <Text style={cc.dateText}>{formatDate(item.createdAt)}</Text>
            )}
          </View>
        </View>

        {hasDesc && (
          <TouchableOpacity
            onPress={() => setExpanded((v) => !v)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={18} color="#9CA3AF"
            />
          </TouchableOpacity>
        )}
      </View>

      {!hasUrl && hasDesc && !expanded && (
        <Text style={cc.notePreview} numberOfLines={3}>{item.description}</Text>
      )}

      {hasDesc && expanded && (
        <Text style={cc.description}>{item.description}</Text>
      )}

      {isVideo && hasUrl && (
        <MediaCard item={item} color={color} bg={bg} isVideo />
      )}

      {isAudio && !isVideo && hasUrl && (
        <MediaCard item={item} color={color} bg={bg} isVideo={false} />
      )}

      {hasUrl && !isMedia && (
        <TouchableOpacity
          style={[cc.openBtn, { backgroundColor: color + "15", borderColor: color + "35" }]}
          onPress={handleOpen}
          activeOpacity={0.75}
          disabled={progress !== null}
        >
          {progress !== null ? (
            <>
              <ActivityIndicator size="small" color={color} />
              <Text style={[cc.openBtnText, { color }]}>
                {progress < 100 ? `Downloading ${progress}%` : "Opening…"}
              </Text>
            </>
          ) : (
            <>
              <Ionicons name={openIcon} size={16} color={color} />
              <Text style={[cc.openBtnText, { color }]}>{openLabel}</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
});

const cc = StyleSheet.create({
  card: {
    backgroundColor: "#FFF", borderRadius: 14,
    padding: 14, marginBottom: 10, gap: 10,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  topRow:    { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  iconBg: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  titleArea: { flex: 1, gap: 5 },
  title:     { fontSize: 14, fontWeight: "700", color: "#111827", lineHeight: 20 },
  metaRow:   { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "#F3F4F6", paddingHorizontal: 6,
    paddingVertical: 2, borderRadius: 5,
  },
  chipText:    { fontSize: 10, color: "#6B7280" },
  dateText:    { fontSize: 10, color: "#9CA3AF" },
  notePreview: { fontSize: 13, color: "#6B7280", lineHeight: 19 },
  description: { fontSize: 13, color: "#374151", lineHeight: 20 },
  openBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, borderRadius: 10, paddingVertical: 9,
    paddingHorizontal: 14, borderWidth: 1,
  },
  openBtnText: { fontSize: 13, fontWeight: "700" },
});

const SummaryRow = ({ summary }) => {
  const chips = Object.entries(summary)
    .filter(([k, v]) => k !== "total" && v > 0)
    .slice(0, 5);
  if (!chips.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={sum.row}
    >
      {chips.map(([key, count]) => {
        const { color, bg } = getContentVisuals(key);
        return (
          <View key={key} style={[sum.chip, { backgroundColor: bg }]}>
            <Text style={[sum.count, { color }]}>{count}</Text>
            <Text style={[sum.label, { color }]}>
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
};

const sum = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, flexDirection: "row" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  count: { fontSize: 13, fontWeight: "800" },
  label: { fontSize: 11, fontWeight: "600" },
});

export default function SubjectDetailScreen() {
  const router = useRouter();
  const {
    subjectId,
    subjectName = "Subject",
    teacherName = "",
    subjectCode = "",
    colorIndex  = "0",
    classId     = null,
  } = useLocalSearchParams();

  const theme = SUBJECT_COLORS[parseInt(colorIndex, 10) % SUBJECT_COLORS.length];

  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [content,      setContent]      = useState([]);
  const [summary,      setSummary]      = useState({});
  const [source,       setSource]       = useState(null);
  const [activeFilter, setActiveFilter] = useState("all");
  const [search,       setSearch]       = useState("");
  const [error,        setError]        = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!subjectId) { setLoading(false); return; }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const contentResult = await getSubjectContentForStudent({ subjectId, classId });

      setContent(contentResult.items   || []);
      setSummary(contentResult.summary || {});
      setSource(contentResult.source   || null);

      if (!contentResult.success && contentResult.error) {
        setError(contentResult.error);
      }
    } catch (err) {
      console.warn("[SubjectDetail] load error:", err.message);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [subjectId, classId]);

  useEffect(() => { load(); }, [load]);

  const visibleFilters = useMemo(() => {
    const typesPresent = new Set(content.map((i) => i.type));
    return FILTER_TABS.filter((t) => t.key === "all" || typesPresent.has(t.key));
  }, [content]);

  const filteredContent = useMemo(() => {
    let list = content;
    if (activeFilter !== "all") {
      list = list.filter((i) => i.type === activeFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (i) =>
          i.title?.toLowerCase().includes(q)       ||
          i.description?.toLowerCase().includes(q) ||
          i.fileName?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [content, activeFilter, search]);

  if (loading) {
    return (
      <View style={sd.centered}>
        <ActivityIndicator size="large" color={theme.color} />
        <Text style={[sd.loadingText, { color: theme.color }]}>
          Loading content…
        </Text>
      </View>
    );
  }

  return (
    <View style={sd.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      <View style={[sd.header, { borderBottomColor: theme.color + "30" }]}>
        <TouchableOpacity
          style={sd.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>

        <View style={[sd.subjectIconBg, { backgroundColor: theme.bg }]}>
          <Ionicons name={theme.icon} size={20} color={theme.color} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={sd.subjectName} numberOfLines={1}>{subjectName}</Text>
          <View style={sd.subHeaderRow}>
            {!!subjectCode && (
              <View style={[sd.codeBadge, { backgroundColor: theme.color + "18" }]}>
                <Text style={[sd.codeText, { color: theme.color }]}>{subjectCode}</Text>
              </View>
            )}
            {!!teacherName && (
              <Text style={sd.teacherLabel} numberOfLines={1}>
                <Ionicons name="person-outline" size={11} color="#9CA3AF" />{" "}
                {teacherName}
              </Text>
            )}
          </View>
        </View>

        <View style={sd.headerRight}>
          <SourceBadge source={source} />
          <View style={[sd.countBadge, { backgroundColor: theme.bg }]}>
            <Text style={[sd.countText, { color: theme.color }]}>
              {content.length}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={sd.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={theme.color}
            colors={[theme.color]}
          />
        }
      >
        {summary && Object.values(summary).some((v) => v > 0) && (
          <View style={{ marginTop: 12 }}>
            <SummaryRow summary={summary} />
          </View>
        )}

        <View style={sd.searchWrap}>
          <Ionicons name="search-outline" size={17} color="#9CA3AF" />
          <TextInput
            style={sd.searchInput}
            placeholder="Search content…"
            placeholderTextColor="#9CA3AF"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {search.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearch("")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close-circle" size={17} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>

        {visibleFilters.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={sd.filterRow}
          >
            {visibleFilters.map((f) => {
              const isActive = activeFilter === f.key;
              return (
                <TouchableOpacity
                  key={f.key}
                  style={[
                    sd.filterChip,
                    isActive && { backgroundColor: theme.color, borderColor: theme.color },
                  ]}
                  onPress={() => setActiveFilter(f.key)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={f.icon}
                    size={13}
                    color={isActive ? "#FFF" : "#6B7280"}
                  />
                  <Text style={[sd.filterChipText, isActive && { color: "#FFF" }]}>
                    {f.label}
                  </Text>
                  {summary[f.key] > 0 && (
                    <Text style={[sd.filterCount, isActive && { color: "rgba(255,255,255,0.8)" }]}>
                      {f.key === "all" ? content.length : summary[f.key]}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {!!error && content.length === 0 && (
          <View style={sd.errorBox}>
            <Ionicons name="alert-circle-outline" size={20} color="#DC2626" />
            <Text style={sd.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => load(true)} activeOpacity={0.7}>
              <Text style={sd.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {filteredContent.length === 0 ? (
          <View style={sd.emptyState}>
            <Ionicons name="folder-open-outline" size={56} color="#D1D5DB" />
            <Text style={sd.emptyTitle}>
              {search
                ? "No content matches your search"
                : content.length === 0
                  ? "No content uploaded yet"
                  : "No content in this category"}
            </Text>
            <Text style={sd.emptySub}>
              {content.length === 0
                ? "Your teacher hasn't uploaded any materials yet."
                : "Try a different filter or search term."}
            </Text>
            {(search || activeFilter !== "all") && (
              <TouchableOpacity
                style={[sd.resetBtn, { backgroundColor: theme.bg }]}
                onPress={() => { setSearch(""); setActiveFilter("all"); }}
              >
                <Text style={[sd.resetBtnText, { color: theme.color }]}>
                  Clear Filters
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filteredContent.map((item) => (
            <ContentCard
              key={`${item._table || "api"}::${item.id}`}
              item={item}
            />
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const sd = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, fontSize: 14, fontWeight: "500" },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: "#FFF", borderBottomWidth: 1, gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center",
  },
  subjectIconBg: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  subjectName:  { fontSize: 17, fontWeight: "700", color: "#111827" },
  subHeaderRow: {
    flexDirection: "row", alignItems: "center",
    gap: 6, marginTop: 2, flexWrap: "wrap",
  },
  codeBadge:    { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  codeText:     { fontSize: 10, fontWeight: "800" },
  teacherLabel: { fontSize: 12, color: "#9CA3AF" },
  headerRight:  { flexDirection: "row", alignItems: "center", gap: 6 },
  countBadge:   { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  countText:    { fontSize: 13, fontWeight: "700" },

  scroll: { paddingHorizontal: 16, paddingTop: 8 },

  searchWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#FFF", borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    gap: 8, marginBottom: 10,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  filterRow: { paddingBottom: 10, gap: 8, flexDirection: "row" },
  filterChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "#FFF", borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  filterChipText: { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  filterCount:    { fontSize: 11, fontWeight: "700", color: "#9CA3AF" },

  errorBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#FEE2E2", borderRadius: 10,
    padding: 12, marginBottom: 10, flexWrap: "wrap",
  },
  errorText: { flex: 1, fontSize: 13, color: "#DC2626" },
  retryText: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },

  emptyState: {
    alignItems: "center", paddingVertical: 60,
    paddingHorizontal: 32, gap: 10,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#374151", textAlign: "center" },
  emptySub:   { fontSize: 13, color: "#9CA3AF", textAlign: "center", lineHeight: 20 },
  resetBtn:   { borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, marginTop: 4 },
  resetBtnText: { fontSize: 13, fontWeight: "700" },
});