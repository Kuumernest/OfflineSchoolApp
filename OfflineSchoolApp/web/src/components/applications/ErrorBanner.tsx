// web/src/components/applications/ErrorBanner.tsx

import React from "react";

interface ErrorBannerProps {
  message: string;
  onRetry: () => void;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  message,
  onRetry,
}) => (
  <div
    className="flex items-center gap-3 bg-red-50 border border-red-200
               rounded-xl px-4 py-3 mb-4 mt-2"
    role="alert"
  >
    <svg
      className="w-5 h-5 text-red-600 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
    <p className="flex-1 text-sm text-red-700 font-medium">{message}</p>
    <button
      onClick={onRetry}
      className="text-sm text-red-600 font-bold hover:underline
                 focus:outline-none focus:ring-2 focus:ring-red-400 rounded"
    >
      Retry
    </button>
  </div>
);