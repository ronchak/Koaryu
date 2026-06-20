import type { Metadata } from "next";
import { AccountNotice, AccountPageShell, AccountSection } from "@/components/account-page-shell";
import { PublicPageShell } from "@/components/marketing/public-pages";

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

export default function PrivacyPage() {
  return (
    <PublicPageShell>
      <AccountPageShell
        title="Privacy Policy"
        description="How Koaryu handles account, studio, student, and payment-adjacent data."
        badge="Updated May 19, 2026"
      >
        <AccountSection title="Information Koaryu handles">
          <p className="text-sm leading-relaxed text-text-secondary">
            Koaryu handles account information, studio settings, staff roles, students, guardians, leads, schedules,
            attendance, rank progress, reports, audit records, billing plans, payer records, invoices, payments, refunds,
            disputes, and related metadata needed to operate the product.
          </p>
        </AccountSection>

        <AccountSection title="Authentication and access">
          <p className="text-sm leading-relaxed text-text-secondary">
            Koaryu uses Supabase Auth for authentication and uses studio membership, role checks, backend authorization,
            and database policies to scope records to the correct studio. Users should protect their login credentials and
            studio admins should promptly remove staff who no longer need access.
          </p>
        </AccountSection>

        <AccountSection title="Payments">
          <p className="text-sm leading-relaxed text-text-secondary">
            Stripe processes card and bank/payment method details. Koaryu stores Stripe IDs, invoice status, payment
            status, fee amounts, reconciliation state, and other payment metadata so studios can understand and repair
            billing activity without storing raw card numbers.
          </p>
        </AccountSection>

        <AccountSection title="How information is used">
          <p className="text-sm leading-relaxed text-text-secondary">
            Koaryu uses information to provide studio management features, enforce permissions, support billing workflows,
            troubleshoot errors, protect accounts, generate exports and reports, improve reliability, and respond to
            support requests.
          </p>
        </AccountSection>

        <AccountSection title="Exports and deletion">
          <p className="text-sm leading-relaxed text-text-secondary">
            Studio admins can export many operational records from Reports. Admin-only cleanup tools can delete or replace
            working studio data after confirmation while preserving platform access records needed to keep Koaryu Core
            subscription access intact.
          </p>
        </AccountSection>

        <AccountSection title="Third-party services">
          <p className="text-sm leading-relaxed text-text-secondary">
            Koaryu depends on service providers such as Supabase, Stripe, Render, and Vercel to authenticate users, store
            data, process payments, host the backend, and serve the frontend. Those providers may process information as
            needed to deliver their services.
          </p>
        </AccountSection>

        <AccountSection title="Contact">
          <p className="text-sm leading-relaxed text-text-secondary">
            For privacy, access, export, or deletion questions, contact support@koaryu.app and include the relevant studio
            name and account email.
          </p>
        </AccountSection>

        <AccountNotice>
          Koaryu may update this privacy policy as the product, business details, data retention decisions, support
          process, and payment configuration evolve. Material changes should be reflected here before relying on the
          updated behavior in production.
        </AccountNotice>
      </AccountPageShell>
    </PublicPageShell>
  );
}
