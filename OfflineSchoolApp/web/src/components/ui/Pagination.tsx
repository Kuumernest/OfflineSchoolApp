// web/src/components/ui/Pagination.tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn }                        from "@/utils/cn";

interface PaginationProps {
  page:         number;
  pages:        number;
  total:        number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  pages,
  total,
  onPageChange,
}: PaginationProps) {
  if (pages <= 1) return null;

  // Build page number array with ellipsis
  const pageNumbers: (number | "...")[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || (i >= page - 1 && i <= page + 1)) {
      pageNumbers.push(i);
    } else if (pageNumbers[pageNumbers.length - 1] !== "...") {
      pageNumbers.push("...");
    }
  }

  return (
    <div className="flex items-center justify-between px-2 py-3">
      <p className="text-sm text-gray-500">
        Showing page{" "}
        <span className="font-medium">{page}</span> of{" "}
        <span className="font-medium">{pages}</span>{" "}
        ({total.toLocaleString()} total)
      </p>

      <div className="flex items-center gap-1">
        {/* Prev */}
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className={cn(
            "p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors",
            "disabled:opacity-30 disabled:cursor-not-allowed"
          )}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* Page numbers */}
        {pageNumbers.map((p, idx) =>
          p === "..." ? (
            <span
              key={`dots-${idx}`}
              className="px-2 text-gray-400 text-sm"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={cn(
                "w-8 h-8 rounded-lg text-sm font-medium transition-colors",
                page === p
                  ? "bg-primary-600 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              )}
            >
              {p}
            </button>
          )
        )}

        {/* Next */}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages}
          className={cn(
            "p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors",
            "disabled:opacity-30 disabled:cursor-not-allowed"
          )}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}