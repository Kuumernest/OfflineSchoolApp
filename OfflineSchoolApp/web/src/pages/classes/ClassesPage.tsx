import { useState, useMemo }                             from "react";
import { useSearchParams }                               from "react-router-dom";
import { useQuery, useMutation, useQueryClient }         from "@tanstack/react-query";
import { School, Plus, Pencil, Trash2, BookOpen }        from "lucide-react";
import { useForm }                                       from "react-hook-form";
import { zodResolver }                                   from "@hookform/resolvers/zod";
import { z }                                             from "zod";
import { useUser }                                       from "@/store/auth.store";
import {
  fetchClasses,
  createClass,
  updateClass,
  deleteClass,
  fetchSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
}                                                        from "@/services/class.service";
import { fetchTeachers }                                 from "@/services/teacher.service";
import type {
  Class,
  Subject,
  TeacherRef,
  DeleteConfirmState,
  SelectOption,
  ClassPageTab,
}                                                        from "@/types/classes.types";
import { PageSpinner }                                   from "@/components/ui/Spinner";
import { Button }                                        from "@/components/ui/Button";
import { Badge }                                         from "@/components/ui/Badge";
import { Modal }                                         from "@/components/ui/Modal";
import { SearchInput }                                   from "@/components/ui/SearchInput";
import { FormField, Input, SelectField }                 from "@/components/ui/FormField";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────────────────

/*
 * The schemas are built from `t`, not declared with English literals.
 *
 * They sat at module scope, where there is no translator, so every validation
 * message on this screen was English however the app was set — a French admin
 * got a French form that refused them in English. Taking the translator as an
 * argument is the smallest change that fixes it: the rules, their order and
 * their bounds are untouched, and the messages now come from the same catalogue
 * as the labels above them.
 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

const MAX_CLASS_NAME = 100;

// max(100) matches Class.js maxlength on the server, so the console refuses up
// front what the server would reject as a 500-shaped ValidationError.
const buildClassSchema = (t: Translate) => z.object({
  name: z.string()
    .min(1, t("classes.errNameRequired"))
    .max(MAX_CLASS_NAME, t("classes.errNameMax", { max: MAX_CLASS_NAME })),
  level:   z.string().optional(),
  section: z.string().optional(),
  // The form master. Optional: a class may genuinely not have one assigned
  // yet, and the report card prints an empty signature rule in that case
  // rather than refusing to print.
  classTeacherId: z.string().optional(),
});

const buildSubjectSchema = (t: Translate) => z.object({
  name:      z.string().min(1, t("subjectsEdit.errNameRequired")),
  code:      z.string().optional(),
  classId:   z.string().min(1, t("subjectsEdit.errClassRequired")),
  teacherId: z.string().optional(),
});

/*
 * The form types come from the builders' return types, not from a placeholder
 * schema built with a stub translator. A placeholder would be a real value
 * nothing validates against — the kind of thing that survives a refactor and
 * then quietly becomes the resolver somebody reaches for.
 */
type ClassForm   = z.infer<ReturnType<typeof buildClassSchema>>;
type SubjectForm = z.infer<ReturnType<typeof buildSubjectSchema>>;

// ─────────────────────────────────────────────────────────
// TEACHER TYPE
// ─────────────────────────────────────────────────────────

interface Teacher extends TeacherRef {
  firstName?: string;
  lastName?:  string;
}

// ─────────────────────────────────────────────────────────
// QUERY KEY FACTORY
// ─────────────────────────────────────────────────────────

const QK = {
  classes:  (schoolId: string)                   => ["classes",  schoolId]            as const,
  subjects: (schoolId: string, classId?: string) => ["subjects", schoolId, classId ?? ""] as const,
  teachers: (schoolId: string)                   => ["teachers", schoolId]            as const,
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const resolveTeacherDisplayName = (t: Teacher): string => {
  if (t.name) return t.name;
  return `${t.firstName ?? ""} ${t.lastName ?? ""}`.trim() || "—";
};

const resolveSubjectTeacherName = (
  sub:      Subject,
  teachers: Teacher[],
): string => {
  if (sub.teacher?.name) return sub.teacher.name;
  if (sub.teacherName)   return sub.teacherName;
  if (!sub.teacherId)    return "—";

  const t = teachers.find((x) => x._id === sub.teacherId);
  return t ? resolveTeacherDisplayName(t) : "—";
};

// ═════════════════════════════════════════════════════════════════════════════
// PAGE
// ═════════════════════════════════════════════════════════════════════════════

export default function ClassesPage() {
  const { t } = useTranslation();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const qc       = useQueryClient();

  // ── URL-driven tab ─────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as ClassPageTab) ?? "classes";

  const setTab = (next: ClassPageTab) => {
    setSearch("");
    setSearchParams(next === "classes" ? {} : { tab: next }, { replace: true });
  };

  // ── UI state ───────────────────────────────────────────
  const [search,        setSearch]        = useState("");
  const [filterClassId, setFilterClassId] = useState("");

  // ── Modal state ────────────────────────────────────────
  const [classModal,   setClassModal]   = useState(false);
  const [editingClass, setEditingClass] = useState<Class | null>(null);

  const [subjectModal,   setSubjectModal]   = useState(false);
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);

  const [deleteConfirm, setDeleteConfirm] =
    useState<DeleteConfirmState | null>(null);

  // ─────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────

  const classesQuery = useQuery({
    queryKey:  QK.classes(schoolId),
    queryFn:   () => fetchClasses(schoolId),
    enabled:   !!schoolId,
    staleTime: 30_000,
  });

  const subjectsQuery = useQuery({
    queryKey:  QK.subjects(schoolId, filterClassId),
    queryFn:   () => fetchSubjects(schoolId, filterClassId || undefined),
    enabled:   !!schoolId,
    staleTime: 30_000,
  });

  const teachersQuery = useQuery({
    queryKey:  QK.teachers(schoolId),
    queryFn:   () => fetchTeachers({ schoolId, limit: 100 }),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const classes:  Class[]   = classesQuery.data            ?? [];
  const subjects: Subject[] = subjectsQuery.data           ?? [];
  const teachers: Teacher[] = (teachersQuery.data?.teachers as Teacher[]) ?? [];

  // ── Filtered lists ─────────────────────────────────────

  const q = search.toLowerCase();

  const filteredClasses = classes.filter((c) =>
    c.name.toLowerCase().includes(q)
  );

  const filteredSubjects = subjects.filter((s) =>
    s.name.toLowerCase().includes(q) ||
    (s.code ?? "").toLowerCase().includes(q)
  );

  // ─────────────────────────────────────────────────────
  // FORMS
  // ─────────────────────────────────────────────────────

  // Rebuilt on a language change so a message already on screen is replaced
  // rather than left in the previous language.
  const classRules   = useMemo(() => buildClassSchema(t),   [t]);
  const subjectRules = useMemo(() => buildSubjectSchema(t), [t]);

  // ── Class form ─────────────────────────────────────────
  const classForm = useForm<ClassForm>({
    resolver:      zodResolver(classRules),
    defaultValues: { name: "", level: "", section: "", classTeacherId: "" },
  });

  const openClassModal = (cls?: Class) => {
    setEditingClass(cls ?? null);
    classForm.reset(
      cls
        ? { name: cls.name, level: cls.level ?? "", section: cls.section ?? "",
            classTeacherId: cls.classTeacherId ?? "" }
        : { name: "",       level: "",              section: "",
            classTeacherId: "" }
    );
    setClassModal(true);
  };

  const closeClassModal = () => {
    setClassModal(false);
    classForm.reset();
  };

  const classMutation = useMutation({
    mutationFn: (values: ClassForm) =>
      editingClass
        ? updateClass(editingClass._id, { ...values, schoolId })
        : createClass({ ...values, schoolId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.classes(schoolId) });
      closeClassModal();
    },
  });

  // ── Subject form ───────────────────────────────────────
  const subjectForm = useForm<SubjectForm>({
    resolver:      zodResolver(subjectRules),
    defaultValues: { name: "", code: "", classId: "", teacherId: "" },
  });

  const openSubjectModal = (sub?: Subject) => {
      setEditingSubject(sub ?? null);
    subjectForm.reset(
      sub
        ? {
            name:      sub.name,
            code:      sub.code      ?? "",
            classId:   sub.classId   ?? "",
            teacherId: sub.teacherId ?? "",
          }
        : {
            name:      "",
            code:      "",
            classId:   filterClassId ?? "",
            teacherId: "",
          }
    );
    setSubjectModal(true);
  };

  const closeSubjectModal = () => {
    setSubjectModal(false);
    subjectForm.reset();
  };

  const subjectMutation = useMutation({
    mutationFn: (values: SubjectForm) =>
      editingSubject
        ? updateSubject(editingSubject._id, { ...values, schoolId })
        : createSubject({ ...values, schoolId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subjects", schoolId] });
      closeSubjectModal();
    },
  });

  // ── Delete ─────────────────────────────────────────────
  const deleteMutation = useMutation({
    // deleteClass resolves a DeleteClassResult while deleteSubject resolves
    // void, and the union of the two is not a valid MutationFunction<void>.
    // Neither result is read, so the mutation is typed as void.
    mutationFn: async ({ type, id }: Pick<DeleteConfirmState, "type" | "id">) => {
      if (type === "class") await deleteClass(id);
      else                  await deleteSubject(id);
    },
    onSuccess: (_data, vars) => {
      if (vars.type === "class") {
        qc.invalidateQueries({ queryKey: QK.classes(schoolId) });
        qc.invalidateQueries({ queryKey: ["subjects", schoolId] });
      } else {
        qc.invalidateQueries({ queryKey: ["subjects", schoolId] });
      }
      setDeleteConfirm(null);
    },
  });

  // ─────────────────────────────────────────────────────
  // DROPDOWN OPTIONS
  // ─────────────────────────────────────────────────────

  const classOptions: SelectOption[] = classes.map((c) => ({
    value: c._id,
    label: c.name,
  }));

  const teacherOptions: SelectOption[] = [
    { value: "", label: "No teacher assigned" },
    ...teachers.map((t) => ({
      value: t._id,
      label: resolveTeacherDisplayName(t),
    })),
  ];

  // A form master who has left keeps their name on the class — that is what
  // their pupils' report cards print — but their account is deactivated and
  // /admin/teachers does not list them. A <select> given a value no option
  // carries falls back to its first option, so the dialog would show them as
  // unassigned and Save would then clear the name those cards depend on. The
  // class being edited therefore always carries an option for whoever holds
  // it, listed or not.
  if (
    editingClass?.classTeacherId &&
    !teacherOptions.some((o) => o.value === editingClass.classTeacherId)
  ) {
    teacherOptions.splice(1, 0, {
      value: String(editingClass.classTeacherId),
      label: editingClass.classTeacherName
        ? `${editingClass.classTeacherName} (no longer on staff)`
        : "Current form master",
    });
  }

  const filterClassOptions: SelectOption[] = [
    { value: "", label: t("students.allClasses") },
    ...classOptions,
  ];

  // ─────────────────────────────────────────────────────
  // DERIVED HELPERS
  // ─────────────────────────────────────────────────────

  const getClassName = (cid: string): string =>
    classes.find((c) => c._id === cid)?.name ?? "—";

  const getTeacherName = (sub: Subject): string =>
    resolveSubjectTeacherName(sub, teachers);

  // ─────────────────────────────────────────────────────
  // LOADING GATE
  // ─────────────────────────────────────────────────────

  if (classesQuery.isLoading) return <PageSpinner />;

  // ─────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900
                         flex items-center gap-2">
            <School className="h-7 w-7 text-primary-600" />
            {t("classes.pageTitle")}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {t("classes.pageBlurb")}
          </p>
        </div>

        <Button
          onClick={() =>
            tab === "classes" ? openClassModal() : openSubjectModal()
          }
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          {tab === "classes" ? t("classes.add") : t("subjects.add")}
        </Button>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6" aria-label={t("classes.pageTabs")}>
          {(["classes", "subjects"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-selected={tab === key}
              role="tab"
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-primary-600 text-primary-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {key === "classes" ? t("classes.title") : t("subjects.title")}
              <Badge
                variant={tab === key ? "primary" : "secondary"}
                className="ml-2"
              >
                {key === "classes" ? classes.length : subjects.length}
              </Badge>
            </button>
          ))}
        </nav>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={tab === "classes"
            ? t("classes.searchPh")
            : t("subjects.searchPh")}
          className="max-w-xs"
        />

        {tab === "subjects" && (
          <select
            value={filterClassId}
            onChange={(e) => setFilterClassId(e.target.value)}
            aria-label={t("classes.filterByClass")}
            className="
              rounded-md border border-gray-300
              bg-white
              text-sm text-gray-700
              px-3 py-2
              focus:outline-none focus:ring-2 focus:ring-primary-500
            "
          >
            {filterClassOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* CLASSES TAB */}
      {tab === "classes" && (
        filteredClasses.length === 0 ? (
          <EmptyState
            icon={<School className="h-10 w-10 text-gray-400" />}
            title={t("classes.none")}
            description={
              search
                ? t("common.tryDifferentSearch")
                : t("classes.firstOne")
            }
            action={
              <Button onClick={() => openClassModal()}>
                <Plus className="h-4 w-4 mr-1" /> {t("classes.add")}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredClasses.map((cls) => {
              const subjectCount = subjects.filter(
                (s) => s.classId === cls._id
              ).length;

              return (
                <ClassCard
                  key={cls._id}
                  cls={cls}
                  subjectCount={subjectCount}
                  onEdit={openClassModal}
                  onDelete={(c) =>
                    setDeleteConfirm({ type: "class", id: c._id, name: c.name })
                  }
                  onViewSubjects={(c) => {
                    setFilterClassId(c._id);
                    setTab("subjects");
                  }}
                />
              );
            })}
          </div>
        )
      )}

      {/* SUBJECTS TAB */}
      {tab === "subjects" && (
        subjectsQuery.isLoading ? (
          <PageSpinner />
        ) : filteredSubjects.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-10 w-10 text-gray-400" />}
            title={t("subjects.none")}
            description={
              search
                ? t("common.tryDifferentSearch")
                : t("subjects.firstOne")
            }
            action={
              <Button onClick={() => openSubjectModal()}>
                <Plus className="h-4 w-4 mr-1" /> {t("subjects.add")}
              </Button>
            }
          />
        ) : (
          <SubjectsTable
            subjects={filteredSubjects}
            getClassName={getClassName}
            getTeacherName={getTeacherName}
            onEdit={openSubjectModal}
            onDelete={(sub) =>
              setDeleteConfirm({ type: "subject", id: sub._id, name: sub.name })
            }
          />
        )
      )}

      {/* CLASS MODAL */}
      <Modal
        open={classModal}
        onClose={closeClassModal}
        title={editingClass ? t("classes.edit") : t("classes.add")}
      >
        <form
          onSubmit={classForm.handleSubmit((v) => classMutation.mutate(v))}
          className="space-y-4"
          noValidate
        >
          <FormField
            label={t("classes.nameLabel")}
            error={classForm.formState.errors.name?.message}
            required
          >
            <Input
              {...classForm.register("name")}
              placeholder={t("classes.namePh")}
              autoFocus
            />
          </FormField>

          <FormField
            label={t("common.level")}
            error={classForm.formState.errors.level?.message}
          >
            <Input
              {...classForm.register("level")}
              placeholder={t("classes.levelPh")}
            />
          </FormField>

          <FormField
            label={t("common.section")}
            error={classForm.formState.errors.section?.message}
          >
            <Input
              {...classForm.register("section")}
              placeholder={t("classes.sectionPh")}
            />
          </FormField>

          {/*
            The form master. This is the name printed over the signature rule
            at the foot of every report card the class issues — until now
            there was nowhere to set it, so that rule sat over a blank.
          */}
          <FormField
            label={t("classes.classTeacher")}
            error={classForm.formState.errors.classTeacherId?.message}
            hint={t("classes.classTeacherHint")}
          >
            <SelectField
              {...classForm.register("classTeacherId")}
              options={teacherOptions}
            />
          </FormField>

          {classMutation.isError && (
            <p className="text-sm text-red-600">
              {(classMutation.error as { response?: { data?: { message?: string } } })
                ?.response?.data?.message ??
                "Something went wrong. Please try again."}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeClassModal}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={classMutation.isPending}>
              {editingClass ? t("common.saveChanges") : t("classes.create")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* SUBJECT MODAL */}
      <Modal
        open={subjectModal}
        onClose={closeSubjectModal}
        title={editingSubject ? t("subjects.edit") : t("subjects.add")}
      >
        <form
          onSubmit={subjectForm.handleSubmit((v) => subjectMutation.mutate(v))}
          className="space-y-4"
          noValidate
        >
          <FormField
            label={t("subjects.nameLabel")}
            error={subjectForm.formState.errors.name?.message}
            required
          >
            <Input
              {...subjectForm.register("name")}
              placeholder={t("subjects.namePh")}
              autoFocus
            />
          </FormField>

          <FormField
            label={t("subjects.codeLabel")}
            error={subjectForm.formState.errors.code?.message}
          >
            <Input
              {...subjectForm.register("code")}
              placeholder={t("subjects.codePh")}
            />
          </FormField>

          <FormField
            label={t("academic.class")}
            error={subjectForm.formState.errors.classId?.message}
            required
          >
            <SelectField
              {...subjectForm.register("classId")}
              options={classOptions}
              placeholder={t("classes.selectClass")}
            />
          </FormField>

          <FormField
            label={t("classes.assignedTeacher")}
            error={subjectForm.formState.errors.teacherId?.message}
          >
            <SelectField
              {...subjectForm.register("teacherId")}
              options={teacherOptions}
            />
          </FormField>

          {subjectMutation.isError && (
            <p className="text-sm text-red-600">
              {(subjectMutation.error as { response?: { data?: { message?: string } } })
                ?.response?.data?.message ??
                "Something went wrong. Please try again."}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeSubjectModal}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={subjectMutation.isPending}>
              {editingSubject ? t("common.saveChanges") : t("subjects.create")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* DELETE CONFIRM MODAL */}
      <Modal
        open={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        title={deleteConfirm?.type === "class"
            ? t("classes.deleteTitle")
            : t("subjects.deleteTitle")}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to delete{" "}
            <span className="font-semibold text-gray-900">
              {deleteConfirm?.name}
            </span>
            ?{" "}
            {deleteConfirm?.type === "class" &&
              t("classes.deleteWarning") + " "}
            {t("common.cannotUndo")}
          </p>

          {deleteMutation.isError && (
            <p className="text-sm text-red-600">
              {(deleteMutation.error as { response?: { data?: { message?: string } } })
                ?.response?.data?.message ??
                t("common.deleteFailed")}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteConfirm(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() =>
                deleteConfirm &&
                deleteMutation.mutate({
                  type: deleteConfirm.type,
                  id:   deleteConfirm.id,
                })
              }
            >
              {t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CLASS CARD
// ═════════════════════════════════════════════════════════════════════════════

interface ClassCardProps {
  cls:            Class;
  subjectCount:   number;
  onEdit:         (cls: Class) => void;
  onDelete:       (cls: Class) => void;
  onViewSubjects: (cls: Class) => void;
}

function ClassCard({
  cls,
  subjectCount,
  onEdit,
  onDelete,
  onViewSubjects,
}: ClassCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className="
        bg-white rounded-xl
        border border-gray-200
        p-5 flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow
      "
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-gray-900 text-lg truncate">
            {cls.name}
          </h3>
          <div className="flex gap-2 mt-1 flex-wrap">
            {cls.level && (
              <Badge variant="secondary">Level {cls.level}</Badge>
            )}
            {cls.section && (
              <Badge variant="secondary">Section {cls.section}</Badge>
            )}
          </div>
        </div>

        <div className="flex gap-1 ml-2 flex-shrink-0">
          <button
            onClick={() => onEdit(cls)}
            className="
              p-1.5 rounded-lg text-gray-400
              hover:text-primary-600 hover:bg-primary-50
 transition
            "
            title={t("classes.edit")}
            aria-label={`Edit ${cls.name}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => onDelete(cls)}
            className="
              p-1.5 rounded-lg text-gray-400
              hover:text-red-600 hover:bg-red-50
 transition
            "
            title={t("classes.delete")}
            aria-label={`Delete ${cls.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="
          flex items-center gap-2 text-sm text-gray-500
          hover:text-primary-600 transition-colors text-left
        "
        onClick={() => onViewSubjects(cls)}
        aria-label={`View subjects for ${cls.name}`}
      >
        <BookOpen className="h-4 w-4 flex-shrink-0" />
        <span>
          {subjectCount} subject{subjectCount !== 1 ? "s" : ""}
        </span>
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SUBJECTS TABLE
// ═════════════════════════════════════════════════════════════════════════════

interface SubjectsTableProps {
  subjects:       Subject[];
  getClassName:   (id: string) => string;
  getTeacherName: (sub: Subject) => string;
  onEdit:         (sub: Subject) => void;
  onDelete:       (sub: Subject) => void;
}

function SubjectsTable({
  subjects,
  getClassName,
  getTeacherName,
  onEdit,
  onDelete,
}: SubjectsTableProps) {
  const { t } = useTranslation();
  return (
    <div
      className="
        bg-white rounded-xl
        border border-gray-200
        overflow-hidden shadow-sm
      "
    >
      <table className="w-full text-sm" role="grid">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            {([
            t("academic.subject"),
            t("common.code"),
            t("academic.class"),
            t("academic.teacher"),
            "",
          ]).map((h) => (
              <th
                key={h}
                className="text-left px-4 py-3 font-medium text-gray-600"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-gray-100">
          {subjects.map((sub) => (
            <tr
              key={sub._id}
              className="hover:bg-gray-50 transition-colors"
            >
              <td className="px-4 py-3 font-medium text-gray-900">
                {sub.name}
              </td>

              <td className="px-4 py-3 text-gray-500">
                {sub.code
                  ? <Badge variant="secondary">{sub.code}</Badge>
                  : "—"}
              </td>

              <td className="px-4 py-3 text-gray-600">
                {sub.class?.name ?? getClassName(sub.classId)}
              </td>

              <td className="px-4 py-3 text-gray-600">
                {getTeacherName(sub)}
              </td>

              <td className="px-4 py-3">
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => onEdit(sub)}
                    className="
                      p-1.5 rounded-lg text-gray-400
                      hover:text-primary-600 hover:bg-primary-50
 transition
                    "
                    title={t("subjects.edit")}
                    aria-label={`Edit ${sub.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => onDelete(sub)}
                    className="
                      p-1.5 rounded-lg text-gray-400
                      hover:text-red-600 hover:bg-red-50
 transition
                    "
                    title={t("subjects.delete")}
                    aria-label={`Delete ${sub.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// EMPTY STATE
// ═════════════════════════════════════════════════════════════════════════════

interface EmptyStateProps {
  icon:        React.ReactNode;
  title:       string;
  description: string;
  action?:     React.ReactNode;
}

function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
      <div className="p-4 bg-gray-100 rounded-full">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-gray-900">
        {title}
      </h3>
      <p className="text-sm text-gray-500 max-w-xs">
        {description}
      </p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}