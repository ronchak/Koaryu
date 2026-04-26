"use client";

import { RefreshCcw } from "lucide-react";
import { StatusAction } from "@/components/status-action";

interface StatusReloadActionProps {
  children?: React.ReactNode;
}

export function StatusReloadAction({
  children = "Reload status",
}: StatusReloadActionProps) {
  return (
    <StatusAction
      icon={RefreshCcw}
      onClick={() => window.location.reload()}
      variant="secondary"
    >
      {children}
    </StatusAction>
  );
}
