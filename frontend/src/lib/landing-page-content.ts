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

export type BeltRank = "white" | "yellow" | "orange" | "green";

/** A student in the hands-on class demo. Counts are before tonight's class. */
export interface DemoStudent {
  id: string;
  name: string;
  belt: BeltRank;
  nextBelt: BeltRank;
  /** Classes attended toward the next rank before this class. */
  attended: number;
  required: number;
  daysAtRank: number;
  daysRequired: number;
  /** Whether the next rank also needs an instructor's sign-off once the counts are met. */
  needsApproval: boolean;
  guardian: string;
  /** The last few classes, oldest first. */
  history: readonly ("present" | "late" | "absent")[];
}

export type DemoLeadStage =
  "inquiry" | "trial_scheduled" | "trial_completed" | "offer_sent" | "enrolled";

export type DemoLeadSource = "walk_in" | "referral" | "social" | "search" | "website" | "other";

/** A lead in the demo's follow-up queue. `dueIn` is days from today; negative is overdue. */
export interface DemoLead {
  id: string;
  name: string;
  stage: DemoLeadStage;
  program: string;
  source: DemoLeadSource;
  dueIn: number;
  owner: string | null;
  minor: boolean;
}

export interface DemoTask {
  id: "mark" | "ready" | "lead";
  label: string;
  detail: string;
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
 * The landing page, beat by beat: the headline over the evening hills, a working
 * miniature of Koaryu to try on tonight's class, the real app at full size, a day
 * at the studio, the price, questions, and the class seated at the end.
 */
export const landingPageContent = {
  hero: {
    id: "welcome",
    headline: ["Run the school.", "Teach the art."],
    lede: `Students, ranks, attendance and trial follow-ups in one calm place. ${formatPublicPlatformPrice()} per studio per month.`,
    actions: [
      { label: "Create an account", href: "/signup" },
      { label: "See pricing", href: "#pricing" },
    ],
  },
  studio: {
    id: "studio",
    title: "Try it on tonight's class.",
    lede: "A working miniature of Koaryu. Tap around; nothing you change is saved.",
    tasks: [
      {
        id: "mark",
        label: "Take attendance",
        detail: "Tap a student to cycle Present, Late and Absent.",
      },
      {
        id: "ready",
        label: "Finish Maya's requirement",
        detail: "She is one class short of Yellow Belt.",
      },
      {
        id: "lead",
        label: "Add a trial lead",
        detail: "Then work the follow-up queue.",
      },
    ],
    studioName: "Riverside Karate",
    session: {
      name: "Kids Karate",
      day: "Tuesday",
      time: "6:00 – 6:45 PM",
    },
    programs: ["Kids Karate", "Teen & Adult Karate"],
    students: [
      {
        id: "zara",
        name: "Zara Ali",
        belt: "white",
        nextBelt: "yellow",
        attended: 3,
        required: 8,
        daysAtRank: 41,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Samira Ali",
        history: ["present", "absent", "present", "late", "present"],
      },
      {
        id: "noah",
        name: "Noah Bennett",
        belt: "yellow",
        nextBelt: "orange",
        attended: 5,
        required: 10,
        daysAtRank: 72,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Claire Bennett",
        history: ["present", "present", "absent", "present", "present"],
      },
      {
        id: "hana",
        name: "Hana Mori",
        belt: "orange",
        nextBelt: "green",
        attended: 9,
        required: 12,
        daysAtRank: 88,
        daysRequired: 90,
        needsApproval: true,
        guardian: "Kenji Mori",
        history: ["present", "present", "present", "late", "present"],
      },
      {
        id: "liam",
        name: "Liam Johnson",
        belt: "white",
        nextBelt: "yellow",
        attended: 6,
        required: 8,
        daysAtRank: 55,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Dana Johnson",
        history: ["absent", "present", "present", "present", "absent"],
      },
      {
        id: "maya",
        name: "Maya Chen",
        belt: "white",
        nextBelt: "yellow",
        attended: 7,
        required: 8,
        daysAtRank: 64,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Wei Chen",
        history: ["present", "present", "late", "present", "present"],
      },
      {
        id: "omar",
        name: "Omar Haddad",
        belt: "yellow",
        nextBelt: "orange",
        attended: 8,
        required: 10,
        daysAtRank: 96,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Lina Haddad",
        history: ["present", "late", "present", "present", "present"],
      },
    ],
    ready: {
      student: "maya",
      message: "Maya Chen is ready to test for Yellow Belt.",
      decision: "Requirements met. Whether she tests is the instructor's call.",
    },
    leads: [
      {
        id: "sarah",
        name: "Sarah Kim",
        stage: "offer_sent",
        program: "Kids Karate",
        source: "walk_in",
        dueIn: -2,
        owner: null,
        minor: true,
      },
      {
        id: "david",
        name: "David Chen",
        stage: "inquiry",
        program: "Teen & Adult Karate",
        source: "website",
        dueIn: -1,
        owner: "Ana Reyes",
        minor: false,
      },
      {
        id: "maria",
        name: "Maria Gonzalez",
        stage: "trial_scheduled",
        program: "Kids Karate",
        source: "referral",
        dueIn: 0,
        owner: null,
        minor: true,
      },
      {
        id: "tyler",
        name: "Tyler Brooks",
        stage: "trial_completed",
        program: "Teen & Adult Karate",
        source: "social",
        dueIn: 2,
        owner: "Ana Reyes",
        minor: false,
      },
    ],
    newLead: { name: "Jordan Rivera", program: "Kids Karate", source: "walk_in", dueIn: 1 },
    caption: "Interactive demo with sample students and leads.",
  },
  product: {
    id: "product",
    title: "Now, the real thing.",
    lede: "That was a miniature. This is Koaryu's belt tracker at full size: requirements you define for each program, and who meets every one, rank by rank. It runs in the browser, so the same screen fits a phone.",
    image: {
      src: "/marketing/product/belt-tracker.webp",
      width: 2400,
      height: 1500,
      alt: "Koaryu belt tracker listing students by current rank, with classes attended and time at rank toward the next belt.",
      mobile: { src: "/marketing/product/belt-tracker-mobile.webp", width: 780, height: 1520 },
    },
    caption: "Belt tracker, shown with sample studio data.",
  },
  day: {
    id: "features",
    title: "Everything between classes.",
    lede: "A day at the studio, from the first coffee to the last lock-up.",
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
    included: [
      "Students & families",
      "Ranks & belt tests",
      "Attendance",
      "Trials & leads",
      "Scheduling",
      "Reports",
      "Billing records",
    ],
    note: "No per-student tiers. Grow your roster without growing your bill.",
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
    headline: readonly [string, string];
    lede: string;
    actions: readonly [LandingAction, LandingAction];
  };
  studio: {
    id: string;
    title: string;
    lede: string;
    tasks: readonly DemoTask[];
    studioName: string;
    session: { name: string; day: string; time: string };
    programs: readonly string[];
    students: readonly DemoStudent[];
    ready: { student: string; message: string; decision: string };
    leads: readonly DemoLead[];
    newLead: { name: string; program: string; source: DemoLeadSource; dueIn: number };
    caption: string;
  };
  product: {
    id: string;
    title: string;
    lede: string;
    image: {
      src: string;
      width: number;
      height: number;
      alt: string;
      mobile: { src: string; width: number; height: number };
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
    included: readonly string[];
    note: string;
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
