import {
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
  PUBLIC_PAYMENTS_FEE_PERCENT,
  PUBLIC_PLATFORM_TRIAL_DAYS,
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

export type StoryChapterId = "welcome" | "product" | "features" | "the-weave" | "studio";

export type StoryChapterKind = "hero" | "product" | "features" | "weave" | "studio";

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
  /** The offer, under the actions. */
  note: string;
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

/** A crop of the real screen that handles a moment, captured at 2x from preview mode. */
export interface DayShot {
  src: string;
  /** Pixel size of the file; the crop is drawn at half this size. */
  width: number;
  height: number;
  /**
   * Radius, in file pixels, of the screen's own rounded corners where the crop
   * keeps them. The print's frame rounds just inside it, so none of the app's
   * backdrop shows in a corner.
   */
  corner: number;
  alt: string;
}

/** One moment of a day at the studio, and the part of Koaryu that handles it. */
export interface DayMoment {
  time: string;
  title: string;
  description: string;
  detail: LandingDetailReference;
  shot: DayShot;
}

export interface FeaturesChapter extends StoryChapterBase {
  kind: "features";
  lede: string;
  moments: readonly DayMoment[];
  /** Under the day: whose data the screens show. */
  caption: string;
  links: readonly [JourneyAction, JourneyAction];
}

/** The words rest on the gathered clouds; the weave plays on the way to the class. */
export interface WeaveChapter extends StoryChapterBase {
  kind: "weave";
  lede: string;
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
  HeroChapter | ProductChapter | FeaturesChapter | WeaveChapter | StudioChapter;

export interface PricingSection {
  id: "pricing";
  title: string;
  lede: string;
  /** The trial terms, beside the price. */
  trial: string;
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
  /** What happens after the trial button, step by step, as the product does it. */
  start: { title: string; steps: readonly { title: string; text: string }[] };
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

/** The offer, said the same way wherever it appears. */
const TRIAL_NOTE = `${PUBLIC_PLATFORM_TRIAL_DAYS} days free, then ${formatPublicPlatformPrice()} a month per studio.`;

const TRIAL_ACTION: JourneyAction = { label: "Start free trial", href: "/signup" };
const DEMO_ACTION: JourneyAction = { label: "Try the demo", href: "/try" };

const dayMoments: readonly DayMoment[] = [
  {
    time: "7:00 AM",
    title: "Bring your roster over",
    description:
      "First morning on Koaryu? Import your spreadsheet, map its columns to student fields and review the results before the first class.",
    detail: landingDetail({ kind: "useCase", slug: "spreadsheets-to-studio-crm" }),
    shot: {
      src: "/marketing/product/day-import.webp",
      width: 1080,
      height: 670,
      corner: 24,
      alt: "Koaryu's import mapping each column of a spreadsheet, such as First Name, Last Name and Email, to a student field.",
    },
  },
  {
    time: "7:30 AM",
    title: "Open the dashboard",
    description:
      "Today's classes, students with attendance gaps and follow-ups that are due, on one screen.",
    detail: landingDetail({ kind: "useCase", slug: "student-retention" }),
    shot: {
      src: "/marketing/product/day-dashboard.webp",
      width: 1140,
      height: 384,
      corner: 22,
      alt: "The dashboard's Classes Today panel: three sessions, each with how many students have checked in.",
    },
  },
  {
    time: "3:45 PM",
    title: "A trial family walks in",
    description:
      "Add the lead, note the visit and set a follow-up date. Due and overdue follow-ups wait in one queue.",
    detail: landingDetail({ kind: "useCase", slug: "trial-to-enrollment" }),
    shot: {
      src: "/marketing/product/day-lead.webp",
      width: 800,
      height: 744,
      corner: 23,
      alt: "A trial lead with contact details and a follow-up due today, ready to move to Trial Scheduled.",
    },
  },
  {
    time: "4:30 PM",
    title: "A parent calls about two kids",
    description:
      "Each child keeps their own profile, program, rank and history. Guardians and payers are recorded separately.",
    detail: landingDetail({ kind: "feature", slug: "student-management" }),
    shot: {
      src: "/marketing/product/day-family.webp",
      width: 920,
      height: 504,
      corner: 23,
      alt: "A student's primary guardian, recorded on the student's own profile with name, email, phone and relation.",
    },
  },
  {
    time: "6:00 PM",
    title: "Take attendance",
    description:
      "Open today's roster and mark Present, Late or Absent. Classes attended count toward the next rank.",
    detail: landingDetail({ kind: "feature", slug: "attendance" }),
    shot: {
      src: "/marketing/product/day-attendance.webp",
      width: 1152,
      height: 880,
      corner: 36,
      alt: "A class roster: three of twenty students present, with each student checked in by a tap.",
    },
  },
  {
    time: "7:15 PM",
    title: "Plan the belt test",
    description:
      "Check class counts, time at rank and instructor approval for each student before deciding whom to test.",
    detail: landingDetail({ kind: "feature", slug: "belt-tracking" }),
    shot: {
      src: "/marketing/product/day-ranks.webp",
      width: 1080,
      height: 592,
      corner: 23,
      alt: "A rank plan: White Belt with stripes, each requiring a number of classes and months at rank.",
    },
  },
  {
    time: "8:00 PM",
    title: "The front desk closes out",
    description:
      "Payers, invoices and cash or check payments in one place. Instructors never see billing.",
    detail: landingDetail({ kind: "feature", slug: "billing" }),
    shot: {
      src: "/marketing/product/day-billing.webp",
      width: 600,
      height: 830,
      corner: 25,
      alt: "Payers with their status, current, past due or externally paid, and outstanding balances.",
    },
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
        question: "How does the free trial work?",
        answer: `New studios get ${PUBLIC_PLATFORM_TRIAL_DAYS} days of Koaryu with every feature. You add a payment method at checkout and nothing is charged until the trial ends. Cancel before then from Billing and you pay nothing.`,
      },
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
    lede: "The roster, belt ranks, attendance and trial follow-ups in one place, instead of five spreadsheets.",
    actions: [TRIAL_ACTION, DEMO_ACTION],
    note: TRIAL_NOTE,
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
    caption: "Koaryu screens, shown with sample studio data.",
    links: [
      { label: "All features", href: "/features" },
      { label: "Workflow guides", href: "/use-cases" },
    ],
  },
  {
    id: "the-weave",
    kind: "weave",
    title: "Your studio is not a spreadsheet.",
    label: "One record",
    scene: 0.685,
    ink: "dark",
    lede: "Every part of Koaryu works from the same record of each student, so the roster, the belt tracker, the follow-up queue and the billing records always agree.",
  },
  {
    id: "studio",
    kind: "studio",
    title: "Koaryu keeps count. You teach.",
    label: "The class",
    scene: 1,
    ink: "dark",
    lede: `Set up your studio in minutes, then bring your roster over from a spreadsheet. Every feature is yours free for ${PUBLIC_PLATFORM_TRIAL_DAYS} days.`,
    actions: [TRIAL_ACTION, DEMO_ACTION],
    caption: "Illustration with sample students.",
    handoffLabel: "Get started",
  },
] as const satisfies readonly StoryChapter[];

const pricing: PricingSection = {
  id: "pricing",
  title: "One price. Every student.",
  lede: "Every feature for every student on your roster, in one studio subscription.",
  trial: `Free for ${PUBLIC_PLATFORM_TRIAL_DAYS} days, then billed monthly. Cancel any time.`,
  amount: publicPlatformPriceAmount(),
  displayPrice: formatPublicPlatformPrice(),
  period: "per studio, per month",
  plan: { name: "Koaryu Core", scope: "One studio, every program" },
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
  setupAction: TRIAL_ACTION,
  paymentsNote: {
    lead: "Collecting tuition online?",
    label: "See Pricing & payments",
    href: "#faq-pricing",
  },
  start: {
    title: "From sign-up to your first class",
    steps: [
      { title: "Create your account", text: "With email, Google or Microsoft." },
      { title: "Name your studio", text: "Its name and timezone. That's the whole setup form." },
      {
        title: "Start your trial",
        text: `Add a payment method at checkout. Nothing is charged for ${PUBLIC_PLATFORM_TRIAL_DAYS} days.`,
      },
      { title: "Bring your roster", text: "Import your spreadsheet, then set up your belts." },
    ],
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
  action: DEMO_ACTION,
  secondaryAction: TRIAL_ACTION,
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
  lede: "Straight answers about switching, pricing and the day to day.",
  groups: faqGroups,
};

const close: CloseSection = {
  id: "begin",
  title: "Enough admin. Go teach.",
  lede: TRIAL_NOTE,
  action: TRIAL_ACTION,
  footerLinks: [
    { label: "Features", href: "/features" },
    { label: "Workflows", href: "/use-cases" },
    { label: "Pricing", href: "#pricing" },
    { label: "Demo", href: "/try" },
    { label: "Sign in", href: "/login" },
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
