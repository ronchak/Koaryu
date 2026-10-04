"use client";

import { getImageProps } from "next/image";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import styles from "./landing.module.css";
import { STUDIO_FINISHED, studioStep } from "./studio-model";

function StudioBackdrop() {
  const common = { alt: "", sizes: "100vw", quality: 80 } as const;
  const {
    props: { srcSet: wide },
  } = getImageProps({
    ...common,
    src: "/marketing/scenes/doorway-wide.webp",
    width: 3200,
    height: 2000,
  });
  const { props: tall } = getImageProps({
    ...common,
    src: "/marketing/scenes/doorway-tall.webp",
    width: 975,
    height: 2110,
  });
  return (
    <picture className={styles.studioBackdrop}>
      <source media="(min-aspect-ratio: 4/5)" srcSet={wide} />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- decorative; alt is empty in the props */}
      <img {...tall} />
    </picture>
  );
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.4 6.6 11.4 12.5 4.9" />
    </svg>
  );
}

export function Studio() {
  const { studio } = landingPageContent;
  const sectionRef = useRef<HTMLElement>(null);
  // Server HTML and no-script visitors see the finished class.
  const [step, setStep] = useState(STUDIO_FINISHED);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = section.getBoundingClientRect();
      const range = box.height - window.innerHeight;
      const progress = range > 0 ? Math.min(1, Math.max(0, -box.top / range)) : 1;
      // React skips the render when the step is unchanged, so this commits once per mark.
      setStep(studioStep(progress));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const present = Math.min(step, studio.students.length);
  const ready = step >= STUDIO_FINISHED;
  const nextBelt = studio.ready.nextRank.split(" ")[0]!.toLowerCase();

  return (
    <section
      ref={sectionRef}
      id={studio.id}
      className={styles.studio}
      aria-labelledby="studio-title"
    >
      <div className={styles.studioStage} data-step={step}>
        <StudioBackdrop />
        <div className={styles.studioShade} aria-hidden="true" />
        <div className={styles.studioContent}>
          <div className={styles.studioCopy}>
            <h2 id="studio-title" className={styles.sectionTitle}>
              {studio.title}
            </h2>
            <p className={styles.sectionLede}>{studio.lede}</p>
          </div>
          <figure className={styles.roster}>
            <div className={styles.rosterCard}>
              <header className={styles.rosterHeader}>
                <p>{studio.session}</p>
                <p className={styles.rosterCount}>
                  {present} of {studio.students.length} present
                </p>
              </header>
              <ol className={styles.rosterList}>
                {studio.students.map((student, index) => {
                  const marked = index < present;
                  const count = Math.min(student.required, student.attended + (marked ? 1 : 0));
                  const isReady = ready && student.name === studio.ready.student;
                  return (
                    <li
                      key={student.name}
                      className={styles.rosterRow}
                      data-marked={marked}
                      data-ready={isReady}
                    >
                      <span className={styles.rosterCheck} aria-hidden="true">
                        <CheckGlyph />
                      </span>
                      <span className={styles.rosterName}>
                        {student.name}
                        <span className={styles.rosterBelt} data-belt={student.belt}>
                          {student.belt} belt
                        </span>
                      </span>
                      <span className={styles.rosterProgress}>
                        <span
                          className={styles.rosterBar}
                          style={{ "--fill": count / student.required } as CSSProperties}
                        />
                        <span className={styles.rosterTally}>
                          {count}/{student.required}
                        </span>
                      </span>
                      <span className={styles.rosterStatus}>
                        {isReady ? (
                          <>
                            <CheckGlyph className={styles.statusGlyph} />
                            Eligible
                          </>
                        ) : marked ? (
                          "Present"
                        ) : (
                          "Not marked"
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className={styles.readyNote} data-visible={ready}>
              <span className={styles.readyIcon} aria-hidden="true">
                <CheckGlyph />
              </span>
              <p>
                <strong>{studio.ready.message}</strong>
                <span>{studio.ready.detail}</span>
              </p>
              <span className={styles.rankBadge} data-belt={nextBelt}>
                {studio.ready.nextRank}
              </span>
            </div>
            <figcaption className={styles.caption}>{studio.caption}</figcaption>
          </figure>
        </div>
        <div className={styles.shoji} data-side="left" aria-hidden="true">
          <span>{studio.doors[0]}</span>
        </div>
        <div className={styles.shoji} data-side="right" aria-hidden="true">
          <span>{studio.doors[1]}</span>
        </div>
        <div className={styles.studioCurtain} aria-hidden="true" />
      </div>
    </section>
  );
}
