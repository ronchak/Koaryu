import Link from "next/link";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { LandingTextLink } from "./actions";
import styles from "./landing.module.css";

/** Each moment's dot ties on the next belt, white at dawn to black by Sunday. */
const DAY_BELTS = ["white", "yellow", "orange", "green", "blue", "brown", "black"] as const;

/** Features told as a day at the studio, with a line drawn down the day as it is read. */
export function Day() {
  const { day } = landingPageContent;
  return (
    <section id={day.id} className={styles.day} aria-labelledby="day-title">
      <header className={styles.dayHeader}>
        <h2 id="day-title" className={styles.sectionTitle}>
          {day.title}
        </h2>
        <nav className={styles.dayLinks} aria-label="Product guides">
          {day.links.map((link) => (
            <LandingTextLink key={link.href} {...link} />
          ))}
        </nav>
      </header>
      <ol className={styles.dayList}>
        <span className={styles.dayLine} aria-hidden="true" />
        {day.moments.map((moment, index) => (
          <li key={moment.title} className={styles.dayMoment}>
            <span className={styles.dayDot} data-belt={DAY_BELTS[index]} aria-hidden="true" />
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
