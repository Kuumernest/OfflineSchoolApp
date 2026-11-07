// mobile/app/admin/sync-overwrites/[id].js
"use strict";

import { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import SyncOverwriteService from "@/services/sync-overwrite.service";
import { getStudentById }   from "@/services/student.service";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const formatDateTime = (value) => {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year:   "numeric",
    month:  "short",
    day:    "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
};

const getActionConfig = (action) => {
  switch (action) {
    case "suspend": return { icon: "ban-outline",              color: ACCENT.amber.solid,  deep: ACCENT.amber.deep,  labelKey: "syncScreens.aSuspended" };
    case "restore": return { icon: "checkmark-circle-outline", color: ACCENT.green.solid,  deep: ACCENT.green.deep,  labelKey: "syncScreens.aRestored"  };
    case "delete":  return { icon: "trash-outline",            color: ACCENT.red.solid,    deep: ACCENT.red.deep,    labelKey: "syncScreens.aDeleted"   };
    case "move":    return { icon: "swap-horizontal-outline",  color: ACCENT.indigo.solid, deep: ACCENT.indigo.deep, labelKey: "syncScreens.aMoved"     };
    // `raw` keeps an unrecognised action visible instead of mislabelling it.
    default:        return { icon: "sync-outline",             color: ACCENT.slate.solid,  deep: ACCENT.slate.deep,  labelKey: "syncScreens.aUpdated", raw: action };
  }
};

// Fields we care about comparing (hide internal/noise fields).
const RELEVANT_FIELDS = [
  { key: "studentName",    labelKey: "common.name" },
  { key: "name",           labelKey: "common.name" },
  { key: "email",          labelKey: "common.email" },
  { key: "phone",          labelKey: "common.phone" },
  { key: "status",         labelKey: "common.status" },
  { key: "isActive",       labelKey: "common.active" },
  { key: "className",      labelKey: "syncScreens.fClass" },
  { key: "classId",        labelKey: "syncScreens.fClassId" },
  { key: "guardianName",   labelKey: "syncScreens.fGuardian" },
  { key: "guardianPhone",  labelKey: "syncScreens.fGuardianPhone" },
  { key: "address",        labelKey: "common.address" },
  { key: "gender",         labelKey: "common.gender" },
];

const buildDiff = (lostVersion, currentVersion) => {
  const diffs = [];
  const seen  = new Set();

  for (const { key, labelKey } of RELEVANT_FIELDS) {
    if (seen.has(labelKey)) continue;

    const lost    = lostVersion?.[key];
    const current = currentVersion?.[key];

    if (lost === undefined && current === undefined) continue;

    const lostStr    = lost    === null || lost    === undefined ? "—" : String(lost);
    const currentStr = current === null || current === undefined ? "—" : String(current);

    if (lostStr !== currentStr) {
      diffs.push({ labelKey, lost: lostStr, current: currentStr, changed: true });
    } else if (lostStr !== "—") {
      diffs.push({ labelKey, lost: lostStr, current: currentStr, changed: false });
    }

    seen.add(labelKey);
  }

  return diffs;
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function OverwriteDetailScreen() {
  const { t } = useTranslation();
  const { id }   = useLocalSearchParams();
  const router   = useRouter();

  const [overwrite,       setOverwrite]       = useState(null);
  const [currentVersion,  setCurrentVersion]  = useState(null);
  const [loading,         setLoading]         = useState(true);

  const load = useCallback(async () => {
    try {
      const record = await SyncOverwriteService.getById(id);
      if (!record) {
        setLoading(false);
        return;
      }
      setOverwrite(record);

      // Try to load the current version from local DB for diff comparison
      if (record.entity_type === "student" && record.entity_id) {
        const current = await getStudentById(record.entity_id);
        setCurrentVersion(current);
      }

      // Auto-mark as seen when opened
      if (record.seen_by_loser === 0) {
        await SyncOverwriteService.markAsSeen(id);
      }
    } catch (err) {
      console.warn("[overwrite-detail] load failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(() => {
    Alert.alert(
      t("syncScreens.delCta"),
      t("syncScreens.delBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text:    t("common.delete"),
          style:   "destructive",
          onPress: async () => {
            await SyncOverwriteService.deleteOverwrite(id);
            router.back();
          },
        },
      ]
    );
  }, [id, router, t]);

  // ── Loading ─────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={ACCENT.amber.solid} />
        <Text style={styles.loadingText}>{t("common.loading")}</Text>
      </View>
    );
  }

  if (!overwrite) {
    return (
      <View style={styles.centered}>
        <IconSquare icon="alert-circle-outline" accent="red" size={56} radius={16} />
        <Text style={styles.errorTitle}>{t("syncScreens.notFound")}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.errorBtn}>
          <Text style={styles.errorBtnText}>{t("common.goBack")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Derived ──────────────────────────────────────────

  const action = getActionConfig(overwrite.new_action);
  const diffs  = buildDiff(overwrite.lost_version, currentVersion);
  // "lost": your edit was replaced. "won": you replaced someone else's — the
  // replaced version is theirs, not yours.
  const isMine = overwrite.side === "lost";

  // ── Render ───────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.page }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("syncScreens.detailTitle")}</Text>
          <Text style={styles.headerSub}>
            {overwrite.entity_name || overwrite.entity_type}
          </Text>
        </View>
        <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
          <Ionicons name="trash-outline" size={18} color={SEMANTIC.error.icon} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>

        {/* Summary card */}
        <View style={styles.summaryCard}>
          <View style={[styles.actionIcon, { backgroundColor: action.color }]}>
            <Ionicons name={action.icon} size={22} color={COLORS.onPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryAction}>
              <Text style={{ color: action.deep, fontWeight: "700" }}>
                {overwrite.overwritten_by_name || t("syncScreens.someone")}
              </Text>
              {" "}
              <Text style={{ color: COLORS.textSecondary }}>{(action.raw || t(action.labelKey)).toLowerCase()}</Text>
              {" "}
              {t("syncScreens.thisRecord")}
            </Text>
            <Text style={styles.summaryTime}>
              {formatDateTime(overwrite.overwritten_at)}
            </Text>
          </View>
        </View>

        {/* Timeline */}
        <View style={styles.card}>
          <View style={styles.sectionHead}>
            <IconSquare icon="time" accent="amber" size={28} />
            <Text style={[styles.sectionTitle, styles.sectionTitleInHead]}>{t("syncScreens.timeline")}</Text>
          </View>

          <View style={styles.timelineRow}>
            <View style={styles.timelineDotMine} />
            <View style={styles.timelineContent}>
              <Text style={styles.timelineLabel}>
                {isMine
                  ? t("syncScreens.yourEdit")
                  : t("syncScreens.editOf", { name: overwrite.lost_edit_by_name || t("syncScreens.anotherAdmin") })}
              </Text>
              <Text style={styles.timelineTime}>
                {formatDateTime(overwrite.lost_edit_at)}
              </Text>
            </View>
          </View>

          <View style={styles.timelineLine} />

          <View style={styles.timelineRow}>
            <View style={styles.timelineDotTheirs} />
            <View style={styles.timelineContent}>
              <Text style={styles.timelineLabel}>
                {isMine
                  ? t("syncScreens.editOf", { name: overwrite.overwritten_by_name || t("syncScreens.anotherAdmin") })
                  : t("syncScreens.yourEdit")}
              </Text>
              <Text style={styles.timelineTime}>
                {formatDateTime(overwrite.overwritten_at)}
              </Text>
            </View>
          </View>
        </View>

        {/* Diff */}
        {diffs.length > 0 ? (
          <View style={styles.card}>
            <View style={styles.sectionHead}>
              <IconSquare icon="git-compare" accent="amber" size={28} />
              <Text style={[styles.sectionTitle, styles.sectionTitleInHead]}>
                {t("syncScreens.changesCount", { count: diffs.filter((d) => d.changed).length })}
              </Text>
            </View>
            {diffs.map((d, i) => {
                         return (
              <View
                key={`${d.labelKey}-${i}`}
                style={[
                  styles.diffRow,
                  i < diffs.length - 1 && styles.diffRowBorder,
                ]}
              >
                <Text style={styles.diffField}>{t(d.labelKey)}</Text>

                <View style={styles.diffValues}>
                  <View style={styles.diffCol}>
                    <Text style={styles.diffColLabel}>{isMine ? t("syncScreens.yourVersion") : t("syncScreens.theirVersion")}</Text>
                    <Text style={[
                      styles.diffValue,
                      d.changed && styles.diffValueOld,
                    ]}>
                      {d.lost}
                    </Text>
                  </View>

                  <Ionicons name="arrow-forward" size={14} color={ACCENT.amber.solid} />

                  <View style={styles.diffCol}>
                    <Text style={styles.diffColLabel}>{t("syncScreens.current")}</Text>
                    <Text style={[
                      styles.diffValue,
                      d.changed && styles.diffValueNew,
                    ]}>
                      {d.current}
                    </Text>
                  </View>
                </View>
              </View>
            );
                       })}
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.sectionHead}>
              <IconSquare icon="git-compare" accent="amber" size={28} />
              <Text style={[styles.sectionTitle, styles.sectionTitleInHead]}>{t("syncScreens.changes")}</Text>
            </View>
            <Text style={styles.noDiffText}>
              {currentVersion
                ? t("syncScreens.noDiffs")
                : overwrite.new_action === "delete"
                  ? t("syncScreens.recordDeleted")
                  : t("syncScreens.currentUnavailable")}
            </Text>
          </View>
        )}

        {/* Raw metadata */}
        <View style={styles.card}>
          <View style={styles.sectionHead}>
            <IconSquare icon="information-circle" accent="slate" size={28} />
            <Text style={[styles.sectionTitle, styles.sectionTitleInHead]}>{t("syncScreens.metadata")}</Text>
          </View>

          <MetaRow label={t("syncScreens.mEntityType")}      value={overwrite.entity_type} />
          <MetaRow label={t("syncScreens.mEntityId")}        value={overwrite.entity_id} mono />
          <MetaRow label={t("syncScreens.mOverwriteId")}     value={overwrite.id} mono />
          <MetaRow label={t("syncScreens.mSchoolId")}        value={overwrite.school_id} mono />
          <MetaRow
            label={t("syncScreens.mRecorded")}
            value={formatDateTime(overwrite.created_at)}
          />
          {overwrite.seen_at && (
            <MetaRow
              label={t("syncScreens.mSeenAt")}
              value={formatDateTime(overwrite.seen_at)}
            />
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// META ROW
// ─────────────────────────────────────────────────────────

function MetaRow({ label, value, mono = false }) {
  if (!value) return null;
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text
        style={[styles.metaValue, mono && styles.mono]}
        numberOfLines={1}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:      { padding: 16, gap: 12 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  loadingText: { color: COLORS.textSecondary, fontSize: 14 },
  errorTitle:  { fontSize: 18, fontWeight: "800", color: COLORS.text },
  errorBtn: {
    marginTop:        16,
    backgroundColor:  ACCENT.amber.solid,
    borderRadius:     12,
    paddingHorizontal:20,
    paddingVertical:  10,
  },
  errorBtnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 14 },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    backgroundColor:   COLORS.surface,
    paddingHorizontal: 16,
    paddingTop:        50,
    paddingBottom:     14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerIcon: { marginRight: 0 },
  backBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: COLORS.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
  deleteBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: SEMANTIC.error.bg,
    alignItems:      "center",
    justifyContent:  "center",
  },

  // Summary
  summaryCard: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: ACCENT.amber.wash,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.amber.base,
    padding:         14,
  },
  actionIcon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  summaryAction: { fontSize: 14, color: COLORS.text, lineHeight: 20 },
  summaryTime:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },

  // Card
  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     COLORS.border,
    padding:         16,
  },
  sectionTitle: {
    fontSize:     13,
    fontWeight:   "800",
    color:        COLORS.text,
    marginBottom: 12,
  },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sectionTitleInHead: { marginBottom: 0, flex: 1 },

  // Timeline
  timelineRow: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           12,
  },
  timelineDotMine: {
    width:           12,
    height:          12,
    borderRadius:    6,
    backgroundColor: ACCENT.indigo.solid,
    marginTop:       4,
  },
  timelineDotTheirs: {
    width:           12,
    height:          12,
    borderRadius:    6,
    backgroundColor: ACCENT.red.solid,
    marginTop:       4,
  },
  timelineLine: {
    width:            2,
    height:           16,
    backgroundColor:  COLORS.border,
    marginLeft:       5,
    marginVertical:   2,
  },
  timelineContent: { flex: 1 },
  timelineLabel: {
    fontSize:   13,
    fontWeight: "600",
    color:      COLORS.text,
  },
  timelineTime: {
    fontSize:  12,
    color:     COLORS.textSecondary,
    marginTop: 2,
  },

  // Diff
  diffRow: {
    paddingVertical: 12,
    gap:             8,
  },
  diffRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  diffField: {
    fontSize:      11,
    fontWeight:    "700",
    color:         ACCENT.amber.deep,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  diffValues: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  diffCol: {
    flex: 1,
    gap:  4,
  },
  diffColLabel: {
    fontSize: 10,
    color:    COLORS.textSecondary,
  },
  diffValue: {
    fontSize:   13,
    color:      COLORS.text,
    fontWeight: "500",
  },
  diffValueOld: {
    color:                SEMANTIC.error.text,
    backgroundColor:      SEMANTIC.error.bg,
    textDecorationLine:   "line-through",
    paddingHorizontal:    6,
    paddingVertical:      2,
    borderRadius:         4,
  },
  diffValueNew: {
    color:            SEMANTIC.success.text,
    backgroundColor:  SEMANTIC.success.bg,
    paddingHorizontal:6,
    paddingVertical:  2,
    borderRadius:     4,
  },
  noDiffText: {
    fontSize:   13,
    color:      COLORS.textSecondary,
    fontStyle:  "italic",
    lineHeight: 19,
  },

  // Meta
  metaRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "center",
    paddingVertical:8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  metaLabel: { fontSize: 12, color: COLORS.textSecondary, fontWeight: "500" },
  metaValue: { fontSize: 13, color: COLORS.text, flex: 1, textAlign: "right", marginLeft: 12 },
  mono: {
    fontFamily: "monospace",
    fontSize:   11,
  },
});
import { useTranslation } from "../../../src/i18n/useTranslation";