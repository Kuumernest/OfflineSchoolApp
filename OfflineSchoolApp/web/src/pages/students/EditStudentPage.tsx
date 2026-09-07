// web/src/pages/students/EditStudentPage.tsx
//
// Correcting a pupil's record — the screen that did not exist.
//
// The office could admit a pupil, approve, suspend, restore, move and delete
// them, and could not fix a mistyped surname. That name prints on report cards,
// identity cards, receipts and transcripts, and deleting the pupil to re-enter
// them detaches their marks, register, fees and every card already issued,
// because twenty collections carry a studentId.
//
// This form is deliberately narrower than the record. Class, status and
// enrolment number are not here: each has its own route and its own side
// effects — a move re-bills the pupil for the destination class, and enrolment
// numbers come from a gapless per-school counter. A correction form that
// quietly did any of that would be the more dangerous kind of convenience.

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Save, History, Loader2, AlertCircle } from "lucide-react";

import { Card, CardHeader }        from "@/components/ui/Card";
import { Button }                  from "@/components/ui/Button";
import { FormField, Input, Textarea, SelectField } from "@/components/ui/FormField";
import { Spinner }                 from "@/components/ui/Spinner";
import { useToast }                from "@/components/ui/Toast";
import { getErrorMessage }         from "@/lib/axios";
import {
  fetchStudentForEdit,
  updateStudent,
  getStudentHistory,
  type StudentEditPayload,
} from "@/services/student.service";

/*
 * The editable fields, in the order the form shows them.
 *
 * This list mirrors EDITABLE_FIELDS on the server. It is duplicated rather than
 * shared because the two lists answer different questions — the server's is a
 * security boundary and must not depend on a client agreeing with it — but they
 * must not drift, so both carry the same comment about what is deliberately
 * absent.
 */
type FieldName =
  | "firstName" | "lastName" | "dateOfBirth" | "gender"
  | "email" | "phone" | "alternatePhone" | "address" | "city" | "state" | "nationalId"
  | "guardianName" | "guardianPhone" | "guardianEmail" | "guardianRelation"
  | "bloodGroup" | "medicalConditions" | "notes";

const IDENTITY: FieldName[] = ["firstName", "lastName", "dateOfBirth", "gender"];
const CONTACT:  FieldName[] = ["email", "phone", "alternatePhone", "address", "city", "state", "nationalId"];
const GUARDIAN: FieldName[] = ["guardianName", "guardianPhone", "guardianEmail", "guardianRelation"];
const WELFARE:  FieldName[] = ["bloodGroup", "medicalConditions", "notes"];
const ALL_FIELDS = [...IDENTITY, ...CONTACT, ...GUARDIAN, ...WELFARE];

/** Label keys, reusing the vocabulary the rest of the app already uses. */
const LABEL_KEY: Record<FieldName, string> = {
  firstName:         "common.firstName",
  lastName:          "common.lastName",
  dateOfBirth:       "common.dateOfBirth",
  gender:            "common.gender",
  email:             "common.email",
  phone:             "common.phone",
  alternatePhone:    "students.alternatePhone",
  address:           "common.address",
  city:              "students.city",
  state:             "students.state",
  nationalId:        "students.nationalId",
  guardianName:      "academic.guardian",
  guardianPhone:     "students.guardianPhone",
  guardianEmail:     "students.guardianEmail",
  guardianRelation:  "students.guardianRelation",
  bloodGroup:        "students.bloodGroup",
  medicalConditions: "students.medicalConditions",
  notes:             "common.notes",
};

type FormState = Record<FieldName, string>;

const emptyForm = (): FormState =>
  Object.fromEntries(ALL_FIELDS.map((f) => [f, ""])) as FormState;

export default function EditStudentPage() {
  const { t }    = useTranslation();
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const { toast } = useToast();

  const [form, setForm]         = useState<FormState>(emptyForm);
  const [initial, setInitial]   = useState<FormState>(emptyForm);
  const [reason, setReason]     = useState("");
  const [showHistory, setShow]  = useState(false);
  /*
   * The updatedAt the form was loaded with.
   *
   * Sent back as baseUpdatedAt so the server can tell that somebody else edited
   * this record between the load and the save. The write still goes through —
   * last-write-wins is the rule everywhere in this system — but the version it
   * replaced is snapshotted into SyncOverwrite, and the person whose edit lost
   * can be shown what happened.
   */
  const [baseUpdatedAt, setBase] = useState<string | null>(null);

  const studentQuery = useQuery({
    queryKey: ["student", id],
    queryFn:  () => fetchStudentForEdit(id!),
    enabled:  Boolean(id),
  });

  const historyQuery = useQuery({
    queryKey: ["student-history", id],
    queryFn:  () => getStudentHistory(id!),
    enabled:  Boolean(id) && showHistory,
  });

  // Seed the form once the record arrives, and keep a pristine copy to diff
  // against so only genuinely changed fields are sent.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const s = studentQuery.data as Record<string, unknown> | undefined;
    if (!s) return;
    const next = emptyForm();
    for (const f of ALL_FIELDS) next[f] = s[f] == null ? "" : String(s[f]);
    setForm(next);
    setInitial(next);
    setBase(typeof s.updatedAt === "string" ? s.updatedAt : null);
  }, [studentQuery.data]);

  const dirty = useMemo(
    () => ALL_FIELDS.filter((f) => form[f] !== initial[f]),
    [form, initial]
  );

  const set = useCallback(
    (field: FieldName) => (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
    ) => setForm((prev) => ({ ...prev, [field]: e.target.value })),
    []
  );

  const mutation = useMutation({
    mutationFn: (payload: StudentEditPayload) => updateStudent(id!, payload),
    onSuccess: (res) => {
      const changed = res?.changed ?? [];
      if (changed.length === 0) {
        toast({ title: t("studentEdit.noChanges"), message: t("studentEdit.noChangesBody"), kind: "info" });
        return;
      }
      toast({
        title:   t("studentEdit.saved"),
        message: t("studentEdit.savedCount", { count: changed.length }),
        kind:    "success",
      });
      // The pupil's name is denormalised into the roster, the register and the
      // report-card lists, so a corrected surname has to invalidate more than
      // this one record.
      void qc.invalidateQueries({ queryKey: ["student", id] });
      void qc.invalidateQueries({ queryKey: ["students"] });
      void qc.invalidateQueries({ queryKey: ["student-history", id] });
      navigate(`/students/${id}`);
    },
    onError: (err) =>
      toast({ title: t("studentEdit.errSave"), message: getErrorMessage(err), kind: "error" }),
  });

  const handleSave = useCallback(() => {
    if (dirty.length === 0) {
      toast({ title: t("studentEdit.noChanges"), message: t("studentEdit.noChangesBody"), kind: "info" });
      return;
    }
    // Only what moved. An empty string is sent as null so the server clears the
    // field rather than storing "" — "we do not have a number for this pupil"
    // is an answer, and a blank string reads as data.
    const payload: StudentEditPayload = { baseUpdatedAt };
    for (const f of dirty) {
      (payload as Record<string, unknown>)[f] = form[f].trim() === "" ? null : form[f].trim();
    }
    if (reason.trim()) payload.changeReason = reason.trim();
    mutation.mutate(payload);
  }, [dirty, form, reason, baseUpdatedAt, mutation, toast, t]);

  if (studentQuery.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  if (studentQuery.isError || !studentQuery.data) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <AlertCircle className="h-8 w-8 text-danger" aria-hidden="true" />
          <p className="text-sm text-ink-muted">{t("studentDetail.notFound")}</p>
          <Link to="/students"><Button variant="secondary">{t("notFound.goBack")}</Button></Link>
        </div>
      </Card>
    );
  }

  // Past the guards above, so the record is loaded.
  const student = studentQuery.data;

  const renderField = (field: FieldName) => {
    if (field === "gender") {
      return (
        <FormField key={field} label={t(LABEL_KEY[field])}>
          <SelectField
            value={form.gender}
            onChange={set("gender")}
            placeholder={t("studentEdit.emptyValue")}
            options={[
              { value: "male",   label: t("common.male")    },
              { value: "female", label: t("common.female")  },
              { value: "other",  label: t("common.unknown") },
            ]}
          />
        </FormField>
      );
    }
    if (field === "medicalConditions" || field === "notes" || field === "address") {
      return (
        <FormField key={field} label={t(LABEL_KEY[field])} className="sm:col-span-2">
          <Textarea rows={3} value={form[field]} onChange={set(field)} />
        </FormField>
      );
    }
    return (
      <FormField key={field} label={t(LABEL_KEY[field])}>
        <Input
          type={field === "email" || field === "guardianEmail" ? "email" : "text"}
          value={form[field]}
          onChange={set(field)}
          placeholder={field === "dateOfBirth" ? t("academic.dateOfBirthPh") : undefined}
        />
      </FormField>
    );
  };

  const section = (titleKey: string, fields: FieldName[], hintKey?: string) => (
    <Card>
      <CardHeader title={t(titleKey)} />
      {hintKey && <p className="px-4 pb-2 text-xs text-ink-faint">{t(hintKey)}</p>}
      <div className="grid gap-4 p-4 sm:grid-cols-2">{fields.map(renderField)}</div>
    </Card>
  );

  return (
    <div className="space-y-5">

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/students/${id}`}
            className="rounded-lg p-2 transition hover:bg-canvas"
            aria-label={t("notFound.goBack")}
          >
            <ArrowLeft className="h-5 w-5 text-ink-muted" aria-hidden="true" />
          </Link>
          {/*
            The pupil's name leads, not the screen's own title. You are
            correcting one child's record, and the first question when a
            correction goes wrong is "whose?". It reads from the record as
            loaded, so it stays right while the name fields below are edited.
          */}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-ink">
              {student.studentName || t("studentEdit.title")}
            </h1>
            <p className="truncate text-xs text-ink-muted">
              {[student.enrollmentNo, student.className]
                .filter(Boolean).join(" · ") || t("studentEdit.blurb")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShow((v) => !v)}>
            <History className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("studentEdit.history")}
          </Button>
          <Button onClick={handleSave} disabled={mutation.isPending || dirty.length === 0}>
            {mutation.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
              : <Save    className="mr-1.5 h-4 w-4"              aria-hidden="true" />}
            {t("studentEdit.save")}
          </Button>
        </div>
      </div>

      {section("studentEdit.identity", IDENTITY, "studentEdit.identityHint")}
      {section("studentEdit.contact",  CONTACT)}
      {section("studentEdit.guardian", GUARDIAN)}
      {section("studentEdit.welfare",  WELFARE)}

      <Card>
        <CardHeader title={t("studentEdit.reason")} />
        <div className="p-4">
          <FormField label={t("studentEdit.reason")} hint={t("studentEdit.reasonHint")}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("studentEdit.reasonPh")}
            />
          </FormField>
          <p className="mt-3 text-xs text-ink-faint">{t("studentEdit.lockedElsewhere")}</p>
        </div>
      </Card>

      {showHistory && (
        <Card>
          <CardHeader title={t("studentEdit.history")} />
          <div className="p-4">
            {historyQuery.isLoading ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : (historyQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-ink-muted">{t("studentEdit.historyEmpty")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {(historyQuery.data ?? []).map((h) => (
                  <li key={h._id} className="py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink">
                        {t(LABEL_KEY[h.field as FieldName] ?? h.field, { defaultValue: h.field })}
                      </span>
                      <span className="text-ink-faint">{t("studentEdit.was")}</span>
                      <span className="text-ink-body">
                        {h.previousValue == null || h.previousValue === ""
                          ? t("studentEdit.emptyValue")
                          : String(h.previousValue)}
                      </span>
                      <span aria-hidden="true" className="text-ink-faint">→</span>
                      <span className="text-ink-body">
                        {h.newValue == null || h.newValue === ""
                          ? t("studentEdit.emptyValue")
                          : String(h.newValue)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {new Date(h.changedAt).toLocaleString()}
                      {h.changedByName ? " · " + t("studentEdit.historyBy", { name: h.changedByName }) : ""}
                      {h.reason ? " · " + h.reason : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
