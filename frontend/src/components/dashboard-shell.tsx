"use client";

import { usePathname } from "next/navigation";
import { formatDashboardRole, resolveDashboardRouteSlug } from "@/lib/dashboard-shell-route";
import styles from "./dashboard-shell.module.css";

export function DashboardSlugBand({
  isPreviewMode,
  role,
  studioName,
}: {
  isPreviewMode: boolean;
  role: string | null;
  studioName: string;
}) {
  const pathname = usePathname();
  const routeSlug = resolveDashboardRouteSlug(pathname);

  return (
    <header className={styles.slugBand} aria-label="Current workspace scope">
      <div className={styles.slugCopy}>
        <p className={styles.slugTitle}>{routeSlug}</p>
        <p className={styles.slugMeta}>
          <span>{studioName || "Studio scope"}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDashboardRole(role)}</span>
          <span aria-hidden="true">·</span>
          <span>{isPreviewMode ? "Preview fixture" : "Authenticated studio"}</span>
        </p>
      </div>
      <span className={styles.scopeStamp}>{isPreviewMode ? "Preview" : "Live scope"}</span>
    </header>
  );
}
