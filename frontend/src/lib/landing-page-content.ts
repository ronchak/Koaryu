import {
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
} from "./constants.ts";
import {
  getMarketingPageByRef,
  type MarketingPageKind,
  type MarketingPageRef,
} from "./marketing-pages.ts";

export type JourneyChapterId =
  | "welcome"
  | "the-problem"
  | "studio-view"
  | "product"
  | "features"
  | "use-cases"
  | "signals-gather"
  | "explore"
  | "class-ready"
  | "pricing"
  | "about"
  | "faq"
  | "stillness"
  | "begin";

export type JourneyInk = "dark" | "light";

export type JourneyChapterKind =
  | "hero"
  | "problem"
  | "morning"
  | "product-intro"
  | "features"
  | "use-cases"
  | "transition"
  | "explore"
  | "pricing"
  | "about"
  | "faq"
  | "final";

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
  scene: number;
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

export interface JourneyMorningChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "morning";
  kicker: string;
  lede: string;
  proofLabel: string;
  proof: string;
}

export interface JourneyProductIntroChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "product-intro";
  framed: true;
  kicker: string;
  lede: string;
}

export interface JourneyFeaturesChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "features";
  kicker: string;
  heading: string;
  lede: string;
  rows: readonly LandingSummaryRow[];
  link: JourneyAction;
}

export interface JourneyUseCasesChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "use-cases";
  kicker: string;
  heading: string;
  rows: readonly LandingSummaryRow[];
  link: JourneyAction;
}

export interface JourneyTransitionChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "transition";
  kicker: string;
  lede?: string;
  placement?: "upper";
}

export interface ExploreRoute {
  title: string;
  body: string;
  meta: string;
  href: string;
}

export interface JourneyExploreChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "explore";
  kicker: string;
  heading: string;
  routes: readonly ExploreRoute[];
  link: JourneyAction;
}

export interface PricingFact {
  label: string;
  description: string;
}

export interface JourneyPricingChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "pricing";
  kicker: string;
  heading: string;
  amount: string;
  displayPrice: string;
  period: string;
  facts: readonly PricingFact[];
  setupAction: JourneyAction;
}

export interface AboutPrinciple {
  title: string;
  description: string;
}

export interface JourneyAboutChapter extends Omit<JourneyBaseChapter, "kind"> {
  kind: "about";
  kicker: string;
  heading: string;
  lede: string;
  principles: readonly AboutPrinciple[];
  link: JourneyAction;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqGroup {
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
  framed: true;
  kicker: string;
  lede: string;
  action: JourneyAction;
  footerLinks: readonly JourneyAction[];
  copyright: string;
}

export type JourneyChapter =
  | JourneyHeroChapter
  | JourneyProblemChapter
  | JourneyMorningChapter
  | JourneyProductIntroChapter
  | JourneyFeaturesChapter
  | JourneyUseCasesChapter
  | JourneyTransitionChapter
  | JourneyExploreChapter
  | JourneyPricingChapter
  | JourneyAboutChapter
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
    title: "Student CRM",
    description:
      "Guardians, programs, notes, rank history, and billing follow the student. Exactly where you would look for them.",
    detail: landingDetail({ kind: "feature", slug: "student-management" }),
  },
  {
    title: "Rank Progression",
    description:
      "See the history behind the shortlist. The instructor still makes the call.",
    detail: landingDetail({ kind: "feature", slug: "belt-tracking" }),
  },
  {
    title: "Schedule & Attendance",
    description:
      "Take attendance fast. Missed classes stop disappearing into a log.",
    detail: landingDetail({ kind: "feature", slug: "attendance" }),
  },
  {
    title: "Billing",
    description:
      "Stripe Connect, family payers, invoices, and failed payments stay tied to the right account.",
    detail: landingDetail({ kind: "feature", slug: "billing" }),
  },
];

const useCaseRows: readonly LandingSummaryRow[] = [
  {
    title: "Switching from spreadsheets",
    description: "Bring over the roster now. Untangle the weird columns later.",
    detail: landingDetail({
      kind: "useCase",
      slug: "spreadsheets-to-studio-crm",
    }),
  },
  {
    title: "Retention workflow",
    description:
      "A student misses enough classes to matter. Koaryu puts them on the list before they quietly disappear.",
    detail: landingDetail({ kind: "useCase", slug: "student-retention" }),
  },
  {
    title: "Trial conversion",
    description:
      "Inquiry, trial, notes, and follow-up stay together. Nobody has to remember which tab got the lead.",
    detail: landingDetail({ kind: "useCase", slug: "trial-to-enrollment" }),
  },
  {
    title: "Tuition cleanup",
    description:
      "See missing payer details and overdue invoices before month-end gets awkward.",
    detail: landingDetail({ kind: "useCase", slug: "tuition-cleanup" }),
  },
  {
    title: "Test readiness",
    description:
      "Get a shortlist with the reasons attached. The instructor still decides.",
    detail: landingDetail({ kind: "useCase", slug: "belt-test-readiness" }),
  },
];

const faqGroups: readonly FaqGroup[] = [
  {
    title: "Fit",
    items: [
      {
        question: "Who is Koaryu built for?",
        answer:
          "Owner-operated martial arts schools with recurring memberships, rank progression, and a small staff.",
      },
      {
        question: "Is this a generic gym CRM?",
        answer:
          "No. Programs, ranks, guardians, trials, attendance, and promotions are built in. You do not have to fake them with custom fields.",
      },
      {
        question: "Which martial arts styles does it support?",
        answer:
          "Karate, taekwondo, jiu-jitsu, kickboxing, mixed programs, and family schools. Any structured program with progression fits.",
      },
      {
        question: "Is this for single-location schools?",
        answer:
          "Yes. Independent, one-location schools are the focus. Multi-location and franchise workflows are not the first priority.",
      },
    ],
  },
  {
    title: "Switching",
    items: [
      {
        question: "Is CSV import available?",
        answer: "CSV import is planned for students, leads, and belt ranks.",
      },
      {
        question: "What if my existing data is messy?",
        answer:
          "Messy data is normal. Bring over the useful parts and clean up the rest as you go.",
      },
      {
        question: "How long should setup take?",
        answer:
          "It depends on the roster and how much cleanup it needs. Start with programs, students, ranks, and attendance. The rest can follow.",
      },
      {
        question: "What does Koaryu replace?",
        answer:
          "The roster spreadsheet, lead tracker, attendance sheet, belt list, payment notes, and reminder pile.",
      },
    ],
  },
  {
    title: "Daily Use",
    items: [
      {
        question: "Can instructors use it during class?",
        answer:
          "That is the target. Rosters and attendance are meant to be quick from a laptop, tablet, or phone between classes.",
      },
      {
        question: "Does attendance affect belt readiness?",
        answer:
          "Yes. Attendance can inform promotion readiness, inactivity alerts, and the student's history instead of dying in a separate log.",
      },
      {
        question: "Can I track multiple programs?",
        answer:
          "Yes. Keep kids, teens, adults, beginner tracks, and different disciplines separate without splitting the school into different systems.",
      },
      {
        question: "Are configurable belt ladders planned?",
        answer:
          "Yes. The plan covers ordered ranks, class thresholds, time-at-rank rules, and instructor approval.",
      },
      {
        question: "Does Koaryu handle leads and trials?",
        answer:
          "Yes. Source, notes, follow-up dates, and conversion history stay with the lead from inquiry through enrollment.",
      },
    ],
  },
  {
    title: "Pricing & Payments",
    items: [
      {
        question: `What does the ${formatPublicPlatformPrice()} include?`,
        answer:
          `Students, ranks, leads, attendance, billing, reports, and automations. One studio is ${formatPublicPlatformPrice()} a month.`,
      },
      {
        question: "Do I pay more when the school grows?",
        answer:
          "No. There are no per-student software tiers, so adding students does not raise the Koaryu subscription.",
      },
      {
        question: "Are Stripe fees included?",
        answer:
          "No. Stripe charges its payment-processing fees separately from the Koaryu subscription.",
      },
      {
        question: "Do I have to use Koaryu for payments?",
        answer:
          "Koaryu works best with Stripe-connected billing. You can still use the rest of the platform before activating payments.",
      },
      {
        question: "Can I cancel?",
        answer: "Koaryu is month to month.",
      },
    ],
  },
  {
    title: "Data & Access",
    items: [
      {
        question: "Who owns the studio data?",
        answer:
          "The studio does. Records stay scoped to the school that owns them.",
      },
      {
        question: "Can staff have different permissions?",
        answer:
          "Yes. Admin, instructor, and front-desk roles keep financial settings and sensitive exports away from people who do not need them.",
      },
      {
        question: "What about minors and guardian contacts?",
        answer:
          "Student profiles account for youth programs with guardian contacts, emergency details, and staff permission boundaries.",
      },
      {
        question: "Is studio data separated between customers?",
        answer:
          "Yes. Records are scoped and isolated by studio. One school should never see another school's data.",
      },
    ],
  },
  {
    title: "Roadmap",
    items: [
      {
        question: "Will there be a mobile app?",
        answer:
          "Koaryu is web-first. Fast rosters, attendance, and student lookup on phones and tablets come before a separate native app.",
      },
      {
        question: "Will it support SMS?",
        answer:
          "Maybe. SMS brings cost, compliance, and delivery headaches with it. Email automations come first.",
      },
      {
        question: "Is this AI-powered?",
        answer:
          "No. Koaryu is built around records, schedules, attendance, billing, rules, and reports that behave the same way twice.",
      },
      {
        question: "What support should I expect?",
        answer:
          "The product should be self-serve. Setup guidance, migration help, and direct support still matter for early studios making the switch.",
      },
    ],
  },
];

export const landingPageContent = {
  chapters: [
    {
      id: "welcome",
      title: "Run the school. Teach the art.",
      scene: 0.025,
      kind: "hero",
      ink: "dark",
      kicker: "For independent martial arts studios",
      headline: ["Run the school.", "Teach the art."],
      lede: `Koaryu keeps the daily mess in one place, from first trial to next belt test. It's ${formatPublicPlatformPrice()} a month for the whole studio, even when the kids class gets suspiciously popular.`,
      actions: [
        { label: "Create your studio", href: "/signup" },
        { label: "See how it works", href: "#studio-view" },
      ],
    },
    {
      id: "the-problem",
      title: "Your studio is not a spreadsheet.",
      scene: 0.1,
      kind: "problem",
      ink: "light",
      question:
        "So why are the roster, belt ranks, trials, and payment notes still spread across five of them?",
      aside: "Very convenient! Right up until class starts...",
    },
    {
      id: "studio-view",
      title: "Your morning is already sorted.",
      scene: 0.235,
      kind: "morning",
      ink: "dark",
      kicker: "Before the first class",
      lede: "The people who need attention rise to the top. The rest can wait.",
      proofLabel: "This morning",
      proof:
        "Six students haven't trained in 14 days. Nine leads need a reply. Eight classes across four programs are ready to go.",
    },
    {
      id: "product",
      title: "One update should do the rest of its job.",
      scene: 0.288,
      kind: "product-intro",
      ink: "light",
      framed: true,
      kicker: "One operating loop",
      lede:
        "Take attendance once. Missed classes reach the follow-up list, and the student history is already there when promotion time comes.",
    },
    {
      id: "features",
      title: "Features",
      scene: 0.52,
      kind: "features",
      ink: "dark",
      kicker: "Features",
      heading: "One student record. Imagine that.",
      lede:
        "Update a student once. The front desk and instructors see the same thing.",
      rows: featureRows,
      link: { label: "See all features", href: "/features" },
    },
    {
      id: "use-cases",
      title: "Use Cases",
      scene: 0.64,
      kind: "use-cases",
      ink: "dark",
      kicker: "Use Cases",
      heading: "The stuff that became your job is Koaryu’s now.",
      rows: useCaseRows,
      link: { label: "All five workflows", href: "/use-cases" },
    },
    {
      id: "signals-gather",
      title: "Attendance should do more than sit there.",
      scene: 0.802,
      kind: "transition",
      ink: "dark",
      kicker: "Attendance with a point",
      lede:
        "Missed classes become follow-up work. A steady streak stays with the student when promotion time comes.",
    },
    {
      id: "explore",
      title: "Explore",
      scene: 0.892,
      kind: "explore",
      ink: "dark",
      kicker: "Explore Koaryu",
      heading: "Start with the headache you already have.",
      routes: [
        {
          title: "Show me what it does",
          body: "Start with the features and see how the pieces connect.",
          meta: "Features",
          href: "/features",
        },
        {
          title: "I have a specific mess",
          body: "Trials, retention, tuition, testing, or the spreadsheet situation.",
          meta: "Five studio workflows",
          href: "/use-cases",
        },
        {
          title: "I run a family-focused school",
          body:
            "See the same system built around kids, guardians, trials, and tuition.",
          meta: "Family martial arts schools",
          href: "/studio-types/family-martial-arts-schools",
        },
      ],
      link: { label: "Open the full guide", href: "/explore" },
    },
    {
      id: "class-ready",
      title: "Now the roster knows what happened in class.",
      scene: 0.952,
      kind: "transition",
      ink: "dark",
      placement: "upper",
      kicker: "One shared history",
      lede:
        "The front desk and instructors are looking at the same student history.",
    },
    {
      id: "pricing",
      title: "Pricing",
      scene: 1,
      kind: "pricing",
      ink: "dark",
      kicker: "Pricing",
      heading: "Fill the mats. The price stays put.",
      amount: publicPlatformPriceAmount(),
      displayPrice: formatPublicPlatformPrice(),
      period: "per studio per month",
      facts: [
        {
          label: "Included",
          description:
            "Students, ranks, leads, scheduling, attendance, billing workflows, reports, and automations.",
        },
        {
          label: "Stripe fees",
          description:
            "Payment-processing fees are billed separately by Stripe.",
        },
        {
          label: "Student count",
          description:
            "No per-student software tiers. The Koaryu price does not climb with your roster.",
        },
      ],
      setupAction: { label: "Create your studio", href: "/signup" },
    },
    {
      id: "about",
      title: "About",
      scene: 1,
      kind: "about",
      ink: "dark",
      kicker: "About Koaryu",
      heading: "Built for the school you actually run.",
      lede:
        "Koaryu starts with one-location, owner-operated studios. If the org chart is three people and a group chat, enterprise gym software is a very weird fit.",
      principles: [
        {
          title: "Independent schools first",
          description:
            "Koaryu starts with owner-operated and small-team studios.",
        },
        {
          title: "Your data stays yours",
          description: "Records stay scoped to the school that owns them.",
        },
        {
          title: "Daily action beats dashboard theater",
          description:
            "Koaryu shows what needs attention today, then gets out of the way.",
        },
      ],
      link: { label: "Why Koaryu exists", href: "/about" },
    },
    {
      id: "faq",
      title: "Questions",
      scene: 1,
      kind: "faq",
      ink: "dark",
      kicker: "Questions owners ask",
      groups: faqGroups,
    },
    {
      id: "stillness",
      title: "The room is ready.",
      scene: 1,
      kind: "transition",
      ink: "dark",
      placement: "upper",
      kicker: "Before you begin",
    },
    {
      id: "begin",
      title: "Enough admin. Go teach.",
      scene: 1,
      kind: "final",
      ink: "dark",
      framed: true,
      kicker: "Koaryu",
      lede: `${formatPublicPlatformPrice()} per studio, per month.`,
      action: { label: "Create your studio", href: "/signup" },
      footerLinks: [
        { label: "Explore", href: "/explore" },
        { label: "Features", href: "/features" },
        { label: "Use Cases", href: "/use-cases" },
        { label: "About", href: "/about" },
        { label: "Terms of Service", href: "/terms" },
        { label: "Privacy Policy", href: "/privacy" },
      ],
      copyright: "© 2026 Koaryu",
    },
  ],
} as const satisfies { chapters: readonly JourneyChapter[] };
