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

export function Pricing() {
  const { pricing } = landingPageContent;
  return (
    <section id={pricing.id} className={styles.pricing} aria-labelledby="pricing-title">
      <p className={styles.kicker}>{pricing.kicker}</p>
      <h2 id="pricing-title" className={styles.sectionTitle}>
        {pricing.title}
      </h2>
      <div className={styles.priceBlock}>
        <p className={styles.price} data-price-amount={pricing.amount}>
          {pricing.displayPrice}
        </p>
        <span className={styles.seal} data-size="large" aria-hidden="true">
          All in
        </span>
      </div>
      <p className={styles.pricePeriod}>{pricing.period}</p>
      <ul className={styles.included} aria-label="Included">
        {pricing.included.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className={styles.priceNote}>{pricing.note}</p>
      <div className={styles.actions} data-align="center">
        <LandingAction {...pricing.setupAction} variant="primary" />
      </div>
      <p className={styles.paymentsLink}>
        <Link href={pricing.paymentsLink.href}>{pricing.paymentsLink.label}</Link>
      </p>
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
        <p className={styles.kicker}>{faq.kicker}</p>
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
