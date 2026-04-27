import { Clock3, Home } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";
import { StatusReloadAction } from "@/components/status-reload-action";

export default function Custom504Page() {
  return (
    <ErrorStatusPage
      statusCode="504"
      eyebrow="Gateway timeout"
      title="The backend took too long to bow in."
      description="The page is here, but the upstream API did not answer in time. Give it a moment, then retry the dashboard."
      icon={Clock3}
      tone="warning"
      diagnostics={[
        { label: "Frontend", value: "online", state: "ok" },
        { label: "Gateway", value: "waiting", state: "warn" },
        { label: "Backend", value: "timed out", state: "bad" },
      ]}
      actions={
        <>
          <StatusAction href="/dashboard" icon={Home}>
            Dashboard
          </StatusAction>
          <StatusReloadAction />
        </>
      }
    />
  );
}
