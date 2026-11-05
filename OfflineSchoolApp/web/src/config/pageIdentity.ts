// web/src/config/pageIdentity.ts
/**
 * What colour and icon a page's header square takes, by route.
 *
 * PageHeader looks the current path up here (longest prefix wins), so every
 * page opens with a solid icon square in the colour of what it is about — the
 * same colour as that kind's cards (config/dashboardTint.ts): students blue,
 * teachers violet, classes indigo, subjects slate, exams amber, attendance
 * green, timetable teal, money teal, messages sky, reports slate.
 */
import {
  Award, Banknote, BarChart3, BookMarked, Building2, CalendarDays,
  ClipboardCheck, ClipboardList, Clock, Download, Eye, FileSpreadsheet,
  FileText, FolderOpen, Globe, GraduationCap, KeyRound, LayoutDashboard,
  Lightbulb, Megaphone, MessageSquare, Printer, Receipt, School, ScrollText,
  Settings, ShieldCheck, TrendingUp, UserCheck, UserCog, Users, Wallet,
  type LucideIcon,
} from "lucide-react";
import type { DashAccent } from "@/config/dashboardTint";

export interface PageIdentity {
  accent: DashAccent;
  icon:   LucideIcon;
}

/** Route prefix → identity. Order does not matter: the longest match wins. */
export const PAGE_IDENTITY: Record<string, PageIdentity> = {
  "/dashboard":                 { accent: "blue",   icon: LayoutDashboard },
  "/students":                  { accent: "blue",   icon: GraduationCap },
  "/students/admissions":       { accent: "blue",   icon: UserCheck },
  "/students/applications":     { accent: "blue",   icon: UserCheck },
  "/teachers":                  { accent: "violet", icon: Users },
  "/teachers/assignments":      { accent: "violet", icon: ClipboardList },
  "/classes":                   { accent: "indigo", icon: School },
  "/subjects":                  { accent: "slate",  icon: BookMarked },
  "/timetable":                 { accent: "teal",   icon: CalendarDays },
  "/periods":                   { accent: "teal",   icon: Clock },
  "/attendance":                { accent: "green",  icon: ClipboardCheck },
  "/attendance/reports":        { accent: "green",  icon: BarChart3 },
  "/exams":                     { accent: "amber",  icon: FileText },
  "/exams/results":             { accent: "slate",  icon: Award },
  "/exams/term-results":        { accent: "slate",  icon: Award },
  "/exams/annual-results":      { accent: "slate",  icon: Award },
  "/exams/reports":             { accent: "slate",  icon: BarChart3 },
  "/promotion":                 { accent: "blue",   icon: TrendingUp },
  "/fees":                      { accent: "teal",   icon: Wallet },
  "/fees/structures":           { accent: "teal",   icon: ClipboardList },
  "/finance":                   { accent: "teal",   icon: Banknote },
  "/finance/expenses":          { accent: "teal",   icon: Receipt },
  "/finance/reports":           { accent: "teal",   icon: BarChart3 },
  "/approvals":                 { accent: "amber",  icon: ShieldCheck },
  "/watchlist":                 { accent: "red",    icon: Eye },
  "/class-intelligence":        { accent: "violet", icon: Lightbulb },
  "/intelligence-review":       { accent: "violet", icon: ClipboardCheck },
  "/announcements":             { accent: "sky",    icon: Megaphone },
  "/messages":                  { accent: "sky",    icon: MessageSquare },
  "/reports":                   { accent: "slate",  icon: BarChart3 },
  "/reports/templates":         { accent: "teal",   icon: FileSpreadsheet },
  "/reports/cards":             { accent: "slate",  icon: Printer },
  "/documents":                 { accent: "slate",  icon: FolderOpen },
  "/exports":                   { accent: "slate",  icon: Download },
  "/portal-codes":              { accent: "sky",    icon: KeyRound },
  "/settings":                  { accent: "slate",  icon: Settings },
  "/change-password":           { accent: "slate",  icon: UserCog },
  "/platform":                  { accent: "indigo", icon: Globe },
  "/platform/schools":          { accent: "indigo", icon: Building2 },
  "/platform/performance":      { accent: "indigo", icon: BarChart3 },
  "/platform/reports":          { accent: "indigo", icon: FileSpreadsheet },
  "/platform/audit":            { accent: "slate",  icon: ScrollText },
  "/platform/settings":         { accent: "slate",  icon: Settings },
};

const FALLBACK: PageIdentity = { accent: "blue", icon: LayoutDashboard };

/** The identity for a path: the longest matching prefix, or the brand blue. */
export function pageIdentity(pathname: string): PageIdentity {
  let best: string | null = null;
  for (const prefix of Object.keys(PAGE_IDENTITY)) {
    if ((pathname === prefix || pathname.startsWith(`${prefix}/`)) && (!best || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best ? PAGE_IDENTITY[best] : FALLBACK;
}
