import type { CSSProperties, ReactNode } from "react";
import styles from "@/components/ui/horizon.module.css";
import local from "./horizon-parts.module.css";

/*
 * Link-free Horizon pieces for Schedule and Leads. They render the kit's own
 * markup and classes (`ui/horizon.module.css`), so they follow every kit change,
 * but they do not pull `next/link` in through `ui/horizon.tsx`: the mounted
 * schedule and lead tests bundle these components outside Next.js, where the
 * router modules cannot load. Once the kit splits its linked stat out, these
 * can be replaced by direct imports from `@/components/ui/horizon`.
 */

export type HorizonTone = "alert" | "warn" | "calm" | "neutral";

export type PlainHorizonStat = {
  id: string;
  label: string;
  value?: ReactNode;
  unit?: string;
  note?: ReactNode;
  tone?: HorizonTone;
  pending?: boolean;
  /** Turns the figure into a button, for stats that filter the page in place. */
  onSelect?: () => void;
  selected?: boolean;
};

export function PlainHorizonStats({
  className,
  items,
  label,
}: {
  className?: string;
  items: readonly PlainHorizonStat[];
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
        return item.onSelect ? (
          <button
            key={item.id}
            type="button"
            className={`${styles.stat} ${local.statButton}`}
            data-tone={item.tone}
            aria-pressed={item.selected ?? false}
            onClick={item.onSelect}
          >
            {body}
          </button>
        ) : (
          <div key={item.id} className={styles.stat} data-tone={item.tone}>
            {body}
          </div>
        );
      })}
    </section>
  );
}

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
