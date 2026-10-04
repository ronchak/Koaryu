import type { CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { MOUNTAIN_WISPS, RIDGES, RIDGE_PATHS, closedRidgePath } from "../journey/hills";
import { LandingAction } from "./actions";
import styles from "./landing.module.css";

/** The evening hills behind the headline and the demo: far ridges sink faster than near ones. */
const LAYERS = RIDGES.map((ridge, index) => ({
  path: RIDGE_PATHS[index],
  color: ridge.color,
  parallax: [0.36, 0.27, 0.19, 0.11, 0.05][index],
}));

/** Two near, dark ridges anchored to the bottom carry the hills into the ground the page continues on. */
const GROUND = [
  { path: closedRidgePath(1040, 70, 0.9, 3.4), color: "#5b4523" },
  { path: closedRidgePath(1150, 54, 1.3, 0.8), color: "#3a2c1b" },
] as const;

export function HeroArt() {
  return (
    <div className={styles.art} aria-hidden="true">
      <div className={styles.sun} />
      {MOUNTAIN_WISPS.slice(0, 3).map((wisp, index) => (
        <svg
          key={`wisp-${index}`}
          className={styles.wisp}
          viewBox="-520 -120 1040 200"
          style={
            {
              "--wisp": index,
              left: `${(wisp.x / 1600) * 100 - 14}%`,
              top: `${8 + index * 9}%`,
            } as CSSProperties
          }
        >
          <path d={wisp.path} />
        </svg>
      ))}
      <div className={styles.ridges}>
        {LAYERS.map((layer, index) => (
          <svg
            key={index}
            className={styles.ridge}
            viewBox="0 400 1600 900"
            preserveAspectRatio="xMidYMin slice"
            style={{ "--parallax": layer.parallax } as CSSProperties}
          >
            <path d={layer.path} fill={layer.color} />
          </svg>
        ))}
      </div>
      <div className={styles.ground}>
        {GROUND.map((layer, index) => (
          <svg
            key={index}
            className={styles.groundRidge}
            viewBox="0 760 1600 540"
            preserveAspectRatio="xMidYMin slice"
          >
            <path d={layer.path} fill={layer.color} />
          </svg>
        ))}
      </div>
    </div>
  );
}

export function Hero() {
  const { hero } = landingPageContent;
  return (
    <section id={hero.id} className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroCopy}>
        <h1 id="hero-title" className={styles.heroTitle}>
          <span>{hero.headline[0]}</span> <span>{hero.headline[1]}</span>
        </h1>
        <div className={styles.heroRow}>
          <p className={styles.heroLede}>{hero.lede}</p>
          <div className={styles.actions}>
            <LandingAction {...hero.actions[0]} variant="primary" />
            <LandingAction {...hero.actions[1]} />
          </div>
        </div>
      </div>
    </section>
  );
}
