import { Home, Wrench } from "lucide-react";
import { ErrorStatusPage } from "@/components/error-status-page";
import { StatusAction } from "@/components/status-action";
import { StatusReloadAction } from "@/components/status-reload-action";
import { navigationRecoveryPath } from "@/lib/navigation-recovery";

export default async function Custom503Page({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const returnTo = navigationRecoveryPath((await searchParams).returnTo);
  return (
    <ErrorStatusPage
      statusCode="503"
      eyebrow="Service unavailable"
      title="The studio desk is temporarily closed."
      description="Koaryu is reachable, but a required service is not ready to serve this request yet."
      icon={Wrench}
      tone="offline"
      actions={
        <>
          <StatusAction href="/dashboard" icon={Home}>
            Dashboard
          </StatusAction>
          <StatusReloadAction returnTo={returnTo}>Try again</StatusReloadAction>
        </>
      }
    />
  );
}
