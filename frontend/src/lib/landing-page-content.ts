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

export interface LandingSummaryRow {
  title: string;
  description: string;
  detail: LandingDetailReference;
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
  kicker: string;
  lede: string;
  image: {
    src: string;
    width: number;
    height: number;
    alt: string;
    caption: string;
    /** The same screen in the app's phone layout, shown on narrow viewports. */
    mobile: { src: string; width: number; height: number };
  };
  highlights: readonly ProductHighlight[];
}

export interface JourneyFeaturesChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "features";
  kicker: string;
  lede: string;
  rows: readonly LandingSummaryRow[];
  links: readonly [JourneyAction, JourneyAction];
}

export interface PricingFact {
  label: string;
  description: string;
}

export interface JourneyPricingChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "pricing";
  kicker: string;
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
  kicker: string;
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

const featureRows: readonly LandingSummaryRow[] = [
  {
    title: "Students & families",
    description:
      "One profile per student with program, rank, guardians and notes. Siblings keep their own history.",
    detail: landingDetail({ kind: "feature", slug: "student-management" }),
  },
  {
    title: "Ranks & belt tests",
    description:
      "Set class-count, time-at-rank and instructor-approval requirements, then see who is ready to test.",
    detail: landingDetail({ kind: "feature", slug: "belt-tracking" }),
  },
  {
    title: "Attendance",
    description:
      "Open today's roster and mark Present, Late or Absent. Classes attended count toward the next rank.",
    detail: landingDetail({ kind: "feature", slug: "attendance" }),
  },
  {
    title: "Trials & leads",
    description:
      "Track every inquiry from first visit to enrollment, with due and overdue follow-ups in one queue.",
    detail: landingDetail({ kind: "useCase", slug: "trial-to-enrollment" }),
  },
  {
    title: "Roster import",
    description:
      "Bring your spreadsheet. Map the columns to student fields, review the results, and you're set up.",
    detail: landingDetail({ kind: "useCase", slug: "spreadsheets-to-studio-crm" }),
  },
  {
    title: "Billing records",
    description:
      "Payers, invoices and cash or check payments in one place for the front desk. Instructors never see billing.",
    detail: landingDetail({ kind: "feature", slug: "billing" }),
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
      interludeAfter: 50,
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
      interludeAfter: 60,
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
      interludeAfter: 70,
      kind: "product",
      ink: "dark",
      kicker: "The belt tracker",
      lede: "Classes attended count toward the next rank's requirement. Koaryu keeps the tally; the decision to promote stays with you.",
      image: {
        src: "/marketing/product/belt-tracker.webp",
        width: 2400,
        height: 1500,
        alt: "Koaryu belt tracker listing students by current rank, with classes attended and time at rank toward the next belt.",
        caption: "Belt tracker, shown with sample studio data.",
        mobile: { src: "/marketing/product/belt-tracker-mobile.webp", width: 780, height: 1520 },
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
      interludeAfter: 80,
      kind: "features",
      ink: "dark",
      kicker: "What's inside",
      lede: "Built around how a dojo actually runs: programs, ranks, and the people moving through them.",
      rows: featureRows,
      links: [
        { label: "All features", href: "/features" },
        { label: "Workflow guides", href: "/use-cases" },
      ],
    },
    {
      id: "pricing",
      title: "One price. Every student.",
      scene: 0.66,
      interludeAfter: 130,
      kind: "pricing",
      ink: "dark",
      kicker: "Pricing",
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
      scene: 0.892,
      interludeAfter: 100,
      kind: "faq",
      ink: "dark",
      kicker: "FAQ",
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
