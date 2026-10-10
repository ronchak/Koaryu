import type { CSSProperties, ReactNode } from "react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import styles from "./horizon.module.css";

/*
 * Horizon kit: the landing page's language for product pages. Paper panels on a
 * warm ground, ink for the one primary action, tone washes for state, and the
 * landing's hills behind page headers. Colours come from the --product-* and
 * --hz-* tokens, so the dark theme is the landing's night scene for free.
 */

export type HorizonTone = "alert" | "warn" | "calm" | "neutral";

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

/** A paper panel with an optional title row. */
export function HorizonPanel({
  actions,
  as: Element = "section",
  children,
  className,
  description,
  flush = false,
  title,
  titleId,
}: {
  actions?: ReactNode;
  as?: "section" | "article" | "div" | "aside";
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  /** Let lists and tables run edge to edge under the title. */
  flush?: boolean;
  title?: ReactNode;
  titleId?: string;
}) {
  return (
    <Element
      className={[styles.panel, className].filter(Boolean).join(" ")}
      data-flush={flush ? "true" : undefined}
      aria-labelledby={title && titleId ? titleId : undefined}
    >
      {title || actions ? (
        <header className={styles.panelHead}>
          <div className={styles.panelTitles}>
            {title ? (
              <h2 id={titleId} className={styles.panelTitle}>
                {title}
              </h2>
            ) : null}
            {description ? <p className={styles.panelDescription}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.panelActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={styles.panelBody}>{children}</div>
    </Element>
  );
}

/** A small pill naming a state. Never colour alone: the words carry the meaning. */
export function ToneTag({
  children,
  className,
  dot = true,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  dot?: boolean;
  tone?: HorizonTone;
}) {
  return (
    <span
      className={[styles.tag, className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-dot={dot ? "true" : undefined}
    >
      {children}
    </span>
  );
}

/** A rounded icon tile tinted by tone, for list rows and empty states. */
export function ToneChip({
  children,
  size = 40,
  tone = "neutral",
}: {
  children: ReactNode;
  size?: 32 | 40;
  tone?: HorizonTone;
}) {
  return (
    <span className={styles.chip} data-tone={tone} data-size={size} aria-hidden="true">
      {children}
    </span>
  );
}

/** A quiet, dashed-edge state for "nothing here" or "all clear", with an optional next step. */
export function CalmState({
  action,
  detail,
  icon,
  title,
  tone = "calm",
}: {
  action?: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  tone?: HorizonTone;
}) {
  return (
    <div className={styles.calm}>
      {icon ? <ToneChip tone={tone}>{icon}</ToneChip> : null}
      <div className={styles.calmText}>
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {action ? <div className={styles.calmAction}>{action}</div> : null}
    </div>
  );
}

/** One row of filters, search and view switches above a list. */
export function HorizonToolbar({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={[styles.toolbar, className].filter(Boolean).join(" ")}
      role={label ? "toolbar" : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/** The page body under a Horizon header: centred, with the shared gutter. */
export function HorizonPage({
  children,
  className,
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: "wide" | "medium" | "narrow";
}) {
  return (
    <div className={[styles.page, className].filter(Boolean).join(" ")} data-width={width}>
      {children}
    </div>
  );
}
