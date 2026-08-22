// web/src/hooks/useApplications.ts

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";

// The applications service exports plain functions, not a
// `StudentApplicationsService` namespace object, and class.service exports
// `fetchClasses` rather than a `ClassService`. There is also no useAuth hook —
// the store exposes `useUser`. All three imports named things that do not
// exist, so this module could not compile.
import {
  fetchPendingApplications,
  approveApplication,
  rejectApplication,
  type StudentApplication,
} from "@/services/studentApplications.service";
import { fetchClasses } from "@/services/class.service";
import { useUser }      from "@/store/auth.store";

import type {
  NormalisedApplication,
  ClassOption,
  ApprovalResult,
  RejectionResult,
} from "@/types/applications";

/**
 * The service's row and the UI's row are nearly the same shape, but
 * NormalisedApplication additionally requires firstName/lastName. The server
 * only sends a single `name`, so they are split here — on the LAST space, so
 * that "Mary Grace Okonkwo" keeps "Mary Grace" as the given name rather than
 * treating "Grace Okonkwo" as a surname.
 */
const toNormalised = (a: StudentApplication): NormalisedApplication => {
  const name = (a.name ?? "").trim();
  const cut  = name.lastIndexOf(" ");

  return {
    id:           a.id || a._id,
    name,
    firstName:    cut > 0 ? name.slice(0, cut) : name || null,
    lastName:     cut > 0 ? name.slice(cut + 1) : null,
    email:        a.email        ?? "",
    phone:        a.phone        ?? "",
    guardianName: a.guardianName ?? "",
    className:    a.className    ?? "",
    classId:      a.classId ?? a.class_id ?? null,
    status:       a.status       ?? "pending",
    created_at:   a.created_at   ?? null,
    updated_at:   a.updated_at   ?? null,
    // The two ApplicationDocument types differ only in which fields are
    // optional, so the service's rows satisfy the UI's contract at runtime.
    documents:    (a.documents ?? []) as NormalisedApplication["documents"],
    address:      a.address      ?? "",
    notes:        a.notes        ?? "",
    schoolId:     a.schoolId     ?? null,
  };
};

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
  const user     = useUser();
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
          fetchPendingApplications(schoolId ?? ""),
          // fetchClasses is school-scoped; without the id it would return
          // every school's classes to whoever asked.
          fetchClasses(schoolId ?? ""),
        ]);

        if (!isMounted.current) return;

        setApplications(apps.map(toNormalised));

        // fetchClasses returns Class[]; ClassOption additionally carries an
        // `id` alias and allows a null level. Indexing through an unknown hop
        // keeps this tolerant of the snake_case variants the API also emits.
        const classOptions: ClassOption[] = (classRows || []).map((row) => {
          const c  = row as unknown as Record<string, unknown>;
          const id = String(c._id || c.id || "");
          return {
            _id:      id,
            id,
            name:     (c.name as string) || "",
            level:    (c.level as string) || null,
            section:  (c.section as string) || "",
            schoolId: (c.schoolId as string) || undefined,
            isActive: c.isActive as boolean | undefined,
          };
        });
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
      const raw = await approveApplication(applicationId, classId);
      // ApproveApplicationResult types `message` as string | null; the UI's
      // ApprovalResult wants string | undefined.
      const result: ApprovalResult = { ...raw, message: raw.message ?? undefined };
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
      const result: RejectionResult = await rejectApplication(
        applicationId,
        reason || "",
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