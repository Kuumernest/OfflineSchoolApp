// src/components/GateVerificationCard.js
//
// What the gate operator reads after a scan or a manual lookup: who the child
// is, and — for an account holding gate.verify — whether their fees are up to
// date, from shared/compliance.js.
//
// It stays on screen until it is closed or the next card is scanned, unlike
// the in/out banner, which flashes for under two seconds. A fee status is a
// conversation the operator may need to have with the child or the parent at
// the gate; it must not vanish mid-sentence.
//
// Read-only. There is deliberately no button here that records a payment,
// edits an agreement, waives a charge or issues a gate pass: the gate is the
// wrong place, and the wrong person, for any of those. The one action is
// "Record arrival / departure" on a manual lookup (onRecord), which is a
// passage, not money.
//
// The answer always says where it came from. Computed on this phone from a
// synced snapshot, it says so and how old the data is; stale data and
// payments this phone recorded but the server has not confirmed are spelled
// out, never folded silently into the figures.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import StudentPhoto from "./StudentPhoto";
import GateStatusPill, { statusColours } from "./gate/GateStatusPill";
import { ageOf, formatFcfa } from "./gate/gateRules";
import { useTranslation } from "../i18n/useTranslation";
import { formatDate } from "../i18n/format";
import { COLORS, ACCENT, SEMANTIC, TILE_SHAPE } from "../theme/colors";

/** "3 h ago", in the person's language. */
export const ageText = (t, then, now = new Date()) => {
  const a = ageOf(then, now);
  if (!a) return null;
  return t(`gate.age.${a.unit}`, { count: a.count });
};

function Row({ label, value, strong, tone }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, strong && styles.rowValueStrong, tone && { color: SEMANTIC[tone].text }]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function Note({ icon, tone, text }) {
  const s = SEMANTIC[tone] ?? SEMANTIC.info;
  return (
    <View style={[styles.note, { backgroundColor: s.bg, borderColor: s.box }]}>
      <Ionicons name={icon} size={16} color={s.icon} style={{ marginTop: 1 }} />
      <Text style={[styles.noteText, { color: s.text }]}>{text}</Text>
    </View>
  );
}

/**
 * @param {object}  p
 * @param {{student_name?, admission_no?, class_name?, photo_url?}} p.student
 * @param {object|null} p.verification  compliance() result + `source` ("device" | "server")
 * @param {boolean} p.canVerify          false → no fee panel at all
 * @param {boolean} p.isOnline
 * @param {string|null} p.academicYear
 * @param {string|null} p.dataAsOf       the snapshot's generatedAt, for the freshness line
 * @param {"card"|"manual"} [p.method]
 * @param {string}  [p.passage]          a line under the name: "Signed in 07:42"
 * @param {boolean} [p.verifying]        the server's answer is on its way
 * @param {() => void} p.onClose
 * @param {() => void} [p.onRecord]      manual lookup only
 * @param {string}  [p.recordLabel]
 * @param {boolean} [p.recordDisabled]
 * @param {string}  [p.recordNote]
 */
export default function GateVerificationCard({
  student, verification, canVerify, isOnline, academicYear, dataAsOf, method,
  passage, verifying, onClose, onRecord, recordLabel, recordDisabled, recordNote, recording,
}) {
  const { t, language } = useTranslation();
  const money = (n) => formatFcfa(n, language);
  const v = verification;
  const edge = v ? statusColours(v.status)?.edge : COLORS.border;
  const year = v?.academicYear ?? academicYear ?? null;
  const fromDevice = v && v.source !== "server";
  const age = ageText(t, v?.dataAsOf ?? dataAsOf);

  const notes = [];
  if (canVerify && v) {
    if (fromDevice) {
      notes.push(!isOnline
        ? { icon: "cloud-offline-outline", tone: "info", text: t("gate.offlineComputed", { age: age ?? "—" }) }
        : { icon: "phone-portrait-outline", tone: "info", text: `${t("gate.sourceDevice")}${age ? ` · ${t("gate.syncedAgo", { age })}` : ""}` });
      if (v.stale) notes.push({ icon: "warning-outline", tone: "warning", text: t("gate.staleData") });
    } else {
      notes.push({ icon: "cloud-done-outline", tone: "info", text: t("gate.sourceServer") });
    }
    if (v.pending?.count > 0) {
      notes.push(v.dependsOnPending
        ? {
            icon: "hourglass-outline", tone: "warning",
            text: t("gate.pendingDepends", {
              count: v.pending.count, amount: money(v.pending.amount),
              status: t(`gate.status.${v.pending.statusIfConfirmed}`),
            }),
          }
        : {
            icon: "hourglass-outline", tone: "info",
            text: t("gate.pendingList", { count: v.pending.count, amount: money(v.pending.amount) }),
          });
    }
    if (v.rejected?.count > 0) {
      notes.push({ icon: "close-circle-outline", tone: "error", text: t("gate.rejectedPayments", { count: v.rejected.count }) });
    }
  }

  const arrangement = !v ? null
    : v.arrangement === "agreement" ? t("gate.arrangementAgreement")
    : v.agreementState === "pending_approval" ? `${t("gate.arrangementStandard")} · ${t("gate.agreementPending")}`
    : v.agreementState ? t("gate.agreementNotInForce")
    : t("gate.arrangementStandard");

  return (
    <View style={[styles.card, { borderTopColor: edge }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <StudentPhoto photoUrl={student?.photo_url} name={student?.student_name} size="lg" shape="card" />
          <View style={styles.headText}>
            <Text style={styles.name} numberOfLines={3}>{student?.student_name || t("gate.unknownStudent")}</Text>
            {student?.admission_no ? (
              <Text style={styles.meta}>{t("gate.admissionNo")} {student.admission_no}</Text>
            ) : null}
            {student?.class_name ? (
              <Text style={styles.meta}>{t("gate.className")}: {student.class_name}</Text>
            ) : null}
            {year ? <Text style={styles.meta}>{t("gate.academicYear")}: {year}</Text> : null}
            <View style={styles.tags}>
              {method ? (
                <View style={styles.tag}>
                  <Ionicons name={method === "manual" ? "search" : "qr-code"} size={11} color={COLORS.textSecondary} />
                  <Text style={styles.tagText}>{method === "manual" ? t("gate.methodManual") : t("gate.methodCard")}</Text>
                </View>
              ) : null}
              {passage ? <Text style={styles.passage}>{passage}</Text> : null}
            </View>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("gate.close")}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        {canVerify ? (
          v ? (
            <>
              <GateStatusPill status={v.status} size="lg" style={{ marginTop: 14 }} />
              {v.status === "authorized" && v.authorization ? (
                <View style={styles.auth}>
                  <Text style={styles.authText}>
                    {t("gate.authorizedUntil", { date: formatDate(v.authorization.validUntil) })}
                  </Text>
                  {v.authorization.reason ? (
                    <Text style={styles.authText}>{t("gate.authorizedReason", { reason: v.authorization.reason })}</Text>
                  ) : null}
                </View>
              ) : null}
              {verifying ? (
                <View style={styles.verifying}>
                  <ActivityIndicator size="small" color={COLORS.textSecondary} />
                  <Text style={styles.verifyingText}>{t("gate.verifying")}</Text>
                </View>
              ) : null}
              {notes.map((n, i) => <Note key={i} {...n} />)}

              <View style={styles.figures}>
                <Row label={t("gate.totalFees")} value={money(v.totalFees)} />
                <Row label={t("gate.expectedInstalment")} value={money(v.expectedInstalment)} />
                <Row label={t("gate.totalPaid")} value={money(v.totalPaid)} />
                <Row
                  label={t("gate.outstandingDue")}
                  value={money(v.outstandingDue)}
                  strong
                  tone={v.outstandingDue > 0 ? "error" : undefined}
                />
                <Row label={t("gate.remainingBalance")} value={money(v.remainingBalance)} />
                <Row
                  label={t("gate.nextDue")}
                  value={v.nextDueDate
                    ? t("gate.nextDueValue", { date: formatDate(v.nextDueDate), amount: money(v.nextDueAmount) })
                    : t("gate.none")}
                />
                <Row label={t("gate.arrangement")} value={arrangement} />
                <Row
                  label={t("gate.lastPayment")}
                  value={v.lastPaymentDate ? formatDate(v.lastPaymentDate) : t("gate.none")}
                />
              </View>
              <Text style={styles.readOnly}>{t("gate.feesReadOnly")}</Text>
            </>
          ) : verifying ? (
            <View style={styles.verifying}>
              <ActivityIndicator size="small" color={COLORS.textSecondary} />
              <Text style={styles.verifyingText}>{t("gate.verifying")}</Text>
            </View>
          ) : (
            <Note icon="information-circle-outline" tone="info" text={t("gate.noFeeData")} />
          )
        ) : null}

        {onRecord ? (
          <View style={{ marginTop: 14 }}>
            {recordNote ? <Text style={styles.recordNote}>{recordNote}</Text> : null}
            <TouchableOpacity
              style={[styles.recordBtn, (recordDisabled || recording) && { opacity: 0.5 }]}
              onPress={onRecord}
              disabled={recordDisabled || recording}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              {recording
                ? <ActivityIndicator color={COLORS.onPrimary} />
                : <>
                    <Ionicons name="enter-outline" size={18} color={COLORS.onPrimary} />
                    <Text style={styles.recordText}>{recordLabel}</Text>
                  </>}
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    ...TILE_SHAPE,
    padding: 0,
    borderTopWidth: 6,
    flex: 1,
    overflow: "hidden",
  },
  scroll:   { padding: 16, paddingBottom: 24 },
  head:     { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  headText: { flex: 1, minWidth: 0 },
  // Large, like the banner: read at arm's length.
  name:     { fontSize: 22, fontWeight: "800", color: COLORS.text },
  meta:     { marginTop: 3, fontSize: 13, color: COLORS.textSecondary },
  tags:     { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 6 },
  tag:      {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    backgroundColor: ACCENT.slate.wash, borderWidth: 1, borderColor: COLORS.border,
  },
  tagText:  { fontSize: 11, fontWeight: "700", color: COLORS.textSecondary },
  passage:  { fontSize: 12, fontWeight: "700", color: ACCENT.green.deep },

  auth:     { marginTop: 8, paddingHorizontal: 4 },
  authText: { fontSize: 14, fontWeight: "600", color: ACCENT.indigo.deep },

  verifying:     { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  verifyingText: { fontSize: 12, color: COLORS.textSecondary },

  note: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    marginTop: 10, padding: 10, borderRadius: 10, borderWidth: 1,
  },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "500" },

  figures:        { marginTop: 14, borderTopWidth: 1, borderTopColor: COLORS.border },
  row:            {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  rowLabel:       { flexShrink: 1, fontSize: 13, color: COLORS.textSecondary },
  rowValue:       { flexShrink: 1, textAlign: "right", fontSize: 14, color: COLORS.text, fontVariant: ["tabular-nums"] },
  rowValueStrong: { fontWeight: "800" },
  readOnly:       { marginTop: 8, fontSize: 11, color: COLORS.textSubtle },

  recordNote: { marginBottom: 6, fontSize: 12, color: SEMANTIC.warning.text },
  recordBtn:  {
    height: 48, borderRadius: 10, backgroundColor: ACCENT.green.solid,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  recordText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "700" },
});
