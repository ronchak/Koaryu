import type { CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { MOUNTAIN_RIMS, MOUNTAIN_WISPS, RIDGES, RIDGE_CRESTS, RIDGE_PATHS } from "../journey/hills";
import { mulberry32 } from "../journey/scene-model";
import { LandingAction } from "./actions";
import styles from "./landing.module.css";

/** How far each layer sinks as the hero scrolls away: the sun most, the nearest hill least. */
const RIDGE_PARALLAX = [0.36, 0.28, 0.19, 0.1, 0] as const;

/** The first stars, fixed so server and client agree. They come out as the sun sets. */
const STARS = (() => {
  const random = mulberry32(1802);
  return Array.from({ length: 46 }, () => ({
    left: `${(random() * 100).toFixed(2)}%`,
    top: `${(random() ** 1.6 * 46).toFixed(2)}%`,
    size: random() < 0.18 ? 3 : 2,
    opacity: (0.35 + random() * 0.6).toFixed(2),
  }));
})();

export function Hero() {
  const { hero } = landingPageContent;
  return (
    <section id={hero.id} className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroArt} aria-hidden="true">
        <div className={styles.heroNight} />
        <div className={styles.heroStars}>
          {STARS.map((star, index) => (
            <span
              key={index}
              style={
                {
                  left: star.left,
                  top: star.top,
                  width: star.size,
                  height: star.size,
                  opacity: star.opacity,
                } as CSSProperties
              }
            />
          ))}
        </div>
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
                top: `${(wisp.y / 1000) * 100 + 4}%`,
              } as CSSProperties
            }
          >
            <defs>
              <linearGradient id={`hero-wisp-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#7A5068" />
                <stop offset="1" stopColor="#F1A879" />
              </linearGradient>
            </defs>
            <path d={wisp.path} fill={`url(#hero-wisp-${index})`} />
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
            <path
              d={RIDGE_CRESTS[index]}
              fill="none"
              stroke={MOUNTAIN_RIMS[index]}
              strokeWidth="2.5"
              opacity="0.7"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ))}
      </div>
      <div className={styles.heroCopy}>
        <p className={styles.tagline}>{hero.kicker}</p>
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
