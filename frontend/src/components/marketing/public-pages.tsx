import Link from "next/link";

import {
  MarketingActionLink,
  MarketingBrandLink,
  MarketingNavLink,
} from "@/components/marketing/marketing-primitives";
import { MarketingRoot } from "@/components/marketing/marketing-root";
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

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <MarketingBrandLink href="/" className={styles.brand} />
        <nav className={styles.primaryNavigation} aria-label="Primary navigation">
          {publicNavLinks.map((link) => (
            <MarketingNavLink key={link.href} href={link.href}>
              {link.label}
            </MarketingNavLink>
          ))}
        </nav>
        <nav className={styles.accountNavigation} aria-label="Account navigation">
          <MarketingNavLink href="/login" prefetch={false}>
            Sign in
          </MarketingNavLink>
          <MarketingActionLink href="/signup" prefetch={false}>
            Start setup
          </MarketingActionLink>
        </nav>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerStatement}>
          <MarketingBrandLink href="/" className={styles.brand} />
          <p>Flat-rate studio software for independent martial arts schools.</p>
        </div>
        <nav className={styles.footerNavigation} aria-label="Footer navigation">
          {publicFooterLinks.map((link) => (
            <MarketingNavLink key={link.href} href={link.href}>
              {link.label}
            </MarketingNavLink>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function PublicPageShell({ children }: { children: React.ReactNode }) {
  return (
    <MarketingRoot layout="document" className={styles.shell}>
      <MarketingHeader />
      <main className={styles.main}>{children}</main>
      <MarketingFooter />
    </MarketingRoot>
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
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroStatement}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
        </div>
        <div className={styles.heroSupport}>
          <p className={styles.heroDescription}>{description}</p>
          <div className={styles.heroActions}>
            <MarketingActionLink
              href={ctaHref}
              prefetch={ctaHref === "/signup" ? false : undefined}
            >
              {cta}
            </MarketingActionLink>
            {secondaryCta ? (
              <MarketingActionLink href={secondaryCta.href} variant="secondary">
                {secondaryCta.label}
              </MarketingActionLink>
            ) : null}
          </div>
        </div>
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
    <section className={styles.nextSteps} aria-labelledby="marketing-next-steps">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Next steps</p>
          <h2 id="marketing-next-steps">{title}</h2>
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      <ul className={styles.routeList}>
        {steps.map((step) => (
          <li key={step.href}>
            <MarketingNavLink
              href={step.href}
              prefetch={step.href === "/signup" ? false : undefined}
              className={styles.routeLink}
            >
              <span className={styles.routeMeta}>{step.eyebrow}</span>
              <span className={styles.routeCopy}>
                <strong>{step.title}</strong>
                <span>{step.description}</span>
              </span>
              <span className={styles.routeAction}>
                {step.action} <span aria-hidden="true">→</span>
              </span>
            </MarketingNavLink>
          </li>
        ))}
      </ul>
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
      <section className={styles.indexSection} aria-labelledby="marketing-index">
        <div className={styles.indexHeading}>
          <p className={styles.eyebrow}>{sectionTitle}</p>
          <h2 id="marketing-index">{listHeading}</h2>
          <p>{listDescription}</p>
        </div>
        <ul className={styles.ledger}>
          {pages.map((page) => {
            const href = `${basePath}/${page.slug}`;

            return (
              <li key={page.slug}>
                <MarketingNavLink href={href} className={styles.ledgerLink}>
                  <span className={styles.ledgerMeta}>{page.eyebrow}</span>
                  <span className={styles.ledgerCopy}>
                    <strong>{page.title}</strong>
                    <span>{page.description}</span>
                  </span>
                  <span className={styles.ledgerAction} aria-hidden="true">
                    →
                  </span>
                </MarketingNavLink>
              </li>
            );
          })}
        </ul>
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
      <section className={styles.proofBand} aria-label="Product proof">
        <dl>
          {page.proof.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                <strong>{item.value}</strong>
                <span>{item.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        id="page-details"
        className={styles.detailSection}
        aria-labelledby="detail-heading"
      >
        <div className={styles.detailHeading}>
          <p className={styles.eyebrow}>{detailEyebrow}</p>
          <h2 id="detail-heading">{detailHeading}</h2>
          <p>{detailDescription}</p>
        </div>
        <div className={styles.detailArticles}>
          {page.sections.map((section) => (
            <article key={section.title}>
              <div>
                <h3>{section.title}</h3>
                <p>{section.description}</p>
              </div>
              <ul>
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.relatedSection} aria-labelledby="related-heading">
        <div className={styles.relatedHeading}>
          <div>
            <p className={styles.eyebrow}>{relatedEyebrow}</p>
            <h2 id="related-heading">{relatedHeading}</h2>
          </div>
          <MarketingActionLink href={basePath} variant="secondary">
            {relatedActionLabel}
          </MarketingActionLink>
        </div>
        <ul className={styles.relatedList}>
          {relatedPages.map((related) => (
            <li key={related.slug}>
              <Link href={related.href} className={styles.relatedLink}>
                <strong>{related.title}</strong>
                <span>{related.description}</span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <MarketingNextSteps
        title={marketingDetailNextStepsDefaults.title}
        description={marketingDetailNextStepsDefaults.description}
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
