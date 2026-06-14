import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { AnimatedFaqItem } from "@/components/animated-faq-item";
import { BackendWarmup } from "@/components/backend-warmup";
import { LogoLink } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ScrollReveal } from "@/components/scroll-reveal";
import { MobileNav } from "@/components/mobile-nav";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";
import {
  assuranceItems,
  faqGroups,
  features,
  previewActions,
  previewMetrics,
  previewProgramBuckets,
  pricingItems,
  privacyItems,
  promises,
  workflows,
} from "@/lib/landing-page-content";
import { publicFooterLinks, publicNavLinks } from "@/lib/public-navigation";
import publicStyles from "@/components/marketing/public-pages.module.css";
import styles from "@/app/page.module.css";

const previewAccentClasses: Record<(typeof previewMetrics)[number]["accent"], string> = {
  blue: styles.previewBlue,
  purple: styles.previewPurple,
  gold: styles.previewGold,
  green: styles.previewGreen,
};

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
          {assuranceItems.map((item, i) => {
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
      className={`${styles.heroPreview} hidden lg:block`}
      aria-label="Koaryu dashboard product preview"
    >
      <div className={styles.heroPreviewShine} aria-hidden />
      <div className={styles.heroPreviewTopbar}>
        <div>
          <p className="text-sm font-semibold text-text-primary">Dashboard</p>
          <p className="mt-1 text-xs text-text-secondary">
            River City Martial Arts
          </p>
        </div>
        <span className={styles.heroPreviewStatus}>
          Live studio view
        </span>
      </div>

      <div className={styles.heroPreviewMetrics}>
        {previewMetrics.map((metric) => {
          const Icon = metric.icon;

          return (
            <div
              key={metric.label}
              className={`${styles.heroPreviewMetric} ${previewAccentClasses[metric.accent]}`}
            >
              <div className={styles.heroPreviewMetricHeader}>
                <span className={styles.heroPreviewIcon}>
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

      <div className={styles.heroPreviewSplit}>
        <section className={styles.heroPreviewPanel}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Inactivity Watch
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                Active and trialing students only.
              </p>
            </div>
            <span className={styles.heroPreviewPseudoLink}>
              Open Reports
            </span>
          </div>
          <div className={styles.heroPreviewNotice}>
            6 students crossed the 14-day threshold.
          </div>
        </section>

        <section className={styles.heroPreviewPanel}>
          <h3 className="text-sm font-semibold text-text-primary">
            Quick Actions
          </h3>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {previewActions.map((action) => {
              const Icon = action.icon;

              return (
                <div key={action.label} className={styles.heroPreviewAction}>
                  <Icon className="h-3.5 w-3.5" />
                  <span>{action.label}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className={styles.heroPreviewProgramPanel}>
        <div className={styles.heroPreviewProgramHeader}>
          <h3 className="text-sm font-semibold text-text-primary">
            Program Buckets
          </h3>
          <span className={styles.heroPreviewPseudoLink}>
            View Reports
          </span>
        </div>
        <div className="mt-3 grid gap-2">
          {previewProgramBuckets.map((program) => (
            <div key={program.name} className={styles.heroPreviewProgramRow}>
              <span className={styles.heroPreviewProgramName}>{program.name}</span>
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

export function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-bg text-text-primary">
      <BackendWarmup />

      {/* Accent stripe — thin gold bar at the very top */}
      <div className={`${publicStyles.accentStripe} w-full`} />

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border px-6 py-4 bg-bg/80 backdrop-blur-md">
        <LogoLink size="md" />
        <nav className="hidden items-center gap-8 text-sm text-text-secondary md:flex">
          {publicNavLinks.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-text-primary transition-colors">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm" className="hidden md:inline-flex">
            <Link href="/login" prefetch={false}>
              Sign In
            </Link>
          </Button>
          <MobileNav links={publicNavLinks} />
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative px-6 py-28 sm:py-36 overflow-hidden">
        {/* Dot-grid background texture */}
        <div className={`${publicStyles.dotGrid} absolute inset-0 pointer-events-none`} aria-hidden />

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
        <div className={`${publicStyles.dotGrid} absolute inset-0 pointer-events-none`} aria-hidden />

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

      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 text-sm text-text-secondary sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Koaryu</p>
          <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Legal">
            {publicFooterLinks.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-text-primary">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </main>
  );
}
