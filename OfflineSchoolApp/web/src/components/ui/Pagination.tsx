// web/src/components/ui/Pagination.tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation }            from "react-i18next";
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
  const { t } = useTranslation();
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
    <div className="flex items-center justify-between gap-4 border-t border-line px-1 pt-3">
      {/* One interpolated sentence per clause rather than words wrapped around
          <span>s — "Page 2 sur 5" and "Page 2 of 5" put the numbers in the same
          places, but a translator cannot move them if they are separate nodes. */}
      <p className="text-xs text-ink-muted tabular">
        {t("pagination.summary", { page, pages })}
        <span className="mx-1.5 text-line-strong">·</span>
        {t("pagination.total", { count: total })}
      </p>

      <div className="flex items-center gap-1">
        {/* Prev */}
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-control text-ink-muted transition-colors",
            "hover:bg-canvas hover:text-ink-body",
            "disabled:pointer-events-none disabled:opacity-30"
          )}
          aria-label={t("pagination.prev")}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {/* Page numbers */}
        {pageNumbers.map((p, idx) =>
          p === "..." ? (
            <span
              key={`dots-${idx}`}
              className="px-1 text-xs text-ink-faint"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={cn(
                "h-8 min-w-8 rounded-control px-2 text-xs font-medium tabular transition-colors",
                page === p
                  ? "bg-primary-600 text-white"
                  : "text-ink-muted hover:bg-canvas hover:text-ink-body"
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
            "flex h-8 w-8 items-center justify-center rounded-control text-ink-muted transition-colors",
            "hover:bg-canvas hover:text-ink-body",
            "disabled:pointer-events-none disabled:opacity-30"
          )}
          aria-label={t("pagination.next")}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}