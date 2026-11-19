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
//
// For an account holding gate.verify the screen also answers the second
// question — are this child's fees up to date? — on a card that stays until
// closed or the next scan (GateVerificationCard). The answer is computed on
// the phone from a synced snapshot (gateSnapshot.service.js + the shared
// compliance engine), then replaced by the server's when there is signal, and
// it always says which. A forgotten card is looked up by name in the search
// box, which also works offline. Without gate.verify none of the fee panel
// exists: the card shows the child, nothing about money.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, StatusBar, Alert, TextInput, Keyboard,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";

import GateService        from "../../../src/services/gate.service";
import GateSnapshot       from "../../../src/services/gateSnapshot.service";
import GateVerificationCard, { ageText } from "../../../src/components/GateVerificationCard";
import GateStatusPill     from "../../../src/components/gate/GateStatusPill";
import StudentPhoto       from "../../../src/components/StudentPhoto";
import { isStale }        from "../../../src/components/gate/gateRules";
import { useIsOnline }    from "../../../src/hooks/useNeedsInternet";
import { formatTime }     from "../../../src/i18n/format";
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

  const isOnline  = useIsOnline();
  // Follows the stored permission list, which revalidateUser (below, and at
  // start-up) brings up to date. It was read once per mount on the belief the
  // list changed only at sign-in — it did, and that was the bug: a phone
  // signed in before gate.verify existed never saw fees here.
  // A selector, so the screen re-renders when the list changes.
  const verify = useAuthStore(() => GateSnapshot.canVerify());
  useEffect(() => { useAuthStore.getState().revalidateUser(); }, []);
  const [meta, setMeta]       = useState(null);
  // The verification card: stays until closed or replaced by the next scan.
  const [card, setCard]       = useState(null);
  const [recording, setRecording] = useState(false);
  const [query, setQuery]     = useState("");
  const [hits, setHits]       = useState([]);
  // Which card a late server answer belongs to. A slow /gate/verify for the
  // previous child must never repaint the card of the child now in front.
  const cardSeq = useRef(0);

  // A ref, not state: the camera fires onBarcodeScanned many times a second and
  // a state read inside that callback would be a render behind, letting the
  // same card through twice before the guard flipped.
  const busy = useRef(false);

  const refreshLog = useCallback(async () => {
    setLog(await GateService.todayLocal());
  }, []);

  const refreshMeta = useCallback(async () => {
    if (!verify) return;
    setMeta(await GateSnapshot.snapshotMeta());
  }, [verify]);

  /**
   * The verification snapshot, for gate.verify holders. Throws on failure so
   * the toolbar button can say so; the on-load pull swallows it — no signal
   * is the normal state at a gate, and the stored snapshot stands.
   */
  const pullSnapshot = useCallback(async () => {
    if (!verify) return;
    await GateSnapshot.pullSnapshot({ schoolId });
    await refreshMeta();
  }, [verify, schoolId, refreshMeta]);

  useEffect(() => {
    (async () => {
      await refreshLog();
      await refreshMeta();
      setReady(true);

      // The roster used to refresh only when someone thought to tap the
      // toolbar button, so a card cancelled this morning still resolved to a
      // child's name all day. Silent on failure: no signal is the normal
      // state at a gate, and the cached roster is the right fallback.
      try {
        setRoster(await GateService.syncRoster({ schoolId }));
      } catch { /* cached roster stands */ }
      try { await pullSnapshot(); } catch { /* stored snapshot stands */ }
    })();
  }, [refreshLog, refreshMeta, pullSnapshot, schoolId]);

  const pullRoster = useCallback(async () => {
    setSyncing(true);
    try {
      setRoster(await GateService.syncRoster({ schoolId }));
      await pullSnapshot();
    } catch {
      // Offline is the expected state at a gate. The cached roster stands.
      Alert.alert(t("gate.title"), t("gate.rosterOffline"));
    } finally {
      setSyncing(false);
    }
  }, [schoolId, t, pullSnapshot]);

  /**
   * Replace the card's device answer with the server's, when there is signal.
   * In the background: the device's answer is already on screen, and the
   * next child must not wait on a round trip.
   */
  //
  // Asked even when this phone's list says no gate.verify: the server decides
  // from the account's current permissions, and says so (forbidden) if not.
  const upgradeFromServer = useCallback((seq, studentId) => {
    if (!isOnline || !studentId) return;
    setCard((c) => (c && cardSeq.current === seq ? { ...c, verifying: true } : c));
    GateSnapshot.verifyRemote({ studentId, schoolId }).then((r) => {
      if (cardSeq.current !== seq) return;
      setCard((c) => {
        if (!c) return c;
        const verification = r?.compliance ?? c.verification;
        return {
          ...c,
          verifying: false,
          verification,
          feeUnavailable: verification ? null
            : r?.forbidden ? "not_permitted"
            : "server_missing",
        };
      });
    });
  }, [isOnline, schoolId]);

  /** Why a new card has no fees yet — null while the server is being asked. */
  const initialFeeReason = useCallback((verification) => {
    if (verification) return null;
    if (isOnline) return null;                       // upgradeFromServer will say
    return verify ? "no_offline_data" : "not_permitted";
  }, [isOnline, verify]);

  const closeCard = useCallback(() => {
    cardSeq.current += 1;
    setCard(null);
  }, []);

  // Manual search, over this phone first (works offline), topped up from the
  // server when there is signal and the phone found little — an operator
  // without gate.verify holds no snapshot, only the card roster.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return undefined; }
    let alive = true;
    const timer = setTimeout(async () => {
      const local = await GateSnapshot.searchLocal({ q, schoolId });
      if (!alive) return;
      setHits(local);
      if (isOnline && local.length < 5) {
        const remote = await GateSnapshot.searchRemote({ q, schoolId });
        if (!alive || !remote?.length) return;
        const seen = new Set(local.map((s) => s.student_id));
        setHits([...local, ...remote.filter((s) => !seen.has(s.student_id))].slice(0, 20));
      }
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, schoolId, isOnline]);

  const openManual = useCallback(async (student) => {
    Keyboard.dismiss();
    setQuery("");
    setHits([]);
    const seq = ++cardSeq.current;
    // The snapshot's row wins over a remote search hit: it carries the photo
    // and class this phone has cached.
    const known = (await GateSnapshot.findById(student.student_id)) ?? student;
    const [verification, next] = await Promise.all([
      verify ? GateSnapshot.verifyLocal(known.student_id) : null,
      GateService.nextDirection(known.student_id),
    ]);
    if (cardSeq.current !== seq) return;
    setCard({
      seq, student: known, verification, method: "manual", manual: true, next,
      passage: null, verifying: false, feeUnavailable: initialFeeReason(verification),
    });
    upgradeFromServer(seq, known.student_id);
  }, [verify, upgradeFromServer, initialFeeReason]);

  const recordManual = useCallback(async () => {
    if (!card?.manual || recording) return;
    setRecording(true);
    try {
      const r = await GateService.recordManual({
        schoolId,
        student: card.student,
        // What the operator is looking at right now — the server's answer if
        // it has arrived, the device's otherwise.
        // (The server keeps it only from an account that may see fees.)
        verification: card.verification ?? null,
      });
      if (!r.ok) return;
      Haptics.notificationAsync(
        r.duplicate ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success
      );
      // The same in/out flash a scan gives, cleared on its own timer — only
      // this one (`stamp`), never a scan banner that replaced it meanwhile.
      const stamp = Date.now();
      setResult(r.duplicate
        ? { kind: "duplicate", name: r.student.student_name, direction: r.direction, stamp }
        : { kind: r.direction, name: r.student.student_name, admissionNo: r.student.admission_no, className: r.student.class_name, at: r.at, stamp });
      setTimeout(() => setResult((cur) => (cur?.stamp === stamp ? null : cur)), RESULT_MS);
      setCard((c) => (c && c.seq === card.seq ? {
        ...c,
        next: { direction: r.direction, duplicate: true },
        passage: `${r.direction === "in" ? t("gate.signedIn") : t("gate.signedOut")} ${formatTime(r.at)}`,
      } : c));
      await refreshLog();
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(t("gate.title"), errorText(t, err));
    } finally {
      setRecording(false);
    }
  }, [card, recording, schoolId, refreshLog, t]);

  const onScan = useCallback(async ({ data }) => {
    if (busy.current) return;
    busy.current = true;

    try {
      const r = await GateService.scan({ schoolId, token: data });

      // The next scan replaces whatever card is open — the child in front
      // of the operator is the one that matters.
      // A QR code that is not a card at all (a poster, a drinks can) leaves
      // the open card alone: it is not a child, and the operator may be
      // mid-conversation with the one on screen.
      const seq = r.reason === "not_a_card" ? cardSeq.current : ++cardSeq.current;
      if (r.ok) {
        setCard({
          seq,
          student: r.student,
          verification: r.verification ?? null,
          method: "card",
          manual: false,
          passage: `${r.direction === "in" ? t("gate.signedIn") : t("gate.signedOut")} ${formatTime(r.at)}`,
          verifying: false,
          feeUnavailable: initialFeeReason(r.verification ?? null),
        });
        upgradeFromServer(seq, r.student?.student_id);
      } else if (r.reason !== "not_a_card") {
        setCard(null);
      }

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
  }, [schoolId, refreshLog, t, upgradeFromServer, initialFeeReason]);

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

      {/* Freshness. The fee answers below are only as good as the last sync,
          so its age is always on screen; no signal is said once here, not
          on every card. */}
      {(!isOnline || verify) && (
        <View style={styles.fresh}>
          {!isOnline && (
            <View style={styles.freshItem}>
              <Ionicons name="cloud-offline-outline" size={13} color={SEMANTIC.warning.text} />
              <Text style={[styles.freshText, { color: SEMANTIC.warning.text }]}>{t("gate.offline")}</Text>
            </View>
          )}
          {verify && (
            <View style={styles.freshItem}>
              <Ionicons
                name={!meta || isStale(meta.generatedAt) ? "warning-outline" : "time-outline"}
                size={13}
                color={!meta || isStale(meta.generatedAt) ? SEMANTIC.warning.text : COLORS.textSecondary}
              />
              <Text
                style={[styles.freshText, (!meta || isStale(meta.generatedAt)) && { color: SEMANTIC.warning.text }]}
                numberOfLines={2}
              >
                {!meta
                  ? t("gate.neverSynced")
                  : `${t("gate.syncedAgo", { age: ageText(t, meta.generatedAt) })}${isStale(meta.generatedAt) ? ` · ${t("gate.staleData")}` : ""}`}
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={COLORS.textSubtle} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={t("gate.searchPlaceholder")}
          placeholderTextColor={COLORS.textMuted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery("")} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={COLORS.textSubtle} />
          </TouchableOpacity>
        ) : null}
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
        {!banner && !card && (
          <View pointerEvents="none" style={styles.reticle}>
            <View style={styles.reticleBox} />
            <Text style={styles.reticleHint}>{t("gate.aim")}</Text>
          </View>
        )}

        {card && (
          <View style={styles.cardWrap}>
            <GateVerificationCard
              student={card.student}
              verification={card.verification}
              feeUnavailable={card.feeUnavailable}
              canVerify={verify}
              isOnline={isOnline}
              academicYear={meta?.academicYear ?? null}
              dataAsOf={meta?.generatedAt ?? null}
              method={card.method}
              passage={card.passage}
              verifying={card.verifying}
              onClose={closeCard}
              onRecord={card.manual ? recordManual : undefined}
              recordLabel={card.next?.direction === "out" ? t("gate.recordOut") : t("gate.recordIn")}
              recordDisabled={card.next?.duplicate === true}
              recordNote={card.next?.duplicate ? t("gate.recordedRecently") : null}
              recording={recording}
            />
          </View>
        )}

        {/* Search results over the camera: a forgotten card is the moment
            the operator stops scanning anyway. */}
        {query.trim().length >= 2 && (
          <View style={styles.hits}>
            {hits.length === 0 ? (
              <Text style={styles.empty}>{t("gate.searchEmpty")}</Text>
            ) : (
              <ScrollView keyboardShouldPersistTaps="handled">
                {hits.map((s) => (
                  <TouchableOpacity key={s.student_id} style={styles.hit} onPress={() => openManual(s)} activeOpacity={0.7}>
                    <StudentPhoto photoUrl={s.photo_url} name={s.student_name} size="sm" />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.rowName} numberOfLines={1}>{s.student_name || t("gate.unknownStudent")}</Text>
                      <Text style={styles.hitMeta} numberOfLines={1}>
                        {[s.admission_no, s.class_name].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={COLORS.textSubtle} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
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
                {verify && e.verificationStatus ? (
                  <GateStatusPill status={e.verificationStatus} short />
                ) : null}
                <Ionicons
                  name={e.method === "manual" ? "search" : "qr-code-outline"}
                  size={13}
                  color={COLORS.textSubtle}
                  accessibilityLabel={e.method === "manual" ? t("gate.methodManual") : t("gate.methodCard")}
                />
                <Text style={styles.rowTime}>{formatTime(e.at)}</Text>
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

  fresh: {
    flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 6,
    backgroundColor: COLORS.page, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  freshItem: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  freshText: { fontSize: 11, fontWeight: "600", color: COLORS.textSecondary, flexShrink: 1 },

  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 14, height: 44,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text, paddingVertical: 0 },

  cardWrap: { ...StyleSheet.absoluteFillObject, padding: 10 },

  hits: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.surface, paddingHorizontal: 14, paddingTop: 4,
  },
  hit: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  hitMeta: { marginTop: 2, fontSize: 12, color: COLORS.textSecondary },

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
