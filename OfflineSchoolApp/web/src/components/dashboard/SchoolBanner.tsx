// web/src/components/dashboard/SchoolBanner.tsx
import { MapPin, School }   from "lucide-react";
import { resolveLogoSrc }     from "@/utils/logoSrc";

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

/**
 * School identity line, sat inside the page header rather than in a tinted
 * banner of its own.
 *
 * It used to be a full-width indigo panel — the first and loudest thing on the
 * page, spending the top of the screen restating something the admin already
 * knows. It is context, so it is now drawn as context.
 */
export default function SchoolBanner({ school }: { school: SchoolInfo }) {
  const logoSrc  = resolveLogoSrc(
    school.logo || school.logoUrl || school.logoBase64
  );
  const location = [school.city, school.state, school.country].filter(Boolean).join(", ");

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-control bg-surface ring-1 ring-inset ring-line">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt=""
            className="h-full w-full object-contain"
            onError={(e) => {
              const img = e.currentTarget;
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
          <School className="h-4 w-4 text-ink-faint" />
        </span>
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink-body">
          {school.name}
        </p>
        <p className="flex items-center gap-2 text-xs text-ink-faint">
          {location && (
            <span className="flex min-w-0 items-center gap-1">
              <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{location}</span>
            </span>
          )}
          {school.motto && (
            <span className="hidden truncate italic sm:inline">
              &ldquo;{school.motto}&rdquo;
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
