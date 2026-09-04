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

import React, { useState, useEffect, useCallback } from "react";
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
import { formatMoney, formatDateShort } from "../../src/i18n/format";
import { errorText } from "../../src/utils/appError";

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

// "notices" is what the school has already sent this parent by email or SMS —
// gate arrivals, absences, fee reminders, published results. The records
// existed all along; nothing in the portal read them.
const TABS = ["fees", "results", "attendance", "notices", "news", "messages"];

// Results arrive sorted newest-first (academic year desc, then term desc).
// Grouping preserves that order while giving each school year its own
// section — the way a report-card file is kept year by year.
const groupResultsByYear = (rows) => {
  const groups = [];
  const index  = {};
  for (const r of rows ?? []) {
    const year = r.academicYear || "—";
    if (!index[year]) {
      index[year] = { year, items: [] };
      groups.push(index[year]);
    }
    index[year].items.push(r);
  }
  return groups;
};

// Trim trailing zeros on a mark: 18.00 → "18", 16.40 → "16.4".
const trimMark = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isNaN(n) ? "—" : String(Math.round(n * 100) / 100);
};

// Attendance statuses arrive as English words; map them through i18n so a
// French portal stays French.
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
  default:            { icon: "notifications-outline", fg: "#4F5A70", bg: "#F4F5F8", labelKey: "portal.noticeOther" },
};

const ATTD_STATUS_KEY = {
  "Present":                      "portal.present",
  "Absent":                       "portal.absent",
  "Late":                         "portal.late",
  "Excused":                      "portal.excused",
  "Partial absence":              "portal.partialAbsence",
  "Present with partial absence": "portal.presentPartial",
};

export default function ParentPortalScreen() {
  const router          = useRouter();
  const { t, language } = useTranslation();

  const [checking, setChecking] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  const [admissionNo, setAdmissionNo] = useState("");
  const [code, setCode]     = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);

  const [tab, setTab]         = useState("fees");
  const [me, setMe]           = useState(null);
  // Which child is on screen. Null means "whichever the server picks first",
  // which is what a parent with one child gets and never has to think about.
  const [childId, setChildId] = useState(null);
  const [section, setSection] = useState(null);
  const [feeReminders, setFeeReminders] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [printing, setPrinting] = useState(null);

  useEffect(() => {
    (async () => {
      setSignedIn(Boolean(await PortalService.getToken()));
      setChecking(false);
    })();
  }, []);

  const leave = useCallback(async () => {
    await PortalService.signOut();
    setSignedIn(false);
    setMe(null);
    setSection(null);
    setChildId(null);
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

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const meRes = await PortalService.fetchMe(childId);
      setMe(meRes.data);

      // Pin the selection once the server has told us who is on screen. Without
      // this the switcher has nothing highlighted until the parent taps.
      const selected = meRes.data?.selectedId ?? null;
      if (!childId && selected) setChildId(selected);

      const fetcher = {
        fees:       PortalService.fetchFees,
        results:    PortalService.fetchResults,
        attendance: PortalService.fetchAttendance,
        notices:    PortalService.fetchNotifications,
        news:       PortalService.fetchAnnouncements,
        messages:   PortalService.fetchConversations,
      }[tab];

      setSection(await fetcher(childId ?? selected));

      // Also fetch fee reminders when on the fees tab
      if (tab === "fees") {
        try {
          const remindersRes = await PortalService.fetchFeeReminders(childId ?? selected);
          setFeeReminders(remindersRes.data);
        } catch {
          setFeeReminders(null);
        }
      }
    } catch (err) {
      if (!(await handle401(err))) setSection(null);
    } finally {
      setLoading(false);
    }
  }, [tab, childId, handle401]);

  useEffect(() => {
    if (signedIn) loadAll();
  }, [signedIn, loadAll]);

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
      const html = await PortalService.fetchReceiptHtml(paymentId, language ?? "en");
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
      const card = await PortalService.fetchReportCardHtml(summary._id);
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
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.loginBody} keyboardShouldPersistTaps="handled">
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

  const data  = section?.data;
  const stale = section?.stale;

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {me?.student?.name || t("portal.title")}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {me?.student?.enrollmentNo}
            {me?.student?.className ? ` · ${me.student.className}` : ""}
          </Text>
        </View>
        <TouchableOpacity onPress={leave} hitSlop={10}>
          <Ionicons name="log-out-outline" size={22} color={C.inkBody} />
        </TouchableOpacity>
      </View>

      {/* Child switcher — only when there is a choice to make. A parent with
          one child should not be shown a control with one option. */}
      {(me?.children?.length ?? 0) > 1 && (
        <View style={styles.childBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.childRow}>
            {me.children.map((c) => {
              const on = (childId ?? me.selectedId) === c._id;
              return (
                <TouchableOpacity
                  key={c._id}
                  style={[styles.childChip, on && styles.childChipOn]}
                  onPress={() => setChildId(c._id)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.childChipText, on && styles.childChipTextOn]}
                        numberOfLines={1}>
                    {c.name || c.enrollmentNo}
                  </Text>
                  {c.className ? (
                    <Text style={[styles.childChipMeta, on && styles.childChipTextOn]}
                          numberOfLines={1}>
                      {c.className}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.tabs}>
        {TABS.map((key) => (
          <TouchableOpacity
            key={key}
            style={[styles.tab, tab === key && styles.tabOn]}
            onPress={() => setTab(key)}
            activeOpacity={0.8}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextOn]}>
              {t(`portal.${key}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

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
              {section?.fetchedAt
                ? t("payroll.lastUpdated", { date: formatDateShort(section.fetchedAt) })
                : t("exp.onlineOnly")}
            </Text>
          </View>
        )}

        {loading && !data ? (
          <ActivityIndicator color={C.primary} style={{ marginTop: 24 }} />
        ) : (
          <>
            {/* ── Fees ── */}
            {tab === "fees" && data && (
              <>
                <View style={[
                  styles.balanceCard,
                  (data.totals?.balance ?? 0) > 0 ? styles.owes : styles.clear,
                ]}>
                  <Text style={styles.balanceLabel}>
                    {(data.totals?.balance ?? 0) > 0 ? t("portal.balance") : t("portal.settled")}
                  </Text>
                  <Text style={[
                    styles.balanceValue,
                    { color: (data.totals?.balance ?? 0) > 0 ? C.danger : C.success },
                  ]}>
                    {formatMoney(data.totals?.balance ?? 0)}
                  </Text>
                  <View style={styles.balanceRow}>
                    <Text style={styles.balanceMeta}>
                      {t("portal.charged")} {formatMoney(data.totals?.charged ?? 0)}
                    </Text>
                    <Text style={styles.balanceMeta}>
                      {t("portal.paid")} {formatMoney(data.totals?.paid ?? 0)}
                    </Text>
                  </View>
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{t("fees.payments")}</Text>
                  {(data.payments?.length ?? 0) === 0 ? (
                    <Text style={styles.empty}>{t("portal.noPayments")}</Text>
                  ) : (
                    data.payments.map((p) => (
                      <View key={p._id} style={styles.line}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.lineLabel} numberOfLines={1}>
                            {p.receiptNo || "—"}
                            {p.isReversal ? ` · ${t("portal.reversalNote")}` : ""}
                          </Text>
                          <Text style={styles.lineMeta}>{formatDateShort(p.receivedAt)}</Text>
                        </View>
                        <Text style={[
                          styles.lineAmount, p.amount < 0 && { color: C.danger },
                        ]}>
                          {formatMoney(p.amount)}
                        </Text>
                        <TouchableOpacity onPress={() => printReceipt(p._id)} hitSlop={8}>
                          {printing === p._id
                            ? <ActivityIndicator color={C.primary} size="small" />
                            : <Ionicons name="print-outline" size={18} color={C.primary} />}
                        </TouchableOpacity>
                      </View>
                    ))
                  )}
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{t("fees.charges")}</Text>
                  {(data.charges?.length ?? 0) === 0 ? (
                    <Text style={styles.empty}>{t("portal.noCharges")}</Text>
                  ) : (
                    data.charges.map((c) => (
                      <View key={c._id} style={styles.line}>
                        <Text style={styles.lineLabel} numberOfLines={1}>
                          {c.label || c.code}
                        </Text>
                        <Text style={styles.lineAmount}>{formatMoney(c.amount)}</Text>
                      </View>
                    ))
                  )}
                </View>

                {/* Fee Reminders */}
                {feeReminders?.reminders?.length > 0 && (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t("portal.feeReminders", "Fee Reminders")}</Text>
                    <Text style={styles.cardHint}>{t("portal.feeRemindersHint", "What you owe and when it's due")}</Text>
                    {feeReminders.reminders.map((r) => (
                      <View key={r.chargeId} style={styles.line}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.lineLabel} numberOfLines={1}>
                            {r.label || r.code}
                          </Text>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                            <Text style={[
                              styles.lineMeta,
                              r.isOverdue && { color: C.danger, fontWeight: "700" },
                            ]}>
                              {t("portal.dueBy", "Due by")} {formatDateShort(r.dueDate)}
                            </Text>
                            {r.isOverdue && (
                              <View style={[styles.badge, { backgroundColor: C.dangerBg }]}>
                                <Text style={[styles.badgeText, { color: C.danger }]}>
                                  {t("portal.overdue", "Overdue")} · {r.daysOverdue}d
                                </Text>
                              </View>
                            )}
                            {r.isDueSoon && !r.isOverdue && (
                              <View style={[styles.badge, { backgroundColor: C.warningBg }]}>
                                <Text style={[styles.badgeText, { color: C.warning }]}>
                                  {t("portal.dueSoon", "Due soon")}
                                </Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <Text style={styles.lineAmount}>{formatMoney(r.netAmount)}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Payment Plan */}
                {feeReminders?.hasPlan && feeReminders.plan && (
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t("portal.paymentPlan", "Payment Plan")}</Text>
                    {feeReminders.plan.reason && (
                      <Text style={styles.cardHint}>{feeReminders.plan.reason}</Text>
                    )}
                    {feeReminders.plan.instalments?.map((inst) => {
                      const isPast = new Date(inst.dueDate) < new Date();
                      return (
                        <View key={inst.seq} style={styles.line}>
                          <Text style={[styles.lineLabel, isPast && { textDecorationLine: "line-through", color: C.inkMuted }]}>
                            {t("portal.instalment", "Instalment")} {inst.seq} — {formatDateShort(inst.dueDate)}
                          </Text>
                          <Text style={styles.lineAmount}>{formatMoney(inst.amount)}</Text>
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            )}

            {/* ── Results — mirrors the issued report card ── */}
            {tab === "results" && (
              (data?.length ?? 0) === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.empty}>{t("portal.noResults")}</Text>
                </View>
              ) : (
                groupResultsByYear(data).map((group) => (
                  <View key={group.year} style={{ marginBottom: 4 }}>
                    <View style={styles.yearHeader}>
                      <Ionicons name="school-outline" size={15} color={C.primary} />
                      <Text style={styles.yearHeaderText}>{group.year}</Text>
                      <Text style={styles.yearHeaderCount}>
                        {t("portal.resultsCount", { count: group.items.length })}
                      </Text>
                    </View>

                    {group.items.map((r) => (
                      <View key={r._id} style={styles.card}>
                        <View style={styles.resultHead}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.cardTitle}>
                              {r.term || "—"} · {r.className || ""}
                            </Text>
                            <Text style={styles.lineMeta}>
                              {r.subjectsTotal
                                ? t("portal.subjectsSummary", {
                                    passed: r.subjectsPassed ?? 0,
                                    failed: r.subjectsFailed ?? 0,
                                  })
                                : ""}
                            </Text>
                          </View>
                          <View style={{ alignItems: "flex-end" }}>
                            {/* The figure was rendered bare, which left a
                                parent looking at "14" with nothing saying what
                                it was — and no way to tell 14/20 from 14%. The
                                label and the denominator are the whole point of
                                the number. */}
                            <Text style={styles.averageLabel}>
                              {t("portal.average")}
                            </Text>
                            <Text style={styles.average}>
                              {trimMark(r.average)}
                              <Text style={styles.averageOutOf}> / 20</Text>
                            </Text>
                            {r.classPosition && (
                              <Text style={styles.lineMeta}>
                                {t("portal.position")} {r.classPosition}
                                {r.totalInClass ? ` / ${r.totalInClass}` : ""}
                              </Text>
                            )}
                          </View>
                        </View>

                        {r.overallGrade && (
                          <View
                            style={[
                              styles.gradeChip,
                              r.isPassing
                                ? { backgroundColor: C.successBg }
                                : { backgroundColor: C.dangerBg },
                            ]}
                          >
                            <Text
                              style={[
                                styles.gradeChipText,
                                { color: r.isPassing ? C.success : C.danger },
                              ]}
                            >
                              {t("portal.overallGrade")}: {r.overallGrade}
                              {r.gpa != null ? ` · GPA ${trimMark(r.gpa)}` : ""}
                            </Text>
                          </View>
                        )}

                        {r.subjects?.map((s, i) => (
                          <View key={i} style={styles.subjectRow}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={styles.lineLabel} numberOfLines={1}>
                                {s.subjectName || "—"}
                              </Text>
                              <Text style={styles.subjectMeta} numberOfLines={2}>
                                {s.isAbsent
                                  ? "Absent"
                                  : `${trimMark(s.score)}${s.maxScore ? `/${s.maxScore}` : ""}`}
                                {s.coefficient
                                  ? ` · ${t("portal.coefficient")} ${s.coefficient}`
                                  : ""}
                                {!s.isAbsent && s.remark
                                  ? ` · ${s.remark}`
                                  : ""}
                              </Text>
                            </View>
                            <View style={{ alignItems: "flex-end" }}>
                              <Text style={styles.subjectMark}>
                                {s.isAbsent ? "—" : trimMark(s.normalizedMark)}
                                <Text style={styles.subjectMarkScale}>/20</Text>
                              </Text>
                            </View>
                            <View
                              style={[
                                styles.subjectGrade,
                                s.isAbsent
                                  ? { backgroundColor: C.warningBg }
                                  : s.isPassing
                                    ? { backgroundColor: C.successBg }
                                    : { backgroundColor: C.dangerBg },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.gradeChipText,
                                  {
                                    color: s.isAbsent
                                      ? C.warning
                                      : s.isPassing ? C.success : C.danger,
                                  },
                                ]}
                              >
                                {s.isAbsent ? "ABS" : (s.grade || "—")}
                              </Text>
                            </View>
                          </View>
                        ))}

                        {r.principalRemark && (
                          <View style={styles.resultFooter}>
                            <Text style={styles.cardHint}>
                              {t("portal.principalRemark")}
                            </Text>
                            <Text style={styles.remarkText}>
                              {r.principalRemark}
                            </Text>
                          </View>
                        )}

                        <TouchableOpacity
                          style={styles.reportCardBtn}
                          activeOpacity={0.8}
                          onPress={() => openReportCard(r)}
                        >
                          {printing === `card-${r._id}` ? (
                            <ActivityIndicator size="small" color={C.primary} />
                          ) : (
                            <Ionicons name="document-text-outline" size={16} color={C.primary} />
                          )}
                          <Text style={styles.reportCardBtnText}>
                            {t("portal.viewReportCard")}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                ))
              )
            )}

            {/* ── Attendance — rate, status counts and recent days ── */}
            {tab === "attendance" && (
              (data?.total ?? 0) === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.empty}>{t("portal.noAttendance")}</Text>
                </View>
              ) : (
                <>
                  <View style={styles.card}>
                    <Text style={styles.balanceLabel}>{t("portal.attendanceRate")}</Text>
                    <Text style={[styles.balanceValue, { color: C.ink }]}>{data.rate}%</Text>
                    <Text style={styles.lineMeta}>
                      {t("portal.daysRecorded", { count: data.total })}
                    </Text>
                  </View>

                  <View style={styles.attdCounts}>
                    {["present", "absent", "late", "excused"].map((key) => (
                      <View key={key} style={styles.attdCell}>
                        <Text style={styles.attdCellValue}>
                          {data.tally?.[key] ?? 0}
                        </Text>
                        <Text style={styles.attdCellLabel}>{t(`portal.${key}`)}</Text>
                      </View>
                    ))}
                  </View>

                  {(data.dailySummaries?.length ?? 0) > 0 && (
                    <View style={styles.card}>
                      <Text style={styles.cardTitle}>{t("portal.recentDays")}</Text>
                      {data.dailySummaries.slice(0, 14).map((day) => (
                        <View key={day.date} style={styles.recentDayRow}>
                          <View
                            style={[
                              styles.recentDayDot,
                              {
                                backgroundColor:
                                  day.status?.toLowerCase().includes("absent")
                                    ? C.danger
                                    : day.status?.toLowerCase().includes("late")
                                      ? C.warning
                                      : C.success,
                              },
                            ]}
                          />
                          <Text style={styles.lineLabel} numberOfLines={1}>
                            {formatDateShort(day.date)}
                          </Text>
                          <Text style={styles.recentDayStatus}>
                            {t(ATTD_STATUS_KEY[day.status] ?? "portal.present")}
                          </Text>
                          <Text style={styles.recentDayMeta}>
                            {day.present}P{day.absent ? ` · ${day.absent}A` : ""}
                            {day.late ? ` · ${day.late}L` : ""}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )
            )}

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
                          {c.title ||
                            (c.otherParticipants || c.participants || [])
                              .map((p) => p.name)
                              .filter(Boolean)
                              .join(", ") ||
                            t("msgMobile.conversation")}
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
            {tab === "notices" && (
              (data?.length ?? 0) === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.empty}>{t("portal.noNotices")}</Text>
                </View>
              ) : (
                data.map((n) => {
                  const meta = NOTICE_META[n.kind] ?? NOTICE_META.default;
                  return (
                    <View key={n._id} style={styles.card}>
                      <View style={styles.noticeHead}>
                        <View style={[styles.noticeIcon, { backgroundColor: meta.bg }]}>
                          <Ionicons name={meta.icon} size={14} color={meta.fg} />
                        </View>
                        <Text style={styles.noticeKind} numberOfLines={1}>
                          {t(meta.labelKey)}
                        </Text>
                        <Text style={styles.lineMeta}>
                          {formatDateShort(n.sentAt || n.createdAt)}
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
                          not told. */}
                      {n.status && n.status !== "sent" ? (
                        <Text style={styles.noticePending}>
                          {t(`portal.noticeStatus_${n.status}`)}
                        </Text>
                      ) : null}
                    </View>
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
                data.map((a) => (
                  <View key={a._id} style={styles.card}>
                    <Text style={styles.cardTitle}>{a.title || "—"}</Text>
                    <Text style={styles.lineMeta}>{formatDateShort(a.createdAt)}</Text>
                    {a.body ? <Text style={styles.newsBody}>{a.body}</Text> : null}
                  </View>
                ))
              )
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.canvas },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },

  loginBody:  { padding: 20, gap: 10, paddingTop: 40 },
  loginTitle: { fontSize: 24, fontWeight: "700", color: C.ink, marginTop: 12 },
  loginIntro: { fontSize: 13, color: C.inkMuted, marginBottom: 10 },

  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  title:    { fontSize: 16, fontWeight: "700", color: C.ink },
  subtitle: { marginTop: 1, fontSize: 11, color: C.inkMuted },

  childBar: {
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  childRow:  { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  childChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 9,
    borderWidth: 1, borderColor: "#D5D9E2", backgroundColor: C.surface,
    minWidth: 96,
  },
  childChipOn:      { backgroundColor: C.primary, borderColor: C.primary },
  childChipText:    { fontSize: 13, fontWeight: "600", color: C.inkBody },
  childChipMeta:    { fontSize: 10, color: C.inkFaint, marginTop: 1 },
  childChipTextOn:  { color: "#fff" },

  tabs: {
    flexDirection: "row", backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  tab:       { flex: 1, paddingVertical: 11, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn:     { borderBottomColor: C.primary },
  tabText:   { fontSize: 12, fontWeight: "600", color: C.inkMuted },
  tabTextOn: { color: C.primary },

  body: { padding: 16, gap: 12, paddingBottom: 40 },

  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.warningBg, borderWidth: 1, borderColor: "#F0DCBB",
  },
  bannerText: { flex: 1, fontSize: 12, color: C.warning, fontWeight: "500" },

  balanceCard:  { borderRadius: 12, borderWidth: 1, padding: 16 },
  owes:         { backgroundColor: C.dangerBg,  borderColor: "#F2D3CF" },
  clear:        { backgroundColor: C.successBg, borderColor: "#C3E2D0" },
  balanceLabel: { fontSize: 11, fontWeight: "600", color: C.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
  balanceValue: { marginTop: 6, fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  balanceRow:   { flexDirection: "row", gap: 16, marginTop: 8 },
  balanceMeta:  { fontSize: 11, color: C.inkMuted, fontVariant: ["tabular-nums"] },

  card: {
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 1, borderColor: C.line, padding: 14,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: C.ink },
  cardHint:  { fontSize: 11, color: C.inkFaint, marginTop: 2, marginBottom: 8 },
  badge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  badgeText: { fontSize: 10, fontWeight: "700" },

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
  lineLabel:  { flex: 1, fontSize: 13, color: C.inkBody },
  lineMeta:   { marginTop: 2, fontSize: 11, color: C.inkFaint },
  lineAmount: { fontSize: 13, fontWeight: "600", color: C.ink, fontVariant: ["tabular-nums"] },
  grade:      { fontSize: 12, fontWeight: "700", width: 28, textAlign: "right" },

  resultHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 6 },
  noticeHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  noticeIcon: {
    width: 24, height: 24, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  noticeKind: { flex: 1, fontSize: 12, fontWeight: "700", color: C.inkBody },
  noticePending: { marginTop: 6, fontSize: 11, fontWeight: "600", color: C.warning },

  averageLabel: {
    fontSize:      10,
    fontWeight:    "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color:         C.inkFaint ?? "#9CA3AF",
    marginBottom:  1,
  },
  average:    { fontSize: 18, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  // The denominator rides inside the figure so it wraps with it and stays
  // visually subordinate — the mark is what a parent reads first.
  averageOutOf: { fontSize: 11, fontWeight: "600", color: C.inkFaint ?? "#9CA3AF" },

  newsBody: { marginTop: 8, fontSize: 13, color: C.inkBody, lineHeight: 19 },
  empty:    { fontSize: 12, color: C.inkFaint, paddingVertical: 8 },

  // ── Results — report-card mirror ──────────────────────────────────────────
  yearHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10,
    backgroundColor: C.primaryBg, borderRadius: 10,
  },
  yearHeaderText:  { flex: 1, fontSize: 14, fontWeight: "700", color: C.ink },
  yearHeaderCount: { fontSize: 11, fontWeight: "600", color: C.inkMuted },

  gradeChip: {
    alignSelf: "flex-start", marginBottom: 6,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
  },
  gradeChipText: { fontSize: 11, fontWeight: "700" },

  subjectRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  subjectMeta:      { fontSize: 10, color: C.inkFaint, marginTop: 2, lineHeight: 14 },
  subjectMark:      { fontSize: 14, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  subjectMarkScale: { fontSize: 9, color: C.inkFaint },
  subjectGrade: {
    minWidth: 30, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 11,
    fontSize: 11, fontWeight: "700", textAlign: "center", overflow: "hidden",
  },
  resultFooter:  { marginTop: 6 },
  remarkText:    { fontSize: 11, color: C.inkMuted, fontStyle: "italic", marginTop: 2, lineHeight: 15 },
  reportCardBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginTop: 8, paddingVertical: 9, borderRadius: 9,
    borderWidth: 1, borderColor: C.primary, backgroundColor: C.primaryBg,
  },
  reportCardBtnText: { fontSize: 12, fontWeight: "700", color: C.primary },

  // ── Attendance breakdown ──────────────────────────────────────────────────
  attdCounts: { flexDirection: "row", gap: 8, marginTop: 12 },
  attdCell: {
    flex: 1, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface,
    borderRadius: 9, paddingVertical: 8, alignItems: "center",
  },
  attdCellValue: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  attdCellLabel: { fontSize: 10, color: C.inkFaint, marginTop: 2 },

  recentDayRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  recentDayDot:    { width: 8, height: 8, borderRadius: 4 },
  recentDayMeta:   { fontSize: 10, color: C.inkFaint, fontVariant: ["tabular-nums"] },
  recentDayStatus: { fontSize: 11, fontWeight: "600" },

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
});
