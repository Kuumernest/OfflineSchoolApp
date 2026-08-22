// web/src/pages/students/StudentsPage.tsx
import { useState, useCallback }  from "react";
import { useQuery }               from "@tanstack/react-query";
import { useNavigate }            from "react-router-dom";
import {
  GraduationCap, Plus, Mail, Phone,
  MoreVertical, AlertCircle,
} from "lucide-react";

import { useUser }         from "@/store/auth.store";
import {
  fetchStudents,
  fetchClasses,
}                          from "@/services/student.service";
import type { Student, SchoolClass } from "@/types";
import { PageSpinner }     from "@/components/ui/Spinner";
import { Button }          from "@/components/ui/Button";
import { Badge }           from "@/components/ui/Badge";
import { SearchInput }     from "@/components/ui/SearchInput";
import { Select }          from "@/components/ui/Select";
import { Pagination }      from "@/components/ui/Pagination";
import { useTranslation } from "react-i18next";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type BadgeVariant = "success" | "danger" | "warning" | "default";

interface SelectOption {
  value: string;
  label: string;
}

interface StudentsResponse {
  students: Student[];
  total:    number;
  pages:    number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 20;

// ✅ "all" is now an explicit option so the backend receives it correctly.
// Backend buildStudentFilter() skips the status clause when status === "all"
// which returns every student regardless of status — matching the DB total.
const STATUS_OPTIONS: SelectOption[] = [
  { value: "all",       label: "All Statuses" },
  { value: "approved",  label: "Active"        },
  { value: "pending",   label: "Pending"       },
  { value: "suspended", label: "Suspended"     },
  { value: "rejected",  label: "Rejected"      },
];

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const statusVariant = (status: string | undefined): BadgeVariant => {
  switch ((status ?? "").toLowerCase()) {
    case "approved":  return "success";
    case "suspended": return "danger";
    case "rejected":  return "danger";
    case "pending":   return "warning";
    default:          return "default";
  }
};

const statusLabel = (status: string | undefined): string => {
  switch ((status ?? "").toLowerCase()) {
    case "approved":  return "Active";
    case "suspended": return "Suspended";
    case "rejected":  return "Rejected";
    case "pending":   return "Pending";
    default:          return status || "Unknown";
  }
};

const nameInitial = (name: string | undefined): string =>
  name?.trim().charAt(0).toUpperCase() || "#";

/**
 * Converts the UI status value to what the backend expects.
 * "" or "all" → "all"  (backend returns every student)
 * anything else is passed through unchanged.
 */
const toQueryStatus = (uiStatus: string): string => uiStatus || "all";

/**
 * The backend returns a flat `className` string (from enrichWithClassNames
 * in students.routes.js), not a nested `class: { name }` object. Support
 * both shapes so this keeps working if the API contract changes.
 */
const resolveClassName = (student: Student): string =>
  student.class?.name ?? student.className ?? "Unassigned";

/**
 * Returns a human-readable count label that reflects the active filter.
 * "42 students registered"  (when showing all)
 * "18 active students"      (when filtered to approved)
 */
const countLabel = (total: number, status: string): string => {
  const n    = total.toLocaleString();
  const noun = total !== 1 ? "students" : "student";

  switch (status) {
    case "all":
    case "":
      return `${n} ${noun} registered`;
    case "approved":
      return `${n} active ${noun}`;
    case "pending":
      return `${n} pending ${noun}`;
    case "suspended":
      return `${n} suspended ${noun}`;
    case "rejected":
      return `${n} rejected ${noun}`;
    default:
      return `${n} ${noun}`;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ERROR BANNER
// ─────────────────────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-red-200
 bg-red-50 px-4 py-3
                 text-sm text-red-700"
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ROW
// ─────────────────────────────────────────────────────────────────────────────

interface StudentRowProps {
  student:    Student;
  onNavigate: () => void;
}

function StudentRow({ student, onNavigate }: StudentRowProps) {
  return (
    <Tr onClick={onNavigate}>

      {/* Name + avatar */}
      <Td>
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full bg-primary-100
                       flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <span className="text-primary-700
                             text-sm font-bold">
              {nameInitial(student.name)}
            </span>
          </div>
          <div>
            <p className="font-medium text-gray-900 text-sm">
              {student.name}
            </p>
            {student.email && (
              <p className="text-xs text-gray-400">
                {student.email}
              </p>
            )}
          </div>
        </div>
      </Td>

      {/* Enrollment / admission number */}
      <Td>
        <span className="text-gray-600 text-sm font-mono">
          {student.admissionNumber || student.enrollmentNo || "—"}
        </span>
      </Td>

      {/* Class */}
      <Td>
        <span className="text-gray-600 text-sm">
          {resolveClassName(student)}
        </span>
      </Td>

      {/* Contact */}
      <Td>
        <div className="space-y-0.5">
          {student.phone && (
            <div className="flex items-center gap-1.5 text-xs
                            text-gray-500">
              <Phone className="w-3 h-3" aria-hidden="true" />
              {student.phone}
            </div>
          )}
          {student.email && (
            <div className="flex items-center gap-1.5 text-xs
                            text-gray-500">
              <Mail className="w-3 h-3" aria-hidden="true" />
              {student.email}
            </div>
          )}
          {!student.phone && !student.email && (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>
      </Td>

      {/* Guardian */}
      <Td>
        <span className="text-sm text-gray-600">
          {student.guardianName || "—"}
        </span>
      </Td>

      {/* Status */}
      <Td>
        <Badge
          label={statusLabel(student.status)}
          variant={statusVariant(student.status)}
        />
      </Td>

      {/* Actions */}
      <Td>
        <button
          type="button"
          aria-label={`More options for ${student.name}`}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            // TODO: open context menu
          }}
          className="p-1 text-gray-400 hover:text-gray-600
 rounded"
        >
          <MoreVertical className="w-4 h-4" aria-hidden="true" />
        </button>
      </Td>
    </Tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  const { t } = useTranslation();
  const user     = useUser();
  const navigate = useNavigate();
  const schoolId = user?.schoolId ?? "";

  // ── Filter state ──────────────────────────────────────────────────────────
  const [search,  setSearch]  = useState<string>("");
  const [classId, setClassId] = useState<string>("");

  // ✅ Default is "all" so the initial page load count matches the DB total.
  // Previously "" caused the backend to default to "approved" only.
  const [status, setStatus]   = useState<string>("all");
  const [page,   setPage]     = useState<number>(1);

  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleClassChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setClassId(e.target.value);
      setPage(1);
    },
    []
  );

  const handleStatusChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setStatus(e.target.value);
      setPage(1);
    },
    []
  );

  // ── Queries ───────────────────────────────────────────────────────────────

  const classesQuery = useQuery<SchoolClass[], Error>({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId) as Promise<SchoolClass[]>,
    enabled:  !!schoolId,
  });

  const studentsQuery = useQuery<StudentsResponse, Error>({
    // ✅ Cache key uses toQueryStatus so "" and "all" share the same entry
    queryKey: [
      "students",
      schoolId,
      search,
      classId,
      toQueryStatus(status),
      page,
    ],
    queryFn: () =>
      fetchStudents({
        schoolId,
        search,
        classId,
        status: toQueryStatus(status),
        page,
        limit:  PAGE_LIMIT,
      }),
    enabled:         !!schoolId,
    placeholderData: (prev) => prev,
  });

  const students: Student[] = studentsQuery.data?.students ?? [];
  const total:    number    = studentsQuery.data?.total    ?? 0;
  const pages:    number    = studentsQuery.data?.pages    ?? 1;

  const classOptions: SelectOption[] = (classesQuery.data ?? []).map(
    (c: SchoolClass) => ({
      value: c._id ?? c.id ?? "",
      label: c.name,
    })
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center
                      sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">
            {t("students.title")}
          </h2>
          {/* ✅ Count label now reflects the active filter honestly */}
          <p className="text-sm text-gray-500 mt-0.5">
            {countLabel(total, status)}
          </p>
        </div>

        <Button
          icon={<Plus className="w-4 h-4" aria-hidden="true" />}
          onClick={() => navigate("/students/new")}
        >
          {t("students.add")}
        </Button>
      </div>

      {/* Error banners */}
      {classesQuery.isError && (
        <ErrorBanner
          message={
            classesQuery.error.message ||
            "Failed to load class list. Filters may be incomplete."
          }
        />
      )}
      {studentsQuery.isError && (
        <ErrorBanner
          message={
            studentsQuery.error.message ||
            "Failed to load students. Please try again."
          }
        />
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border
                      border-gray-200 shadow-sm p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput
            value={search}
            onChange={handleSearch}
            placeholder={t("students.searchPh")}
            className="flex-1"
          />
          <Select
            value={classId}
            onChange={handleClassChange}
            options={classOptions}
            placeholder={t("students.allClasses")}
          />
          {/* ✅ No placeholder — "All Statuses" is the first explicit option */}
          <Select
            value={status}
            onChange={handleStatusChange}
            options={STATUS_OPTIONS}
          />
        </div>
      </div>

      {/* Table card */}
      <div className="bg-white rounded-xl border
                      border-gray-200 shadow-sm
                      overflow-hidden">

        {studentsQuery.isLoading ? (
          <PageSpinner />
        ) : students.length === 0 ? (
          <EmptyTable
            icon={
              <GraduationCap
                className="w-12 h-12 text-gray-300"
                aria-hidden="true"
              />
            }
            title={t("students.none")}
            subtitle={
              search || classId || status !== "all"
                ? "Try adjusting your filters"
                : "Add your first student to get started"
            }
            action={
              !search && !classId && status === "all" ? (
                <Button
                  icon={<Plus className="w-4 h-4" aria-hidden="true" />}
                  onClick={() => navigate("/students/new")}
                >
                  {t("students.add")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>{t("academic.student")}</Th>
                  <Th>{t("academic.enrollmentNo")}</Th>
                  <Th>{t("academic.class")}</Th>
                  <Th>{t("common.contact")}</Th>
                  <Th>{t("students.guardian")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th className="w-10">
                    <span className="sr-only">{t("common.actions")}</span>
                  </Th>
                </tr>
              </THead>

              <TBody>
                {students.map((student) => (
                  <StudentRow
                    key={student._id}
                    student={student}
                    onNavigate={() => navigate(`/students/${student._id}`)}
                  />
                ))}
              </TBody>
            </Table>

            <div className="border-t border-gray-100">
              <Pagination
                page={page}
                pages={pages}
                total={total}
                onPageChange={setPage}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}