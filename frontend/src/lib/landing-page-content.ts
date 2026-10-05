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

/**
 * The landing page in two acts. The story is paged: each chapter is a composed
 * frame of the illustrated scene, and one gesture moves one chapter. After the
 * class sits, the picture is handed off into a framed still and the page reads
 * as an ordinary product page: pricing, the hands-on demo, questions, the close.
 */

export type StoryChapterId =
  "welcome" | "the-problem" | "product" | "features" | "the-path" | "the-weave" | "studio";

export type StoryChapterKind =
  "hero" | "problem" | "product" | "features" | "path" | "weave" | "studio";

/** Ink for copy set directly on the daytime scene. */
export type JourneyInk = "dark" | "light";

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

interface StoryChapterBase {
  id: StoryChapterId;
  kind: StoryChapterKind;
  title: string;
  /** Short name in the chapter rail. */
  label: string;
  /** Scene progress (0 hills to 1 seated class) held while this chapter is shown. */
  scene: number;
  ink: JourneyInk;
}

export interface HeroChapter extends StoryChapterBase {
  kind: "hero";
  kicker: string;
  headline: readonly [string, string];
  lede: string;
  actions: readonly [JourneyAction, JourneyAction];
}

export interface ProblemChapter extends StoryChapterBase {
  kind: "problem";
  question: string;
  aside: string;
}

export interface ProductHighlight {
  label: string;
  description: string;
}

export interface ProductChapter extends StoryChapterBase {
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

export interface FeaturesChapter extends StoryChapterBase {
  kind: "features";
  lede: string;
  moments: readonly DayMoment[];
  links: readonly [JourneyAction, JourneyAction];
}

export interface PathChapter extends StoryChapterBase {
  kind: "path";
}

export interface WeaveChapter extends StoryChapterBase {
  kind: "weave";
  lede: string;
  /** The studio's scattered threads, written along the strands of the weave. */
  threads: readonly string[];
}

/** The seated class, then the hand-off into the page. */
export interface StudioChapter extends StoryChapterBase {
  kind: "studio";
  lede: string;
  actions: readonly [JourneyAction, JourneyAction];
  caption: string;
  /** Rail label for the hand-off, where the page begins. */
  handoffLabel: string;
}

export type StoryChapter =
  | HeroChapter
  | ProblemChapter
  | ProductChapter
  | FeaturesChapter
  | PathChapter
  | WeaveChapter
  | StudioChapter;

export interface PricingSection {
  id: "pricing";
  title: string;
  lede: string;
  amount: string;
  displayPrice: string;
  period: string;
  plan: { name: string; scope: string };
  included: readonly string[];
  /** Roster sizes shown at the same price, so "no per-student tiers" is visible. */
  rosterSizes: readonly number[];
  rosterNote: string;
  setupAction: JourneyAction;
  paymentsNote: { lead: string; label: string; href: string };
}

export interface TryStudent {
  initials: string;
  name: string;
  belt: "white" | "yellow" | "orange";
  beltLabel: string;
  attended: number;
  required: number;
}

export interface TrySection {
  id: "try";
  title: string;
  lede: string;
  tasks: readonly { title: string; description: string }[];
  action: JourneyAction;
  secondaryAction: JourneyAction;
  miniature: {
    studio: string;
    className: string;
    when: string;
    students: readonly TryStudent[];
    readyLabel: string;
    caption: string;
  };
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

export interface FaqSection {
  id: "faq";
  title: string;
  lede: string;
  groups: readonly FaqGroup[];
}

export interface CloseSection {
  id: "begin";
  title: string;
  lede: string;
  action: JourneyAction;
  footerLinks: readonly JourneyAction[];
  copyright: string;
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

const story = [
  {
    id: "welcome",
    kind: "hero",
    title: "Run the school. Teach the art.",
    label: "Welcome",
    scene: 0,
    ink: "dark",
    kicker: "For independent martial arts schools",
    headline: ["Run the school.", "Teach the art."],
    lede: `Students, ranks, attendance and trial follow-ups in one calm place. ${formatPublicPlatformPrice()} per studio per month.`,
    actions: [
      { label: "Create an account", href: "/signup" },
      { label: "Try it", href: "/try" },
    ],
  },
  {
    id: "the-problem",
    kind: "problem",
    title: "Your studio is not a spreadsheet.",
    label: "Spreadsheets",
    scene: 0.1,
    ink: "light",
    question:
      "Yet the roster, belt ranks, trial follow-ups and payment notes still live in five of them.",
    aside: "Class starts in ten minutes. Which one is up to date?",
  },
  {
    id: "product",
    kind: "product",
    title: "Know who is ready for their next belt.",
    label: "Belt tracker",
    scene: 0.288,
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
    kind: "features",
    title: "Everything between classes.",
    label: "Between classes",
    scene: 0.52,
    ink: "dark",
    lede: "A day at the studio, from the first coffee to the last class. Built around how a dojo actually runs.",
    moments: dayMoments,
    links: [
      { label: "All features", href: "/features" },
      { label: "Workflow guides", href: "/use-cases" },
    ],
  },
  {
    id: "the-path",
    kind: "path",
    title: "Every class is a step toward the next belt.",
    label: "The path",
    scene: 0.66,
    ink: "dark",
  },
  {
    id: "the-weave",
    kind: "weave",
    title: "Everything your studio runs on, woven into one place.",
    label: "Woven together",
    scene: 0.892,
    ink: "dark",
    lede: "Students, families, belt ranks, attendance, trial leads, schedules and billing records, held in one studio workspace instead of five spreadsheets.",
    threads: [
      "Students",
      "Families",
      "Belt ranks",
      "Attendance",
      "Trial leads",
      "Schedules",
      "Billing records",
    ],
  },
  {
    id: "studio",
    kind: "studio",
    title: "Koaryu keeps count. You teach.",
    label: "The class",
    scene: 1,
    ink: "dark",
    lede: "One place for a small school's students and families, belt ranks, attendance, trials and billing records, so the mat gets your attention.",
    actions: [
      { label: "Create an account", href: "/signup" },
      { label: "Try it", href: "/try" },
    ],
    caption: "Illustration with sample students.",
    handoffLabel: "Get started",
  },
] as const satisfies readonly StoryChapter[];

const pricing: PricingSection = {
  id: "pricing",
  title: "One price. Every student.",
  lede: "Every feature for every student on your roster, in one studio subscription.",
  amount: publicPlatformPriceAmount(),
  displayPrice: formatPublicPlatformPrice(),
  period: "per studio, per month",
  plan: { name: "Studio plan", scope: "One studio, every program" },
  included: [
    "Students & families",
    "Ranks & belt tests",
    "Attendance",
    "Trials & leads",
    "Scheduling",
    "Reports",
    "Billing records",
    "Admin, Instructor and Front Desk roles",
  ],
  rosterSizes: [25, 80, 200],
  rosterNote: "No per-student tiers. Grow your roster without growing your bill.",
  setupAction: { label: "Create an account", href: "/signup" },
  paymentsNote: {
    lead: "Collecting tuition online?",
    label: "See Pricing & payments",
    href: "#faq-pricing",
  },
};

const tryIt: TrySection = {
  id: "try",
  title: "Try it on tonight's class.",
  lede: "A working miniature of Koaryu with sample students. Tap around; nothing you change is saved.",
  tasks: [
    { title: "Take attendance", description: "Tap a student to cycle Present, Late and Absent." },
    {
      title: "Finish Maya's requirement",
      description: "She is one class short of Yellow Belt.",
    },
    { title: "Add a trial lead", description: "Then work the follow-up queue." },
  ],
  action: { label: "Try it", href: "/try" },
  secondaryAction: { label: "Create an account", href: "/signup" },
  miniature: {
    studio: "Riverside Karate",
    className: "Kids Karate",
    when: "Tuesday, 6:00 PM",
    students: [
      {
        initials: "ZA",
        name: "Zara Ali",
        belt: "white",
        beltLabel: "White Belt",
        attended: 3,
        required: 8,
      },
      {
        initials: "NB",
        name: "Noah Bennett",
        belt: "yellow",
        beltLabel: "Yellow Belt",
        attended: 5,
        required: 10,
      },
      {
        initials: "HM",
        name: "Hana Mori",
        belt: "orange",
        beltLabel: "Orange Belt",
        attended: 9,
        required: 12,
      },
      {
        initials: "MC",
        name: "Maya Chen",
        belt: "white",
        beltLabel: "White Belt",
        attended: 7,
        required: 8,
      },
    ],
    readyLabel: "Ready to test",
    caption: "Sample students and class.",
  },
};

const faq: FaqSection = {
  id: "faq",
  title: "Questions owners ask",
  lede: "Straight answers, including what Koaryu doesn't do yet.",
  groups: faqGroups,
};

const close: CloseSection = {
  id: "begin",
  title: "Enough admin. Go teach.",
  lede: `${formatPublicPlatformPrice()} per studio, per month.`,
  action: { label: "Create an account", href: "/signup" },
  footerLinks: [
    { label: "Features", href: "/features" },
    { label: "Workflows", href: "/use-cases" },
    { label: "Try it", href: "/try" },
    { label: "Terms", href: "/terms" },
    { label: "Privacy", href: "/privacy" },
  ],
  copyright: "© 2026 Koaryu",
};

export const landingPageContent = {
  story,
  pricing,
  tryIt,
  faq,
  close,
} as const;

export type LandingPageContent = typeof landingPageContent;
