import type { ReactNode } from "react";
import styles from "./operations-surface.module.css";

export type OperationsPage =
  | "schedule"
  | "billing"
  | "reports"
  | "automations"
  | "settings"
  | "account"
  | "help"
  | "subscription-required"
  | "onboarding"
  | "account-archived"
  | "access-denied"
  | "connect-refresh"
  | "legal-name";

export function OperationsSurface({
  children,
  page,
  allowInternalOverflow = false,
}: {
  children: ReactNode;
  page: OperationsPage;
  allowInternalOverflow?: boolean;
}) {
  return (
    <div
      className={`${styles.surface} ${allowInternalOverflow ? styles.internalOverflow : ""}`}
      data-operations-surface="v1"
      data-operations-page={page}
    >
      {children}
    </div>
  );
}
export function OperationsIndex({
  label,
  items,
}: {
  label: string;
  items: ReadonlyArray<{ href: string; label: string; meta?: string }>;
}) {
  return (
    <nav className={styles.index} aria-label={label}>
      <p className={styles.indexLabel}>{label}</p>
      <ol>
        {items.map((item, index) => (
          <li key={item.href}>
            <a href={item.href}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.label}</strong>
              {item.meta ? <small>{item.meta}</small> : null}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function FocusedOperationsSheet({
  children,
  eyebrow,
  page,
}: {
  children: ReactNode;
  eyebrow?: string;
  page: Extract<
    OperationsPage,
    "onboarding" | "account-archived" | "access-denied" | "connect-refresh" | "legal-name"
  >;
}) {
  return (
    <OperationsSurface page={page}>
      <main className={styles.focusedPage}>
        <section className={styles.focusedSheet}>
          {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
          {children}
        </section>
      </main>
    </OperationsSurface>
  );
}

export function OperationsLoading({
  description,
  page,
  title,
}: {
  description: string;
  page: Extract<OperationsPage, "schedule" | "billing" | "reports" | "settings">;
  title: string;
}) {
  const labels = {
    schedule: ["Navigation", "Studio time", "Seven-day canvas"],
    billing: ["Six books", "Current register", "Money rows"],
    reports: ["Report scope", "Operational totals", "Export register"],
    settings: ["Administration", "Studio controls", "People and programs"],
  }[page];

  return (
    <OperationsSurface page={page} allowInternalOverflow={page === "schedule"}>
      <div className={styles.loading} aria-busy="true" aria-live="polite" data-loading-family={page}>
        <div className={styles.loadingIntro}>
          <p className={styles.eyebrow}>Preparing working sheet</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className={styles.loadingWorkbench} aria-hidden="true">
          <div className={styles.loadingIndex}>
            {labels.map((label, index) => (
              <span key={label}>
                <i>{String(index + 1).padStart(2, "0")}</i>
                {label}
              </span>
            ))}
          </div>
          <div className={styles.loadingRules}>
            {Array.from({ length: page === "schedule" ? 8 : 6 }, (_, index) => <span key={index} />)}
          </div>
        </div>
      </div>
    </OperationsSurface>
  );
}
