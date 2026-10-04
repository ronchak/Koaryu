import { landingPageContent } from "../../../lib/landing-page-content.ts";
import styles from "./landing.module.css";

/**
 * The camera dives into the hill: the nearest ridge swells up out of the hero
 * and fills the screen, darkening to deep brown, and the problem is named on it.
 */
export function Problem() {
  const { problem } = landingPageContent;
  return (
    <section id={problem.id} className={styles.problem} aria-labelledby="problem-title">
      <svg
        className={styles.hillCrest}
        viewBox="0 0 1600 240"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 176 C 170 120, 360 30, 590 24 S 960 86, 1170 136 S 1470 156, 1600 120 L1600 240 L0 240 Z" />
      </svg>
      <div className={styles.problemStage}>
        <div className={styles.problemCopy}>
          <h2 id="problem-title" className={styles.statement}>
            {problem.title}
          </h2>
          <p className={styles.statementLede}>{problem.lede}</p>
        </div>
      </div>
    </section>
  );
}
