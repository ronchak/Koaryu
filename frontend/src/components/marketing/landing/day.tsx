import Link from "next/link";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { LandingTextLink } from "./actions";
import styles from "./landing.module.css";

/** Features told as a day at the studio: a line of light runs down the day, lighting each lantern. */
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
      <ol className={styles.dayList}>
        <span className={styles.dayTrack} aria-hidden="true" />
        <span className={styles.dayLine} aria-hidden="true" />
        {day.moments.map((moment) => (
          <li key={moment.title} className={styles.dayMoment}>
            <span className={styles.lantern} aria-hidden="true" />
            <p className={styles.dayTime}>{moment.time}</p>
            <h3 className={styles.dayTitle}>
              <Link href={moment.detail.href}>{moment.title}</Link>
            </h3>
            <p className={styles.dayText}>{moment.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
