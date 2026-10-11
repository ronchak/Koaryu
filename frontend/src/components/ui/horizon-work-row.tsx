import { isValidElement, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { ToneTag, type HorizonTone } from "./horizon-parts";
import styles from "./horizon.module.css";

/*
 * Horizon work lists: rows that each open the thing that needs a hand, with the
 * main action visible. These link through the app's router, so they live here
 * rather than in the routing-free horizon-parts; `horizon.tsx` re-exports them.
 */

type DataAttributes = { [attribute: `data-${string}`]: string | number | boolean | undefined };

export function HorizonWorkList({
  children,
  className,
  label,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <ul className={[styles.workList, className].filter(Boolean).join(" ")} aria-label={label}>
      {children}
    </ul>
  );
}

export type HorizonWorkRowProps = {
  /** The whole row is one link when present; otherwise a plain row. */
  href?: string;
  /** Left slot: a `ToneChip`, or a time as a string or `<time>`, set as plain tabular text. */
  leading?: ReactNode;
  title: ReactNode;
  tag?: { label: ReactNode; tone: HorizonTone };
  /** Soft-ink text after the tag; wraps rather than truncates. */
  meta?: ReactNode;
  /** Visible action label at the right, part of the row's link. */
  action?: ReactNode;
  /** The action renders as the ink pill; otherwise a quiet text action. */
  emphasized?: boolean;
  className?: string;
} & DataAttributes;

function isTextLeading(leading: ReactNode): boolean {
  if (typeof leading === "string" || typeof leading === "number") return true;
  return isValidElement(leading) && leading.type === "time";
}

export function HorizonWorkRow({
  action,
  className,
  emphasized = false,
  href,
  leading,
  meta,
  tag,
  title,
  ...data
}: HorizonWorkRowProps) {
  const hasLeading = leading !== undefined && leading !== null && leading !== false;
  const body = (
    <>
      {hasLeading ? (
        <span
          className={styles.workLeading}
          data-leading={isTextLeading(leading) ? "text" : "slot"}
        >
          {leading}
        </span>
      ) : null}
      <span className={styles.workBody}>
        <span className={styles.workText}>
          <strong className={styles.workTitle}>{title}</strong>
          {tag || meta ? (
            <span className={styles.workMeta}>
              {tag ? <ToneTag tone={tag.tone}>{tag.label}</ToneTag> : null}
              {meta ? <span>{meta}</span> : null}
            </span>
          ) : null}
        </span>
        {action ? (
          <span className={styles.workAction} data-emphasized={emphasized ? "true" : undefined}>
            {action}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <li className={[styles.workItem, className].filter(Boolean).join(" ")} {...data}>
      {href ? (
        <Link href={href} className={styles.workRow}>
          {body}
        </Link>
      ) : (
        <div className={styles.workRow}>{body}</div>
      )}
    </li>
  );
}

/** A panel header's way to its source page: words and an arrow, never the arrow alone. */
export function HorizonPanelLink({ children, href }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={styles.panelLink}>
      <span>{children}</span>
      <ArrowRight aria-hidden="true" focusable="false" />
    </Link>
  );
}
