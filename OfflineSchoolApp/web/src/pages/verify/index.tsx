// web/src/pages/verify/index.tsx
//
// The address printed under a document's QR code: https://<the app>/verify/<code>.
//
// Transcripts and report cards used to print the API's own host
// (offlineschool-app.onrender.com/api/verify/…), because that is where the
// verification page is served. They now print the app's domain, and this
// public page hands the visitor straight to that server page — so the paper
// names the school's app, and the API can move without reprinting anything.
// No sign-in: the person holding the paper has no account.

import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

const API_BASE = String(import.meta.env.VITE_API_URL ?? "/api").replace(/\/+$/, "");

export default function VerifyPage() {
  const { t } = useTranslation();
  const { code } = useParams();
  const [params] = useSearchParams();

  const target = code
    ? `${API_BASE}/verify/${encodeURIComponent(code)}`
    : `${API_BASE}/verify${params.get("code") ? `?code=${encodeURIComponent(params.get("code")!)}` : ""}`;

  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4 text-center">
      <p className="text-sm text-ink-muted">
        {t("verifyPage.opening")}{" "}
        <a className="text-primary-600 underline" href={target}>{t("verifyPage.continue")}</a>
      </p>
    </div>
  );
}
