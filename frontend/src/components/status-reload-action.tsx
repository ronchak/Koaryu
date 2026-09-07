"use client";

import { RefreshCcw } from "lucide-react";
import { StatusAction } from "@/components/status-action";
import { navigationRecoveryPath } from "@/lib/navigation-recovery";

interface StatusReloadActionProps {
  children?: React.ReactNode;
  returnTo?: string;
}

export function StatusReloadAction({
  children = "Reload status",
  returnTo,
}: StatusReloadActionProps) {
  return (
    <StatusAction
      icon={RefreshCcw}
      onClick={() => returnTo === undefined
        ? window.location.reload()
        : window.location.assign(navigationRecoveryPath(returnTo))}
      variant="secondary"
    >
      {children}
    </StatusAction>
  );
}
