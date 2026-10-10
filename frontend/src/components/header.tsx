import type { ReactNode } from "react";
import { HorizonHills } from "@/components/ui/horizon-hills";
import styles from "./header.module.css";

interface HeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** A short label above the title, such as the section or a date. */
  eyebrow?: ReactNode;
  children?: ReactNode;
}

/** Page header in the Horizon language: title and actions over the landing's hills. */
export function Header({ title, description, eyebrow, children }: HeaderProps) {
  return (
    <header className="koaryu-surface-transition" data-koaryu-page-header="horizon">
      <div className={styles.header}>
        <HorizonHills variant="band" className={styles.hills} />
        <div className={styles.inner}>
          <div className={styles.copy}>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1 className={styles.title}>{title}</h1>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {children ? <div className={styles.actions}>{children}</div> : null}
        </div>
      </div>
    </header>
  );
}
