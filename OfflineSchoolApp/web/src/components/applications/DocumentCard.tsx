// web/src/components/applications/DocumentCard.tsx

import React from "react";
import type { ApplicationDocument } from "../../types/applications";

interface DocumentCardProps {
  doc:    ApplicationDocument;
  index:  number;
  onOpen: (doc: ApplicationDocument) => void;
}

export const DocumentCard: React.FC<DocumentCardProps> = ({
  doc,
  index,
  onOpen,
}) => (
  <button
    onClick={() => onOpen(doc)}
    className="flex items-center gap-3 w-full bg-gray-50 border border-gray-200
               rounded-xl p-3 mb-2 last:mb-0 hover:bg-gray-100 transition-colors
               text-left focus:outline-none focus:ring-2 focus:ring-emerald-400"
  >
    {/* Icon */}
    <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center
                    justify-center flex-shrink-0">
      <svg
        className="w-[18px] h-[18px] text-emerald-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4
             4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
        />
      </svg>
    </div>

    {/* Text */}
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-gray-900 truncate">
        {doc.title || `Document ${index + 1}`}
      </p>
      <p className="text-xs text-gray-400 truncate mt-0.5">
        {doc.type || "Attached document"}
      </p>
    </div>

    {/* Open icon */}
    <svg
      className="w-[18px] h-[18px] text-gray-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14
           4h6m0 0v6m0-6L10 14"
      />
    </svg>
  </button>
);