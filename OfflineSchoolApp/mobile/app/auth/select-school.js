// app/auth/select-school.js

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Image,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_URL } from "../../src/services/api";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";
import { errorText } from "../../src/utils/appError";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS    = 350;
const PAGE_SIZE      = 20;
const SKELETON_COUNT = 6;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a logo field to a fully-qualified URL.
 *
 * Handles:
 *  - Already absolute URLs  (https://…)
 *  - Relative paths         (/uploads/logos/foo.png)
 *  - Empty / null / undefined → null
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
const resolveLogoUrl = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already absolute
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  // Relative path — prepend the API base URL
  // API_URL may or may not end with /api — strip it for static assets
  const base = API_URL.replace(/\/api\/?$/, "");
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${base}${path}`;
};

const normaliseSchool = (raw) => ({
  id:       String(raw.id   || raw._id        || ""),
  name:     raw.name        || raw.schoolName  || "Unnamed School",
  address:  raw.address     || raw.location    || "",
  city:     raw.city        || "",
  state:    raw.state       || "",
  logo:     resolveLogoUrl(raw.logo || raw.logoUrl || raw.logoUri || null),
  classes:  Array.isArray(raw.classes) ? raw.classes : [],
  phone:    raw.phone       || raw.phoneNumber || "",
  email:    raw.email       || "",
  verified: raw.verified    ?? raw.isVerified  ?? false,
});

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON CARD
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonCard = () => (
  <View style={styles.skeletonCard}>
    <View style={styles.skeletonAvatar} />
    <View style={styles.skeletonBody}>
      <View style={[styles.skeletonLine, { width: "70%" }]} />
      <View style={[styles.skeletonLine, { width: "50%", marginTop: 6 }]} />
      <View style={[styles.skeletonLine, { width: "40%", marginTop: 6 }]} />
    </View>
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL AVATAR — shows logo image or falls back to initial
// ─────────────────────────────────────────────────────────────────────────────

const SchoolAvatar = ({ name, logoUrl }) => {
  const [imgError, setImgError] = useState(false);

  // Show image if we have a URL and it hasn't errored
  if (logoUrl && !imgError) {
    return (
      <View style={styles.avatarBox}>
        <Image
          source={{ uri: logoUrl }}
          style={styles.avatarImage}
          resizeMode="cover"
          onError={() => setImgError(true)}
          accessibilityLabel={`${name} logo`}
        />
      </View>
    );
  }

  // Fallback: first letter initial
  return (
    <View style={styles.avatarBox}>
      <Text style={styles.avatarText}>
        {(name || "?").charAt(0).toUpperCase()}
      </Text>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL CARD
// ─────────────────────────────────────────────────────────────────────────────

const SchoolCard = ({ school, onSelect }) => {
  const { t } = useTranslation();
  const locationParts = [school.city, school.state].filter(Boolean);
  const location      = locationParts.join(", ") || school.address || "";
  const classCount    = school.classes.length;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onSelect(school)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Select ${school.name}`}
    >
      {/* Avatar: logo image or initial fallback */}
      <SchoolAvatar name={school.name} logoUrl={school.logo} />

      {/* Info */}
      <View style={styles.cardInfo}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {school.name}
          </Text>
          {school.verified && (
            <View style={styles.verifiedBadge}>
              <Ionicons name="checkmark-circle" size={14} color="#059669" />
              <Text style={styles.verifiedText}>{t("selectSchool.verified")}</Text>
            </View>
          )}
        </View>

        {location ? (
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={12} color="#9CA3AF" />
            <Text style={styles.metaText}>{location}</Text>
          </View>
        ) : null}

        <View style={styles.metaRow}>
          <Ionicons name="library-outline" size={12} color="#9CA3AF" />
          <Text style={styles.metaText}>
            {classCount === 1
              ? t("selectSchool.oneClass")
              : t("selectSchool.manyClasses", { count: classCount })}
          </Text>
        </View>

        {/* Contact info */}
        {(school.phone || school.email) && (
          <View style={styles.contactRow}>
            {school.phone ? (
              <View style={styles.contactItem}>
                <Ionicons name="call-outline" size={11} color="#9CA3AF" />
                <Text style={styles.contactText}>{school.phone}</Text>
              </View>
            ) : null}
            {school.email ? (
              <View style={styles.contactItem}>
                <Ionicons name="mail-outline" size={11} color="#9CA3AF" />
                <Text style={styles.contactText} numberOfLines={1}>
                  {school.email}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </View>

      {/* Arrow */}
      <Ionicons name="chevron-forward" size={20} color="#C7D2FE" />
    </TouchableOpacity>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function SelectSchoolScreen() {
  const router = useRouter();
  const { t }  = useTranslation();
  const screenPad = useScreenInsets({ top: 16, bottom: 40 });

  // ── Data state ─────────────────────────────────────────────────────────────
  const [schools,     setSchools]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,       setError]       = useState(null);
  const [page,        setPage]        = useState(1);
  const [hasMore,     setHasMore]     = useState(true);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [query,          setQuery]          = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // ── Debounce search query ──────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(query.trim()),
      DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [query]);

  // Reset pagination + data when search changes
  useEffect(() => {
    setPage(1);
    setSchools([]);
    setHasMore(true);
    fetchSchools(1, debouncedQuery, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchSchools = useCallback(
    async (pageNum = 1, search = "", replace = false) => {
      try {
        if (pageNum === 1 && replace) setLoading(true);
        else if (pageNum > 1)         setLoadingMore(true);

        setError(null);

        const params = new URLSearchParams({
          page:  String(pageNum),
          limit: String(PAGE_SIZE),
        });
        if (search) params.set("search", search);

        const res = await fetch(
          `${API_URL}/public/schools?${params.toString()}`,
          { headers: { Accept: "application/json" } }
        );

        if (!res.ok) {
          const body = await res.text();
          let   msg;
          try   { msg = JSON.parse(body)?.message; }
          catch { msg = body; }
          throw new Error(msg || `Failed to load schools (${res.status})`);
        }

        const data = await res.json();

        const raw   = Array.isArray(data) ? data : data.schools ?? data.data ?? [];
        const total = data.total ?? data.totalCount ?? raw.length;

        const normalised = raw.map(normaliseSchool);

        setSchools((prev) =>
          replace || pageNum === 1 ? normalised : [...prev, ...normalised]
        );
        setHasMore(
          normalised.length === PAGE_SIZE &&
          pageNum * PAGE_SIZE < total
        );
        setPage(pageNum);
      } catch (err) {
        console.error("fetchSchools error:", err.message);
        setError(errorText(t, err));
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [t]
  );

  // Initial load
  useEffect(() => {
    fetchSchools(1, "", true);
  }, [fetchSchools]);

  // ── Pull-to-refresh ────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchSchools(1, debouncedQuery, true);
  }, [debouncedQuery, fetchSchools]);

  // ── Infinite scroll ────────────────────────────────────────────────────────

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    fetchSchools(page + 1, debouncedQuery, false);
  }, [loadingMore, hasMore, page, debouncedQuery, fetchSchools]);

  // ── Select school → navigate to apply screen ──────────────────────────────

  const handleSelectSchool = useCallback(
    (school) => {
      const classesJson = JSON.stringify(
        school.classes.map((c) => ({
          ...c,
          id:   String(c.id || c._id || ""),
          name: c.name || c.className || "",
        }))
      );

      router.push({
        pathname: "/auth/apply",
        params: {
          schoolId:   school.id,
          schoolName: school.name,
          classes:    classesJson,
        },
      });
    },
    [router]
  );

  // ── Empty / error states ───────────────────────────────────────────────────

  const renderEmpty = useCallback(() => {
    if (loading) return null;

    if (error) {
      return (
        <View style={styles.centreBox}>
          <Text style={styles.centreEmoji}>😕</Text>
          <Text style={styles.centreTitle}>{t("selectSchool.errorTitle")}</Text>
          <Text style={styles.centreBody}>{error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => fetchSchools(1, debouncedQuery, true)}
            accessibilityRole="button"
            accessibilityLabel={t("selectSchool.a11yRetry")}
          >
            <Text style={styles.retryBtnText}>{t("selectSchool.retry")}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.centreBox}>
        <Text style={styles.centreEmoji}>🏫</Text>
        <Text style={styles.centreTitle}>{t("selectSchool.emptyTitle")}</Text>
        <Text style={styles.centreBody}>
          {debouncedQuery
            ? t("selectSchool.emptySearch", { query: debouncedQuery })
            : t("selectSchool.emptyBody")}
        </Text>
        {debouncedQuery ? (
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setQuery("");
              setDebouncedQuery("");
            }}
            accessibilityRole="button"
            accessibilityLabel={t("selectSchool.a11yClear")}
          >
            <Text style={styles.retryBtnText}>{t("selectSchool.clearSearch")}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }, [loading, error, debouncedQuery, fetchSchools, t]);

  // ── List footer ────────────────────────────────────────────────────────────

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color="#4F46E5" />
        <Text style={styles.footerLoaderText}>{t("selectSchool.loadingMore")}</Text>
      </View>
    );
  }, [loadingMore, t]);

  // ── Render item ────────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item }) => (
      <SchoolCard
        school={item}
        onSelect={handleSelectSchool}
      />
    ),
    [handleSelectSchool]
  );

  const keyExtractor = useCallback((item) => item.id, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: screenPad.paddingTop }]}>
        <TouchableOpacity
          style={styles.backArrow}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t("common.goBack")}
        >
          <Ionicons name="arrow-back" size={20} color="#4F46E5" />
          <Text style={styles.backArrowText}>{t("selectSchool.back")}</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>{t("selectSchool.title")}</Text>
        <Text style={styles.headerSubtitle}>
          {t("selectSchool.subtitle")}
        </Text>

        {/* Search bar */}
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={t("selectSchool.searchPh")}
            placeholderTextColor="#9CA3AF"
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            accessibilityLabel={t("selectSchool.a11ySearch")}
          />
          {query.length > 0 && Platform.OS === "android" && (
            <TouchableOpacity
              onPress={() => setQuery("")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t("selectSchool.a11yClear")}
            >
              <Ionicons name="close-circle" size={18} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Body ── */}
      {loading && schools.length === 0 ? (
        <View style={styles.skeletonContainer}>
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </View>
      ) : (
        <FlatList
          data={schools}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: screenPad.paddingBottom },
            schools.length === 0 && styles.listContentEmpty,
          ]}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderFooter}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              colors={["#4F46E5"]}
              tintColor="#4F46E5"
            />
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={Platform.OS === "android"}
          windowSize={7}
          maxToRenderPerBatch={PAGE_SIZE}
          initialNumToRender={PAGE_SIZE}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },

  // ── Header ──
  header: {
    backgroundColor:   "#FFF",
    // paddingTop comes from the insets at render; 56-on-iOS/36-on-Android
    // was a guess from before Android drew behind the status bar.
    paddingBottom:     16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    shadowColor:       "#000",
    shadowOpacity:     0.04,
    shadowRadius:      4,
    elevation:         2,
  },
  backArrow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
    marginBottom:  12,
    alignSelf:     "flex-start",
  },
  backArrowText:  { color: "#4F46E5", fontSize: 15, fontWeight: "600" },
  headerTitle:    { fontSize: 22, fontWeight: "800", color: "#111827", marginBottom: 4 },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginBottom: 14, lineHeight: 18 },

  // Search
  searchBar: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F9FAFB",
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    borderRadius:      12,
    paddingHorizontal: 12,
    paddingVertical:   Platform.OS === "ios" ? 10 : 6,
    gap:               8,
  },
  searchInput: {
    flex:     1,
    fontSize: 15,
    color:    "#111827",
    padding:  0,
  },

  // ── List ──
  listContent:      { padding: 16 },
  listContentEmpty: { flexGrow: 1 },

  // ── School card ──
  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    16,
    marginBottom:    12,
    padding:         16,
    gap:             12,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },

  // ── Avatar (logo or initial) ──
  avatarBox: {
    width:           48,
    height:          48,
    borderRadius:    14,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
    overflow:        "hidden",  // clips the logo image to the rounded box
  },
  avatarImage: {
    width:        48,
    height:       48,
    borderRadius: 14,
  },
  avatarText: { fontSize: 22, fontWeight: "800", color: "#4F46E5" },

  cardInfo:     { flex: 1 },
  cardTitleRow: {
    flexDirection: "row",
    alignItems:    "center",
    flexWrap:      "wrap",
    gap:           6,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#111827", flexShrink: 1 },

  verifiedBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   "#ECFDF5",
    borderRadius:      20,
    paddingVertical:   2,
    paddingHorizontal: 7,
  },
  verifiedText: { fontSize: 10, color: "#059669", fontWeight: "600" },

  metaRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           4,
    marginTop:     3,
  },
  metaText: { fontSize: 12, color: "#6B7280" },

  // Contact row (inside card)
  contactRow: {
    flexDirection:  "row",
    flexWrap:       "wrap",
    gap:            10,
    marginTop:      6,
    paddingTop:     6,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  contactItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  contactText: { fontSize: 10, color: "#9CA3AF" },

  // ── Empty / error ──
  centreBox: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    padding:        32,
    marginTop:      40,
  },
  centreEmoji: { fontSize: 52, marginBottom: 12 },
  centreTitle: {
    fontSize:     18,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 8,
    textAlign:    "center",
  },
  centreBody: {
    fontSize:     14,
    color:        "#6B7280",
    textAlign:    "center",
    lineHeight:   21,
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   12,
    paddingHorizontal: 28,
  },
  retryBtnText: { color: "#FFF", fontSize: 14, fontWeight: "700" },

  // ── Footer loader ──
  footerLoader: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    paddingVertical: 16,
  },
  footerLoaderText: { fontSize: 13, color: "#6B7280" },

  // ── Skeleton ──
  skeletonContainer: { padding: 16 },
  skeletonCard: {
    flexDirection:   "row",
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    12,
    gap:             12,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
  },
  skeletonAvatar: {
    width:           48,
    height:          48,
    borderRadius:    14,
    backgroundColor: "#E5E7EB",
  },
  skeletonBody: { flex: 1, justifyContent: "center" },
  skeletonLine: {
    height:          12,
    borderRadius:    6,
    backgroundColor: "#E5E7EB",
  },
});