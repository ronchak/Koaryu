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
}: {
  children: ReactNode;
  page: OperationsPage;
}) {
  return (
    <div className={styles.surface} data-operations-surface="v2" data-operations-page={page}>
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
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href}>
              <strong>{item.label}</strong>
              {item.meta ? <small>{item.meta}</small> : null}
            </a>
          </li>
        ))}
      </ul>
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
