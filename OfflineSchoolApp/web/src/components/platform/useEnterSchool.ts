// web/src/components/platform/useEnterSchool.ts
//
// Stepping into a school: tell the server (it records the entry), remember
// the school in the store (which mirrors it into user.schoolId, so every
// school page reads the right school), and land on that school's dashboard.
import { useState }       from "react";
import { useNavigate }    from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore }   from "@/store/auth.store";
import { useToast }       from "@/components/ui/Toast";
import { enterSchoolOnServer } from "@/services/platform.service";

export function useEnterSchool() {
  const { t }       = useTranslation();
  const navigate    = useNavigate();
  const { toast }   = useToast();
  const enterSchool = useAuthStore((s) => s.enterSchool);
  const [enteringId, setEnteringId] = useState<string | null>(null);

  const enter = async (schoolId: string) => {
    setEnteringId(schoolId);
    try {
      const school = await enterSchoolOnServer(schoolId);
      enterSchool({
        _id: school._id, name: school.name, code: school.code, isActive: school.isActive,
        academicYear: school.academicYear, currentTerm: school.currentTerm,
      });
      toast({ title: t("platform.context.entered", { name: school.name }), kind: "success" });
      navigate("/dashboard");
    } catch {
      toast({ title: t("platform.context.enterFailed"), kind: "error" });
    } finally {
      setEnteringId(null);
    }
  };

  return { enter, enteringId };
}

/** The server's message on a failed request, if it sent one. */
export const errorMessage = (err: unknown): string | null =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? null;
