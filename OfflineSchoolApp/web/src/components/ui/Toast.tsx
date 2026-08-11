import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  success: "text-emerald-500",
  error:   "text-red-500",
  warning: "text-amber-500",
  info:    "text-blue-500",
};

const BORDER_COLOR: Record<ToastKind, string> = {
  success: "border-emerald-200",
  error:   "border-red-200",
  warning: "border-amber-200",
  info:    "border-blue-200",
};

const BG_COLOR: Record<ToastKind, string> = {
  success: "bg-emerald-50",
  error:   "bg-red-50",
  warning: "bg-amber-50",
  info:    "bg-blue-50",
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
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-sm transition-all duration-300",
        BORDER_COLOR[entry.kind],
        BG_COLOR[entry.kind],
        entry.removing
          ? "translate-x-full opacity-0"
          : "translate-x-0 opacity-100"
      )}
    >
      <Icon
        className={cn("mt-0.5 h-5 w-5 shrink-0", ICON_COLOR[entry.kind])}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-gray-900">{entry.title}</p>
        {entry.message && (
          <p className="mt-0.5 text-sm text-gray-600 whitespace-pre-line">
            {entry.message}
          </p>
        )}
        {entry.action && (
          <button
            onClick={() => {
              entry.action!.onClick();
              onDismiss(entry.id);
            }}
            className="mt-2 inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm ring-1 ring-gray-200 hover:bg-gray-50 transition-colors"
          >
            {entry.action.label}
          </button>
        )}
      </div>

      <button
        onClick={() => onDismiss(entry.id)}
        className="shrink-0 rounded-md p-0.5 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Dismiss"
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => onResolve(false)}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <div
          className={cn(
            "mb-4 flex h-12 w-12 items-center justify-center rounded-full",
            isDanger ? "bg-red-50" : "bg-amber-50"
          )}
        >
          {isDanger ? (
            <AlertCircle className="h-6 w-6 text-red-600" />
          ) : (
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          )}
        </div>

        <h3 id="confirm-title" className="text-lg font-bold text-gray-900">
          {options.title}
        </h3>
        <p
          id="confirm-message"
          className="mt-2 text-sm text-gray-500 whitespace-pre-line"
        >
          {options.message}
        </p>

        <div className="mt-6 flex gap-3">
          <button
            ref={cancelRef}
            onClick={() => onResolve(false)}
            className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {options.cancelLabel || "Cancel"}
          </button>
          <button
            onClick={() => onResolve(true)}
            className={cn(
              "flex-1 rounded-xl py-2.5 text-sm font-semibold text-white transition-colors",
              isDanger
                ? "bg-red-600 hover:bg-red-700"
                : "bg-indigo-600 hover:bg-indigo-700"
            )}
          >
            {options.confirmLabel || "Confirm"}
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

  const value = useCallback(
    () => ({ toast, confirm }),
    [toast, confirm]
  );

  return (
    <ToastContext.Provider value={value()}>
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