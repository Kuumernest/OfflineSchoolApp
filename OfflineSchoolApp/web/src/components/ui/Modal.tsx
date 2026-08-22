// web/src/components/ui/Modal.tsx
//
// ClassesPage has always imported this; the file did not exist, so the whole
// classes/subjects page failed to compile.
//
// Built on the native <dialog> element rather than a hand-rolled overlay. That
// buys three things a div cannot without a lot of code: the top layer (so it
// paints above everything regardless of z-index), a real focus trap, and Escape
// handling — all from the platform.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";

interface ModalProps {
  open:      boolean;
  onClose:   () => void;
  title?:    string;
  children:  React.ReactNode;
  /** Set false for a destructive confirm the user must answer deliberately. */
  closeOnBackdrop?: boolean;
  size?:     "sm" | "md" | "lg";
  className?: string;
}

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  children,
  closeOnBackdrop = true,
  size = "md",
  className,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  // showModal()/close() are imperative, so open/close is driven by an effect
  // rather than by conditional rendering. Calling showModal() on an already
  // open dialog throws, hence the `.open` guards.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Escape fires the dialog's `cancel` event and closes it natively. Without
  // telling React, `open` would stay true and the dialog could not be reopened.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const onCancel = (e: Event) => {
      e.preventDefault();  // let React own the close, so state stays in sync
      onClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  // The page behind a modal must not scroll. <dialog> does not do this itself.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Rendered into <body> so an ancestor's `overflow: hidden` or `transform`
  // cannot clip it — the dashboard shell sets both.
  return createPortal(
    <dialog
      ref={ref}
      // The backdrop is a pseudo-element of the dialog, so a click on it lands
      // on the dialog itself. Comparing the target to the dialog distinguishes
      // "clicked the backdrop" from "clicked the content".
      onClick={(e) => {
        if (!closeOnBackdrop) return;
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "w-[calc(100%-2rem)] rounded-card border border-line bg-surface p-0 shadow-raise",
        "backdrop:bg-ink/40 backdrop:backdrop-blur-[2px]",
        // <dialog> is display:block when open and centred by the UA; these keep
        // it from growing past the viewport on a small screen.
        "max-h-[calc(100vh-4rem)] overflow-y-auto",
        SIZES[size],
        className,
      )}
    >
      {title && (
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-control p-1 text-ink-faint transition-colors hover:bg-canvas hover:text-ink-body"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="px-5 py-4">{children}</div>
    </dialog>,
    document.body,
  );
}

export default Modal;
