"use client";

import { memo, useEffect, useRef, useState, type RefObject } from "react";

import { sceneTransitionDuration } from "./interaction-model";
import { JourneyScene } from "./journey-scene";
import { clamp, easeInOut, easeOut, mix, rangeProgress, type SceneFrame } from "./scene-model";

export interface SceneTarget {
  readonly progress: number;
  readonly animate: boolean;
}

// Keep frame updates inside the artwork. Navigation and the chapter tree do not
// need to reconcile sixty times a second to move the camera.
export const AnimatedJourneyScene = memo(function AnimatedJourneyScene({
  target,
  frame,
  compact,
  rootRef,
}: {
  readonly target: SceneTarget;
  readonly frame: SceneFrame;
  readonly compact: boolean;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}) {
  const progressRef = useRef(target.progress);
  const [progress, setProgress] = useState(target.progress);

  useEffect(() => {
    const origin = progressRef.current;
    const destination = target.progress;
    const duration = sceneTransitionDuration(origin, destination) * (compact ? 0.62 : 1);
    // The doorway camera already accelerates cubically. A second ease-in makes
    // the mobile 05/06 transition appear stalled before it suddenly rushes past.
    const mobileDoorway =
      compact && Math.min(origin, destination) >= 0.516 && Math.max(origin, destination) <= 0.64;
    const started = performance.now();
    let animation: number;
    const tick = (now: number) => {
      const raw =
        target.animate && Math.abs(destination - origin) > 0.0001
          ? clamp((now - started) / duration)
          : 1;
      const eased =
        Math.max(origin, destination) > 0.52 && !mobileDoorway ? easeInOut(raw) : easeOut(raw);
      const next = mix(origin, destination, eased);
      progressRef.current = next;
      setProgress(next);
      if (compact) {
        // The phone crop keeps the ceiling behind the header longer than desktop.
        // The footer is over the darker mountains only at the start of the story.
        const headerLight = next >= 0.075 && next < 0.6;
        const footerLight = next < 0.19;
        const style = rootRef.current?.style;
        for (const [property, light] of [
          ["--journey-mobile-header-color", headerLight],
          ["--journey-mobile-footer-color", footerLight],
        ] as const) {
          const color = light ? "var(--koaryu-ink-light)" : "var(--koaryu-ink)";
          // Inherited custom properties otherwise invalidate the whole page on
          // each camera frame, even though mobile only needs two color switches.
          if (style?.getPropertyValue(property) !== color) style?.setProperty(property, color);
        }
      } else {
        const lightMix = clamp(rangeProgress(next, 0.048, 0.096) - rangeProgress(next, 0.48, 0.52));
        rootRef.current?.style.setProperty(
          "--journey-chrome-color",
          `color-mix(in srgb, var(--koaryu-ink-light) ${Math.round(lightMix * 100)}%, var(--koaryu-ink))`,
        );
      }
      if (raw < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [compact, rootRef, target]);

  return <JourneyScene progress={progress} frame={frame} compact={compact} />;
});
