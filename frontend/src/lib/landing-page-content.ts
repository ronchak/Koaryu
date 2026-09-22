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
  examples: readonly { condition: string; action: string }[];
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
    title: "Student records",
    description:
      "Keep programs, ranks, guardian contacts and notes in each student's profile. Staff access depends on their role.",
    detail: landingDetail({ kind: "feature", slug: "student-management" }),
  },
  {
    title: "Rank requirements",
    description:
      "Set class-count, time-at-rank and approval requirements. Review the evidence before recording a promotion.",
    detail: landingDetail({ kind: "feature", slug: "belt-tracking" }),
  },
  {
    title: "Classes & attendance",
    description:
      "Open a dated class roster, mark attendance and correct individual entries when needed.",
    detail: landingDetail({ kind: "feature", slug: "attendance" }),
  },
  {
    title: "Billing & availability",
    description:
      "Review payer and invoice records. Tuition collection requires separate activation and is not generally available.",
    detail: landingDetail({ kind: "feature", slug: "billing" }),
  },
];

const useCaseRows: readonly LandingSummaryRow[] = [
  {
    title: "Import a roster",
    description:
      "Map your CSV columns to student fields, resolve program and belt matches, then review validation results.",
    detail: landingDetail({ kind: "useCase", slug: "spreadsheets-to-studio-crm" }),
  },
  {
    title: "Review absences",
    description:
      "Check attendance and student notes before contacting a family about a training gap.",
    detail: landingDetail({ kind: "useCase", slug: "student-retention" }),
  },
  {
    title: "Follow up on trials",
    description:
      "Track inquiry stages and follow-up dates. Contact the family yourself, then record the outcome.",
    detail: landingDetail({ kind: "useCase", slug: "trial-to-enrollment" }),
  },
  {
    title: "Check tuition",
    description:
      "Separate missing payer details, overdue invoices and payments received outside Stripe.",
    detail: landingDetail({ kind: "useCase", slug: "tuition-cleanup" }),
  },
  {
    title: "Prepare a belt test",
    description:
      "Check requirements, attendance and promotion history before deciding whom to test.",
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
          "Independent martial arts schools with a small staff. It covers student records, programs, rank ladders, attendance and lead follow-up.",
      },
      {
        question: "Can I use my own belt system?",
        answer:
          "Yes. Create ordered ranks for each program, with class-count, time-at-rank and instructor-approval requirements. Staff review eligibility and record each promotion.",
      },
      {
        question: "Does it manage multiple locations?",
        answer:
          "Koaryu is designed around one studio workspace. It does not provide a franchise-wide or multi-location management dashboard.",
      },
    ],
  },
  {
    title: "Switching",
    items: [
      {
        question: "What can I import?",
        answer:
          "Student CSV import maps names, contacts, programs and current belts. It does not reconstruct past attendance, promotion history or billing records.",
      },
      {
        question: "What happens to invalid rows?",
        answer:
          "Validation identifies rows needing correction. Valid rows can import while invalid rows are skipped. Review the result before retrying; import does not deduplicate existing students.",
      },
      {
        question: "Where should I start setup?",
        answer:
          "Create an account, configure programs and ranks, then add or import students. Set up recurring classes and their rosters before taking attendance.",
      },
    ],
  },
  {
    title: "Daily use",
    items: [
      {
        question: "Can instructors take attendance?",
        answer:
          "Yes. Instructors can open a dated session roster, mark students Present, Late or Absent and correct entries. Each change saves separately; check for save errors.",
      },
      {
        question: "How does attendance affect ranks?",
        answer:
          "Recorded non-absent entries can count toward configured class requirements. Time at rank and any required instructor approval are checked separately. Staff decide whether to promote.",
      },
      {
        question: "What happens after a trial?",
        answer:
          "Staff update the lead's stage, schedule follow-up and contact the family themselves. Mark contacted clears the follow-up date. Conversion creates a student record.",
      },
      {
        question: "Does Koaryu send reminders?",
        answer:
          "No automated email or SMS follow-up is available. Staff use the due and overdue follow-up queue, contact families through their usual channel and update the lead.",
      },
    ],
  },
  {
    title: "Pricing & payments",
    items: [
      {
        question: `What does ${formatPublicPlatformPrice()}/month include?`,
        answer:
          "One studio's student records, ranks, leads, scheduling, attendance, reports and billing records. No per-student tiers. Tuition collection requires separate activation; automations are planned.",
      },
      {
        question: "What payment fees apply?",
        answer: `Koaryu Payments adds ${PUBLIC_PAYMENTS_FEE_PERCENT}% per successful charge, plus Stripe fees. These are separate from the studio subscription. Collection is not generally available.`,
      },
      {
        question: "Can I use my existing payment method?",
        answer:
          "Yes. Admin and Front Desk staff can record payments received outside Koaryu. These payer-level records do not settle a Stripe invoice or charge a family.",
      },
      {
        question: "Where do I manage my subscription?",
        answer:
          "Admins with an existing Koaryu subscription can open Billing, find Koaryu Core, then choose Customer portal.",
      },
    ],
  },
  {
    title: "Data & access",
    items: [
      {
        question: "Can I export or delete records?",
        answer:
          "Admins can export operational records from Reports and use confirmed data-cleanup tools. New billing exports are unavailable. The Privacy Policy explains exports, deletion and retained access records.",
      },
      {
        question: "Can staff see billing records?",
        answer:
          "Admin and Front Desk staff can review billing records. Instructors can use student and attendance records, but cannot access billing. Admins manage staff roles.",
      },
      {
        question: "How are siblings and guardians recorded?",
        answer:
          "Each child keeps a separate student profile, program, rank and attendance history. Guardian contacts and billing payers are separate records; a guardian is not automatically the payer.",
      },
      {
        question: "Is my studio's data separate?",
        answer:
          "Access is checked against studio membership and staff role. The Privacy Policy describes the records Koaryu stores, how they are used and where to request help.",
      },
    ],
  },
  {
    title: "Support & availability",
    items: [
      {
        question: "Is there a mobile app?",
        answer:
          "Koaryu runs in a web browser on phones, tablets and computers. There is no separate native mobile app.",
      },
      {
        question: "What payment actions are available?",
        answer:
          "Staff can review existing invoices, refresh Stripe status and record external payments. Tuition collection needs separate activation and is not generally available. New billing exports are unavailable.",
      },
      {
        question: "How do I get support?",
        answer:
          "After signing in, open your account menu, then Help, Help center and Contact support. Submit the form to get a ticket reference in the app.",
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
      lede: `Manage students, attendance, ranks and lead follow-up. ${formatPublicPlatformPrice()} per studio per month.`,
      actions: [
        { label: "Create an account", href: "/signup" },
        { label: "See a studio morning", href: "#studio-view" },
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
      aside: "Class is starting. Which record is up to date?",
    },
    {
      id: "studio-view",
      title: "Review the day before class.",
      scene: 0.235,
      kind: "morning",
      ink: "dark",
      kicker: "Before the first class",
      lede: "The dashboard surfaces attendance gaps, due follow-ups and today's sessions for staff to review.",
      proofLabel: "Illustrative studio morning",
      proof:
        "Six students have a 14-day attendance gap: review their records. Nine leads have follow-ups due: contact them. Eight classes today: open the session rosters.",
      examples: [
        { condition: "6 attendance gaps of 14+ days", action: "Review attendance and notes." },
        { condition: "9 lead follow-ups due", action: "Contact leads; update follow-up." },
        { condition: "8 classes today", action: "Open the session rosters." },
      ],
    },
    {
      id: "product",
      title: "After you mark attendance.",
      scene: 0.288,
      kind: "product-intro",
      ink: "light",
      framed: true,
      kicker: "A recorded class",
      lede: "Mark a student Present. The saved entry appears in their attendance history and can count toward the next rank's class requirement. An instructor still decides whether to promote.",
    },
    {
      id: "features",
      title: "Features",
      scene: 0.52,
      kind: "features",
      ink: "dark",
      kicker: "Features",
      heading: "What you can manage",
      lede: "Student records connect programs, ranks and attendance. Billing access is limited to Admin and Front Desk staff.",
      rows: featureRows,
      link: { label: "Product overview", href: "/features" },
    },
    {
      id: "use-cases",
      title: "Use Cases",
      scene: 0.64,
      kind: "use-cases",
      ink: "dark",
      kicker: "Use Cases",
      heading: "Work between classes",
      rows: useCaseRows,
      link: { label: "Compare workflows", href: "/use-cases" },
    },
    {
      id: "signals-gather",
      title: "Check the reason for an absence.",
      scene: 0.802,
      kind: "transition",
      ink: "dark",
      kicker: "Illustrative attendance review",
      lede: "Maya has a 14-day attendance gap. Her notes mention a family trip. Check the return date before contacting her guardian; an attendance gap alone does not explain the absence.",
    },
    {
      id: "explore",
      title: "Explore",
      scene: 0.892,
      kind: "explore",
      ink: "dark",
      kicker: "Explore Koaryu",
      heading: "Choose a guide",
      routes: [
        {
          title: "Product overview",
          body: "Compare product capabilities and current limits.",
          meta: "Features",
          href: "/features",
        },
        {
          title: "Workflow guides",
          body: "Instructions for importing, follow-up, tuition review and belt tests.",
          meta: "Five studio workflows",
          href: "/use-cases",
        },
        {
          title: "Family records",
          body: "See how students, guardians and payers differ.",
          meta: "Students, guardians and payers",
          href: "/features/student-management#families",
        },
      ],
      link: { label: "Product fit and limits", href: "/features#fit" },
    },
    {
      id: "class-ready",
      title: "Hand off to the right staff.",
      scene: 0.952,
      kind: "transition",
      ink: "dark",
      placement: "upper",
      kicker: "Staff access",
      lede: "Instructors use student profiles, attendance and rank history. Admin and Front Desk staff can also review payer and invoice records. Instructors cannot access billing.",
    },
    {
      id: "pricing",
      title: "Pricing",
      scene: 1,
      kind: "pricing",
      ink: "dark",
      kicker: "Pricing",
      heading: "One studio subscription",
      amount: publicPlatformPriceAmount(),
      displayPrice: formatPublicPlatformPrice(),
      period: "per studio per month",
      facts: [
        {
          label: "Included",
          description:
            "Students, ranks, leads, attendance, reports and billing records. Automations are planned.",
        },
        {
          label: "Payments",
          description: `Koaryu Payments: ${PUBLIC_PAYMENTS_FEE_PERCENT}% per successful charge, plus Stripe fees. Collection requires separate activation and is not generally available.`,
        },
        {
          label: "Student count",
          description: "No per-student tiers.",
        },
      ],
      setupAction: { label: "Create an account", href: "/signup" },
    },
    {
      id: "about",
      title: "About",
      scene: 1,
      kind: "about",
      ink: "dark",
      kicker: "About Koaryu",
      heading: "For independent schools",
      lede: "A single studio workspace for a small staff, with separate Admin, Instructor and Front Desk roles. Multi-location management is outside its scope.",
      principles: [
        {
          title: "One studio",
          description: "Programs and recurring classes share one studio workspace.",
        },
        {
          title: "Different staff roles",
          description: "Instructors can use student records without access to billing.",
        },
        {
          title: "Staff make the decisions",
          description:
            "Contact families and review rank evidence yourself. Automated outreach is unavailable.",
        },
      ],
      link: { label: "Product fit and limits", href: "/features#fit" },
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
      action: { label: "Create an account", href: "/signup" },
      footerLinks: [
        { label: "Features", href: "/features" },
        { label: "Workflows", href: "/use-cases" },
        { label: "Terms of Service", href: "/terms" },
        { label: "Privacy Policy", href: "/privacy" },
      ],
      copyright: "© 2026 Koaryu",
    },
  ],
} as const satisfies { chapters: readonly JourneyChapter[] };
