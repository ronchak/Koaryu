import Image from "next/image";
import Link from "next/link";

import {
  landingPageContent,
  type JourneyChapter,
  type JourneyFaqChapter,
  type JourneyFeaturesChapter,
  type JourneyFinalChapter,
  type JourneyHeroChapter,
  type JourneyPricingChapter,
  type JourneyProblemChapter,
  type JourneyProductChapter,
} from "../../../lib/landing-page-content.ts";
import { MarketingActionLink } from "../marketing-primitives";
import styles from "./journey.module.css";

function actionPrefetch(href: string): false | undefined {
  return href === "/signup" || href === "/login" ? false : undefined;
}

function ChapterAction({
  href,
  label,
  variant = "secondary",
}: {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <MarketingActionLink
      href={href}
      prefetch={actionPrefetch(href)}
      variant={variant}
      className={styles.action}
    >
      {label}
    </MarketingActionLink>
  );
}

function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className={styles.textLink} href={href}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  );
}

function HeroChapter({ chapter }: { chapter: JourneyHeroChapter }) {
  return (
    <div className={styles.heroCopy}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h1 className={styles.heroHeading}>
        {chapter.headline.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </h1>
      <p className={styles.lede}>{chapter.lede}</p>
      <div className={styles.actions}>
        <ChapterAction {...chapter.actions[0]} variant="primary" />
        <ChapterAction {...chapter.actions[1]} />
      </div>
    </div>
  );
}

function ProblemChapter({ chapter }: { chapter: JourneyProblemChapter }) {
  return (
    <div className={styles.problemCopy}>
      <h2 className={styles.statementHeading}>{chapter.title}</h2>
      <div className={styles.problemResponse}>
        <p>{chapter.question}</p>
        <p className={styles.problemAside}>{chapter.aside}</p>
      </div>
    </div>
  );
}

function ProductChapter({ chapter }: { chapter: JourneyProductChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.productSheet}`}>
      <div className={styles.productCopy}>
        <p className={styles.kicker}>{chapter.kicker}</p>
        <h2 className={styles.sheetHeading}>{chapter.title}</h2>
        <p className={styles.lede}>{chapter.lede}</p>
        <dl className={styles.highlights}>
          {chapter.highlights.map((highlight) => (
            <div key={highlight.label}>
              <dt>{highlight.label}</dt>
              <dd>{highlight.description}</dd>
            </div>
          ))}
        </dl>
      </div>
      <figure className={styles.productFigure}>
        <div className={styles.productFrame}>
          <Image
            src={chapter.image.src}
            width={chapter.image.width}
            height={chapter.image.height}
            alt={chapter.image.alt}
            sizes="(max-width: 820px) 92vw, 760px"
          />
        </div>
        <figcaption>{chapter.image.caption}</figcaption>
      </figure>
    </article>
  );
}

function FeaturesChapter({ chapter }: { chapter: JourneyFeaturesChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.featuresSheet}`}>
      <header className={styles.sheetHeader}>
        <div>
          <p className={styles.kicker}>{chapter.kicker}</p>
          <h2 className={styles.sheetHeading}>{chapter.title}</h2>
        </div>
        <p className={styles.lede}>{chapter.lede}</p>
      </header>
      <ul className={styles.featureGrid}>
        {chapter.rows.map((row) => (
          <li key={row.detail.href}>
            <h3>
              <Link href={row.detail.href}>{row.title}</Link>
            </h3>
            <p>{row.description}</p>
          </li>
        ))}
      </ul>
      <nav className={styles.sheetLinks} aria-label="Product guides">
        {chapter.links.map((link) => (
          <TextLink key={link.href} {...link} />
        ))}
      </nav>
    </article>
  );
}

function PricingChapter({ chapter }: { chapter: JourneyPricingChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.priceSheet}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.sheetHeading}>{chapter.title}</h2>
      <p className={styles.price} data-price-amount={chapter.amount}>
        {chapter.displayPrice}
      </p>
      <p className={styles.pricePeriod}>{chapter.period}</p>
      <dl className={styles.priceFacts}>
        {chapter.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.description}</dd>
          </div>
        ))}
      </dl>
      <ChapterAction {...chapter.setupAction} variant="primary" />
      <p className={styles.priceNote}>
        Collecting tuition online? See <Link href="#faq-pricing">Pricing &amp; payments</Link>.
      </p>
    </article>
  );
}

function FaqChapter({ chapter }: { chapter: JourneyFaqChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.faqSheet}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.sheetHeading}>{chapter.title}</h2>
      <div className={styles.faqGroups}>
        {chapter.groups.map((group) => (
          <section key={group.id} id={group.id} className={styles.faqGroup}>
            <h3>{group.title}</h3>
            {group.items.map((item) => (
              <details key={item.question} className={styles.faqItem}>
                <summary>
                  <span>{item.question}</span>
                  <span className={styles.faqIcon} aria-hidden="true" />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}

function FinalChapter({ chapter }: { chapter: JourneyFinalChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.finalSheet}`}>
      <h2 className={styles.sheetHeading}>{chapter.title}</h2>
      <p className={styles.lede}>{chapter.lede}</p>
      <div className={styles.actions}>
        <ChapterAction {...chapter.action} variant="primary" />
      </div>
      <footer className={styles.footer}>
        <nav aria-label="Footer">
          {chapter.footerLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <p>{chapter.copyright}</p>
      </footer>
    </article>
  );
}

function ChapterContent({ chapter }: { chapter: JourneyChapter }) {
  switch (chapter.kind) {
    case "hero":
      return <HeroChapter chapter={chapter} />;
    case "problem":
      return <ProblemChapter chapter={chapter} />;
    case "product":
      return <ProductChapter chapter={chapter} />;
    case "features":
      return <FeaturesChapter chapter={chapter} />;
    case "pricing":
      return <PricingChapter chapter={chapter} />;
    case "faq":
      return <FaqChapter chapter={chapter} />;
    case "final":
      return <FinalChapter chapter={chapter} />;
  }
}

export function JourneyChapters() {
  return (
    <main id="main-content" tabIndex={-1} className={styles.storyRegion}>
      {landingPageContent.chapters.map((chapter) => (
        <section
          key={chapter.id}
          id={chapter.id}
          className={styles.chapter}
          data-journey-chapter=""
          data-chapter-id={chapter.id}
          data-kind={chapter.kind}
          data-ink={chapter.ink}
          data-scene={chapter.scene}
          aria-label={chapter.kind === "hero" ? undefined : chapter.title}
        >
          <ChapterContent chapter={chapter} />
        </section>
      ))}
    </main>
  );
}
