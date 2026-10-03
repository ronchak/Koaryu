import { Home, Search, Users } from "lucide-react";

import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";

export function NotFoundView() {
  return (
    <ErrorStatusPage
      statusCode="404"
      eyebrow="Route not found"
      title="That page is not on the mat."
      description="The route may have moved, been renamed, or never existed."
      icon={Search}
      tone="missing"
      actions={
        <>
          <StatusAction href="/dashboard" icon={Home}>
            Dashboard
          </StatusAction>
          <StatusAction href="/students" icon={Users} variant="secondary">
            Students
          </StatusAction>
        </>
      }
    />
  );
}
