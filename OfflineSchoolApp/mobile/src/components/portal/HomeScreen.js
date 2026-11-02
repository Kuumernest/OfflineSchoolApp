// src/components/portal/HomeScreen.js
//
// Home: one card per child, from one request (GET /portal/home). A parent can
// have several children at the school, and this is the screen that shows them
// side by side. Each figure is read as the screen it leads to reads it, so
// the card never disagrees with the page behind it. The phone's copy of
// web/src/pages/portal/HomeScreen.tsx.

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTranslation } from "../../i18n/useTranslation";
import { formatMoney, formatDate } from "../../i18n/format";
import { Card, Skeleton, EmptyState, ChildAvatar } from "./ui";
import { C, TAP, ordinal, on20 } from "./theme";
import { TILE, TILE_SHAPE, PALETTE } from "../../theme/colors";

export default function HomeScreen({ data, loading, onOpen }) {
  const { t } = useTranslation();

  return (
    <View style={s.stack}>
      <View>
        <Text style={s.h1} accessibilityRole="header">{t("portal.home.title")}</Text>
        <Text style={s.sub}>{t("portal.home.subtitle")}</Text>
      </View>

      {loading && !data ? <HomeSkeleton /> : null}

      {data && (data.children?.length ?? 0) === 0 ? (
        <Card><EmptyState icon="people-outline" title={t("portal.home.empty")} hint={t("portal.home.emptyHint")} /></Card>
      ) : null}

      {(data?.children ?? []).map((child, i) => (
        <ChildCard key={child._id} child={child} index={i} onOpen={onOpen} />
      ))}

      {data?.latestNews ? (
        <Card style={s.newsCard}>
          <View style={s.newsRow}>
            <View style={s.newsIcon}><Ionicons name="megaphone-outline" size={20} color={C.primary} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.kicker}>{t("portal.home.latestNews")}</Text>
              <Text style={s.newsTitle}>{data.latestNews.title}</Text>
              {data.latestNews.body ? <Text style={s.newsBody} numberOfLines={2}>{data.latestNews.body}</Text> : null}
              <Text style={s.faint}>{formatDate(data.latestNews.createdAt)}</Text>
            </View>
          </View>
          <Pressable onPress={() => onOpen(null, "messages", "news")} accessibilityRole="button" style={s.seeAll}>
            <Text style={s.seeAllText}>{t("portal.home.seeAll")}</Text>
            <Ionicons name="chevron-forward" size={16} color={C.primary} />
          </Pressable>
        </Card>
      ) : null}
    </View>
  );
}

function ChildCard({ child, index, onOpen }) {
  const { t, language } = useTranslation();
  const latest = child.latest;
  const delta = latest?.average != null && latest.previousAverage != null
    ? Math.round((latest.average - latest.previousAverage) * 100) / 100 : null;
  const att  = child.attendance ?? {};
  const fees = child.fees;
  // Text on a tile takes that tile's ink: cream on the dark fills, warm ink on mustard.
  const ink = (kind) => ({ color: TILE[kind].fg });

  return (
    <Card>
      <View style={s.childHead}>
        <ChildAvatar name={child.name} index={index} size={48} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.childName} numberOfLines={1} accessibilityRole="header">{child.name ?? child.enrollmentNo}</Text>
          <View style={s.childMeta}>
            {child.className ? <Text style={s.classPill}>{child.className}</Text> : null}
            {child.enrollmentNo ? <Text style={s.faint}>{child.enrollmentNo}</Text> : null}
          </View>
        </View>
      </View>

      <View style={s.grid}>
        <Tile kind="results" icon="school-outline" label={t("portal.home.latestResult")} onPress={() => onOpen(child._id, "results")} testID={`portal-home-results-${index}`}>
          {latest?.average != null ? (
            <>
              <Text style={[s.big, ink("results")]}>{on20(latest.average, language)}<Text style={[s.outOf, ink("results")]}>/20</Text></Text>
              {latest.position != null && latest.outOf != null ? (
                <Text style={[s.body, ink("results")]}>{t("portal.home.rank", { position: ordinal(latest.position, language), outOf: latest.outOf })}</Text>
              ) : null}
              {latest.examName ? <Text style={[s.faint, ink("results")]}>{latest.examName}</Text> : null}
              {delta != null && latest.previousExamName ? <Change delta={delta} exam={latest.previousExamName} /> : null}
            </>
          ) : <Text style={[s.muted, ink("results")]}>{t("portal.home.noResults")}</Text>}
        </Tile>

        {/* Under 90% used to turn the figure amber; on a coloured tile that
            would not read, so the tile carries the alert dot instead. */}
        <Tile kind="attendance" icon="calendar-outline" label={t("portal.home.attendanceMonth")} onPress={() => onOpen(child._id, "attendance")}
          alert={att.rate != null && att.rate < 90}>
          {att.rate != null ? (
            <>
              <Text style={[s.big, ink("attendance")]}>{att.rate}%</Text>
              <Text style={[s.body, ink("attendance")]}>{t("portal.home.daysPresent", { present: att.present, marked: att.marked })}</Text>
            </>
          ) : <Text style={[s.muted, ink("attendance")]}>{t("portal.home.noRegister")}</Text>}
        </Tile>

        <Tile kind="fees" icon="wallet-outline" label={t("portal.home.balance")} onPress={() => onOpen(child._id, "fees")}
          alert={Boolean(fees?.isOverdue)}>
          {fees == null ? <Skeleton width={96} height={24} /> : fees.balance > 0 ? (
            <>
              <Text style={[s.money, ink("fees")]} numberOfLines={1} adjustsFontSizeToFit>
                {formatMoney(fees.balance)}
              </Text>
              {fees.isOverdue ? (
                <Text style={[s.pill, s.pillDanger]}>{t("portal.home.overdue")}</Text>
              ) : fees.dueDate ? (
                <Text style={[s.body, ink("fees")]}>{t("portal.home.dueOn", { date: formatDate(fees.dueDate) })}</Text>
              ) : null}
            </>
          ) : <Text style={[s.pill, s.pillSuccess]}>{t("portal.home.paidUp")}</Text>}
        </Tile>

        <Tile kind="exams" icon="time-outline" label={t("portal.home.nextExam")}>
          {child.nextExam ? (
            <>
              <Text style={[s.examName, ink("exams")]}>{child.nextExam.name}</Text>
              <Text style={[s.body, ink("exams")]}>{t("portal.home.startsOn", { date: formatDate(child.nextExam.startDate) })}</Text>
            </>
          ) : <Text style={[s.muted, ink("exams")]}>{t("portal.home.noExam")}</Text>}
        </Tile>
      </View>
    </Card>
  );
}

/**
 * One figure on a child's card, on its kind's colour (src/theme/colors.js);
 * tappable when it leads somewhere. `alert` is the cream corner dot every
 * tile in the app uses for "this needs you".
 */
function Tile({ kind, icon, label, children, onPress, alert = false, testID }) {
  const { bg, fg } = TILE[kind];
  const body = (
    <>
      {alert ? <View style={s.alertDot} /> : null}
      <View style={s.tileHead}>
        <Ionicons name={icon} size={15} color={fg} />
        <Text style={[s.tileLabel, { color: fg }]} numberOfLines={2}>{label}</Text>
        {onPress ? <Ionicons name="chevron-forward" size={14} color={fg} style={{ marginLeft: "auto" }} /> : null}
      </View>
      {children}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID}
      style={({ pressed }) => [s.tile, { backgroundColor: bg }, pressed && { opacity: 0.85 }]}>
      {body}
    </Pressable>
  ) : <View style={[s.tile, { backgroundColor: bg }]}>{body}</View>;
}

function Change({ delta, exam }) {
  const { t, language } = useTranslation();
  const abs = on20(Math.abs(delta), language);
  const [icon, color, text] =
    delta > 0 ? ["trending-up-outline",   C.success,  t("portal.home.up",   { delta: abs, exam })]
    : delta < 0 ? ["trending-down-outline", C.danger,   t("portal.home.down", { delta: abs, exam })]
    : ["remove-outline", C.inkMuted, t("portal.home.same", { exam })];
  // On a cream pill, so green and red keep their meaning on the plum tile.
  return (
    <View style={s.change}>
      <Ionicons name={icon} size={14} color={color} />
      <Text style={[s.changeText, { color }]}>{text}</Text>
    </View>
  );
}

function HomeSkeleton() {
  return (
    <>
      {[0, 1].map((k) => (
        <Card key={k}>
          <View style={s.childHead}>
            <Skeleton width={48} height={48} radius={24} />
            <View style={{ flex: 1, gap: 8 }}><Skeleton width={140} height={16} /><Skeleton width={80} height={12} /></View>
          </View>
          <View style={s.grid}>
            {[0, 1, 2, 3].map((j) => (
              <View key={j} style={[s.tile, s.tileLoading, { gap: 8 }]}>
                <Skeleton width={90} height={12} /><Skeleton width={70} height={26} /><Skeleton width={100} height={12} />
              </View>
            ))}
          </View>
        </Card>
      ))}
    </>
  );
}

const s = StyleSheet.create({
  stack: { gap: 14 },
  h1:    { fontSize: 22, fontWeight: "700", color: C.ink },
  sub:   { marginTop: 2, fontSize: 14, color: C.inkMuted },

  childHead: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  childName: { fontSize: 17, fontWeight: "700", color: C.ink },
  childMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4 },
  classPill: {
    fontSize: 12, fontWeight: "600", color: C.primary, backgroundColor: C.primaryBg,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden",
  },

  // Two by two: the card's grid of coloured tiles.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 12 },
  tile: {
    ...TILE_SHAPE,
    width: "47%", flexGrow: 1, minHeight: 124,
  },
  tileLoading: { backgroundColor: C.canvas, shadowOpacity: 0, elevation: 0 },
  tileHead:  { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, minHeight: 18 },
  tileLabel: { flexShrink: 1, fontSize: 12, fontWeight: "700" },
  // Bottom corner: the top one holds the chevron.
  alertDot: {
    position: "absolute", bottom: 10, right: 10, width: 10, height: 10, borderRadius: 5,
    backgroundColor: PALETTE.cream, borderWidth: 2, borderColor: PALETTE.inkWarm,
  },

  big:      { fontSize: 28, fontWeight: "800", color: C.ink, fontVariant: ["tabular-nums"] },
  outOf:    { fontSize: 14, fontWeight: "600", color: C.inkFaint },
  money:    { fontSize: 20, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  examName: { fontSize: 15, fontWeight: "700", color: C.ink },
  body:     { marginTop: 2, fontSize: 13, color: C.inkBody, lineHeight: 18 },
  muted:    { fontSize: 13, color: C.inkMuted, lineHeight: 18 },
  faint:    { marginTop: 2, fontSize: 12, color: C.inkFaint },

  pill: {
    alignSelf: "flex-start", marginTop: 6, fontSize: 12, fontWeight: "700",
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1, overflow: "hidden",
  },
  pillDanger:  { color: C.danger,  backgroundColor: C.dangerBg,  borderColor: C.dangerLine },
  pillSuccess: { color: C.success, backgroundColor: C.successBg, borderColor: C.successLine, marginTop: 0, fontSize: 13 },

  change: {
    flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6, alignSelf: "flex-start",
    backgroundColor: PALETTE.cream, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
  },
  changeText: { flexShrink: 1, fontSize: 12, fontWeight: "600" },

  newsCard: { padding: 16 },
  newsRow:  { flexDirection: "row", gap: 12 },
  newsIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.primaryBg,
    alignItems: "center", justifyContent: "center",
  },
  kicker:    { fontSize: 11, fontWeight: "700", color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  newsTitle: { marginTop: 2, fontSize: 15, fontWeight: "600", color: C.ink },
  newsBody:  { marginTop: 4, fontSize: 13, color: C.inkBody, lineHeight: 19 },
  seeAll: {
    marginTop: 10, minHeight: TAP, borderRadius: 10, flexDirection: "row",
    alignItems: "center", justifyContent: "center", gap: 4,
  },
  seeAllText: { fontSize: 14, fontWeight: "600", color: C.primary },
});
