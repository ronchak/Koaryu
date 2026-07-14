import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ShieldCheck, Users } from "lucide-react";
import {
  BreadcrumbJsonLd,
  detailNextSteps,
  MarketingHero,
  MarketingNextSteps,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import { ScrollReveal } from "@/components/scroll-reveal";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About Koaryu | Martial Arts Studio Software",
  description:
    "Koaryu is a flat-rate operating system for independent martial arts studios, built around students, ranks, attendance, leads, billing, and retention.",
  alternates: { canonical: "https://koaryu.app/about" },
  openGraph: {
    title: "About Koaryu | Martial Arts Studio Software",
    description:
      "The product philosophy behind Koaryu and its focus on independent martial arts schools.",
    url: "https://koaryu.app/about",
  },
};

const principles = [
  {
    title: "Built for independent schools",
    description:
      "Koaryu is focused on owner-operated and small-team martial arts studios, not enterprise gym chains.",
    icon: Users,
  },
  {
    title: "Studio data should stay understandable",
    description:
      "Student, guardian, attendance, rank, lead, and supported billing records stay visible and scoped to the school; new billing exports are currently unavailable.",
    icon: ShieldCheck,
  },
  {
    title: "Daily action beats dashboard theater",
    description:
      "The product should answer what needs attention today: follow-ups, classes, promotions, retention, and tuition issues.",
    icon: CheckCircle2,
  },
];

export default function AboutPage() {
  return (
    <PublicPageShell>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "About", url: "https://koaryu.app/about" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "AboutPage",
          name: "About Koaryu",
          description:
            "Koaryu is a martial arts studio operating system for independent schools.",
          url: "https://koaryu.app/about",
          isPartOf: {
            "@type": "WebSite",
            name: APP_NAME,
            url: "https://koaryu.app/",
          },
        }}
      />
      <MarketingHero
        eyebrow="About Koaryu"
        title="Serious studio software for schools that still feel personal."
        description="Koaryu exists for martial arts owners who need a calmer way to run students, ranks, attendance, trials, billing, and retention without inheriting enterprise software complexity."
        cta="Start setup"
        sceneLabel="Product philosophy"
        sceneFocus="Independent studios"
      />
      <section className="px-6 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr]">
          <ScrollReveal>
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-accent">Positioning</p>
              <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">
                Koaryu is intentionally narrower than generic gym software.
              </h2>
              <p className="mt-5 text-sm leading-7 text-text-secondary">
                The product is built around the rhythm of a martial arts school:
                the student who misses class, the trial family waiting for a call,
                the instructor reviewing promotions, and the owner who needs to
                know whether the school is healthy before the evening rush.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild variant="primary" className="btn-lift">
                  <Link href="/features">
                    Explore features
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/use-cases">See use cases</Link>
                </Button>
              </div>
            </div>
          </ScrollReveal>
          <div className="border-t border-border">
            {principles.map((principle, index) => {
              const Icon = principle.icon;

              return (
                <ScrollReveal key={principle.title} stagger={index}>
                  <article className="grid gap-4 border-b border-border py-7 sm:grid-cols-[48px_1fr]">
                    <span className="flex h-10 w-10 items-center justify-center border border-border bg-surface text-accent" style={{ borderRadius: 6 }}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="font-semibold">{principle.title}</h3>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">{principle.description}</p>
                    </div>
                  </article>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
      </section>
      <section className="border-t border-border bg-surface px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <ScrollReveal>
            <div className="max-w-3xl">
              <p className="text-xs font-medium uppercase tracking-widest text-accent">Koaryu</p>
              <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">
                Reliable daily operations for one independent studio.
              </h2>
              <p className="mt-5 text-sm leading-7 text-text-secondary">
                Koaryu supports one studio per user with explicit Admin,
                Front Desk, and Instructor boundaries. It centers the roster, ranks,
                schedule, attendance, leads, and honest visibility into existing billing
                records. Provider-backed billing changes and live Stripe activation are
                currently unavailable.
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>
      <MarketingNextSteps
        title="See how the product works"
        description=""
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
