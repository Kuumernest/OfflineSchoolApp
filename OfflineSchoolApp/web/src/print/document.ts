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
 * Resolves once every image in `doc` has loaded or failed, or after `limitMs`.
 *
 * A sheet printed before its logo or a pupil's photo has arrived prints with a
 * blank box, and the PDF saved from that dialog keeps the blank. Failures count
 * as settled: a missing photo must not hold the print dialog back for ever, and
 * the template already shows its empty state for one.
 */
export const imagesSettled = (doc: Document, limitMs = 10_000): Promise<void> => {
  const pending = Array.from(doc?.images ?? []).filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let left = pending.length;
    const timer = setTimeout(resolve, limitMs);
    const done = () => { if (--left === 0) { clearTimeout(timer); resolve(); } };
    for (const img of pending) {
      img.addEventListener("load",  done, { once: true });
      img.addEventListener("error", done, { once: true });
    }
  });
};

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
 *
 * Resolves true once the frame has loaded and `print()` has been invoked, and
 * false if the document cannot be written or the frame does not load. It does
 * not claim the reader accepted or completed the print job — the browser does
 * not tell us that.
 */
export const printHtml = (html: string): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cleanUp: (() => void) | null = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(ok);
    };

    try {
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.position = "fixed";
      frame.style.right    = "0";
      frame.style.bottom   = "0";
      frame.style.width    = "0";
      frame.style.height   = "0";
      frame.style.border   = "0";

      document.body.appendChild(frame);

      cleanUp = () => {
        // Guarded: afterprint and the fallback timer can both fire.
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      };

      frame.onload = () => {
        if (settled) return;
        const win = frame.contentWindow;
        if (!win) { cleanUp?.(); finish(false); return; }

        win.addEventListener("afterprint", cleanUp!, { once: true });
        // Some browsers never fire afterprint; without this the frame leaks.
        setTimeout(() => cleanUp?.(), 60_000);

        // The frame's load normally waits for its images; this makes it a
        // rule rather than a browser habit, since an image added late or
        // still decoding prints as a blank box.
        void imagesSettled(frame.contentDocument ?? win.document).then(() => {
          try {
            win.focus();
            // The load watchdog stops at the point print() is invoked. A print
            // dialog may legitimately stay open longer than the load timeout.
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            win.print();
            finish(true);
          } catch {
            cleanUp?.();
            finish(false);
          }
        });
      };

      const doc = frame.contentDocument;
      if (!doc) { cleanUp?.(); finish(false); return; }
      doc.open();
      doc.write(html);
      doc.close();

      /*
       * A frame that never loads must not leave the caller waiting for ever.
       * The frame is removed, and the caller reports that the print request
       * could not be initiated.
       */
      if (!settled) {
        timeout = setTimeout(() => {
          cleanUp?.();
          finish(false);
        }, 30_000);
      }
    } catch {
      cleanUp?.();
      finish(false);
    }
  });
};

/**
 * Open the preview tab from the click itself.
 *
 * This must be called synchronously in the click handler, before the first
 * `await`. A `window.open` after a network request is no longer part of the
 * user's gesture, so browsers treat it as an unsolicited popup and return
 * `null` — silently, with nothing in the console. The window stays blank until
 * the caller has the finished document.
 */
export const openPreviewWindow = (): Window | null => {
  try {
    const win = window.open("", "_blank");
    return win && !win.closed ? win : null;
  } catch {
    return null;
  }
};

/**
 * Write a fetched document into an already-open preview window.
 *
 * Returns false when the window was closed (or could not be written to), so
 * the caller can say the card was not shown instead of counting it as success.
 * `print` asks for the print dialog once the document has loaded; it never
 * claims the dialog appeared, because the browser does not tell us.
 * `onPrint` runs once print() has been invoked, and not if it never was.
 */
export const showInPreviewWindow = (
  win: Window,
  html: string,
  { print = true, onPrint }: { print?: boolean; onPrint?: () => void } = {}
): boolean => {
  if (!win || win.closed) return false;

  try {
    const doc = win.document;
    if (!doc) return false;

    let requested = false;
    const requestPrint = () => {
      if (requested || win.closed) return;
      requested = true;
      try {
        win.focus();
        win.print();
        onPrint?.();
      } catch {
        // The preview is still readable; the reader can print from it.
      }
    };

    doc.open();
    doc.write(html);
    doc.close();
    win.focus();

    // Not a `load` listener: one added before document.open() is erased by
    // it (the open replaces the window's listeners), so the dialog depended
    // on a fixed 4-second timer — too soon for a slow logo or photo, which
    // then printed blank, and needlessly late for everything else. Wait for
    // the images themselves, with a bound.
    if (print) void imagesSettled(win.document).then(requestPrint);
    return true;
  } catch {
    return false;
  }
};

/** Opens the document in a new tab, for checking it before spending paper. */
export const previewHtml = (html: string): void => {
  const blob = new Blob([html], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  // Revoked late: revoking immediately can beat the new tab to the load.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
