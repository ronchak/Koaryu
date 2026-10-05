import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";

import {
  landingPageContent,
  type FeaturesChapter as FeaturesContent,
  type HeroChapter as HeroContent,
  type PathChapter as PathContent,
  type ProblemChapter as ProblemContent,
  type ProductChapter as ProductContent,
  type StoryChapter,
  type StudioChapter as StudioContent,
  type WeaveChapter as WeaveContent,
} from "../../../lib/landing-page-content.ts";
import { MarketingActionLink } from "../marketing-primitives";
import styles from "./journey.module.css";

function actionPrefetch(href: string): false | undefined {
  return href === "/signup" || href === "/login" ? false : undefined;
}

export function ChapterAction({
  href,
  label,
  variant = "secondary",
  className,
}: {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  return (
    <MarketingActionLink
      href={href}
      prefetch={actionPrefetch(href)}
      variant={variant}
      data-variant={variant}
      className={[styles.action, className].filter(Boolean).join(" ")}
    >
      {label}
    </MarketingActionLink>
  );
}

/** Sets each sentence of a short title on its own line ("Koaryu keeps count." / "You teach."). */
function SentenceLines({ text }: { text: string }) {
  return text.split(/(?<=\.)\s+/).map((line) => (
    <span key={line} className={styles.line}>
      {line}
    </span>
  ));
}

function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className={styles.textLink} href={href}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  );
}

/** Hero copy arrives in a short stagger on load and drifts away as the camera dives. */
function Hero({ chapter }: { chapter: HeroContent }) {
  return (
    <div className={styles.heroCopy}>
      <p className={styles.heroKicker}>{chapter.kicker}</p>
      <h1 className={styles.heroHeading}>
        {chapter.headline.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </h1>
      <p className={`${styles.lede} ${styles.heroLede}`}>{chapter.lede}</p>
      <div className={`${styles.actions} ${styles.heroActions}`}>
        <ChapterAction {...chapter.actions[0]} variant="primary" />
        <ChapterAction {...chapter.actions[1]} />
      </div>
    </div>
  );
}

function Problem({ chapter }: { chapter: ProblemContent }) {
  return (
    <div className={styles.problemCopy}>
      <h2 className={styles.statementHeading}>{chapter.title}</h2>
      <div className={styles.problemResponse}>
        <p>{chapter.question}</p>
        <p className={styles.problemAside}>{chapter.aside}</p>
      </div>
    </div>
  );
}

/** The real belt tracker: the desktop screen, with the phone layout standing in front of it. */
function Product({ chapter }: { chapter: ProductContent }) {
  const { image } = chapter;
  return (
    <div className={styles.productStage}>
      <article className={`${styles.sheet} ${styles.productSheet}`}>
        <h2 className={styles.sheetHeading}>{chapter.title}</h2>
        <p className={styles.lede}>{chapter.lede}</p>
        <dl className={styles.highlights}>
          {chapter.highlights.map((highlight) => (
            <div key={highlight.label}>
              <dt>{highlight.label}</dt>
              <dd>{highlight.description}</dd>
            </div>
          ))}
        </dl>
      </article>
      <figure className={styles.productFigure}>
        <div className={styles.productScreens}>
          <div className={styles.productDesktop}>
            <Image
              src={image.src}
              width={image.width}
              height={image.height}
              alt={image.alt}
              sizes="(max-width: 820px) 150vw, 64vw"
            />
          </div>
          <div className={styles.productPhone}>
            <Image
              src={image.mobile.src}
              width={image.mobile.width}
              height={image.mobile.height}
              alt={image.mobile.alt}
              sizes="(max-width: 820px) 200px, 240px"
            />
          </div>
        </div>
        <figcaption className={styles.caption}>{image.caption}</figcaption>
      </figure>
    </div>
  );
}

/**
 * Features told as a day at the studio. The chapter scrolls on its own, so the
 * day reads naturally while the story waits; an ink line draws down the day.
 */
function Features({ chapter }: { chapter: FeaturesContent }) {
  return (
    <article className={`${styles.sheet} ${styles.daySheet}`}>
      <header className={styles.dayHeader}>
        <h2 className={styles.sheetHeading}>{chapter.title}</h2>
        <p className={styles.lede}>{chapter.lede}</p>
        <nav className={styles.dayLinks} aria-label="Product guides">
          {chapter.links.map((link) => (
            <TextLink key={link.href} {...link} />
          ))}
        </nav>
      </header>
      <ol className={styles.dayList}>
        {chapter.moments.map((moment) => (
          <li key={moment.title} className={styles.dayMoment}>
            <span className={styles.dayDot} aria-hidden="true" />
            <p className={styles.dayTime}>{moment.time}</p>
            <h3 className={styles.dayTitle}>
              <Link href={moment.detail.href}>{moment.title}</Link>
            </h3>
            <p className={styles.dayText}>{moment.description}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** A single line in the open sky, after flying through the door. */
function Path({ chapter }: { chapter: PathContent }) {
  return (
    <div className={styles.pathCopy}>
      <h2 className={styles.pathHeading}>{chapter.title}</h2>
    </div>
  );
}

/** Over the loom: the threads are drawn in the art; the words say what they are. */
function Weave({ chapter }: { chapter: WeaveContent }) {
  return (
    <div className={styles.weaveCopy}>
      <h2 className={styles.weaveHeading}>{chapter.title}</h2>
      <p className={`${styles.lede} ${styles.weaveLede}`}>{chapter.lede}</p>
    </div>
  );
}

/** A still of the seated class for visitors without scripts; the live scene frames itself. */
function ClassStill() {
  const common = { alt: "", sizes: "(max-width: 820px) 92vw, 50vw", quality: 76 } as const;
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
    <picture className={styles.pictureStill}>
      <source media="(min-width: 821px)" srcSet={wide} />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative; alt is empty in the props */}
      <img {...tall} loading="lazy" />
    </picture>
  );
}

/**
 * The class sits; then the picture is handed off into a timber frame beside the
 * same headline, and the page begins. The copy is pinned while the hand-off plays.
 */
function Studio({ chapter }: { chapter: StudioContent }) {
  return (
    <section
      id={chapter.id}
      className={styles.studio}
      data-stop={chapter.id}
      data-scene={chapter.scene}
      data-focus-stop={chapter.id}
      data-kind={chapter.kind}
      aria-labelledby="studio-title"
    >
      <span className={styles.handoffMarker} data-stop="handoff" data-scene={chapter.scene} />
      <div className={styles.studioPin} data-pinned="">
        <div className={styles.studioCopy}>
          <h2 id="studio-title" className={styles.studioHeading}>
            <SentenceLines text={chapter.title} />
          </h2>
          <div className={styles.studioDetail} data-focus-stop="handoff">
            <p className={styles.studioLede}>{chapter.lede}</p>
            <div className={styles.actions}>
              <ChapterAction {...chapter.actions[0]} variant="primary" />
              <ChapterAction {...chapter.actions[1]} />
            </div>
          </div>
        </div>
        <figure className={styles.studioFigure}>
          <div className={styles.pictureSlot} data-picture-slot="">
            <ClassStill />
          </div>
          <figcaption className={styles.studioCaption}>{chapter.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}

function ChapterContent({ chapter }: { chapter: StoryChapter }): ReactNode {
  switch (chapter.kind) {
    case "hero":
      return <Hero chapter={chapter} />;
    case "problem":
      return <Problem chapter={chapter} />;
    case "product":
      return <Product chapter={chapter} />;
    case "features":
      return <Features chapter={chapter} />;
    case "path":
      return <Path chapter={chapter} />;
    case "weave":
      return <Weave chapter={chapter} />;
    case "studio":
      return null;
  }
}

/**
 * Open scroll between chapters, in screen heights, where each beat plays when
 * the story is scrubbed. Keyed by the chapter the beat arrives at.
 */
const INTERLUDES: Readonly<Record<string, number>> = {
  "the-problem": 50,
  product: 70,
  features: 80,
  "the-path": 80,
  "the-weave": 120,
  studio: 90,
};

/** The paged story: one composed chapter per screen, with open scroll between them. */
export function JourneyStory() {
  const { story } = landingPageContent;
  return (
    <div className={styles.story}>
      {story.map((chapter, index) => (
        <Fragment key={chapter.id}>
          {index > 0 ? (
            <div
              className={styles.interlude}
              aria-hidden="true"
              style={{ "--interlude": INTERLUDES[chapter.id] ?? 70 } as CSSProperties}
            />
          ) : null}
          {chapter.kind === "studio" ? (
            <Studio chapter={chapter} />
          ) : (
            <section
              id={chapter.id}
              className={styles.chapter}
              data-stop={chapter.id}
              data-scene={chapter.scene}
              data-focus-stop={chapter.id}
              data-kind={chapter.kind}
              data-ink={chapter.ink}
              aria-label={chapter.kind === "hero" ? undefined : chapter.title}
            >
              <div className={styles.panel} data-panel="">
                <div className={styles.frame}>
                  <ChapterContent chapter={chapter} />
                </div>
              </div>
            </section>
          )}
        </Fragment>
      ))}
    </div>
  );
}
