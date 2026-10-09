import Image from "next/image";
import type { CSSProperties } from "react";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import { MarketingRoot } from "@/components/marketing/marketing-root";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/public-pages";
import { SceneTimeScript } from "@/components/marketing/journey/scene-time-script";

import { tryPageContent } from "./try-content.ts";
import { TryDemo } from "./try-demo";
import { CREST_PATHS, EDGE_PATHS, GROUND_PATHS, RIDGE_PATHS, STARS, WISPS } from "./try-hills.ts";
import styles from "./try-page.module.css";

/** Far ridges sink faster than near ones as the page scrolls away from the hills. */
const PARALLAX = [0.3, 0.22, 0.15, 0.09, 0.04] as const;

/** The sky over the hills: a pale golden-hour sky by day, dusk and the first stars at night. */
function Sky() {
  return (
    <div className={styles.sky} aria-hidden="true">
      <svg className={styles.stars}>
        {STARS.map((star, index) => (
          <circle
            key={index}
            cx={`${star.x}%`}
            cy={`${star.y}%`}
            r={star.r}
            opacity={star.opacity}
          />
        ))}
      </svg>
      {WISPS.map((wisp, index) => (
        <svg
          key={index}
          className={styles.wisp}
          viewBox="-520 -120 1040 200"
          style={
            {
              "--wisp": index,
              left: `${(wisp.x / 1600) * 100 - 16}%`,
              top: `${10 + index * 7}%`,
            } as CSSProperties
          }
        >
          <path d={wisp.path} />
        </svg>
      ))}
    </div>
  );
}

/**
 * The landscape the miniature stands in, anchored to the top of the demo: the sun
 * (or the moon) setting behind the window, five ridges, and the near ground that
 * carries on into the dark band below.
 */
function Landscape() {
  return (
    <div className={styles.landscape} aria-hidden="true">
      <div className={styles.sun} />
      <div className={styles.moon} />
      <div className={styles.ridges}>
        {RIDGE_PATHS.map((path, index) => (
          <svg
            key={index}
            className={styles.ridge}
            viewBox="0 400 1600 900"
            preserveAspectRatio="xMidYMin slice"
            style={{ "--ridge": index, "--parallax": PARALLAX[index] } as CSSProperties}
          >
            <path d={path} className={styles.ridgeFill} />
            <path d={CREST_PATHS[index]} className={styles.crest} />
          </svg>
        ))}
      </div>
      <div className={styles.ground}>
        {GROUND_PATHS.map((path, index) => (
          <svg
            key={index}
            className={styles.groundRidge}
            viewBox="0 0 1600 540"
            preserveAspectRatio="xMidYMin slice"
            style={{ "--ground": index } as CSSProperties}
          >
            <path d={path} />
          </svg>
        ))}
      </div>
    </div>
  );
}

function Hero() {
  const { hero } = tryPageContent;
  return (
    <section className={styles.hero} aria-labelledby="try-title">
      <Sky />
      <div className={styles.heroInner}>
        <div className={styles.intro}>
          <h1 id="try-title" className={styles.title}>
            <span>{hero.headline[0]}</span> <span>{hero.headline[1]}</span>
          </h1>
          <p className={styles.lede}>{hero.lede}</p>
        </div>
        <div className={styles.stage}>
          <Landscape />
          <TryDemo />
        </div>
      </div>
    </section>
  );
}

/** The real belt tracker, desktop and phone, and the way in. */
function RealThing() {
  const { real } = tryPageContent;
  return (
    <section className={styles.real} aria-labelledby="try-real-title">
      <div className={styles.realInner}>
        <div className={styles.realCopy}>
          <h2 id="try-real-title" className={styles.realTitle}>
            {real.title}
          </h2>
          <p className={styles.realLede}>{real.lede}</p>
          <p className={styles.realPrice}>{real.price}</p>
          <div className={styles.actions}>
            <MarketingActionLink
              href={real.actions[0].href}
              prefetch={false}
              className={styles.action}
            >
              {real.actions[0].label}
            </MarketingActionLink>
            <MarketingActionLink
              href={real.actions[1].href}
              variant="secondary"
              className={styles.action}
            >
              {real.actions[1].label}
            </MarketingActionLink>
          </div>
        </div>
        <figure className={styles.realFigure}>
          <div className={styles.screens}>
            <div className={styles.desktop}>
              <Image
                src={real.image.src}
                width={real.image.width}
                height={real.image.height}
                alt={real.image.alt}
                sizes="(max-width: 900px) calc(100vw - 40px), 760px"
              />
            </div>
            <div className={styles.phone}>
              <Image
                src={real.image.mobile.src}
                width={real.image.mobile.width}
                height={real.image.mobile.height}
                alt={real.image.mobile.alt}
                sizes="(max-width: 900px) 34vw, 190px"
              />
            </div>
          </div>
          <figcaption className={styles.realCaption}>{real.caption}</figcaption>
        </figure>
      </div>
      <div className={styles.edge} aria-hidden="true">
        {EDGE_PATHS.map((path, index) => (
          <svg
            key={index}
            viewBox="0 0 1600 160"
            preserveAspectRatio="xMidYMax slice"
            style={{ "--edge": index } as CSSProperties}
          >
            <path d={path} />
          </svg>
        ))}
      </div>
    </section>
  );
}

export function TryPage() {
  return (
    <MarketingRoot layout="document" className={styles.root}>
      <SceneTimeScript />
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.masthead}>
        <MarketingHeader />
      </div>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        <Hero />
        <RealThing />
      </main>
      <div className={styles.footer}>
        <MarketingFooter />
      </div>
    </MarketingRoot>
  );
}
