// web/src/services/reportLayout.service.ts
//
// Which sections a school's report cards print (docs/39 §10.3, Phase 2d API;
// screen: Phase 5). Every route takes the school explicitly: a super_admin
// must name one, and the server refuses a request that names none.

import api from "@/services/api";

export interface ReportSection {
  id:          string;
  label:       string;
  description: string;
  default:     boolean;
}

export interface ReportLayout {
  id:             string | null;
  schoolId:       string;
  version:        number;
  sections:       Record<string, boolean>;
  basedOnVersion: number | null;
  createdBy:      string | null;
  createdAt:      string | null;
  source:         "default" | "school" | string;
}

export interface LayoutState {
  layout: ReportLayout;
  /** Sections switched off that the school's own token template prints anyway. */
  sectionsNotHiddenByTemplate: string[];
}

export async function fetchSections(schoolId: string): Promise<ReportSection[]> {
  const { data } = await api.get("/templates/sections", { params: { schoolId } });
  return (data?.sections as ReportSection[]) ?? [];
}

export async function fetchLayout(schoolId: string): Promise<LayoutState> {
  const { data } = await api.get("/templates/layout", { params: { schoolId } });
  return {
    layout: data?.layout as ReportLayout,
    sectionsNotHiddenByTemplate: (data?.sectionsNotHiddenByTemplate as string[]) ?? [],
  };
}

export async function fetchLayoutVersions(schoolId: string): Promise<ReportLayout[]> {
  const { data } = await api.get("/templates/layout/versions", { params: { schoolId } });
  return (data?.versions as ReportLayout[]) ?? [];
}

export async function saveLayout(
  schoolId: string, sections: Record<string, boolean>
): Promise<{ changed: boolean; layout: ReportLayout | null; sectionsNotHiddenByTemplate: string[] }> {
  const { data } = await api.put("/templates/layout", { sections }, { params: { schoolId } });
  return {
    changed: Boolean(data?.changed),
    layout:  (data?.layout as ReportLayout) ?? null,
    sectionsNotHiddenByTemplate: (data?.sectionsNotHiddenByTemplate as string[]) ?? [],
  };
}
