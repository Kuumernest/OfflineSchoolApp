// web/src/pages/documents/index.tsx
//
// The printing desk: pick a class list or a transcript, look at it, print it.
//
// Preview is offered beside Print rather than instead of it, because these go
// onto paper and the cost of finding a mistake after 40 copies is a ream. The
// preview is the identical HTML the printer receives — not an approximation of
// it — so what is checked is what comes out.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Printer, Eye, FileText, Users, IdCard } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { FormField, SelectField } from "@/components/ui/FormField";
import { SearchInput } from "@/components/ui/SearchInput";
import { useToast }    from "@/components/ui/Toast";
import { cn }          from "@/utils/cn";
import { getErrorMessage } from "@/lib/api";

import { fetchClasses }  from "@/services/class.service";
import { fetchStudents } from "@/services/student.service";
import {
  fetchClassListHtml, fetchTranscriptHtml, fetchIdCardsHtml,
} from "@/services/document.service";
import { printHtml, previewHtml } from "@/print/document";

/** The three sheets a roster is actually used as. */
type ClassListVariant = "plain" | "register" | "contacts";

type Tab = "classList" | "transcript" | "idCards";

export default function DocumentsPage() {
  const { t, i18n } = useTranslation();
  const { toast }   = useToast();
  const schoolId    = useUser()?.schoolId ?? "";

  const [tab, setTab]         = useState<Tab>("classList");
  const [classId, setClassId] = useState("");
  const [variant, setVariant] = useState<ClassListVariant>("plain");
  const [query, setQuery]     = useState("");
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy]       = useState(false);

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const studentsQ = useQuery({
    queryKey: ["students", "printing", schoolId],
    queryFn:  () => fetchStudents({ schoolId, status: "approved" }),
    enabled:  !!schoolId && tab === "transcript",
  });

  const classes = classesQ.data ?? [];

  const students = useMemo(() => {
    const list = studentsQ.data?.students ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      `${s.name ?? ""} ${s.enrollmentNo ?? ""}`.toLowerCase().includes(q)
    );
  }, [studentsQ.data, query]);

  /** Fetch the finished sheet, then print it or open it for a look. */
  const run = async (mode: "print" | "preview") => {
    setBusy(true);
    try {
      // The console's language goes with the request: a head reading the app in
      // French should not get an English register.
      const lang = i18n.resolvedLanguage ?? "en";

      const html =
        tab === "classList"  ? await fetchClassListHtml(classId, schoolId, variant, lang) :
        tab === "idCards"    ? await fetchIdCardsHtml(classId, schoolId, lang) :
                               await fetchTranscriptHtml(studentId, schoolId, lang);

      if (mode === "print") printHtml(html);
      else previewHtml(html);
    } catch (err) {
      toast({ kind: "error", title: t("doc.print"), message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (classesQ.isLoading) return <PageSpinner />;

  // ID cards are picked by class, like a class list — not by student.
  const ready = tab === "transcript" ? Boolean(studentId) : Boolean(classId);

  const VARIANTS: { key: ClassListVariant; hint: string }[] = [
    { key: "plain",    hint: t("cl.plainHint") },
    { key: "register", hint: t("cl.registerHint") },
    { key: "contacts", hint: t("cl.contactsHint") },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("doc.title")}
        description={t("doc.blurb")}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Eye className="h-4 w-4" />}
              disabled={!ready || busy}
              onClick={() => run("preview")}
            >
              {t("doc.preview")}
            </Button>
            <Button
              icon={<Printer className="h-4 w-4" />}
              loading={busy}
              disabled={!ready}
              onClick={() => run("print")}
            >
              {t("doc.print")}
            </Button>
          </>
        }
      />

      {/* Which document */}
      <div className="flex gap-1.5">
        {([
          ["classList",  t("cl.title"),  <Users key="u" className="h-4 w-4" />],
          ["idCards",    t("idc.title"), <IdCard key="i" className="h-4 w-4" />],
          ["transcript", t("tr.title"),  <FileText key="f" className="h-4 w-4" />],
        ] as const).map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key as Tab)}
            className={cn(
              "flex h-9 items-center gap-2 rounded-control px-3.5 text-sm font-medium transition-colors",
              tab === key
                ? "bg-primary-600 text-white"
                : "border border-line-strong bg-surface text-ink-body hover:bg-surface-muted"
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {tab === "classList" || tab === "idCards" ? (
        <Card className="space-y-5">
          <FormField label={t("cl.pick")} required>
            <SelectField
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              placeholder={t("cl.pick")}
              options={classes.map((c) => ({ value: c._id, label: c.name }))}
            />
          </FormField>

          {tab === "idCards" && (
            <p className="rounded-control border border-line bg-canvas px-3 py-2 text-xs text-ink-muted">
              {t("idc.hint")} {t("idc.blank")}
            </p>
          )}

          {tab === "classList" && <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("cl.variant")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {VARIANTS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setVariant(v.key)}
                  className={cn(
                    "rounded-card border p-3 text-left transition-colors",
                    variant === v.key
                      ? "border-primary-600 bg-primary-50/60"
                      : "border-line bg-surface hover:bg-surface-muted"
                  )}
                >
                  <p className="text-sm font-medium text-ink">{t(`cl.${v.key}`)}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">{v.hint}</p>
                </button>
              ))}
            </div>
          </div>}
        </Card>
      ) : (
        <Card className="space-y-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("tr.searchStudent")}
          />

          {studentsQ.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : students.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-muted">{t("tr.noStudents")}</p>
          ) : (
            <div className="max-h-[420px] overflow-y-auto rounded-card border border-line">
              {students.map((s) => (
                <button
                  key={s._id}
                  type="button"
                  onClick={() => setStudentId(s._id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 transition-colors",
                    studentId === s._id ? "bg-primary-50/60" : "hover:bg-canvas"
                  )}
                >
                  <span className="truncate text-sm font-medium text-ink">
                    {s.name || s.enrollmentNo || s._id}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {s.enrollmentNo ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
