import Image from "next/image";
import Link from "next/link";
import { Fragment, type CSSProperties } from "react";

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

/** Sets each sentence of a short title on its own line ("One price." / "Every student."). */
function SentenceLines({ text }: { text: string }) {
  return text.split(/(?<=\.)\s+/).map((line) => (
    <span key={line} className={styles.line}>
      {line}
    </span>
  ));
}

function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className={styles.textLink} href={href}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  );
}

/** Hero copy arrives in a short stagger on load and drifts away as the camera dives. */
function HeroChapter({ chapter }: { chapter: JourneyHeroChapter }) {
  return (
    <div className={styles.heroCopy}>
      <p className={styles.heroKicker}>{chapter.kicker}</p>
      <h1 className={styles.heroHeading}>
        {chapter.headline.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </h1>
      <p className={`${styles.lede} ${styles.heroLede}`}>{chapter.lede}</p>
      <div className={`${styles.actions} ${styles.heroActions}`}>
        <ChapterAction {...chapter.actions[0]} variant="primary" />
        <ChapterAction {...chapter.actions[1]} />
      </div>
    </div>
  );
}

function ProblemChapter({ chapter }: { chapter: JourneyProblemChapter }) {
  return (
    <div className={`${styles.problemCopy} ${styles.reveal}`}>
      <h2 className={styles.statementHeading}>{chapter.title}</h2>
      <div className={styles.problemResponse}>
        <p>{chapter.question}</p>
        <p className={styles.problemAside}>{chapter.aside}</p>
      </div>
    </div>
  );
}

/** The real belt tracker: the desktop screen, with the phone layout standing in front of it. */
function ProductChapter({ chapter }: { chapter: JourneyProductChapter }) {
  const { image } = chapter;
  return (
    <div className={styles.productStage}>
      <article className={`${styles.sheet} ${styles.productSheet}`}>
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
      </article>
      <figure className={styles.productFigure}>
        <div className={styles.productScreens}>
          <div className={styles.productDesktop}>
            <Image
              src={image.src}
              width={image.width}
              height={image.height}
              alt={image.alt}
              sizes="(max-width: 820px) 150vw, 64vw"
            />
          </div>
          <div className={styles.productPhone}>
            <Image
              src={image.mobile.src}
              width={image.mobile.width}
              height={image.mobile.height}
              alt={image.mobile.alt}
              sizes="(max-width: 820px) 200px, 240px"
            />
          </div>
        </div>
        <figcaption className={styles.caption}>{image.caption}</figcaption>
      </figure>
    </div>
  );
}

/** Features told as a day at the studio; an ink line draws down the day as it is read. */
function FeaturesChapter({ chapter }: { chapter: JourneyFeaturesChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.daySheet}`}>
      <header className={styles.dayHeader}>
        <h2 className={styles.sheetHeading}>{chapter.title}</h2>
        <p className={styles.lede}>{chapter.lede}</p>
        <nav className={styles.dayLinks} aria-label="Product guides">
          {chapter.links.map((link) => (
            <TextLink key={link.href} {...link} />
          ))}
        </nav>
      </header>
      <ol className={styles.dayList}>
        {chapter.moments.map((moment) => (
          <li key={moment.title} className={styles.dayMoment}>
            <span className={styles.dayDot} aria-hidden="true" />
            <p className={styles.dayTime}>{moment.time}</p>
            <h3 className={styles.dayTitle}>
              <Link href={moment.detail.href}>{moment.title}</Link>
            </h3>
            <p className={styles.dayText}>{moment.description}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** The price stands in the open sky, without a card. */
function PricingChapter({ chapter }: { chapter: JourneyPricingChapter }) {
  return (
    <div className={`${styles.priceCopy} ${styles.reveal}`}>
      <div className={styles.priceLead}>
        <h2 className={styles.statementHeading}>
          <SentenceLines text={chapter.title} />
        </h2>
        <p className={styles.price} data-price-amount={chapter.amount}>
          {chapter.displayPrice}
          <span className={styles.pricePeriod}>{chapter.period}</span>
        </p>
      </div>
      <div className={styles.priceDetail}>
        <dl className={styles.priceFacts}>
          {chapter.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.description}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.actions}>
          <ChapterAction {...chapter.setupAction} variant="primary" />
        </div>
        <p className={styles.priceNote}>
          Collecting tuition online? See <Link href="#faq-pricing">Pricing &amp; payments</Link>.
        </p>
      </div>
    </div>
  );
}

function FaqChapter({ chapter }: { chapter: JourneyFaqChapter }) {
  return (
    <article className={`${styles.sheet} ${styles.faqSheet}`}>
      <h2 className={`${styles.sheetHeading} ${styles.revealRow}`}>{chapter.title}</h2>
      <div className={styles.faqGroups}>
        {chapter.groups.map((group) => (
          <section key={group.id} id={group.id} className={styles.faqGroup}>
            <h3 className={styles.revealRow}>{group.title}</h3>
            {group.items.map((item) => (
              <details key={item.question} className={`${styles.faqItem} ${styles.revealRow}`}>
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

/** The closing line is written on the dojo wall, above the seated class. */
function FinalChapter({ chapter }: { chapter: JourneyFinalChapter }) {
  return (
    <div className={styles.finalCopy}>
      <h2 className={styles.finalHeading}>
        <SentenceLines text={chapter.title} />
      </h2>
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
    </div>
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
        <Fragment key={chapter.id}>
          <section
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
          {"interludeAfter" in chapter && chapter.interludeAfter ? (
            <div
              className={styles.interlude}
              data-journey-interlude=""
              aria-hidden="true"
              style={{ "--interlude": chapter.interludeAfter } as CSSProperties}
            />
          ) : null}
        </Fragment>
      ))}
    </main>
  );
}
