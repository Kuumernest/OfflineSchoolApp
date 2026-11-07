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
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";
import {
  COLORS, ACCENT, SEMANTIC, roleAccent, accentBadge, statusBadge,
} from "../../../src/theme/colors";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// The priority banner takes its status tone: normal info, important warning,
// urgent error.
const PRIORITY_STYLES = {
  normal:    { bg: SEMANTIC.info.bg,    color: SEMANTIC.info.text,    border: SEMANTIC.info.box,    icon: "information-circle" },
  important: { bg: SEMANTIC.warning.bg, color: SEMANTIC.warning.text, border: SEMANTIC.warning.box, icon: "alert-circle"       },
  urgent:    { bg: SEMANTIC.error.bg,   color: SEMANTIC.error.text,   border: SEMANTIC.error.box,   icon: "warning"             },
};

const TEACHER       = ACCENT[roleAccent("teacher")];
const EXPIRED_BADGE = statusBadge("error");
const CLASS_BADGE   = accentBadge("indigo");

const AUDIENCE_LABEL_KEYS = {
  all:      "annAdmin.audAll",
  teachers: "annAdmin.audTeachers",
  students: "annAdmin.audStudents",
  class:    "annAdmin.audClasses",
};

const AUTHOR_ROLE_LABEL_KEYS = {
  super_admin:  "annAdmin.roleSuperAdmin",
  school_admin: "annAdmin.roleSchoolAdmin",
  admin:        "annAdmin.roleAdmin",
  teacher:      "annAdmin.roleTeacher",
};

/** The banner shouts the priority, so each one needs its own upper-case line. */
const PRIORITY_BANNER_KEYS = {
  normal:    "annAdmin.bannerNormal",
  important: "annAdmin.bannerImportant",
  urgent:    "annAdmin.bannerUrgent",
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

function MetaRow({ icon, iconColor = COLORS.textSecondary, children }) {
  return (
    <View style={styles.metaRow}>
      <Ionicons name={icon} size={16} color={iconColor} />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function SectionTitle({ icon, accent = "sky", children }) {
  if (!icon) return <Text style={styles.sectionLabel}>{children}</Text>;
  return (
    <View style={styles.sectionLabelRow}>
      <IconSquare icon={icon} accent={accent} size={28} />
      <Text style={[styles.sectionLabel, styles.sectionLabelInRow]}>{children}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function AnnouncementDetailScreen() {
  const router = useRouter();
  const { t }  = useTranslation();
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
      setError(errorText(t, err, "annAdmin.errLoad"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = () => {
    Alert.alert(
      t("annAdmin.deleteTitle"),
      t("annAdmin.deleteBody", { title: announcement?.title }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.delete"),
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await AnnouncementService.deleteAnnouncement(id);
              router.back();
            } catch (err) {
              Alert.alert(t("annAdmin.errorTitle"), errorText(t, err, "annAdmin.errDelete"));
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
      Alert.alert(t("annAdmin.errorTitle"), errorText(t, err, "annAdmin.errPin"));
    }
  };

  // ── Acknowledge ────────────────────────────────────────────────────────────
  const handleAcknowledge = async () => {
    try {
      await AnnouncementService.acknowledgeAnnouncement(id);
      setAnnouncement((prev) =>
        prev ? { ...prev, isAcknowledged: true, isRead: true } : prev
      );
      Alert.alert(t("annAdmin.ackDoneTitle"), t("annAdmin.ackDoneBody"));
    } catch (err) {
      Alert.alert(t("annAdmin.errorTitle"), errorText(t, err, "annAdmin.errAck"));
    }
  };

  // ── Share ──────────────────────────────────────────────────────────────────
  const handleShare = async () => {
    if (!announcement) return;
    try {
      await Share.share({
        title:   announcement.title,
        message: `📢 ${announcement.title}\n\n${announcement.body}\n\n— ${
          announcement.authorName || t("annAdmin.shareAuthorFallback")
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
        <ActivityIndicator size="large" color={ACCENT.sky.solid} />
        <Text style={styles.loadingText}>{t("common.loading")}</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ERROR / NOT FOUND STATE
  // ─────────────────────────────────────────────────────────────────────────

  if (error || !announcement) {
    return (
      <View style={styles.centered}>
        <IconSquare icon="alert-circle-outline" accent={error ? "red" : "sky"} size={56} radius={16} />
        <Text style={styles.notFoundTitle}>
          {error ? t("annAdmin.somethingWrong") : t("annAdmin.notFound")}
        </Text>
        {!!error && (
          <Text style={styles.notFoundSub}>{error}</Text>
        )}
        <View style={styles.notFoundActions}>
          {!!error && (
            <TouchableOpacity style={styles.retryBtn} onPress={loadDetail}>
              <Ionicons name="refresh-outline" size={16} color={ACCENT.sky.deep} />
              <Text style={styles.retryBtnText}>{t("common.retry")}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.goBackBtn}
            onPress={() => router.back()}
          >
            <Text style={styles.goBackText}>{t("common.goBack")}</Text>
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
  const authorLabelKey = AUTHOR_ROLE_LABEL_KEYS[announcement.authorRole] ||
                         AUTHOR_ROLE_LABEL_KEYS[announcement.author_role] ||
                         "annAdmin.roleStaff";

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>

        <HeaderIcon style={styles.headerIcon} />
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t("annAdmin.announcement")}
          </Text>
          {fromTeacher && (
            <Text style={styles.headerSub}>{t("annAdmin.fromTeacher")}</Text>
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
            <Ionicons name="share-outline" size={20} color={COLORS.textSecondary} />
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
              color={announcement.isPinned ? ACCENT.sky.solid : COLORS.textSecondary}
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
              <ActivityIndicator size="small" color={COLORS.danger} />
            ) : (
              <Ionicons name="trash-outline" size={20} color={COLORS.danger} />
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
            <Ionicons name="time-outline" size={16} color={EXPIRED_BADGE.text} />
            <Text style={styles.expiredText}>
              {t("annAdmin.expiredOn", {
                date: formatFullDate(announcement.expiresAt),
              })}
            </Text>
          </View>
        )}

        {/* ── TEACHER SOURCE BANNER ── */}
        {fromTeacher && (
          <View style={styles.teacherBanner}>
            <View style={styles.teacherBannerLeft}>
              <Ionicons name="person-circle-outline" size={20} color={TEACHER.solid} />
              <Text style={styles.teacherBannerText}>
                {t("annAdmin.sentBy")}{" "}
                <Text style={{ fontWeight: "700" }}>
                  {announcement.authorName || t("annAdmin.teacherFallback")}
                </Text>
              </Text>
            </View>
            <View style={styles.teacherBadge}>
              <Text style={styles.teacherBadgeText}>{t("annAdmin.roleTeacher")}</Text>
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
              {t(
                PRIORITY_BANNER_KEYS[announcement.priority] ||
                  "annAdmin.bannerNormal"
              )}
            </Text>
            {expired && (
              <View style={styles.expiredTag}>
                <Text style={styles.expiredTagText}>{t("annAdmin.expired")}</Text>
              </View>
            )}
          </View>
        )}

        {/* ── PINNED BANNER ── */}
        {announcement.isPinned && (
          <View style={styles.pinnedBanner}>
            <Ionicons name="pin" size={14} color={ACCENT.sky.solid} />
            <Text style={styles.pinnedText}>{t("annAdmin.pinnedAnnouncement")}</Text>
          </View>
        )}

        {/* ── TITLE ── */}
        <Text style={styles.title}>{announcement.title}</Text>

        {/* ── META CARD ── */}
        <View style={[styles.card, announcement.isPinned && styles.cardPinned]}>
          <SectionTitle icon="information-circle">{t("annAdmin.details")}</SectionTitle>

          {/* Author */}
          <MetaRow
            icon={fromTeacher ? "person-circle-outline" : "shield-half-outline"}
            iconColor={ACCENT[roleAccent(announcement.authorRole || announcement.author_role)].solid}
          >
            <Text style={styles.metaValue}>
              {announcement.authorName || t("annAdmin.unknown")}
              {"  "}
              <Text style={[
                styles.metaTag,
                { color: ACCENT[roleAccent(announcement.authorRole || announcement.author_role)].deep },
              ]}>
                {t(authorLabelKey)}
              </Text>
            </Text>
          </MetaRow>

          {/* Sent at */}
          <MetaRow icon="time-outline" iconColor={COLORS.textSecondary}>
            <Text style={styles.metaValue}>
              {formatFullDate(announcement.createdAt)}
            </Text>
          </MetaRow>

          {/* Audience */}
          <MetaRow icon="people-outline" iconColor={COLORS.textSecondary}>
            <Text style={styles.metaValue}>
              {t(AUDIENCE_LABEL_KEYS[announcement.audience] || "annAdmin.audAll")}
            </Text>
          </MetaRow>

          {/* Expiry */}
          {announcement.expiresAt && (
            <MetaRow
              icon="timer-outline"
              iconColor={expired ? COLORS.textSecondary : ACCENT.amber.solid}
            >
              <Text style={[
                styles.metaValue,
                expired && { color: COLORS.textSecondary },
              ]}>
                {t("annAdmin.expiresAt", {
                  date: formatFullDate(announcement.expiresAt),
                })}
                {expired ? t("annAdmin.expiredSuffix") : ""}
              </Text>
            </MetaRow>
          )}

          {/* Read / acknowledged counts */}
          {(announcement.readCount !== undefined ||
            announcement.acknowledgedCount !== undefined) && (
            <MetaRow icon="eye-outline" iconColor={COLORS.textSecondary}>
              <Text style={styles.metaValue}>
                {t("annAdmin.readCount", { count: announcement.readCount ?? 0 })}
                {announcement.acknowledgedCount !== undefined
                  ? `  ·  ${t("annAdmin.ackCount", {
                      count: announcement.acknowledgedCount,
                    })}`
                  : ""}
              </Text>
            </MetaRow>
          )}

          {/* Offline indicator */}
          {!announcement._synced && (
            <MetaRow icon="cloud-offline-outline" iconColor={SEMANTIC.warning.icon}>
              <Text style={[styles.metaValue, { color: SEMANTIC.warning.text }]}>
                {t("annAdmin.savedOffline")}
              </Text>
            </MetaRow>
          )}
        </View>

        {/* ── TARGET CLASSES ── */}
        {announcement.audience === "class" &&
          announcement.targetClasses?.length > 0 && (
            <View style={styles.card}>
              <SectionTitle icon="school" accent="indigo">{t("annAdmin.targetClasses")}</SectionTitle>
              <View style={styles.classChips}>
                {announcement.targetClasses.map((c, i) => {
                  const name =
                    typeof c === "object"
                      ? c.name || c.className || t("annAdmin.classIndex", { n: i + 1 })
                      : c;
                  return (
                    <View key={i} style={styles.classChip}>
                      <Ionicons
                        name="school-outline"
                        size={12}
                        color={CLASS_BADGE.text}
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
          <SectionTitle icon="chatbox-ellipses">{t("common.message")}</SectionTitle>
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
                color={COLORS.onPrimary}
              />
              <Text style={styles.ackButtonText}>
                {t("annAdmin.ackCta")}
              </Text>
            </TouchableOpacity>
          )}

        {/* ── ACKNOWLEDGED BADGE ── */}
        {announcement.isAcknowledged && (
          <View style={styles.ackBadge}>
            <Ionicons name="checkmark-circle" size={20} color={SEMANTIC.success.text} />
            <Text style={styles.ackBadgeText}>{t("annAdmin.acknowledged")}</Text>
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
              color={announcement.isPinned ? ACCENT.sky.solid : COLORS.textSecondary}
            />
            <Text style={[
              styles.quickActionText,
              { color: announcement.isPinned ? ACCENT.sky.deep : COLORS.textSecondary },
            ]}>
              {announcement.isPinned ? t("annAdmin.unpin") : t("annAdmin.pin")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickActionBtn, styles.quickActionShareBtn]}
            onPress={handleShare}
            activeOpacity={0.8}
          >
            <Ionicons name="share-outline" size={18} color={ACCENT.sky.solid} />
            <Text style={[styles.quickActionText, { color: ACCENT.sky.deep }]}>
              {t("annAdmin.share")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickActionBtn, styles.quickActionDeleteBtn]}
            onPress={handleDelete}
            disabled={deleting}
            activeOpacity={0.8}
          >
            {deleting ? (
              <ActivityIndicator size="small" color={COLORS.danger} />
            ) : (
              <>
                <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
                <Text style={[styles.quickActionText, { color: SEMANTIC.error.text }]}>
                  {t("common.delete")}
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
  container: { flex: 1, backgroundColor: COLORS.page },

  // ── Loading / error states ─────────────────────────────────────────────────
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: COLORS.page,
    padding:         32,
    gap:             12,
  },
  loadingText: {
    fontSize:   14,
    color:      COLORS.textSecondary,
    fontWeight: "500",
    marginTop:  8,
  },
  notFoundTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      COLORS.text,
    textAlign:  "center",
  },
  notFoundSub: {
    fontSize:   13,
    color:      COLORS.textSecondary,
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
    borderColor:       ACCENT.sky.base,
  },
  retryBtnText: { color: ACCENT.sky.deep, fontWeight: "600", fontSize: 14 },
  goBackBtn: {
    paddingHorizontal: 20,
    paddingVertical:   10,
    backgroundColor:   ACCENT.sky.solid,
    borderRadius:      10,
  },
  goBackText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerIcon:    { marginRight: 0 },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:     { fontSize: 11, color: TEACHER.deep, fontWeight: "600", marginTop: 1 },
  headerActions: { flexDirection: "row", gap: 6 },
  headerAction: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: COLORS.page,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerActionActive: {
    backgroundColor: ACCENT.sky.wash,
  },
  headerActionDelete: {
    backgroundColor: SEMANTIC.error.bg,
  },

  // ── Scroll content ─────────────────────────────────────────────────────────
  scrollContent: { padding: 16, paddingBottom: 40 },

  // ── Banners ────────────────────────────────────────────────────────────────
  expiredBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              8,
    backgroundColor:  EXPIRED_BADGE.bg,
    borderWidth:      1,
    borderColor:      EXPIRED_BADGE.border,
    borderRadius:     10,
    padding:          10,
    marginBottom:     10,
  },
  expiredText: { fontSize: 12, color: EXPIRED_BADGE.text, flex: 1, lineHeight: 17 },

  teacherBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   TEACHER.wash,
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   10,
    marginBottom:      10,
    borderWidth:       1,
    borderColor:       accentBadge(roleAccent("teacher")).border,
  },
  teacherBannerLeft: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flex:          1,
  },
  teacherBannerText: { fontSize: 13, color: TEACHER.deep, fontWeight: "500" },
  teacherBadge: {
    backgroundColor:   TEACHER.solid,
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  teacherBadgeText: { fontSize: 11, color: COLORS.onPrimary, fontWeight: "700" },

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
    backgroundColor:   EXPIRED_BADGE.bg,
    borderWidth:       1,
    borderColor:       EXPIRED_BADGE.border,
    borderRadius:      5,
    paddingHorizontal: 7,
    paddingVertical:   2,
  },
  expiredTagText: { fontSize: 10, color: EXPIRED_BADGE.text, fontWeight: "700" },

  pinnedBanner: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    marginBottom:  10,
  },
  pinnedText: { fontSize: 12, color: ACCENT.sky.deep, fontWeight: "700" },

  // ── Title ──────────────────────────────────────────────────────────────────
  title: {
    fontSize:     22,
    fontWeight:   "800",
    color:        COLORS.text,
    lineHeight:   30,
    marginBottom: 14,
  },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.sky.base,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       1,
  },
  cardPinned: { borderColor: ACCENT.sky.base },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    "700",
    color:         COLORS.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom:  12,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  12,
  },
  sectionLabelInRow: { marginBottom: 0, flexShrink: 1 },

  // ── Meta rows ──────────────────────────────────────────────────────────────
  metaRow: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           10,
    marginBottom:  10,
  },
  metaValue: {
    fontSize:   13,
    color:      COLORS.text,
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
    backgroundColor:   CLASS_BADGE.bg,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       CLASS_BADGE.border,
  },
  classChipText: { fontSize: 12, color: CLASS_BADGE.text, fontWeight: "600" },

  // ── Body ───────────────────────────────────────────────────────────────────
  bodyText: {
    fontSize:   15,
    color:      COLORS.text,
    lineHeight: 24,
  },

  // ── Acknowledge ────────────────────────────────────────────────────────────
  ackButton: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: ACCENT.red.solid,
    borderRadius:    14,
    padding:         16,
    gap:             10,
    marginBottom:    12,
  },
  ackButtonText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "700" },
  ackBadge: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: SEMANTIC.success.bg,
    borderRadius:    14,
    padding:         14,
    gap:             8,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     SEMANTIC.success.box,
  },
  ackBadgeText: { fontSize: 14, color: SEMANTIC.success.text, fontWeight: "700" },

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
  quickActionPinBtn:   { borderColor: COLORS.border, backgroundColor: COLORS.surface },
  quickActionShareBtn: { borderColor: ACCENT.sky.base, backgroundColor: ACCENT.sky.wash },
  quickActionDeleteBtn:{ borderColor: SEMANTIC.error.box, backgroundColor: SEMANTIC.error.bg },
  quickActionText:     { fontSize: 13, fontWeight: "600" },
});