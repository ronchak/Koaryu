export type MarketingPageKind = "feature" | "useCase" | "studioType";

export interface MarketingPageRef {
  kind: MarketingPageKind;
  slug: string;
}

interface MarketingPageBase {
  slug: string;
  title: string;
  eyebrow: string;
  metaTitle: string;
  description: string;
  summary: string;
  icon:
    | "users"
    | "award"
    | "calendar"
    | "credit-card"
    | "file-spreadsheet"
    | "heart-pulse"
    | "user-plus"
    | "clipboard-check";
  primaryAction: string;
  sections: Array<{
    title: string;
    description: string;
    bullets: string[];
  }>;
  proof: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
  related: MarketingPageRef[];
}

export interface MarketingPage extends MarketingPageBase {
  kind: MarketingPageKind;
  href: string;
}

export interface ExplorePath {
  title: string;
  description: string;
  href: string;
  eyebrow: string;
  action: string;
  pages: MarketingPageRef[];
}

export interface ExploreSection {
  title: string;
  description: string;
  paths: ExplorePath[];
}

type MarketingPageDraft = MarketingPageBase;

const pageBasePath: Record<MarketingPageKind, string> = {
  feature: "/features",
  useCase: "/use-cases",
  studioType: "/studio-types",
};

export function marketingPageHref(ref: MarketingPageRef) {
  return `${pageBasePath[ref.kind]}/${ref.slug}`;
}

function withMarketingPageMeta(
  kind: MarketingPageKind,
  pages: MarketingPageDraft[]
): MarketingPage[] {
  return pages.map((page) => ({
    ...page,
    kind,
    href: marketingPageHref({ kind, slug: page.slug }),
  }));
}

const featurePageDrafts: MarketingPageDraft[] = [
  {
    slug: "student-management",
    title: "Student Management Software for Martial Arts Studios",
    eyebrow: "Student CRM",
    metaTitle: "Student Management Software for Martial Arts Studios | Koaryu",
    description:
      "Keep students, guardians, programs, notes, attendance, billing context, and rank history in one martial-arts-native CRM.",
    summary:
      "Koaryu gives studio owners a calmer roster: who trains here, who needs attention, who is trialing, who belongs to which family, and what happened last time they walked through the door.",
    icon: "users",
    primaryAction: "Build your studio roster",
    sections: [
      {
        title: "One record per student",
        description:
          "A useful studio CRM should not make instructors hunt across spreadsheets, payment exports, and notebooks before class.",
        bullets: [
          "Student status, program, rank, guardian contacts, birthday, emergency details, and internal notes",
          "Family context for siblings, payers, and household billing conversations",
          "Class and rank history attached to the same operational profile",
        ],
      },
      {
        title: "Designed for front-desk speed",
        description:
          "Owners and staff need quick answers while families are in the lobby, not a generic database that takes training to operate.",
        bullets: [
          "Fast roster search for active, trialing, inactive, and canceled students",
          "Import paths for moving away from spreadsheets without rebuilding every profile manually",
          "Role-aware access so sensitive account information stays closer to admins",
        ],
      },
      {
        title: "Turns records into action",
        description:
          "The roster is not just storage. It feeds follow-up, attendance, promotion readiness, retention, and billing attention.",
        bullets: [
          "Identify students going quiet before they disappear",
          "See promotion and attendance context from the student record",
          "Keep trial and lead conversion history connected after enrollment",
        ],
      },
    ],
    proof: [
      { label: "Roster", value: "1 place", detail: "Students, families, notes, and status" },
      { label: "Setup", value: "CSV-ready", detail: "Bring existing records forward" },
      { label: "Access", value: "Role-aware", detail: "Admin, instructor, and front desk boundaries" },
    ],
    related: [
      { kind: "feature", slug: "belt-tracking" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "billing" },
    ],
  },
  {
    slug: "belt-tracking",
    title: "Belt Tracking and Promotion Readiness",
    eyebrow: "Rank Progression",
    metaTitle: "Belt Tracking Software for Martial Arts Schools | Koaryu",
    description:
      "Track belt ranks, class counts, time at rank, instructor approvals, and promotion readiness without a side spreadsheet.",
    summary:
      "Koaryu treats rank progression as daily studio work, not a disconnected chart. Attendance, manual approvals, and ordered belt ladders all contribute to a clearer promotion queue.",
    icon: "award",
    primaryAction: "Review promotion readiness",
    sections: [
      {
        title: "Configurable rank ladders",
        description:
          "Different schools use different programs, stripes, tips, and promotion rules. Koaryu keeps that structure explicit.",
        bullets: [
          "Program-specific belt ladders for kids, teens, adults, or discipline-specific tracks",
          "Ordered ranks with requirements for class count, time at rank, and instructor approval",
          "Promotion history that follows the student record over time",
        ],
      },
      {
        title: "Readiness without guessing",
        description:
          "A good belt tracker gives instructors a shortlist they can trust before testing decisions are made.",
        bullets: [
          "See students who meet automatic requirements and those waiting on manual approval",
          "Use attendance and time-at-rank signals instead of memory",
          "Keep upcoming test conversations grounded in visible history",
        ],
      },
      {
        title: "Built for the instructor-owner",
        description:
          "Promotion work has emotional weight for families and students. The software should support judgment, not replace it.",
        bullets: [
          "Keep final decisions in human hands",
          "Show why a student appears in the promotion queue",
          "Preserve notes and history for the next instructor conversation",
        ],
      },
    ],
    proof: [
      { label: "Requirements", value: "Visible", detail: "Classes, time, and approvals" },
      { label: "Programs", value: "Flexible", detail: "Separate ladders by track" },
      { label: "History", value: "Permanent", detail: "Rank changes stay attached" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "billing" },
    ],
  },
  {
    slug: "attendance",
    title: "Attendance Tracking for Martial Arts Classes",
    eyebrow: "Schedule & Attendance",
    metaTitle: "Martial Arts Attendance Tracking Software | Koaryu",
    description:
      "Run weekly classes, check students in quickly, and turn attendance into retention, capacity, and promotion signals.",
    summary:
      "Attendance is where the studio’s daily reality becomes visible. Koaryu connects class rosters, check-ins, student history, and retention risk so attendance is useful after class ends.",
    icon: "calendar",
    primaryAction: "Run attendance from one roster",
    sections: [
      {
        title: "Weekly classes that match the studio",
        description:
          "Most independent schools run predictable weekly rhythms. Koaryu models that schedule so instructors can work from a current roster.",
        bullets: [
          "Recurring class templates by program, day, time, and capacity",
          "Today-focused views for classes that are about to happen",
          "Attendance records that feed student history and reports",
        ],
      },
      {
        title: "Retention signals from missed classes",
        description:
          "The owner does not need a bigger chart. They need to know which students have started drifting away.",
        bullets: [
          "Spot inactive students before a cancellation conversation arrives",
          "Connect missed classes to follow-up and student notes",
          "Review attendance patterns by program and belt family",
        ],
      },
      {
        title: "Promotion context that updates naturally",
        description:
          "When attendance lives beside belt progression, class counts become part of the promotion conversation automatically.",
        bullets: [
          "Class counts support rank requirements where the studio chooses to use them",
          "Instructors can see the student’s recent training history",
          "Reports become grounded in real check-ins instead of manual tally sheets",
        ],
      },
    ],
    proof: [
      { label: "Classes", value: "Weekly", detail: "Built around recurring schedules" },
      { label: "Retention", value: "Earlier", detail: "Missed-class signals surface sooner" },
      { label: "Ranks", value: "Connected", detail: "Attendance informs readiness" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "belt-tracking" },
      { kind: "feature", slug: "billing" },
    ],
  },
  {
    slug: "billing",
    title: "Martial Arts Studio Billing Visibility",
    eyebrow: "Billing",
    metaTitle: "Martial Arts Studio Billing and Tuition Software | Koaryu",
    description:
      "Review existing tuition plans, family payer context, invoices, and payment issues without presenting unsupported provider changes as complete.",
    summary:
      "Koaryu keeps existing billing state visible to Admin and Front Desk, supports external-only local records and read-based invoice reconciliation, and denies Instructor access before billing data is fetched.",
    icon: "credit-card",
    primaryAction: "Review billing status",
    sections: [
      {
        title: "Existing tuition context",
        description:
          "Independent studios need a truthful view of the billing records already associated with their students and families.",
        bullets: [
          "Read existing plans, family payer context, student billing assignments, invoices, and payments",
          "Attach an external-only local billing record without changing Stripe",
          "Keep missing or failed billing context visible to authorized staff",
        ],
      },
      {
        title: "Provider state without provider mutation",
        description:
          "Koaryu can read and reconcile an existing Stripe-linked invoice while live outbound provider changes remain disabled.",
        bullets: [
          "Reconcile an existing provider invoice through a read and update the local projection",
          "Record payer-level cash, check, Zelle, Venmo, or other external outcomes locally",
          "Plan, payer, autopay, invoice-lifecycle, refund, and Connect changes are currently unavailable",
        ],
      },
      {
        title: "Payment issues without mystery",
        description:
          "The owner’s real question is simple: who needs help, what happened, and what should staff do next?",
        bullets: [
          "Overdue and failed-payment attention queues",
          "Family context next to student records",
          "External payment notes for cash, check, Zelle, Venmo, or other processors",
        ],
      },
    ],
    proof: [
      { label: "Pricing", value: "$27", detail: "Flat Koaryu platform subscription" },
      { label: "Provider writes", value: "Disabled", detail: "Currently unavailable" },
      { label: "Tuition", value: "Visible", detail: "Existing plans, payers, invoices, and issues" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "belt-tracking" },
    ],
  },
];

const useCasePageDrafts: MarketingPageDraft[] = [
  {
    slug: "spreadsheets-to-studio-crm",
    title: "Move a Martial Arts Studio from Spreadsheets to a Real CRM",
    eyebrow: "Switching from spreadsheets",
    metaTitle: "Move from Martial Arts Spreadsheets to Studio CRM | Koaryu",
    description:
      "A practical path for replacing scattered student spreadsheets, rank lists, attendance sheets, and payment notes with one operating system.",
    summary:
      "Koaryu is built for studios that have outgrown the spreadsheet era but do not want enterprise software. Start with the roster, then add ranks, schedule, leads, and billing as the school becomes cleaner.",
    icon: "file-spreadsheet",
    primaryAction: "Import the first roster",
    sections: [
      {
        title: "Start with the records you already have",
        description:
          "A switch should not require perfect data. The first job is getting the current school into a workable system.",
        bullets: [
          "Import students and preserve imperfect notes instead of forcing a blank rebuild",
          "Clean up programs, belt ranks, and guardian details over time",
          "Use demo-ready workflows before every historical edge case is solved",
        ],
      },
      {
        title: "Replace the weekly patchwork",
        description:
          "Most spreadsheet studios are really running five systems at once: roster, attendance, leads, ranks, and billing notes.",
        bullets: [
          "One student profile becomes the source for attendance, rank, and family context",
          "Follow-up dates replace memory-based lead tracking",
          "Promotion readiness becomes visible without manual sorting",
        ],
      },
      {
        title: "Keep the owner in control",
        description:
          "The product should make migration feel calm, not like handing the school to a black box.",
        bullets: [
          "Clear setup steps and studio-scoped records",
          "Simple pricing that does not rise with every new student",
          "Operational language designed for studio owners and instructors",
        ],
      },
    ],
    proof: [
      { label: "Migration", value: "Incremental", detail: "Start with the roster" },
      { label: "Records", value: "Connected", detail: "Students, ranks, attendance, billing" },
      { label: "Control", value: "Scoped", detail: "Studio history stays tenant-bound" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "belt-tracking" },
      { kind: "feature", slug: "attendance" },
    ],
  },
  {
    slug: "student-retention",
    title: "Catch Martial Arts Students Before They Drift Away",
    eyebrow: "Retention workflow",
    metaTitle: "Martial Arts Student Retention Software | Koaryu",
    description:
      "Use attendance, follow-ups, billing attention, and promotion context to see which students need a check-in.",
    summary:
      "Retention is not one chart. It is a daily operating rhythm: notice missed classes, follow up after trials, repair tuition issues, and keep students moving toward the next meaningful milestone.",
    icon: "heart-pulse",
    primaryAction: "Review students needing attention",
    sections: [
      {
        title: "Turn attendance into follow-up",
        description:
          "A missed class is easy to ignore once. A pattern is where the owner should intervene.",
        bullets: [
          "Surface students who have crossed inactivity thresholds",
          "Connect retention notes to student and guardian context",
          "Keep today’s follow-up work visible on the dashboard",
        ],
      },
      {
        title: "Protect the trial-to-enrollment path",
        description:
          "New families need a clean handoff from inquiry to trial to enrolled student.",
        bullets: [
          "Track lead source, next follow-up, trial status, and conversion notes",
          "Keep overdue follow-ups from disappearing in email or sticky notes",
          "Carry context into the student record after enrollment",
        ],
      },
      {
        title: "Use milestones as retention moments",
        description:
          "Promotion readiness, attendance streaks, and billing repairs are all chances to keep a family engaged.",
        bullets: [
          "Review students ready for testing before families have to ask",
          "Notice payment issues before they become awkward conversations",
          "Give the owner a daily action list instead of a dashboard full of interpretation work",
        ],
      },
    ],
    proof: [
      { label: "Signals", value: "Daily", detail: "Follow-ups, classes, payments, ranks" },
      { label: "Owners", value: "Action-first", detail: "A clear queue beats passive charts" },
      { label: "Families", value: "Contextual", detail: "Guardian and billing context stays close" },
    ],
    related: [
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "billing" },
    ],
  },
  {
    slug: "trial-to-enrollment",
    title: "Turn Trial Students into Enrolled Families",
    eyebrow: "Trial conversion",
    metaTitle: "Martial Arts Trial Student Follow-Up Workflow | Koaryu",
    description:
      "Keep inquiries, trial classes, follow-up dates, guardian notes, and enrollment handoffs visible from the first conversation.",
    summary:
      "Trial families usually decide based on timing, trust, and follow-through. Koaryu helps the owner keep the next step visible so a good first class does not disappear into a forgotten note.",
    icon: "user-plus",
    primaryAction: "Track the trial handoff",
    sections: [
      {
        title: "Capture the inquiry while it is fresh",
        description:
          "The first contact should become an operating record, not a memory in someone’s inbox.",
        bullets: [
          "Record lead source, student age, guardian context, notes, and next follow-up date",
          "Keep walk-ins, web inquiries, referrals, and trial bookings in one lead queue",
          "Make the next owner or front-desk action visible before the trial happens",
        ],
      },
      {
        title: "Carry context into the first class",
        description:
          "A trial student should arrive with enough context that staff can welcome the family well.",
        bullets: [
          "Connect trial notes to program fit and class schedule",
          "Keep guardian questions and concerns close to the student record",
          "Use the same language staff will use during enrollment conversations",
        ],
      },
      {
        title: "Close the loop after class",
        description:
          "The most important follow-up is often the one after a family has already had a good experience.",
        bullets: [
          "Track which trials need a same-day or next-day follow-up",
          "Preserve conversion notes when the lead becomes an enrolled student",
          "Give the owner a clean list of families who still need a decision conversation",
        ],
      },
    ],
    proof: [
      { label: "Pipeline", value: "Visible", detail: "Inquiry, trial, enrolled" },
      { label: "Follow-up", value: "Dated", detail: "Next action stays obvious" },
      { label: "Handoff", value: "Connected", detail: "Lead context follows enrollment" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "billing" },
    ],
  },
  {
    slug: "tuition-cleanup",
    title: "Clean Up Tuition Issues Before They Become Awkward",
    eyebrow: "Tuition cleanup",
    metaTitle: "Martial Arts Tuition Cleanup Workflow | Koaryu",
    description:
      "Give authorized staff a clear view of existing tuition records, overdue invoices, failed payments, and external payment notes.",
    summary:
      "Tuition problems are easier to address when they are visible early. Koaryu keeps existing payer context, invoices, student billing records, and external payment notes in the same operating picture.",
    icon: "credit-card",
    primaryAction: "Review tuition attention",
    sections: [
      {
        title: "Find the record gaps first",
        description:
          "Authorized staff can identify which existing records need attention without changing provider setup.",
        bullets: [
          "See students missing local billing assignments or payer context",
          "Separate existing provider-linked invoices from external payment records",
          "Attach an external-only local student billing record when appropriate",
        ],
      },
      {
        title: "Make payment attention operational",
        description:
          "The owner needs to know who needs help and what to say, not stare at processor details.",
        bullets: [
          "Track overdue invoices and payment statuses alongside family context",
          "Reconcile an existing Stripe-linked invoice through a provider read",
          "Record payer-level external outcomes without claiming that Koaryu moved money",
        ],
      },
      {
        title: "Reduce awkward surprises",
        description:
          "A clean tuition queue lets the studio repair issues before the conversation becomes tense.",
        bullets: [
          "Surface problems before month-end reconciliation",
          "Keep billing visibility role-aware for admins and front-desk staff",
          "Attach tuition issues to the same operating dashboard the owner already checks",
        ],
      },
    ],
    proof: [
      { label: "Plans", value: "Mapped", detail: "Students tied to tuition" },
      { label: "Payers", value: "Clear", detail: "Family context stays close" },
      { label: "Issues", value: "Early", detail: "Attention before surprise" },
    ],
    related: [
      { kind: "feature", slug: "billing" },
      { kind: "feature", slug: "student-management" },
      { kind: "feature", slug: "attendance" },
    ],
  },
  {
    slug: "belt-test-readiness",
    title: "Prepare for Belt Tests Without Rebuilding the List by Hand",
    eyebrow: "Test readiness",
    metaTitle: "Martial Arts Belt Test Readiness Workflow | Koaryu",
    description:
      "Use attendance, time at rank, instructor approval, and student history to prepare a cleaner belt test review list.",
    summary:
      "Belt test prep should feel thoughtful, not frantic. Koaryu helps instructors see who may be ready, why they appear on the list, and where human judgment still matters.",
    icon: "clipboard-check",
    primaryAction: "Review the test list",
    sections: [
      {
        title: "Start from visible requirements",
        description:
          "A readiness list is more useful when instructors can see the signals behind it.",
        bullets: [
          "Review class counts, time at rank, rank ladder position, and manual approval needs",
          "Separate students who meet automatic requirements from students needing instructor review",
          "Keep the current belt and promotion history attached to the student record",
        ],
      },
      {
        title: "Keep instructors in the decision",
        description:
          "Testing is a teaching judgment. Koaryu should make the conversation clearer, not automatic.",
        bullets: [
          "Use readiness as a shortlist rather than a final decision engine",
          "Preserve notes for students who need more time before testing",
          "Give the owner a calmer review before families start asking",
        ],
      },
      {
        title: "Make test prep easier next time",
        description:
          "Promotion history becomes more valuable every time the studio runs the process cleanly.",
        bullets: [
          "Record rank changes and dates after testing",
          "Let attendance continue feeding future readiness conversations",
          "Use the same belt ladders across roster, reports, and student history",
        ],
      },
    ],
    proof: [
      { label: "Signals", value: "Visible", detail: "Classes, time, approvals" },
      { label: "Judgment", value: "Human", detail: "Readiness supports instructors" },
      { label: "History", value: "Reusable", detail: "Each test improves the record" },
    ],
    related: [
      { kind: "feature", slug: "belt-tracking" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "student-management" },
    ],
  },
];

const studioTypePageDrafts: MarketingPageDraft[] = [
  {
    slug: "family-martial-arts-schools",
    title: "Koaryu for Family-Focused Martial Arts Schools",
    eyebrow: "Studio type",
    metaTitle: "Martial Arts Software for Kids and Family Studios | Koaryu",
    description:
      "A practical Koaryu path for schools with kids programs, guardian context, trial families, attendance, rank progress, and tuition visibility.",
    summary:
      "Family-focused studios need clean student records, guardian context, trial follow-up, attendance, rank progress, and tuition details in one place. Koaryu is built to keep those daily decisions understandable.",
    icon: "users",
    primaryAction: "Explore the family studio path",
    sections: [
      {
        title: "Keep student and guardian context together",
        description:
          "Kids programs usually involve the student, at least one guardian, class fit, safety details, and tuition context.",
        bullets: [
          "Student profiles keep guardian contact, emergency, program, rank, and notes close",
          "Family and payer context helps staff answer lobby questions without digging",
          "Status and program filters keep trialing, active, paused, and inactive students understandable",
        ],
      },
      {
        title: "Protect the trial family follow-up",
        description:
          "A family that tries class should not disappear because the next conversation lived in someone's memory.",
        bullets: [
          "Lead records keep inquiry source, trial context, notes, and follow-up dates visible",
          "Trial-to-enrollment handoffs preserve context when a student joins",
          "The dashboard keeps due follow-ups near classes, promotions, and tuition attention",
        ],
      },
      {
        title: "Make progress visible without making promises",
        description:
          "Families care about attendance and rank progress, but promotion decisions still need instructor judgment.",
        bullets: [
          "Attendance history supports retention and readiness conversations",
          "Belt rules can surface students who may be ready for review",
          "Instructor approval remains part of the workflow where the school requires it",
        ],
      },
    ],
    proof: [
      { label: "Families", value: "Connected", detail: "Students, guardians, and payers" },
      { label: "Trials", value: "Followed up", detail: "Inquiry to enrollment context" },
      { label: "Progress", value: "Visible", detail: "Attendance and rank history stay close" },
    ],
    related: [
      { kind: "feature", slug: "student-management" },
      { kind: "useCase", slug: "trial-to-enrollment" },
      { kind: "feature", slug: "attendance" },
      { kind: "feature", slug: "billing" },
      { kind: "useCase", slug: "tuition-cleanup" },
    ],
  },
];

export const exploreSections: ExploreSection[] = [
  {
    title: "Understand the product",
    description:
      "Start here if you want to see what Koaryu actually does before comparing individual workflows.",
    paths: [
      {
        eyebrow: "Product map",
        title: "Features",
        description:
          "Student CRM, belts, attendance, and billing visibility as product areas.",
        href: "/features",
        action: "Compare features",
        pages: [
          { kind: "feature", slug: "student-management" },
          { kind: "feature", slug: "belt-tracking" },
          { kind: "feature", slug: "attendance" },
          { kind: "feature", slug: "billing" },
        ],
      },
      {
        eyebrow: "Why Koaryu exists",
        title: "About Koaryu",
        description:
          "Why Koaryu focuses on independent martial arts schools instead of generic gym software.",
        href: "/about",
        action: "Read about Koaryu",
        pages: [],
      },
    ],
  },
  {
    title: "Start with a studio problem",
    description:
      "Use cases are written around the pressure points owners already recognize from normal studio operations.",
    paths: [
      {
        eyebrow: "Operating workflows",
        title: "Use cases",
        description:
          "Spreadsheets, retention, trial conversion, tuition cleanup, and belt test readiness.",
        href: "/use-cases",
        action: "Browse use cases",
        pages: [
          { kind: "useCase", slug: "spreadsheets-to-studio-crm" },
          { kind: "useCase", slug: "student-retention" },
          { kind: "useCase", slug: "trial-to-enrollment" },
          { kind: "useCase", slug: "tuition-cleanup" },
          { kind: "useCase", slug: "belt-test-readiness" },
        ],
      },
    ],
  },
  {
    title: "See if the fit sounds like your school",
    description:
      "Studio-type paths connect the same product to a familiar operating environment without pretending every school runs the same way.",
    paths: [
      {
        eyebrow: "Kids and families",
        title: "Family-focused martial arts schools",
        description:
          "A path for kids programs, guardian context, trial families, attendance, rank progress, and tuition visibility.",
        href: "/studio-types/family-martial-arts-schools",
        action: "Open the studio path",
        pages: [{ kind: "studioType", slug: "family-martial-arts-schools" }],
      },
    ],
  },
];

export const featurePages = withMarketingPageMeta("feature", featurePageDrafts);
export const useCasePages = withMarketingPageMeta("useCase", useCasePageDrafts);
export const studioTypePages = withMarketingPageMeta("studioType", studioTypePageDrafts);
export const allMarketingPages = [...featurePages, ...useCasePages];
export const allPublicMarketingPages = [...featurePages, ...useCasePages, ...studioTypePages];

export function getFeaturePage(slug: string) {
  return featurePages.find((page) => page.slug === slug);
}

export function getUseCasePage(slug: string) {
  return useCasePages.find((page) => page.slug === slug);
}

export function getStudioTypePage(slug: string) {
  return studioTypePages.find((page) => page.slug === slug);
}

export function getMarketingPageByRef(ref: MarketingPageRef) {
  if (ref.kind === "feature") {
    return getFeaturePage(ref.slug);
  }

  if (ref.kind === "useCase") {
    return getUseCasePage(ref.slug);
  }

  return getStudioTypePage(ref.slug);
}
