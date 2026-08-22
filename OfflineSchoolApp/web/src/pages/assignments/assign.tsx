import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate, useLocation }                  from "react-router-dom";
import { useQuery, useMutation, useQueryClient }     from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Square,
  BookOpen,
  School,
  Users,
  AlertCircle,
  Search,
  X,
} from "lucide-react";

import { useUser }            from "@/store/auth.store";
import { fetchTeachers }      from "@/services/teacher.service";
import {
  fetchClasses,
  fetchSubjects,
}                             from "@/services/class.service";
import {
  fetchAssignmentsByTeacher,
  createAssignment,
  createBulkAssignments,
  type Assignment,
}                             from "@/services/assignment.service";
import { cn }                 from "@/utils/cn";
import type { Teacher, Class, Subject } from "@/types";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4;

interface LocationState {
  teacherId?:   string;
  teacherName?: string;
}

interface CreateResult {
  classId:   string;
  className: string;
  subjects:  string[];
  ok:        boolean;
  error?:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1 as Step, title: "Select Teacher",   icon: Users       },
  { id: 2 as Step, title: "Select Class",     icon: School      },
  { id: 3 as Step, title: "Select Subjects",  icon: BookOpen    },
  { id: 4 as Step, title: "Review & Confirm", icon: CheckSquare },
];

// ─────────────────────────────────────────────────────────────────────────────
// QUERY KEYS
// ─────────────────────────────────────────────────────────────────────────────

const QK = {
  teachers:    (sid: string) => ["teachers",             sid] as const,
  classes:     (sid: string) => ["classes",              sid] as const,
  subjects:    (cid: string) => ["subjects",             cid] as const,
  assignments: (tid: string) => ["teacher-assignments",  tid] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const StepIndicator = ({
  current, completed, onGoTo,
}: {
  current:   Step;
  completed: Set<Step>;
  onGoTo:    (s: Step) => void;
}) => (
  <div className="flex items-center justify-center gap-1 py-6">
    {STEPS.map((step, i) => {
      const isActive    = current === step.id;
      const isCompleted = completed.has(step.id);
      return (
        <div key={step.id} className="flex items-center">
          <button
            onClick={() => isCompleted && onGoTo(step.id)}
            disabled={!isCompleted}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors",
              isActive    && "bg-indigo-600 text-white",
              isCompleted && !isActive && "cursor-pointer bg-emerald-500 text-white hover:bg-emerald-600",
              !isActive && !isCompleted && "bg-gray-200 text-gray-500"
            )}
          >
            {isCompleted && !isActive ? "✓" : step.id}
          </button>
          {i < STEPS.length - 1 && (
            <div className={cn(
              "mx-1 h-0.5 w-8",
              isCompleted ? "bg-emerald-400" : "bg-gray-200"
            )} />
          )}
        </div>
      );
    })}
  </div>
);

const StepCard = ({ step, children }: { step: Step; children: React.ReactNode }) => {
  const s = STEPS[step - 1];
  const Icon = s.icon;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50">
          <Icon size={20} className="text-indigo-600" />
        </div>
        <div>
          <p className="text-xs font-medium text-gray-400">Step {step} of 4</p>
          <p className="text-base font-bold text-gray-900">{s.title}</p>
        </div>
      </div>
      {children}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function AssignTeacherPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const qc       = useQueryClient();

  const state          = (location.state ?? {}) as LocationState;
  const preTeacherId   = state.teacherId   ?? null;
  const preTeacherName = state.teacherName ?? null;

  const [step,             setStep]             = useState<Step>(preTeacherId ? 2 : 1);
  const [selectedTeacher,  setSelectedTeacher]  = useState<Teacher | null>(null);
  const [selectedClass,    setSelectedClass]    = useState<Class   | null>(null);
  const [selectedSubjects, setSelectedSubjects] = useState<Subject[]>([]);
  const [teacherSearch,    setTeacherSearch]    = useState("");
  const [results,          setResults]          = useState<CreateResult[] | null>(null);

  const completedSteps = useMemo((): Set<Step> => {
    const s = new Set<Step>();
    if (selectedTeacher) s.add(1);
    if (selectedTeacher && selectedClass) s.add(2);
    if (selectedTeacher && selectedClass && selectedSubjects.length > 0) s.add(3);
    return s;
  }, [selectedTeacher, selectedClass, selectedSubjects]);

  // Queries
  const teachersQuery = useQuery({
    queryKey:  QK.teachers(schoolId),
    queryFn:   () => fetchTeachers({ schoolId, limit: 200 }),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const classesQuery = useQuery<Class[], Error>({
    queryKey:  QK.classes(schoolId),
    queryFn:   () => fetchClasses(schoolId),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const subjectsQuery = useQuery<Subject[], Error>({
    queryKey:  QK.subjects(selectedClass?._id ?? ""),
    queryFn:   () => fetchSubjects(schoolId, selectedClass!._id),
    enabled:   !!selectedClass,
    staleTime: 30_000,
  });

  const existingQuery = useQuery<Assignment[], Error>({
    queryKey:  QK.assignments(selectedTeacher?._id ?? ""),
    queryFn:   () => fetchAssignmentsByTeacher(selectedTeacher!._id),
    enabled:   !!selectedTeacher,
    staleTime: 15_000,
  });

  const teachers = teachersQuery.data?.teachers ?? [];
  const classes  = classesQuery.data            ?? [];
  const subjects = subjectsQuery.data           ?? [];
  const existing = existingQuery.data           ?? [];

  useEffect(() => {
    if (!preTeacherId || !teachers.length) return;
    const found = teachers.find((t) => t._id === preTeacherId);
    if (found) setSelectedTeacher(found);
  }, [preTeacherId, teachers]);

  const assignedSet = useMemo(() => {
    const s = new Set<string>();
    existing.forEach((a) => {
      if (a.subjectId && a.classId) {
        s.add(`${a.subjectId}|${a.classId}`);
      }
    });
    return s;
  }, [existing]);

  const isAlreadyAssigned = useCallback(
    (subjectId: string, classId: string) =>
      assignedSet.has(`${subjectId}|${classId}`),
    [assignedSet]
  );

  const availableSubjects = useMemo(
    () => subjects.filter((s) => !isAlreadyAssigned(s._id, selectedClass?._id ?? "")),
    [subjects, isAlreadyAssigned, selectedClass]
  );

  const allSelected = useMemo(
    () =>
      availableSubjects.length > 0 &&
      availableSubjects.every((s) =>
        selectedSubjects.some((x) => x._id === s._id)
      ),
    [availableSubjects, selectedSubjects]
  );

  const filteredTeachers = useMemo(() => {
    const q = teacherSearch.toLowerCase().trim();
    if (!q) return teachers;
    return teachers.filter((t) => t.name.toLowerCase().includes(q));
  }, [teachers, teacherSearch]);

  const existingCountForClass = useCallback(
    (classId: string) => existing.filter((a) => a.classId === classId).length,
    [existing]
  );

  const goToStep = useCallback((target: Step) => {
    const resolved = target === 1 && preTeacherId ? 2 : target;
    if (resolved <= 1 && !preTeacherId) {
      setSelectedTeacher(null);
      setSelectedClass(null);
      setSelectedSubjects([]);
      setTeacherSearch("");
    } else if (resolved === 2) {
      setSelectedClass(null);
      setSelectedSubjects([]);
    } else if (resolved === 3) {
      setSelectedSubjects([]);
    }
    setStep(resolved as Step);
  }, [preTeacherId]);

  const handleTeacherSelect = useCallback((teacher: Teacher) => {
    setSelectedTeacher(teacher);
    setSelectedClass(null);
    setSelectedSubjects([]);
    setStep(2);
  }, []);

  const handleClassSelect = useCallback((cls: Class) => {
    setSelectedClass(cls);
    setSelectedSubjects([]);
    setStep(3);
  }, []);

  const toggleSubject = useCallback((subject: Subject) => {
    setSelectedSubjects((prev) => {
      const exists = prev.some((s) => s._id === subject._id);
      return exists
        ? prev.filter((s) => s._id !== subject._id)
        : [...prev, subject];
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedSubjects((prev) =>
      allSelected ? [] : [...prev, ...availableSubjects.filter(
        (a) => !prev.some((p) => p._id === a._id)
      )]
    );
  }, [allSelected, availableSubjects]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedTeacher || !selectedClass || !selectedSubjects.length) {
        throw new Error("Incomplete selection");
      }

      const teacherId = selectedTeacher._id;
      const classId   = selectedClass._id;

      if (selectedSubjects.length === 1) {
        await createAssignment({
          teacherId,
          classId,
          subjectId: selectedSubjects[0]._id,
          schoolId,
        });
        return [{
          classId,
          className: selectedClass.name,
          subjects:  [selectedSubjects[0].name],
          ok:        true,
        }] as CreateResult[];
      }

      const bulk = await createBulkAssignments({
        teacherId,
        assignments: selectedSubjects.map((s) => ({
          classId,
          subjectId: s._id,
        })),
        schoolId,
      });

      return [{
        classId,
        className: selectedClass.name,
        subjects:  selectedSubjects.map((s) => s.name),
        ok:        true,
        error:     bulk.failed.length
          ? `${bulk.failed.length} subject(s) failed`
          : undefined,
      }] as CreateResult[];
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["assignments", schoolId] });
      qc.invalidateQueries({ queryKey: QK.assignments(selectedTeacher?._id ?? "") });
      setResults(data);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        "Failed to create assignment";
      setResults([{
        classId:   selectedClass?._id  ?? "",
        className: selectedClass?.name ?? "",
        subjects:  selectedSubjects.map((s) => s.name),
        ok:        false,
        error:     msg,
      }]);
    },
  });

  if (results) {
    const allOk = results.every((r) => r.ok);
    return (
      <div className="mx-auto max-w-lg py-8">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className={cn(
            "mb-4 flex h-14 w-14 items-center justify-center rounded-full",
            allOk ? "bg-emerald-50" : "bg-amber-50"
          )}>
            {allOk
              ? <CheckSquare size={26} className="text-emerald-600" />
              : <AlertCircle size={26} className="text-amber-600" />
            }
          </div>
          <h2 className="text-xl font-bold text-gray-900">
            {allOk ? "Assignment Created!" : "Partial Success"}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Assigned to{" "}
            <span className="font-semibold text-gray-900">
              {selectedTeacher?.name}
            </span>
          </p>

          <div className="mt-4 flex flex-col gap-2">
            {results.map((r) => (
              <div
                key={r.classId}
                className={cn(
                  "rounded-xl p-3",
                  r.ok ? "bg-emerald-50" : "bg-red-50"
                )}
              >
                <p className={cn(
                  "text-sm font-semibold",
                  r.ok ? "text-emerald-800" : "text-red-800"
                )}>
                  {r.ok ? "✅" : "❌"} {r.className}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {r.subjects.join(", ")}
                </p>
                {r.error && (
                  <p className="mt-0.5 text-xs text-red-500">{r.error}</p>
                )}
              </div>
            ))}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => {
                setSelectedClass(null);
                setSelectedSubjects([]);
                setResults(null);
                setStep(2);
              }}
              className="flex-1 rounded-xl border-2 border-indigo-600 py-2.5 text-sm font-bold text-indigo-600 hover:bg-indigo-50 transition-colors"
            >
              {t("assignments.assignMore")}
            </button>
            <button
              onClick={() => navigate("/teachers/assignments")}
              className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition-colors"
            >
              {t("common.done")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">

      <button
        onClick={() => navigate("/teachers/assignments")}
        className="mb-4 flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors"
      >
        <ChevronLeft size={16} />
        {t("assignments.back")}
      </button>

      <h1 className="text-2xl font-bold text-gray-900">{t("assignments.assignTeacher")}</h1>
      <p className="mt-1 text-sm text-gray-500">{t("assignments.mapSubjects")}</p>

      <StepIndicator
        current={step}
        completed={completedSteps}
        onGoTo={goToStep}
      />

      {/* STEP 1 */}
      {step === 1 && (
        <StepCard step={1}>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
            <Search size={14} className="text-gray-400" />
            <input
              type="text"
              value={teacherSearch}
              onChange={(e) => setTeacherSearch(e.target.value)}
              placeholder={t("assignments.searchTeachers")}
              className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none"
            />
            {teacherSearch && (
              <button onClick={() => setTeacherSearch("")}>
                <X size={14} className="text-gray-400" />
              </button>
            )}
          </div>

          {teachersQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-gray-400">Loading teachers…</p>
          ) : filteredTeachers.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              {teacherSearch ? "No teachers match your search." : "No teachers found."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredTeachers.map((teacher) => {
                const isSelected = selectedTeacher?._id === teacher._id;
                return (
                  <button
                    key={teacher._id}
                    onClick={() => handleTeacherSelect(teacher)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border-2 p-3.5 text-left transition-colors",
                      isSelected
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    )}
                  >
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold",
                      isSelected ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600"
                    )}>
                      {teacher.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {teacher.name}
                      </p>
                      <p className="truncate text-xs text-gray-400">
                        {teacher.email}
                      </p>
                    </div>
                    <div className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                      isSelected
                        ? "border-indigo-600 bg-indigo-600"
                        : "border-gray-300"
                    )}>
                      {isSelected && (
                        <div className="h-2 w-2 rounded-full bg-white" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </StepCard>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <StepCard step={2}>
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2.5">
            <Users size={14} className="shrink-0 text-indigo-600" />
            <span className="flex-1 truncate text-sm font-semibold text-indigo-900">
              {selectedTeacher?.name ?? preTeacherName}
            </span>
            {!preTeacherId && (
              <button
                onClick={() => goToStep(1)}
                className="text-xs font-medium text-indigo-500 hover:text-indigo-700"
              >
                {t("common.change")}
              </button>
            )}
          </div>

          {existing.length > 0 && (
            <div className="mb-3 flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2.5">
              <AlertCircle size={14} className="shrink-0 text-blue-600" />
              <p className="text-xs font-medium text-blue-800">
                Currently assigned to {existing.length} subject
                {existing.length !== 1 ? "s" : ""}
              </p>
            </div>
          )}

          {classesQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-gray-400">Loading classes…</p>
          ) : classes.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">{t("assignments.noClasses")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {classes.map((cls) => {
                const count = existingCountForClass(cls._id);
                return (
                  <button
                    key={cls._id}
                    onClick={() => handleClassSelect(cls)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border-2 p-3.5 text-left transition-colors",
                      selectedClass?._id === cls._id
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    )}
                  >
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                      selectedClass?._id === cls._id
                        ? "bg-indigo-600"
                        : "bg-purple-100"
                    )}>
                      <School
                        size={18}
                        className={
                          selectedClass?._id === cls._id
                            ? "text-white"
                            : "text-purple-700"
                        }
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {cls.name}
                      </p>
                      {cls.section && (
                        <p className="text-xs text-gray-400">
                          Section {cls.section}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {count > 0 && (
                        <span className="rounded-lg bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-600">
                          {count} assigned
                        </span>
                      )}
                      <ChevronRight size={16} className="text-gray-300" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </StepCard>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <StepCard step={3}>
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <button
              onClick={() => goToStep(preTeacherId ? 2 : 1)}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            >
              <Users size={12} />
              {selectedTeacher?.name ?? preTeacherName}
            </button>
            <ChevronRight size={12} className="text-gray-300" />
            <button
              onClick={() => goToStep(2)}
              className="flex items-center gap-1.5 rounded-lg bg-purple-50 px-2.5 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
            >
              <School size={12} />
              {selectedClass?.name}
            </button>
          </div>

          {subjectsQuery.isLoading ? (
            <p className="py-6 text-center text-sm text-gray-400">Loading subjects…</p>
          ) : subjects.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              {t("assignments.noSubjectsInClass")}
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs font-medium text-gray-400">
                {t("assignments.selectSubjects")}
              </p>

              {availableSubjects.length > 0 && (
                <button
                  onClick={toggleAll}
                  className="mb-3 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors w-full"
                >
                  {allSelected
                    ? <CheckSquare size={18} />
                    : <Square      size={18} />
                  }
                  {allSelected
                    ? "Deselect All"
                    : `Select All (${availableSubjects.length})`
                  }
                </button>
              )}

              <div className="flex flex-col gap-2">
                {subjects.map((subject) => {
                  const already   = isAlreadyAssigned(subject._id, selectedClass?._id ?? "");
                  const isChecked = selectedSubjects.some((s) => s._id === subject._id);
                  return (
                    <button
                      key={subject._id}
                      onClick={() => !already && toggleSubject(subject)}
                      disabled={already}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-colors",
                        already   && "cursor-not-allowed border-gray-100 bg-gray-50 opacity-60",
                        isChecked && !already && "border-emerald-500 bg-emerald-50",
                        !isChecked && !already && "border-gray-200 bg-white hover:border-gray-300"
                      )}
                    >
                      <div className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2",
                        already   && "border-gray-300 bg-gray-200",
                        isChecked && !already && "border-emerald-500 bg-emerald-500",
                        !isChecked && !already && "border-gray-300"
                      )}>
                        {(isChecked || already) && (
                          <span className={cn(
                            "text-xs",
                            already ? "text-gray-400" : "text-white"
                          )}>✓</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={cn(
                          "truncate text-sm font-semibold",
                          already ? "text-gray-400" : "text-gray-900"
                        )}>
                          {subject.name}
                        </p>
                        {subject.code && (
                          <p className="text-xs text-gray-400">{subject.code}</p>
                        )}
                      </div>
                      {already && (
                        <span className="shrink-0 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400">
                          {t("assignments.alreadyAssigned")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {selectedSubjects.length > 0 && (
                <button
                  onClick={() => setStep(4)}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white hover:bg-indigo-700 transition-colors"
                >
                  Review {selectedSubjects.length} Selection
                  {selectedSubjects.length !== 1 ? "s" : ""}
                  <ChevronRight size={16} />
                </button>
              )}
            </>
          )}
        </StepCard>
      )}

      {/* STEP 4 */}
      {step === 4 && (
        <StepCard step={4}>
          <h3 className="mb-4 text-base font-bold text-gray-900">
            {t("assignments.summary")}
          </h3>

          <div className="mb-3 rounded-xl border border-gray-100 p-3.5">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              <Users size={12} /> {t("academic.teacher")}
            </p>
            <p className="text-sm font-bold text-gray-900">
              {selectedTeacher?.name}
            </p>
          </div>

          <div className="mb-3 rounded-xl border border-gray-100 p-3.5">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              <School size={12} /> {t("academic.class")}
            </p>
            <p className="text-sm font-bold text-gray-900">
              {selectedClass?.name}
            </p>
          </div>

          <div className="mb-3 rounded-xl border border-gray-100 p-3.5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              <BookOpen size={12} /> Subjects ({selectedSubjects.length})
            </p>
            <div className="flex flex-col gap-1.5">
              {selectedSubjects.map((s) => (
                <div
                  key={s._id}
                  className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-sm font-medium text-gray-900">
                      {s.name}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      setSelectedSubjects((prev) =>
                        prev.filter((x) => x._id !== s._id)
                      )
                    }
                    className="text-red-400 hover:text-red-600"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {selectedSubjects.length === 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5">
              <AlertCircle size={14} className="shrink-0 text-amber-600" />
              <p className="text-xs font-medium text-amber-800">
                {t("assignments.noneSelected")}
              </p>
            </div>
          )}

          {mutation.isError && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5">
              <AlertCircle size={14} className="shrink-0 text-red-500" />
              <p className="text-xs font-medium text-red-700">
                {(mutation.error as { response?: { data?: { message?: string } } })
                  ?.response?.data?.message ??
                  (mutation.error instanceof Error
                    ? mutation.error.message
                    : "Failed to create assignment")}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep(3)}
              className="flex items-center gap-1.5 rounded-xl bg-gray-100 px-5 py-3 text-sm font-bold text-gray-700 hover:bg-gray-200 transition-colors"
            >
              <ChevronLeft size={16} />
              {t("common.back")}
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || selectedSubjects.length === 0}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white transition-colors",
                mutation.isPending || selectedSubjects.length === 0
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700"
              )}
            >
              {mutation.isPending ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Confirming…
                </>
              ) : (
                <>
                  <CheckSquare size={16} />
                  {t("common.confirm")}
                </>
              )}
            </button>
          </div>
        </StepCard>
      )}
    </div>
  );
}