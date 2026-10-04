import { getImageProps } from "next/image";
import type { CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { FILM_ANCHORS, TITLE_CUES, cueSpan } from "../journey/film-model";
import { LandingAction } from "./actions";
import styles from "./film.module.css";

type StillName = "doorway" | "sky" | "mat" | "class";

const STILLS: Record<StillName, { wide: [number, number]; tall: [number, number] }> = {
  doorway: { wide: [3200, 2000], tall: [975, 2110] },
  sky: { wide: [3200, 2000], tall: [975, 2110] },
  mat: { wide: [3200, 2000], tall: [975, 2110] },
  class: { wide: [3200, 2000], tall: [975, 2110] },
};

/** A still from the film, art-directed for wide and tall screens; decorative. */
function Still({ name, className }: { name: StillName; className?: string }) {
  const common = { alt: "", sizes: "100vw", quality: 78, loading: "lazy" } as const;
  const {
    props: { srcSet: wide },
  } = getImageProps({
    ...common,
    src: `/marketing/scenes/${name}-wide.webp`,
    width: STILLS[name].wide[0],
    height: STILLS[name].wide[1],
  });
  const { props: tall } = getImageProps({
    ...common,
    src: `/marketing/scenes/${name}-tall.webp`,
    width: STILLS[name].tall[0],
    height: STILLS[name].tall[1],
  });
  return (
    <picture className={className}>
      <source media="(min-aspect-ratio: 4/5)" srcSet={wide} />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative; alt is empty in the props */}
      <img {...tall} />
    </picture>
  );
}

function layerStyle(id: keyof typeof TITLE_CUES, anchor: number): CSSProperties {
  const [from, to] = cueSpan(TITLE_CUES[id]);
  return { "--from": from, "--to": to, "--at": anchor } as CSSProperties;
}

/**
 * The film's words. Each layer spans the stretch of film where its title is on
 * screen and pins it there; the controller fades it in and out with the art.
 * Without the film (reduced motion, or before scripts run) the same layers
 * read as a sequence of composed stills.
 */
export function FilmTitles() {
  const { hero, titles, handoff } = landingPageContent;
  const [problem, path] = titles;
  return (
    <div className={styles.titles}>
      <div className={styles.layer} data-layer="welcome" style={layerStyle("welcome", 0)}>
        <span id={hero.id} className={styles.anchor} />
        <div className={styles.pin}>
          <div className={styles.hero} data-cue-body="welcome">
            <p className={styles.kicker}>{hero.kicker}</p>
            <h1 className={styles.heroTitle}>
              <span>{hero.headline[0]}</span>
              <span>{hero.headline[1]}</span>
            </h1>
            <p className={styles.heroLede}>{hero.lede}</p>
            <div className={styles.actions}>
              <LandingAction {...hero.actions[0]} variant="primary" />
              <LandingAction {...hero.actions[1]} />
            </div>
          </div>
        </div>
      </div>

      <div
        className={styles.layer}
        data-layer={problem.id}
        data-ink={problem.ink}
        style={layerStyle("the-problem", FILM_ANCHORS["the-problem"])}
      >
        <span id={problem.id} className={styles.anchor} />
        <div className={styles.pin}>
          <h2 className={styles.title} data-cue-body="the-problem">
            {problem.title}
          </h2>
        </div>
      </div>

      <div className={styles.still} aria-hidden="true">
        <Still name="doorway" className={styles.stillArt} />
      </div>

      <div
        className={styles.layer}
        data-layer={path.id}
        data-ink={path.ink}
        style={layerStyle("the-path", FILM_ANCHORS["the-path"])}
      >
        <span id={path.id} className={styles.anchor} />
        <Still name="sky" className={styles.stillArt} />
        <div className={styles.pin}>
          <h2 className={styles.title} data-cue-body="the-path">
            {path.title}
          </h2>
        </div>
      </div>

      <div className={styles.still} aria-hidden="true">
        <Still name="mat" className={styles.stillArt} />
      </div>

      <div
        className={styles.layer}
        data-layer={handoff.id}
        style={layerStyle("studio", FILM_ANCHORS.studio)}
      >
        <span id={handoff.id} className={styles.anchor} />
        <div className={styles.pin}>
          <div className={styles.handoff}>
            <div className={styles.handoffCopy}>
              <h2 className={styles.handoffTitle} data-cue-body="studio">
                {handoff.title}
              </h2>
              <div className={styles.handoffDetail} data-cue-body="studio-detail">
                <p className={styles.handoffLede}>{handoff.lede}</p>
                <div className={styles.actions}>
                  <LandingAction {...handoff.action} variant="primary" />
                </div>
              </div>
            </div>
            <figure className={styles.handoffFigure}>
              <Still name="class" className={styles.handoffStill} />
              <figcaption className={styles.caption} data-cue-body="studio-detail">
                {handoff.caption}
              </figcaption>
            </figure>
          </div>
        </div>
      </div>
    </div>
  );
}
