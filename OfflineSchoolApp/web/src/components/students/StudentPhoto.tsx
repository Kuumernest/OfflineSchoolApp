// web/src/components/students/StudentPhoto.tsx
//
// A pupil's passport photo, or their initial when there is none.
//
// The one renderer for Student.photoUrl on the web (and so the desktop, which
// runs this build): profile, lists, dashboards and the gate screen all use it.
// It goes through useAuthedImage because a photo is a private upload — a bare
// <img src="/uploads/photos/…"> is refused by the server (no token), which is
// the trap every hand-rolled renderer falls into.

import { useAuthedImage } from "@/hooks/useAuthedImage";
import { cn } from "@/utils/cn";

const SIZES = {
  sm: "h-9 w-9 text-sm",
  md: "h-16 w-16 text-2xl",
  lg: "h-28 w-24 text-4xl",
  xl: "h-40 w-32 text-5xl",
} as const;

export interface StudentPhotoProps {
  photoUrl?: string | null;
  name?:     string | null;
  size?:     keyof typeof SIZES;
  /** "circle" for list avatars, "card" for the passport shape. */
  shape?:    "circle" | "card";
  /** Fallback tint; defaults to the primary palette. */
  tone?:     "primary" | "danger";
  className?: string;
}

export function StudentPhoto({
  photoUrl, name, size = "sm", shape = "circle", tone = "primary", className,
}: StudentPhotoProps) {
  const src = useAuthedImage(photoUrl ?? null);
  const initial = (String(name ?? "").trim()[0] ?? "?").toUpperCase();

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden font-bold",
        SIZES[size],
        shape === "circle" ? "rounded-full" : "rounded-2xl",
        tone === "danger" ? "bg-red-100 text-red-600" : "bg-primary-100 text-primary-700",
        className,
      )}
      aria-hidden={src ? undefined : true}
    >
      {src
        ? <img src={src} alt={name ?? ""} className="h-full w-full object-cover" />
        : initial}
    </div>
  );
}

export default StudentPhoto;
