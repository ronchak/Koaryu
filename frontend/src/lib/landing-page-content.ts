import {
  Award,
  BarChart3,
  Calendar,
  CreditCard,
  FileSpreadsheet,
  ShieldCheck,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";

export const features = [
  {
    title: "Student CRM",
    description:
      "Profiles, guardians, status, programs, notes, attendance, payments, and rank history in one record.",
    icon: Users,
  },
  {
    title: "Belt Progression",
    description:
      "Track ranks, classes since promotion, time at rank, tips, and test readiness without a side spreadsheet.",
    icon: Award,
  },
  {
    title: "Schedule & Attendance",
    description:
      "Build recurring classes, check students in quickly, and turn attendance into retention and promotion signals.",
    icon: Calendar,
  },
  {
    title: "Lead Pipeline",
    description:
      "Move prospects from inquiry to trial to enrolled with follow-up dates, notes, sources, and conversion context.",
    icon: UserPlus,
  },
  {
    title: "Billing Visibility",
    description:
      "Use Stripe for payments while Koaryu keeps overdue accounts, plans, payers, and invoices visible to staff.",
    icon: CreditCard,
  },
  {
    title: "Rules-Based Automation",
    description:
      "Run practical reminders for trials, missed classes, payment recovery, testing, and promotions.",
    icon: Zap,
  },
];

export const workflows = [
  {
    label: "Morning check",
    detail:
      "See today's classes, overdue payments, inactive students, new leads, and students nearing test eligibility.",
  },
  {
    label: "Before class",
    detail:
      "Open the roster, mark attendance, review notes, and spot students who need instructor attention.",
  },
  {
    label: "After class",
    detail:
      "Update promotion progress, follow up with missed students, and keep every student's history current.",
  },
  {
    label: "End of week",
    detail:
      "Review leads, retention risk, attendance trends, billing status, and the next belt test list.",
  },
];

export const promises = [
  "Flat-rate pricing that does not punish growth",
  "Martial-arts-native data instead of generic gym custom fields",
  "Fast self-serve setup for one-location independent studios",
  "Tenant-scoped records and role-based staff access",
];

export const pricingItems = [
  "Full platform for student CRM, belts, leads, schedule, reports, and automations",
  "Stripe Connect onboarding for studio payments",
  "Billing plans tied to programs, not headcount",
  "Family payers and invoices tracked alongside student records",
  "CSV import path for studios leaving spreadsheets or legacy tools",
];

export const previewMetrics = [
  {
    label: "Total students",
    value: "132",
    detail: "118 active · 14 trialing",
    icon: Users,
    accent: "blue",
  },
  {
    label: "Active leads",
    value: "27",
    detail: "9 follow-ups due",
    icon: UserPlus,
    accent: "purple",
  },
  {
    label: "Today's classes",
    value: "8",
    detail: "4 programs active",
    icon: Calendar,
    accent: "gold",
  },
  {
    label: "Belt ranks",
    value: "16",
    detail: "8 stripes configured",
    icon: Award,
    accent: "green",
  },
] as const;

export const previewActions = [
  { label: "Add Student", icon: UserPlus },
  { label: "Import CSV", icon: FileSpreadsheet },
  { label: "View Leads", icon: Users },
  { label: "Reports", icon: BarChart3 },
];

export const previewProgramBuckets = [
  {
    name: "Brazilian Jiu-Jitsu Core",
    students: "64",
    leads: "11",
    today: "3",
  },
  {
    name: "Tae Kwon Do Fundamentals",
    students: "68",
    leads: "16",
    today: "5",
  },
];

export const assuranceItems = [
  {
    title: "Migrate cleanly",
    description:
      "Bring students, leads, and belt ranks in from CSV instead of rebuilding every record by hand.",
    icon: FileSpreadsheet,
  },
  {
    title: "Measure the real work",
    description:
      "Track attendance, source conversion, promotion history, inactive students, and billing attention.",
    icon: BarChart3,
  },
  {
    title: "Protect studio data",
    description:
      "Keep staff permissions and tenant-scoped records central because student and guardian data matters.",
    icon: ShieldCheck,
  },
];

export const privacyItems = [
  {
    title: "Not an AI platform",
    description:
      "Koaryu does not use studio data to train AI models. The product is built around predictable records, rules, permissions, and reports.",
  },
  {
    title: "Separated studio records",
    description:
      "Student, guardian, attendance, rank, lead, and billing records are scoped to the studio they belong to.",
  },
  {
    title: "Staff access boundaries",
    description:
      "Role-based access keeps sensitive settings, exports, and payment visibility closer to the people who actually need them.",
  },
  {
    title: "Payment handling through Stripe",
    description:
      "Koaryu keeps billing context visible while Stripe handles payment processing, onboarding, and processor-level payment infrastructure.",
  },
  {
    title: "Exportable school history",
    description:
      "A studio should be able to leave with its own operational history: students, guardians, attendance, ranks, leads, and billing records.",
  },
];

export const faqGroups = [
  {
    title: "Fit",
    items: [
      {
        question: "Who is Koaryu built for?",
        answer:
          "Independent martial arts studios with recurring memberships, rank progression, and a working owner or small staff team.",
      },
      {
        question: "Is this a generic gym CRM?",
        answer:
          "No. Programs, ranks, attendance, guardians, promotions, trials, and retention workflows are first-class parts of the product.",
      },
      {
        question: "Which martial arts styles does it support?",
        answer:
          "Koaryu is designed for schools with structured programs and progression: karate, taekwondo, jiu-jitsu, kickboxing, mixed programs, and family martial arts schools.",
      },
      {
        question: "Is this for single-location schools?",
        answer:
          "Yes. The first version is focused on owner-operated and independent studios. Multi-location or franchise workflows should be treated as a later fit.",
      },
    ],
  },
  {
    title: "Switching",
    items: [
      {
        question: "Can I move over from spreadsheets?",
        answer:
          "Yes. CSV import is part of the intended setup path for students, leads, and belt ranks so you do not have to rebuild every record by hand.",
      },
      {
        question: "What if my existing data is messy?",
        answer:
          "Koaryu should tolerate partial records and let you clean up the important fields over time. The goal is to get operating quickly, not force a perfect migration first.",
      },
      {
        question: "How long should setup take?",
        answer:
          "A small studio should be able to define programs, import students, set ranks, and start using attendance the same day.",
      },
      {
        question: "What does Koaryu replace?",
        answer:
          "For most studios, it replaces a patchwork of student spreadsheets, lead trackers, attendance sheets, rank lists, payment notes, and manual follow-up reminders.",
      },
    ],
  },
  {
    title: "Daily Use",
    items: [
      {
        question: "Can instructors use it during class?",
        answer:
          "That is the target workflow. Rosters and attendance should be fast enough to use between classes from a laptop, tablet, or phone browser.",
      },
      {
        question: "Does attendance affect belt readiness?",
        answer:
          "Yes. Attendance is meant to feed promotion readiness, inactivity alerts, class utilization, and student history instead of sitting in a separate log.",
      },
      {
        question: "Can I track multiple programs?",
        answer:
          "Yes. Programs are part of the model so a studio can separate kids, teens, adults, beginner tracks, or discipline-specific groups.",
      },
      {
        question: "Can I configure belt ladders?",
        answer:
          "The product direction is configurable rank ladders with ordered ranks, class thresholds, time-at-rank rules, and instructor approval where needed.",
      },
      {
        question: "Does Koaryu handle leads and trials?",
        answer:
          "Yes. Leads should move from inquiry to trial to enrolled, with source, notes, follow-up dates, and conversion history attached.",
      },
    ],
  },
  {
    title: "Pricing & Payments",
    items: [
      {
        question: "What does the $27 include?",
        answer:
          "The flat platform price is for the core studio operating system: students, ranks, leads, attendance, billing visibility, reports, and automations.",
      },
      {
        question: "Do I pay more when the school grows?",
        answer:
          "No per-student software tiers. The platform subscription is a flat studio rate, so growth does not automatically raise the Koaryu bill.",
      },
      {
        question: "Are Stripe fees included?",
        answer:
          "No. Stripe payment processing fees are separate from Koaryu's platform subscription, as they are charged by the payment processor.",
      },
      {
        question: "Do I have to use Koaryu for payments?",
        answer:
          "The product is built to work best with Stripe-connected billing, but a studio should still be able to use the operational pieces before fully activating payments.",
      },
      {
        question: "Can I cancel?",
        answer:
          "The pricing philosophy is month-to-month and predictable. Studios should be able to leave without losing access to their own exported data.",
      },
    ],
  },
  {
    title: "Data & Access",
    items: [
      {
        question: "Who owns the studio data?",
        answer:
          "The studio does. Koaryu should make records exportable instead of trapping student, guardian, attendance, or billing history inside the product.",
      },
      {
        question: "Can staff have different permissions?",
        answer:
          "Yes. Admin, instructor, and front-desk roles are part of the access model so financial settings and sensitive exports are not exposed to everyone.",
      },
      {
        question: "What about minors and guardian contacts?",
        answer:
          "Student profiles are designed with youth programs in mind, including guardian contact fields, emergency details, and staff permission boundaries.",
      },
      {
        question: "Is studio data separated between customers?",
        answer:
          "Yes. Tenant-scoped records and database-level isolation are core requirements because studios should never see another school's data.",
      },
    ],
  },
  {
    title: "Roadmap",
    items: [
      {
        question: "Will there be a mobile app?",
        answer:
          "Koaryu is web-first. The priority is making the browser experience fast on phones and tablets for rosters, attendance, and student lookup before adding a separate native app.",
      },
      {
        question: "Will it support SMS?",
        answer:
          "Maybe. SMS can be useful for studios, but it adds cost, compliance, and deliverability tradeoffs. Email-based automations come first.",
      },
      {
        question: "Is this AI-powered?",
        answer:
          "No. Koaryu is intentionally not an AI platform. Core workflows should be deterministic: records, schedules, attendance, billing, rules, and reports that behave predictably.",
      },
      {
        question: "What support should I expect?",
        answer:
          "The product should be self-serve, but setup guidance, migration help, and direct support matter for early studios switching from spreadsheets or legacy tools.",
      },
    ],
  },
];
