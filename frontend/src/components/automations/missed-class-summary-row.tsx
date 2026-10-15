"use client";

import { useEffect, useState } from "react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { useConfigStore } from "@/lib/store";
import { useRetainedState } from "@/lib/retained-state";
import { crmLinkPrefetch } from "@/lib/constants";
import {
  DEMO_SETTINGS,
  missedClassApi,
  type MissedClassSettingsResponse,
} from "@/lib/missed-class-automation";
import kit from "@/components/ui/horizon.module.css";
import styles from "./workflow-workspace.module.css";

export const MISSED_CLASS_ADDRESS = "/automations/missed-class";

/**
 * The built-in attendance rule as one row of the automations list: what starts it,
 * what it does, whether it is on. It shares the detail page's retained settings, so a
 * return visit shows the saved state at once.
 */
export function MissedClassSummaryRow() {
  const { token, isPreviewMode } = useConfigStore();
  const [settings, setSettings] = useRetainedState<MissedClassSettingsResponse | null>(
    `automations:missed-class:settings:${isPreviewMode ? "preview" : "live"}`,
    isPreviewMode ? DEMO_SETTINGS : null,
  );
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (isPreviewMode || !token || settings) return;
    const controller = new AbortController();
    missedClassApi
      .settings(token, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [isPreviewMode, token, settings, setSettings]);
  const rule = settings?.rule;
  const status = isPreviewMode
    ? { label: "Sample", tone: "neutral" as const }
    : rule
      ? rule.enabled
        ? { label: "Enabled", tone: "calm" as const }
        : { label: "Paused", tone: "warn" as const }
      : null;
  return (
    <li
      className={styles.workflowRow}
      data-tone={status?.tone ?? "neutral"}
      data-built-in-automation="missed-class"
    >
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <h3>
            <Link
              href={MISSED_CLASS_ADDRESS}
              prefetch={crmLinkPrefetch(MISSED_CLASS_ADDRESS)}
              className={styles.rowName}
            >
              Missed-class nudges
            </Link>
          </h3>
          {status ? (
            <span className={kit.tag} data-tone={status.tone} data-dot="true">
              {status.label}
            </span>
          ) : null}
        </div>
        <p className={styles.rowSentence}>
          <span className={styles.when}>When</span> an active student goes{" "}
          {rule ? `${rule.inactivity_days} days` : "a while"} without class
        </p>
        <p className={styles.rowDescription}>
          One check-in email to the student, or to their guardian. Built in: choose the gap and the
          message.
        </p>
        {unavailable ? (
          <p className={styles.rowMeta}>
            <span>Current status could not be loaded. Open the rule to retry.</span>
          </p>
        ) : null}
      </div>
      <div className={styles.rowActions}>
        <Link
          href={MISSED_CLASS_ADDRESS}
          prefetch={crmLinkPrefetch(MISSED_CLASS_ADDRESS)}
          className={styles.textLink}
        >
          Open<span className={styles.srOnly}> Missed-class nudges</span>
        </Link>
      </div>
    </li>
  );
}
