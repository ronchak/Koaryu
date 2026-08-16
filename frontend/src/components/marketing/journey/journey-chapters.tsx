import Link from "next/link";

import {
  landingPageContent,
  type JourneyAboutChapter,
  type JourneyChapter,
  type JourneyExploreChapter,
  type JourneyFaqChapter,
  type JourneyFeaturesChapter,
  type JourneyFinalChapter,
  type JourneyHeroChapter,
  type JourneyMorningChapter,
  type JourneyPricingChapter,
  type JourneyProblemChapter,
  type JourneyProductIntroChapter,
  type JourneyTransitionChapter,
  type JourneyUseCasesChapter,
} from "../../../lib/landing-page-content.ts";
import { MarketingActionLink } from "../marketing-primitives";
import { FAQ_HASHES } from "./interaction-model";
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
      <p className={styles.scrollHint}>Scroll once</p>
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

function MorningChapter({ chapter }: { chapter: JourneyMorningChapter }) {
  return (
    <article className={`${styles.plane} ${styles.morningPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.title}</h2>
      <p className={styles.lede}>{chapter.lede}</p>
      <div className={styles.proofBlock}>
        <p className={styles.rowLabel}>{chapter.proofLabel}</p>
        <p>{chapter.proof}</p>
      </div>
    </article>
  );
}

function ProductIntroChapter({
  chapter,
}: {
  chapter: JourneyProductIntroChapter;
}) {
  return (
    <article className={`${styles.framedPlane} ${styles.darkPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.title}</h2>
      <p className={styles.lede}>{chapter.lede}</p>
    </article>
  );
}

function FeaturesChapter({ chapter }: { chapter: JourneyFeaturesChapter }) {
  return (
    <article className={`${styles.plane} ${styles.ledgerPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.heading}</h2>
      <p className={`${styles.lede} ${styles.supportingLede}`}>{chapter.lede}</p>
      <ul className={styles.ledgerList}>
        {chapter.rows.map((row) => (
          <li key={row.detail.href} className={styles.ledgerRow}>
            <h3>
              <Link href={row.detail.href}>{row.title}</Link>
            </h3>
            <p>{row.description}</p>
          </li>
        ))}
      </ul>
      <Link className={styles.planeLink} href={chapter.link.href}>
        {chapter.link.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

function UseCasesChapter({ chapter }: { chapter: JourneyUseCasesChapter }) {
  return (
    <article className={`${styles.plane} ${styles.bandPlane}`}>
      <div className={styles.bandHeading}>
        <div>
          <p className={styles.kicker}>{chapter.kicker}</p>
          <h2 className={styles.planeHeading}>{chapter.heading}</h2>
        </div>
        <Link className={styles.planeLink} href={chapter.link.href}>
          {chapter.link.label} <span aria-hidden="true">→</span>
        </Link>
      </div>
      <ul className={styles.bandList}>
        {chapter.rows.map((row) => (
          <li key={row.detail.href} className={styles.bandRow}>
            <h3>
              <Link href={row.detail.href}>{row.title}</Link>
            </h3>
            <p>{row.description}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function TransitionChapter({
  chapter,
}: {
  chapter: JourneyTransitionChapter;
}) {
  return (
    <div className={styles.transitionCopy}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.statementHeading}>{chapter.title}</h2>
      {chapter.lede ? <p className={styles.lede}>{chapter.lede}</p> : null}
    </div>
  );
}

function ExploreChapter({ chapter }: { chapter: JourneyExploreChapter }) {
  return (
    <article className={`${styles.plane} ${styles.mapPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.heading}</h2>
      <ul className={styles.routeList}>
        {chapter.routes.map((route) => (
          <li key={route.href} className={styles.routeRow}>
            <Link href={route.href}>
              <span>
                <strong>{route.title}</strong>
                <span>{route.body}</span>
                <small>{route.meta}</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link className={styles.planeLink} href={chapter.link.href}>
        {chapter.link.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

function PricingChapter({ chapter }: { chapter: JourneyPricingChapter }) {
  return (
    <article className={`${styles.plane} ${styles.pricePlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.heading}</h2>
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
    </article>
  );
}

function AboutChapter({ chapter }: { chapter: JourneyAboutChapter }) {
  return (
    <article className={`${styles.plane} ${styles.aboutPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.heading}</h2>
      <p className={`${styles.lede} ${styles.supportingLede}`}>{chapter.lede}</p>
      <dl className={styles.statementList}>
        {chapter.principles.map((principle) => (
          <div key={principle.title}>
            <dt>{principle.title}</dt>
            <dd>{principle.description}</dd>
          </div>
        ))}
      </dl>
      <Link className={styles.planeLink} href={chapter.link.href}>
        {chapter.link.label} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

function FaqChapter({ chapter }: { chapter: JourneyFaqChapter }) {
  return (
    <div className={styles.faqShell}>
      <nav className={styles.faqIndex} aria-label="FAQ topics">
        {chapter.groups.map((group, groupIndex) => (
          <Link
            key={group.title}
            href={`#${FAQ_HASHES[groupIndex]}`}
            data-faq-topic={groupIndex}
          >
            {group.title}
          </Link>
        ))}
      </nav>
      <div
        className={`${styles.plane} ${styles.faqPanel}`}
        tabIndex={0}
        data-faq-scroll=""
        aria-label="Questions and answers"
      >
        {chapter.groups.map((group, groupIndex) => (
          <section
            key={group.title}
            id={FAQ_HASHES[groupIndex]}
            className={styles.faqGroup}
            data-faq-group={groupIndex}
          >
            <p className={styles.kicker}>{chapter.kicker}</p>
            <h2 className={styles.planeHeading}>{group.title}</h2>
            <div className={styles.faqList}>
              {group.items.map((item, itemIndex) => {
                const answerId = `faq-answer-${groupIndex}-${itemIndex}`;
                return (
                  <div
                    key={item.question}
                    className={styles.faqItem}
                    data-faq-item={`${groupIndex}-${itemIndex}`}
                  >
                    <button
                      type="button"
                      className={styles.faqQuestion}
                      data-faq-question={`${groupIndex}-${itemIndex}`}
                      aria-expanded="true"
                      aria-controls={answerId}
                    >
                      <span>{item.question}</span>
                      <span className={styles.faqIcon} aria-hidden="true">
                        +
                      </span>
                    </button>
                    <div
                      id={answerId}
                      className={styles.faqAnswer}
                      data-faq-answer=""
                    >
                      <p>{item.answer}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function FinalChapter({ chapter }: { chapter: JourneyFinalChapter }) {
  return (
    <article className={`${styles.framedPlane} ${styles.finalPlane}`}>
      <p className={styles.kicker}>{chapter.kicker}</p>
      <h2 className={styles.planeHeading}>{chapter.title}</h2>
      <p className={styles.lede}>{chapter.lede}</p>
      <div className={styles.actions}>
        <ChapterAction {...chapter.action} variant="primary" />
      </div>
      <nav className={styles.finalLinks} aria-label="Footer">
        {chapter.footerLinks.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
      <p className={styles.copyright}>{chapter.copyright}</p>
    </article>
  );
}

function ChapterContent({ chapter }: { chapter: JourneyChapter }) {
  switch (chapter.kind) {
    case "hero":
      return <HeroChapter chapter={chapter} />;
    case "problem":
      return <ProblemChapter chapter={chapter} />;
    case "morning":
      return <MorningChapter chapter={chapter} />;
    case "product-intro":
      return <ProductIntroChapter chapter={chapter} />;
    case "features":
      return <FeaturesChapter chapter={chapter} />;
    case "use-cases":
      return <UseCasesChapter chapter={chapter} />;
    case "transition":
      return <TransitionChapter chapter={chapter} />;
    case "explore":
      return <ExploreChapter chapter={chapter} />;
    case "pricing":
      return <PricingChapter chapter={chapter} />;
    case "about":
      return <AboutChapter chapter={chapter} />;
    case "faq":
      return <FaqChapter chapter={chapter} />;
    case "final":
      return <FinalChapter chapter={chapter} />;
  }
}

export function JourneyChapters() {
  return (
    <main className={styles.storyRegion}>
      {landingPageContent.chapters.map((chapter, index) => (
        <section
          key={chapter.id}
          id={chapter.id}
          className={styles.chapter}
          data-journey-chapter=""
          data-chapter-id={chapter.id}
          data-chapter-index={index}
          data-kind={chapter.kind}
          data-ink={chapter.ink}
          data-placement={"placement" in chapter ? chapter.placement : undefined}
          aria-label={`Chapter ${index + 1} of ${landingPageContent.chapters.length}`}
        >
          <ChapterContent chapter={chapter} />
        </section>
      ))}
    </main>
  );
}
