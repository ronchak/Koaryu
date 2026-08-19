"use client";

import { formatDashboardRole } from "@/lib/dashboard-shell-route";
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
  return (
    <header className={styles.slugBand} aria-label="Current workspace scope">
      <p className={styles.slugMeta}>
        <span className={styles.studioName}>{studioName || "Studio workspace"}</span>
        <span className={styles.scopeSeparator} aria-hidden="true" />
        <span>{formatDashboardRole(role)}</span>
      </p>
      <span className={styles.scopeStamp} data-preview={isPreviewMode ? "true" : "false"}>
        <span className={styles.scopeDot} aria-hidden="true" />
        {isPreviewMode ? "Preview data" : "Live data"}
      </span>
    </header>
  );
}
