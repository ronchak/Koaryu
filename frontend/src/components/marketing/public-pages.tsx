import Link from "next/link";
import {
  ArrowRight,
  Award,
  Calendar,
  CheckCircle2,
  CreditCard,
  FileSpreadsheet,
  HeartPulse,
  ClipboardCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { LogoLink } from "@/components/logo";
import { MobileNav } from "@/components/mobile-nav";
import { ScrollReveal } from "@/components/scroll-reveal";
import { Button } from "@/components/ui/button";
import { ProductScene } from "@/components/marketing/product-scene";
import type { MarketingPage } from "@/lib/marketing-pages";
import {
  detailNextSteps,
  marketingDetailPageDefaults,
  marketingDetailNextStepsDefaults,
  marketingHeroDefaults,
  marketingIndexDefaults,
  marketingNextStepsDefaults,
  nextStepsForIndex,
  type MarketingNextStep,
} from "@/lib/marketing-public-content";
import { publicFooterLinks, publicNavLinks } from "@/lib/public-navigation";
import styles from "./public-pages.module.css";

export { detailNextSteps, indexNextSteps } from "@/lib/marketing-public-content";
export type { MarketingNextStep } from "@/lib/marketing-public-content";

const iconMap: Record<MarketingPage["icon"], LucideIcon> = {
  users: Users,
  award: Award,
  calendar: Calendar,
  "credit-card": CreditCard,
  "file-spreadsheet": FileSpreadsheet,
  "heart-pulse": HeartPulse,
  "user-plus": UserPlus,
  "clipboard-check": ClipboardCheck,
};

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border bg-bg/80 px-6 py-4 backdrop-blur-md">
      <LogoLink size="md" />
      <nav className="hidden items-center gap-8 text-sm text-text-secondary md:flex">
        {publicNavLinks.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-text-primary">
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
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border px-6 py-8">
      <div className="mx-auto grid max-w-7xl gap-6 text-sm text-text-secondary md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <p className="font-medium text-text-primary">Koaryu</p>
          <p className="mt-1">Flat-rate studio software for independent martial arts schools.</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
          {publicFooterLinks.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-text-primary">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function PublicPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col bg-bg text-text-primary">
      <div className={`${styles.accentStripe} w-full`} />
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </main>
  );
}

export function PageStructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function BreadcrumbJsonLd({
  items,
}: {
  items: Array<{ name: string; url: string }>;
}) {
  return (
    <PageStructuredData
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: item.url,
        })),
      }}
    />
  );
}

export function MarketingHero({
  eyebrow,
  title,
  description,
  cta,
  ctaHref = marketingHeroDefaults.ctaHref,
  secondaryCta = marketingHeroDefaults.secondaryCta,
  sceneLabel,
  sceneFocus,
}: {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  ctaHref?: string;
  secondaryCta?: { label: string; href: string } | null;
  sceneLabel?: string;
  sceneFocus?: string;
}) {
  return (
    <section className="relative min-h-[620px] overflow-hidden border-b border-border px-6 py-24 sm:py-28 lg:min-h-[660px]">
      <ProductScene label={sceneLabel} focus={sceneFocus} />
      <div className="absolute inset-0 z-[3] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg)_18%,transparent),var(--bg)_94%)]" aria-hidden />
      <div className="relative z-[4] mx-auto flex min-h-[430px] max-w-7xl items-end">
        <ScrollReveal>
          <div className="max-w-[42rem] pb-2 sm:max-w-[46rem] lg:max-w-[47rem]">
            <p className="mb-4 text-xs font-medium uppercase tracking-widest text-accent">{eyebrow}</p>
            <h1 className="text-4xl font-bold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">{title}</h1>
            <div className="draw-line mt-5" />
            <p className="mt-6 max-w-2xl text-base leading-8 text-text-secondary sm:text-lg">{description}</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild variant="primary" size="lg" className="btn-lift">
                <Link href={ctaHref} prefetch={ctaHref === "/signup" ? false : undefined}>
                  {cta}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              {secondaryCta ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export function MarketingNextSteps({
  title = marketingNextStepsDefaults.title,
  description = marketingNextStepsDefaults.description,
  steps,
}: {
  title?: string;
  description?: string;
  steps: MarketingNextStep[];
}) {
  return (
    <section className="border-t border-border px-6 py-14">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="grid gap-4 md:grid-cols-[0.75fr_1.25fr] md:items-end">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-accent">Next steps</p>
              <h2 className="mt-3 text-2xl font-semibold text-text-primary sm:text-3xl">{title}</h2>
            </div>
            {description ? (
              <p className="max-w-2xl text-sm leading-7 text-text-secondary">{description}</p>
            ) : null}
          </div>
        </ScrollReveal>
        <div className="mt-8 grid gap-px bg-border md:grid-cols-3">
          {steps.map((step, index) => (
            <ScrollReveal key={step.href} stagger={index}>
              <Link
                href={step.href}
                prefetch={step.href === "/signup" ? false : undefined}
                className="group block h-full bg-bg px-4 py-5 transition-colors hover:bg-surface"
              >
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted">{step.eyebrow}</p>
                <h3 className="mt-3 text-base font-semibold text-text-primary">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{step.description}</p>
                <p className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  {step.action}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                </p>
              </Link>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingIndexPage({
  eyebrow,
  title,
  description,
  pages,
  sectionTitle,
  basePath,
  listHeading = marketingIndexDefaults.listHeading,
  listDescription = marketingIndexDefaults.listDescription,
}: {
  eyebrow: string;
  title: string;
  description: string;
  pages: MarketingPage[];
  sectionTitle: string;
  basePath: "/features" | "/use-cases";
  listHeading?: string;
  listDescription?: string;
}) {
  const secondaryCta =
    basePath === "/features"
      ? { label: "Browse use cases", href: "/use-cases" }
      : { label: "Compare features", href: "/features" };

  return (
    <PublicPageShell>
      <MarketingHero
        eyebrow={eyebrow}
        title={title}
        description={description}
        cta="Start setup"
        secondaryCta={secondaryCta}
        sceneLabel={sectionTitle}
        sceneFocus="Public product map"
      />
      <section className="px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-7xl">
          <ScrollReveal>
            <div className="mb-12 max-w-2xl">
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-accent">{sectionTitle}</p>
              <h2 className="text-3xl font-semibold sm:text-4xl">{listHeading}</h2>
              <p className="mt-4 text-sm leading-7 text-text-secondary">
                {listDescription}
              </p>
            </div>
          </ScrollReveal>
          <div className="grid gap-5 md:grid-cols-2">
            {pages.map((page, index) => {
              const Icon = iconMap[page.icon];
              const href = `${basePath}/${page.slug}`;

              return (
                <ScrollReveal key={page.slug} stagger={index}>
                  <Link
                    href={href}
                    className="group block min-h-[245px] border border-border bg-surface p-6 transition-[background-color,border-color,transform,box-shadow] duration-200 hover:-translate-y-1 hover:border-accent/40 hover:bg-surface-raised hover:shadow-xl hover:shadow-black/10 motion-reduce:transition-none"
                    style={{ borderRadius: 8 }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <span className="flex h-10 w-10 items-center justify-center border border-border bg-bg text-accent transition-transform duration-200 group-hover:-translate-y-0.5" style={{ borderRadius: 6 }}>
                        <Icon className="h-5 w-5" />
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted transition-transform duration-200 group-hover:translate-x-1 group-hover:text-accent" />
                    </div>
                    <p className="mt-6 text-xs font-medium uppercase tracking-widest text-accent">{page.eyebrow}</p>
                    <h3 className="mt-3 text-xl font-semibold text-text-primary">{page.title}</h3>
                    <p className="mt-3 text-sm leading-6 text-text-secondary">{page.description}</p>
                  </Link>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
      </section>
      <MarketingNextSteps steps={nextStepsForIndex(basePath)} />
    </PublicPageShell>
  );
}

export function MarketingDetailPage({
  page,
  relatedPages,
  basePath,
  detailEyebrow = marketingDetailPageDefaults.detailEyebrow,
  detailHeading = marketingDetailPageDefaults.detailHeading,
  detailDescription = marketingDetailPageDefaults.detailDescription,
  relatedEyebrow = marketingDetailPageDefaults.relatedEyebrow,
  relatedHeading = marketingDetailPageDefaults.relatedHeading,
  relatedActionLabel = marketingDetailPageDefaults.relatedActionLabel,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
  basePath: "/features" | "/use-cases" | "/explore";
  detailEyebrow?: string;
  detailHeading?: string;
  detailDescription?: string;
  relatedEyebrow?: string;
  relatedHeading?: string;
  relatedActionLabel?: string;
}) {
  const Icon = iconMap[page.icon];

  return (
    <PublicPageShell>
      <MarketingHero
        eyebrow={page.eyebrow}
        title={page.title}
        description={page.summary}
        cta={page.primaryAction}
        ctaHref="#page-details"
        sceneLabel={page.eyebrow}
        sceneFocus="Workflow detail"
      />
      <section className="border-b border-border px-6 py-16">
        <div className="mx-auto grid max-w-7xl gap-4 md:grid-cols-3">
          {page.proof.map((item, index) => (
            <ScrollReveal key={item.label} stagger={index}>
              <div className="border-t border-border py-6">
                <p className="text-xs font-medium uppercase tracking-widest text-accent">{item.label}</p>
                <p className="mt-3 font-mono text-4xl font-semibold text-text-primary">{item.value}</p>
                <p className="mt-2 text-sm text-text-secondary">{item.detail}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </section>
      <section id="page-details" className="scroll-mt-24 px-6 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.8fr_1.2fr]">
          <ScrollReveal>
            <div className="sticky top-28">
              <Icon className="mb-5 h-8 w-8 text-accent" />
              <p className="text-xs font-medium uppercase tracking-widest text-accent">{detailEyebrow}</p>
              <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">
                {detailHeading}
              </h2>
              <p className="mt-5 text-sm leading-7 text-text-secondary">
                {detailDescription}
              </p>
            </div>
          </ScrollReveal>
          <div className="border-t border-border">
            {page.sections.map((section, index) => (
              <ScrollReveal key={section.title} stagger={index}>
                <article className="grid gap-6 border-b border-border py-9 md:grid-cols-[0.8fr_1.2fr]">
                  <div>
                    <p className="font-mono text-xs text-muted">{String(index + 1).padStart(2, "0")}</p>
                    <h3 className="mt-3 text-xl font-semibold">{section.title}</h3>
                    <p className="mt-3 text-sm leading-6 text-text-secondary">{section.description}</p>
                  </div>
                  <ul className="space-y-3">
                    {section.bullets.map((bullet) => (
                      <li key={bullet} className="flex gap-3 text-sm leading-6 text-text-secondary">
                        <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-success" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>
      <section className="border-t border-border bg-surface px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <ScrollReveal>
            <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-widest text-accent">{relatedEyebrow}</p>
                <h2 className="mt-3 text-3xl font-semibold">{relatedHeading}</h2>
              </div>
              <Button asChild variant="secondary">
                <Link href={basePath}>{relatedActionLabel}</Link>
              </Button>
            </div>
          </ScrollReveal>
          <div className="grid gap-4 md:grid-cols-3">
            {relatedPages.map((related, index) => {
              const RelatedIcon = iconMap[related.icon];

              return (
                <ScrollReveal key={related.slug} stagger={index}>
                  <Link href={related.href} className="group block border border-border bg-bg p-5 hover:border-accent/40 hover:bg-surface-raised" style={{ borderRadius: 8 }}>
                    <RelatedIcon className="h-5 w-5 text-accent" />
                    <h3 className="mt-4 font-semibold">{related.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">{related.description}</p>
                  </Link>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
      </section>
      <MarketingNextSteps
        title={marketingDetailNextStepsDefaults.title}
        description={marketingDetailNextStepsDefaults.description}
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
