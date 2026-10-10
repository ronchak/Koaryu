import type { ReactNode } from "react";
import styles from "@/components/ui/horizon.module.css";

/*
 * Link-free copies of the Horizon kit's panel primitives, drawn with the kit's
 * own stylesheet. `@/components/ui/horizon` imports a Next.js link for its stats
 * strip, which the mounted Settings and Account test bundles cannot load; these
 * keep those pages testable until the kit splits its link-free parts out.
 */

export type HorizonTone = "alert" | "warn" | "calm" | "neutral";

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
