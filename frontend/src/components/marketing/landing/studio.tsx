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

/**
 * The 6 PM class. The lit doors slide open, light spills out, and the roster is
 * marked as the reader scrolls; one student finishes their requirement.
 */
export function Studio() {
  const { studio } = landingPageContent;
  const sectionRef = useRef<HTMLElement>(null);
  // Server HTML and no-script visitors see the finished class.
  const [step, setStep] = useState(STUDIO_FINISHED);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;
    let current = -1;
    const update = () => {
      frame = 0;
      const box = section.getBoundingClientRect();
      const range = box.height - window.innerHeight;
      const progress = range > 0 ? Math.min(1, Math.max(0, -box.top / range)) : 1;
      const next = studioStep(progress);
      // Only a new beat of the class re-renders; scrolling within a beat costs nothing.
      if (next !== current) {
        current = next;
        setStep(next);
      }
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
              {studio.title.split(/(?<=\.) /).map((line) => (
                <span key={line}>{line}</span>
              ))}
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
                      <span className={styles.rosterCheck} aria-hidden="true" />
                      <span className={styles.rosterName}>
                        {student.name}
                        <span className={styles.rosterBelt} data-belt={student.belt}>
                          {student.belt.charAt(0).toUpperCase()}
                          {student.belt.slice(1)} belt
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
                        {isReady ? "Ready" : marked ? "Present" : "Not marked"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className={styles.readyNote} data-visible={ready}>
              <span className={styles.readyBelt} data-belt="yellow" aria-hidden="true" />
              <p>
                <strong>{studio.ready.message}</strong>
                <span>Class, time-at-rank and approval requirements met.</span>
              </p>
            </div>
            <figcaption className={styles.caption}>{studio.caption}</figcaption>
          </figure>
        </div>
        <div className={styles.spill} aria-hidden="true" />
        <div className={styles.shoji} data-side="left" aria-hidden="true" />
        <div className={styles.shoji} data-side="right" aria-hidden="true" />
      </div>
    </section>
  );
}
