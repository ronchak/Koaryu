import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Compass, Map, Sparkles } from "lucide-react";
import {
  BreadcrumbJsonLd,
  detailNextSteps,
  MarketingNextSteps,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import { ScrollReveal } from "@/components/scroll-reveal";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/constants";
import {
  exploreSections,
  getMarketingPageByRef,
  type MarketingPage,
} from "@/lib/marketing-pages";

export const metadata: Metadata = {
  title: "Explore Koaryu | Martial Arts Studio Software Guide",
  description:
    "A quiet guide to Koaryu's feature pages, studio workflows, and fit for independent martial arts schools.",
  alternates: { canonical: "https://koaryu.app/explore" },
  openGraph: {
    title: "Explore Koaryu | Martial Arts Studio Software Guide",
    description:
      "Find the Koaryu product page, use case, or studio path that matches what you are trying to understand.",
    url: "https://koaryu.app/explore",
  },
};

const sectionIcons = [Compass, Map, Sparkles];

export default function ExplorePage() {
  return (
    <PublicPageShell>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "Explore", url: "https://koaryu.app/explore" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "Explore Koaryu",
          description:
            "A guide to Koaryu feature pages, use cases, and studio-fit pages.",
          url: "https://koaryu.app/explore",
          isPartOf: {
            "@type": "WebSite",
            name: APP_NAME,
            url: "https://koaryu.app/",
          },
        }}
      />

      <section className="border-b border-border px-6 py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-end">
          <ScrollReveal>
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-accent">Explore Koaryu</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-text-primary sm:text-5xl">
                Find the page that matches what you need to understand.
              </h1>
            </div>
          </ScrollReveal>
          <ScrollReveal>
            <div className="border-l border-border pl-6">
              <p className="text-sm leading-7 text-text-secondary">
                Koaryu has product pages, use-case pages, and studio-fit pages.
                This guide keeps them in one place so an owner can start with a
                question instead of guessing which page matters.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild variant="primary" className="btn-lift">
                  <Link href="/features">
                    Compare features
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/use-cases">Browse use cases</Link>
                </Button>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section className="px-6 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl space-y-14">
          {exploreSections.map((section, sectionIndex) => {
            const Icon = sectionIcons[sectionIndex] ?? Compass;

            return (
              <section key={section.title} aria-labelledby={`explore-${sectionIndex}`}>
                <ScrollReveal>
                  <div className="mb-6 grid gap-5 md:grid-cols-[260px_1fr] md:items-start">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center border border-border bg-surface text-accent" style={{ borderRadius: 6 }}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <h2 id={`explore-${sectionIndex}`} className="text-xl font-semibold text-text-primary">
                        {section.title}
                      </h2>
                    </div>
                    <p className="max-w-2xl text-sm leading-7 text-text-secondary">
                      {section.description}
                    </p>
                  </div>
                </ScrollReveal>

                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {section.paths.map((path, index) => {
                    const includedPages = path.pages
                      .map(getMarketingPageByRef)
                      .filter((page): page is MarketingPage => Boolean(page))
                      .slice(0, 4);

                    return (
                      <ScrollReveal key={path.href} stagger={index}>
                        <Link
                          href={path.href}
                          className="group block h-full border border-border bg-surface p-5 transition-[background-color,border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-surface-raised hover:shadow-lg hover:shadow-black/10 motion-reduce:transition-none"
                          style={{ borderRadius: 8 }}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <p className="text-xs font-medium uppercase tracking-widest text-accent">{path.eyebrow}</p>
                            <ArrowRight className="h-4 w-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                          </div>
                          <h3 className="mt-4 text-lg font-semibold text-text-primary">{path.title}</h3>
                          <p className="mt-3 text-sm leading-6 text-text-secondary">{path.description}</p>
                          {includedPages.length > 0 ? (
                            <div className="mt-5 border-t border-border pt-4">
                              <p className="text-[11px] font-medium uppercase tracking-widest text-muted">Includes</p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {includedPages.map((page) => (
                                  <span key={page.href} className="rounded-[4px] border border-border bg-bg px-2 py-1 text-xs text-text-secondary">
                                    {page.eyebrow}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          <p className="mt-5 text-sm font-medium text-accent">{path.action}</p>
                        </Link>
                      </ScrollReveal>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </section>
      <MarketingNextSteps
        title="Move from browsing to a useful next page"
        description="Explore is a directory. The next page should either explain a product area, a studio workflow, or the setup path."
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
