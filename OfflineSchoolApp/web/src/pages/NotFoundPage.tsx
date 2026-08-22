// web/src/pages/NotFoundPage.tsx
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation }           from "react-i18next";
import { Compass, ArrowLeft }       from "lucide-react";
import { Button }                   from "@/components/ui/Button";
import { Card }                     from "@/components/ui/Card";

export default function NotFoundPage() {
  const { t }        = useTranslation();
  const navigate     = useNavigate();
  const { pathname } = useLocation();

  return (
    <Card className="mx-auto mt-10 max-w-xl text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-50">
        <Compass className="h-6 w-6 text-primary-600" aria-hidden="true" />
      </div>

      <h2 className="mt-4 text-lg font-semibold text-ink">
        {t("notFound.title")}
      </h2>

      {/*
        The path is interpolated rather than concatenated around the sentence.
        French puts the clause in a different order, so splitting the string
        into "<code/> doesn't match…" would force a word order that only works
        in English.
      */}
      <p className="mt-1 text-sm text-ink-muted">
        {t("notFound.body", { path: pathname })}
      </p>

      <div className="mt-6 flex items-center justify-center gap-2">
        <Button
          variant="secondary"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate(-1)}
        >
          {t("notFound.goBack")}
        </Button>
        <Button onClick={() => navigate("/dashboard")}>
          {t("notFound.openDash")}
        </Button>
      </div>
    </Card>
  );
}
