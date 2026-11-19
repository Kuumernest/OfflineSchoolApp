// web/src/pages/gate/HistoryPanel.tsx
//
// The last passages: what the server has recorded, with this device's unsent
// scans on top, marked as waiting. A scan that is only on this machine must
// look different from one that is safely recorded — the operator is the one
// who will be asked "did she come in?" if the laptop is closed before it syncs.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { History, LogIn, LogOut, CreditCard, Search, UploadCloud, CloudCheck } from "lucide-react";

import { Card, CardHeader } from "@/components/ui/Card";
import { useFormat } from "@/i18n/format";
import type { GateHistoryRow, QueuedScan } from "@/services/gate.service";
import type { ComplianceStatus } from "../../../../shared/compliance.js";
import { StatusPill } from "./VerificationCard";

interface Row {
  id:        string;
  name:      string | null;
  enrollmentNo: string | null;
  at:        string;
  direction: "in" | "out" | null;
  method:    "card" | "manual";
  status:    ComplianceStatus | null;
  waiting:   boolean;
  voided:    boolean;
}

export function HistoryPanel({
  rows, queue, showStatus, loadFailed,
}: {
  rows:       GateHistoryRow[];
  queue:      QueuedScan[];
  showStatus: boolean;
  loadFailed: boolean;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();

  const merged = useMemo<Row[]>(() => {
    const fromQueue: Row[] = queue.map((q) => ({
      id:        q.body._id,
      name:      q.display.name,
      enrollmentNo: q.display.enrollmentNo,
      at:        q.body.at,
      direction: q.body.direction ?? null,
      method:    q.display.method,
      status:    q.display.status,
      waiting:   true,
      voided:    false,
    }));
    const fromServer: Row[] = rows.map((r) => ({
        id:        String(r._id),
        name:      r.studentName,
        enrollmentNo: r.enrollmentNo,
        at:        r.at,
        direction: r.direction,
        method:    r.method ?? "card",
        status:    r.serverVerification?.status ?? r.verification?.status ?? null,
        waiting:   false,
        voided:    r.voided,
      }));
    // A scan that reached the server but whose answer did not is in both
    // lists until the queue replays it; the server's copy is the one to show.
    const serverIds = new Set(fromServer.map((r) => r.id));
    return [...fromQueue.filter((r) => !serverIds.has(r.id)), ...fromServer]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [rows, queue]);

  return (
    <Card padding={false}>
      <div className="p-5 pb-3">
        <CardHeader title={t("gatePage.history.title")} icon={History} />
      </div>
      {loadFailed && (
        <p className="px-5 pb-2 text-xs text-ink-muted">{t("gatePage.history.offline")}</p>
      )}
      {merged.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-muted">{t("gatePage.history.empty")}</p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto">
          {merged.map((r) => {
            const DirIcon = r.direction === "out" ? LogOut : LogIn;
            return (
              <li key={r.id} className={r.voided ? "px-5 py-2.5 opacity-60" : "px-5 py-2.5"}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {r.name ?? t("gatePage.unknownCard")}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span>{fmt.time(r.at)}</span>
                      {r.direction ? (
                        <span className="inline-flex items-center gap-1">
                          <DirIcon className="h-3 w-3" aria-hidden="true" />
                          {r.direction === "out" ? t("gatePage.dirOut") : t("gatePage.dirIn")}
                        </span>
                      ) : (
                        <span>{t("gatePage.dirLater")}</span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        {r.method === "manual"
                          ? <Search className="h-3 w-3" aria-hidden="true" />
                          : <CreditCard className="h-3 w-3" aria-hidden="true" />}
                        {r.method === "manual" ? t("gatePage.methodManual") : t("gatePage.methodCard")}
                      </span>
                      {r.voided && <span>{t("gatePage.history.voided")}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {showStatus && r.status && <StatusPill status={r.status} />}
                    {r.waiting ? (
                      <span className="inline-flex items-center gap-1 text-xs text-info-text">
                        <UploadCloud className="h-3 w-3" aria-hidden="true" />
                        {t("gatePage.history.waiting")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-ink-faint">
                        <CloudCheck className="h-3 w-3" aria-hidden="true" />
                        {t("gatePage.history.synced")}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
