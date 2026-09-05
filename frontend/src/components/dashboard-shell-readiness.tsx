"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { DASHBOARD_PERFORMANCE_ROUTES, markDashboardReadiness } from "@/lib/performance";

export function DashboardShellReadiness({ identityGeneration, identityReady, shellVisible }: {
  identityGeneration: number;
  identityReady: boolean;
  shellVisible: boolean;
}) {
  const pathname = usePathname();
  useEffect(() => {
    const route = DASHBOARD_PERFORMANCE_ROUTES.find((label) => pathname === `/${label}`);
    if (!route) return;
    return markDashboardReadiness(route, identityGeneration, { shell: shellVisible, identity: identityReady });
  }, [identityGeneration, identityReady, pathname, shellVisible]);
  return null;
}
