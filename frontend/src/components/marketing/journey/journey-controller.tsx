"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { MarketingHeader } from "../public-pages";
import { JourneyScene, type JourneySceneHandle } from "./journey-scene";
import { SCENE_HEIGHT, SCENE_WIDTH, frameForDimensions } from "./scene-model";
import {
  anchorsForLayout,
  nearestAnchorScene,
  progressForScroll,
  resolveLegacyHash,
  type SceneAnchor,
} from "./scroll-model";
import styles from "./journey.module.css";

/** Fraction of the remaining distance the camera covers per frame; smooths stepped mouse wheels. */
const CAMERA_EASING = 0.22;
const SCROLLED_THRESHOLD_PX = 8;

interface JourneyControllerProps {
  readonly children: ReactNode;
}

export function JourneyController({ children }: JourneyControllerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneLayerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<JourneySceneHandle>(null);
  const [frame, setFrame] = useState(() => frameForDimensions(SCENE_WIDTH, SCENE_HEIGHT));
  const [enhanced, setEnhanced] = useState(false);

  // Older links used chapter names that no longer exist; send them to the matching section.
  useEffect(() => {
    const rewrite = () => {
      const target = resolveLegacyHash(window.location.hash);
      if (!target) return;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#${target}`,
      );
      document.getElementById(target)?.scrollIntoView({ block: "start" });
    };
    rewrite();
    window.addEventListener("hashchange", rewrite);
    return () => window.removeEventListener("hashchange", rewrite);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const layer = sceneLayerRef.current;
    if (!root || !layer) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let anchors: SceneAnchor[] = [];
    let displayed = Number.NaN;
    let frameRequest = 0;
    let layerWidth = 0;
    let layerHeight = 0;

    const measure = () => {
      const chapters = Array.from(
        root.querySelectorAll<HTMLElement>("[data-journey-chapter]"),
        (chapter) => {
          const box = chapter.getBoundingClientRect();
          return {
            top: box.top + window.scrollY,
            height: box.height,
            scene: Number(chapter.dataset.scene ?? 0),
          };
        },
      );
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      anchors = anchorsForLayout(chapters, window.innerHeight, maxScroll);

      // The scene layer uses the large viewport, so mobile toolbars collapsing do
      // not reframe the artwork. Only a real size change does.
      const { width, height } = layer.getBoundingClientRect();
      if (Math.abs(width - layerWidth) > 1 || Math.abs(height - layerHeight) > 1) {
        layerWidth = width;
        layerHeight = height;
        setFrame(frameForDimensions(width, height));
      }
    };

    const tick = () => {
      frameRequest = 0;
      const scrollY = window.scrollY;
      root.dataset.scrolled = scrollY > SCROLLED_THRESHOLD_PX ? "true" : "false";

      const reduced = motionQuery.matches;
      const target = reduced
        ? nearestAnchorScene(scrollY, anchors)
        : progressForScroll(scrollY, anchors);
      const distance = target - displayed;
      displayed =
        reduced || Number.isNaN(displayed) || Math.abs(distance) < 0.0008
          ? target
          : displayed + distance * CAMERA_EASING;
      sceneRef.current?.setProgress(displayed);
      if (displayed !== target) frameRequest = window.requestAnimationFrame(tick);
    };

    const schedule = () => {
      if (!frameRequest) frameRequest = window.requestAnimationFrame(tick);
    };

    const remeasure = () => {
      measure();
      schedule();
    };

    measure();
    displayed = Number.NaN;
    tick();
    setEnhanced(true);

    const resizeObserver = new ResizeObserver(remeasure);
    resizeObserver.observe(root);
    resizeObserver.observe(layer);
    window.addEventListener("scroll", schedule, { passive: true });
    motionQuery.addEventListener("change", schedule);
    return () => {
      window.cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      motionQuery.removeEventListener("change", schedule);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.journey}
      data-enhanced={enhanced ? "true" : "false"}
      data-scrolled="false"
    >
      <div ref={sceneLayerRef} className={styles.sceneLayer} aria-hidden="true">
        <JourneyScene ref={sceneRef} frame={frame} />
      </div>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.masthead}>
        <MarketingHeader />
      </div>
      {children}
    </div>
  );
}
