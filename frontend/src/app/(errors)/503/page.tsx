import { Home, Wrench } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";
import { StatusReloadAction } from "@/components/status-reload-action";

export default function Custom503Page() {
  return (
    <ErrorStatusPage
      statusCode="503"
      eyebrow="Service unavailable"
      title="The studio desk is temporarily closed."
      description="Koaryu is reachable, but a required service is not ready to serve this request yet."
      icon={Wrench}
      tone="offline"
      diagnostics={[
        { label: "Frontend", value: "online", state: "ok" },
        { label: "Service", value: "unavailable", state: "bad" },
        { label: "Retry", value: "recommended", state: "warn" },
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
