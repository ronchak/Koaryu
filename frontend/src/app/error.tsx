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
      title="Something went wrong."
      description="Try this page again. If the problem continues, return to the dashboard."
      icon={ServerCrash}
      tone="danger"
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
