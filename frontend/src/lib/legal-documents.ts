export type LegalDocumentKey = "terms" | "privacy";

export interface LegalRevision {
  /** ISO date, newest first. */
  date: string;
  summary: string;
}

export interface LegalDocumentEntry {
  href: `/${LegalDocumentKey}`;
  title: string;
  /** ISO date the current text takes effect. */
  effective: string;
  history: readonly [LegalRevision, ...LegalRevision[]];
}

/** One support inbox handles legal, privacy and account requests. */
export const legalContact = {
  email: "support@koaryu.app",
} as const;

export const legalDocuments: Record<LegalDocumentKey, LegalDocumentEntry> = {
  terms: {
    href: "/terms",
    title: "Terms of Service",
    effective: "2026-10-08",
    history: [
      {
        date: "2026-10-08",
        summary:
          "Rewritten in full: subscription, trial and cancellation terms, Koaryu Payments and Stripe Connect responsibilities, studio data, acceptable use, warranties, liability, disputes and notices.",
      },
      { date: "2026-05-19", summary: "First published." },
    ],
  },
  privacy: {
    href: "/privacy",
    title: "Privacy Policy",
    effective: "2026-10-08",
    history: [
      {
        date: "2026-10-08",
        summary:
          "Rewritten in full: Koaryu's role for studio records, the categories of information and their sources, service providers, cookies, retention, security, children's information, privacy rights by region, and international transfers.",
      },
      { date: "2026-05-19", summary: "First published." },
    ],
  },
};

const legalDateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function formatLegalDate(isoDate: string) {
  return legalDateFormat.format(new Date(`${isoDate}T00:00:00Z`));
}
