// web/src/pages/teachers/EditTeacherPage.tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams }  from "react-router-dom";
import { useAuthStore }            from "@/store/auth.store";
import api                         from "@/services/api";
import {
  ArrowLeft, Save, Loader2, AlertCircle,
  BookOpen, Plus, X, RefreshCw, User, Mail,
} from "lucide-react";

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
  _id:   string;
  name:  string;
  email: string;
}

interface FormErrors {
  name?:  string;
  email?: string;
}

// ─────────────────────────────────────────────────────────
// NORMALISERS
// ─────────────────────────────────────────────────────────

const normaliseAssigned = (raw: any): AssignedSubject => ({
  ...raw,
  id:           raw.subjectId    ?? raw.id           ?? raw.assignmentId ?? "",
  assignmentId: raw.assignmentId ?? raw.id           ?? "",
  subjectId:    raw.subjectId    ?? raw.id           ?? "",
  name:         raw.name         ?? raw.subjectName  ?? "Unknown Subject",
  className:    raw.className    ?? raw.class_name   ?? "Unknown Class",
});

const normaliseAvailable = (raw: any): AvailableSubject => ({
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
  const navigate              = useNavigate();
  const { id: teacherId }     = useParams<{ id: string }>();
  const user                  = useAuthStore((s) => s.user);
  const schoolId              = user?.schoolId;

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
        setLoadError("No teacher ID provided.");
        setLoading(false);
        return;
      }

      try {
        isRefresh ? setRefreshing(true) : setLoading(true);
        setLoadError(null);

        const [teacherRes, assignedRes, availableRes] = await Promise.all([
          api.get(`/admin/teachers/${teacherId}`, { params: { schoolId } }),
          api.get("/admin/assignments",           { params: { schoolId, teacherId } }),
          api.get("/admin/subjects",              { params: { schoolId } }),
        ]);

        if (!isMounted.current) return;

        const t = teacherRes.data?.data || teacherRes.data?.teacher || teacherRes.data;
        if (!t) { setLoadError("Teacher not found."); return; }

        setTeacher(t);
        setName(t.name  ?? "");
        setEmail(t.email ?? "");

        // ── Assigned subjects ─────────────────────────────
        const rawAssigned: any[] =
          assignedRes.data?.assignments ??
          assignedRes.data?.data        ??
          (Array.isArray(assignedRes.data) ? assignedRes.data : []);

        const normAssigned = rawAssigned
          .filter((a) => a.subject)
          .map((a) =>
            normaliseAssigned({
              assignmentId: String(a._id || a.id),
              subjectId:    String(a.subject?._id || a.subject),
              id:           String(a.subject?._id || a.subject),
              name:         a.subject?.name  ?? "Unknown",
              className:    a.class?.name    ?? "Unknown",
              classId:      String(a.class?._id || a.classId || ""),
            })
          );

        setAssigned(normAssigned);

        // ── Available = all subjects minus assigned ────────
        const rawSubjects: any[] =
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
              name:      s.name        ?? "Unknown",
              className: s.class?.name ?? s.classObj?.name ?? s.className ?? "Unknown",
              classId:   String(s.class?._id || s.classId || s.class || ""),
            })
          );

        setAvailable(normAvailable);
      } catch (err: any) {
        if (isMounted.current) {
          setLoadError(
            err?.response?.data?.message || err.message || "Failed to load teacher."
          );
        }
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [teacherId, schoolId]
  );

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Validation ──────────────────────────────────────────

  const validate = (): boolean => {
    const next: FormErrors = {};
    if (!name.trim())  next.name  = "Name is required.";
    if (!email.trim()) next.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = "Enter a valid email address.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  // ── Save profile ────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!validate() || saving) return;
    setSaving(true);
    try {
      await api.put(`/admin/teachers/${teacherId}`, {
        name:  name.trim(),
        email: email.trim().toLowerCase(),
        schoolId,
      });
      if (isMounted.current) navigate("/teachers");
    } catch (err: any) {
      if (isMounted.current) {
        setErrors({
          name: err?.response?.data?.message || err.message || "Failed to save.",
        });
      }
    } finally {
      if (isMounted.current) setSaving(false);
    }
  }, [name, email, saving, teacherId, schoolId, navigate]);

  // ── Unassign ────────────────────────────────────────────

  const handleUnassign = useCallback(
    async (subject: AssignedSubject) => {
      if (!window.confirm(`Remove "${subject.name}" from this teacher?`)) return;

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
        const list: any[] =
          assignmentsRes.data?.assignments ??
          assignmentsRes.data?.data        ??
          [];
        const match = list.find(
          (a) => String(a.subject?._id || a.subject) === sid
        );
        if (match) {
          await api.delete(`/admin/assignments/${match._id || match.id}`);
        }
      } catch (err: any) {
        // Roll back on failure
        if (isMounted.current) {
          setAssigned((p) => {
            const exists = p.some((s) => (s.subjectId || s.id) === sid);
            return exists ? p : [...p, subject];
          });
          setAvailable((p) => p.filter((s) => (s.subjectId || s.id) !== sid));
          alert(
            err?.response?.data?.message || err.message || "Failed to remove subject."
          );
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
    [teacherId, schoolId]
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

      try {
        await api.post("/admin/assignments", {
          teacherId,
          subjectId: sid,
          classId:   subject.classId,
          schoolId,
        });

        // Refresh both lists for server-confirmed data
        const [assignedRes, availableRes] = await Promise.all([
          api.get("/admin/assignments", { params: { schoolId, teacherId } }),
          api.get("/admin/subjects",    { params: { schoolId } }),
        ]);

        if (!isMounted.current) return;

        const rawAssigned: any[] =
          assignedRes.data?.assignments ??
          assignedRes.data?.data        ??
          [];

        const normAssigned = rawAssigned
          .filter((a) => a.subject)
          .map((a) =>
            normaliseAssigned({
              assignmentId: String(a._id || a.id),
              subjectId:    String(a.subject?._id || a.subject),
              id:           String(a.subject?._id || a.subject),
              name:         a.subject?.name  ?? "Unknown",
              className:    a.class?.name    ?? "Unknown",
              classId:      String(a.class?._id || a.classId || ""),
            })
          );

        setAssigned(normAssigned);

        const rawSubjects: any[] =
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
                name:      s.name        ?? "Unknown",
                className: s.class?.name ?? s.classObj?.name ?? s.className ?? "Unknown",
                classId:   String(s.class?._id || s.classId || s.class || ""),
              })
            )
        );
      } catch (err: any) {
        // Roll back
        if (isMounted.current) {
          setAssigned((p) => p.filter((s) => (s.subjectId || s.id) !== sid));
          setAvailable((p) => {
            const exists = p.some((s) => (s.subjectId || s.id) === sid);
            return exists ? p : [...p, subject];
          });
          alert(
            err?.response?.data?.message || err.message || "Failed to assign subject."
          );
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
    [teacherId, schoolId, actioningIds]
  );

  // ─────────────────────────────────────────────────────────
  // RENDER — Loading
  // ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <PageHeader title="Edit Teacher" onBack={() => navigate("/teachers")} />
        <div className="flex-1 flex items-center justify-center gap-3">
          <Loader2 size={32} className="animate-spin text-indigo-600" />
          <span className="text-gray-500 text-sm">Loading teacher…</span>
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
        <PageHeader title="Edit Teacher" onBack={() => navigate("/teachers")} />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <AlertCircle size={48} className="text-red-400" />
          <p className="text-sm text-red-600 text-center max-w-sm">{loadError}</p>
          <button
            onClick={() => loadAll()}
            className="bg-indigo-600 text-white text-sm font-semibold
                       px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Retry
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
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900 truncate">
            {teacher?.name ?? "Edit Teacher"}
          </h1>
          <p className="text-xs text-gray-500">
            {assigned.length} subject{assigned.length !== 1 ? "s" : ""} assigned
          </p>
        </div>
        <button
          onClick={() => loadAll(true)}
          disabled={refreshing}
          className="w-9 h-9 flex items-center justify-center rounded-xl
                     bg-gray-100 hover:bg-gray-200 transition-colors
                     disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            size={16}
            className={`text-gray-600 ${refreshing ? "animate-spin" : ""}`}
          />
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700
                     disabled:opacity-60 text-white text-sm font-bold
                     px-4 py-2 rounded-lg transition-colors"
        >
          {saving
            ? <Loader2 size={15} className="animate-spin" />
            : <Save size={15} />
          }
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-6 space-y-5">

        {/* ── Profile fields ── */}
        <section className="bg-white rounded-2xl border border-gray-200
                            shadow-sm p-6 space-y-4">
          <h2 className="text-sm font-bold text-gray-700">Profile</h2>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-gray-700">
              Full Name
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.name
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"}
            `}>
              <User size={16} className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder="e.g. Jane Smith"
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
              Email Address
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.email
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"}
            `}>
              <Mail size={16} className="text-gray-400 shrink-0" />
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
                }}
                placeholder="e.g. jane@school.com"
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
        </section>

        {/* ── Assigned subjects ── */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-bold text-gray-700 flex-1">
              Assigned Subjects
            </h2>
            <span className="bg-indigo-50 text-indigo-600 text-xs font-bold
                             px-2.5 py-1 rounded-full">
              {assigned.length}
            </span>
          </div>

          {assigned.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">
              No subjects assigned yet.
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
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center
                                    justify-center shrink-0">
                      <BookOpen size={14} className="text-indigo-600" />
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
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Available subjects ── */}
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-bold text-gray-700 flex-1">
              Available Subjects
            </h2>
            <span className="bg-gray-100 text-gray-600 text-xs font-bold
                             px-2.5 py-1 rounded-full">
              {available.length}
            </span>
          </div>

          {available.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-4">
              No available subjects found.
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
                    <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center
                                    justify-center shrink-0">
                      <BookOpen size={14} className="text-gray-400" />
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
                      Assign
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
      <div>
        <h1 className="text-lg font-bold text-gray-900">{title}</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Teacher profile &amp; subject assignments
        </p>
      </div>
    </div>
  );
}