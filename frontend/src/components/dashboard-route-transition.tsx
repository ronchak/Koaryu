"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function DashboardRouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className="koaryu-route-enter flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}
