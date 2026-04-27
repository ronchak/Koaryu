import { Home, RadioTower, ServerCrash } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";

export default function Custom502Page() {
  return (
    <ErrorStatusPage
      statusCode="502"
      eyebrow="Bad gateway"
      title="Koaryu could not get a clean response."
      description="The frontend is available, but the upstream service answered with something the app could not use."
      icon={RadioTower}
      tone="warning"
      diagnostics={[
        { label: "Frontend", value: "online", state: "ok" },
        { label: "Gateway", value: "invalid", state: "warn" },
        { label: "Backend", value: "check logs", state: "idle" },
      ]}
      actions={
        <>
          <StatusAction href="/dashboard" icon={Home}>
            Dashboard
          </StatusAction>
          <StatusAction href="/504" icon={ServerCrash} variant="secondary">
            Timeout page
          </StatusAction>
        </>
      }
    />
  );
}
