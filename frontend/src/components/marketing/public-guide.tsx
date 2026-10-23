import type { ReactNode } from "react";
import { PublicPageShell } from "@/components/marketing/public-pages";
import styles from "./public-guide.module.css";

export function PublicGuide({
  eyebrow,
  title,
  introduction,
  children,
}: {
  eyebrow: string;
  title: string;
  introduction: string;
  children: ReactNode;
}) {
  return (
    <PublicPageShell>
      <article className={styles.guide}>
        <header>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.introduction}>{introduction}</p>
        </header>
        {children}
      </article>
    </PublicPageShell>
  );
}
