import {
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
  PUBLIC_PAYMENTS_FEE_PERCENT,
} from "./constants.ts";
import {
  getMarketingPageByRef,
  type MarketingPageKind,
  type MarketingPageRef,
} from "./marketing-pages.ts";

export interface LandingAction {
  label: string;
  href: string;
}

export interface LandingDetailReference {
  kind: MarketingPageKind;
  slug: string;
  href: string;
  eyebrow: string;
  title: string;
}

export type FilmInk = "dark" | "light";

/** A title card in the film: one short line, set over the artwork. */
export interface FilmTitle {
  id: string;
  title: string;
  ink: FilmInk;
}

export interface DayMoment {
  time: string;
  title: string;
  description: string;
  detail: LandingDetailReference;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqGroup {
  id: string;
  title: string;
  items: readonly FaqItem[];
}

function landingDetail(ref: MarketingPageRef): LandingDetailReference {
  const page = getMarketingPageByRef(ref);

  if (!page) {
    throw new Error(`Missing marketing page for landing reference: ${ref.kind}/${ref.slug}`);
  }

  return {
    kind: page.kind,
    slug: page.slug,
    href: page.href,
    eyebrow: page.eyebrow,
    title: page.title,
  };
}

const faqGroups: readonly FaqGroup[] = [
  {
    id: "faq-fit",
    title: "Getting started",
    items: [
      {
        question: "Who is Koaryu built for?",
        answer:
          "Independent martial arts schools with a small staff: one studio, a few programs, and instructors who would rather be on the mat than in a spreadsheet.",
      },
      {
        question: "Can I use my own belt system?",
        answer:
          "Yes. Create ordered ranks for each program, with class-count, time-at-rank and instructor-approval requirements. Instructors review eligibility and record each promotion.",
      },
      {
        question: "What can I import?",
        answer:
          "Student CSV import maps names, contacts, programs and current belts. Valid rows import and invalid rows are listed for correction. Import does not deduplicate existing students, so review the results before importing again.",
      },
    ],
  },
  {
    id: "faq-daily",
    title: "Day to day",
    items: [
      {
        question: "Can instructors take attendance?",
        answer:
          "Yes. Instructors open a dated class roster, mark students Present, Late or Absent, and correct entries when needed. Each change saves on its own.",
      },
      {
        question: "Who can see billing?",
        answer:
          "Admin and Front Desk staff. Instructors work with student profiles, attendance and rank history, and cannot access billing. Admins manage staff roles.",
      },
      {
        question: "Is there a mobile app?",
        answer:
          "Koaryu runs in the browser on phones, tablets and computers, so there is nothing to install.",
      },
    ],
  },
  {
    id: "faq-pricing",
    title: "Pricing & payments",
    items: [
      {
        question: `What does ${formatPublicPlatformPrice()} a month include?`,
        answer:
          "One studio's students, ranks, leads, scheduling, attendance, reports and billing records. There are no per-student tiers.",
      },
      {
        question: "Can families pay tuition through Koaryu?",
        answer: `Online tuition collection through Koaryu Payments requires separate activation and is not generally available. When enabled, the standard fee is ${PUBLIC_PAYMENTS_FEE_PERCENT}% per successful charge, plus Stripe fees. In the meantime, record cash, check and other outside payments against each payer.`,
      },
    ],
  },
  {
    id: "faq-limits",
    title: "Current limits",
    items: [
      {
        question: "What doesn't Koaryu do yet?",
        answer:
          "It is built for one studio, with no multi-location dashboard. It doesn't send automated email or SMS reminders; staff work from the follow-up queue and contact families themselves. Import does not bring over past attendance, promotions or billing, and new billing exports are unavailable.",
      },
      {
        question: "How do I get support?",
        answer:
          "After signing in, open your account menu, then Help, Help center and Contact support. You get a ticket reference in the app.",
      },
    ],
  },
];

/**
 * The landing page in two acts. Act one is a film: the illustrated story,
 * pinned and scrubbed by scroll, with a few title cards. Act two is the page:
 * the product, a day at the studio, the price, questions and the close.
 */
export const landingPageContent = {
  hero: {
    id: "welcome",
    kicker: "For independent martial arts schools",
    headline: ["Run the school.", "Teach the art."],
    lede: `Students, ranks, attendance and trial follow-ups in one calm place. ${formatPublicPlatformPrice()} per studio per month.`,
    actions: [
      { label: "Create an account", href: "/signup" },
      { label: "See the product", href: "#product" },
    ],
  },
  titles: [
    { id: "the-problem", title: "Your studio is not a spreadsheet.", ink: "light" },
    { id: "the-path", title: "Every class is a step toward the next belt.", ink: "dark" },
  ],
  handoff: {
    id: "studio",
    title: "Koaryu keeps count. You teach.",
    lede: "One place for a small school's students and families, belt ranks, attendance, trials and billing records, so the mat gets your attention.",
    action: { label: "Create an account", href: "/signup" },
    caption: "Illustration with sample students.",
  },
  product: {
    id: "product",
    title: "Know who is ready for their next belt.",
    lede: "Set the requirements for each program: classes, time at rank and instructor approval. Koaryu keeps the tally, rank by rank. The decision to promote stays with you.",
    image: {
      src: "/marketing/product/belt-tracker.webp",
      width: 2400,
      height: 1500,
      alt: "Koaryu belt tracker listing students by current rank, with classes attended and time at rank toward the next belt.",
      mobile: {
        src: "/marketing/product/belt-tracker-mobile.webp",
        width: 780,
        height: 1520,
        alt: "The same belt tracker in Koaryu's phone layout.",
      },
    },
    caption: "Belt tracker, shown with sample studio data.",
  },
  day: {
    id: "features",
    title: "Everything between classes.",
    lede: "A day at the studio, and the part of Koaryu that helps with each moment of it.",
    moments: [
      {
        time: "7:30 AM",
        title: "Open the dashboard",
        description:
          "Today's classes, students with attendance gaps and follow-ups that are due, on one screen.",
        detail: landingDetail({ kind: "useCase", slug: "student-retention" }),
      },
      {
        time: "3:45 PM",
        title: "A trial family walks in",
        description:
          "Add the lead, note the visit and set a follow-up date. Due and overdue follow-ups wait in one queue.",
        detail: landingDetail({ kind: "useCase", slug: "trial-to-enrollment" }),
      },
      {
        time: "4:30 PM",
        title: "A parent calls about two kids",
        description:
          "Each child keeps their own profile, program, rank and history. Guardians and payers are recorded separately.",
        detail: landingDetail({ kind: "feature", slug: "student-management" }),
      },
      {
        time: "6:00 PM",
        title: "Take attendance",
        description:
          "Open today's roster and mark Present, Late or Absent. Classes attended count toward the next rank.",
        detail: landingDetail({ kind: "feature", slug: "attendance" }),
      },
      {
        time: "7:15 PM",
        title: "Plan the belt test",
        description: "Check class counts, time at rank and approvals before deciding whom to test.",
        detail: landingDetail({ kind: "feature", slug: "belt-tracking" }),
      },
      {
        time: "8:00 PM",
        title: "The front desk closes out",
        description:
          "Payers, invoices and cash or check payments in one place. Instructors never see billing.",
        detail: landingDetail({ kind: "feature", slug: "billing" }),
      },
      {
        time: "Sunday",
        title: "Bring your roster over",
        description:
          "Import your spreadsheet: map the columns, review the results, and you're set up.",
        detail: landingDetail({ kind: "useCase", slug: "spreadsheets-to-studio-crm" }),
      },
    ],
    links: [
      { label: "All features", href: "/features" },
      { label: "Workflow guides", href: "/use-cases" },
    ],
  },
  pricing: {
    id: "pricing",
    title: "One price. Every student.",
    amount: publicPlatformPriceAmount(),
    displayPrice: formatPublicPlatformPrice(),
    period: "per studio, per month",
    note: "No per-student tiers. Grow your roster without growing your bill.",
    included: [
      "Students & families",
      "Ranks & belt tests",
      "Attendance",
      "Trials & leads",
      "Scheduling",
      "Reports",
      "Billing records",
    ],
    setupAction: { label: "Create an account", href: "/signup" },
    paymentsLink: { label: "Collecting tuition online?", href: "#faq-pricing" },
  },
  faq: {
    id: "faq",
    title: "Questions owners ask",
    groups: faqGroups,
  },
  finale: {
    id: "begin",
    title: "Enough admin. Go teach.",
    lede: `${formatPublicPlatformPrice()} per studio, per month.`,
    action: { label: "Create an account", href: "/signup" },
    footerLinks: [
      { label: "Features", href: "/features" },
      { label: "Workflows", href: "/use-cases" },
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
    copyright: "© 2026 Koaryu",
  },
} as const satisfies {
  hero: {
    id: string;
    kicker: string;
    headline: readonly [string, string];
    lede: string;
    actions: readonly [LandingAction, LandingAction];
  };
  titles: readonly FilmTitle[];
  handoff: { id: string; title: string; lede: string; action: LandingAction; caption: string };
  product: {
    id: string;
    title: string;
    lede: string;
    image: {
      src: string;
      width: number;
      height: number;
      alt: string;
      mobile: { src: string; width: number; height: number; alt: string };
    };
    caption: string;
  };
  day: {
    id: string;
    title: string;
    lede: string;
    moments: readonly DayMoment[];
    links: readonly [LandingAction, LandingAction];
  };
  pricing: {
    id: string;
    title: string;
    amount: string;
    displayPrice: string;
    period: string;
    note: string;
    included: readonly string[];
    setupAction: LandingAction;
    paymentsLink: LandingAction;
  };
  faq: { id: string; title: string; groups: readonly FaqGroup[] };
  finale: {
    id: string;
    title: string;
    lede: string;
    action: LandingAction;
    footerLinks: readonly LandingAction[];
    copyright: string;
  };
};

export type LandingPageContent = typeof landingPageContent;
