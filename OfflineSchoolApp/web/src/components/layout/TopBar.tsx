// web/src/components/layout/TopBar.tsx
import {
  Menu, Search, LogOut, ChevronDown, X,
  User, Users, BookOpen, LayoutDashboard, GraduationCap,
}                                                   from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate }                              from "react-router-dom";
import { useAuthStore, useUser }                    from "@/store/auth.store";
import { cn }                                       from "@/utils/cn";
import {
  globalSearch,
  clearSearchCache,
  type SearchResult,
}                                                   from "@/utils/search";
import NotificationPanel                            from "@/components/layout/NotificationPanel";

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
  page: {
    label: "Pages",
    icon:  <LayoutDashboard className="w-3.5 h-3.5 text-gray-400   shrink-0" />,
    badge: "bg-gray-100  text-gray-600",
  },
  student: {
    label: "Students",
    icon:  <GraduationCap  className="w-3.5 h-3.5 text-blue-400   shrink-0" />,
    badge: "bg-blue-50   text-blue-600",
  },
  teacher: {
    label: "Teachers",
    icon:  <Users          className="w-3.5 h-3.5 text-green-400  shrink-0" />,
    badge: "bg-green-50  text-green-600",
  },
  class: {
    label: "Classes",
    icon:  <BookOpen       className="w-3.5 h-3.5 text-purple-400 shrink-0" />,
    badge: "bg-purple-50 text-purple-600",
  },
  subject: {
    label: "Subjects",
    icon:  <User           className="w-3.5 h-3.5 text-orange-400 shrink-0" />,
    badge: "bg-orange-50 text-orange-600",
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
            className="bg-yellow-100 text-yellow-800 rounded px-0.5 not-italic"
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
        const data = await globalSearch(value);
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
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6 shrink-0">

      {/* ── Left ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold text-gray-800">{title}</h1>
      </div>

      {/* ── Center: Search ───────────────────────────────────────────────── */}
      <div className="hidden md:flex flex-1 max-w-md mx-8">
        <div className="relative w-full" ref={searchRef}>

          {/* Search Icon / Spinner */}
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            {isLoading ? (
              <div className="w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Search className="w-4 h-4 text-gray-400" />
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
            placeholder="Search students, teachers, classes…"
            className="
              w-full pl-9 pr-9 py-2 text-sm bg-gray-50 border border-gray-200
              rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500
              focus:border-transparent transition-colors
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
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* ── Results Dropdown ──────────────────────────────────────────── */}
          {searchOpen && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden">

              {/* Error */}
              {error && (
                <div className="px-4 py-4 text-center">
                  <p className="text-sm text-red-500">{error}</p>
                </div>
              )}

              {/* Loading */}
              {isLoading && !error && (
                <div className="px-4 py-6 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-gray-500">Searching…</p>
                  </div>
                </div>
              )}

              {/* Results */}
              {!isLoading && !error && totalResults > 0 && (
                <>
                  {/* Count header */}
                  <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
                    <p className="text-xs text-gray-400">
                      {totalResults} result{totalResults !== 1 ? "s" : ""} for{" "}
                      <span className="font-medium text-gray-600">
                        "{searchQuery}"
                      </span>
                    </p>
                  </div>

                  <div className="max-h-80 overflow-y-auto">
                    {GROUP_ORDER.filter((type) => grouped[type]?.length).map(
                      (type) => (
                        <div key={type}>
                          {/* Group header */}
                          <div className="px-4 py-1.5 bg-gray-50 border-y border-gray-100 sticky top-0">
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                              {TYPE_CONFIG[type].label}
                              <span className="ml-1.5 text-gray-300">
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
                                  "w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors border-b border-gray-50 last:border-0",
                                  isActive
                                    ? "bg-primary-50"
                                    : "hover:bg-gray-50"
                                )}
                              >
                                {/* Icon */}
                                <div
                                  className={cn(
                                    "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                                    isActive ? "bg-primary-100" : "bg-gray-100"
                                  )}
                                >
                                  {TYPE_CONFIG[type].icon}
                                </div>

                                {/* Label + sublabel */}
                                <div className="flex-1 min-w-0">
                                  <p
                                    className={cn(
                                      "text-sm font-medium truncate",
                                      isActive
                                        ? "text-primary-700"
                                        : "text-gray-800"
                                    )}
                                  >
                                    <HighlightMatch
                                      text={item.label}
                                      query={searchQuery}
                                    />
                                  </p>
                                  {item.sublabel && (
                                    <p className="text-xs text-gray-400 truncate mt-0.5">
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
                                    "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
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
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                    <p className="text-xs text-gray-400">
                      ↑↓ Navigate · Enter Select · Esc Close
                    </p>
                  </div>
                </>
              )}

              {/* No results */}
              {!isLoading && !error && totalResults === 0 && (
                <div className="px-4 py-8 text-center">
                  <Search className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm font-medium text-gray-600">
                    No results found
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Try a different name or keyword
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: notifications + profile ───────────────────────────────── */}
      <div className="flex items-center gap-2">

        {/* Notification bell */}
        <NotificationPanel />

        {/* Profile dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            className="flex items-center gap-2 p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
              <span className="text-white text-sm font-bold">
                {user?.name?.charAt(0).toUpperCase() ?? "?"}
              </span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-gray-800 leading-none">
                {user?.name}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 capitalize">
                {user?.role?.replace("_", " ")}
              </p>
            </div>
            <ChevronDown
              className={cn(
                "w-4 h-4 text-gray-400 transition-transform hidden sm:block",
                dropdownOpen && "rotate-180"
              )}
            />
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50">
              <div className="px-4 py-2 border-b border-gray-100">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {user?.name}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {user?.email}
                </p>
              </div>
              <button
                onClick={() => {
                  navigate("/settings");
                  setDropdownOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Settings
              </button>
              <button
                onClick={handleLogout}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}