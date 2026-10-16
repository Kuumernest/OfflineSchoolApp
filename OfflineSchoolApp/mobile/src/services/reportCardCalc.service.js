// mobile/src/services/reportCardCalc.service.js
//
// "Calculate & Generate Report Card" on the admin pupil-result screen
// (app/admin/exams/results/[examId]/student/[studentId].js).
//
// The server recalculates the WHOLE CLASS for the exam from the stored
// marks — the same calculation as processing the exam (docs/39 §21.1,
// backend examProcess.service) — and refuses with 409 PUBLISHED_RESULTS when
// any result in the class is published. Nothing typed on the phone is sent:
// marks are corrected in mark entry, and the scale, pass mark and
// coefficients are the school's.

/** The confirmation shown before the request, as i18n keys. */
export const CONFIRM = Object.freeze({
  title:   "studentResult.calcConfirmTitle",
  body:    "studentResult.calcConfirmBody",
  confirm: "studentResult.calcConfirm",
});

/**
 * Recalculate the pupil's class for the exam.
 *
 * @param {{ post: Function }} api   the app's axios instance
 * @param {string} examId
 * @param {string} studentId
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number|null, code: string|null, message: string|null }>}
 */
export async function recalculateClass(api, examId, studentId) {
  try {
    const { data } = await api.post(
      `/results/${encodeURIComponent(examId)}/student/${encodeURIComponent(studentId)}/reportcard/calculate`,
      {}
    );
    if (!data?.success) {
      return { ok: false, status: null, code: data?.code ?? null, message: data?.error ?? data?.message ?? null };
    }
    return { ok: true, data: data.data };
  } catch (err) {
    const res = err?.response;
    return {
      ok: false,
      status:  res?.status ?? null,
      code:    res?.data?.code ?? null,
      message: res?.data?.error ?? res?.data?.message ?? null,
    };
  }
}
