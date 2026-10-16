// web/src/components/results/UnpublishButton.tsx
//
// "Unpublish…" beside Publish, for a class's sequence, term or annual
// results. Unpublishing is one class at a time and needs a reason, which is
// recorded (backend services/unpublish.service.js); the figures do not
// change, and report cards already issued stay as issued.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Undo2, Loader2 } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { useUnpublishResults } from "@/hooks/useExamResults";
import type { UnpublishLayer } from "@/services/exam.service";

interface Props {
  layer:         UnpublishLayer;
  /** The classes it can apply to; with one, no choice is offered. */
  classOptions:  { id: string; name: string }[];
  /** A class already chosen on the page (the filter), if any. */
  classId?:      string;
  examId?:       string;
  academicYear?: string;
  term?:         number;
  disabled?:     boolean;
}

export function UnpublishButton({ layer, classOptions, classId, examId, academicYear, term, disabled }: Props) {
  const { t } = useTranslation();
  const [open, setOpen]       = useState(false);
  const [chosen, setChosen]   = useState(classId ?? "");
  const [reason, setReason]   = useState("");
  const mutation = useUnpublishResults(layer);

  const target = classId || chosen || (classOptions.length === 1 ? classOptions[0].id : "");
  const ready  = Boolean(target) && reason.trim().length >= 4 && !mutation.isPending;

  const submit = () => {
    if (!ready) return;
    mutation.mutate(
      { classId: target, reason: reason.trim(), examId, academicYear, term },
      { onSuccess: () => { setOpen(false); setReason(""); } },
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setChosen(classId ?? ""); setOpen(true); }}
        disabled={disabled}
        className="flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium
                   text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Undo2 className="h-4 w-4" />
        {t("unpublish.action")}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("unpublish.title")} closeOnBackdrop={false} size="sm">
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">{t(`unpublish.body_${layer}`)}</p>
          <p className="text-gray-600">{t("unpublish.issuedStay")}</p>

          {!classId && classOptions.length > 1 && (
            <label className="block">
              <span className="text-xs font-semibold text-gray-700">{t("unpublish.class")}</span>
              <select
                value={chosen}
                onChange={(e) => setChosen(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5"
              >
                <option value="">{t("unpublish.chooseClass")}</option>
                {classOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}

          <label className="block">
            <span className="text-xs font-semibold text-gray-700">{t("unpublish.reason")}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={t("unpublish.reasonPh")}
              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5"
            />
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-100">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!ready}
              className="flex items-center gap-2 rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white
                         hover:bg-red-700 disabled:opacity-50"
            >
              {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("unpublish.confirm")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
