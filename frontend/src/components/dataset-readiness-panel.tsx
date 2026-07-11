"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DatasetReadinessErrorPanel({
  error,
  onRetry,
  title,
}: {
  error: string;
  onRetry: () => void;
  title: string;
}) {
  return (
    <section className="border border-danger/30 bg-danger/5 p-5" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-text-primary">{title}</h2>
          <p className="mt-1 text-sm text-text-secondary">{error}</p>
          <Button className="mt-4" size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </div>
    </section>
  );
}
