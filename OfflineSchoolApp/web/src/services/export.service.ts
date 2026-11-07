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
): Promise<{ rows: number; fileName: string }> {
  let response;
  try {
    response = await api.get(`${BASE}/${kind}`, {
      params: { schoolId, lang, ...params },
      responseType: "blob",
      // The workbook is built server-side before a single byte comes back.
      timeout: TIMEOUTS.long,
    });
  } catch (err) {
    // With responseType "blob" the server's JSON error arrives as a Blob, so
    // getErrorMessage found no message or code in it and the toast could only
    // say "something went wrong". Put the parsed body back where it looks.
    const res = (err as { response?: { data?: unknown } })?.response;
    if (res && res.data instanceof Blob) {
      try {
        res.data = JSON.parse(await res.data.text());
      } catch {
        // Not JSON: the original error says as much as there is to say.
      }
    }
    throw err;
  }

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

  return { rows: Number(response.headers?.["x-export-rows"] ?? 0), fileName };
}
