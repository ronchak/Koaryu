import Image, { getImageProps } from "next/image";
import Link from "next/link";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { MarketingBrandLink } from "../marketing-primitives";
import { LandingAction } from "./actions";
import styles from "./landing.module.css";

/** The open sky from the story, as a quiet band between the product and the price. */
export function Breather() {
  return (
    <section className={styles.breather} aria-label="About Koaryu">
      <div className={styles.breatherArt} aria-hidden="true">
        <Image src="/marketing/scenes/sky-wide.webp" alt="" fill sizes="100vw" />
      </div>
      <p className={styles.breatherLine}>{landingPageContent.breather.line}</p>
    </section>
  );
}

/**
 * The price, big and plain, beside the plan as Koaryu itself would list it:
 * what is included, and the same bill at any roster size.
 */
export function Pricing() {
  const { pricing } = landingPageContent;
  return (
    <section id={pricing.id} className={styles.pricing} aria-labelledby="pricing-title">
      <div className={styles.pricingLead}>
        <h2 id="pricing-title" className={styles.sectionTitle}>
          {pricing.title}
        </h2>
        <p className={styles.price} data-price-amount={pricing.amount}>
          {pricing.displayPrice}
        </p>
        <p className={styles.pricePeriod}>{pricing.period}</p>
        <div className={styles.actions}>
          <LandingAction {...pricing.setupAction} variant="primary" />
        </div>
        <p className={styles.paymentsLink}>
          <Link href={pricing.paymentsLink.href}>{pricing.paymentsLink.label}</Link>
        </p>
      </div>
      <div className={styles.plan}>
        <div className={styles.planHeader}>
          <h3>Studio plan</h3>
          <p>One studio, every program</p>
        </div>
        <ul className={styles.included} aria-label="Included">
          {pricing.included.map((item) => (
            <li key={item}>
              <svg className={styles.includedGlyph} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.4 6.6 11.4 12.5 4.9" />
              </svg>
              {item}
            </li>
          ))}
        </ul>
        <div className={styles.register}>
          <p className={styles.registerLabel}>{pricing.note}</p>
          <dl>
            {pricing.rosterSizes.map((size) => (
              <div key={size}>
                <dt>{size} students</dt>
                <dd>{pricing.displayPrice}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/** The woven mat from the story, as a strip of floor before the questions. */
export function MatBand() {
  return (
    <div className={styles.matBand} aria-hidden="true">
      <Image src="/marketing/scenes/mat-wide.webp" alt="" fill sizes="100vw" />
    </div>
  );
}

export function Faq() {
  const { faq } = landingPageContent;
  return (
    <section id={faq.id} className={styles.faq} aria-labelledby="faq-title">
      <header className={styles.faqHeader}>
        <h2 id="faq-title" className={styles.sectionTitle}>
          {faq.title}
        </h2>
      </header>
      <div className={styles.faqGroups}>
        {faq.groups.map((group) => (
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
    </section>
  );
}

function FinaleArt() {
  const common = { alt: "", sizes: "100vw", quality: 80 } as const;
  const {
    props: { srcSet: wide },
  } = getImageProps({
    ...common,
    src: "/marketing/scenes/class-wide.webp",
    width: 3200,
    height: 2000,
  });
  const { props: tall } = getImageProps({
    ...common,
    src: "/marketing/scenes/class-tall.webp",
    width: 975,
    height: 2110,
  });
  return (
    <picture className={styles.finaleArt}>
      <source media="(min-aspect-ratio: 4/5)" srcSet={wide} />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative; alt is empty in the props */}
      <img {...tall} />
    </picture>
  );
}

/** The class, seated. The closing line is written on the wall above them. */
export function Finale() {
  const { finale } = landingPageContent;
  return (
    <section id={finale.id} className={styles.finale} aria-labelledby="finale-title">
      <FinaleArt />
      <div className={styles.finaleCopy}>
        <h2 id="finale-title" className={styles.finaleTitle}>
          {finale.title}
        </h2>
        <p className={styles.finaleLede}>{finale.lede}</p>
        <div className={styles.actions} data-align="center">
          <LandingAction {...finale.action} variant="primary" />
        </div>
      </div>
      <footer className={styles.footer}>
        <MarketingBrandLink href="/" className={styles.footerBrand} />
        <nav aria-label="Footer">
          {finale.footerLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <p>{finale.copyright}</p>
      </footer>
    </section>
  );
}
