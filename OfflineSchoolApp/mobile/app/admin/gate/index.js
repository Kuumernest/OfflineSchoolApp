// app/admin/gate/index.js
//
// The gate scanner.
//
// Held by a member of staff at the gate while children file past, so the whole
// screen is built around one question: did that scan work, and who was it? The
// answer is a full-width colour flash and a name in large type — readable at
// arm's length, in sunlight, without looking closely.
//
// It works with no signal. Scans are written locally and queued; the roster is
// cached so a token still resolves to a name offline. A scanner that pauses for
// the network is worse than a paper register, because at least the register
// never spins.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, StatusBar, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";

import GateService        from "../../../src/services/gate.service";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { useAuthStore }   from "../../../src/store/auth.store";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

const C = {
  primary:   ACCENT.green.solid,
  in:        SEMANTIC.success.text,
  inBg:      SEMANTIC.success.bg,
  out:       SEMANTIC.warning.text,
  outBg:     SEMANTIC.warning.bg,
  danger:    SEMANTIC.error.text,
  dangerBg:  SEMANTIC.error.bg,
  ink:       COLORS.text,
  inkBody:   COLORS.text,
  inkMuted:  COLORS.textSecondary,
  inkFaint:  COLORS.textSubtle,
  line:      COLORS.border,
  surface:   COLORS.surface,
  canvas:    COLORS.page,
};

/** How long the result banner stays before the scanner is armed again. */
const RESULT_MS = 1800;

export default function GateScannerScreen() {
  const router   = useRouter();
  const { t }    = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [permission, requestPermission] = useCameraPermissions();

  const [ready, setReady]     = useState(false);
  const [roster, setRoster]   = useState(0);
  const [result, setResult]   = useState(null);
  const [log, setLog]         = useState({ events: [], onSite: 0, pending: 0 });
  const [syncing, setSyncing] = useState(false);

  // A ref, not state: the camera fires onBarcodeScanned many times a second and
  // a state read inside that callback would be a render behind, letting the
  // same card through twice before the guard flipped.
  const busy = useRef(false);

  const refreshLog = useCallback(async () => {
    setLog(await GateService.todayLocal());
  }, []);

  useEffect(() => {
    (async () => {
      await refreshLog();
      setReady(true);

      // The roster used to refresh only when someone thought to tap the
      // toolbar button, so a card cancelled this morning still resolved to a
      // child's name all day. Silent on failure: no signal is the normal
      // state at a gate, and the cached roster is the right fallback.
      try {
        setRoster(await GateService.syncRoster({ schoolId }));
      } catch { /* cached roster stands */ }
    })();
  }, [refreshLog, schoolId]);

  const pullRoster = useCallback(async () => {
    setSyncing(true);
    try {
      setRoster(await GateService.syncRoster({ schoolId }));
    } catch {
      // Offline is the expected state at a gate. The cached roster stands.
      Alert.alert(t("gate.title"), t("gate.rosterOffline"));
    } finally {
      setSyncing(false);
    }
  }, [schoolId, t]);

  const onScan = useCallback(async ({ data }) => {
    if (busy.current) return;
    busy.current = true;

    try {
      const r = await GateService.scan({ schoolId, token: data });

      if (!r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setResult({ kind: "unknown", queued: r.queued === true });
      } else if (r.duplicate) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setResult({ kind: "duplicate", name: r.student.student_name, direction: r.direction });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setResult({
          kind: r.direction,
          name: r.student.student_name,
          admissionNo: r.student.admission_no,
          className: r.student.class_name,
          at: r.at,
        });
        await refreshLog();
      }
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setResult({ kind: "error", message: errorText(t, err) });
    } finally {
      // Re-armed on a timer rather than immediately, so the operator sees the
      // result before the next child's card replaces it.
      setTimeout(() => { busy.current = false; setResult(null); }, RESULT_MS);
    }
  }, [schoolId, refreshLog, t]);

  if (!permission) {
    return <View style={styles.centre}><ActivityIndicator color={C.primary} /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.centre}>
        <IconSquare icon="camera-outline" accent="green" size={56} radius={16} />
        <Text style={styles.permTitle}>{t("gate.cameraNeeded")}</Text>
        <Text style={styles.permBody}>{t("gate.cameraWhy")}</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission} activeOpacity={0.85}>
          <Text style={styles.permBtnText}>{t("gate.allowCamera")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 14 }}>
          <Text style={styles.link}>{t("common.back")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const banner =
    result?.kind === "in"        ? { bg: C.inBg,     fg: C.in,     label: t("gate.signedIn") } :
    result?.kind === "out"       ? { bg: C.outBg,    fg: C.out,    label: t("gate.signedOut") } :
    result?.kind === "duplicate" ? { bg: C.outBg,    fg: C.out,    label: t("gate.alreadyScanned") } :
    result                       ? { bg: C.dangerBg, fg: C.danger, label: t("gate.notRecognised") } :
                                   null;

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>{t("gate.title")}</Text>
          <Text style={styles.subtitle}>
            {t("gate.onSite", { count: log.onSite })}
            {log.pending > 0 ? ` · ${t("gate.pending", { count: log.pending })}` : ""}
          </Text>
        </View>
        <TouchableOpacity onPress={pullRoster} hitSlop={10} disabled={syncing}>
          {syncing
            ? <ActivityIndicator color={C.primary} size="small" />
            : <Ionicons name="refresh" size={20} color={C.primary} />}
        </TouchableOpacity>
      </View>

      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScan}
        />

        {/* A frame to aim at. The camera reads the whole view, but a target
            makes people hold the card still, which is what actually speeds
            this up. */}
        {!banner && (
          <View pointerEvents="none" style={styles.reticle}>
            <View style={styles.reticleBox} />
            <Text style={styles.reticleHint}>{t("gate.aim")}</Text>
          </View>
        )}

        {banner && (
          <View style={[styles.result, { backgroundColor: banner.bg, borderTopColor: banner.fg }]}>
            <Text style={[styles.resultLabel, { color: banner.fg }]}>{banner.label}</Text>
            {result.name ? (
              <Text style={styles.resultName} numberOfLines={2}>{result.name}</Text>
            ) : null}
            {result.admissionNo ? (
              <Text style={styles.resultMeta}>
                {result.admissionNo}{result.className ? ` · ${result.className}` : ""}
              </Text>
            ) : null}
            {result.kind === "unknown" && (
              <Text style={styles.resultMeta}>
                {t("gate.unknownHint")}
                {result.queued ? ` ${t("gate.unknownQueued")}` : ""}
              </Text>
            )}
          </View>
        )}
      </View>

      <View style={styles.logWrap}>
        <Text style={styles.logTitle}>{t("gate.recent")}</Text>
        {!ready ? (
          <ActivityIndicator color={C.primary} style={{ marginTop: 12 }} />
        ) : log.events.length === 0 ? (
          <Text style={styles.empty}>{t("gate.noScans")}</Text>
        ) : (
          <ScrollView>
            {log.events.slice(0, 30).map((e) => (
              <View
                key={e.id}
                style={[
                  styles.row,
                  { borderLeftColor: e.direction === "in" ? ACCENT.green.base : ACCENT.amber.base },
                ]}
              >
                <View style={[
                  styles.pill,
                  {
                    backgroundColor: e.direction === "in" ? C.inBg : C.outBg,
                    borderColor: e.direction === "in" ? SEMANTIC.success.box : SEMANTIC.warning.box,
                  },
                ]}>
                  <Text style={[
                    styles.pillText,
                    { color: e.direction === "in" ? C.in : C.out },
                  ]}>
                    {e.direction === "in" ? t("gate.in") : t("gate.out")}
                  </Text>
                </View>
                <Text style={styles.rowName} numberOfLines={1}>
                  {e.studentName || t("gate.unknownStudent")}
                </Text>
                <Text style={styles.rowTime}>{String(e.at).slice(11, 16)}</Text>
                {!e.isSynced && (
                  <Ionicons name="cloud-upload-outline" size={14} color={C.out} />
                )}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, backgroundColor: C.canvas },

  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerIcon: { marginRight: 0 },
  title:    { fontSize: 16, fontWeight: "700", color: COLORS.text },
  subtitle: { marginTop: 1, fontSize: 11, color: COLORS.textSecondary },

  cameraWrap: { flex: 1, position: "relative", overflow: "hidden" },

  reticle:     { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticleBox:  {
    width: 220, height: 220, borderRadius: 18,
    borderWidth: 3, borderColor: "#ffffffcc",
  },
  reticleHint: { marginTop: 14, color: "#fff", fontSize: 13, fontWeight: "600" },

  result: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center", justifyContent: "center", padding: 24,
    borderTopWidth: 6,
  },
  resultLabel: {
    fontSize: 13, fontWeight: "800", textTransform: "uppercase",
    letterSpacing: 1.2, marginBottom: 10,
  },
  // Deliberately large: read at arm's length, outdoors, without leaning in.
  resultName: { fontSize: 30, fontWeight: "800", color: C.ink, textAlign: "center" },
  resultMeta: { marginTop: 8, fontSize: 14, color: C.inkMuted, textAlign: "center" },

  logWrap: {
    height: 210, backgroundColor: C.surface,
    borderTopWidth: 1, borderTopColor: C.line, padding: 14,
  },
  logTitle: { fontSize: 12, fontWeight: "700", color: ACCENT.green.deep, textTransform: "uppercase", letterSpacing: 0.6 },
  empty:    { marginTop: 12, fontSize: 13, color: COLORS.textSecondary },

  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line,
    borderLeftWidth: 3, paddingLeft: 8,
  },
  pill:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, minWidth: 42, alignItems: "center", borderWidth: 1 },
  pillText: { fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  rowName:  { flex: 1, fontSize: 14, color: C.inkBody, fontWeight: "500" },
  rowTime:  { fontSize: 13, color: C.inkMuted, fontVariant: ["tabular-nums"] },

  permTitle:   { marginTop: 14, fontSize: 17, fontWeight: "700", color: C.ink, textAlign: "center" },
  permBody:    { marginTop: 6, fontSize: 14, color: C.inkMuted, textAlign: "center", lineHeight: 20 },
  permBtn:     { marginTop: 18, height: 46, paddingHorizontal: 22, borderRadius: 10, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  permBtnText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "600" },
  link:        { color: C.primary, fontSize: 14, fontWeight: "600" },
});
