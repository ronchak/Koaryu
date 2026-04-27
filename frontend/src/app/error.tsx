"use client";

import { Home, RefreshCcw, ServerCrash } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorStatusPage
      statusCode="500"
      eyebrow="Unexpected app error"
      title="Koaryu hit a bad transition."
      description="The app caught the problem before it could spill into your studio data. Try the route again or head back to the dashboard."
      icon={ServerCrash}
      tone="danger"
      diagnostics={[
        { label: "App shell", value: "recovered", state: "warn" },
        { label: "Session", value: "preserved", state: "ok" },
        { label: "Retry", value: "available", state: "idle" },
      ]}
      actions={
        <>
          <StatusAction onClick={reset} icon={RefreshCcw}>
            Try again
          </StatusAction>
          <StatusAction href="/dashboard" icon={Home} variant="secondary">
            Dashboard
          </StatusAction>
        </>
      }
    />
  );
}
