// web/src/components/offline/DesktopServerGate.tsx
//
// The desktop's first-run question: which server is this school's?
//
// Everything the desktop cannot answer from its own database, and all of its
// sync, goes to one server address (desktop/src/main/appProtocol.js,
// sync/client.js). An installation that has none can do nothing useful — it
// cannot even sign in — so until one is set this screen stands in front of the
// app. An installer built for a school carries its address already
// (package.json config.defaultServerUrl) and never shows it.
//
// In a browser there is no bridge and this renders its children untouched.
//
// The address is checked before it is saved (GET /api/health from the main
// process), so a typo is caught here rather than as a login that "cannot reach
// the server". The login page can bring it back to change the address:
// window.dispatchEvent(new Event(CHANGE_SERVER_EVENT)).

import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { GraduationCap, Loader2, Server } from "lucide-react";
import { desktop } from "@/lib/offline/bridge";

export const CHANGE_SERVER_EVENT = "school:change-server";

export default function DesktopServerGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const bridge = desktop();
  const [phase, setPhase]     = useState<"loading" | "ask" | "ready">(bridge ? "loading" : "ready");
  const [address, setAddress] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.server.get().then((url) => {
      if (!live) return;
      setCurrent(url);
      setAddress(url ?? "");
      setPhase(url ? "ready" : "ask");
    }).catch(() => { if (live) setPhase("ask"); });
    const reopen = () => { setError(null); setPhase("ask"); };
    window.addEventListener(CHANGE_SERVER_EVENT, reopen);
    return () => { live = false; window.removeEventListener(CHANGE_SERVER_EVENT, reopen); };
  }, [bridge]);

  if (!bridge || phase === "ready") return <>{children}</>;
  if (phase === "loading") return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const checked = await bridge.server.check(address);
      if (!checked.ok) { setError(checked.error); return; }
      const saved = await bridge.server.set(checked.url);
      if (!saved.ok) { setError(saved.error); return; }
      setCurrent(saved.url);
      setAddress(saved.url);
      setPhase("ready");
    } catch {
      setError(t("desktopServer.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-primary-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4">
            <GraduationCap className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t("desktopServer.title")}</h1>
          <p className="text-primary-200 mt-1 text-sm">{t("desktopServer.intro")}</p>
        </div>
        <form onSubmit={submit} noValidate className="bg-white rounded-2xl shadow-2xl p-8 space-y-5">
          {error && (
            <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>
          )}
          <div>
            <label htmlFor="server-address" className="block text-sm font-medium text-gray-700 mb-1">
              {t("desktopServer.label")}
            </label>
            <input
              id="server-address"
              type="url"
              inputMode="url"
              autoComplete="url"
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="https://api.example.cm"
              aria-describedby="server-address-hint"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 text-sm outline-none transition focus:ring-2 focus:ring-primary-500"
            />
            <p id="server-address-hint" className="mt-1 text-xs text-gray-400">{t("desktopServer.hint")}</p>
          </div>
          <button
            type="submit"
            disabled={busy || !address.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
            {busy ? t("desktopServer.checking") : t("desktopServer.connect")}
          </button>
          {current && (
            <button type="button" onClick={() => { setAddress(current); setPhase("ready"); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700">
              {t("desktopServer.keep", { url: current })}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
