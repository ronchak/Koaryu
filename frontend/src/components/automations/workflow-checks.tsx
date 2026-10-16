"use client";

import type { WorkflowIssueRow } from "@/lib/automation-workflow-issues";
import styles from "./workflow-graph-editor.module.css";

/** What the workspace knows about server checks; absent when checks are unavailable. */
export type WorkflowChecks = {
  loading: boolean;
  error: boolean;
  /** The last check passed and the draft has not changed since. */
  passed: boolean;
  onCheck?: () => void;
};

/**
 * One list of what still needs doing: a row per step and setting, each a way in. Rendered
 * inside the steps panel so the rows sit beside the steps they describe.
 */
export function WorkflowChecksPanel({
  rows,
  checks,
  onFocusIssue,
}: {
  rows: WorkflowIssueRow[];
  checks?: WorkflowChecks;
  onFocusIssue: (nodeId: string, field: string | null) => void;
}) {
  if (!checks && !rows.length) return null;
  const state = rows.length
    ? "issues"
    : checks?.loading
      ? "loading"
      : checks?.error
        ? "error"
        : checks?.passed
          ? "passed"
          : "idle";
  return (
    <section className={styles.checks} aria-label="Workflow checks" data-state={state}>
      <div className={styles.checksHead}>
        <h3>Workflow checks</h3>
        {rows.length ? (
          <span className={styles.checksTag} data-tone="warn">
            {rows.length} to fix
          </span>
        ) : checks?.passed ? (
          <span className={styles.checksTag} data-tone="calm">
            Passed
          </span>
        ) : null}
        {checks?.onCheck ? (
          <button
            type="button"
            className={styles.checkButton}
            disabled={checks.loading}
            onClick={checks.onCheck}
          >
            Check workflow
          </button>
        ) : null}
      </div>
      {checks?.loading ? <p role="status">Checking the workflow...</p> : null}
      {checks?.error ? (
        <p role="alert">Checks could not be completed. Try Check workflow again.</p>
      ) : null}
      {rows.length ? (
        <ul className={styles.issueRows}>
          {rows.map((row) => (
            <li key={row.key}>
              {row.node_id ? (
                <button type="button" onClick={() => onFocusIssue(row.node_id!, row.field)}>
                  <span className={styles.issueWhere}>
                    <strong>{row.step}</strong>
                    {row.setting ? ` · ${row.setting}` : ""}
                  </span>
                  <span className={styles.issueWhat}>
                    {row.message}
                    {row.count > 1 ? ` (${row.count})` : ""}
                  </span>
                </button>
              ) : (
                <span className={styles.issueWhat}>{row.message}</span>
              )}
            </li>
          ))}
        </ul>
      ) : checks && !checks.loading && !checks.error ? (
        <p>
          {checks.passed
            ? "Every step is complete and connected."
            : checks.onCheck
              ? "Save an incomplete draft at any time. Check the workflow before publishing."
              : "Checks run in your live studio."}
        </p>
      ) : null}
    </section>
  );
}
