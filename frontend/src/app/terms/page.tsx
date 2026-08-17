import type { Metadata } from "next";

import { PublicPageShell } from "@/components/marketing/public-pages";
import styles from "@/components/marketing/public-pages.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | Koaryu",
  description: "Operating terms for Koaryu studio management and billing tools.",
  alternates: { canonical: "https://koaryu.app/terms" },
  openGraph: {
    title: "Terms of Service | Koaryu",
    description: "Operating terms for Koaryu studio management and billing tools.",
    url: "https://koaryu.app/terms",
  },
};

const termsSections = [
  {
    id: "agreement-to-these-terms",
    title: "Agreement to these terms",
    paragraphs: [
      "By creating an account, accessing Koaryu, or using Koaryu to manage studio operations, you agree to use the service responsibly and only for lawful studio administration, communication, reporting, scheduling, and billing workflows.",
    ],
  },
  {
    id: "accounts-and-studio-access",
    title: "Accounts and studio access",
    paragraphs: [
      "You are responsible for keeping account credentials secure, inviting only authorized staff, assigning appropriate staff roles, and promptly removing access for people who should no longer use the studio workspace. Actions taken inside a studio workspace may be recorded for operational, audit, billing, or support purposes.",
    ],
  },
  {
    id: "koaryu-core-and-koaryu-payments",
    title: "Koaryu Core and Koaryu Payments",
    paragraphs: [
      "Koaryu Core is the studio subscription that provides access to the Koaryu software. Koaryu Payments lets an eligible connected studio charge students or payers through Stripe Connect.",
      "Studios are responsible for obtaining authorization before charging a payer or enabling autopay, keeping billing plans accurate, issuing refunds when appropriate, responding to disputes, and maintaining required Stripe Connect account information.",
      "Stripe may charge processing fees, enforce its own platform rules, request additional verification, delay payouts, or reject transactions. Koaryu stores payment metadata and Stripe object references, but Koaryu does not store raw card numbers.",
    ],
  },
  {
    id: "studio-data",
    title: "Studio data",
    paragraphs: [
      "Studios are responsible for the accuracy, permissions, and lawful use of student, guardian, staff, schedule, attendance, rank, lead, report, and billing records entered into Koaryu. Admin-only demo reset and data-clearing tools are destructive and should be used only when replacement or deletion of working studio records is intended.",
    ],
  },
  {
    id: "availability-and-changes",
    title: "Availability and changes",
    paragraphs: [
      "Koaryu may change, improve, limit, suspend, or discontinue features as the product evolves. Service availability can be affected by maintenance, hosting providers, network conditions, browser behavior, Supabase, Stripe, or other third-party dependencies.",
    ],
  },
  {
    id: "support",
    title: "Support",
    paragraphs: [
      "For account, billing, or support questions, contact Koaryu at support@koaryu.app with the relevant studio name, user email, workflow, and any invoice or payment identifiers that appear in the product.",
    ],
  },
] as const;

const termsNotice =
  "Koaryu may update these terms as the product, pricing, support process, business details, and payment configuration evolve. Continued use of Koaryu after an update means the updated terms apply.";

export default function TermsPage() {
  return (
    <PublicPageShell>
      <header className={styles.legalHero}>
        <div className={styles.legalHeroInner}>
          <p className={styles.eyebrow}>Legal</p>
          <h1>Terms of Service</h1>
          <p className={styles.legalDescription}>
            Operating terms for Koaryu studio management and billing tools.
          </p>
          <time className={styles.legalUpdated} dateTime="2026-05-19">
            Updated May 19, 2026
          </time>
        </div>
      </header>

      <div className={styles.legalLayout}>
        <nav className={styles.legalSectionNavigation} aria-label="Terms of service sections">
          <p className={styles.eyebrow}>On this page</p>
          <ul>
            {termsSections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className={styles.legalDocument} aria-label="Terms of service">
          {termsSections.map((section) => (
            <section key={section.id} id={section.id} className={styles.legalSection}>
              <h2>{section.title}</h2>
              <div className={styles.legalBody}>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
          <aside className={styles.legalNotice} aria-label="Terms update notice">
            {termsNotice}
          </aside>
        </article>
      </div>
    </PublicPageShell>
  );
}
