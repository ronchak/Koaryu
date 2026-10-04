"use client";

import { memo, useEffect, useRef, type RefObject } from "react";

import { sceneTransitionDuration } from "./interaction-model";
import { JourneyScene, type JourneySceneHandle } from "./journey-scene";
import { clamp, easeInOut, easeOut, mix, rangeProgress, type SceneFrame } from "./scene-model";

export interface SceneTarget {
  readonly progress: number;
  readonly animate: boolean;
}

/** Light chrome over the dark curtain and the dojo ceiling; dark ink everywhere else. */
export function chromeInkForProgress(progress: number): "light" | "dark" {
  const lightMix = clamp(
    rangeProgress(progress, 0.048, 0.096) - rangeProgress(progress, 0.48, 0.52),
  );
  return lightMix >= 0.5 ? "light" : "dark";
}

function writeDataset(element: HTMLElement | null | undefined, key: string, value: string) {
  if (element && element.dataset[key] !== value) element.dataset[key] = value;
}

// The camera tween writes SVG attributes directly through the scene handle. No
// React state changes per frame, so neither the artwork nor the chapter tree
// reconciles while the camera moves.
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
  const sceneRef = useRef<JourneySceneHandle>(null);
  const progressRef = useRef(target.progress);

  useEffect(() => {
    const origin = progressRef.current;
    const destination = target.progress;
    const duration = sceneTransitionDuration(origin, destination) * (compact ? 0.62 : 1);
    // The doorway camera already accelerates cubically. A second ease-in makes
    // the mobile 05/06 transition appear stalled before it suddenly rushes past.
    const mobileDoorway =
      compact && Math.min(origin, destination) >= 0.516 && Math.max(origin, destination) <= 0.64;
    const started = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      const raw =
        target.animate && Math.abs(destination - origin) > 0.0001
          ? clamp((now - started) / duration)
          : 1;
      const eased =
        Math.max(origin, destination) > 0.52 && !mobileDoorway ? easeInOut(raw) : easeOut(raw);
      const next = mix(origin, destination, eased);
      progressRef.current = next;
      sceneRef.current?.setProgress(next);
      const root = rootRef.current;
      if (compact) {
        // The phone crop keeps the ceiling behind the header longer than desktop.
        // The footer is over the darker mountains only at the start of the story.
        writeDataset(root, "mobileHeaderInk", next >= 0.075 && next < 0.6 ? "light" : "dark");
        writeDataset(root, "mobileFooterInk", next < 0.19 ? "light" : "dark");
      } else {
        // Two discrete states; CSS eases the color. Only a change writes the DOM.
        writeDataset(root, "chromeInk", chromeInkForProgress(next));
      }
      if (raw < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [compact, rootRef, target]);

  return <JourneyScene ref={sceneRef} initialProgress={target.progress} frame={frame} />;
});
