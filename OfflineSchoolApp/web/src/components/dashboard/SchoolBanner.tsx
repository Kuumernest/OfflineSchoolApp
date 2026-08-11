// web/src/components/dashboard/SchoolBanner.tsx
import { MapPin, School } from "lucide-react";

interface SchoolInfo {
  name:      string;
  city?:     string;
  state?:    string;
  country?:  string;
  motto?:    string;
  logo?:     string;
  logoUrl?:  string;
  logoBase64?: string;
}

const resolveLogoSrc = (school: SchoolInfo): string | null => {
  const raw = school.logo || school.logoUrl || school.logoBase64 || null;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return null;
  const t = raw.trim();
  if (t.startsWith("http") || t.startsWith("data:")) return t;
  const mime = t.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${t}`;
};

export default function SchoolBanner({ school }: { school: SchoolInfo }) {
  const logoSrc  = resolveLogoSrc(school);
  const location = [school.city, school.state, school.country].filter(Boolean).join(", ");

  return (
    <div className="flex items-center gap-4 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 px-4 py-3">

      {/* Logo / fallback */}
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-indigo-100 dark:border-indigo-700 bg-white dark:bg-gray-800 flex items-center justify-center">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={`${school.name} logo`}
            className="h-full w-full object-contain"
            onError={(e) => {
              const img      = e.currentTarget;
              img.style.display = "none";
              const fallback = img.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "flex";
            }}
          />
        ) : null}
        <span
          className="hidden h-full w-full items-center justify-center"
          style={logoSrc ? undefined : { display: "flex" }}
          aria-hidden="true"
        >
          <School className="h-6 w-6 text-indigo-400" />
        </span>
      </div>

      {/* Text */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-indigo-900 dark:text-indigo-100 truncate leading-tight">
          {school.name}
        </p>
        {location && (
          <p className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{location}</span>
          </p>
        )}
        {school.motto && (
          <p className="text-xs text-indigo-500 dark:text-indigo-400 italic font-medium mt-0.5 truncate">
            &ldquo;{school.motto}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}