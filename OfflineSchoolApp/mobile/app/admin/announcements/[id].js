// app/admin/announcements/[id].js
"use strict";

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  StatusBar,
  Share,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import AnnouncementService from "../../../src/services/announcement.service";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_STYLES = {
  normal:    { bg: "#F0FDF4", color: "#15803D", border: "#BBF7D0", icon: "information-circle" },
  important: { bg: "#FEF3C7", color: "#92400E", border: "#FDE68A", icon: "alert-circle"       },
  urgent:    { bg: "#FEE2E2", color: "#991B1B", border: "#FECACA", icon: "warning"             },
};

const AUDIENCE_LABELS = {
  all:      "Everyone",
  teachers: "Teachers Only",
  students: "Students Only",
  class:    "Specific Classes",
};

const AUTHOR_ROLE_LABELS = {
  super_admin:  "Super Admin",
  school_admin: "School Admin",
  admin:        "Admin",
  teacher:      "Teacher",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const formatFullDate = (dateStr) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    year:    "numeric",
    month:   "long",
    day:     "numeric",
    hour:    "2-digit",
    minute:  "2-digit",
  });
};

const isExpired = (d) => !!d && new Date(d) < new Date();

const isTeacherRole = (role) => role === "teacher";

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function MetaRow({ icon, iconColor = "#6B7280", children }) {
  return (
    <View style={styles.metaRow}>
      <Ionicons name={icon} size={16} color={iconColor} />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function SectionTitle({ children }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function AnnouncementDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();

  const [announcement, setAnnouncement] = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [deleting,     setDeleting]     = useState(false);
  const [error,        setError]        = useState(null);

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await AnnouncementService.getAnnouncementById(id);
      setAnnouncement(data);

      // FIX: Only call markAsRead if genuinely unread — prevents
      // double-calling and avoids race with background refresh.
      if (data && !data.isRead) {
        AnnouncementService.markAsRead(id).catch((err) =>
          console.warn("markAsRead failed:", err.message)
        );
      }
    } catch (err) {
      console.error("loadDetail error:", err.message);
      setError(err.message || "Failed to load announcement");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = () => {
    Alert.alert(
      "Delete Announcement",
      `Delete "${announcement?.title}"?\n\nThis cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text:  "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await AnnouncementService.deleteAnnouncement(id);
              router.back();
            } catch (err) {
              Alert.alert("Error", err.message || "Failed to delete");
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  // ── Toggle pin ─────────────────────────────────────────────────────────────
  const handleTogglePin = async () => {
    try {
      const pinned = await AnnouncementService.togglePin(id);
      setAnnouncement((prev) =>
        prev ? { ...prev, isPinned: pinned } : prev
      );
    } catch (err) {
      Alert.alert("Error", err.message || "Failed to toggle pin");
    }
  };

  // ── Acknowledge ────────────────────────────────────────────────────────────
  const handleAcknowledge = async () => {
    try {
      await AnnouncementService.acknowledgeAnnouncement(id);
      setAnnouncement((prev) =>
        prev ? { ...prev, isAcknowledged: true, isRead: true } : prev
      );
      Alert.alert("Done ✓", "Announcement acknowledged.");
    } catch (err) {
      Alert.alert("Error", err.message || "Failed to acknowledge");
    }
  };

  // ── Share ──────────────────────────────────────────────────────────────────
  const handleShare = async () => {
    if (!announcement) return;
    try {
      await Share.share({
        title:   announcement.title,
        message: `📢 ${announcement.title}\n\n${announcement.body}\n\n— ${
          announcement.authorName || "School"
        }`,
      });
    } catch { /* user cancelled — ignore */ }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // LOADING STATE
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ERROR / NOT FOUND STATE
  // ─────────────────────────────────────────────────────────────────────────

  if (error || !announcement) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={52} color="#D1D5DB" />
        <Text style={styles.notFoundTitle}>
          {error ? "Something went wrong" : "Announcement not found"}
        </Text>
        {!!error && (
          <Text style={styles.notFoundSub}>{error}</Text>
        )}
        <View style={styles.notFoundActions}>
          {!!error && (
            <TouchableOpacity style={styles.retryBtn} onPress={loadDetail}>
              <Ionicons name="refresh-outline" size={16} color="#4F46E5" />
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.goBackBtn}
            onPress={() => router.back()}
          >
            <Text style={styles.goBackText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DERIVED VALUES
  // ─────────────────────────────────────────────────────────────────────────

  const pri         = PRIORITY_STYLES[announcement.priority] || PRIORITY_STYLES.normal;
  const expired     = isExpired(announcement.expiresAt);
  const fromTeacher = isTeacherRole(announcement.authorRole || announcement.author_role);
  const authorLabel = AUTHOR_ROLE_LABELS[announcement.authorRole] ||
                      AUTHOR_ROLE_LABELS[announcement.author_role] ||
                      "Staff";

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Announcement
          </Text>
          {fromTeacher && (
            <Text style={styles.headerSub}>From Teacher</Text>
          )}
        </View>

        <View style={styles.headerActions}>
          {/* Share */}
          <TouchableOpacity
            onPress={handleShare}
            style={styles.headerAction}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="share-outline" size={20} color="#6B7280" />
          </TouchableOpacity>

          {/* Pin / unpin */}
          <TouchableOpacity
            onPress={handleTogglePin}
            style={[
              styles.headerAction,
              announcement.isPinned && styles.headerActionActive,
            ]}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={announcement.isPinned ? "pin" : "pin-outline"}
              size={20}
              color={announcement.isPinned ? "#4F46E5" : "#6B7280"}
            />
          </TouchableOpacity>

          {/* Delete */}
          <TouchableOpacity
            onPress={handleDelete}
            style={[styles.headerAction, styles.headerActionDelete]}
            disabled={deleting}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {deleting ? (
              <ActivityIndicator size="small" color="#EF4444" />
            ) : (
              <Ionicons name="trash-outline" size={20} color="#EF4444" />
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* ── EXPIRED BANNER ── */}
        {expired && (
          <View style={styles.expiredBanner}>
            <Ionicons name="time-outline" size={16} color="#6B7280" />
            <Text style={styles.expiredText}>
              This announcement expired on{" "}
              {formatFullDate(announcement.expiresAt)}
            </Text>
          </View>
        )}

        {/* ── TEACHER SOURCE BANNER ── */}
        {fromTeacher && (
          <View style={styles.teacherBanner}>
            <View style={styles.teacherBannerLeft}>
              <Ionicons name="person-circle-outline" size={20} color="#0891B2" />
              <Text style={styles.teacherBannerText}>
                Sent by{" "}
                <Text style={{ fontWeight: "700" }}>
                  {announcement.authorName || "a Teacher"}
                </Text>
              </Text>
            </View>
            <View style={styles.teacherBadge}>
              <Text style={styles.teacherBadgeText}>Teacher</Text>
            </View>
          </View>
        )}

        {/* ── PRIORITY BANNER ── */}
        {announcement.priority !== "normal" && (
          <View style={[
            styles.priorityBanner,
            { backgroundColor: pri.bg, borderColor: pri.border },
          ]}>
            <Ionicons name={pri.icon} size={18} color={pri.color} />
            <Text style={[styles.priorityText, { color: pri.color }]}>
              {announcement.priority.toUpperCase()} ANNOUNCEMENT
            </Text>
            {expired && (
              <View style={styles.expiredTag}>
                <Text style={styles.expiredTagText}>Expired</Text>
              </View>
            )}
          </View>
        )}

        {/* ── PINNED BANNER ── */}
        {announcement.isPinned && (
          <View style={styles.pinnedBanner}>
            <Ionicons name="pin" size={14} color="#4F46E5" />
            <Text style={styles.pinnedText}>Pinned Announcement</Text>
          </View>
        )}

        {/* ── TITLE ── */}
        <Text style={styles.title}>{announcement.title}</Text>

        {/* ── META CARD ── */}
        <View style={styles.card}>
          <SectionTitle>Details</SectionTitle>

          {/* Author */}
          <MetaRow
            icon={fromTeacher ? "person-circle-outline" : "shield-half-outline"}
            iconColor={fromTeacher ? "#0891B2" : "#4F46E5"}
          >
            <Text style={styles.metaValue}>
              {announcement.authorName || "Unknown"}
              {"  "}
              <Text style={[
                styles.metaTag,
                { color: fromTeacher ? "#0891B2" : "#4F46E5" },
              ]}>
                {authorLabel}
              </Text>
            </Text>
          </MetaRow>

          {/* Sent at */}
          <MetaRow icon="time-outline" iconColor="#6B7280">
            <Text style={styles.metaValue}>
              {formatFullDate(announcement.createdAt)}
            </Text>
          </MetaRow>

          {/* Audience */}
          <MetaRow icon="people-outline" iconColor="#6B7280">
            <Text style={styles.metaValue}>
              {AUDIENCE_LABELS[announcement.audience] || "Everyone"}
            </Text>
          </MetaRow>

          {/* Expiry */}
          {announcement.expiresAt && (
            <MetaRow
              icon="timer-outline"
              iconColor={expired ? "#9CA3AF" : "#D97706"}
            >
              <Text style={[
                styles.metaValue,
                expired && { color: "#9CA3AF" },
              ]}>
                Expires: {formatFullDate(announcement.expiresAt)}
                {expired ? "  (expired)" : ""}
              </Text>
            </MetaRow>
          )}

          {/* Read / acknowledged counts */}
          {(announcement.readCount !== undefined ||
            announcement.acknowledgedCount !== undefined) && (
            <MetaRow icon="eye-outline" iconColor="#6B7280">
              <Text style={styles.metaValue}>
                {announcement.readCount ?? 0} read
                {announcement.acknowledgedCount !== undefined
                  ? `  ·  ${announcement.acknowledgedCount} acknowledged`
                  : ""}
              </Text>
            </MetaRow>
          )}

          {/* Offline indicator */}
          {!announcement._synced && (
            <MetaRow icon="cloud-offline-outline" iconColor="#F59E0B">
              <Text style={[styles.metaValue, { color: "#F59E0B" }]}>
                Saved offline — will sync when connected
              </Text>
            </MetaRow>
          )}
        </View>

        {/* ── TARGET CLASSES ── */}
        {announcement.audience === "class" &&
          announcement.targetClasses?.length > 0 && (
            <View style={styles.card}>
              <SectionTitle>Target Classes</SectionTitle>
              <View style={styles.classChips}>
                {announcement.targetClasses.map((c, i) => {
                  const name =
                    typeof c === "object"
                      ? c.name || c.className || `Class ${i + 1}`
                      : c;
                  return (
                    <View key={i} style={styles.classChip}>
                      <Ionicons
                        name="school-outline"
                        size={12}
                        color="#4F46E5"
                      />
                      <Text style={styles.classChipText}>{name}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

        {/* ── BODY ── */}
        <View style={styles.card}>
          <SectionTitle>Message</SectionTitle>
          <Text style={styles.bodyText}>{announcement.body}</Text>
        </View>

        {/* ── ACKNOWLEDGE (urgent + not yet acknowledged) ── */}
        {announcement.priority === "urgent" &&
          !announcement.isAcknowledged && (
            <TouchableOpacity
              onPress={handleAcknowledge}
              style={styles.ackButton}
              activeOpacity={0.8}
            >
              <Ionicons
                name="checkmark-circle-outline"
                size={20}
                color="#FFF"
              />
              <Text style={styles.ackButtonText}>
                Acknowledge This Announcement
              </Text>
            </TouchableOpacity>
          )}

        {/* ── ACKNOWLEDGED BADGE ── */}
        {announcement.isAcknowledged && (
          <View style={styles.ackBadge}>
            <Ionicons name="checkmark-circle" size={20} color="#15803D" />
            <Text style={styles.ackBadgeText}>Acknowledged</Text>
          </View>
        )}

        {/* ── QUICK ACTIONS (bottom) ── */}
        <View style={styles.quickActionsRow}>
          <TouchableOpacity
            style={[styles.quickActionBtn, styles.quickActionPinBtn]}
            onPress={handleTogglePin}
            activeOpacity={0.8}
          >
            <Ionicons
              name={announcement.isPinned ? "pin" : "pin-outline"}
              size={18}
              color={announcement.isPinned ? "#4F46E5" : "#6B7280"}
            />
            <Text style={[
              styles.quickActionText,
              { color: announcement.isPinned ? "#4F46E5" : "#6B7280" },
            ]}>
              {announcement.isPinned ? "Unpin" : "Pin"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickActionBtn, styles.quickActionShareBtn]}
            onPress={handleShare}
            activeOpacity={0.8}
          >
            <Ionicons name="share-outline" size={18} color="#4F46E5" />
            <Text style={[styles.quickActionText, { color: "#4F46E5" }]}>
              Share
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickActionBtn, styles.quickActionDeleteBtn]}
            onPress={handleDelete}
            disabled={deleting}
            activeOpacity={0.8}
          >
            {deleting ? (
              <ActivityIndicator size="small" color="#DC2626" />
            ) : (
              <>
                <Ionicons name="trash-outline" size={18} color="#DC2626" />
                <Text style={[styles.quickActionText, { color: "#DC2626" }]}>
                  Delete
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },

  // ── Loading / error states ─────────────────────────────────────────────────
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
    padding:         32,
    gap:             12,
  },
  loadingText: {
    fontSize:   14,
    color:      "#6B7280",
    fontWeight: "500",
    marginTop:  8,
  },
  notFoundTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      "#374151",
    textAlign:  "center",
  },
  notFoundSub: {
    fontSize:   13,
    color:      "#9CA3AF",
    textAlign:  "center",
    lineHeight: 18,
  },
  notFoundActions: {
    flexDirection: "row",
    gap:           10,
    marginTop:     8,
  },
  retryBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 16,
    paddingVertical:   9,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       "#4F46E5",
  },
  retryBtnText: { color: "#4F46E5", fontWeight: "600", fontSize: 14 },
  goBackBtn: {
    paddingHorizontal: 20,
    paddingVertical:   10,
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
  },
  goBackText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:     { fontSize: 11, color: "#0891B2", fontWeight: "600", marginTop: 1 },
  headerActions: { flexDirection: "row", gap: 6 },
  headerAction: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerActionActive: {
    backgroundColor: "#EEF2FF",
  },
  headerActionDelete: {
    backgroundColor: "#FEF2F2",
  },

  // ── Scroll content ─────────────────────────────────────────────────────────
  scrollContent: { padding: 16, paddingBottom: 40 },

  // ── Banners ────────────────────────────────────────────────────────────────
  expiredBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              8,
    backgroundColor:  "#F3F4F6",
    borderRadius:     10,
    padding:          10,
    marginBottom:     10,
  },
  expiredText: { fontSize: 12, color: "#6B7280", flex: 1, lineHeight: 17 },

  teacherBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   "#E0F2FE",
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   10,
    marginBottom:      10,
    borderWidth:       1,
    borderColor:       "#BAE6FD",
  },
  teacherBannerLeft: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flex:          1,
  },
  teacherBannerText: { fontSize: 13, color: "#0C4A6E", fontWeight: "500" },
  teacherBadge: {
    backgroundColor:   "#0891B2",
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  teacherBadgeText: { fontSize: 11, color: "#FFF", fontWeight: "700" },

  priorityBanner: {
    flexDirection: "row",
    alignItems:    "center",
    padding:       12,
    borderRadius:  12,
    marginBottom:  12,
    gap:           8,
    borderWidth:   1,
  },
  priorityText: {
    fontSize:      12,
    fontWeight:    "800",
    letterSpacing: 0.8,
    flex:          1,
  },
  expiredTag: {
    backgroundColor:   "#E5E7EB",
    borderRadius:      5,
    paddingHorizontal: 7,
    paddingVertical:   2,
  },
  expiredTagText: { fontSize: 10, color: "#6B7280", fontWeight: "700" },

  pinnedBanner: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    marginBottom:  10,
  },
  pinnedText: { fontSize: 12, color: "#4F46E5", fontWeight: "700" },

  // ── Title ──────────────────────────────────────────────────────────────────
  title: {
    fontSize:     22,
    fontWeight:   "800",
    color:        "#111827",
    lineHeight:   30,
    marginBottom: 14,
  },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       1,
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    "700",
    color:         "#9CA3AF",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom:  12,
  },

  // ── Meta rows ──────────────────────────────────────────────────────────────
  metaRow: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           10,
    marginBottom:  10,
  },
  metaValue: {
    fontSize:   13,
    color:      "#374151",
    fontWeight: "500",
    lineHeight: 18,
    marginTop:  1,
  },
  metaTag: {
    fontSize:   11,
    fontWeight: "700",
  },

  // ── Class chips ────────────────────────────────────────────────────────────
  classChips: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           8,
  },
  classChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 10,
    paddingVertical:   6,
    backgroundColor:   "#EEF2FF",
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#C7D2FE",
  },
  classChipText: { fontSize: 12, color: "#4F46E5", fontWeight: "600" },

  // ── Body ───────────────────────────────────────────────────────────────────
  bodyText: {
    fontSize:   15,
    color:      "#374151",
    lineHeight: 24,
  },

  // ── Acknowledge ────────────────────────────────────────────────────────────
  ackButton: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#991B1B",
    borderRadius:    14,
    padding:         16,
    gap:             10,
    marginBottom:    12,
  },
  ackButtonText: { color: "#FFF", fontSize: 15, fontWeight: "700" },
  ackBadge: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#F0FDF4",
    borderRadius:    14,
    padding:         14,
    gap:             8,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     "#BBF7D0",
  },
  ackBadgeText: { fontSize: 14, color: "#15803D", fontWeight: "700" },

  // ── Quick actions row (bottom) ─────────────────────────────────────────────
  quickActionsRow: {
    flexDirection: "row",
    gap:           10,
    marginTop:     4,
    marginBottom:  12,
  },
  quickActionBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    paddingVertical: 12,
    borderRadius:    12,
    borderWidth:     1.5,
  },
  quickActionPinBtn:   { borderColor: "#E5E7EB", backgroundColor: "#F9FAFB" },
  quickActionShareBtn: { borderColor: "#C7D2FE", backgroundColor: "#EEF2FF" },
  quickActionDeleteBtn:{ borderColor: "#FECACA", backgroundColor: "#FEF2F2" },
  quickActionText:     { fontSize: 13, fontWeight: "600" },
});