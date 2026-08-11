// web/src/components/applications/Toast.tsx

import React, { useEffect, useState } from "react";
import type { ToastMessage }          from "../../types/applications";

const BG: Record<string, string> = {
  success: "bg-emerald-600",
  warning: "bg-amber-500",
  info:    "bg-indigo-600",
  error:   "bg-red-600",
};

interface ToastProps extends ToastMessage {
  duration?: number;
  onDismiss?: () => void;
}

export const Toast: React.FC<ToastProps> = ({
  type,
  message,
  duration = 4500,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  if (!visible) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`
        fixed bottom-6 left-1/2 -translate-x-1/2 z-[100]
        px-5 py-3 rounded-2xl shadow-xl max-w-sm w-[90vw]
        text-white text-sm font-medium text-center
        animate-[fadeInUp_0.3s_ease-out]
        ${BG[type] || BG.info}
      `}
    >
      {message}
    </div>
  );
};