import { formatPublicPlatformPrice } from "./constants.ts";

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
  pages: MarketingPageDraft[],
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
    title: "Student Records for Martial Arts Studios",
    eyebrow: "Student CRM",
    metaTitle: "Student Management Software for Martial Arts Studios | Koaryu",
    description:
      "See how student profiles, programs, guardian contacts, notes, and recorded promotions fit together, including staff access and family-record limits.",
    summary:
      "Each student has a training record. Guardian contacts and billing payers have separate roles, even when the same adult fills both.",
    icon: "users",
    primaryAction: "Read the student crm guide",
    sections: [
      {
        title: "Student Records for Martial Arts Studios",
        description:
          "Each student has a training record. Guardian contacts and billing payers have separate roles, even when the same adult fills both.",
        bullets: [
          "The profile holds contact details, programs, current rank, notes, and recorded promotions. Attendance and billing records are accessed separately.",
          "Editing the student does not edit existing guardian contact fields.",
          "A current belt does not reconstruct past promotion history.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "belt-tracking",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "billing",
      },
    ],
  },
  {
    slug: "belt-tracking",
    title: "Belt Tracking and Promotion Readiness",
    eyebrow: "Rank Progression",
    metaTitle: "Belt Tracking Software for Martial Arts Schools | Koaryu",
    description:
      "Understand program rank ladders, qualifying class counts, time calculations, instructor review, and what is recorded when a promotion is confirmed.",
    summary:
      "Set ordered ranks and class, time, and approval requirements. Review the underlying attendance and rank dates before making a promotion decision.",
    icon: "award",
    primaryAction: "Read the rank progression guide",
    sections: [
      {
        title: "Belt Tracking and Promotion Readiness",
        description:
          "Set ordered ranks and class, time, and approval requirements. Review the underlying attendance and rank dates before making a promotion decision.",
        bullets: [
          "Configured months are calculated as 30 days each.",
          "Without a recorded promotion date, time uses program membership start or student membership start.",
          "Confirming a promotion records it at that time. There is no historical promotion-date input.",
          "A required approval appears as Needs approval; it is not a separate stored approval record.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "billing",
      },
    ],
  },
  {
    slug: "attendance",
    title: "Attendance Tracking for Martial Arts Classes",
    eyebrow: "Schedule & Attendance",
    metaTitle: "Martial Arts Attendance Tracking Software | Koaryu",
    description:
      "Understand recurring classes and dated sessions, save or correct each student’s attendance, and see which records contribute to reports and rank review.",
    summary:
      "A dated session has its own roster and attendance. Each student’s change saves separately, with an error shown if it fails.",
    icon: "calendar",
    primaryAction: "Read the schedule & attendance guide",
    sections: [
      {
        title: "Attendance Tracking for Martial Arts Classes",
        description:
          "A dated session has its own roster and attendance. Each student’s change saves separately, with an error shown if it fails.",
        bullets: [
          "The attendance control cycles through Unmarked, Present, Late, Absent, and back to Unmarked.",
          "Admin, Front Desk, and Instructor can take attendance.",
          "Present and Late can count toward rank requirements when the session and entry qualify.",
          "Canceled or deleted sessions and entries excluded from eligibility do not count toward rank requirements.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "belt-tracking",
      },
      {
        kind: "feature",
        slug: "billing",
      },
    ],
  },
  {
    slug: "billing",
    title: "Billing Records and Tuition Availability",
    eyebrow: "Billing",
    metaTitle: "Martial Arts Billing Records and Tuition Availability | Koaryu",
    description:
      "Compare platform pricing, existing invoices and payers, external payment records, and tuition availability. Collection requires separate studio activation.",
    summary:
      "Admin and Front Desk can review existing billing records. Tuition collection needs separate activation for your studio and is not generally available. New billing exports are unavailable.",
    icon: "credit-card",
    primaryAction: "Read the billing guide",
    sections: [
      {
        title: "Billing Records and Tuition Availability",
        description:
          "Admin and Front Desk can review existing billing records. Tuition collection needs separate activation for your studio and is not generally available. New billing exports are unavailable.",
        bullets: [
          "An external payment is a payer-level record. It does not settle a Stripe invoice.",
          "Reconcile refreshes an existing Stripe invoice’s local status without charging the payer.",
          "Attach external student billing creates a record-only enrollment; it does not create a missing payer or start collection.",
          "Instructors cannot access billing records.",
        ],
      },
    ],
    proof: [
      {
        label: "Pricing",
        value: `${formatPublicPlatformPrice()} per month per studio`,
        detail: "Koaryu platform subscription in USD.",
      },
      {
        label: "Collection",
        value: "Separate activation",
        detail: "Not generally available.",
      },
    ],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "belt-tracking",
      },
    ],
  },
];

const useCasePageDrafts: MarketingPageDraft[] = [
  {
    slug: "spreadsheets-to-studio-crm",
    title: "Import a Student Roster from CSV",
    eyebrow: "Switching from spreadsheets",
    metaTitle: "Move from Martial Arts Spreadsheets to Studio CRM | Koaryu",
    description:
      "Prepare a roster CSV with a downloadable example, field mapping, validation checks, import outcomes, and the difference between retrying and importing again.",
    summary:
      "Map student fields, resolve programs and current belts, then review validation before importing. Existing attendance, promotion history, and billing records are separate.",
    icon: "file-spreadsheet",
    primaryAction: "Read the switching from spreadsheets guide",
    sections: [
      {
        title: "Import a Student Roster from CSV",
        description:
          "Map student fields, resolve programs and current belts, then review validation before importing. Existing attendance, promotion history, and billing records are separate.",
        bullets: [
          "The import validates mapped rows and can import valid rows when others fail.",
          "Importing a new file does not match or update existing students by name or email.",
          "Retrying the same import run resumes its work; starting another import can create duplicates.",
          "An unmatched current belt can remain in notes without assigning that rank.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "belt-tracking",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
    ],
  },
  {
    slug: "student-retention",
    title: "Review Attendance Before Contacting an Absent Student",
    eyebrow: "Retention workflow",
    metaTitle: "Martial Arts Student Retention Software | Koaryu",
    description:
      "Work through an attendance-gap example, distinguish planned breaks from missing data, and prepare a personal check-in using the student’s actual history.",
    summary:
      "The inactivity signal helps identify records to inspect. Check attendance, status, and notes before contacting a student or guardian through your usual channel.",
    icon: "heart-pulse",
    primaryAction: "Read the retention workflow guide",
    sections: [
      {
        title: "Review Attendance Before Contacting an Absent Student",
        description:
          "The inactivity signal helps identify records to inspect. Check attendance, status, and notes before contacting a student or guardian through your usual channel.",
        bullets: [
          "A long gap can mean a planned break, missing attendance, or a student who needs a check-in.",
          "Verify imported or incomplete attendance history before interpreting a gap.",
          "Staff send outreach themselves; this guide does not send messages.",
          "Admin and Front Desk can record a dated update in student notes after contact.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "billing",
      },
    ],
  },
  {
    slug: "trial-to-enrollment",
    title: "Follow Up on a Trial Inquiry and Convert the Lead",
    eyebrow: "Trial conversion",
    metaTitle: "Martial Arts Trial Student Follow-Up Workflow | Koaryu",
    description:
      "Follow a lead through stage changes, contact marking, follow-up rescheduling, and conversion. See which initial details reach the student record.",
    summary:
      "After creation, staff can change stage, assignee, and follow-up date, mark contact, mark lost, or convert. Initial contact details, program, and notes are displayed without edit controls in the inspector.",
    icon: "user-plus",
    primaryAction: "Read the trial conversion guide",
    sections: [
      {
        title: "Follow Up on a Trial Inquiry and Convert the Lead",
        description:
          "After creation, staff can change stage, assignee, and follow-up date, mark contact, mark lost, or convert. Initial contact details, program, and notes are displayed without edit controls in the inspector.",
        bullets: [
          "Stage changes track progress. They do not book a class or send an offer.",
          "Mark contacted clears the follow-up date. Reschedule when the family still needs a decision.",
          "Conversion copies name, email, phone, selected program, and initial notes into an active student record.",
          "A guardian record is created for a minor lead when a guardian name is present.",
          "Conversion does not transfer the activity timeline into student notes or start tuition.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "billing",
      },
    ],
  },
  {
    slug: "tuition-cleanup",
    title: "Choose the Right Action for a Tuition Record",
    eyebrow: "Tuition cleanup",
    metaTitle: "Martial Arts Tuition Cleanup Workflow | Koaryu",
    description:
      "Distinguish a missing payer, missing enrollment, stale Stripe invoice, and payment received elsewhere. Check what each available action changes.",
    summary:
      "Compare the student, payer, invoice, and payment evidence before acting. An external payment record does not settle a Stripe invoice.",
    icon: "credit-card",
    primaryAction: "Read the tuition cleanup guide",
    sections: [
      {
        title: "Choose the Right Action for a Tuition Record",
        description:
          "Compare the student, payer, invoice, and payment evidence before acting. An external payment record does not settle a Stripe invoice.",
        bullets: [
          "Attach external student billing records an enrollment; it does not create the payer.",
          "Reconcile refreshes an existing Stripe invoice without collecting payment.",
          "Record an external payment against the payer with a USD amount, method, and optional note.",
          "There is no external-payment date input. A date written in the note does not change the recording timestamp.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "billing",
      },
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
    ],
  },
  {
    slug: "belt-test-readiness",
    title: "Prepare a Belt Test Review List",
    eyebrow: "Test readiness",
    metaTitle: "Martial Arts Belt Test Readiness Workflow | Koaryu",
    description:
      "Use a worked shortlist to check class counts, rank-date history, and instructor review, then understand the supported promotion-recording procedure.",
    summary:
      "Compare the configured next-rank requirements with each student’s evidence. Keep a reason beside each name: review, more classes, or verify history.",
    icon: "clipboard-check",
    primaryAction: "Read the test readiness guide",
    sections: [
      {
        title: "Prepare a Belt Test Review List",
        description:
          "Compare the configured next-rank requirements with each student’s evidence. Keep a reason beside each name: review, more classes, or verify history.",
        bullets: [
          "Select the correct program and ladder, check attendance and rank-date assumptions, then make the teaching decision.",
          "Imported current belts may have no promotion history; the time figure can fall back to membership dates.",
          "An approval requirement flags a review; it is not a test booking or separate stored approval.",
          "Admin and Instructor can confirm a promotion with optional notes. Koaryu records it when confirmed.",
        ],
      },
    ],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "belt-tracking",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "student-management",
      },
    ],
  },
];

const studioTypePageDrafts: MarketingPageDraft[] = [
  {
    slug: "family-martial-arts-schools",
    title: "Student, Guardian, and Payer Records",
    eyebrow: "Studio type",
    metaTitle: "Martial Arts Software for Kids and Family Studios | Koaryu",
    description:
      "See how siblings keep separate student records and how guardian contacts differ from billing payers.",
    summary: "This guide has moved to the family-record explanation within Student Records.",
    icon: "users",
    primaryAction: "Read the studio type guide",
    sections: [],
    proof: [],
    related: [
      {
        kind: "feature",
        slug: "student-management",
      },
      {
        kind: "useCase",
        slug: "trial-to-enrollment",
      },
      {
        kind: "feature",
        slug: "attendance",
      },
      {
        kind: "feature",
        slug: "billing",
      },
      {
        kind: "useCase",
        slug: "tuition-cleanup",
      },
    ],
  },
];

export const featurePages = withMarketingPageMeta("feature", featurePageDrafts);
export const useCasePages = withMarketingPageMeta("useCase", useCasePageDrafts);
export const studioTypePages = withMarketingPageMeta("studioType", studioTypePageDrafts);

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
