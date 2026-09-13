import type { Metadata } from "next";

import { LegalDocument } from "@/components/marketing/legal-document";

export const metadata: Metadata = {
  title: "Privacy Policy | Koaryu",
  description: "How Koaryu handles account, studio, student, and billing information.",
  alternates: { canonical: "https://koaryu.app/privacy" },
  openGraph: {
    title: "Privacy Policy | Koaryu",
    description: "How Koaryu handles account, studio, student, and billing information.",
    url: "https://koaryu.app/privacy",
  },
};

const privacySections = [
  {
    id: "information-koaryu-handles",
    title: "Information Koaryu handles",
    paragraphs: [
      "Koaryu handles account details and the studio records entered or created while using the product. These records include staff roles, students, guardians, leads, schedules, attendance, rank progress, reports, audit records, billing plans, payers, invoices, payments, refunds, and disputes.",
    ],
  },
  {
    id: "authentication-and-access",
    title: "Authentication and access",
    paragraphs: [
      "Koaryu checks each user's studio membership and role before allowing access to studio records. Users should protect their login details. Studio admins should remove access when a staff member no longer needs it.",
    ],
  },
  {
    id: "payments",
    title: "Payments",
    paragraphs: [
      "Stripe processes card, bank, and other payment method details. Koaryu does not store raw card numbers. It stores Stripe IDs, invoice and payment status, fee amounts, and related billing records so studios can review payment activity.",
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
      "Koaryu uses Supabase for sign-in and data storage, Stripe for payment processing, Render for backend hosting, and Vercel for the website and application. These companies may process information when providing those services.",
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
  "Koaryu may update this privacy policy as the product, business details, data retention decisions, support process, and payment configuration evolve.";

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      description="How Koaryu handles account, studio, student, and billing information."
      sections={privacySections}
      navigationLabel="Privacy policy sections"
      documentLabel="Privacy policy"
      notice={privacyNotice}
      noticeLabel="Policy update notice"
    />
  );
}
