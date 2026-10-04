import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { RIDGES, RIDGE_PATHS } from "../journey/hills";
import { MarketingBrandLink } from "../marketing-primitives";
import { LandingAction, LandingTextLink } from "./actions";
import styles from "./page.module.css";

/** The real belt tracker: the desktop screen, with the same screen on a phone in front of it. */
export function Product() {
  const { product } = landingPageContent;
  return (
    <section id={product.id} className={styles.product} aria-labelledby="product-title">
      <header className={styles.sectionHeader}>
        <h2 id="product-title" className={styles.sectionTitle}>
          {product.title}
        </h2>
        <p className={styles.sectionLede}>{product.lede}</p>
      </header>
      <figure className={styles.productFigure}>
        <div className={styles.productScreens}>
          <div className={styles.productDesktop}>
            <Image
              src={product.image.src}
              width={product.image.width}
              height={product.image.height}
              alt={product.image.alt}
              sizes="(max-width: 640px) 1px, (max-width: 1400px) 82vw, 1140px"
            />
          </div>
          <div className={styles.productPhone}>
            <Image
              src={product.image.mobile.src}
              width={product.image.mobile.width}
              height={product.image.mobile.height}
              alt={product.image.mobile.alt}
              sizes="(max-width: 640px) 300px, 250px"
            />
          </div>
        </div>
        <figcaption className={styles.caption}>{product.caption}</figcaption>
      </figure>
    </section>
  );
}

/** Belt colours for the day's moments: the day ranks up from white to black. */
const DAY_BELTS = ["white", "yellow", "orange", "green", "blue", "brown", "black"] as const;

/** Features told as a day at the studio, with an ink line drawn down the day as it is read. */
export function Day() {
  const { day } = landingPageContent;
  return (
    <section id={day.id} className={styles.day} aria-labelledby="day-title">
      <header className={styles.dayHeader}>
        <h2 id="day-title" className={styles.sectionTitle}>
          {day.title}
        </h2>
        <p className={styles.sectionLede}>{day.lede}</p>
        <nav className={styles.dayLinks} aria-label="Product guides">
          {day.links.map((link) => (
            <LandingTextLink key={link.href} {...link} />
          ))}
        </nav>
      </header>
      <div className={styles.dayTrack}>
        <span className={styles.dayLine} aria-hidden="true" />
        <ol className={styles.dayList}>
          {day.moments.map((moment, index) => (
            <li key={moment.title} className={styles.dayMoment}>
              <span
                className={styles.dayDot}
                data-belt={DAY_BELTS[index % DAY_BELTS.length]}
                aria-hidden="true"
              />
              <p className={styles.dayTime}>{moment.time}</p>
              <h3 className={styles.dayTitle}>
                <Link href={moment.detail.href}>{moment.title}</Link>
              </h3>
              <p className={styles.dayText}>{moment.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Pricing() {
  const { pricing } = landingPageContent;
  return (
    <section id={pricing.id} className={styles.pricing} aria-labelledby="pricing-title">
      <div className={styles.pricingInner}>
        <div className={styles.pricingCopy}>
          <h2 id="pricing-title" className={styles.sectionTitle}>
            {pricing.title}
          </h2>
          <p className={styles.pricingNote}>{pricing.note}</p>
        </div>
        <div className={styles.priceCard}>
          <p className={styles.price} data-price-amount={pricing.amount}>
            {pricing.displayPrice}
          </p>
          <p className={styles.pricePeriod}>{pricing.period}</p>
          <ul className={styles.included} aria-label="Included">
            {pricing.included.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className={styles.actions}>
            <LandingAction {...pricing.setupAction} variant="primary" />
          </div>
          <p className={styles.paymentsLink}>
            <Link href={pricing.paymentsLink.href}>{pricing.paymentsLink.label}</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  const { faq } = landingPageContent;
  return (
    <section id={faq.id} className={styles.faq} aria-labelledby="faq-title">
      <h2 id="faq-title" className={styles.sectionTitle}>
        {faq.title}
      </h2>
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

/** How far each ridge rises as the close arrives: the far hills least, the near hill most. */
const RIDGE_RISE = [0.12, 0.2, 0.3, 0.42, 0.56] as const;

/** The film began in the hills; the page ends there, with the footer on the nearest ridge. */
export function Finale() {
  const { finale } = landingPageContent;
  return (
    <section id={finale.id} className={styles.finale} aria-labelledby="finale-title">
      <div className={styles.finaleArt} aria-hidden="true">
        <div className={styles.finaleSun} />
        {RIDGES.map((ridge, index) => (
          <svg
            key={`ridge-${index}`}
            className={styles.finaleRidge}
            viewBox="0 0 1600 1000"
            preserveAspectRatio="xMidYMax slice"
            style={{ "--rise": RIDGE_RISE[index] } as CSSProperties}
          >
            <path d={RIDGE_PATHS[index]} fill={ridge.color} />
          </svg>
        ))}
      </div>
      <div className={styles.finaleCopy}>
        <h2 id="finale-title" className={styles.finaleTitle}>
          {finale.title}
        </h2>
        <p className={styles.finaleLede}>{finale.lede}</p>
        <div className={styles.actions}>
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
