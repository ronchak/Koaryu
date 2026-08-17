import type { Metadata } from "next";
import Link from "next/link";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import {
  BreadcrumbJsonLd,
  detailNextSteps,
  MarketingNextSteps,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import styles from "@/components/marketing/public-pages.module.css";
import { APP_NAME } from "@/lib/constants";
import {
  exploreSections,
  getMarketingPageByRef,
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

      <section className={styles.exploreHero}>
        <div className={styles.exploreHeroInner}>
          <div className={styles.exploreHeroStatement}>
            <p className={styles.eyebrow}>Explore Koaryu</p>
            <h1>Find the page that matches what you need to understand.</h1>
          </div>
          <div className={styles.exploreHeroSupport}>
            <p className={styles.exploreHeroDescription}>
              Koaryu has product pages, use-case pages, and studio-fit pages.
              This guide keeps them in one place so an owner can start with a
              question instead of guessing which page matters.
            </p>
            <div className={styles.editorialActions}>
              <MarketingActionLink href="/features">
                Compare features
              </MarketingActionLink>
              <MarketingActionLink href="/use-cases" variant="secondary">
                Browse use cases
              </MarketingActionLink>
            </div>
          </div>
        </div>
      </section>

      <div className={styles.exploreDirectory}>
        {exploreSections.map((section, sectionIndex) => (
          <section
            key={section.title}
            className={styles.exploreIntent}
            aria-labelledby={`explore-intent-${sectionIndex}`}
          >
            <header className={styles.exploreIntentHeading}>
              <h2 id={`explore-intent-${sectionIndex}`}>{section.title}</h2>
              <p>{section.description}</p>
            </header>
            <ul className={styles.exploreRouteList}>
              {section.paths.map((path) => {
                const includedPages = path.pages.flatMap((pageRef) => {
                  const page = getMarketingPageByRef(pageRef);
                  return page ? [page] : [];
                });

                return (
                  <li key={path.href}>
                    <Link href={path.href} className={styles.exploreRouteLink}>
                      <span className={styles.exploreRouteMeta}>
                        {path.eyebrow}
                      </span>
                      <span className={styles.exploreRouteCopy}>
                        <strong>{path.title}</strong>
                        <span>{path.description}</span>
                      </span>
                      <span className={styles.exploreRouteContext}>
                        {includedPages.length > 0 ? (
                          <span className={styles.exploreIncludedBlock}>
                            <span className={styles.exploreIncludedLabel}>
                              Included pages
                            </span>
                            <span className={styles.exploreIncludedList}>
                              {includedPages.map((page) => (
                                <span key={page.href}>
                                  <span>{page.eyebrow}</span>
                                  <span>{page.title}</span>
                                </span>
                              ))}
                            </span>
                          </span>
                        ) : null}
                        <span className={styles.exploreRouteAction}>
                          {path.action} <span aria-hidden="true">→</span>
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <MarketingNextSteps
        title="Move from browsing to a useful next page"
        description="Explore is a directory. The next page should either explain a product area, a studio workflow, or the setup path."
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
