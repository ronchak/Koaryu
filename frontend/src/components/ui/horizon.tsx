import type { CSSProperties, ReactNode } from "react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import type { HorizonTone } from "./horizon-parts";
import styles from "./horizon.module.css";

/*
 * Horizon kit: the landing page's language for product pages. Paper panels on a
 * warm ground, ink for the one primary action, tone washes for state, and the
 * landing's hills behind page headers. Colours come from the --product-* and
 * --hz-* tokens, so the dark theme is the landing's night scene for free.
 */

export * from "./horizon-parts";
export { HorizonHills } from "./horizon-hills";

export type HorizonStat = {
  id: string;
  label: string;
  /** Omit while loading; a dash stands in when the value is unknown. */
  value?: ReactNode;
  unit?: string;
  note?: ReactNode;
  href?: string;
  tone?: HorizonTone;
  pending?: boolean;
};

/** A frosted strip of headline numbers. Place it right after a Header to sit on its ridge. */
export function HorizonStats({
  className,
  items,
  label,
}: {
  className?: string;
  items: readonly HorizonStat[];
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <section
      className={[styles.stats, className].filter(Boolean).join(" ")}
      aria-label={label}
      style={{ "--hz-stat-count": items.length } as CSSProperties}
    >
      {items.map((item) => {
        const body = (
          <>
            <span className={styles.statLabel}>{item.label}</span>
            {item.pending ? (
              <span className={styles.statPending} aria-label="Loading" />
            ) : (
              <span className={styles.statValue}>
                {item.value ?? "—"}
                {item.unit ? <small>{item.unit}</small> : null}
              </span>
            )}
            {item.note ? (
              <span className={styles.statNote} data-tone={item.tone}>
                {item.note}
              </span>
            ) : null}
          </>
        );
        return item.href ? (
          <Link key={item.id} href={item.href} className={styles.stat} data-tone={item.tone}>
            {body}
          </Link>
        ) : (
          <div key={item.id} className={styles.stat} data-tone={item.tone}>
            {body}
          </div>
        );
      })}
    </section>
  );
}
