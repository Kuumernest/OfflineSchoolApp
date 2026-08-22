// web/src/print/document.ts
//
// Putting a document in front of a printer.
//
// The documents themselves are built server-side, in backend/src/print. That is
// deliberate: the browser and the phone both print the same sheets, and a copy
// of those templates in each client is a copy that drifts — the first fix to a
// column width lands in one and not the other, and nobody notices until two
// teachers compare printouts of the same class.
//
// What stays here is the half that genuinely differs per client: the browser
// knows about iframes and popup blockers, the phone knows about expo-print.

/**
 * Print without opening a tab.
 *
 * A hidden same-origin iframe rather than `window.open`, which popup blockers
 * stop by default unless the call is judged a direct result of a click — and a
 * blocked print window fails silently, so the user taps Print and nothing at
 * all happens.
 *
 * The frame is kept until `afterprint` because removing it while the print
 * dialog is still reading from it cancels the job in Chrome.
 */
export const printHtml = (html: string): void => {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right    = "0";
  frame.style.bottom   = "0";
  frame.style.width    = "0";
  frame.style.height   = "0";
  frame.style.border   = "0";

  document.body.appendChild(frame);

  const cleanUp = () => {
    // Guarded: afterprint and the fallback timer can both fire.
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  };

  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) { cleanUp(); return; }

    win.addEventListener("afterprint", cleanUp, { once: true });
    // Some browsers never fire afterprint; without this the frame leaks.
    setTimeout(cleanUp, 60_000);

    win.focus();
    win.print();
  };

  const doc = frame.contentDocument;
  if (!doc) { cleanUp(); return; }
  doc.open();
  doc.write(html);
  doc.close();
};

/** Opens the document in a new tab, for checking it before spending paper. */
export const previewHtml = (html: string): void => {
  const blob = new Blob([html], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  // Revoked late: revoking immediately can beat the new tab to the load.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
