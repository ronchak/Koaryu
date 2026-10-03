import { Home, ServerCrash } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";
import { StatusReloadAction } from "@/components/status-reload-action";

export default function Custom500Page() {
  return (
    <ErrorStatusPage
      statusCode="500"
      eyebrow="Server error"
      title="The app stumbled while loading this view."
      description="Return to the dashboard or reload this page to try again."
      icon={ServerCrash}
      tone="danger"
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
