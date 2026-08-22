// web/src/services/document.service.ts
import api from "@/services/api";

const BASE = "/documents";

/**
 * Fetch a finished, printable document.
 *
 * Returns HTML rather than data because the template lives on the server — see
 * print/document.ts for why. `lang` goes with the request so the sheet is
 * printed in the language the user is reading the console in.
 */
async function fetchDocument(path: string, params: Record<string, string>): Promise<string> {
  const { data } = await api.get(`${BASE}${path}`, {
    params: { ...params, format: "html" },
    // Without this axios tries to parse an HTML body as JSON and hands back
    // something unusable.
    responseType: "text",
    transformResponse: [(body: string) => body],
  });
  return data as string;
}

export const fetchClassListHtml = (
  classId: string, schoolId: string, variant: string, lang: string
): Promise<string> =>
  fetchDocument(`/class-list/${classId}`, { schoolId, variant, lang });

export const fetchTranscriptHtml = (
  studentId: string, schoolId: string, lang: string
): Promise<string> =>
  fetchDocument(`/transcript/${studentId}`, { schoolId, lang });

/** A whole class of ID cards, ten to an A4 sheet. */
export const fetchIdCardsHtml = (
  classId: string, schoolId: string, lang: string
): Promise<string> =>
  fetchDocument(`/id-cards/${classId}`, { schoolId, lang });
