// web/src/hooks/useApplications.ts

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";

import { StudentApplicationsService }   from "../services/studentApplications.service";
import { ClassService }                  from "../services/class.service";
import { useAuth }                       from "./useAuth";

import type {
  NormalisedApplication,
  ClassOption,
  ApprovalResult,
  RejectionResult,
} from "../types/applications";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

export const STALE_DAYS = 3;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Returns true if a created_at timestamp is older than STALE_DAYS.
 */
export const isStale = (created_at: string | null | undefined): boolean => {
  if (!created_at) return false;
  const t = new Date(created_at).getTime();
  return !Number.isNaN(t) && t < Date.now() - STALE_MS;
};

// ─────────────────────────────────────────────────────────
// HOOK RETURN TYPE
// ─────────────────────────────────────────────────────────

export interface UseApplicationsReturn {
  applications: NormalisedApplication[];
  classes:      ClassOption[];
  staleCount:   number;
  loading:      boolean;
  refreshing:   boolean;
  error:        string | null;
  loadData:     (isRefresh?: boolean) => Promise<void>;
  approve:      (applicationId: string, classId: string) => Promise<ApprovalResult>;
  reject:       (applicationId: string, reason?: string) => Promise<RejectionResult>;
  STALE_DAYS:   number;
}

// ─────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────

export const useApplications = (): UseApplicationsReturn => {
  const { user } = useAuth();
  const schoolId = user?.schoolId ?? null;

  const isMounted = useRef(true);

  const [applications, setApplications] = useState<NormalisedApplication[]>([]);
  const [classes,      setClasses]      = useState<ClassOption[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ── Load data ───────────────────────────────────────────────────────────
  const loadData = useCallback(
    async (isRefresh = false): Promise<void> => {
      try {
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        setError(null);

        const [apps, classRows] = await Promise.all([
          StudentApplicationsService.getPendingApplications(schoolId),
          ClassService.getAll(false),
        ]);

        if (!isMounted.current) return;

        setApplications(apps);

        // ClassService.getAll returns Class[] — map to ClassOption[]
        const classOptions: ClassOption[] = (classRows || []).map(
          (c: Record<string, unknown>) => ({
            _id:      String(c._id || c.id || ""),
            id:       String(c._id || c.id || ""),
            name:     (c.name as string) || "",
            level:    (c.level as string) || null,
            section:  (c.section as string) || "",
            schoolId: (c.schoolId as string) || undefined,
            isActive: c.isActive as boolean | undefined,
          })
        );
        setClasses(classOptions);
      } catch (err: unknown) {
        console.error("[useApplications] loadData failed:", err);
        if (isMounted.current) {
          const axiosErr = err as {
            response?: { data?: { message?: string } };
            message?: string;
          };
          setError(
            axiosErr?.response?.data?.message ||
            axiosErr?.message ||
            "Failed to load applications."
          );
        }
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [schoolId]
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Derived values ──────────────────────────────────────────────────────
  const staleCount = useMemo(
    () => applications.filter((a) => isStale(a.created_at)).length,
    [applications]
  );

  // ── Approve ─────────────────────────────────────────────────────────────
  const approve = useCallback(
    async (applicationId: string, classId: string): Promise<ApprovalResult> => {
      const result = await StudentApplicationsService.approveApplication(
        applicationId,
        classId
      );
      if (isMounted.current) {
        setApplications((prev) =>
          prev.filter((a) => a.id !== applicationId)
        );
      }
      return result;
    },
    []
  );

  // ── Reject ──────────────────────────────────────────────────────────────
  const reject = useCallback(
    async (
      applicationId: string,
      reason?: string
    ): Promise<RejectionResult> => {
      const result = await StudentApplicationsService.rejectApplication(
        applicationId,
        reason || ""
      );
      if (isMounted.current) {
        setApplications((prev) =>
          prev.filter((a) => a.id !== applicationId)
        );
      }
      return result;
    },
    []
  );

  return {
    applications,
    classes,
    staleCount,
    loading,
    refreshing,
    error,
    loadData,
    approve,
    reject,
    STALE_DAYS,
  };
};