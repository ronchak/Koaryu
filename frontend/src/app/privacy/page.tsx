import type { Metadata } from "next";

import { PublicPageShell } from "@/components/marketing/public-pages";
import styles from "@/components/marketing/public-pages.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Koaryu",
  description: "How Koaryu handles account, studio, student, and payment-adjacent data.",
  alternates: { canonical: "https://koaryu.app/privacy" },
  openGraph: {
    title: "Privacy Policy | Koaryu",
    description: "How Koaryu handles account, studio, student, and payment-adjacent data.",
    url: "https://koaryu.app/privacy",
  },
};

const privacySections = [
  {
    id: "information-koaryu-handles",
    title: "Information Koaryu handles",
    paragraphs: [
      "Koaryu handles account information, studio settings, staff roles, students, guardians, leads, schedules, attendance, rank progress, reports, audit records, billing plans, payer records, invoices, payments, refunds, disputes, and related metadata needed to operate the product.",
    ],
  },
  {
    id: "authentication-and-access",
    title: "Authentication and access",
    paragraphs: [
      "Koaryu uses Supabase Auth for authentication and uses studio membership, role checks, backend authorization, and database policies to scope records to the correct studio. Users should protect their login credentials and studio admins should promptly remove staff who no longer need access.",
    ],
  },
  {
    id: "payments",
    title: "Payments",
    paragraphs: [
      "Stripe processes card and bank/payment method details. Koaryu stores Stripe IDs, invoice status, payment status, fee amounts, reconciliation state, and other payment metadata so studios can understand and repair billing activity without storing raw card numbers.",
    ],
  },
  {
    id: "how-information-is-used",
    title: "How information is used",
    paragraphs: [
      "Koaryu uses information to provide studio management features, enforce permissions, support billing workflows, troubleshoot errors, protect accounts, generate exports and reports, improve reliability, and respond to support requests.",
    ],
  },
  {
    id: "exports-and-deletion",
    title: "Exports and deletion",
    paragraphs: [
      "Studio admins can export many operational records from Reports. Admin-only cleanup tools can delete or replace working studio data after confirmation while preserving platform access records needed to keep Koaryu Core subscription access intact.",
    ],
  },
  {
    id: "third-party-services",
    title: "Third-party services",
    paragraphs: [
      "Koaryu depends on service providers such as Supabase, Stripe, Render, and Vercel to authenticate users, store data, process payments, host the backend, and serve the frontend. Those providers may process information as needed to deliver their services.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    paragraphs: [
      "For privacy, access, export, or deletion questions, contact support@koaryu.app and include the relevant studio name and account email.",
    ],
  },
] as const;

const privacyNotice =
  "Koaryu may update this privacy policy as the product, business details, data retention decisions, support process, and payment configuration evolve. Material changes should be reflected here before relying on the updated behavior in production.";

export default function PrivacyPage() {
  return (
    <PublicPageShell>
      <header className={styles.legalHero}>
        <div className={styles.legalHeroInner}>
          <p className={styles.eyebrow}>Legal</p>
          <h1>Privacy Policy</h1>
          <p className={styles.legalDescription}>
            How Koaryu handles account, studio, student, and payment-adjacent data.
          </p>
          <time className={styles.legalUpdated} dateTime="2026-05-19">
            Updated May 19, 2026
          </time>
        </div>
      </header>

      <div className={styles.legalLayout}>
        <nav className={styles.legalSectionNavigation} aria-label="Privacy policy sections">
          <p className={styles.eyebrow}>On this page</p>
          <ul>
            {privacySections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className={styles.legalDocument} aria-label="Privacy policy">
          {privacySections.map((section) => (
            <section key={section.id} id={section.id} className={styles.legalSection}>
              <h2>{section.title}</h2>
              <div className={styles.legalBody}>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
          <aside className={styles.legalNotice} aria-label="Policy update notice">
            {privacyNotice}
          </aside>
        </article>
      </div>
    </PublicPageShell>
  );
}
