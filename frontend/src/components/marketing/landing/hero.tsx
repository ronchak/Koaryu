import type { CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { MOUNTAIN_WISPS, RIDGES, RIDGE_PATHS } from "../journey/hills";
import { LandingAction } from "./actions";
import styles from "./landing.module.css";

/** How far each layer sinks as the hero scrolls away: the far hills most, the nearest least. */
const RIDGE_PARALLAX = [0.42, 0.32, 0.22, 0.12, 0.04] as const;

export function Hero() {
  const { hero } = landingPageContent;
  return (
    <section id={hero.id} className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroArt} aria-hidden="true">
        <div className={styles.heroSun} />
        {MOUNTAIN_WISPS.slice(0, 3).map((wisp, index) => (
          <svg
            key={`wisp-${index}`}
            className={styles.heroWisp}
            viewBox="-520 -120 1040 200"
            style={
              {
                "--wisp": index,
                left: `${(wisp.x / 1600) * 100 - 12}%`,
                top: `${(wisp.y / 1000) * 100 - 6}%`,
              } as CSSProperties
            }
          >
            <path d={wisp.path} />
          </svg>
        ))}
        {RIDGES.map((ridge, index) => (
          <svg
            key={`ridge-${index}`}
            className={styles.heroRidge}
            viewBox="0 0 1600 1000"
            preserveAspectRatio="xMidYMax slice"
            style={{ "--parallax": RIDGE_PARALLAX[index] } as CSSProperties}
          >
            <path d={RIDGE_PATHS[index]} fill={ridge.color} />
          </svg>
        ))}
      </div>
      <div className={styles.heroCopy}>
        <p className={styles.kicker}>{hero.kicker}</p>
        <h1 id="hero-title" className={styles.heroTitle}>
          <span>{hero.headline[0]}</span>
          <span>{hero.headline[1]}</span>
        </h1>
        <p className={styles.heroLede}>{hero.lede}</p>
        <div className={styles.actions}>
          <LandingAction {...hero.actions[0]} variant="primary" />
          <LandingAction {...hero.actions[1]} />
        </div>
      </div>
    </section>
  );
}
