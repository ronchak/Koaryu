import type { ReactNode } from "react";
import styles from "./settings.module.css";

export type SettingsIndexItem = {
  href: string;
  label: string;
  /** A live one-line summary, such as "3 active" or the studio's name. */
  meta?: ReactNode;
  tone?: "alert" | "neutral";
};

/** The page's section index: a sticky rail on wide screens, a row of chips on phones. */
export function SettingsIndex({
  items,
  label,
}: {
  items: readonly SettingsIndexItem[];
  label: string;
}) {
  return (
    <nav className={styles.index} aria-label={label}>
      <p className={styles.indexLabel}>On this page</p>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href} data-tone={item.tone}>
              <strong>{item.label}</strong>
              {item.meta ? <small>{item.meta}</small> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
