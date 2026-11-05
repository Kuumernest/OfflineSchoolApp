// src/components/Tinted.js
//
// The shared pieces every screen uses to look like the dashboards, in the
// same colours as the web console:
//
//   HeaderIcon   the solid icon square at the head of a screen, picked from
//                the route (SCREEN_IDENTITY) unless told otherwise
//   ScreenHeader a whole header: back button, icon square, title, subtitle,
//                and a right-hand slot
//   IconSquare   a solid colour square with a white icon
//   Badge        a pill in an entity's colour or a status colour — never grey
//   EmptyState   a solid icon square, a title and a line of text
//   TintCard     a card with its accent's wash and a 3px top or left edge
//
// Colours come from src/theme/colors.js only. An `accent` is a key of ACCENT
// ("blue", "violet" …); a `kind` ("classes", "fees" …) maps to one through
// TILE. levelAccent / termAccent / roleAccent / categoryAccent pick an
// entity's accent. Styling only: none of these fetch, store or navigate
// (ScreenHeader calls the onBack it is given).

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import {
  COLORS, ACCENT, SEMANTIC, TONE_EDGE, TILE_SHAPE, kindAccent, accentBadge, statusBadge,
} from "../theme/colors";

/** Route prefix → the header square's accent and Ionicons name. Longest prefix wins. */
export const SCREEN_IDENTITY = {
  "/admin":                 { accent: "blue",   icon: "grid" },
  "/admin/dashboard":       { accent: "blue",   icon: "grid" },
  "/admin/classes":         { accent: "indigo", icon: "school" },
  "/admin/subjects":        { accent: "slate",  icon: "book" },
  "/admin/periods":         { accent: "teal",   icon: "time" },
  "/admin/timetable":       { accent: "teal",   icon: "calendar" },
  "/admin/students":        { accent: "blue",   icon: "people" },
  "/admin/teachers":        { accent: "violet", icon: "person" },
  "/admin/assignments":     { accent: "violet", icon: "git-branch" },
  "/admin/exams":           { accent: "amber",  icon: "document-text" },
  "/admin/promotion":       { accent: "blue",   icon: "trending-up" },
  "/admin/attendance":      { accent: "green",  icon: "checkbox" },
  "/admin/fees":            { accent: "teal",   icon: "wallet" },
  "/admin/finance":         { accent: "teal",   icon: "cash" },
  "/admin/announcements":   { accent: "sky",    icon: "megaphone" },
  "/admin/reports":         { accent: "slate",  icon: "stats-chart" },
  "/admin/documents":       { accent: "slate",  icon: "folder-open" },
  "/admin/exports":         { accent: "slate",  icon: "download" },
  "/admin/gate":            { accent: "green",  icon: "qr-code" },
  "/admin/settings":        { accent: "slate",  icon: "settings" },
  "/admin/sync-overwrites": { accent: "amber",  icon: "git-compare" },
  "/admin/school-picker":   { accent: "indigo", icon: "business" },
  "/teacher":               { accent: "violet", icon: "grid" },
  "/teacher/subjects":      { accent: "slate",  icon: "book" },
  "/teacher/students":      { accent: "blue",   icon: "people" },
  "/teacher/exams":         { accent: "amber",  icon: "trophy" },
  "/teacher/results":       { accent: "slate",  icon: "stats-chart" },
  "/teacher/attendance":    { accent: "green",  icon: "checkbox" },
  "/teacher/timetable":     { accent: "teal",   icon: "time" },
  "/teacher/content":       { accent: "indigo", icon: "folder" },
  "/teacher/quizzes":       { accent: "indigo", icon: "help-circle" },
  "/teacher/homework":      { accent: "indigo", icon: "clipboard" },
  "/teacher/announcements": { accent: "sky",    icon: "megaphone" },
  "/teacher/intelligence":  { accent: "violet", icon: "bulb" },
  "/teacher/explorations":  { accent: "violet", icon: "compass" },
  "/teacher/profile":       { accent: "violet", icon: "person" },
  "/teacher/settings":      { accent: "slate",  icon: "settings" },
  "/student":               { accent: "blue",   icon: "home" },
  "/student/subjects":      { accent: "slate",  icon: "book" },
  "/student/timetable":     { accent: "teal",   icon: "time" },
  "/student/attendance":    { accent: "green",  icon: "calendar" },
  "/student/results":       { accent: "slate",  icon: "trophy" },
  "/student/homework":      { accent: "indigo", icon: "document-text" },
  "/student/quizzes":       { accent: "indigo", icon: "help-circle" },
  "/student/announcements": { accent: "sky",    icon: "megaphone" },
  "/student/fees":          { accent: "teal",   icon: "wallet" },
  "/student/explore":       { accent: "sky",    icon: "compass" },
  "/student/development":   { accent: "green",  icon: "leaf" },
  "/student/plans":         { accent: "indigo", icon: "map" },
  "/student/intelligence":  { accent: "violet", icon: "bulb" },
  "/student/profile":       { accent: "blue",   icon: "person" },
  "/student/settings":      { accent: "slate",  icon: "settings" },
  "/messages":              { accent: "sky",    icon: "chatbubbles" },
  "/portal":                { accent: "sky",    icon: "home" },
  "/auth":                  { accent: "blue",   icon: "log-in" },
  "/sync":                  { accent: "amber",  icon: "sync" },
};

const FALLBACK = { accent: "blue", icon: "grid" };

/** The identity for a path: the longest matching prefix, or the brand blue. */
export function screenIdentity(pathname) {
  let best = null;
  for (const prefix of Object.keys(SCREEN_IDENTITY)) {
    if ((pathname === prefix || pathname?.startsWith(`${prefix}/`)) && (!best || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best ? SCREEN_IDENTITY[best] : FALLBACK;
}

/** `accent` wins, then `kind`, then the fallback. */
const pickAccent = (accent, kind, fallback = "blue") =>
  (accent && ACCENT[accent] ? accent : null) ?? (kind ? kindAccent(kind) : null) ?? fallback;

/** A solid colour square with a white icon. */
export function IconSquare({ icon, accent, kind, size = 36, radius, style }) {
  const a = ACCENT[pickAccent(accent, kind)];
  return (
    <View
      style={[
        styles.square,
        { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.28), backgroundColor: a.solid },
        style,
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={COLORS.onPrimary} />
    </View>
  );
}

/** The screen's icon square, from the route unless `icon` / `accent` say otherwise. */
export function HeaderIcon({ icon, accent, kind, size = 36, style }) {
  const pathname = usePathname();
  const id = screenIdentity(pathname);
  return (
    <IconSquare
      icon={icon ?? id.icon}
      accent={accent ?? (kind ? undefined : id.accent)}
      kind={kind}
      size={size}
      style={[styles.headerIcon, style]}
    />
  );
}

/**
 * A whole screen header: back, icon square, title and subtitle, right slot.
 * Screens with a header of their own can keep it and add <HeaderIcon />.
 */
export function ScreenHeader({ title, subtitle, onBack, backLabel, right, icon, accent, kind, style }) {
  return (
    <View style={[styles.header, style]}>
      {onBack ? (
        <TouchableOpacity
          onPress={onBack}
          style={styles.back}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={backLabel}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
      ) : null}
      <HeaderIcon icon={icon} accent={accent} kind={kind} />
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );
}

/**
 * A pill. `tone` (success, warning, error, info) for a status; `accent` or
 * `kind` for an entity (a level, a role, a term, a category). Never grey.
 */
export function Badge({ label, tone, accent, kind, icon, style, textStyle }) {
  const c = tone ? statusBadge(tone) : accentBadge(pickAccent(accent, kind, "blue"));
  return (
    <View style={[styles.badge, { backgroundColor: c.bg, borderColor: c.border }, style]}>
      {icon ? <Ionicons name={icon} size={12} color={c.text} /> : null}
      <Text style={[styles.badgeText, { color: c.text }, textStyle]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** An empty list: a solid icon square, a title and a line of text. */
export function EmptyState({ icon = "file-tray-outline", title, message, accent, kind, action, style }) {
  return (
    <View style={[styles.empty, style]}>
      <IconSquare icon={icon} accent={accent} kind={kind} size={56} radius={16} />
      {title ? <Text style={styles.emptyTitle}>{title}</Text> : null}
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {action ?? null}
    </View>
  );
}

/**
 * A card in an accent: its wash, a hairline and a 3px edge on top (or the
 * left, for row-like cards). A `tone` (warning, error) turns the border to
 * the tone's colour, as the dashboard's alert tiles do.
 */
export function TintCard({ accent, kind, edge = "top", tone, onPress, children, style, ...rest }) {
  const a = ACCENT[pickAccent(accent, kind)];
  const border = tone && SEMANTIC[tone] ? TONE_EDGE[tone] : COLORS.border;
  const edgeStyle = edge === "left"
    ? { borderLeftWidth: 3, borderLeftColor: tone ? border : a.base }
    : { borderTopWidth: 3, borderTopColor: tone ? border : a.base };
  const Box = onPress ? TouchableOpacity : View;
  return (
    <Box
      style={[styles.card, { backgroundColor: a.wash, borderColor: border }, edgeStyle, style]}
      {...(onPress ? { onPress, activeOpacity: 0.8, accessibilityRole: "button" } : {})}
      {...rest}
    >
      {children}
    </Box>
  );
}

/** The colours a tinted card's text takes: figure in the deep shade, labels secondary. */
export const tintText = (accent, kind) => {
  const a = ACCENT[pickAccent(accent, kind)];
  return { figure: a.deep, title: COLORS.text, label: COLORS.textSecondary, glyph: a.solid };
};

const styles = StyleSheet.create({
  square: { alignItems: "center", justifyContent: "center" },
  headerIcon: { marginRight: 12 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "ios" ? 60 : 20,
    paddingBottom: 16,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  back: { marginRight: 8, padding: 4 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, fontWeight: "700", color: COLORS.text },
  subtitle: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeText: { fontSize: 11, fontWeight: "600" },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 40, paddingHorizontal: 24, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: COLORS.text, textAlign: "center" },
  emptyMessage: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center", lineHeight: 19 },
  card: { ...TILE_SHAPE },
});
