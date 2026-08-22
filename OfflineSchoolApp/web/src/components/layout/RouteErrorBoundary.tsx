// web/src/components/layout/RouteErrorBoundary.tsx
//
// Per-route error boundary.
//
// React only catches render errors through a class component's
// componentDidCatch / getDerivedStateFromError, so this stays a class even
// though the rest of the app is hooks-only. There is no hook equivalent.
//
// It is mounted once per route (see App.tsx) rather than once around the whole
// tree: a page that throws should leave the sidebar and topbar standing so the
// user can navigate away, instead of blanking the app and forcing a reload.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The fallback UI, split out as a function component.
 *
 * An error boundary has to be a class — only componentDidCatch and
 * getDerivedStateFromError catch render errors — and hooks cannot be called in
 * one. Moving the markup into a function component is what lets the message be
 * translated without giving up the boundary.
 */
function ErrorFallback({
  error,
  onRetry,
}: {
  error:   Error;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Card className="mx-auto mt-10 max-w-2xl">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger-soft">
          <AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">
            {t("error.pageProblem")}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t("error.stillWorking")}
          </p>

          <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-card border border-line bg-canvas p-3 text-xs text-ink-muted">
            {error.message || String(error)}
          </pre>

          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              icon={<RotateCcw className="h-4 w-4" />}
              onClick={onRetry}
            >
              {t("error.retry")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.location.reload()}
            >
              {t("error.reload")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Left as console output on purpose — there is no error-reporting sink
    // wired up yet, and swallowing this silently would make a white page
    // impossible to diagnose from a user's screenshot.
    console.error("[route] Unhandled render error:", error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return <ErrorFallback error={error} onRetry={this.reset} />;
  }
}

