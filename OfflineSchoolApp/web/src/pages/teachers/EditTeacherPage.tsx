// web/src/pages/teachers/EditTeacherPage.tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams }  from "react-router-dom";
import { useAuthStore }            from "@/store/auth.store";
import api                         from "@/services/api";
import { getErrorMessage }         from "@/lib/axios";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";
import axios               from "axios";
import NeedsInternet       from "@/components/offline/NeedsInternet";
import { useNeedsInternet } from "@/hooks/useNeedsInternet";
import { createIds }       from "@/lib/clientId";
import { STAFF_NO_MAX, normaliseStaffNoInput, staffNoErrorKey } from "@/utils/staffNo";
import {
  ArrowLeft, Save, Loader2, AlertCircle,
  BookOpen, Plus, X, RefreshCw, User, Mail, Hash, BookMarked, UserCog,
} from "lucide-react";
import { cn }               from "@/utils/cn";
import { ACCENT_BADGE, DASH_TINT } from "@/config/dashboardTint";
import { PageIcon }         from "@/components/ui/PageHeader";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface AssignedSubject {
  id:           string;
  assignmentId: string;
  subjectId:    string;
  name:         string;
  className:    string;
  classId?:     string;
}

interface AvailableSubject {
  id:        string;
  subjectId: string;
  name:      string;
  className: string;
  classId?:  string;
}

interface Teacher {
  _id:      string;
  name:     string;
  email:    string;
  staffNo?: string | null;
}

interface FormErrors {
  name?:    string;
  email?:   string;
  staffNo?: string;
}

/**
 * A subject row exactly as the assignment endpoints send it.
 *
 * Three endpoints feed these screens and none agree on names: an assignment
 * row calls the subject `subjectId` while the subject catalogue calls the same
 * value `id`, and class names arrive as either `className` or `class_name`.
 * Every field is therefore optional and resolved by the normalisers below.
 */
/** A ref the API sends either populated or as a bare id string. */
type RawRef = { _id?: string; name?: string } | string | null | undefined;

const refId   = (ref: RawRef): string =>
  (typeof ref === "string" ? ref : ref?._id) ?? "";
const refName = (ref: RawRef): string =>
  (typeof ref === "string" ? "" : ref?.name) ?? "";

interface RawSubjectRow {
  id?:           string;
  _id?:          string;
  assignmentId?: string;
  subjectId?:    string;
  name?:         string;
  subjectName?:  string;
  className?:    string;
  class_name?:   string;
  classId?:      string;
  // Populated shapes: the assignments endpoint nests the subject and the class,
  // and one older response spells the class `classObj`.
  subject?:      RawRef;
  class?:        RawRef;
  classObj?:     { name?: string } | null;
}

// ─────────────────────────────────────────────────────────
// NORMALISERS
// ─────────────────────────────────────────────────────────

const normaliseAssigned = (raw: RawSubjectRow): AssignedSubject => ({
  ...raw,
  id:           raw.subjectId    ?? raw.id           ?? raw.assignmentId ?? "",
  assignmentId: raw.assignmentId ?? raw.id           ?? "",
  subjectId:    raw.subjectId    ?? raw.id           ?? "",
  name:         raw.name         ?? raw.subjectName  ?? "Unknown Subject",
  className:    raw.className    ?? raw.class_name   ?? "Unknown Class",
});

const normaliseAvailable = (raw: RawSubjectRow): AvailableSubject => ({
  ...raw,
  id:        raw.id      ?? raw.subjectId ?? "",
  subjectId: raw.id      ?? raw.subjectId ?? "",
  name:      raw.name    ?? "Unknown Subject",
  className: raw.className ?? raw.class_name ?? "Unknown Class",
});

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function EditTeacherPage() {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const navigate              = useNavigate();
  const { id: teacherId }     = useParams<{ id: string }>();
  const user                  = useAuthStore((s) => s.user);
  const schoolId              = user?.schoolId;
  // Editing a teacher is online-only on the desktop (desktop coverage.js:
  // PUT /admin/teachers/:id), the staff number included.
  const net                   = useNeedsInternet();

  // The id each new assignment is created under: kept while the same subject
  // is retried, renewed once it is shown assigned (lib/clientId.ts). It is what
  // lets the desktop assign a subject with no connection — and assignments are
  // NOT online-only, unlike the profile above.
  const assignIds = useRef(createIds());

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ── Data state ──────────────────────────────────────────
  const [teacher,   setTeacher]   = useState<Teacher | null>(null);
  const [assigned,  setAssigned]  = useState<AssignedSubject[]>([]);
  const [available, setAvailable] = useState<AvailableSubject[]>([]);

  // ── UI state ────────────────────────────────────────────
  const [name,         setName]         = useState("");
  const [email,        setEmail]        = useState("");
  const [staffNo,      setStaffNo]      = useState("");
  const [errors,       setErrors]       = useState<FormErrors>({});
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [actioningIds, setActioningIds] = useState<Set<string>>(new Set());

  // ── Load ────────────────────────────────────────────────

  const loadAll = useCallback(
    async (isRefresh = false) => {
      if (!teacherId) {
        setLoadError(t("teachers.noId"));
        setLoading(false);
        return;
      }

      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);
        setLoadError(null);

        const [teacherRes, assignedRes, availableRes] = await Promise.all([
          api.get(`/admin/teachers/${teacherId}`, { params: { schoolId } }),
          api.get("/admin/assignments",           { params: { schoolId, teacherId } }),
          api.get("/admin/subjects",              { params: { schoolId } }),
        ]);

        if (!isMounted.current) return;

        const t = teacherRes.data?.data || teacherRes.data?.teacher || teacherRes.data;
        if (!t) { setLoadError(t("teachers.notFound")); return; }

        setTeacher(t);
        setName(t.name  ?? "");
        setEmail(t.email ?? "");
        setStaffNo(t.staffNo ?? "");

        // ── Assigned subjects ─────────────────────────────
        const rawAssigned: RawSubjectRow[] =
          assignedRes.data?.assignments ??
          assignedRes.data?.data        ??
          (Array.isArray(assignedRes.data) ? assignedRes.data : []);

        const normAssigned = rawAssigned
          .filter((a) => a.subject)
          .map((a) =>
            normaliseAssigned({
              assignmentId: String(a._id || a.id),
              subjectId:    refId(a.subject),
              id:           refId(a.subject),
              name:         refName(a.subject) || t("common.unknown"),
              className:    refName(a.class)   || t("common.unknown"),
              classId:      refId(a.class) || a.classId || "",
            })
          );

        setAssigned(normAssigned);

        // ── Available = all subjects minus assigned ────────
        const rawSubjects: RawSubjectRow[] =
          availableRes.data?.subjects ??
          availableRes.data?.data     ??
          (Array.isArray(availableRes.data) ? availableRes.data : []);

        const assignedIds = new Set(normAssigned.map((s) => s.subjectId));

        const normAvailable = rawSubjects
          .filter((s) => !assignedIds.has(String(s._id || s.id)))
          .map((s) =>
            normaliseAvailable({
              id:        String(s._id  || s.id),
              subjectId: String(s._id  || s.id),
              name:      s.name        ?? t("common.unknown"),
              className: refName(s.class) || s.classObj?.name || s.className || t("common.unknown"),
              classId:   refId(s.class) || s.classId || "",
            })
          );

        setAvailable(normAvailable);
      } catch (err) {
        if (isMounted.current) {
          setLoadError(getErrorMessage(err) || "Failed to load teacher.");
        }
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [teacherId, schoolId, t]
  );

  // loadAll is useCallback([teacherId, schoolId]) and guards every write with
  // isMounted.current, so nothing lands after the screen has gone.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Validation ──────────────────────────────────────────

  /*
   * useCallback so handleSave can declare it as a dependency.
   *
   * It was a plain function, recreated every render, which is why handleSave
   * could not list it. That happened to be safe — validate reads only name and
   * email, and handleSave already depended on both, so every rebuild of one
   * rebuilt the other. Safe by coincidence rather than by construction, and the
   * next field added to validate would have broken it silently.
   */
  // The three messages below are the ones the Add Teacher page already uses
  // (teachersAdd.err*), translated in both locales. They were hardcoded
  // English here, on a screen otherwise fully translated, so a francophone
  // admin got a French form with English validation.
  const validate = useCallback((): boolean => {
    const next: FormErrors = {};
    if (!name.trim())  next.name  = t("teachersAdd.errNameRequired");
    if (!email.trim()) next.email = t("teachersAdd.errEmailRequired");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = t("teachersAdd.errEmailInvalid");
    // Only when it has one to change: a teacher not numbered yet has nothing
    // here, and an untouched empty field is not an attempt to clear it.
    const cleanStaffNo = normaliseStaffNoInput(staffNo);
    if (teacher?.staffNo || cleanStaffNo) {
      const key = staffNoErrorKey(cleanStaffNo);
      if (key) next.staffNo = t(key);
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [name, email, staffNo, teacher, t]);

  // ── Save profile ────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!validate() || saving || net.blocked) return;
    setSaving(true);
    // Sent only when changed, so a plain rename never touches (or audits)
    // the number.
    const cleanStaffNo = normaliseStaffNoInput(staffNo);
    const staffNoChanged = Boolean(cleanStaffNo) && cleanStaffNo !== (teacher?.staffNo ?? "");
    try {
      await api.put(`/admin/teachers/${teacherId}`, {
        name:  name.trim(),
        email: email.trim().toLowerCase(),
        ...(staffNoChanged ? { staffNo: cleanStaffNo } : {}),
        schoolId,
      });
      if (isMounted.current) navigate("/teachers");
    } catch (err) {
      if (isMounted.current) {
        // The server's refusal of the number goes under the number.
        const code = axios.isAxiosError(err) ? err.response?.data?.code : undefined;
        if (code === "STAFF_NO_TAKEN") {
          setErrors({ staffNo: t("teachersEdit.errStaffNoTaken", { number: cleanStaffNo }) });
        } else if (code === "STAFF_NO_INVALID") {
          setErrors({ staffNo: getErrorMessage(err) });
        } else {
          setErrors({
            name: getErrorMessage(err) || "Failed to save.",
          });
        }
      }
    } finally {
      if (isMounted.current) setSaving(false);
    }
  }, [name, email, staffNo, teacher, saving, net.blocked, teacherId, schoolId, navigate, validate, t]);

  // ── Unassign ────────────────────────────────────────────

  const handleUnassign = useCallback(
    async (subject: AssignedSubject) => {
      const ok = await confirm({
        title:   t("common.remove"),
        message: t("teachers.unassignConfirm", { name: subject.name }),
        kind:    "danger",
      });
      if (!ok) return;

      const sid = subject.subjectId || subject.id;
      setActioningIds((p) => new Set([...p, sid]));

      // Optimistic remove
      setAssigned((p) => p.filter((s) => (s.subjectId || s.id) !== sid));
      setAvailable((p) => [
        ...p,
        normaliseAvailable({
          id:        sid,
          subjectId: sid,
          name:      subject.name,
          className: subject.className,
          classId:   subject.classId,
        }),
      ]);

      try {
        const assignmentsRes = await api.get("/admin/assignments", {
          params: { schoolId, teacherId, subjectId: sid },
        });
        const list: RawSubjectRow[] =
          assignmentsRes.data?.assignments ??
          assignmentsRes.data?.data        ??
          [];
        const match = list.find(
          (a) => refId(a.subject) === sid
        );
        if (match) {
          await api.delete(`/admin/assignments/${match._id || match.id}`);
        }
      } catch (err) {
        // Roll back on failure
        if (isMounted.current) {
          setAssigned((p) => {
            const exists = p.some((s) => (s.subjectId || s.id) === sid);
            return exists ? p : [...p, subject];
          });
          setAvailable((p) => p.filter((s) => (s.subjectId || s.id) !== sid));
          toast({
            kind:  "error",
            title: getErrorMessage(err) || t("teachers.removeSubjectFailed"),
          });
        }
      } finally {
        if (isMounted.current) {
          setActioningIds((p) => {
            const n = new Set(p);
            n.delete(sid);
            return n;
          });
        }
      }
    },
    [teacherId, schoolId, confirm, t, toast]
  );

  // ── Assign ──────────────────────────────────────────────

  const handleAssign = useCallback(
    async (subject: AvailableSubject) => {
      const sid = subject.subjectId || subject.id;
      if (actioningIds.has(sid)) return;

      setActioningIds((p) => new Set([...p, sid]));

      // Optimistic add
      const optimistic = normaliseAssigned({
        assignmentId: `temp_${sid}`,
        subjectId:    sid,
        id:           sid,
        name:         subject.name,
        className:    subject.className,
        classId:      subject.classId,
      });
      setAssigned((p) => [...p, optimistic]);
      setAvailable((p) => p.filter((s) => (s.subjectId || s.id) !== sid));

      const attempt = {
        teacherId,
        subjectId: sid,
        classId:   subject.classId,
        schoolId,
      };
      try {
        await api.post("/admin/assignments", { ...attempt, id: assignIds.current.forAttempt(attempt) });

        // Refresh both lists for server-confirmed data
        const [assignedRes, availableRes] = await Promise.all([
          api.get("/admin/assignments", { params: { schoolId, teacherId } }),
          api.get("/admin/subjects",    { params: { schoolId } }),
        ]);

        if (!isMounted.current) return;

        const rawAssigned: RawSubjectRow[] =
          assignedRes.data?.assignments ??
          assignedRes.data?.data        ??
          [];

        const normAssigned = rawAssigned
          .filter((a) => a.subject)
          .map((a) =>
            normaliseAssigned({
              assignmentId: String(a._id || a.id),
              subjectId:    refId(a.subject),
              id:           refId(a.subject),
              name:         refName(a.subject) || t("common.unknown"),
              className:    refName(a.class)   || t("common.unknown"),
              classId:      refId(a.class) || a.classId || "",
            })
          );

        setAssigned(normAssigned);
        // Renewed only here, once the assignment is on screen: if the refresh
        // fails the row rolls back, and a retry must be answered with the
        // assignment already made, not refused as a second one.
        assignIds.current.created(attempt);

        const rawSubjects: RawSubjectRow[] =
          availableRes.data?.subjects ??
          availableRes.data?.data     ??
          [];

        const assignedIds = new Set(normAssigned.map((s) => s.subjectId));
        setAvailable(
          rawSubjects
            .filter((s) => !assignedIds.has(String(s._id || s.id)))
            .map((s) =>
              normaliseAvailable({
                id:        String(s._id || s.id),
                subjectId: String(s._id || s.id),
                name:      s.name        ?? t("common.unknown"),
                className: refName(s.class) || s.classObj?.name || s.className || t("common.unknown"),
                classId:   refId(s.class) || s.classId || "",
              })
            )
        );
      } catch (err) {
        // Roll back
        if (isMounted.current) {
          setAssigned((p) => p.filter((s) => (s.subjectId || s.id) !== sid));
          setAvailable((p) => {
            const exists = p.some((s) => (s.subjectId || s.id) === sid);
            return exists ? p : [...p, subject];
          });
          toast({
            kind:  "error",
            title: getErrorMessage(err) || t("teachers.assignSubjectFailed"),
          });
        }
      } finally {
        if (isMounted.current) {
          setActioningIds((p) => {
            const n = new Set(p);
            n.delete(sid);
            return n;
          });
        }
      }
    },
    [teacherId, schoolId, actioningIds, t, toast]
  );

  // ─────────────────────────────────────────────────────────
  // RENDER — Loading
  // ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <PageHeader title={t("teachersEdit.title")} onBack={() => navigate("/teachers")} />
        <div className="flex-1 flex items-center justify-center gap-3">
          <Loader2 size={32} className="animate-spin text-primary-600" />
          <span className="text-gray-500 text-sm">{t("teachersEdit.loading")}</span>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — Error
  // ─────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <PageHeader title={t("teachersEdit.title")} onBack={() => navigate("/teachers")} />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <AlertCircle size={48} className="text-red-400" />
          <p className="text-sm text-red-600 text-center max-w-sm">{loadError}</p>
          <button
            onClick={() => loadAll()}
            className="bg-primary-600 text-white text-sm font-semibold
                       px-5 py-2.5 rounded-lg hover:bg-primary-700 transition-colors"
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — Main
  // ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex
                      items-center gap-4 shrink-0">
        <button
          onClick={() => navigate("/teachers")}
          className="w-9 h-9 flex items-center justify-center rounded-xl
                     bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <ArrowLeft size={20} className="text-gray-700" />
        </button>
        <PageIcon />
        <div className="flex-1">
          <h1 className="text-lg font-bold text-ink truncate">
            {teacher?.name ?? "Edit Teacher"}
          </h1>
          <p className="text-xs text-ink-muted">
            {t("teachersEdit.subjectsAssignedCount", { count: assigned.length })}
          </p>
        </div>
        <button
          onClick={() => loadAll(true)}
          disabled={refreshing}
          className="w-9 h-9 flex items-center justify-center rounded-xl
                     bg-gray-100 hover:bg-gray-200 transition-colors
                     disabled:opacity-50"
          title={t("common.refresh")}
        >
          <RefreshCw
            size={16}
            className={`text-gray-600 ${refreshing ? "animate-spin" : ""}`}
          />
        </button>
        <button
          onClick={handleSave}
          disabled={saving || net.blocked}
          title={net.hint}
          className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700
                     disabled:opacity-60 text-white text-sm font-bold
                     px-4 py-2 rounded-lg transition-colors"
        >
          {saving
            ? <Loader2 size={15} className="animate-spin" />
            : <Save size={15} />
          }
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-6 space-y-5">

        {/* ── Profile fields ── */}
        <NeedsInternet>
        <section className={cn("bg-surface rounded-2xl border border-line shadow-sm p-6 space-y-4", DASH_TINT.violet.edge)}>
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
            <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.violet.box)} aria-hidden="true">
              <UserCog className="h-4 w-4" />
            </span>
            {t("common.profile")}
          </h2>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-gray-700">
              {t("common.fullName")}
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.name
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-primary-500 focus-within:bg-white"}
            `}>
              <User size={16} className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder={t("teachersEdit.namePh")}
                className="flex-1 bg-transparent text-sm text-gray-900
                           placeholder-gray-400 focus:outline-none"
              />
            </div>
            {errors.name && (
              <p className="flex items-center gap-1 text-xs text-red-600">
                <AlertCircle size={12} /> {errors.name}
              </p>
            )}
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-gray-700">
              {t("common.email")}
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.email
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-primary-500 focus-within:bg-white"}
            `}>
              <Mail size={16} className="text-gray-400 shrink-0" />
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
                }}
                placeholder={t("teachersEdit.emailPh")}
                className="flex-1 bg-transparent text-sm text-gray-900
                           placeholder-gray-400 focus:outline-none"
              />
            </div>
            {errors.email && (
              <p className="flex items-center gap-1 text-xs text-red-600">
                <AlertCircle size={12} /> {errors.email}
              </p>
            )}
          </div>

          {/* Staff number — issued by the server; an administrator may change it */}
          <div className="space-y-1.5">
            <label htmlFor="teacher-staff-no" className="block text-sm font-semibold text-gray-700">
              {t("teachersEdit.staffNo")}
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.staffNo
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-primary-500 focus-within:bg-white"}
            `}>
              <Hash size={16} className="text-gray-400 shrink-0" />
              <input
                id="teacher-staff-no"
                type="text"
                value={staffNo}
                maxLength={STAFF_NO_MAX}
                autoCapitalize="characters"
                onChange={(e) => {
                  setStaffNo(e.target.value);
                  if (errors.staffNo) setErrors((p) => ({ ...p, staffNo: undefined }));
                }}
                placeholder={teacher?.staffNo ? undefined : t("teachersEdit.staffNoNone")}
                className="flex-1 bg-transparent text-sm font-mono uppercase text-gray-900
                           placeholder-gray-400 placeholder:font-sans placeholder:normal-case focus:outline-none"
              />
            </div>
            {errors.staffNo ? (
              <p className="flex items-center gap-1 text-xs text-red-600">
                <AlertCircle size={12} /> {errors.staffNo}
              </p>
            ) : (
              <p className="text-xs text-gray-500">{t("teachersEdit.staffNoHint")}</p>
            )}
          </div>
        </section>
        </NeedsInternet>

        {/* ── Assigned subjects ── */}
        <section className={cn("bg-surface rounded-2xl border border-line shadow-sm p-6", DASH_TINT.violet.edge)}>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="flex flex-1 items-center gap-2 text-sm font-bold text-ink">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.violet.box)} aria-hidden="true">
                <BookOpen className="h-4 w-4" />
              </span>
              {t("teachersEdit.assigned")}
            </h2>
            <span className={cn("text-xs font-bold px-2.5 py-1 rounded-full ring-1 ring-inset", ACCENT_BADGE.violet)}>
              {assigned.length}
            </span>
          </div>

          {assigned.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">
              {t("teachersEdit.noneAssigned")}
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {assigned.map((subject) => {
                const sid       = subject.subjectId || subject.id;
                const actioning = actioningIds.has(sid);
                return (
                  <div
                    key={subject.id || subject.assignmentId}
                    className="flex items-center gap-3 py-3"
                  >
                    <div className="w-8 h-8 rounded-lg bg-accent-slate-solid text-white flex items-center
                                    justify-center shrink-0">
                      <BookOpen size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {subject.name}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {subject.className}
                      </p>
                    </div>
                    <button
                      onClick={() => handleUnassign(subject)}
                      disabled={actioning}
                      className="flex items-center gap-1 text-xs font-semibold
                                 text-red-500 hover:text-red-700 disabled:opacity-40
                                 transition-colors px-2 py-1 rounded-lg hover:bg-red-50"
                    >
                      {actioning
                        ? <Loader2 size={13} className="animate-spin" />
                        : <X size={13} />
                      }
                      {t("common.remove")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Available subjects ── */}
        <section className={cn("bg-surface rounded-2xl border border-line shadow-sm p-6", DASH_TINT.violet.edge)}>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="flex flex-1 items-center gap-2 text-sm font-bold text-ink">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.slate.box)} aria-hidden="true">
                <BookMarked className="h-4 w-4" />
              </span>
              {t("teachersEdit.available")}
            </h2>
            <span className={cn("text-xs font-bold px-2.5 py-1 rounded-full ring-1 ring-inset", ACCENT_BADGE.slate)}>
              {available.length}
            </span>
          </div>

          {available.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">
              {t("teachersEdit.noneAvailable")}
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {available.map((subject) => {
                const sid       = subject.subjectId || subject.id;
                const actioning = actioningIds.has(sid);
                return (
                  <div
                    key={subject.id || subject.subjectId}
                    className="flex items-center gap-3 py-3"
                  >
                    <div className="w-8 h-8 rounded-lg bg-accent-slate-solid text-white flex items-center
                                    justify-center shrink-0">
                      <BookOpen size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {subject.name}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {subject.className}
                      </p>
                    </div>
                    <button
                      onClick={() => handleAssign(subject)}
                      disabled={actioning}
                      className="flex items-center gap-1 text-xs font-semibold
                                 text-emerald-600 hover:text-emerald-800
                                 disabled:opacity-40 transition-colors
                                 px-2 py-1 rounded-lg hover:bg-emerald-50"
                    >
                      {actioning
                        ? <Loader2 size={13} className="animate-spin" />
                        : <Plus size={13} />
                      }
                      {t("teachersEdit.assign")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="h-8" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// PAGE HEADER
// ─────────────────────────────────────────────────────────

function PageHeader({
  title,
  onBack,
}: {
  title:  string;
  onBack: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 flex
                    items-center gap-4 shrink-0">
      <button
        onClick={onBack}
        className="w-9 h-9 flex items-center justify-center rounded-xl
                   bg-gray-100 hover:bg-gray-200 transition-colors"
      >
        <ArrowLeft size={20} className="text-gray-700" />
      </button>
      <PageIcon />
      <div>
        <h1 className="text-lg font-bold text-ink">{title}</h1>
        <p className="text-xs text-ink-muted mt-0.5">
          {t("teachersEdit.subtitle")}
        </p>
      </div>
    </div>
  );
}