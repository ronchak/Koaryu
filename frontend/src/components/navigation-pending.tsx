"use client";

import { useLinkStatus } from "next/link";
import styles from "./dashboard-shell.module.css";

export function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span className={styles.navigationPending} role="status" data-koaryu-navigation-pending="true">
      <span className="sr-only">Opening page</span>
    </span>
  ) : null;
}
