import Link from "next/link";
import {
  ArrowRight,
  Award,
  BarChart3,
  Calendar,
  CheckCircle2,
  CreditCard,
  FileSpreadsheet,
  ShieldCheck,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { AnimatedFaqItem } from "@/components/animated-faq-item";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ScrollReveal } from "@/components/scroll-reveal";
import { MobileNav } from "@/components/mobile-nav";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";

const features = [
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

const workflows = [
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

const promises = [
  "Flat-rate pricing that does not punish growth",
  "Martial-arts-native data instead of generic gym custom fields",
  "Fast self-serve setup for one-location independent studios",
  "Tenant-scoped records and role-based staff access",
];

const pricingItems = [
  "Full platform for student CRM, belts, leads, schedule, reports, and automations",
  "Stripe Connect onboarding for studio payments",
  "Billing plans tied to programs, not headcount",
  "Family payers and invoices tracked alongside student records",
  "CSV import path for studios leaving spreadsheets or legacy tools",
];

const previewMetrics = [
  {
    label: "Total students",
    value: "132",
    detail: "118 active · 14 trialing",
    icon: Users,
    accent: "preview-blue",
  },
  {
    label: "Active leads",
    value: "27",
    detail: "9 follow-ups due",
    icon: UserPlus,
    accent: "preview-purple",
  },
  {
    label: "Today's classes",
    value: "8",
    detail: "4 programs active",
    icon: Calendar,
    accent: "preview-gold",
  },
  {
    label: "Belt ranks",
    value: "16",
    detail: "8 stripes configured",
    icon: Award,
    accent: "preview-green",
  },
];

const previewActions = [
  { label: "Add Student", icon: UserPlus },
  { label: "Import CSV", icon: FileSpreadsheet },
  { label: "View Leads", icon: Users },
  { label: "Reports", icon: BarChart3 },
];

const previewProgramBuckets = [
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

const privacyItems = [
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

const faqGroups = [
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

/* ─────────────────────────────────────────────
   Section Components
   ───────────────────────────────────────────── */

function FeatureGrid() {
  return (
    <section id="product" className="border-t border-border px-6 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-14 max-w-2xl">
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Product
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              Built around how a studio actually runs
            </h2>
            <p className="text-sm text-text-secondary sm:text-base leading-7">
              Koaryu connects the daily work: students, trials, classes,
              promotion progress, billing, and retention. No more stitching a
              school together from spreadsheets and tabs.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => {
            const Icon = feature.icon;

            return (
              <ScrollReveal key={feature.title} stagger={i}>
                <article className="feature-item py-4 min-w-0">
                  <div className="mb-3 flex items-center gap-3">
                    <Icon className="h-5 w-5 shrink-0 text-accent" />
                    <h3 className="text-lg font-semibold">{feature.title}</h3>
                  </div>
                  <p className="text-sm leading-6 text-text-secondary">
                    {feature.description}
                  </p>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section className="border-t border-border px-6 py-24 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.8fr_1.2fr]">
        <ScrollReveal>
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Workflow
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              One system from trial to black belt
            </h2>
            <p className="text-sm leading-7 text-text-secondary sm:text-base">
              The useful part is not another contact database. It is the way each
              update changes the next decision: attendance affects belt readiness,
              missed classes trigger retention work, and lead activity turns into
              enrollment history.
            </p>
          </div>
        </ScrollReveal>

        <div className="border-t border-border">
          {workflows.map((workflow, index) => (
            <ScrollReveal key={workflow.label} stagger={index}>
              <article className="timeline-step grid gap-4 border-b border-border py-6 sm:grid-cols-[64px_1fr]">
                <div className="flex items-center justify-center w-10 h-10 font-mono text-sm font-semibold text-accent bg-surface-raised border border-border sm:w-16 sm:h-10 sm:justify-center">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">
                    {workflow.label}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {workflow.detail}
                  </p>
                </div>
              </article>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function PositioningSection() {
  return (
    <section className="border-t border-border px-6 py-24 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-2">
        <ScrollReveal>
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Why it exists
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              Serious studio software without legacy studio pricing
            </h2>
            <p className="text-sm leading-7 text-text-secondary sm:text-base">
              Many small schools are choosing between brittle spreadsheets and
              expensive tools built for bigger organizations. Koaryu is narrower:
              it focuses on the operational loop an instructor-owner repeats
              every week.
            </p>
          </div>
        </ScrollReveal>

        <div className="border-t border-border">
          {promises.map((promise, i) => (
            <ScrollReveal key={promise} stagger={i}>
              <div className="flex items-start gap-3 border-b border-border py-5 last:border-b-0">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <p className="text-sm text-text-secondary">{promise}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section
      id="pricing"
      className="border-t border-border bg-surface px-6 py-24 sm:py-28"
    >
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
        <ScrollReveal>
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Pricing
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              Simple, honest pricing
            </h2>
            <p className="text-sm leading-7 text-text-secondary sm:text-base">
              One flat platform subscription for the studio. No software tiers
              that climb as your student count grows.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal className="animate-scale-in">
          <div className="border-t border-b border-border py-8">
            <div className="mb-8 flex flex-col gap-4 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-mono text-6xl font-bold text-accent accent-glow sm:text-7xl">
                  $27
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  per studio per month
                </p>
              </div>
              <Button asChild variant="primary" size="lg" className="btn-lift">
                <Link href="/signup" prefetch={false}>
                  Start setup
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>

            <ul className="grid gap-3 text-sm text-text-secondary sm:grid-cols-2">
              {pricingItems.map((item, i) => (
                <ScrollReveal key={item} stagger={i} as="li">
                  <div className="flex items-start gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 bg-accent" />
                    <span>{item}</span>
                  </div>
                </ScrollReveal>
              ))}
            </ul>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

function AssuranceSection() {
  const items = [
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

  return (
    <section className="border-t border-border px-6 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-14 max-w-2xl">
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Operations
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              Built for the unglamorous work that keeps a school healthy
            </h2>
            <p className="text-sm leading-7 text-text-secondary sm:text-base">
              The best studio software should make the ordinary week easier: less
              chasing, fewer blind spots, and faster answers between classes.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-8 border-t border-b border-border py-8 md:grid-cols-3 md:divide-x md:divide-border">
          {items.map((item, i) => {
            const Icon = item.icon;

            return (
              <ScrollReveal key={item.title} stagger={i}>
                <article className="md:px-8 md:first:pl-0 md:last:pr-0">
                  <Icon className="mb-4 h-5 w-5 text-accent" />
                  <h3 className="mb-2 font-semibold">{item.title}</h3>
                  <p className="text-sm leading-6 text-text-secondary">
                    {item.description}
                  </p>
                </article>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PrivacySection() {
  return (
    <section id="privacy" className="border-t border-border px-6 py-24 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr]">
        <ScrollReveal>
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              Privacy
            </p>
            <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
              Student data deserves a quieter kind of software
            </h2>
            <p className="text-sm leading-7 text-text-secondary sm:text-base">
              Martial arts schools hold information about kids, families, staff,
              payments, and attendance. Koaryu treats that as operational trust,
              not raw material for opaque experiments.
            </p>
          </div>
        </ScrollReveal>

        <div className="border-t border-border">
          {privacyItems.map((item, i) => (
            <ScrollReveal key={item.title} stagger={i}>
              <article className="grid gap-2 border-b border-border py-6 last:border-b-0 sm:grid-cols-[190px_1fr] sm:gap-8">
                <h3 className="text-sm font-semibold text-text-primary">
                  {item.title}
                </h3>
                <p className="text-sm leading-6 text-text-secondary">
                  {item.description}
                </p>
              </article>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  return (
    <section id="faq" className="border-t border-border bg-surface px-6 py-24 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <ScrollReveal>
          <div className="mb-14 max-w-2xl">
            <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">
              FAQ
            </p>
            <h2 className="text-3xl font-semibold sm:text-4xl accent-glow">
              Questions owners ask before switching
            </h2>
            <p className="mt-4 text-sm leading-6 text-text-secondary">
              Short answers to the practical concerns that come up before moving
              a studio off spreadsheets or legacy software.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal className="space-y-14">
          {faqGroups.map((group) => (
            <div key={group.title} className="grid gap-4 lg:grid-cols-[180px_1fr]">
              <h3 className="text-sm font-medium text-accent uppercase tracking-widest">
                {group.title}
              </h3>
              <div className="divide-y divide-border border-t border-b border-border">
                {group.items.map((faq) => (
                  <AnimatedFaqItem
                    key={faq.question}
                    question={faq.question}
                    answer={faq.answer}
                  />
                ))}
              </div>
            </div>
          ))}
        </ScrollReveal>
      </div>
    </section>
  );
}

function HeroProductPreview() {
  return (
    <aside
      className="hero-preview hidden lg:block"
      aria-label="Koaryu dashboard product preview"
    >
      <div className="hero-preview__shine" aria-hidden />
      <div className="hero-preview__topbar">
        <div>
          <p className="text-sm font-semibold text-text-primary">Dashboard</p>
          <p className="mt-1 text-xs text-text-secondary">
            River City Martial Arts
          </p>
        </div>
        <button type="button" className="hero-preview__status">
          Live studio view
        </button>
      </div>

      <div className="hero-preview__metrics">
        {previewMetrics.map((metric) => {
          const Icon = metric.icon;

          return (
            <div
              key={metric.label}
              className={`hero-preview__metric ${metric.accent}`}
            >
              <div className="hero-preview__metric-header">
                <span className="hero-preview__icon">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span>{metric.label}</span>
              </div>
              <p className="mt-3 font-mono text-2xl font-semibold text-text-primary">
                {metric.value}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{metric.detail}</p>
            </div>
          );
        })}
      </div>

      <div className="hero-preview__split">
        <section className="hero-preview__panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Inactivity Watch
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                Active and trialing students only.
              </p>
            </div>
            <button type="button" className="hero-preview__pseudo-link">
              Open Reports
            </button>
          </div>
          <button type="button" className="hero-preview__notice">
            6 students crossed the 14-day threshold.
          </button>
        </section>

        <section className="hero-preview__panel">
          <h3 className="text-sm font-semibold text-text-primary">
            Quick Actions
          </h3>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {previewActions.map((action) => {
              const Icon = action.icon;

              return (
                <button key={action.label} type="button" className="hero-preview__action">
                  <Icon className="h-3.5 w-3.5" />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="hero-preview__program-panel">
        <div className="hero-preview__program-header">
          <h3 className="text-sm font-semibold text-text-primary">
            Program Buckets
          </h3>
          <button type="button" className="hero-preview__pseudo-link">
            View Reports
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          {previewProgramBuckets.map((program) => (
            <div key={program.name} className="hero-preview__program-row">
              <span className="hero-preview__program-name">{program.name}</span>
              <span>
                <strong>{program.students}</strong> students
              </span>
              <span>
                <strong>{program.leads}</strong> leads
              </span>
              <span>
                <strong>{program.today}</strong> today
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

/* ─────────────────────────────────────────────
   Page
   ───────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-bg text-text-primary">
      {/* Accent stripe — thin gold bar at the very top */}
      <div className="accent-stripe w-full" />

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border px-6 py-4 bg-bg/80 backdrop-blur-md">
        <Logo size="md" />
        <nav className="hidden items-center gap-8 text-sm text-text-secondary md:flex">
          <Link href="#product" className="hover:text-text-primary transition-colors">
            Product
          </Link>
          <Link href="#pricing" className="hover:text-text-primary transition-colors">
            Pricing
          </Link>
          <Link href="#privacy" className="hover:text-text-primary transition-colors">
            Privacy
          </Link>
          <Link href="#faq" className="hover:text-text-primary transition-colors">
            FAQ
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm" className="hidden md:inline-flex">
            <Link href="/login" prefetch={false}>
              Sign In
            </Link>
          </Button>
          <MobileNav />
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative px-6 py-28 sm:py-36 overflow-hidden">
        {/* Dot-grid background texture */}
        <div className="dot-grid absolute inset-0 pointer-events-none" aria-hidden />

        <div className="relative mx-auto max-w-7xl">
          <ScrollReveal>
            <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(380px,0.72fr)] xl:gap-20">
              <div className="max-w-3xl">
                <p className="mb-4 text-xs font-medium uppercase tracking-widest text-accent">
                  Flat-rate studio CRM for martial arts schools
                </p>
                <h1 className="text-5xl font-bold sm:text-6xl lg:text-7xl accent-glow tracking-tight">
                  {APP_NAME}
                </h1>

                {/* Draw-in accent line */}
                <div className="draw-line mt-5" />

                <p className="mt-6 max-w-2xl text-base leading-8 text-text-secondary sm:text-lg">
                  {APP_DESCRIPTION} Track students, belts, trials, classes,
                  billing, and retention without paying legacy software prices.
                </p>

                <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                  <Button asChild variant="primary" size="lg" className="btn-lift">
                    <Link
                      href="/signup"
                      prefetch={false}
                      className="flex items-center gap-2"
                    >
                      <span>Get Started</span>
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button asChild variant="secondary" size="lg">
                    <Link href="#pricing">View pricing</Link>
                  </Button>
                </div>

                {/* Stat ticker */}
                <div className="mt-12 flex flex-wrap gap-6 text-sm text-text-secondary border-t border-border pt-6">
                  <span className="stat-item font-mono text-text-primary">$27/mo</span>
                  <span className="stat-item text-muted">·</span>
                  <span className="stat-item">Flat rate</span>
                  <span className="stat-item text-muted">·</span>
                  <span className="stat-item">No per-student fees</span>
                </div>
              </div>

              <HeroProductPreview />
            </div>
          </ScrollReveal>
        </div>
      </section>

      <FeatureGrid />
      <WorkflowSection />
      <PositioningSection />
      <PricingSection />
      <AssuranceSection />
      <PrivacySection />
      <FaqSection />

      {/* ── Final CTA ── */}
      <section className="relative border-t border-border px-6 py-24 sm:py-28 text-center overflow-hidden">
        {/* Subtle grid texture */}
        <div className="dot-grid absolute inset-0 pointer-events-none" aria-hidden />

        <div className="relative mx-auto max-w-2xl">
          <h2 className="mb-4 text-3xl font-semibold sm:text-4xl accent-glow">
            Run the school from one calm dashboard
          </h2>
          <p className="mb-10 text-sm leading-6 text-text-secondary sm:text-base">
            Start with the workflows that matter most: roster, attendance,
            leads, rank progress, billing attention, and retention.
          </p>
          <Button asChild variant="primary" size="lg" className="btn-lift">
            <Link
              href="/signup"
              prefetch={false}
              className="flex items-center gap-2"
            >
              <span>Create account</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
