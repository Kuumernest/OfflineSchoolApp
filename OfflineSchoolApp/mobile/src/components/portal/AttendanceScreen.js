// src/components/portal/AttendanceScreen.js
//
// Attendance for the selected child, a month at a time: the month's rate as
// the server gives it (the figure Home shows), the school days on a calendar,
// each day with its gate times, and the month by subject. The phone's copy of
// web/src/pages/portal/AttendanceScreen.tsx.
//
// A day's mark on the calendar is read from that day's own counts — all
// absent, some absent, late without absence, excused, present — so a late
// arrival reads as late, with an icon as well as a colour.
//
// A school that scans at the gate but keeps no period register still has
// days to show: their times, without a register mark.

import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { formatDate, formatTime, formatMonth } from "../../i18n/format";
import { Card, CardTitle, Skeleton, EmptyState, said } from "./ui";
import { C, TAP } from "./theme";

const STATE = {
  present: { icon: "checkmark",           fg: C.success, bg: C.successBg, line: C.successLine },
  absent:  { icon: "close",               fg: C.danger,  bg: C.dangerBg,  line: C.dangerLine },
  late:    { icon: "time-outline",        fg: C.warning, bg: C.warningBg, line: C.warningLine },
  partial: { icon: "ellipse-outline",     fg: C.warning, bg: C.warningBg, line: C.warningLine },
  excused: { icon: "shield-checkmark-outline", fg: C.primary, bg: C.primaryBg, line: C.primaryLine },
};

const stateOf = (d) =>
  d.total > 0 && d.absent === d.total ? "absent"
    : d.absent > 0 ? "partial"
    : d.late > 0 ? "late"
    : d.total > 0 && d.excused === d.total ? "excused"
    : "present";

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** The first and last day of a "YYYY-MM" month, as the server's from/to. */
export const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: `${month}-${pad(new Date(y, m, 0).getDate())}` };
};

/** A month moved by `by` (−1 earlier, +1 later). */
export const shiftMonth = (month, by) => {
  const [y, m] = month.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + by, 1));
};

export default function AttendanceScreen({ data, loading, month, onMonth }) {
  const { t } = useTranslation();
  const thisMonth = monthKey(new Date());
  const today = dayKey(new Date());
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const label = formatMonth(month);

  const byDate = useMemo(() => new Map((data?.dailySummaries ?? []).map((d) => [d.date, d])), [data]);

  // Every day with something to say, newest first: a register mark, gate
  // times, or both. Gate times come with the day's summary when the school
  // keeps both, and from the gate list when it only scans.
  const days = useMemo(() => {
    const out = new Map();
    for (const d of data?.dailySummaries ?? []) out.set(d.date, { date: d.date, summary: d, arrivedAt: d.arrivedAt, departedAt: d.departedAt });
    for (const g of data?.gate ?? []) {
      if (!String(g.date).startsWith(month)) continue;
      const row = out.get(g.date) ?? { date: g.date };
      out.set(g.date, { ...row, arrivedAt: row.arrivedAt ?? g.arrivedAt, departedAt: row.departedAt ?? g.departedAt });
    }
    return [...out.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [data, month]);

  // Mon–Fri rows for the month; weekends are not school days.
  const weeks = useMemo(() => {
    const rows = [];
    let row = [null, null, null, null, null];
    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) continue;
      row[dow - 1] = `${month}-${pad(d)}`;
      if (dow === 5) { rows.push(row); row = [null, null, null, null, null]; }
    }
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }, [month, y, m, lastDay]);

  const weekdays = t("portal.attendanceScreen.weekdays");
  const hasRegister = (data?.total ?? 0) > 0;

  return (
    <View style={s.stack}>
      <View style={s.titleRow}>
        <Text style={s.h1} accessibilityRole="header">{t("portal.attendanceScreen.title")}</Text>
        <View style={s.monthNav}>
          <Pressable onPress={() => onMonth(shiftMonth(month, -1))} accessibilityRole="button"
            accessibilityLabel={t("portal.attendanceScreen.prevMonth")} style={s.navBtn} testID="portal-month-prev">
            <Ionicons name="chevron-back" size={22} color={C.inkBody} />
          </Pressable>
          <Text style={s.monthLabel} accessibilityLiveRegion="polite">{label}</Text>
          <Pressable onPress={() => onMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} accessibilityRole="button"
            accessibilityState={{ disabled: month >= thisMonth }}
            accessibilityLabel={t("portal.attendanceScreen.nextMonth")} style={[s.navBtn, month >= thisMonth && { opacity: 0.3 }]}>
            <Ionicons name="chevron-forward" size={22} color={C.inkBody} />
          </Pressable>
        </View>
      </View>

      {loading && !data ? (
        <View style={s.stack}>
          <Skeleton height={150} radius={14} />
          <Skeleton height={280} radius={14} />
        </View>
      ) : null}

      {data && !hasRegister && days.length === 0 ? (
        <Card>
          <EmptyState icon="calendar-outline"
            title={t("portal.attendanceScreen.empty", { month: label })} hint={t("portal.attendanceScreen.emptyHint")} />
        </Card>
      ) : null}

      {data && hasRegister ? (
        <>
          <Card style={s.pad}>
            <View style={s.rateRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.kicker}>{t("portal.attendanceScreen.rate")}</Text>
                <Text style={s.rate}>{data.rate == null ? "–" : `${data.rate}%`}</Text>
                <Text style={s.faint}>{t("portal.attendanceScreen.rateHint")}</Text>
              </View>
              <Text style={s.marked}>{t("portal.attendanceScreen.marked", { count: data.total })}</Text>
            </View>
            <View style={s.tally}>
              {["present", "absent", "late", "excused"].map((k) => (
                <View key={k} style={[s.tallyCell, { backgroundColor: STATE[k].bg, borderColor: STATE[k].line }]}
                  accessible accessibilityLabel={said(t(`portal.attendanceScreen.${k}`), data.tally?.[k] ?? 0)}>
                  <View style={s.tallyHead}>
                    <Ionicons name={STATE[k].icon} size={12} color={STATE[k].fg} />
                    <Text style={[s.tallyLabel, { color: STATE[k].fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                      {t(`portal.attendanceScreen.${k}`)}
                    </Text>
                  </View>
                  <Text style={[s.tallyValue, { color: STATE[k].fg }]}>{data.tally?.[k] ?? 0}</Text>
                </View>
              ))}
            </View>
          </Card>

          <Card style={s.pad}>
            <CardTitle style={{ marginBottom: 12 }}>{t("portal.attendanceScreen.calendar")}</CardTitle>
            <View style={s.calRow}>
              {(Array.isArray(weekdays) ? weekdays : []).map((w) => (
                <Text key={w} style={s.weekday}>{w}</Text>
              ))}
            </View>
            {weeks.map((week, wi) => (
              <View key={wi} style={s.calRow}>
                {week.map((date, di) => {
                  if (!date) return <View key={`b${di}`} style={s.cellBlank} />;
                  const d = byDate.get(date);
                  const st = d ? stateOf(d) : null;
                  const future = date > today;
                  return (
                    <View
                      key={date}
                      accessible
                      accessibilityLabel={said(formatDate(date), st ? t(`portal.attendanceScreen.${st}`) : t("portal.attendanceScreen.noRecord"))}
                      style={[
                        s.cell,
                        st ? { backgroundColor: STATE[st].bg } : { backgroundColor: future ? "transparent" : C.canvas },
                        date === today && s.cellToday,
                      ]}
                    >
                      <Text style={[s.cellDay, { color: st ? STATE[st].fg : future ? C.lineStrong : C.inkFaint }]}>
                        {Number(date.slice(8))}
                      </Text>
                      {st ? <Ionicons name={STATE[st].icon} size={12} color={STATE[st].fg} /> : null}
                    </View>
                  );
                })}
              </View>
            ))}
            <View style={s.legend}>
              {["present", "late", "partial", "absent", "excused"].map((k) => (
                <View key={k} style={s.legendItem}>
                  <View style={[s.legendSwatch, { backgroundColor: STATE[k].bg }]}>
                    <Ionicons name={STATE[k].icon} size={11} color={STATE[k].fg} />
                  </View>
                  <Text style={s.legendText}>{t(`portal.attendanceScreen.${k}`)}</Text>
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : null}

      {data && days.length > 0 ? (
        <Card>
          <View style={s.listHead}><CardTitle>{t("portal.attendanceScreen.days")}</CardTitle></View>
          {days.map((d) => {
            const st = d.summary ? stateOf(d.summary) : null;
            return (
              <View key={d.date} style={s.dayRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.dayDate}>{formatDate(d.date)}</Text>
                  {d.arrivedAt || d.departedAt ? (
                    <Text style={s.faint}>
                      {d.arrivedAt ? t("portal.attendanceScreen.arrived", { time: formatTime(d.arrivedAt) }) : ""}
                      {d.arrivedAt && d.departedAt ? " · " : ""}
                      {d.departedAt ? t("portal.attendanceScreen.left", { time: formatTime(d.departedAt) }) : ""}
                    </Text>
                  ) : null}
                </View>
                {st ? (
                  <View style={[s.chip, { backgroundColor: STATE[st].bg, borderColor: STATE[st].line }]}>
                    <Ionicons name={STATE[st].icon} size={13} color={STATE[st].fg} />
                    <Text style={[s.chipText, { color: STATE[st].fg }]}>{t(`portal.attendanceScreen.${st}`)}</Text>
                  </View>
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}

      {data && (data.subjectSummary?.filter((x) => x.subjectId).length ?? 0) > 0 ? (
        <Card style={s.pad}>
          <CardTitle style={{ marginBottom: 12 }}>{t("portal.attendanceScreen.bySubject")}</CardTitle>
          {data.subjectSummary.filter((x) => x.subjectId).map((x) => {
            const pct = x.total ? Math.round((x.present / x.total) * 100) : 0;
            return (
              <View key={x.subjectId} style={{ marginBottom: 12 }}>
                <View style={s.subjRow}>
                  <Text style={s.subjName}>{x.subjectName ?? t("portal.general")}</Text>
                  <Text style={s.subjCount}>{x.present}/{x.total}</Text>
                </View>
                <View style={s.bar}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
              </View>
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 14 },
  pad:   { padding: 16 },
  h1:    { fontSize: 22, fontWeight: "700", color: C.ink },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  monthNav: { flexDirection: "row", alignItems: "center" },
  navBtn:   { width: TAP, height: TAP, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  monthLabel: { minWidth: 120, textAlign: "center", fontSize: 14, fontWeight: "700", color: C.ink, textTransform: "capitalize" },

  kicker:  { fontSize: 13, fontWeight: "600", color: C.inkMuted },
  rateRow: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  rate:    { fontSize: 36, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  marked:  { fontSize: 13, color: C.inkBody, textAlign: "right" },
  faint:   { marginTop: 2, fontSize: 12, color: C.inkMuted },

  tally:      { flexDirection: "row", gap: 6, marginTop: 14 },
  tallyCell:  { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 4, alignItems: "center" },
  tallyHead:  { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: "100%" },
  tallyLabel: { flexShrink: 1, fontSize: 11, fontWeight: "600" },
  tallyValue: { marginTop: 2, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },

  calRow:    { flexDirection: "row", gap: 6, marginBottom: 6 },
  weekday:   { flex: 1, textAlign: "center", fontSize: 11, fontWeight: "600", color: C.inkMuted },
  cellBlank: { flex: 1 },
  cell: {
    flex: 1, aspectRatio: 1, minHeight: TAP, borderRadius: 10,
    alignItems: "center", justifyContent: "center", gap: 1,
  },
  cellToday: { borderWidth: 2, borderColor: C.primary },
  cellDay:   { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  legend:     { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendSwatch: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  legendText: { fontSize: 12, color: C.inkBody },

  listHead: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  dayRow: {
    flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56,
    paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line,
  },
  dayDate:  { fontSize: 14, fontWeight: "600", color: C.ink },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1,
  },
  chipText: { fontSize: 12, fontWeight: "700" },

  subjRow:   { flexDirection: "row", justifyContent: "space-between" },
  subjName:  { fontSize: 14, color: C.ink },
  subjCount: { fontSize: 14, color: C.inkBody, fontVariant: ["tabular-nums"] },
  bar:       { marginTop: 6, height: 8, borderRadius: 4, backgroundColor: C.line, overflow: "hidden" },
  barFill:   { height: "100%", borderRadius: 4, backgroundColor: C.primary },
});
