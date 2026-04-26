import { Home, Search, Users } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";

export default function Custom404Page() {
  return (
    <ErrorStatusPage
      statusCode="404"
      eyebrow="Route not found"
      title="That page is not on the mat."
      description="The route may have moved, been renamed, or never existed. Your studio session is still intact."
      icon={Search}
      tone="missing"
      diagnostics={[
        { label: "Requested route", value: "missing", state: "warn" },
        { label: "App shell", value: "online", state: "ok" },
        { label: "Session", value: "preserved", state: "ok" },
      ]}
      actions={
        <>
          <StatusAction href="/" icon={Home}>
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
