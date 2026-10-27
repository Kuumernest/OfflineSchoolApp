// web/src/hooks/useSchoolYear.ts
//
// The school's current academic year — its own setting, else the calendar's
// (shared/academicYear.js currentAcademicYearOf, served by
// GET /admin/school-info). What every year picker opens on (B5): Progression
// opened on 2025/2026 for a school in 2026/2027.

import { useQuery }     from "@tanstack/react-query";
import api              from "@/services/api";
import { useAuthStore } from "@/store/auth.store";
import type { AgeRanges } from "@/utils/studentValidation";

/** The calendar's year, September to August, until the school's arrives. */
export const calendarAcademicYear = (now = new Date()): string => {
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

/** The year before, the school's year and the two after — the school's always listed. */
export const yearOptionsAround = (year: string): string[] => {
  const start = Number(year.split(/[/-]/)[0]) || new Date().getFullYear();
  return [-1, 0, 1, 2].map((d) => `${start + d}/${start + d + 1}`);
};

/** The two school settings the forms read: its current year and its age ranges (B3). */
const useSchoolBasics = () => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: ["school-basics", schoolId],
    queryFn:  async () => {
      const { data } = await api.get("/admin/school-info", { params: { schoolId } });
      const s = data?.school || data;
      return {
        year:      (s?.currentAcademicYear as string | undefined)?.replace("-", "/") ?? null,
        ageRanges: (s?.settings?.studentAgeRanges ?? null) as AgeRanges,
      };
    },
    enabled:   !!schoolId,
    staleTime: 5 * 60_000,
  });
};

export function useSchoolYear(): { year: string; isLoading: boolean } {
  const q = useSchoolBasics();
  return { year: q.data?.year ?? calendarAcademicYear(), isLoading: q.isLoading };
}

/** The school's own age range per class level, or null for the defaults. */
export function useStudentAgeRanges(): AgeRanges {
  return useSchoolBasics().data?.ageRanges ?? null;
}
