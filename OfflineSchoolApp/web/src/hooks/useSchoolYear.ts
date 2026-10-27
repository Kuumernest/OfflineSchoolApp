// web/src/hooks/useSchoolYear.ts
//
// The school's current academic year — its own setting, else the calendar's
// (shared/academicYear.js currentAcademicYearOf, served by
// GET /admin/school-info). What every year picker opens on (B5): Progression
// opened on 2025/2026 for a school in 2026/2027.

import { useQuery }     from "@tanstack/react-query";
import api              from "@/services/api";
import { useAuthStore } from "@/store/auth.store";

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

export function useSchoolYear(): { year: string; isLoading: boolean } {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  const q = useQuery({
    queryKey: ["school-current-year", schoolId],
    queryFn:  async () => {
      const { data } = await api.get("/admin/school-info", { params: { schoolId } });
      const s = data?.school || data;
      return (s?.currentAcademicYear as string | undefined)?.replace("-", "/") ?? null;
    },
    enabled:   !!schoolId,
    staleTime: 5 * 60_000,
  });
  return { year: q.data ?? calendarAcademicYear(), isLoading: q.isLoading };
}
