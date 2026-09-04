// app/teacher/announcements/[id].js
"use strict";

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Alert,
  Share,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }                        from "@expo/vector-icons";
import { useAuthStore }                    from "../../../src/store/auth.store";
import { useAnnouncementStore }            from "../../../src/store/announcement.store";
import { getAnnouncementById }             from "../../../src/services/announcement.service";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_CONFIG = {
  urgent: { color: "#DC2626", bg: "#FEE2E2", labelKey: "annTeacher.prioUrgent", icon: "warning"       },
  high:   { color: "#DC2626", bg: "#FEE2E2", labelKey: "annTeacher.prioHigh",   icon: "warning"       },
  normal: { color: "#D97706", bg: "#FEF3C7", labelKey: "annTeacher.prioNormal", icon: "alert-circle"  },
  medium: { color: "#D97706", bg: "#FEF3C7", labelKey: "annTeacher.prioNormal", icon: "alert-circle"  },
  low:    { color: "#059669", bg: "#ECFDF5", labelKey: "annTeacher.prioLow",    icon: "remove-circle" },
};

const formatFull = (d) => {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", {
    day:    "numeric",
    month:  "long",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
};

const isExpired = (d) => d && new Date(d) < new Date();

// ─── Info row ─────────────────────────────────────────────────────────────────

const InfoRow = ({ icon, label, value, color = "#4F46E5" }) => (
  <View style={styles.infoRow}>
    <View style={[styles.infoIcon, { backgroundColor: color + "18" }]}>
      <Ionicons name={icon} size={16} color={color} />
    </View>
    <View style={{ flex: 1 }}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  </View>
);

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function AnnouncementDetailScreen() {
  const { t } = useTranslation();
  const router    = useRouter();
  const { id }    = useLocalSearchParams();
  const user      = useAuthStore((s) => s.user);
  const teacherId = user?._id || user?.id;

  // ✅ Use selector subscriptions so the component re-renders
  //    if the store updates (e.g. isRead flips via another screen)
  const markRead    = useAnnouncementStore((s) => s.markRead);
  const acknowledge = useAnnouncementStore((s) => s.acknowledge);
  const remove      = useAnnouncementStore((s) => s.remove);

  // ✅ Subscribe to inbox so local isRead/isAcknowledged state is
  //    reflected immediately without a server round-trip
  const inboxItem = useAnnouncementStore((s) =>
    s.inbox.find((a) => (a.id || a._id) === String(id))
  );

  const [item,     setItem]     = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error,    setError]    = useState(null);

  // ── Fetch & mark read on mount ─────────────────────────────────────────
  useEffect(() => {
    if (!id) return;

    (async () => {
      try {
        const data = await getAnnouncementById(id);
        setItem(data);
      } catch (err) {
        setError(errorText(t, err));
      } finally {
        setLoading(false);
      }
    })();

    // ✅ Mark as read immediately on mount — covers all entry paths:
    //    tap from list, deep-link, push notification tap.
    //    The store skips the call internally if already read.
    markRead(String(id));
  }, [id, markRead, t]);

  // ✅ Keep local item in sync with store's optimistic updates
  useEffect(() => {
    if (!inboxItem) return;
    setItem((prev) =>
      prev
        ? {
            ...prev,
            isRead:         inboxItem.isRead,
            isAcknowledged: inboxItem.isAcknowledged,
          }
        : prev
    );
  }, [inboxItem?.isRead, inboxItem?.isAcknowledged]);

  // ── Acknowledge ────────────────────────────────────────────────────────
  const handleAcknowledge = useCallback(async () => {
    try {
      await acknowledge(String(id));
      setItem((prev) =>
        prev ? { ...prev, isAcknowledged: true, isRead: true } : prev
      );
      Alert.alert(t("annTeacher.ackedTitle"), t("annTeacher.ackedBody"));
    } catch (err) {
      Alert.alert(t("annTeacher.errorTitle"), errorText(t, err));
    }
  }, [acknowledge, id, t]);

  // ── Delete ─────────────────────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    Alert.alert(
      t("annTeacher.deleteTitle"),
      t("annTeacher.deleteConfirmBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:  t("common.delete"),
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await remove(String(id));
              router.back();
            } catch (err) {
              Alert.alert(t("annTeacher.errorTitle"), errorText(t, err));
              setDeleting(false);
            }
          },
        },
      ]
    );
  }, [id, remove, router, t]);

  // ── Share ──────────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!item) return;
    try {
      await Share.share({
        title:   item.title,
        message: `📢 ${item.title}\n\n${item.body}\n\n— ${item.authorName || t("annTeacher.shareFallback")}`,
      });
    } catch { /* ignore */ }
  }, [item, t]);

  // ─── Derived ───────────────────────────────────────────────────────────
  const isMine   = item?.authorId === teacherId;
  const priority = PRIORITY_CONFIG[item?.priority] || PRIORITY_CONFIG.normal;
  const expired  = isExpired(item?.expiresAt);

  // ─── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    );
  }

  if (error || !item) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={44} color="#DC2626" />
        <Text style={styles.errorMsg}>{error || t("annTeacher.notFound")}</Text>
        <TouchableOpacity style={styles.backBtnLarge} onPress={() => router.back()}>
          <Text style={styles.backBtnLargeText}>{t("common.goBack")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFF" />

      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </TouchableOpacity>

        <Text style={styles.headerTitle} numberOfLines={1}>{t("annTeacher.announcement")}</Text>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={handleShare}
            activeOpacity={0.7}
          >
            <Ionicons name="share-outline" size={20} color="#4F46E5" />
          </TouchableOpacity>

          {isMine && (
            <TouchableOpacity
              style={[styles.iconBtn, { backgroundColor: "#FEE2E2" }]}
              onPress={handleDelete}
              disabled={deleting}
              activeOpacity={0.7}
            >
              {deleting
                ? <ActivityIndicator size="small" color="#DC2626" />
                : <Ionicons name="trash-outline" size={18} color="#DC2626" />
              }
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {/* ── PRIORITY BANNER ── */}
        <View style={[
          styles.priorityBanner,
          { backgroundColor: expired ? "#F3F4F6" : priority.bg },
        ]}>
          <Ionicons
            name={expired ? "time-outline" : priority.icon}
            size={18}
            color={expired ? "#9CA3AF" : priority.color}
          />
          <Text style={[
            styles.priorityLabel,
            { color: expired ? "#9CA3AF" : priority.color },
          ]}>
            {expired ? t("annTeacher.expired") : t("annTeacher.priorityBanner", { label: t(priority.labelKey) })}
          </Text>
          {item.isPinned && (
            <View style={styles.pinnedChip}>
              <Ionicons name="pin" size={11} color="#7C3AED" />
              <Text style={styles.pinnedChipText}>{t("annTeacher.pinned")}</Text>
            </View>
          )}
        </View>

        {/* ── TITLE CARD ── */}
        <View style={styles.card}>
          <Text style={styles.announcementTitle}>{item.title}</Text>
        </View>

        {/* ── META CARD ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t("annTeacher.details")}</Text>
          <InfoRow
            icon="person-outline"
            label={t("annTeacher.from")}
            value={item.authorName || t("annTeacher.adminFallback")}
            color="#4F46E5"
          />
          <InfoRow
            icon="shield-half-outline"
            label={t("annTeacher.roleLabel")}
            value={
              item.authorRole === "super_admin"  ? t("annTeacher.roleSuperAdmin")  :
              item.authorRole === "school_admin" ? t("annTeacher.roleSchoolAdmin") :
              item.authorRole === "teacher"      ? t("annTeacher.roleTeacher")      :
                                                   item.authorRole || "—"
            }
            color="#7C3AED"
          />
          <InfoRow
            icon="calendar-outline"
            label={t("annTeacher.sent")}
            value={formatFull(item.createdAt)}
            color="#2563EB"
          />
          {item.expiresAt && (
            <InfoRow
              icon="timer-outline"
              label={t("annTeacher.expires")}
              value={formatFull(item.expiresAt)}
              color={expired ? "#9CA3AF" : "#D97706"}
            />
          )}
          <InfoRow
            icon="megaphone-outline"
            label={t("annTeacher.audience")}
            value={
              item.audience === "all"      ? t("annTeacher.wholeSchool")     :
              item.audience === "teachers" ? t("annTeacher.audTeachers")         :
              item.audience === "students" ? t("annTeacher.audStudents")         :
              item.audience === "class"    ? t("annTeacher.audClasses") :
                                             item.audience || "—"
            }
            color="#059669"
          />
          {item.targetClasses?.length > 0 && (
            <InfoRow
              icon="school-outline"
              label={t("annTeacher.classesLabel")}
              value={item.targetClasses.map((c) => c?.name || c).join(", ")}
              color="#D97706"
            />
          )}
        </View>

        {/* ── MESSAGE CARD ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t("common.message")}</Text>
          <Text style={styles.bodyText}>{item.body}</Text>
        </View>

        {/* ── STATUS CARD (inbox only — not own announcements) ── */}
        {!isMine && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t("annTeacher.yourStatus")}</Text>
            <View style={styles.statusRow}>
              <View style={[
                styles.statusChip,
                { backgroundColor: item.isRead ? "#ECFDF5" : "#F3F4F6" },
              ]}>
                <Ionicons
                  name={item.isRead ? "checkmark-circle" : "ellipse-outline"}
                  size={16}
                  color={item.isRead ? "#059669" : "#9CA3AF"}
                />
                <Text style={[
                  styles.statusText,
                  { color: item.isRead ? "#059669" : "#9CA3AF" },
                ]}>
                  {item.isRead ? t("annTeacher.read") : t("annTeacher.unread")}
                </Text>
              </View>

              <View style={[
                styles.statusChip,
                { backgroundColor: item.isAcknowledged ? "#ECFDF5" : "#FEF3C7" },
              ]}>
                <Ionicons
                  name={item.isAcknowledged ? "checkmark-done-circle" : "hand-left-outline"}
                  size={16}
                  color={item.isAcknowledged ? "#059669" : "#D97706"}
                />
                <Text style={[
                  styles.statusText,
                  { color: item.isAcknowledged ? "#059669" : "#D97706" },
                ]}>
                  {item.isAcknowledged ? t("annTeacher.acknowledged") : t("annTeacher.notAcknowledged")}
                </Text>
              </View>
            </View>

            {!item.isAcknowledged && (
              <TouchableOpacity
                style={styles.acknowledgeBtn}
                onPress={handleAcknowledge}
                activeOpacity={0.85}
              >
                <Ionicons name="checkmark-done" size={18} color="#FFF" />
                <Text style={styles.acknowledgeBtnText}>
                  {t("annTeacher.ackCta")}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── DELETE CTA (own sent announcements only) ── */}
        {isMine && (
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={handleDelete}
            disabled={deleting}
            activeOpacity={0.8}
          >
            <Ionicons name="trash-outline" size={18} color="#DC2626" />
            <Text style={styles.deleteBtnText}>{t("annTeacher.deleteTitle")}</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    gap:             14,
    padding:         32,
    backgroundColor: "#F3F4F6",
  },
  scroll: { padding: 14, paddingBottom: 40 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               12,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: "700", color: "#111827" },
  headerRight: { flexDirection: "row", gap: 8 },
  iconBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },

  priorityBanner: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    paddingHorizontal: 14,
    paddingVertical:   9,
    borderRadius:      10,
    marginBottom:      10,
  },
  priorityLabel: { fontSize: 14, fontWeight: "700", flex: 1 },
  pinnedChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   "#EDE9FE",
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
  },
  pinnedChipText: { fontSize: 11, fontWeight: "700", color: "#7C3AED" },

  card: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    marginBottom:    10,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       1,
  },
  sectionTitle: {
    fontSize:      11,
    fontWeight:    "700",
    color:         "#9CA3AF",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom:  12,
  },

  announcementTitle: {
    fontSize:   20,
    fontWeight: "800",
    color:      "#111827",
    lineHeight: 28,
  },

  infoRow: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           12,
    marginBottom:  12,
  },
  infoIcon: {
    width:          34,
    height:         34,
    borderRadius:   8,
    alignItems:     "center",
    justifyContent: "center",
  },
  infoLabel: { fontSize: 11, color: "#9CA3AF", fontWeight: "600", marginBottom: 2 },
  infoValue: { fontSize: 14, color: "#111827", fontWeight: "500" },

  bodyText: { fontSize: 15, color: "#374151", lineHeight: 24 },

  statusRow: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  statusChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 12,
    paddingVertical:   7,
    borderRadius:      10,
  },
  statusText: { fontSize: 13, fontWeight: "600" },

  acknowledgeBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: "#059669",
    paddingVertical: 13,
    borderRadius:    12,
  },
  acknowledgeBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  deleteBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: "#FEE2E2",
    paddingVertical: 14,
    borderRadius:    12,
    marginTop:       4,
  },
  deleteBtnText: { color: "#DC2626", fontWeight: "700", fontSize: 15 },

  errorMsg: { fontSize: 15, color: "#374151", textAlign: "center", fontWeight: "500" },
  backBtnLarge: {
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
  },
  backBtnLargeText: { color: "#FFF", fontWeight: "600" },
});
import { useTranslation } from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";