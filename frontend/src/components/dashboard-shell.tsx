"use client";

import { formatDashboardRole } from "@/lib/dashboard-shell-route";
import styles from "./dashboard-shell.module.css";

export function DashboardSlugBand({
  role,
  studioName,
}: {
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
    </header>
  );
}
