import type { ReactNode } from "react";
import { HorizonHills } from "@/components/ui/horizon-hills";
import styles from "./header.module.css";

interface HeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** A short label above the title, such as the section or a date. */
  eyebrow?: ReactNode;
  /**
   * `band` (default) is every page's short sky. `hero` is the landing's wide shot, for
   * Home only; it keeps the band's padding, so a stats strip still sits on the ridge.
   */
  hills?: "band" | "hero";
  /** Hold one empty line for a description that arrives after first paint. */
  reserveDescription?: boolean;
  /** id for the h1, so the page can label itself by its title. */
  titleId?: string;
  children?: ReactNode;
}

/** Page header in the Horizon language: title and actions over the landing's hills. */
export function Header({
  title,
  description,
  eyebrow,
  hills = "band",
  reserveDescription = false,
  titleId,
  children,
}: HeaderProps) {
  return (
    <header className="koaryu-surface-transition" data-koaryu-page-header="horizon">
      <div className={styles.header} data-hills={hills}>
        <HorizonHills variant={hills} className={styles.hills} />
        <div className={styles.inner}>
          <div className={styles.copy}>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1 id={titleId} className={styles.title}>
              {title}
            </h1>
            {description ? (
              <p className={styles.description}>{description}</p>
            ) : reserveDescription ? (
              <p className={styles.description} data-reserved="true" aria-hidden="true" />
            ) : null}
          </div>
          {children ? <div className={styles.actions}>{children}</div> : null}
        </div>
      </div>
    </header>
  );
}
