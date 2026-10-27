// app/portal/index.js
//
// The guardian portal on a phone.
//
// Outside the admin and student sections on purpose: a parent signs in with an
// admission number and a code, holds a different token, and should never land
// in a screen built for staff.
//
// Read-only, and cached per section so a parent with one bar of signal in the
// school yard still sees the balance they came to check — with the screen
// saying plainly when it is showing an older copy.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, RefreshControl, KeyboardAvoidingView,
  Platform, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Print from "expo-print";

import PortalService      from "../../src/services/portal.service";
import { useTranslation } from "../../src/i18n/useTranslation";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";
import { formatDateShort } from "../../src/i18n/format";
import { errorText } from "../../src/utils/appError";
import BottomTabs     from "../../src/components/portal/BottomTabs";
import ChildSwitcher  from "../../src/components/portal/ChildSwitcher";
import HomeScreen     from "../../src/components/portal/HomeScreen";
import ResultsScreen  from "../../src/components/portal/ResultsScreen";
import AttendanceScreen, { monthKey, monthRange } from "../../src/components/portal/AttendanceScreen";
import FeesScreen     from "../../src/components/portal/FeesScreen";
import MessagesScreen from "../../src/components/portal/MessagesScreen";
import { LanguageToggle } from "../../src/components/portal/ui";

const C = {
  primary:   "#3B4996",
  primaryBg: "#F0F4FF",
  danger:    "#9F2318",
  dangerBg:  "#FDF2F1",
  success:   "#12683A",
  successBg: "#EEF7F1",
  warning:   "#96570B",
  warningBg: "#FDF6EC",
  ink:       "#0D1220",
  inkBody:   "#343D4F",
  inkMuted:  "#4F5A70",
  inkFaint:  "#666F84",
  line:      "#E9EBF0",
  surface:   "#FFFFFF",
  canvas:    "#F4F5F8",
};

// The screens that are about one child, and so carry the child switcher. Home
// shows every child at once; Messages covers the whole family.
const PER_CHILD = ["results", "attendance", "fees"];

export default function ParentPortalScreen() {
  const router          = useRouter();
  const { t, language } = useTranslation();
  const screenPad       = useScreenInsets({ top: 24, bottom: 28 });
  const headPad         = useScreenInsets({ top: 8, bottom: 0 });

  const [checking, setChecking] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  const [admissionNo, setAdmissionNo] = useState("");
  const [code, setCode]     = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);

  // Which of the five sections is on screen, and inside Messages which list.
  // `tab` is what is fetched: one of the five, or one of Messages' three.
  const [screen, setScreen]   = useState("home");
  const [msgView, setMsgView] = useState("messages");
  const tab = screen === "messages" ? msgView : screen;
  // The month Attendance shows, "YYYY-MM"; this month to begin with.
  const [month, setMonth]     = useState(() => monthKey(new Date()));
  const [me, setMe]           = useState(null);
  // Which child is on screen. Null means "whichever the server picks first",
  // which is what a parent with one child gets and never has to think about.
  const [childId, setChildId] = useState(null);
  const [section, setSection] = useState(null);
  const [feeReminders, setFeeReminders] = useState(null);
  // The account's overdue and due date, by the school's own rule: the figure
  // Home shows, read from the same card so the two never disagree.
  const [feeStatus, setFeeStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [printing, setPrinting] = useState(null);

  useEffect(() => {
    (async () => {
      // Signed in means "this phone holds a session", not "the twenty-minute
      // access token is still good" — the client renews that on its own.
      setSignedIn(await PortalService.hasSession());
      setChecking(false);
    })();
  }, []);

  const leave = useCallback(async () => {
    await PortalService.signOut();
    setSignedIn(false);
    setMe(null);
    setSection(null);
    setChildId(null);
    setScreen("home");
    setCode("");
  }, []);

  /** A 401 anywhere means the code was revoked or the session lapsed. */
  const handle401 = useCallback(async (err) => {
    if (err?.response?.status === 401) {
      const revoked = err?.response?.data?.code === "ACCESS_REVOKED";
      await leave();
      Alert.alert(
        t("portal.title"),
        revoked ? t("portal.revoked") : t("portal.sessionExpired")
      );
      return true;
    }
    return false;
  }, [leave, t]);

  /**
   * Which load is the current one.
   *
   * Every tab shares one `section`, and loadAll re-runs on each tab change
   * without cancelling the fetch already in flight — so the LAST response to
   * arrive won, not the one belonging to the tab on screen. The tabs do not
   * take the same time: `notices` makes two round trips (notifications and
   * conversations) where every other fetcher makes one, so it is reliably the
   * slowest and reliably the loser.
   *
   * Open Notices, tap Messages: the conversation list arrives first and
   * renders, then the notices response lands on top of it and the Messages tab
   * is showing the notifications array.
   *
   * This is HALF of what was reported, and for a while it was mistaken for all
   * of it. A ticket stops a superseded response from being written; it does
   * nothing about a payload already written by another tab, which is the other
   * half and the one that actually reached the parent. See `forThisTab` further
   * down — that is where "No conversations yet" was really coming from.
   *
   * A ticket per load, compared before every setState. The stale response is
   * dropped rather than cancelled — it is already paid for, and its cached copy
   * is still worth keeping for the tab it belongs to.
   */
  const loadSeq = useRef(0);

  const loadAll = useCallback(async ({ quiet = false } = {}) => {
    const ticket  = ++loadSeq.current;
    const current = () => ticket === loadSeq.current;

    // A poll must not put a spinner over a screen the parent is reading. The
    // ticket still applies, so a slow poll that lands after a tab change is
    // dropped like any other superseded load.
    if (!quiet) setLoading(true);
    try {
      const meRes = await PortalService.fetchMe(childId);
      if (!current()) return;
      setMe(meRes.data);

      // Pin the selection once the server has told us who is on screen. Without
      // this the switcher has nothing highlighted until the parent taps.
      const selected = meRes.data?.selectedId ?? null;
      if (!childId && selected) setChildId(selected);

      const fetcher = {
        // Every child's card in one request; the child is not passed.
        home:       PortalService.fetchHome,
        fees:       PortalService.fetchFees,
        results:    PortalService.fetchResults,
        attendance: (id) => PortalService.fetchAttendance(id, monthRange(month)),
        // Notices, including the threads with something unread in them.
        //
        // The merge used to happen here, on the phone: two requests, sorted
        // together locally. It is one request now because the server does it,
        // which is what makes the two slower halves of this screen the same
        // speed as the rest — and it is why the notice list can carry an
        // unread total at all. A client cannot count what it would need a
        // second endpoint to see.
        notices:    PortalService.fetchNotifications,
        news:       PortalService.fetchAnnouncements,
        messages:   PortalService.fetchConversations,
      }[tab];

      const loaded = await fetcher(childId ?? selected);
      if (!current()) return;
      // Tagged with the tab it was fetched for. The render refuses to read a
      // payload belonging to another tab, which is what stops one tab's shape
      // being handed to another tab's markup.
      setSection({ ...loaded, tab });

      // On Fees, the payment plan and the account's status as well.
      if (tab === "fees") {
        const id = childId ?? selected;
        try {
          const remindersRes = await PortalService.fetchFeeReminders(id);
          if (!current()) return;
          setFeeReminders(remindersRes.data);
        } catch {
          if (current()) setFeeReminders(null);
        }
        try {
          const homeRes = await PortalService.fetchHome();
          if (!current()) return;
          setFeeStatus(homeRes.data?.children?.find((c) => String(c._id) === String(id))?.fees ?? null);
        } catch {
          if (current()) setFeeStatus(null);
        }
      }
    } catch (err) {
      // A superseded load must not blank the tab now on screen, and must not
      // sign the parent out on a 401 that belongs to a request nobody is
      // waiting for any more.
      if (!current()) return;
      if (!(await handle401(err))) setSection(null);
    } finally {
      if (current() && !quiet) setLoading(false);
    }
  // `t` was a dependency while the notices fetcher named an untitled thread
  // with it. The server names them now, so nothing in here translates and
  // keeping it would refetch all six tabs on a language switch for no reason.
  }, [tab, childId, handle401, month]);

  useEffect(() => {
    if (signedIn) loadAll();
  }, [signedIn, loadAll]);

  /**
   * Polled while the portal is open.
   *
   * There is no socket layer anywhere in this system and this is not one: a
   * message sent while the parent is holding the screen appears within about
   * half a minute, not instantly. What it does replace is the parent having to
   * pull down to find out — which they had no reason to do, because nothing on
   * screen suggested there was anything new.
   *
   * Quiet, so no spinner appears over what they are reading. The staff thread
   * screen has polled at 20s for a while; 25s here because this refreshes a
   * whole tab rather than one conversation.
   */
  useEffect(() => {
    if (!signedIn) return undefined;
    const poll = setInterval(() => { loadAll({ quiet: true }); }, 25000);
    return () => clearInterval(poll);
  }, [signedIn, loadAll]);

  /**
   * Acknowledge one notice.
   *
   * Optimistic: the card and the badge settle before the request returns,
   * because a parent tapping a card should see it stop being new immediately
   * and the round trip is not theirs to wait for.
   *
   * Both pieces of local state are corrected from the server's own count when
   * it answers, and a failure needs no handling — the 25s poll re-reads both
   * and the worst case is a badge one too high until then. Nothing is lost:
   * the receipt either landed or it did not, and the notice is still there.
   */
  const markNotice = useCallback(async (noticeId) => {
    setSection((prev) => (prev?.tab !== "notices" ? prev : {
      ...prev,
      data: (prev.data ?? []).map((n) => (n._id === noticeId ? { ...n, read: true } : n)),
    }));
    setMe((prev) => (prev ? { ...prev, unreadNotices: Math.max(0, (prev.unreadNotices ?? 1) - 1) } : prev));

    try {
      const count = await PortalService.markNoticeRead(noticeId);
      if (count != null) {
        setMe((prev) => (prev ? { ...prev, unreadNotices: count } : prev));
      }
    } catch {
      // Left to the poll. See above.
    }
  }, []);

  /**
   * Acknowledge the lot.
   *
   * Same optimism as one card, applied to the list: every row is flipped and
   * the badge zeroed before the request returns, then settled on the server's
   * own count. A parent returning after a week of gate scans should not tap
   * twelve cards to clear a badge.
   */
  const markAllNotices = useCallback(async () => {
    setSection((prev) => (prev?.tab !== "notices" ? prev : {
      ...prev,
      data: (prev.data ?? []).map((n) => (n.conversationId ? n : { ...n, read: true })),
    }));
    setMe((prev) => (prev ? { ...prev, unreadNotices: 0 } : prev));

    try {
      const count = await PortalService.markAllNoticesRead();
      if (count != null) setMe((prev) => (prev ? { ...prev, unreadNotices: count } : prev));
    } catch {
      // Left to the poll, like one card.
    }
  }, []);

  /** To a section, and from a Home card to that child's page. */
  const open = useCallback((id, next, view = null) => {
    if (id) setChildId(id);
    if (view) setMsgView(view);
    setScreen(next);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadAll(); } finally { setRefreshing(false); }
  }, [loadAll]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await PortalService.login({
        admissionNo: admissionNo.trim(), code: code.trim(),
      });
      setSignedIn(true);
      setCode("");
    } catch (err) {
      setError(
        err?.response?.status === 429 ? t("portal.locked") : t("portal.signInFailed")
      );
    } finally {
      setBusy(false);
    }
  };

  const printReceipt = async (paymentId) => {
    setPrinting(paymentId);
    try {
      const html = await PortalService.fetchReceiptHtml(paymentId, language ?? "en", childId ?? me?.selectedId);
      await Print.printAsync({ html });
    } catch (err) {
      if (!(await handle401(err))) {
        Alert.alert(t("portal.receipt"), errorText(t, err) || String(err));
      }
    } finally {
      setPrinting(null);
    }
  };

  // Open the FROZEN card the school issued for a published result — the exact
  // report card, never a re-render from today's numbers.
  const openReportCard = async (summary) => {
    setPrinting(`card-${summary._id}`);
    try {
      const card = await PortalService.fetchReportCardHtml(summary._id, childId ?? me?.selectedId);
      if (card?.html) await Print.printAsync({ html: card.html });
    } catch (err) {
      if (err?.response?.status === 404) {
        Alert.alert(
          t("portal.reportCardView"),
          err?.response?.data?.code === "NOT_ISSUED"
            ? t("portal.reportCardNotIssued")
            : errorText(t, err) || String(err)
        );
      } else if (!(await handle401(err))) {
        Alert.alert(t("portal.reportCardView"), errorText(t, err) || String(err));
      }
    } finally {
      setPrinting(null);
    }
  };

  if (checking) {
    return <View style={styles.centre}><ActivityIndicator color={C.primary} /></View>;
  }

  // ── Sign in ────────────────────────────────────────────────────────────────
  if (!signedIn) {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        // "padding" on Android too. Edge-to-edge stopped the window resizing
      // for the keyboard, so an undefined behaviour left this doing nothing
      // and the field being typed into sat underneath the keys.
      behavior="padding"
      >
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={[styles.loginBody, screenPad]} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={{ alignSelf: "flex-start" }}>
            <Ionicons name="chevron-back" size={24} color={C.inkBody} />
          </TouchableOpacity>

          <Text style={styles.loginTitle}>{t("portal.title")}</Text>
          <Text style={styles.loginIntro}>{t("portal.intro")}</Text>

          <View style={styles.card}>
            <Text style={styles.label}>{t("portal.admissionNo")}</Text>
            <TextInput
              style={styles.input}
              value={admissionNo}
              onChangeText={setAdmissionNo}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholderTextColor={C.inkFaint}
            />
            <Text style={styles.hint}>{t("portal.admissionHint")}</Text>

            <Text style={styles.label}>{t("portal.code")}</Text>
            <TextInput
              // Not secureTextEntry: the parent is reading this off a slip of
              // paper, and hiding it only causes typing mistakes.
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="ABCD-EFGH"
              placeholderTextColor={C.inkFaint}
            />
            <Text style={styles.hint}>{t("portal.codeHint")}</Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.submit, (!admissionNo.trim() || !code.trim() || busy) && styles.submitOff]}
              onPress={submit}
              disabled={!admissionNo.trim() || !code.trim() || busy}
              activeOpacity={0.85}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>{t("portal.signIn")}</Text>}
            </TouchableOpacity>

            <Text style={styles.footNote}>{t("portal.noAccount")}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  /**
   * The section, but only if it belongs to the tab being drawn.
   *
   * `section` is one state slot for six tabs, and every tab reads a different
   * SHAPE out of it: fees and attendance are objects, results and messages and
   * notices are arrays. On a tab switch the new branch used to render the old
   * tab's payload for as long as the new fetch was in flight — and the spinner
   * could not intervene, because its condition is `loading && !data` and the
   * old payload made `data` truthy.
   *
   * Fees → Messages was therefore a crash: an object has no `.length`, so
   * `(data ?? []).length === 0` was false and the code fell through to
   * `.map()`, which an object does not have. "undefined is not a function",
   * on a parent's phone, on the tab they were told to check.
   *
   * Notices → Messages was the quieter face of the same bug: back when
   * /notifications returned nothing, an empty ARRAY crossed over and the
   * messages tab printed "No conversations yet" over a conversation that was
   * sitting on the server the whole time. That is the reported failure, and
   * the reason no amount of looking at the request explained it.
   *
   * Comparing the tag rather than clearing the slot on switch: clearing works
   * only if every writer remembers to, and a background poll landing a moment
   * later would put a foreign shape straight back. A payload that carries the
   * tab it was fetched for cannot be read by the wrong tab at all.
   */
  const forThisTab = section?.tab === tab ? section : null;
  const data  = forThisTab?.data;
  const stale = forThisTab?.stale;

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      {/* The school, the language, the way out. */}
      <View style={[styles.header, { paddingTop: headPad.paddingTop }]}>
        <Text style={styles.title} numberOfLines={1}>
          {me?.school?.name || t("portal.title")}
        </Text>
        <LanguageToggle />
        <TouchableOpacity
          onPress={leave}
          hitSlop={8}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t("portal.signOut")}
        >
          <Ionicons name="log-out-outline" size={22} color={C.inkBody} />
        </TouchableOpacity>
      </View>

      {/* Whose page this is, on the three screens about one child. */}
      {PER_CHILD.includes(screen) && (
        <ChildSwitcher
          family={me?.children}
          selected={childId ?? me?.selectedId}
          onSelect={setChildId}
        />
      )}

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.primary} />
        }
      >
        {stale && (
          <View style={styles.banner}>
            <Ionicons name="cloud-offline-outline" size={15} color={C.warning} />
            <Text style={styles.bannerText}>
              {forThisTab?.fetchedAt
                ? t("payroll.lastUpdated", { date: formatDateShort(forThisTab.fetchedAt) })
                : t("exp.onlineOnly")}
            </Text>
          </View>
        )}

        {/* Home draws its own placeholders. */}
        {tab === "home" && (
          <HomeScreen data={data} loading={loading} onOpen={open} />
        )}

        {tab === "results" && (
          <ResultsScreen
            data={data}
            loading={loading}
            childId={childId ?? me?.selectedId}
            printing={printing}
            onOpenReportCard={openReportCard}
          />
        )}

        {tab === "attendance" && (
          <AttendanceScreen data={data} loading={loading} month={month} onMonth={setMonth} />
        )}

        {tab === "fees" && (
          <FeesScreen
            data={data}
            loading={loading}
            plan={feeReminders?.hasPlan ? feeReminders.plan : null}
            status={feeStatus}
            childName={me?.student?.name ?? null}
            printing={printing}
            onPrintReceipt={printReceipt}
          />
        )}

        {screen === "messages" && (
          <MessagesScreen
            tab={tab}
            onView={setMsgView}
            data={data}
            loading={loading}
            me={me}
            markNotice={markNotice}
            markAllNotices={markAllNotices}
          />
        )}
      </ScrollView>

      <BottomTabs
        screen={screen}
        onChange={(next) => open(null, next)}
        badges={{ messages: (me?.unreadMessages ?? 0) + (me?.unreadNotices ?? 0) }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },

  loginBody:  { paddingHorizontal: 20, gap: 10 },
  loginTitle: { fontSize: 24, fontWeight: "700", color: C.ink, marginTop: 12 },
  loginIntro: { fontSize: 13, color: C.inkMuted, marginBottom: 10 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:   { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "700", color: C.ink },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 10 },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: "#F0DCBB",
  },
  bannerText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },

  label: { fontSize: 12, fontWeight: "600", color: C.inkBody, marginBottom: 5, marginTop: 10 },
  input: {
    height: 46, borderRadius: 9, borderWidth: 1, borderColor: "#D5D9E2",
    paddingHorizontal: 12, fontSize: 16, color: C.ink, backgroundColor: C.surface,
  },
  codeInput: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", letterSpacing: 2 },
  hint: { marginTop: 4, fontSize: 11, color: C.inkFaint },

  errorBox: {
    marginTop: 12, padding: 10, borderRadius: 9,
    backgroundColor: C.dangerBg, borderWidth: 1, borderColor: "#F2D3CF",
  },
  errorText: { fontSize: 12, color: C.danger },

  submit: {
    marginTop: 18, height: 48, borderRadius: 10, backgroundColor: C.primary,
    alignItems: "center", justifyContent: "center",
  },
  submitOff:  { opacity: 0.45 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  footNote:   { marginTop: 14, fontSize: 11, color: C.inkFaint, lineHeight: 16 },
});
