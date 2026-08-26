// web/src/components/layout/TopBar.tsx
import {
  Menu, Search, LogOut, ChevronDown, X, Settings,
  User, Users, BookOpen, LayoutDashboard, GraduationCap,
}                                                   from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation }                             from "react-i18next";
import { useNavigate }                              from "react-router-dom";
import { useAuthStore, useUser }                    from "@/store/auth.store";
import { cn }                                       from "@/utils/cn";
import {
  globalSearch,
  clearSearchCache,
  type SearchResult,
}                                                   from "@/utils/search";
import NotificationPanel                            from "@/components/layout/NotificationPanel";
import { LanguageSwitcher }                           from "@/components/ui/LanguageSwitcher";

interface TopBarProps {
  onMenuClick: () => void;
  title:       string;
}

// ─── Config ───────────────────────────────────────────────────────────────────
const MIN_QUERY_LENGTH = 1;
const DEBOUNCE_MS      = 300;

// ─── Type display config ──────────────────────────────────────────────────────
const TYPE_CONFIG: Record<
  SearchResult["type"],
  { label: string; icon: React.ReactNode; badge: string }
> = {
  // The icon distinguishes the kind of result; the chip does not need to
  // repeat that in a fifth colour. One neutral chip keeps a mixed result list
  // scannable instead of turning it into a swatch board.
  page: {
    label: "Pages",
    icon:  <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-ink-faint" />,
    badge: "bg-canvas text-ink-muted ring-1 ring-inset ring-line",
  },
  student: {
    label: "Students",
    icon:  <GraduationCap  className="h-3.5 w-3.5 shrink-0 text-ink-faint" />,
    badge: "bg-canvas text-ink-muted ring-1 ring-inset ring-line",
  },
  teacher: {
    label: "Teachers",
    icon:  <Users          className="h-3.5 w-3.5 shrink-0 text-ink-faint" />,
    badge: "bg-canvas text-ink-muted ring-1 ring-inset ring-line",
  },
  class: {
    label: "Classes",
    icon:  <BookOpen       className="h-3.5 w-3.5 shrink-0 text-ink-faint" />,
    badge: "bg-canvas text-ink-muted ring-1 ring-inset ring-line",
  },
  subject: {
    label: "Subjects",
    icon:  <User           className="h-3.5 w-3.5 shrink-0 text-ink-faint" />,
    badge: "bg-canvas text-ink-muted ring-1 ring-inset ring-line",
  },
};

// ─── Highlight matching text ──────────────────────────────────────────────────
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>;

  const parts = text.split(
    new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
  );

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-[3px] bg-warning-soft px-0.5 font-semibold text-warning not-italic"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function TopBar({ onMenuClick, title }: TopBarProps) {
  const { t }      = useTranslation();
  const user       = useUser();
  const { logout } = useAuthStore();
  const navigate   = useNavigate();

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen,  setSearchOpen]  = useState(false);
  const [results,     setResults]     = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading,   setIsLoading]   = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // Profile dropdown state
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Refs
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Close on outside click ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
      if (
        searchRef.current &&
        !searchRef.current.contains(e.target as Node)
      ) {
        closeSearch();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Reset active index when results change ──────────────────────────────────
  useEffect(() => {
    setActiveIndex(-1);
  }, [results]);

  // ── Debounced search ────────────────────────────────────────────────────────
  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length < MIN_QUERY_LENGTH) {
      setSearchOpen(false);
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setSearchOpen(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const data = await globalSearch(value, t);
        setResults(data);
      } catch {
        setError("Search failed. Please try again.");
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  // ── Close search ────────────────────────────────────────────────────────────
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setResults([]);
    setError(null);
  }, []);

  // ── Navigate to result ──────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (result: SearchResult) => {
      navigate(result.path);
      closeSearch();
      inputRef.current?.blur();
    },
    [navigate, closeSearch]
  );

  // ── Keyboard navigation ─────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searchOpen) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          handleSelect(results[activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        closeSearch();
        inputRef.current?.blur();
        break;
    }
  };

  // ── Logout ──────────────────────────────────────────────────────────────────
  const handleLogout = () => {
    clearSearchCache();
    logout();
    navigate("/login", { replace: true });
  };

  // ── Group results by type ───────────────────────────────────────────────────
  const grouped = results.reduce<Record<string, SearchResult[]>>(
    (acc, item) => {
      (acc[item.type] ??= []).push(item);
      return acc;
    },
    {}
  );

  const GROUP_ORDER: SearchResult["type"][] = [
    "page", "student", "teacher", "class", "subject",
  ];

  const totalResults = results.length;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 lg:px-6">

      {/* ── Left ─────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenuClick}
          className="-ml-1 rounded-control p-2 text-ink-muted hover:bg-canvas hover:text-ink-body lg:hidden"
          aria-label={t("nav.toggle")}
        >
          <Menu className="h-4.5 w-4.5" />
        </button>
        {/*
          The rail already says which section you are in, and the page renders
          its own <h1>. A third copy of the same word in 18px bold was the
          loudest thing on the screen and told you nothing — so it is a quiet
          breadcrumb here, not a heading.
        */}
        <span className="truncate text-sm font-medium text-ink-muted">
          {title}
        </span>
      </div>

      {/* ── Center: Search ───────────────────────────────────────────────── */}
      <div className="mx-auto hidden max-w-md flex-1 md:flex">
        <div className="relative w-full" ref={searchRef}>

          {/* Search Icon / Spinner */}
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            {isLoading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-400 border-t-transparent" />
            ) : (
              <Search className="h-4 w-4 text-ink-faint" />
            )}
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (searchQuery.trim().length >= MIN_QUERY_LENGTH) {
                setSearchOpen(true);
              }
            }}
            placeholder={t("common.searchPlaceholder")}
            className="
              h-9 w-full rounded-control border border-line bg-canvas
              pl-9 pr-9 text-sm text-ink-body placeholder:text-ink-faint
              transition-colors
              hover:border-line-strong
              focus:border-primary-500 focus:bg-surface focus:outline-none
            "
          />

          {/* Clear button */}
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchOpen(false);
                setResults([]);
                inputRef.current?.focus();
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint transition-colors hover:text-ink-body"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* ── Results Dropdown ──────────────────────────────────────────── */}
          {searchOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-card border border-line bg-surface shadow-raise">

              {/* Error */}
              {error && (
                <div className="px-4 py-4 text-center">
                  <p className="text-sm text-danger">{error}</p>
                </div>
              )}

              {/* Loading */}
              {isLoading && !error && (
                <div className="px-4 py-6 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-400 border-t-transparent" />
                    <p className="text-sm text-ink-muted">Searching…</p>
                  </div>
                </div>
              )}

              {/* Results */}
              {!isLoading && !error && totalResults > 0 && (
                <>
                  {/* Count header */}
                  <div className="border-b border-line bg-surface-muted px-4 py-2">
                    <p className="text-xs text-ink-faint">
                      {totalResults} result{totalResults !== 1 ? "s" : ""} for{" "}
                      <span className="font-medium text-ink-body">
                        "{searchQuery}"
                      </span>
                    </p>
                  </div>

                  <div className="max-h-80 overflow-y-auto">
                    {GROUP_ORDER.filter((type) => grouped[type]?.length).map(
                      (type) => (
                        <div key={type}>
                          {/* Group header */}
                          <div className="sticky top-0 border-y border-line bg-surface-muted px-4 py-1.5">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                              {TYPE_CONFIG[type].label}
                              <span className="ml-1.5 text-line-strong">
                                ({grouped[type].length})
                              </span>
                            </span>
                          </div>

                          {/* Group items */}
                          {grouped[type].map((item) => {
                            const globalIdx = results.indexOf(item);
                            const isActive  = activeIndex === globalIdx;

                            return (
                              <button
                                key={item.id}
                                onClick={() => handleSelect(item)}
                                className={cn(
                                  "flex w-full items-center gap-3 border-b border-line px-4 py-2 text-left transition-colors last:border-0",
                                  isActive
                                    ? "bg-primary-50"
                                    : "hover:bg-surface-muted"
                                )}
                              >
                                {/* Icon */}
                                <div
                                  className={cn(
                                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-control",
                                    isActive ? "bg-primary-100" : "bg-canvas"
                                  )}
                                >
                                  {TYPE_CONFIG[type].icon}
                                </div>

                                {/* Label + sublabel */}
                                <div className="flex-1 min-w-0">
                                  <p
                                    className={cn(
                                      "truncate text-sm font-medium",
                                      isActive
                                        ? "text-primary-700"
                                        : "text-ink"
                                    )}
                                  >
                                    <HighlightMatch
                                      text={item.label}
                                      query={searchQuery}
                                    />
                                  </p>
                                  {item.sublabel && (
                                    <p className="mt-0.5 truncate text-xs text-ink-muted">
                                      <HighlightMatch
                                        text={item.sublabel}
                                        query={searchQuery}
                                      />
                                    </p>
                                  )}
                                </div>

                                {/* Type badge */}
                                <span
                                  className={cn(
                                    "shrink-0 rounded-control px-2 py-0.5 text-[11px] font-medium",
                                    TYPE_CONFIG[type].badge
                                  )}
                                >
                                  {TYPE_CONFIG[type].label.slice(0, -1)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )
                    )}
                  </div>

                  {/* Footer hint */}
                  <div className="border-t border-line bg-surface-muted px-4 py-2">
                    <p className="text-[11px] text-ink-faint">
                      <kbd className="rounded-[3px] bg-surface px-1 ring-1 ring-inset ring-line">↑↓</kbd> navigate
                      <span className="mx-1.5 text-line-strong">·</span>
                      <kbd className="rounded-[3px] bg-surface px-1 ring-1 ring-inset ring-line">↵</kbd> open
                      <span className="mx-1.5 text-line-strong">·</span>
                      <kbd className="rounded-[3px] bg-surface px-1 ring-1 ring-inset ring-line">esc</kbd> close
                    </p>
                  </div>
                </>
              )}

              {/* No results */}
              {!isLoading && !error && totalResults === 0 && (
                <div className="px-4 py-8 text-center">
                  <Search className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
                  <p className="text-sm font-medium text-ink">
                    {t("common.noResults")}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {t("common.tryDifferent")}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: notifications + profile ───────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1">

        {/* Notification bell */}
        <NotificationPanel />

        {/* Profile dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
            aria-expanded={dropdownOpen}
            aria-haspopup="menu"
            className={cn(
              "flex items-center gap-2 rounded-control p-1 pr-1.5 transition-colors",
              dropdownOpen ? "bg-canvas" : "hover:bg-canvas"
            )}
          >
            {/*
              Neutral, not accent. The avatar is an identity marker that sits
              on every screen; painting it in the action colour competes with
              the one button on the page that is actually actionable.
            */}
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas ring-1 ring-inset ring-line-strong">
              <span className="text-xs font-semibold text-ink-body">
                {user?.name?.charAt(0).toUpperCase() ?? "?"}
              </span>
            </div>
            <span className="hidden max-w-[10rem] truncate text-[13px] font-medium text-ink-body sm:block">
              {user?.name}
            </span>
            <ChevronDown
              className={cn(
                "hidden h-3.5 w-3.5 text-ink-faint transition-transform sm:block",
                dropdownOpen && "rotate-180"
              )}
              aria-hidden="true"
            />
          </button>

          {dropdownOpen && (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-1.5 w-56 overflow-hidden rounded-card border border-line bg-surface py-1 shadow-raise"
            >
              <div className="border-b border-line px-3 py-2">
                <p className="truncate text-[13px] font-medium text-ink">
                  {user?.name}
                </p>
                <p className="truncate text-xs text-ink-muted">
                  {user?.email}
                </p>
                <p className="mt-1 text-[11px] capitalize text-ink-faint">
                  {user?.role?.replace("_", " ")}
                </p>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  navigate("/settings");
                  setDropdownOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink-body hover:bg-canvas"
              >
                <Settings className="h-4 w-4 text-ink-faint" aria-hidden="true" />
                {t("common.settings")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-danger hover:bg-danger-soft"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                {t("common.signOut")}
              </button>

              {/* Language sits in the profile menu, next to sign-out: it is a
                  personal preference, not a school setting, and this is where
                  a user already looks for "things about me". */}
              <div className="mt-1 border-t border-line pt-1">
                <LanguageSwitcher />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}