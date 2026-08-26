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
    case "suspend": return { icon: "ban-outline",              color: "#D97706", labelKey: "syncScreens.aSuspended" };
    case "restore": return { icon: "checkmark-circle-outline", color: "#059669", labelKey: "syncScreens.aRestored"  };
    case "delete":  return { icon: "trash-outline",            color: "#DC2626", labelKey: "syncScreens.aDeleted"   };
    case "move":    return { icon: "swap-horizontal-outline",  color: "#4F46E5", labelKey: "syncScreens.aMoved"     };
    // `raw` keeps an unrecognised action visible instead of mislabelling it.
    default:        return { icon: "sync-outline",             color: "#6B7280", labelKey: "syncScreens.aUpdated", raw: action };
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
  }, [id, router]);

  // ── Loading ─────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("common.loading")}</Text>
      </View>
    );
  }

  if (!overwrite) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
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

  // ── Render ───────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: "#F9FAFB" }}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color="#374151" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{t("syncScreens.detailTitle")}</Text>
          <Text style={styles.headerSub}>
            {overwrite.entity_name || overwrite.entity_type}
          </Text>
        </View>
        <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
          <Ionicons name="trash-outline" size={18} color="#DC2626" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>

        {/* Summary card */}
        <View style={styles.summaryCard}>
          <View style={[styles.actionIcon, { backgroundColor: action.color + "15" }]}>
            <Ionicons name={action.icon} size={22} color={action.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryAction}>
              <Text style={{ color: action.color, fontWeight: "700" }}>
                {overwrite.overwritten_by_name || t("syncScreens.someone")}
              </Text>
              {" "}
              <Text style={{ color: "#6B7280" }}>{(action.raw || t(action.labelKey)).toLowerCase()}</Text>
              {" this record"}
            </Text>
            <Text style={styles.summaryTime}>
              {formatDateTime(overwrite.overwritten_at)}
            </Text>
          </View>
        </View>

        {/* Timeline */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t("syncScreens.timeline")}</Text>

          <View style={styles.timelineRow}>
            <View style={styles.timelineDotMine} />
            <View style={styles.timelineContent}>
              <Text style={styles.timelineLabel}>{t("syncScreens.yourEdit")}</Text>
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
                {overwrite.overwritten_by_name || t("syncScreens.anotherAdmin")}'s edit
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
            <Text style={styles.sectionTitle}>
              Changes ({diffs.filter((d) => d.changed).length})
            </Text>
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
                    <Text style={styles.diffColLabel}>{t("syncScreens.yourVersion")}</Text>
                    <Text style={[
                      styles.diffValue,
                      d.changed && styles.diffValueOld,
                    ]}>
                      {d.lost}
                    </Text>
                  </View>

                  <Ionicons name="arrow-forward" size={14} color="#9CA3AF" />

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
            <Text style={styles.sectionTitle}>{t("syncScreens.changes")}</Text>
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
          <Text style={styles.sectionTitle}>{t("syncScreens.metadata")}</Text>

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
  loadingText: { color: "#6B7280", fontSize: 14 },
  errorTitle:  { fontSize: 18, fontWeight: "800", color: "#111827" },
  errorBtn: {
    marginTop:        16,
    backgroundColor:  "#4F46E5",
    borderRadius:     12,
    paddingHorizontal:20,
    paddingVertical:  10,
  },
  errorBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    backgroundColor:   "#fff",
    paddingHorizontal: 16,
    paddingTop:        50,
    paddingBottom:     14,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#6B7280", marginTop: 1 },
  deleteBtn: {
    width:           38,
    height:          38,
    borderRadius:    10,
    backgroundColor: "#FEF2F2",
    alignItems:      "center",
    justifyContent:  "center",
  },

  // Summary
  summaryCard: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: "#fff",
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    padding:         14,
  },
  actionIcon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  summaryAction: { fontSize: 14, color: "#111827", lineHeight: 20 },
  summaryTime:   { fontSize: 12, color: "#9CA3AF", marginTop: 2 },

  // Card
  card: {
    backgroundColor: "#fff",
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    padding:         16,
  },
  sectionTitle: {
    fontSize:     13,
    fontWeight:   "800",
    color:        "#111827",
    marginBottom: 12,
  },

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
    backgroundColor: "#4F46E5",
    marginTop:       4,
  },
  timelineDotTheirs: {
    width:           12,
    height:          12,
    borderRadius:    6,
    backgroundColor: "#DC2626",
    marginTop:       4,
  },
  timelineLine: {
    width:            2,
    height:           16,
    backgroundColor:  "#E5E7EB",
    marginLeft:       5,
    marginVertical:   2,
  },
  timelineContent: { flex: 1 },
  timelineLabel: {
    fontSize:   13,
    fontWeight: "600",
    color:      "#111827",
  },
  timelineTime: {
    fontSize:  12,
    color:     "#9CA3AF",
    marginTop: 2,
  },

  // Diff
  diffRow: {
    paddingVertical: 12,
    gap:             8,
  },
  diffRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  diffField: {
    fontSize:      11,
    fontWeight:    "700",
    color:         "#6B7280",
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
    color:    "#9CA3AF",
  },
  diffValue: {
    fontSize:   13,
    color:      "#111827",
    fontWeight: "500",
  },
  diffValueOld: {
    color:                "#991B1B",
    backgroundColor:      "#FEF2F2",
    textDecorationLine:   "line-through",
    paddingHorizontal:    6,
    paddingVertical:      2,
    borderRadius:         4,
  },
  diffValueNew: {
    color:            "#065F46",
    backgroundColor:  "#ECFDF5",
    paddingHorizontal:6,
    paddingVertical:  2,
    borderRadius:     4,
  },
  noDiffText: {
    fontSize:   13,
    color:      "#6B7280",
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
    borderBottomColor: "#F3F4F6",
  },
  metaLabel: { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  metaValue: { fontSize: 13, color: "#111827", flex: 1, textAlign: "right", marginLeft: 12 },
  mono: {
    fontFamily: "monospace",
    fontSize:   11,
  },
});
import { useTranslation } from "../../../src/i18n/useTranslation";