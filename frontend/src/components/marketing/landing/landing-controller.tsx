"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  FILM_LENGTH,
  TITLE_CUES,
  cueState,
  filmPosition,
  handoffAt,
  sceneAt,
  type TitleCueId,
} from "../journey/film-model";
import { JourneyScene, type JourneySceneHandle } from "../journey/journey-scene";
import { SCENE_HEIGHT, SCENE_WIDTH, frameForDimensions } from "../journey/scene-model";
import { MarketingHeader } from "../public-pages";
import { resolveLegacyHash } from "./legacy-hash";
import styles from "./film.module.css";

/**
 * The camera follows the scroll position with this time constant (ms), which
 * smooths stepped mouse wheels without depending on the frame rate.
 */
const CAMERA_LAG_MS = 70;
/** Jumps longer than this (in screens), such as a link to another section, cut instead of racing. */
const CAMERA_CUT = 1.5;
/** How far a title drifts as it fades in or out, in pixels. */
const TITLE_DRIFT = 26;
const TOP_ZONE_PX = 24;
const DIRECTION_PX = 6;
const COMPACT_QUERY = "(max-width: 820px)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface LandingControllerProps {
  /** The film's title cards, rendered on the server. */
  readonly titles: ReactNode;
  /** Act two: the page. */
  readonly children: ReactNode;
}

interface Cue {
  readonly element: HTMLElement;
  readonly id: TitleCueId;
  opacity: number;
  shift: number;
}

function readNumber(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Act one is a film pinned to the screen and scrubbed by native scrolling; act
 * two is an ordinary page. One passive scroll listener feeds one animation
 * frame, which writes attributes and styles directly. Nothing intercepts input.
 */
export function LandingController({ titles, children }: LandingControllerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<JourneySceneHandle>(null);
  const [frame, setFrame] = useState(() => frameForDimensions(SCENE_WIDTH, SCENE_HEIGHT));

  // Older links used section names that no longer exist; send them to the matching section.
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
    const film = filmRef.current;
    const stage = stageRef.current;
    const picture = pictureRef.current;
    const art = artRef.current;
    const pictureFrame = frameRef.current;
    if (!root || !film || !stage || !picture || !art || !pictureFrame) return;

    const motionQuery = window.matchMedia(MOTION_QUERY);
    const compactQuery = window.matchMedia(COMPACT_QUERY);
    let live = false;
    let cues: Cue[] = [];
    let filmTop = 0;
    let filmEnd = 0;
    let screen = 1;
    let stageWidth = 0;
    let stageHeight = 0;
    let handoffScale = 0.54;
    let crop = [0, 0, 0, 0];
    let displayed = Number.NaN;
    let appliedScene = Number.NaN;
    let appliedHandoff = Number.NaN;
    let frameRequest = 0;
    let lastFrameAt = 0;
    let lastScrollY = window.scrollY;
    let mastheadHidden = false;

    const setFlag = (name: string, value: string) => {
      if (root.dataset[name] !== value) root.dataset[name] = value;
    };

    const measure = () => {
      const rect = film.getBoundingClientRect();
      filmTop = rect.top + window.scrollY;
      const box = stage.getBoundingClientRect();
      screen = box.height || window.innerHeight;
      filmEnd = filmTop + FILM_LENGTH * screen;
      cues = Array.from(root.querySelectorAll<HTMLElement>("[data-cue-body]")).map((element) => ({
        element,
        id: element.dataset.cueBody as TitleCueId,
        opacity: Number.NaN,
        shift: Number.NaN,
      }));
      const style = getComputedStyle(picture);
      handoffScale = readNumber(style, "--handoff-scale", 0.54);
      crop = ["--crop-top", "--crop-right", "--crop-bottom", "--crop-left"].map((name) =>
        readNumber(style, name, 0),
      );
      appliedHandoff = Number.NaN;
      // The stage uses the large viewport, so mobile toolbars collapsing do not
      // reframe the artwork. Only a real size change does.
      if (Math.abs(box.width - stageWidth) > 1 || Math.abs(box.height - stageHeight) > 1) {
        stageWidth = box.width;
        stageHeight = box.height;
        setFrame(frameForDimensions(box.width, box.height));
      }
    };

    const clearFilmStyles = () => {
      for (const cue of cues) {
        cue.element.style.opacity = "";
        cue.element.style.transform = "";
        cue.opacity = Number.NaN;
        cue.shift = Number.NaN;
      }
      picture.style.transform = "";
      art.style.clipPath = "";
      pictureFrame.style.cssText = "";
      appliedHandoff = Number.NaN;
    };

    const applyHandoff = (value: number) => {
      if (Math.abs(value - appliedHandoff) < 0.0004) return;
      appliedHandoff = value;
      const [top, right, bottom, left] = crop.map((edge) => edge * value) as [
        number,
        number,
        number,
        number,
      ];
      const scale = 1 - (1 - handoffScale) * value;
      picture.style.transform = value > 0 ? `scale(${scale.toFixed(4)})` : "";
      art.style.clipPath =
        value > 0 && crop.some(Boolean)
          ? `inset(${top.toFixed(3)}% ${right.toFixed(3)}% ${bottom.toFixed(3)}% ${left.toFixed(3)}%)`
          : "";
      pictureFrame.style.inset = `${top}% ${right}% ${bottom}% ${left}%`;
      pictureFrame.style.opacity = value > 0 ? String(Math.min(1, value * 3).toFixed(3)) : "0";
      setFlag("handoff", value >= 0.999 ? "settled" : value > 0 ? "moving" : "none");
    };

    const tick = () => {
      frameRequest = 0;
      const scrollY = window.scrollY;

      // Masthead: clear over the hills, out of the way while the film plays
      // downward, back (grounded) on any upward scroll and on the page.
      const delta = scrollY - lastScrollY;
      if (Math.abs(delta) > DIRECTION_PX) {
        const inFilm = live && scrollY < filmEnd - screen * 0.2;
        if (scrollY < TOP_ZONE_PX) mastheadHidden = false;
        else if (delta < 0) mastheadHidden = false;
        else if (inFilm || compactQuery.matches) mastheadHidden = true;
        else mastheadHidden = false;
        lastScrollY = scrollY;
      }
      if (scrollY < TOP_ZONE_PX) mastheadHidden = false;
      setFlag("scrolled", scrollY > TOP_ZONE_PX ? "true" : "false");
      // Keep the masthead visible while the menu inside it is open.
      setFlag(
        "mastheadHidden",
        mastheadHidden && !root.querySelector("details[open]") ? "true" : "false",
      );

      if (!live) return;

      const target = filmPosition(scrollY, filmTop, screen);
      const distance = target - displayed;
      const now = performance.now();
      // After an idle stretch, the first step is one ordinary frame long.
      const elapsed = lastFrameAt ? Math.min(100, Math.max(8, now - lastFrameAt)) : 16;
      lastFrameAt = now;
      displayed =
        Number.isNaN(displayed) || Math.abs(distance) < 0.0006 || Math.abs(distance) > CAMERA_CUT
          ? target
          : displayed + distance * (1 - Math.exp(-elapsed / CAMERA_LAG_MS));

      const scene = sceneAt(displayed);
      if (scene !== appliedScene) {
        appliedScene = scene;
        sceneRef.current?.setProgress(scene);
      }
      for (const cue of cues) {
        const { opacity, shift } = cueState(TITLE_CUES[cue.id], displayed);
        // NaN (never written) compares false, so a new cue always writes once.
        if (!(Math.abs(opacity - cue.opacity) <= 0.002 && Math.abs(shift - cue.shift) <= 0.002)) {
          cue.opacity = opacity;
          cue.shift = shift;
          cue.element.style.opacity = opacity.toFixed(3);
          cue.element.style.transform = shift
            ? `translate3d(0, ${(shift * TITLE_DRIFT).toFixed(2)}px, 0)`
            : "";
          cue.element.dataset.shown = opacity > 0.5 ? "true" : "false";
        }
      }
      applyHandoff(handoffAt(displayed));
      if (displayed !== target) frameRequest = window.requestAnimationFrame(tick);
      else lastFrameAt = 0;
    };

    const schedule = () => {
      if (!frameRequest) frameRequest = window.requestAnimationFrame(tick);
    };

    const setMode = () => {
      const nextLive = !motionQuery.matches;
      const changed = nextLive !== live;
      live = nextLive;
      film.dataset.mode = live ? "live" : "still";
      measure();
      if (!live) {
        clearFilmStyles();
        appliedScene = Number.NaN;
        sceneRef.current?.setProgress(0);
        setFlag("handoff", "none");
      }
      displayed = Number.NaN;
      tick();
      return changed;
    };

    const changedOnMount = setMode();
    // The page first renders as still frames; once the film takes over, the
    // document is longer, so return a linked visitor to their section.
    const hashTarget = window.location.hash
      ? document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
      : null;
    if (changedOnMount && hashTarget) hashTarget.scrollIntoView({ block: "start" });

    const remeasure = () => {
      measure();
      schedule();
    };
    const onMotionChange = () => {
      setMode();
    };

    const resizeObserver = new ResizeObserver(remeasure);
    resizeObserver.observe(root);
    resizeObserver.observe(stage);
    window.addEventListener("scroll", schedule, { passive: true });
    motionQuery.addEventListener("change", onMotionChange);
    return () => {
      window.cancelAnimationFrame(frameRequest);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.landing}
      data-scrolled="false"
      data-masthead-hidden="false"
      data-handoff="none"
    >
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.beltProgress} aria-hidden="true" />
      <div className={styles.masthead}>
        <MarketingHeader />
      </div>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        <section
          ref={filmRef}
          className={styles.film}
          data-mode="still"
          aria-label="Koaryu, the story"
          style={{ "--film-length": FILM_LENGTH } as CSSProperties}
        >
          <div ref={stageRef} className={styles.stage} aria-hidden="true">
            <div ref={pictureRef} className={styles.picture}>
              <div ref={artRef} className={styles.art}>
                <JourneyScene ref={sceneRef} frame={frame} />
              </div>
              <div ref={frameRef} className={styles.pictureFrame} />
            </div>
          </div>
          {titles}
        </section>
        {children}
      </main>
    </div>
  );
}
