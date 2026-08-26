import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/utils/cn";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  title:      string;
  message?:   string;
  kind?:      ToastKind;
  duration?:  number;       // ms — 0 = manual dismiss only
  action?:    {
    label:   string;
    onClick: () => void;
  };
}

export interface ConfirmOptions {
  title:         string;
  message:       string;
  confirmLabel?: string;
  cancelLabel?:  string;
  kind?:         "danger" | "warning" | "default";
}

interface ToastEntry extends Required<Pick<ToastOptions, "title" | "kind">> {
  id:        string;
  message?:  string;
  duration:  number;
  action?:   ToastOptions["action"];
  removing?: boolean;
}

interface ToastContextValue {
  toast:   (options: ToastOptions) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  error:   6000,
  warning: 5000,
  info:    4000,
};

const ICON: Record<ToastKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  error:   AlertCircle,
  warning: AlertTriangle,
  info:    Info,
};

const ICON_COLOR: Record<ToastKind, string> = {
  success: "text-success",
  error:   "text-danger",
  warning: "text-warning",
  info:    "text-info",
};

// A toast sits on top of the page, so it keeps a solid surface and a hairline
// rather than a tinted fill — the icon carries the kind. A tinted panel
// floating over a tinted alert on the page below was two different reds
// arguing about which one mattered.
const BORDER_COLOR: Record<ToastKind, string> = {
  success: "border-success-line",
  error:   "border-danger-line",
  warning: "border-warning-line",
  info:    "border-info-line",
};

const BG_COLOR: Record<ToastKind, string> = {
  success: "bg-surface",
  error:   "bg-surface",
  warning: "bg-surface",
  info:    "bg-surface",
};

let _idCounter = 0;
const nextId = () => `toast-${++_idCounter}-${Date.now()}`;

// ─────────────────────────────────────────────────────────
// CONTEXT
// ─────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
};

// ─────────────────────────────────────────────────────────
// SINGLE TOAST COMPONENT
// ─────────────────────────────────────────────────────────

function ToastItem({
  entry,
  onDismiss,
}: {
  entry:     ToastEntry;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = ICON[entry.kind];

  useEffect(() => {
    if (entry.duration <= 0) return;
    const timer = setTimeout(() => onDismiss(entry.id), entry.duration);
    return () => clearTimeout(timer);
  }, [entry.id, entry.duration, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border px-4 py-3 shadow-raise transition-all duration-300",
        BORDER_COLOR[entry.kind],
        BG_COLOR[entry.kind],
        entry.removing
          ? "translate-x-full opacity-0"
          : "translate-x-0 opacity-100"
      )}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", ICON_COLOR[entry.kind])}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{entry.title}</p>
        {entry.message && (
          <p className="mt-0.5 whitespace-pre-line text-xs text-ink-muted">
            {entry.message}
          </p>
        )}
        {entry.action && (
          <button
            onClick={() => {
              entry.action!.onClick();
              onDismiss(entry.id);
            }}
            className="mt-2 inline-flex h-8 items-center rounded-control border border-line-strong bg-surface px-2.5 text-xs font-medium text-ink-body transition-colors hover:bg-canvas"
          >
            {entry.action.label}
          </button>
        )}
      </div>

      <button
        onClick={() => onDismiss(entry.id)}
        className="shrink-0 rounded-control p-0.5 text-ink-faint transition-colors hover:text-ink-body"
        aria-label={t("common.dismiss")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// CONFIRM DIALOG COMPONENT
// ─────────────────────────────────────────────────────────

function ConfirmDialog({
  options,
  onResolve,
}: {
  options:   ConfirmOptions;
  onResolve: (result: boolean) => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onResolve(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onResolve]);

  const isDanger = options.kind === "danger";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
      onClick={() => onResolve(false)}
    >
      <div
        className="w-full max-w-sm rounded-card border border-line bg-surface p-5 shadow-raise animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <div
          className={cn(
            "mb-3 flex h-9 w-9 items-center justify-center rounded-card",
            isDanger ? "bg-danger-soft" : "bg-warning-soft"
          )}
        >
          {isDanger ? (
            <AlertCircle className="h-4.5 w-4.5 text-danger" />
          ) : (
            <AlertTriangle className="h-4.5 w-4.5 text-warning" />
          )}
        </div>

        <h3 id="confirm-title" className="text-base font-semibold text-ink">
          {options.title}
        </h3>
        <p
          id="confirm-message"
          className="mt-1.5 whitespace-pre-line text-sm text-ink-muted"
        >
          {options.message}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={() => onResolve(false)}
            className="h-9 rounded-control border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink-body transition-colors hover:bg-canvas"
          >
            {options.cancelLabel || t("common.cancel")}
          </button>
          <button
            onClick={() => onResolve(true)}
            className={cn(
              "h-9 rounded-control px-3.5 text-sm font-medium text-white transition-colors",
              isDanger
                ? "bg-danger hover:brightness-95"
                : "bg-primary-600 hover:bg-primary-700"
            )}
          >
            {options.confirmLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts,       setToasts]       = useState<ToastEntry[]>([]);
  const [confirmState, setConfirmState] = useState<{
    options:  ConfirmOptions;
    resolve:  (result: boolean) => void;
  } | null>(null);

  // ── Toast ──────────────────────────────────────────────

  const dismiss = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, removing: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const kind     = options.kind ?? "info";
    const duration = options.duration ?? DEFAULT_DURATION[kind];

    const entry: ToastEntry = {
      id:       nextId(),
      title:    options.title,
      message:  options.message,
      kind,
      duration,
      action:   options.action,
    };

    setToasts((prev) => [...prev, entry]);
  }, []);

  // ── Confirm ────────────────────────────────────────────

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirmState({ options, resolve });
      }),
    []
  );

  const handleConfirmResolve = useCallback(
    (result: boolean) => {
      confirmState?.resolve(result);
      setConfirmState(null);
    },
    [confirmState]
  );

  // useMemo, not useCallback-then-call: `value()` built a fresh object on every
  // render, so the context identity changed each time the provider re-rendered
  // (i.e. on every toast shown or dismissed) and re-rendered every consumer.
  // Now that the whole app's toasts come through here, that reaches every page.
  const value = useMemo(
    () => ({ toast, confirm }),
    [toast, confirm]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {createPortal(
        <div
          className="pointer-events-none fixed top-4 right-4 z-[70] flex flex-col items-end gap-2"
          aria-live="polite"
          aria-relevant="additions removals"
        >
          {toasts.map((entry) => (
            <ToastItem key={entry.id} entry={entry} onDismiss={dismiss} />
          ))}
        </div>,
        document.body
      )}

      {confirmState &&
        createPortal(
          <ConfirmDialog
            options={confirmState.options}
            onResolve={handleConfirmResolve}
          />,
          document.body
        )}
    </ToastContext.Provider>
  );
}