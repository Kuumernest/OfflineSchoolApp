// web/src/pages/announcements/index.tsx
//
// Writing and managing announcements.
//
// The composer mirrors the server's permission rules rather than discovering
// them by failing: a teacher may only address students or their own classes and
// cannot pin, so those options are absent from their form instead of being
// offered and then rejected with a 403.
//
// It also distinguishes "live" from "scheduled" and "expired". The list
// endpoint filters on isActive but not on publishAt/expiresAt, so a notice that
// nobody can see yet comes back looking identical to one that is out there.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Megaphone,
  Plus,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  Clock,
  CheckCheck,
  AlertCircle,
  Eye,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { FormField, Input, Textarea, SelectField, Checkbox } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/ui/Pagination";
import { useToast } from "@/components/ui/Toast";

import {
  fetchAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  togglePin,
  markAllRead,
  targetClassNames,
  lifecycleOf,
} from "@/services/announcement.service";
import { fetchClasses } from "@/services/class.service";
import {
  AUDIENCE_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  allowedAudiences,
  canPin,
} from "@/types/announcement.types";
import type {
  Announcement,
  Audience,
  Priority,
} from "@/types/announcement.types";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/api";
import { formatDate } from "@/utils/formatDate";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

const QK = {
  list:    (page: number, audience: string, priority: string) =>
    ["announcements", page, audience, priority] as const,
  classes: (schoolId: string) => ["classes", schoolId] as const,
};

const PRIORITY_VARIANT: Record<Priority, "default" | "info" | "warning" | "danger"> = {
  low:    "default",
  normal: "info",
  high:   "warning",
  urgent: "danger",
};

const LIFECYCLE_LABEL = {
  live:      { labelKey: "annLifecycle.live",      variant: "success" as const },
  scheduled: { labelKey: "annLifecycle.scheduled", variant: "info" as const },
  expired:   { labelKey: "annLifecycle.expired",   variant: "default" as const },
  inactive:  { labelKey: "common.inactive",        variant: "default" as const },
};

interface ComposerState {
  title:         string;
  body:          string;
  audience:      Audience;
  priority:      Priority;
  isPinned:      boolean;
  targetClasses: string[];
  expiresAt:     string;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AnnouncementsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const role     = user?.role;

  const audiences = useMemo(() => allowedAudiences(role), [role]);
  const pinAllowed = canPin(role);

  const [page,     setPage]     = useState(1);
  const [audience, setAudience] = useState("");
  const [priority, setPriority] = useState("");
  const [editing,  setEditing]  = useState<Announcement | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [reading, setReading] = useState<Announcement | null>(null);

  const emptyComposer = (): ComposerState => ({
    title:         "",
    body:          "",
    audience:      audiences[0],
    priority:      "normal",
    isPinned:      false,
    targetClasses: [],
    expiresAt:     "",
  });

  const [form, setForm] = useState<ComposerState>(emptyComposer);

  const listQ = useQuery({
    queryKey: QK.list(page, audience, priority),
    queryFn:  () => fetchAnnouncements({
      page,
      limit: PAGE_SIZE,
      ...(audience ? { audience: audience as Audience } : {}),
      ...(priority ? { priority: priority as Priority } : {}),
    }),
  });

  const classesQ = useQuery({
    queryKey: QK.classes(schoolId),
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const items   = listQ.data?.announcements ?? [];
  const classes = classesQ.data ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["announcements"] });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        title:    form.title,
        body:     form.body,
        audience: form.audience,
        priority: form.priority,
        isPinned: pinAllowed ? form.isPinned : false,
        targetClasses: form.targetClasses,
        // A date input gives "YYYY-MM-DD"; the server wants something Date can
        // parse. End of day is the sensible reading of "expires on the 5th".
        expiresAt: form.expiresAt ? `${form.expiresAt}T23:59:59` : null,
      };
      return editing
        ? updateAnnouncement(editing._id, payload)
        : createAnnouncement(payload);
    },
    onSuccess: () => {
      toast({ title: editing ? "Announcement updated" : "Announcement posted", kind: "success" });
      closeComposer();
      invalidate();
    },
    onError: (err) =>
      toast({ title: "Could not save", message: getErrorMessage(err), kind: "error" }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteAnnouncement(id),
    onSuccess: () => { toast({ title: "Announcement removed", kind: "success" }); invalidate(); },
    onError: (err) =>
      toast({ title: "Could not remove", message: getErrorMessage(err), kind: "error" }),
  });

  const pinMutation = useMutation({
    mutationFn: (id: string) => togglePin(id),
    onSuccess: invalidate,
    onError: (err) =>
      toast({ title: "Could not change pin", message: getErrorMessage(err), kind: "error" }),
  });

  const readAllMutation = useMutation({
    mutationFn: () => markAllRead(schoolId),
    onSuccess: (marked) => {
      toast({
        title:   "Marked as read",
        message: marked > 0
          ? `${marked} announcement${marked === 1 ? "" : "s"} marked as read.`
          : "Nothing was left unread.",
        kind: "success",
      });
      invalidate();
    },
    onError: (err) =>
      toast({ title: "Could not mark as read", message: getErrorMessage(err), kind: "error" }),
  });

  // ── Composer ───────────────────────────────────────────────────────────────
  const openCreate = () => {
      setEditing(null);
    setForm(emptyComposer());
    setComposerOpen(true);
  };

  const openEdit = (a: Announcement) => {
    setEditing(a);
    setForm({
      title:    a.title,
      body:     a.body,
      audience: a.audience,
      priority: a.priority,
      isPinned: a.isPinned,
      targetClasses: (a.targetClasses ?? []).map((c) =>
        typeof c === "string" ? c : c._id,
      ),
      expiresAt: a.expiresAt ? a.expiresAt.slice(0, 10) : "",
    });
    setComposerOpen(true);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setEditing(null);
    setForm(emptyComposer());
  };

  const askRemove = async (a: Announcement) => {
    const ok = await confirm({
      title:        "Remove this announcement?",
      message:      `"${a.title}" will disappear for everyone who can currently see it.`,
      confirmLabel: t("common.remove"),
      kind:         "danger",
    });
    if (ok) removeMutation.mutate(a._id);
  };

  // The server rejects audience:"class" with no classes chosen, so the save
  // button waits for one.
  const needsClasses = form.audience === "class";
  const canSave =
    form.title.trim().length > 0 &&
    form.body.trim().length > 0 &&
    (!needsClasses || form.targetClasses.length > 0);

  if (listQ.isLoading) return <PageSpinner />;

  if (listQ.error) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              {t("announcements.loadFailed")}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">{getErrorMessage(listQ.error)}</p>
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
          <h1 className="text-lg font-semibold text-gray-900">{t("announcements.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {listQ.data?.total ?? 0} posted · pinned notices appear first
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<CheckCheck className="w-4 h-4" />}
            loading={readAllMutation.isPending}
            onClick={() => readAllMutation.mutate()}
          >
            {t("announcements.markAllRead")}
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            {t("announcements.new")}
          </Button>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <Select
          options={[
            { value: "", label: "Every audience" },
            ...audiences.map((a) => ({ value: a, label: AUDIENCE_LABELS[a] })),
          ]}
          value={audience}
          onChange={(e) => { setAudience(e.target.value); setPage(1); }}
        />
        <Select
          options={[
            { value: "", label: "Any priority" },
            ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
          ]}
          value={priority}
          onChange={(e) => { setPriority(e.target.value); setPage(1); }}
        />
      </div>

      {/* ── List ────────────────────────────────────────────────────────── */}
      {items.length === 0 ? (
        <Card className="text-center py-16">
          <Megaphone className="w-8 h-8 text-gray-300 mx-auto" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            {audience || priority ? "Nothing matches those filters" : "No announcements yet"}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {audience || priority
              ? "Try clearing the filters."
              : "Post one to reach staff, students, or a particular class."}
          </p>
          {!audience && !priority && (
            <Button className="mt-4" size="sm" icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
              {t("announcements.writeFirst")}
            </Button>
          )}
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            {items.map((a) => {
              const state = lifecycleOf(a);
              const meta  = LIFECYCLE_LABEL[state];
              const targets = targetClassNames(a);

              return (
                <Card
                  key={a._id}
                  className={cn(
                    "transition-shadow hover:shadow-md",
                    a.isPinned && "border-primary-300 bg-primary-50/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {a.isPinned && (
                          <Pin className="w-3.5 h-3.5 text-primary-600 shrink-0" />
                        )}
                        <h3 className="text-sm font-semibold text-gray-900">
                          {a.title}
                        </h3>
                        <Badge label={PRIORITY_LABELS[a.priority]} variant={PRIORITY_VARIANT[a.priority]} />
                        <Badge label={t(meta.labelKey)} variant={meta.variant} />
                      </div>

                      <p className="mt-1.5 text-sm text-gray-600 line-clamp-2">
                        {a.body}
                      </p>

                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                        <span>{AUDIENCE_LABELS[a.audience]}</span>
                        {targets.length > 0 && (
                          <span className="text-gray-500">{targets.join(", ")}</span>
                        )}
                        {a.authorName && <span>by {a.authorName}</span>}
                        {a.createdAt && <span>{formatDate(a.createdAt)}</span>}
                        {a.expiresAt && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            expires {formatDate(a.expiresAt)}
                          </span>
                        )}
                        {typeof a.readCount === "number" && (
                          <span className="inline-flex items-center gap-1">
                            <Eye className="w-3 h-3" />
                            {a.readCount} read
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <IconAction title={t("announcements.readInFull")} onClick={() => setReading(a)}>
                        <Eye className="w-4 h-4" />
                      </IconAction>
                      {pinAllowed && (
                        <IconAction
                          title={a.isPinned ? "Unpin" : "Pin to the top"}
                          onClick={() => pinMutation.mutate(a._id)}
                        >
                          {a.isPinned
                            ? <PinOff className="w-4 h-4" />
                            : <Pin className="w-4 h-4" />}
                        </IconAction>
                      )}
                      <IconAction title={t("common.edit")} onClick={() => openEdit(a)}>
                        <Pencil className="w-4 h-4" />
                      </IconAction>
                      <IconAction title={t("common.remove")} danger onClick={() => askRemove(a)}>
                        <Trash2 className="w-4 h-4" />
                      </IconAction>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <Card padding={false}>
            <Pagination
              page={listQ.data?.page ?? page}
              pages={listQ.data?.pages ?? 1}
              total={listQ.data?.total ?? items.length}
              onPageChange={setPage}
            />
          </Card>
        </>
      )}

      {/* ── Composer ────────────────────────────────────────────────────── */}
      <Modal
        open={composerOpen}
        onClose={closeComposer}
        title={editing ? "Edit announcement" : "New announcement"}
        size="lg"
      >
        <form
          onSubmit={(e) => { e.preventDefault(); if (canSave) saveMutation.mutate(); }}
          className="space-y-4"
        >
          <FormField label={t("common.title")} required>
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={t("announcements.titlePh")}
              autoFocus
            />
          </FormField>

          <FormField label={t("common.message")} required>
            <Textarea
              rows={6}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder={t("announcements.bodyPh")}
            />
          </FormField>

          <div className="grid sm:grid-cols-2 gap-3">
            <FormField
              label={t("announcements.audience")}
              required
              hint={
                audiences.length < 4
                  ? "Teachers can post to students or their own classes."
                  : undefined
              }
            >
              <SelectField
                options={audiences.map((a) => ({ value: a, label: AUDIENCE_LABELS[a] }))}
                value={form.audience}
                onChange={(e) =>
                  setForm((f) => ({ ...f, audience: e.target.value as Audience }))
                }
              />
            </FormField>

            <FormField label={t("announcements.priority")}>
              <SelectField
                options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                value={form.priority}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priority: e.target.value as Priority }))
                }
              />
            </FormField>
          </div>

          {/* Class picker — only when it applies, and required when it does. */}
          {needsClasses && (
            <FormField
              label={t("announcements.whichClasses")}
              required
              error={
                form.targetClasses.length === 0
                  ? "Pick at least one class."
                  : undefined
              }
            >
              <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                {classes.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-400">{t("announcements.noClasses")}</p>
                ) : (
                  classes.map((c) => {
                    const id = c.id ?? c._id ?? "";
                    const checked = form.targetClasses.includes(id);
                    return (
                      <label
                        key={id}
                        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setForm((f) => ({
                              ...f,
                              targetClasses: checked
                                ? f.targetClasses.filter((x) => x !== id)
                                : [...f.targetClasses, id],
                            }))
                          }
                          className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700">
                          {[c.name, c.section].filter(Boolean).join(" ")}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </FormField>
          )}

          <FormField
            label={t("announcements.expire")}
            hint="Leave empty to keep it up indefinitely."
          >
            <Input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
          </FormField>

          {/* Pinning is admin-only server-side, so the control is simply
              absent for a teacher rather than shown and refused. */}
          {pinAllowed && (
            <Checkbox
              label={t("announcements.pin")}
              hint="Pinned announcements stay above everything else."
              checked={form.isPinned}
              onChange={(e) => setForm((f) => ({ ...f, isPinned: e.target.checked }))}
            />
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeComposer}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} loading={saveMutation.isPending}>
              {editing ? "Save changes" : "Post announcement"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Reader ──────────────────────────────────────────────────────── */}
      {reading && (
        <Modal open onClose={() => setReading(null)} title={reading.title} size="lg">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge label={PRIORITY_LABELS[reading.priority]} variant={PRIORITY_VARIANT[reading.priority]} />
              <Badge label={AUDIENCE_LABELS[reading.audience]} variant="default" />
              {reading.authorName && (
                <span className="text-xs text-gray-500">by {reading.authorName}</span>
              )}
            </div>
            {/* whitespace-pre-wrap so paragraph breaks the author typed
                survive — the body is plain text, not markup. */}
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              {reading.body}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

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
