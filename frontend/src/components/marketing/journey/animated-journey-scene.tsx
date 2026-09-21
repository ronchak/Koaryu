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
    const started = performance.now();
    let animation: number;
    const tick = (now: number) => {
      const raw =
        target.animate && Math.abs(destination - origin) > 0.0001
          ? clamp((now - started) / duration)
          : 1;
      const eased = Math.max(origin, destination) > 0.52 ? easeInOut(raw) : easeOut(raw);
      const next = mix(origin, destination, eased);
      progressRef.current = next;
      setProgress(next);
      const lightMix = clamp(rangeProgress(next, 0.048, 0.096) - rangeProgress(next, 0.48, 0.52));
      rootRef.current?.style.setProperty(
        "--journey-chrome-color",
        `color-mix(in srgb, var(--koaryu-ink-light) ${Math.round(lightMix * 100)}%, var(--koaryu-ink))`,
      );
      if (raw < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [compact, rootRef, target]);

  return <JourneyScene progress={progress} frame={frame} compact={compact} />;
});
