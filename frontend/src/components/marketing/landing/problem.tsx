import type { CSSProperties } from "react";

import { landingPageContent, type ProblemScrap } from "../../../lib/landing-page-content.ts";
import styles from "./landing.module.css";

/**
 * Where each scrap lies before the page gathers them, relative to the center of
 * the stage. Kept clear of the headline above and the card that replaces them.
 */
const SCATTER = [
  { x: "-31vw", y: "-7vh", r: "-7deg" },
  { x: "28vw", y: "-11vh", r: "6deg" },
  { x: "-25vw", y: "17vh", r: "4deg" },
  { x: "24vw", y: "14vh", r: "-5deg" },
  { x: "-8vw", y: "27vh", r: "3deg" },
  { x: "10vw", y: "-21vh", r: "-3deg" },
] as const;

function Scrap({ scrap }: { scrap: ProblemScrap }) {
  switch (scrap.kind) {
    case "sheet":
      return (
        <>
          <p className={styles.scrapTitle}>{scrap.title}</p>
          {scrap.lines.map((line) => (
            <p key={line} className={styles.scrapLine}>
              {line}
            </p>
          ))}
        </>
      );
    case "note":
    case "receipt":
      return <p className={styles.scrapText}>{scrap.text}</p>;
  }
}

export function Problem() {
  const { problem } = landingPageContent;
  const [before, after] = problem.title.split(" not ");
  return (
    <section id={problem.id} className={styles.problem} aria-labelledby="problem-title">
      <div className={styles.problemStage}>
        <header className={styles.problemCopy}>
          <h2 id="problem-title" className={styles.problemTitle}>
            {before} <em>not</em> {after}
          </h2>
          <p className={styles.problemLede}>{problem.lede}</p>
        </header>
        <div className={styles.scrapField} aria-hidden="true">
          {problem.scraps.map((scrap, index) => {
            const scatter = SCATTER[index % SCATTER.length]!;
            return (
              <div
                key={index}
                className={styles.scrap}
                data-kind={scrap.kind}
                style={
                  {
                    "--from-x": scatter.x,
                    "--from-y": scatter.y,
                    "--from-r": scatter.r,
                    "--stack": index,
                  } as CSSProperties
                }
              >
                <Scrap scrap={scrap} />
              </div>
            );
          })}
        </div>
        <div className={styles.resolution}>
          <p className={styles.resolutionMark}>Koaryu</p>
          <p className={styles.resolutionText}>{problem.resolution}</p>
          <div className={styles.resolutionBelts} aria-hidden="true">
            {(["white", "yellow", "orange", "green", "blue", "brown", "black"] as const).map(
              (belt) => (
                <span key={belt} data-belt={belt} />
              ),
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
