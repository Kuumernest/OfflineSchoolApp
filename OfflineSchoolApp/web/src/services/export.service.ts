// web/src/services/export.service.ts
import api, { TIMEOUTS } from "@/services/api";

const BASE = "/exports";

export type ExportKind =
  | "students" | "arrears" | "payments" | "expenses" | "payroll" | "enrollments";

export interface ExportParams {
  classId?:      string;
  academicYear?: string;
  from?:         string;
  to?:           string;
  periodMonth?:  string;
  status?:       string;
}

/** Which exports the signed-in user may run. */
export async function listExports(): Promise<ExportKind[]> {
  const { data } = await api.get(BASE);
  return (data as { data: ExportKind[] }).data ?? [];
}

/**
 * Download one export and hand it to the browser.
 *
 * The filename comes from Content-Disposition rather than being rebuilt here,
 * so the file a bursar receives is named the same whether it came from this
 * console or from the phone. That header is only readable because the server
 * exposes it — a cross-origin response hides it by default, and the download
 * would silently land as "students" with no extension.
 *
 * @returns the number of rows the server reported writing
 */
export async function downloadExport(
  kind: ExportKind,
  schoolId: string,
  lang: string,
  params: ExportParams = {}
): Promise<number> {
  const response = await api.get(`${BASE}/${kind}`, {
    params: { schoolId, lang, ...params },
    responseType: "blob",
    // The workbook is built server-side before a single byte comes back.
    timeout: TIMEOUTS.long,
  });

  const disposition = String(response.headers?.["content-disposition"] ?? "");
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const fileName = match ? match[1] : `${kind}.xlsx`;

  const url = URL.createObjectURL(response.data as Blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  // Appended to the document because Firefox ignores a click on a link that is
  // not in the tree.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked late: revoking immediately can beat the browser to the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return Number(response.headers?.["x-export-rows"] ?? 0);
}
