"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { MarketingHeader } from "../public-pages";
import { JourneyScene, type JourneySceneHandle } from "./journey-scene";
import { SCENE_HEIGHT, SCENE_WIDTH, frameForDimensions } from "./scene-model";
import {
  keyframesForLayout,
  progressForScroll,
  resolveLegacyHash,
  stillFrame,
  type SceneKeyframe,
} from "./scroll-model";
import styles from "./journey.module.css";

/** Fraction of the remaining distance the camera covers per frame; smooths stepped mouse wheels. */
const CAMERA_EASING = 0.22;
const SCROLLED_THRESHOLD_PX = 8;
/** On phones the masthead steps aside while reading down and returns on any upward scroll. */
const MASTHEAD_HIDE_AFTER_PX = 160;
const MASTHEAD_DIRECTION_PX = 6;
/**
 * Scrolls the visitor did not make (snap corrections, momentum settling) must
 * not toggle the masthead, so direction follows their latest gesture for this long.
 */
const GESTURE_MEMORY_MS = 3000;
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End", " "]);
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const COMPACT_QUERY = "(max-width: 820px)";

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
    const compactQuery = window.matchMedia(COMPACT_QUERY);
    let keyframes: SceneKeyframe[] = [];
    let scenes: number[] = [];
    let displayed = Number.NaN;
    let applied = Number.NaN;
    let frameRequest = 0;
    let layerWidth = 0;
    let layerHeight = 0;
    let lastScrollY = window.scrollY;
    let mastheadHidden = false;
    let gestureDirection = 0;
    let gestureAt = Number.NEGATIVE_INFINITY;
    let touchY: number | null = null;

    // These listeners only observe which way the visitor is moving; they never block input.
    const noteGesture = (direction: number) => {
      gestureDirection = direction;
      gestureAt = performance.now();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY) noteGesture(Math.sign(event.deltaY));
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY === null || y === undefined || Math.abs(y - touchY) < 4) return;
      noteGesture(y < touchY ? 1 : -1);
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (DOWN_KEYS.has(event.key)) noteGesture(1);
      else if (UP_KEYS.has(event.key)) noteGesture(-1);
    };

    const measure = () => {
      const chapters = Array.from(root.querySelectorAll<HTMLElement>("[data-journey-chapter]"));
      const top = (element: Element) => element.getBoundingClientRect().top + window.scrollY;
      const layout = chapters.map((chapter, index) => {
        const interlude = chapter.nextElementSibling?.hasAttribute("data-journey-interlude")
          ? chapter.nextElementSibling
          : null;
        const next = chapters[index + 1];
        const gapCenter = interlude
          ? top(interlude) + interlude.getBoundingClientRect().height / 2
          : next
            ? top(next)
            : Number.POSITIVE_INFINITY;
        return { scene: Number(chapter.dataset.scene ?? 0), gapCenter };
      });
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      keyframes = keyframesForLayout(layout, window.innerHeight, maxScroll);
      scenes = layout.map(({ scene }) => scene);

      // The scene layer uses the large viewport, so mobile toolbars collapsing do
      // not reframe the artwork. Only a real size change does.
      const { width, height } = layer.getBoundingClientRect();
      if (Math.abs(width - layerWidth) > 1 || Math.abs(height - layerHeight) > 1) {
        layerWidth = width;
        layerHeight = height;
        setFrame(frameForDimensions(width, height));
      }
    };

    const setFlag = (name: string, value: boolean) => {
      const next = value ? "true" : "false";
      if (root.dataset[name] !== next) root.dataset[name] = next;
    };

    const tick = () => {
      frameRequest = 0;
      const scrollY = window.scrollY;
      setFlag("scrolled", scrollY > SCROLLED_THRESHOLD_PX);

      const delta = scrollY - lastScrollY;
      if (!compactQuery.matches || scrollY < MASTHEAD_HIDE_AFTER_PX) {
        mastheadHidden = false;
      } else if (Math.abs(delta) > MASTHEAD_DIRECTION_PX) {
        const direction = Math.sign(delta);
        const recentGesture = performance.now() - gestureAt < GESTURE_MEMORY_MS;
        if (!recentGesture || direction === gestureDirection) mastheadHidden = direction > 0;
      }
      // Small steps accumulate until they show a direction, so slow scrolling counts too.
      if (Math.abs(delta) > MASTHEAD_DIRECTION_PX) lastScrollY = scrollY;
      // Keep the masthead visible while the menu inside it is open.
      setFlag("mastheadHidden", mastheadHidden && !root.querySelector("details[open]"));

      const target = progressForScroll(scrollY, keyframes);
      if (motionQuery.matches) {
        displayed = stillFrame(target, scenes);
      } else {
        const distance = target - displayed;
        displayed =
          Number.isNaN(displayed) || Math.abs(distance) < 0.0008
            ? target
            : displayed + distance * CAMERA_EASING;
      }
      // While a chapter is being read the scene holds, so most scroll frames write nothing.
      if (displayed !== applied) {
        applied = displayed;
        sceneRef.current?.setProgress(displayed);
      }
      if (displayed !== target && !motionQuery.matches) {
        frameRequest = window.requestAnimationFrame(tick);
      }
    };

    const schedule = () => {
      if (!frameRequest) frameRequest = window.requestAnimationFrame(tick);
    };

    const remeasure = () => {
      measure();
      schedule();
    };

    measure();
    tick();
    setEnhanced(true);

    const resizeObserver = new ResizeObserver(remeasure);
    resizeObserver.observe(root);
    resizeObserver.observe(layer);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown, { passive: true });
    motionQuery.addEventListener("change", schedule);
    return () => {
      window.cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
      motionQuery.removeEventListener("change", schedule);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.journey}
      data-enhanced={enhanced ? "true" : "false"}
      data-scrolled="false"
      data-masthead-hidden="false"
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
