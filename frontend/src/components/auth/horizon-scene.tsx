import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { HorizonHills } from "@/components/ui/horizon-hills";
import styles from "./horizon-scene.module.css";

/*
 * The landing page's hills behind the product's front door: sign-in, sign-up,
 * studio setup and the system pages. A paper sheet stands on the ridges; the
 * sky is the landing's noon by day and its indigo night in the dark theme.
 */
export function HorizonScene({
  children,
  homeHref = "/",
  topAction,
}: {
  children: ReactNode;
  homeHref?: string;
  topAction?: ReactNode;
}) {
  return (
    <div className={styles.scene} data-horizon-scene="true">
      <div className={styles.sky} aria-hidden="true">
        <span className={styles.sun} />
        <HorizonHills variant="hero" sun={false} className={styles.hills} />
      </div>
      <div className={styles.topBar}>
        <Link href={homeHref} aria-label="Go to Koaryu homepage" className={styles.home}>
          <Logo size="md" />
        </Link>
        {topAction ? <div className={styles.topAction}>{topAction}</div> : null}
      </div>
      <div className={styles.stage}>{children}</div>
    </div>
  );
}

/** The words beside the sheet: a short kicker, the page's one big line, and a plain sentence. */
export function SceneIntro({
  children,
  eyebrow,
  lede,
  title,
  titleId,
}: {
  children?: ReactNode;
  eyebrow?: ReactNode;
  lede?: ReactNode;
  title: ReactNode;
  titleId?: string;
}) {
  return (
    <div className={styles.intro}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h1 id={titleId} className={styles.title}>
        {title}
      </h1>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
      {children ? <div className={styles.introExtra}>{children}</div> : null}
    </div>
  );
}

/** The paper sheet that holds a form or a status message. */
export function SceneSheet({
  children,
  labelledBy,
  width = "form",
}: {
  children: ReactNode;
  labelledBy?: string;
  width?: "form" | "wide";
}) {
  return (
    <section className={styles.sheet} data-width={width} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}

/** Intro and sheet side by side on wide screens, stacked on phones. */
export function SceneSplit({ children }: { children: ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}

/** One centred column for pages that only need the sheet. */
export function SceneSolo({ children }: { children: ReactNode }) {
  return <div className={styles.solo}>{children}</div>;
}

/** Numbered steps for a short journey, such as account, studio, trial. */
export function SceneSteps({
  current,
  label,
  steps,
}: {
  current: number;
  label: string;
  steps: readonly { title: string; detail?: string }[];
}) {
  return (
    <ol className={styles.steps} aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.title}
          className={styles.step}
          data-state={index < current ? "done" : index === current ? "current" : "next"}
          aria-current={index === current ? "step" : undefined}
        >
          <span className={styles.stepMark} aria-hidden="true">
            {index + 1}
          </span>
          <span className={styles.stepText}>
            <strong>{step.title}</strong>
            {step.detail ? <span>{step.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A quiet line under the form, such as the switch between sign-in and sign-up. */
export function SceneFootnote({ children }: { children: ReactNode }) {
  return <p className={styles.footnote}>{children}</p>;
}

export const sceneLinkClassName = styles.link;
export const sceneSheetTitleClassName = styles.sheetTitle;
export const sceneSheetLedeClassName = styles.sheetLede;
