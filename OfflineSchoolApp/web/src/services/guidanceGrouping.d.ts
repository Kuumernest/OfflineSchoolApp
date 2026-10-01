export interface GuidanceLike {
  subjectId?: string | null;
  subjectName?: string | null;
  rationaleCode: string;
  priority: "high" | "moderate" | "low";
  type?: string;
}

export interface GuidanceGroup<T extends GuidanceLike = GuidanceLike> {
  key: string;
  subjectId: string | null;
  subjectName: string | null;
  priority: "high" | "moderate" | "low";
  rationaleCodes: string[];
  types: string[];
  items: T[];
}

export function groupGuidanceBySubject<T extends GuidanceLike>(items: readonly T[] | null | undefined): GuidanceGroup<T>[];
