"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./dashboard-shell.module.css";

export function DashboardRouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className={`${styles.routeTravel} flex min-h-0 flex-1 flex-col`}>
      {children}
    </div>
  );
}
