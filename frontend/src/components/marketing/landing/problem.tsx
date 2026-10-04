import { getImageProps } from "next/image";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import styles from "./landing.module.css";

function DojoAtNight() {
  const common = { alt: "", sizes: "100vw", quality: 80 } as const;
  const {
    props: { srcSet: wide },
  } = getImageProps({
    ...common,
    src: "/marketing/scenes/dojo-night-wide.webp",
    width: 3200,
    height: 2000,
  });
  const { props: tall } = getImageProps({
    ...common,
    src: "/marketing/scenes/dojo-night-tall.webp",
    width: 975,
    height: 2110,
  });
  return (
    <picture className={styles.dojoArt}>
      <source media="(min-aspect-ratio: 4/5)" srcSet={wide} />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative; alt is empty in the props */}
      <img {...tall} />
    </picture>
  );
}

/** Nightfall: the dojo lit from within, the class already sitting behind the paper. */
export function Problem() {
  const { problem } = landingPageContent;
  return (
    <section id={problem.id} className={styles.problem} aria-labelledby="problem-title">
      <header className={styles.problemCopy}>
        <h2 id="problem-title" className={styles.sectionTitle}>
          {problem.title}
        </h2>
        <p className={styles.sectionLede}>{problem.lede}</p>
      </header>
      <figure className={styles.dojo}>
        <div className={styles.dojoFrame} aria-hidden="true">
          <DojoAtNight />
        </div>
        <figcaption className={styles.caption}>{problem.caption}</figcaption>
      </figure>
    </section>
  );
}
