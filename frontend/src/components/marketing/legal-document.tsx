import { PublicPageShell } from "@/components/marketing/public-pages";
import styles from "@/components/marketing/public-pages.module.css";

export interface LegalSection {
  id: string;
  title: string;
  paragraphs: readonly string[];
}

export function LegalDocument({
  description,
  documentLabel,
  navigationLabel,
  notice,
  noticeLabel,
  sections,
  title,
}: {
  description: string;
  documentLabel: string;
  navigationLabel: string;
  notice: string;
  noticeLabel: string;
  sections: readonly LegalSection[];
  title: string;
}) {
  return (
    <PublicPageShell>
      <header className={styles.legalHero}>
        <div className={styles.legalHeroInner}>
          <p className={styles.eyebrow}>Legal</p>
          <h1>{title}</h1>
          <p className={styles.legalDescription}>{description}</p>
          <time className={styles.legalUpdated} dateTime="2026-05-19">
            Updated May 19, 2026
          </time>
        </div>
      </header>

      <div className={styles.legalLayout}>
        <nav className={styles.legalSectionNavigation} aria-label={navigationLabel}>
          <p className={styles.eyebrow}>On this page</p>
          <ul>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className={styles.legalDocument} aria-label={documentLabel}>
          {sections.map((section) => (
            <section key={section.id} id={section.id} className={styles.legalSection}>
              <h2>{section.title}</h2>
              <div className={styles.legalBody}>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
          <aside className={styles.legalNotice} aria-label={noticeLabel}>
            {notice}
          </aside>
        </article>
      </div>
    </PublicPageShell>
  );
}
