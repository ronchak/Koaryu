import type { ReactNode } from "react";

import {
  LegalContents,
  LegalPrintButton,
  LegalSwitcher,
} from "@/components/marketing/legal-contents";
import { PublicPageShell } from "@/components/marketing/public-pages";
import {
  formatLegalDate,
  legalContact,
  legalDocuments,
  type LegalDocumentKey,
} from "@/lib/legal-documents";

import styles from "./legal-document.module.css";

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

export interface LegalHighlight {
  title: string;
  text: ReactNode;
}

const GLANCE_ID = "at-a-glance";

const switcherDocuments = Object.values(legalDocuments).map(({ href, title }) => ({ href, title }));

/**
 * Shared by /terms and /privacy through their route-group layout, so the site
 * chrome and the document switch stay mounted and the switch can slide.
 */
export function LegalShell({ children }: { children: ReactNode }) {
  return (
    <PublicPageShell>
      <div className={styles.switcherBar}>
        <LegalSwitcher documents={switcherDocuments} />
      </div>
      {children}
    </PublicPageShell>
  );
}

function sectionNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function LegalDocument({
  contactPrompt,
  contactSubject,
  contactTitle,
  description,
  documentKey,
  highlights,
  sections,
}: {
  contactPrompt: string;
  contactSubject: string;
  contactTitle: string;
  description: string;
  documentKey: LegalDocumentKey;
  highlights: readonly LegalHighlight[];
  sections: readonly LegalSection[];
}) {
  const entry = legalDocuments[documentKey];
  const contentsItems = [
    { id: GLANCE_ID, label: "At a glance" },
    ...sections.map((section, index) => ({
      id: section.id,
      label: section.title,
      number: sectionNumber(index),
    })),
  ];

  return (
    <>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Koaryu legal</p>
        <h1>{entry.title}</h1>
        <p className={styles.lede}>{description}</p>
        <div className={styles.heroMeta}>
          <dl className={styles.facts}>
            <div>
              <dt>Effective</dt>
              <dd>
                <time dateTime={entry.effective}>{formatLegalDate(entry.effective)}</time>
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>
                <time dateTime={entry.history[0].date}>
                  {formatLegalDate(entry.history[0].date)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Applies to</dt>
              <dd>koaryu.app and the Koaryu app</dd>
            </div>
          </dl>
          <LegalPrintButton />
        </div>
      </header>

      <div className={styles.layout}>
        <LegalContents items={contentsItems} label={`${entry.title} contents`} />

        <article className={styles.document} aria-label={entry.title}>
          <section className={styles.glance} id={GLANCE_ID} aria-labelledby={`${GLANCE_ID}-title`}>
            <h2 id={`${GLANCE_ID}-title`}>At a glance</h2>
            <dl className={styles.glanceList}>
              {highlights.map((highlight) => (
                <div key={highlight.title}>
                  <dt>{highlight.title}</dt>
                  <dd>{highlight.text}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.glanceNote}>
              This summary is a guide to the sections below. The full text is what applies.
            </p>
          </section>

          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              className={styles.section}
              aria-labelledby={`${section.id}-title`}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionNumber}>Section {sectionNumber(index)}</span>
                  <h2 id={`${section.id}-title`}>{section.title}</h2>
                </div>
                <a
                  href={`#${section.id}`}
                  className={styles.anchor}
                  aria-label={`Link to section ${index + 1}, ${section.title}`}
                >
                  #
                </a>
              </div>
              <div className={styles.body}>{section.body}</div>
            </section>
          ))}

          <footer className={styles.closing}>
            <section className={styles.contactCard} aria-labelledby="legal-contact-title">
              <div>
                <h2 id="legal-contact-title">{contactTitle}</h2>
                <p>{contactPrompt}</p>
              </div>
              <a
                className={styles.contactAction}
                href={`mailto:${legalContact.email}?subject=${encodeURIComponent(contactSubject)}`}
              >
                {legalContact.email}
              </a>
            </section>

            <section className={styles.history} aria-labelledby="legal-history-title">
              <h2 id="legal-history-title">Revision history</h2>
              <ol>
                {entry.history.map((revision) => (
                  <li key={revision.date}>
                    <time dateTime={revision.date}>{formatLegalDate(revision.date)}</time>
                    <span>{revision.summary}</span>
                  </li>
                ))}
              </ol>
            </section>

            <a href="#main-content" className={styles.backToTop}>
              Back to top
            </a>
          </footer>
        </article>
      </div>
    </>
  );
}

export function LegalCallout({ children, label }: { children: ReactNode; label: string }) {
  return (
    <aside className={styles.callout} aria-label={label}>
      <strong className={styles.calloutLabel}>{label}</strong>
      {children}
    </aside>
  );
}

export function LegalConspicuous({ children }: { children: ReactNode }) {
  return <p className={styles.conspicuous}>{children}</p>;
}

export function LegalDefinitions({
  items,
}: {
  items: ReadonlyArray<{ term: string; definition: ReactNode }>;
}) {
  return (
    <dl className={styles.terms}>
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.definition}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A three-column reference table. Rows stack into labelled blocks on phones and
 * print as blocks, so a page break never lets the next paragraph overlap a row.
 */
export function LegalTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly [string, string, string];
  rows: ReadonlyArray<readonly [string, ReactNode, ReactNode]>;
}) {
  return (
    <table className={styles.table}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([heading, ...cells]) => (
          <tr key={heading}>
            <th scope="row">{heading}</th>
            {cells.map((cell, index) => (
              <td key={columns[index + 1]} data-label={columns[index + 1]}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
