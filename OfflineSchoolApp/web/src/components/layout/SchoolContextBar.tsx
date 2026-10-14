// web/src/components/layout/SchoolContextBar.tsx
//
// Which school the operator is inside, said out loud.
//
// A super_admin uses the ordinary school screens once they have entered a
// school; every request those screens make names that school, and nothing on
// the server remembers the choice between requests. That is the right shape
// for safety — the context cannot leak — and the wrong shape for a person, who
// can be three schools into an afternoon and no longer sure which one the
// students page is showing. So the shell says so, on every page, with the way
// out beside it.
//
// Rendered only for super_admin. Everyone else has exactly one school and no
// need to be told which.
import { useNavigate }    from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Building2, LogOut, AlertTriangle } from "lucide-react";
import { useActiveSchool, useAuthStore, useUser } from "@/store/auth.store";
import { Button } from "@/components/ui/Button";
import { Badge }  from "@/components/ui/Badge";

export default function SchoolContextBar() {
  const { t }        = useTranslation();
  const navigate     = useNavigate();
  const user         = useUser();
  const activeSchool = useActiveSchool();
  const leaveSchool  = useAuthStore((s) => s.leaveSchool);

  if (user?.role !== "super_admin" || !activeSchool) return null;

  const exit = () => {
    leaveSchool();
    navigate("/platform", { replace: true });
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning-line bg-warning-soft px-4 py-2 text-sm text-ink lg:px-6"
    >
      <Building2 className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <span className="text-ink-muted">{t("platform.context.operatingIn")}</span>
      <span className="font-semibold">
        {activeSchool.name}
        {activeSchool.code ? <span className="ml-1 font-normal text-ink-muted">({activeSchool.code})</span> : null}
      </span>
      {activeSchool.academicYear ? (
        <span className="text-ink-muted">
          · {activeSchool.academicYear}{activeSchool.currentTerm ? ` · ${activeSchool.currentTerm}` : ""}
        </span>
      ) : null}
      {!activeSchool.isActive ? (
        <Badge variant="danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />
          {t("platform.context.inactive")}
        </Badge>
      ) : null}
      <div className="ml-auto">
        <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={exit}>
          {t("platform.context.exit")}
        </Button>
      </div>
    </div>
  );
}
