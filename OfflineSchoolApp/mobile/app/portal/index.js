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
import { conversationName } from "../../src/utils/participantName";
import BottomTabs     from "../../src/components/portal/BottomTabs";
import ChildSwitcher  from "../../src/components/portal/ChildSwitcher";
import HomeScreen     from "../../src/components/portal/HomeScreen";
import ResultsScreen  from "../../src/components/portal/ResultsScreen";
import AttendanceScreen, { monthKey, monthRange } from "../../src/components/portal/AttendanceScreen";
import FeesScreen     from "../../src/components/portal/FeesScreen";
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

// The three lists behind the Messages tab. "notices" is what the school has
// already sent this parent by email or SMS — gate arrivals, absences, fee
// reminders, published results. The records existed all along; nothing in the
// portal read them.
const MSG_VIEWS = ["messages", "notices", "news"];

// The screens that are about one child, and so carry the child switcher. Home
// shows every child at once; Messages covers the whole family.
const PER_CHILD = ["results", "attendance", "fees"];

// Screens that draw their own loading placeholders.
const SELF_LOADING = ["home", "results", "attendance", "fees"];

// One row per notification kind the portal is allowed to show. Keyed on the
// kind the server sends, so a kind that is added server-side and not listed
// here falls back rather than rendering a blank card.
const NOTICE_META = {
  "gate.arrival":     { icon: "log-in-outline",       fg: "#12683A", bg: "#EEF7F1", labelKey: "portal.noticeArrival" },
  "gate.departure":   { icon: "log-out-outline",      fg: "#3B4996", bg: "#F0F4FF", labelKey: "portal.noticeDeparture" },
  "attendance.absent":{ icon: "alert-circle-outline", fg: "#9F2318", bg: "#FDF2F1", labelKey: "portal.noticeAbsent" },
  "fee.reminder":     { icon: "cash-outline",          fg: "#96570B", bg: "#FDF6EC", labelKey: "portal.noticeFeeReminder" },
  "fee.payment":      { icon: "receipt-outline",       fg: "#12683A", bg: "#EEF7F1", labelKey: "portal.noticePayment" },
  "result.published": { icon: "school-outline",        fg: "#3B4996", bg: "#F0F4FF", labelKey: "portal.noticeResults" },
  "announcement":     { icon: "megaphone-outline",     fg: "#3B4996", bg: "#F0F4FF", labelKey: "portal.noticeAnnouncement" },
  // Not a row in the Notification queue — see the notices fetcher. That
  // collection is a delivery queue for email and SMS, and a row per message
  // would be a message per message.
  "message":          { icon: "chatbubble-outline",    fg: "#3B4996", bg: "#F0F4FF", labelKey: "portal.noticeMessage" },
  default:            { icon: "notifications-outline", fg: "#4F5A70", bg: "#F4F5F8", labelKey: "portal.noticeOther" },
};

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

        {/* Messages: conversations, notices and news, each with its count. */}
        {screen === "messages" && (
          <View style={styles.segment} accessibilityRole="tablist" accessibilityLabel={t("portal.messages")}>
            {MSG_VIEWS.map((key) => {
              const label = t(`portal.messagesScreen.${{ messages: "tabMessages", notices: "tabNotices", news: "tabNews" }[key]}`);
              const unread =
                key === "messages" ? (me?.unreadMessages ?? 0) :
                key === "notices"  ? (me?.unreadNotices  ?? 0) : 0;
              const on = msgView === key;
              return (
                <TouchableOpacity
                  key={key}
                  testID={`portal-msg-${key}`}
                  style={[styles.segmentBtn, on && styles.segmentBtnOn]}
                  onPress={() => setMsgView(key)}
                  activeOpacity={0.8}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={unread > 0 ? `${label} (${t("portal.unreadCount", { count: unread })})` : label}
                >
                  <Text style={[styles.segmentText, on && styles.segmentTextOn]} numberOfLines={1}>{label}</Text>
                  {unread > 0 ? (
                    <View style={[styles.tabBadge, on && styles.tabBadgeOn]}>
                      <Text style={styles.tabBadgeText}>{unread > 9 ? "9+" : unread}</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
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

        {/* The screens not above draw the shell's spinner while they load. */}
        {SELF_LOADING.includes(tab) ? null : loading && !data ? (
          <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
        ) : (
          <>
            {/* ── Messages ── */}
            {tab === "messages" && (
              <>
                <TouchableOpacity
                  style={styles.newMsgBtn}
                  onPress={() => router.push("/portal/messages/new")}
                  activeOpacity={0.85}
                >
                  <Ionicons name="create-outline" size={17} color="#FFFFFF" />
                  <Text style={styles.newMsgText}>{t("msgMobile.newMessage")}</Text>
                </TouchableOpacity>

                {(data ?? []).length === 0 ? (
                  <Text style={styles.emptyMsg}>{t("msgMobile.emptyTitle")}</Text>
                ) : (
                  (data ?? []).map((c) => (
                    <TouchableOpacity
                      key={c._id}
                      style={styles.convoRow}
                      activeOpacity={0.7}
                      onPress={() => router.push(`/portal/messages/${c._id}`)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.convoTitle} numberOfLines={1}>
                          {/* otherParticipants excludes this guardian, which
                              is why the server sends it — joining every
                              participant showed a parent their own name over
                              a message from the school. participants is the
                              fallback for an older server. */}
                          {conversationName(
                            c, c.otherParticipants || c.participants, t
                          )}
                        </Text>
                        <Text style={styles.convoPreview} numberOfLines={1}>
                          {c.lastMessagePreview || t("portal.noMessages")}
                        </Text>
                      </View>
                      {c.unread > 0 && (
                        <View style={styles.convoBadge}>
                          <Text style={styles.convoBadgeText}>{c.unread}</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  ))
                )}
              </>
            )}

            {/* ── Notices ─────────────────────────────────────────────────
                Everything the school has already sent this parent by email or
                SMS: gate arrivals and departures, absences, fee reminders,
                published results. The records existed from the moment each
                message went out — nothing in the portal had ever read them, so
                a parent whose phone lost the SMS had no second place to look. */}
            {tab === "notices" && (data?.length ?? 0) > 0 &&
              (me?.unreadNotices ?? 0) > 0 && (
                <TouchableOpacity
                  style={styles.markAllBtn}
                  onPress={markAllNotices}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                >
                  <Ionicons name="checkmark-done-outline" size={15} color={C.primary} />
                  <Text style={styles.markAllText}>{t("portal.markAllRead")}</Text>
                </TouchableOpacity>
              )}

            {tab === "notices" && (
              (data?.length ?? 0) === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.empty}>{t("portal.noNotices")}</Text>
                </View>
              ) : (
                data.map((n) => {
                  const meta = NOTICE_META[n.kind] ?? NOTICE_META.default;
                  // Whose notice it is. The list covers every child on the
                  // access now rather than only the one selected — a parent
                  // looking at their eldest should still learn the younger one
                  // was absent — so "was not recorded at school today" needs a
                  // name against it. Only worth showing when there are two.
                  const about = (me?.children?.length ?? 0) > 1
                    ? (me.children.find((c) => String(c._id) === String(n.studentId))?.name ?? null)
                    : null;
                  // A notice about a message that cannot be opened from the
                  // notice is a dead end; the rest have nowhere to go.
                  //
                  // Straight into the thread now, rather than switching to the
                  // Messages tab and leaving the parent to find the row again.
                  // Every card is tappable now, because tapping is what marks
                  // it read. A message notice also opens its thread; the rest
                  // have nowhere to go and are simply acknowledged.
                  //
                  // The message rows carry no `read` of their own — an unread
                  // thread stops being a notice at all once the thread is
                  // opened, which the thread screen's own marker handles.
                  const isNotice = !n.conversationId;
                  const unreadCard = isNotice && n.read === false;
                  return (
                    <TouchableOpacity
                      key={n._id}
                      style={[styles.card, unreadCard && styles.cardUnread]}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (n.conversationId) {
                          router.push(`/portal/messages/${n.conversationId}`);
                          return;
                        }
                        if (unreadCard) markNotice(n._id);
                      }}
                      accessibilityLabel={
                        unreadCard ? `${t(meta.labelKey)} · ${t("portal.unreadNotice")}` : undefined
                      }
                    >
                      <View style={styles.noticeHead}>
                        <View style={[styles.noticeIcon, { backgroundColor: meta.bg }]}>
                          <Ionicons name={meta.icon} size={14} color={meta.fg} />
                        </View>
                        <Text style={styles.noticeKind} numberOfLines={1}>
                          {t(meta.labelKey)}
                        </Text>
                        {n.unread > 0 ? (
                          <View style={styles.convoBadge}>
                            <Text style={styles.convoBadgeText}>{n.unread}</Text>
                          </View>
                        ) : null}
                        {/* A dot rather than a number: there is only ever one
                            of this notice, and "1" beside every new card is
                            noise. */}
                        {unreadCard ? <View style={styles.unreadDot} /> : null}
                        <Text style={[styles.lineMeta, styles.noticeMeta]} numberOfLines={1}>
                          {formatDateShort(n.sentAt || n.createdAt)}
                          {about ? ` · ${about}` : ""}
                        </Text>
                      </View>

                      {n.subject ? (
                        <Text style={styles.cardTitle}>{n.subject}</Text>
                      ) : null}
                      {n.body ? (
                        <Text style={styles.newsBody}>{n.body}</Text>
                      ) : null}

                      {/* A queued notice has not left the school yet, and a
                          failed one never will — saying so is kinder than a
                          silent absence when a parent is asking why they were
                          not told.

                          Only those two. This was every status except "sent",
                          which was safe while the server hid skipped rows and
                          is not now that it shows them: a skipped notice is
                          one the school never tried to send — an on-time
                          arrival, or a family with no email address — and
                          telling a parent it was not emailed, on the screen
                          where they are reading it, is an apology for
                          nothing. There is also no such translation: the key
                          would have rendered as portal.noticeStatus_skipped
                          on screen, because until now it could never be
                          reached. */}
                      {n.status === "pending" || n.status === "failed" ? (
                        <Text style={styles.noticePending}>
                          {t(`portal.noticeStatus_${n.status}`)}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })
              )
            )}

            {tab === "news" && (
              (data?.length ?? 0) === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.empty}>{t("portal.noNews")}</Text>
                </View>
              ) : (
                data.map((a) => {
                  // Which of this parent's children the notice is about, when
                  // it names any. The list now carries notices for every
                  // child's class rather than only the one on screen — which
                  // is the fix — and that makes "bring PE kit on Thursday"
                  // ambiguous for a parent with three children unless the card
                  // says whose Thursday it is.
                  const about = (a.forStudents ?? [])
                    .map((id) => (me?.children ?? [])
                      .find((c) => String(c._id) === String(id))?.name)
                    .filter(Boolean);
                  return (
                    <View key={a._id} style={styles.card}>
                      <Text style={styles.cardTitle}>{a.title || "—"}</Text>
                      <Text style={styles.lineMeta}>
                        {formatDateShort(a.createdAt)}
                        {about.length ? ` · ${about.join(", ")}` : ""}
                      </Text>
                      {a.body ? <Text style={styles.newsBody}>{a.body}</Text> : null}
                    </View>
                  );
                })
              )
            )}
          </>
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

  // Messages' three lists, as one segmented control.
  segment: {
    flexDirection: "row", gap: 4, padding: 4, borderRadius: 14,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
  },
  segmentBtn: {
    flex: 1, minHeight: 44, borderRadius: 10, paddingHorizontal: 4,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
  },
  segmentBtnOn:  { backgroundColor: C.primary },
  segmentText:   { flexShrink: 1, fontSize: 13, fontWeight: "600", color: C.inkBody },
  segmentTextOn: { color: "#FFFFFF" },
  tabBadgeOn:    { backgroundColor: "rgba(255,255,255,0.28)" },

  tabBadge: {
    minWidth: 16, paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 8, backgroundColor: C.danger, alignItems: "center",
  },
  tabBadgeText: { fontSize: 10, fontWeight: "700", color: "#FFFFFF" },

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
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink },

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

  line: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  lineMeta:   { marginTop: 2, fontSize: 11, color: C.inkFaint },

  noticeHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  noticeIcon: {
    width: 24, height: 24, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  // Beside the kind: shrinks (and ends in …) before it pushes the row wider.
  noticeMeta: { flexShrink: 1, maxWidth: "50%" },
  noticeKind: { flex: 1, fontSize: 12, fontWeight: "700", color: C.inkBody },
  noticePending: { marginTop: 6, fontSize: 11, fontWeight: "600", color: C.warning },

  // The denominator rides inside the figure so it wraps with it and stays
  // visually subordinate — the mark is what a parent reads first.

  newsBody: { marginTop: 8, fontSize: 13, color: C.inkBody, lineHeight: 19 },
  empty:    { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },

  // ── Results — report-card mirror ──────────────────────────────────────────

  // ── Attendance breakdown ──────────────────────────────────────────────────

  // The gate row: date, then arrival and departure as two labelled columns.
  // Times are tabular so a fortnight of arrivals reads as a column rather than
  // a ragged list — which is the whole point of looking at it.

  // ── Messages ──────────────────────────────────────────────────────────────
  newMsgBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: C.ink, borderRadius: 10,
    paddingVertical: 11, marginBottom: 12,
  },
  newMsgText: { fontSize: 14, fontWeight: "700", color: "#FFFFFF" },
  emptyMsg:   { fontSize: 13, color: C.inkFaint, textAlign: "center", paddingVertical: 24 },

  convoRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  convoTitle:   { fontSize: 14, fontWeight: "600", color: C.ink },
  convoPreview: { fontSize: 12, color: C.inkFaint, marginTop: 2 },
  convoBadge: {
    minWidth: 20, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 10, backgroundColor: C.ink, alignItems: "center",
  },
  convoBadgeText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },
  // An unread notice: a tinted edge down the left of the card and a dot by
  // the kind. Colour is not carrying this alone — the dot is a second cue for
  // anyone who cannot pick the tint out.
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: C.primary,
    backgroundColor: C.primaryBg,
  },
  // Shown only while there is something to clear, so it is never a button
  // that does nothing.
  markAllBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 9, marginBottom: 10, borderRadius: 10,
    borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
  },
  markAllText: { fontSize: 13, fontWeight: "600", color: C.primary },
  unreadDot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: C.primary,
  },
});
