"use client";

import { useRef, type MouseEvent } from "react";

import styles from "./page.module.css";

const OPEN_MS = 380;
const CLOSE_MS = 280;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * One question. The answer unfolds and folds away instead of snapping; a click
 * mid-fold turns it back from where it is. Without scripts, or with reduced
 * motion, it is the browser's own details toggle.
 */
export function FaqItem({ question, answer }: { question: string; answer: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<{ closing: boolean; animations: Animation[] } | null>(null);

  const onToggle = (event: MouseEvent<HTMLElement>) => {
    const details = detailsRef.current;
    const panel = panelRef.current;
    const text = panel?.firstElementChild;
    if (!details || !panel || !text || typeof panel.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();

    const opening = !details.open || Boolean(motionRef.current?.closing);
    const from = details.open ? panel.getBoundingClientRect().height : 0;
    const shown = details.open ? Number(getComputedStyle(text).opacity) : 0;
    for (const animation of motionRef.current?.animations ?? []) animation.cancel();
    details.open = true;
    // The icon stands back up into a plus as soon as the fold starts.
    details.toggleAttribute("data-closing", !opening);
    const to = opening ? panel.scrollHeight : 0;
    const timing = { duration: opening ? OPEN_MS : CLOSE_MS, easing: EASE };
    const fold = panel.animate({ height: [`${from}px`, `${to}px`] }, timing);
    const ink = text.animate(
      opening
        ? { opacity: [shown, 1], transform: ["translateY(-8px)", "none"] }
        : { opacity: [shown, 0], transform: ["none", "translateY(-4px)"] },
      // The words fade a little ahead of the fold on the way out, and stay gone.
      { ...timing, duration: opening ? OPEN_MS : CLOSE_MS * 0.7, fill: "forwards" },
    );
    const motion = { closing: !opening, animations: [fold, ink] };
    motionRef.current = motion;
    fold.onfinish = () => {
      if (motionRef.current !== motion) return;
      motionRef.current = null;
      details.removeAttribute("data-closing");
      if (!opening) details.open = false;
      ink.cancel();
    };
  };

  return (
    <details ref={detailsRef} className={styles.faqItem}>
      <summary onClick={onToggle}>
        <span className={styles.faqQuestion}>{question}</span>
        <span className={styles.faqIcon} aria-hidden="true" />
      </summary>
      <div ref={panelRef} className={styles.faqAnswer}>
        <p>{answer}</p>
      </div>
    </details>
  );
}
