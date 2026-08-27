// web/src/pages/teachers/TeachersPage.tsx
//
// The teacher roster. AddTeacherPage and EditTeacherPage both existed, but the
// list they are reached from did not — so /teachers, a top-level sidebar entry,
// went nowhere.

import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  Mail,
  School,
  Users,
  BookMarked,
  AlertCircle,
  ClipboardList,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/ui/Pagination";
import { Table, THead, Th, TBody } from "@/components/ui/DataTable";
import { useToast } from "@/components/ui/Toast";
import {
  fetchTeachers,
  deleteTeacher,
} from "@/services/teacher.service";
import api from "@/lib/axios";
import { API } from "@/services/apiEndpoints";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/utils/cn";
import type { Teacher } from "@/types";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 20;

const QK = {
  teachers: (schoolId: string, page: number, status: string) =>
    ["teachers", schoolId, page, status] as const,
};

// Keys, not text: this is module scope, where there is no translator, and a
// constant evaluated once at import could never react to a language change.
const STATUS_OPTIONS = [
  { value: "",         labelKey: "teachers.all"      },
  { value: "active",   labelKey: "teachers.activeOnly"   },
  { value: "inactive", labelKey: "teachers.inactiveOnly" },
];

export default function TeachersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page,   setPage]   = useState(1);

  const deferredSearch = useDeferredValue(search);

  const { data, isLoading, error } = useQuery({
    queryKey: QK.teachers(schoolId, page, status),
    queryFn:  () => fetchTeachers({
      schoolId,
      page,
      limit: PAGE_SIZE,
      ...(status ? { status } : {}),
    }),
    enabled:  !!schoolId,
  });

  // Memoised so its identity is stable — `?? []` would hand the useMemos
  // below a new array on every render and defeat them entirely.
  const teachers = useMemo(() => data?.teachers ?? [], [data]);

  // Filtered client-side rather than round-tripping every keystroke. The page
  // is already capped at PAGE_SIZE rows, so this is cheap and instant — but it
  // does mean the search only covers the current page, which the hint below
  // says out loud rather than leaving the user to discover.
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return teachers;
    return teachers.filter((t) =>
      t.name?.toLowerCase().includes(q) ||
      t.email?.toLowerCase().includes(q) ||
      t.phone?.toLowerCase().includes(q),
    );
  }, [teachers, deferredSearch]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["teachers"] });

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteTeacher(id),
    onSuccess: () => {
      toast({ title: t("teachers.removed"), kind: "success" });
      invalidate();
    },
    onError: (err) =>
      toast({ title: t("teachers.errRemove"), message: getErrorMessage(err), kind: "error" }),
  });

  const resetMutation = useMutation({
    mutationFn: (id: string) =>
      api.post(API.admin.teachers.resetPassword(id)).then((r) => r.data),
    onSuccess: (result: { tempPassword?: string; emailSent?: boolean }) => {
      // The temporary password is shown only if the server could not email it.
      // Putting it on screen when the teacher already has it in their inbox is
      // an unnecessary place for it to be read over someone's shoulder.
      toast({
        title:    t("teachers.passwordReset"),
        message:  result?.emailSent
          ? "A new password has been emailed to the teacher."
          : result?.tempPassword
            ? `Temporary password: ${result.tempPassword}`
            : "The teacher must set a new password at next sign-in.",
        kind:     "success",
        duration: result?.emailSent ? 4000 : 0,
      });
    },
    onError: (err) =>
      toast({ title: t("teachers.errResetPassword"), message: getErrorMessage(err), kind: "error" }),
  });

  const askRemove = async (teacher: Teacher) => {
    const ok = await confirm({
      title:        t("teachers.removeConfirm"),
      message:      t("teachers.removeBody", { name: teacher.name }),
      confirmLabel: t("teachers.removeConfirmLabel"),
      kind:         "danger",
    });
    if (ok) removeMutation.mutate(teacher._id);
  };

  const askReset = async (teacher: Teacher) => {
    const ok = await confirm({
      title:   t("teachers.resetTitle"),
      message: t("teachers.resetBody", { name: teacher.name }),
      confirmLabel: t("teachers.resetPassword"),
      kind:         "warning",
    });
    if (ok) resetMutation.mutate(teacher._id);
  };

  const totals = useMemo(() => ({
    all:      data?.total ?? teachers.length,
    active:   teachers.filter((t) => t.isActive).length,
    subjects: new Set(
      teachers.flatMap((t) => (t.subjects ?? []).map((s) => s._id)),
    ).size,
  }), [teachers, data?.total]);

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{t("teachers.loadFailed")}</h3>
            <p className="text-sm text-gray-500 mt-0.5">{getErrorMessage(error)}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t("teachers.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("teachers.blurb")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<ClipboardList className="w-4 h-4" />}
            onClick={() => navigate("/teachers/assignments")}
          >
            {t("nav.assignments")}
          </Button>
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate("/teachers/new")}
          >
            {t("teachers.add")}
          </Button>
        </div>
      </div>

      {/* ── Totals ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <Stat icon={Users}      label={t("teachers.title")}          value={totals.all} />
        <Stat icon={School}     label={t("common.active")}            value={totals.active} />
        <Stat icon={BookMarked} label={t("teachers.subjectsCovered")}  value={totals.subjects} />
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="p-4 border-b border-gray-100">
          <CardHeader
            title={t("teachers.all")}
            subtitle={
              deferredSearch
                ? `${filtered.length} match on this page`
                : `${teachers.length} on this page of ${totals.all}`
            }
            action={
              <div className="flex items-center gap-2">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t("teachers.searchPh")}
                  className="w-52"
                />
                <Select
                  options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  value={status}
                  onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                />
              </div>
            }
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Users className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-gray-700">
              {teachers.length === 0 ? "No teachers yet" : "Nothing matches that search"}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {teachers.length === 0
                ? "Add a teacher to give them an account and assign them subjects."
                : "Search only covers the current page — try another page or clear the filter."}
            </p>
            {teachers.length === 0 && (
              <Button
                className="mt-4"
                size="sm"
                icon={<Plus className="w-4 h-4" />}
                onClick={() => navigate("/teachers/new")}
              >
                {t("teachers.add")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>{t("academic.teacher")}</Th>
                  <Th>{t("common.contact")}</Th>
                  <Th>{t("academic.subject_other")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </THead>
              <TBody>
                {filtered.map((teacher) => (
                  <tr key={teacher._id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center shrink-0">
                          <span className="text-xs font-semibold text-primary-700">
                            {initials(teacher.name)}
                          </span>
                        </div>
                        <p className="font-medium text-gray-800">{teacher.name}</p>
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <a
                        href={`mailto:${teacher.email}`}
                        className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-primary-600"
                      >
                        <Mail className="w-3.5 h-3.5" />
                        {teacher.email}
                      </a>
                      {teacher.phone && (
                        <p className="text-xs text-gray-400 mt-0.5">{teacher.phone}</p>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {teacher.subjects?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {teacher.subjects.slice(0, 3).map((s) => (
                            <Badge key={s._id} label={s.name} variant="info" />
                          ))}
                          {teacher.subjects.length > 3 && (
                            <Badge
                              label={`+${teacher.subjects.length - 3}`}
                              variant="default"
                            />
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">
                          {t("teachers.notAssigned")}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <Badge
                        label={teacher.isActive ? t("common.active") : t("common.inactive")}
                        variant={teacher.isActive ? "success" : "default"}
                      />
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconAction
                          title={t("common.edit")}
                          onClick={() => navigate(`/teachers/${teacher._id}/edit`)}
                        >
                          <Pencil className="w-4 h-4" />
                        </IconAction>
                        <IconAction
                          title={t("teachers.resetPassword")}
                          onClick={() => askReset(teacher)}
                        >
                          <KeyRound className="w-4 h-4" />
                        </IconAction>
                        <IconAction
                          title={t("common.remove")}
                          danger
                          onClick={() => askRemove(teacher)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </IconAction>
                      </div>
                    </td>
                  </tr>
                ))}
              </TBody>
            </Table>

            <div className="border-t border-gray-100">
              <Pagination
                page={data?.page ?? page}
                pages={data?.pages ?? 1}
                total={totals.all}
                onPageChange={setPage}
              />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const initials = (name?: string): string =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon:  React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <Card className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-primary-600" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold text-gray-900 leading-tight">{value}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
      </div>
    </Card>
  );
}

function IconAction({
  title,
  onClick,
  children,
  danger = false,
}: {
  title:    string;
  onClick:  () => void;
  children: React.ReactNode;
  danger?:  boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "p-1.5 rounded-lg transition-colors",
        danger
          ? "text-gray-400 hover:text-red-600 hover:bg-red-50"
          : "text-gray-400 hover:text-primary-600 hover:bg-primary-50",
      )}
    >
      {children}
    </button>
  );
}
