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
      description="This is usually temporary. Your data is protected, and you can retry from the dashboard while the request settles."
      icon={ServerCrash}
      tone="danger"
      diagnostics={[
        { label: "Request", value: "failed", state: "bad" },
        { label: "App shell", value: "online", state: "ok" },
        { label: "Recovery", value: "ready", state: "idle" },
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
