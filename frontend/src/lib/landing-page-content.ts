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

export type JourneyChapterId =
  "welcome" | "the-problem" | "product" | "features" | "pricing" | "faq" | "begin";

export type JourneyInk = "dark" | "light";

export type JourneyChapterKind =
  "hero" | "problem" | "product" | "features" | "pricing" | "faq" | "final";

export interface JourneyAction {
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

export interface JourneyBaseChapter {
  id: JourneyChapterId;
  title: string;
  /** Scene progress held while this chapter is being read. */
  scene: number;
  /**
   * Length, in percent of the screen's height, of the open stretch of scroll
   * after this chapter where the next story beat plays unobstructed. Longer
   * beats get more room.
   */
  interludeAfter?: number;
  kind: JourneyChapterKind;
  ink: JourneyInk;
}

export interface JourneyHeroChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "hero";
  kicker: string;
  headline: readonly [string, string];
  lede: string;
  actions: readonly [JourneyAction, JourneyAction];
}

export interface JourneyProblemChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "problem";
  question: string;
  aside: string;
}

export interface ProductHighlight {
  label: string;
  description: string;
}

export interface JourneyProductChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "product";
  lede: string;
  image: {
    src: string;
    width: number;
    height: number;
    alt: string;
    caption: string;
    /** The same screen in the app's phone layout, shown in front of the desktop screen. */
    mobile: { src: string; width: number; height: number; alt: string };
  };
  highlights: readonly ProductHighlight[];
}

/** One moment of a day at the studio, and the part of Koaryu that handles it. */
export interface DayMoment {
  time: string;
  title: string;
  description: string;
  detail: LandingDetailReference;
}

export interface JourneyFeaturesChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "features";
  lede: string;
  moments: readonly DayMoment[];
  links: readonly [JourneyAction, JourneyAction];
}

export interface PricingFact {
  label: string;
  description: string;
}

export interface JourneyPricingChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "pricing";
  amount: string;
  displayPrice: string;
  period: string;
  facts: readonly PricingFact[];
  setupAction: JourneyAction;
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

export interface JourneyFaqChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "faq";
  groups: readonly FaqGroup[];
}

export interface JourneyFinalChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "final";
  lede: string;
  action: JourneyAction;
  footerLinks: readonly JourneyAction[];
  copyright: string;
}

export type JourneyChapter =
  | JourneyHeroChapter
  | JourneyProblemChapter
  | JourneyProductChapter
  | JourneyFeaturesChapter
  | JourneyPricingChapter
  | JourneyFaqChapter
  | JourneyFinalChapter;

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

const dayMoments: readonly DayMoment[] = [
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
    description:
      "Check class counts, time at rank and instructor approval for each student before deciding whom to test.",
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
      "Import your spreadsheet: map the columns to student fields, review the results, and you're set up.",
    detail: landingDetail({ kind: "useCase", slug: "spreadsheets-to-studio-crm" }),
  },
];

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

export const landingPageContent = {
  chapters: [
    {
      id: "welcome",
      title: "Run the school. Teach the art.",
      scene: 0,
      interludeAfter: 70,
      kind: "hero",
      ink: "dark",
      kicker: "For independent martial arts schools",
      headline: ["Run the school.", "Teach the art."],
      lede: `Students, ranks, attendance and trial follow-ups in one calm place. ${formatPublicPlatformPrice()} per studio per month.`,
      actions: [
        { label: "Create an account", href: "/signup" },
        { label: "See the product", href: "#product" },
      ],
    },
    {
      id: "the-problem",
      title: "Your studio is not a spreadsheet.",
      scene: 0.1,
      interludeAfter: 80,
      kind: "problem",
      ink: "light",
      question:
        "Yet the roster, belt ranks, trial follow-ups and payment notes still live in five of them.",
      aside: "Class starts in ten minutes. Which one is up to date?",
    },
    {
      id: "product",
      title: "Know who is ready for their next belt.",
      scene: 0.288,
      interludeAfter: 100,
      kind: "product",
      ink: "dark",
      lede: "Classes attended count toward the next rank's requirement. Koaryu keeps the tally; the decision to promote stays with you.",
      image: {
        src: "/marketing/product/belt-tracker.webp",
        width: 2400,
        height: 1500,
        alt: "Koaryu belt tracker listing students by current rank, with classes attended and time at rank toward the next belt.",
        caption: "Belt tracker, shown with sample studio data.",
        mobile: {
          src: "/marketing/product/belt-tracker-mobile.webp",
          width: 780,
          height: 1520,
          alt: "The same belt tracker in Koaryu's phone layout, with ready, approval and in-progress counts.",
        },
      },
      highlights: [
        {
          label: "Requirements you define",
          description: "Classes, time at rank and instructor approval, per program.",
        },
        {
          label: "Ready at a glance",
          description: "See how many students meet every requirement, rank by rank.",
        },
      ],
    },
    {
      id: "features",
      title: "Everything between classes.",
      scene: 0.52,
      interludeAfter: 100,
      kind: "features",
      ink: "dark",
      lede: "A day at the studio, from the first coffee to the last class. Built around how a dojo actually runs.",
      moments: dayMoments,
      links: [
        { label: "All features", href: "/features" },
        { label: "Workflow guides", href: "/use-cases" },
      ],
    },
    {
      id: "pricing",
      title: "One price. Every student.",
      scene: 0.66,
      interludeAfter: 200,
      kind: "pricing",
      ink: "dark",
      amount: publicPlatformPriceAmount(),
      displayPrice: formatPublicPlatformPrice(),
      period: "per studio, per month",
      facts: [
        {
          label: "Everything included",
          description:
            "Students, ranks, leads, scheduling, attendance, reports and billing records.",
        },
        {
          label: "No per-student tiers",
          description: "Grow your roster without growing your bill.",
        },
      ],
      setupAction: { label: "Create an account", href: "/signup" },
    },
    {
      id: "faq",
      title: "Questions owners ask",
      scene: 0.952,
      interludeAfter: 90,
      kind: "faq",
      ink: "dark",
      groups: faqGroups,
    },
    {
      id: "begin",
      title: "Enough admin. Go teach.",
      scene: 1,
      kind: "final",
      ink: "dark",
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
  ],
} as const satisfies { chapters: readonly JourneyChapter[] };
