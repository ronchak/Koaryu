"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { MarketingHeader } from "../public-pages";
import { JourneyScene, classTop, type JourneySceneHandle } from "./journey-scene";
import {
  INITIAL_WHEEL_GESTURE_STATE,
  STOP_TOLERANCE_PX,
  beatFor,
  canScrollablePanelMove,
  classFocus,
  copyClearance,
  copyReveal,
  decideJourneyKey,
  decideTouchChapter,
  handoffGeometry,
  handoffProgress,
  holdWheelGesture,
  monotoneMotion,
  nearestStop,
  normalizeWheelDelta,
  planMove,
  reduceWheelGesture,
  shouldHandleJourneyKeyboardFocus,
  stopAt,
  stopToward,
  storyKeyframes,
  type Motion,
  type PictureRect,
  type ScrollMetrics,
  type StoryStop,
} from "./paging-model";
import { SCENE_HEIGHT, SCENE_WIDTH, frameForDimensions } from "./scene-model";
import {
  mastheadOverHills,
  mastheadTone,
  progressForScroll,
  resolveLegacyHash,
  stillFrame,
  type SceneKeyframe,
} from "./scroll-model";
import { WeaveLoom, type WeaveLoomHandle } from "./weave-loom";
import styles from "./journey.module.css";

/** Fraction of the remaining distance the camera covers per frame when the reader scrubs. */
const CAMERA_EASING = 0.24;
/** A native scroll in the story (scrollbar, find, focus) settles on the nearest stop after this. */
const SETTLE_AFTER_MS = 280;
const COMPACT_QUERY = "(max-width: 820px)";
const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** Where the class sits in the scene layer on wide screens, as a fraction of its height, for the framed picture. */
const PICTURE_FOCUS = Object.freeze({ wide: 0.62 });
const MASTHEAD_DIRECTION_PX = 6;
/** Jumps longer than this many screens cut through a veil. */
const FAR_SCREENS = 3.2;
const VEIL_MS = 190;

const studio = landingPageContent.story.find((chapter) => chapter.kind === "studio");

/** Rail entries: every chapter, then the hand-off where the page begins. */
export const RAIL_STOPS: readonly { id: string; label: string; title: string }[] = [
  ...landingPageContent.story.map(({ id, label, title }) => ({ id, label, title })),
  {
    id: "handoff",
    label: studio?.handoffLabel ?? "Get started",
    title: studio?.handoffLabel ?? "Get started",
  },
];

function metricsFor(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

interface Reveal {
  readonly element: HTMLElement;
  readonly y: number;
  readonly enter: number;
  readonly exit: number;
  /** The studio headline stays put through the hand-off once it has arrived. */
  readonly arriveOnly: boolean;
  applied: string;
}

interface CopyBox {
  readonly element: HTMLElement;
  readonly name: string;
  readonly onWall: boolean;
  readonly box: PictureRect;
  /** How far clear of the framed picture the copy sits once the page has begun. */
  readonly settled: number;
}

/** The box the copy's ink and controls actually cover, tighter than its block. */
function inkBox(element: HTMLElement): DOMRect | null {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    rects.push(...Array.from(range.getClientRects()));
  }
  for (const control of element.querySelectorAll("a, button")) {
    rects.push(control.getBoundingClientRect());
  }
  const solid = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!solid.length) return null;
  const left = Math.min(...solid.map((rect) => rect.left));
  const top = Math.min(...solid.map((rect) => rect.top));
  const right = Math.max(...solid.map((rect) => rect.right));
  const bottom = Math.max(...solid.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function isFormTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function scrollToY(y: number) {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
}

interface JourneyControllerProps {
  readonly children: ReactNode;
}

interface Engine {
  go(id: string, history: "push" | "replace" | "none"): boolean;
  goIndex(index: number): void;
}

export function JourneyController({ children }: JourneyControllerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const sceneLayerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const mastheadRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<JourneySceneHandle>(null);
  const loomRef = useRef<WeaveLoomHandle>(null);
  const engineRef = useRef<Engine | null>(null);
  const [frame, setFrame] = useState(() => frameForDimensions(SCENE_WIDTH, SCENE_HEIGHT));
  const [layerSize, setLayerSize] = useState({ width: SCENE_WIDTH, height: SCENE_HEIGHT });
  const [enhanced, setEnhanced] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = rootRef.current;
    const dock = dockRef.current;
    const layer = sceneLayerRef.current;
    const ring = ringRef.current;
    const masthead = mastheadRef.current;
    if (!root || !dock || !layer || !ring || !masthead) return;

    const motionQuery = window.matchMedia(MOTION_QUERY);
    const compactQuery = window.matchMedia(COMPACT_QUERY);
    let stops: StoryStop[] = [];
    let panels: (HTMLElement | null)[] = [];
    let keyframes: SceneKeyframe[] = [];
    let scenes: number[] = [];
    let classY = 0;
    let pageY = 0;
    let viewportHeight = window.innerHeight;
    let layerWidth = 0;
    let layerHeight = 0;
    let viewBoxHeight = 1000;
    let slot: PictureRect | null = null;
    let studioElement: HTMLElement | null = null;
    let copyBoxes: CopyBox[] = [];
    let pictureFocus: number = PICTURE_FOCUS.wide;
    let reveals: Reveal[] = [];
    let frameWidth = 16;
    let motion: Motion | null = null;
    let motionStart = 0;
    let motionTarget = -1;
    let frameRequest = 0;
    let displayed = Number.NaN;
    let appliedScene = Number.NaN;
    let appliedPicture = "";
    let restingIndex = 0;
    let wheelState = INITIAL_WHEEL_GESTURE_STATE;
    let settleTimer = 0;
    let pointerDown = false;
    let lastScrollY = window.scrollY;
    let mastheadHidden = false;
    let touch: {
      startY: number;
      startX: number;
      mode: "story" | "edge" | "page";
      panel: HTMLElement | null;
      panelStart: number;
      panelMetrics: ScrollMetrics | null;
    } | null = null;

    const setFlag = (name: string, value: string) => {
      if (root.dataset[name] !== value) root.dataset[name] = value;
    };
    /** The controller's own scroll writes, so a scroll event can tell them from the reader's. */
    let writtenY = Number.NaN;
    const jumpTo = (y: number) => {
      writtenY = y;
      scrollToY(y);
    };
    /** The masthead's menu is open: the story leaves the wheel to it. */
    const menuOpen = () => Boolean(masthead.querySelector("details[open]"));
    const reduced = () => motionQuery.matches;
    const inPage = (y: number) => y > pageY + STOP_TOLERANCE_PX;
    const atPageStart = (y: number) => Math.abs(y - pageY) <= STOP_TOLERANCE_PX;

    const measure = () => {
      viewportHeight = window.innerHeight;
      const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-stop]"));
      stops = elements.map((element, index) => ({
        id: element.dataset.stop ?? "",
        // The story opens at the very top of the document.
        y: index === 0 ? 0 : Math.round(element.getBoundingClientRect().top + window.scrollY),
        scene: Number(element.dataset.scene ?? 0),
      }));
      panels = elements.map((element) => element.querySelector<HTMLElement>("[data-panel]"));
      // Every chapter's copy, held in place and faded by the scroll (see copyReveal).
      for (const reveal of reveals) {
        reveal.element.style.opacity = "";
        reveal.element.style.transform = "";
      }
      reveals = [];
      elements.forEach((element, index) => {
        const stop = stops[index]!;
        const next = stops[index + 1];
        const copy =
          panels[index] ?? element.querySelector<HTMLElement>("[data-handoff-copy='heading']");
        if (!copy || stop.id === "handoff") return;
        reveals.push({
          element: copy,
          y: stop.y,
          enter: beatFor(stop.id).enter,
          exit: next ? beatFor(next.id).exit : 0,
          arriveOnly: !panels[index],
          applied: "",
        });
      });
      keyframes = storyKeyframes(stops, viewportHeight);
      scenes = stops.map(({ scene }) => scene);
      classY = stops.find(({ id }) => id === "studio")?.y ?? 0;
      pageY = stops[stops.length - 1]?.y ?? 0;
      // The stage lets go exactly where the copy's pin does: one screen above
      // the dock's end, at the hand-off marker (unrounded, as layout places it).
      const marker = elements[elements.length - 1];
      if (marker?.dataset.stop === "handoff") {
        const run = marker.getBoundingClientRect().top - dock.getBoundingClientRect().top;
        dock.style.height = `calc(${run.toFixed(3)}px + 100lvh)`;
      }

      const slotElement = root.querySelector<HTMLElement>("[data-picture-slot]");
      const pinned = slotElement?.closest<HTMLElement>("[data-pinned]");
      studioElement = pinned?.parentElement ?? null;
      if (slotElement && pinned) {
        const box = slotElement.getBoundingClientRect();
        const pin = pinned.getBoundingClientRect();
        slot = { left: box.left, top: box.top - pin.top, width: box.width, height: box.height };
      }
      frameWidth =
        Number.parseFloat(getComputedStyle(ring).getPropertyValue("--frame-width")) || 16;

      // The scene layer uses the large viewport, so mobile toolbars collapsing
      // do not reframe the artwork. Only a real size change does.
      // Layout size, not the transformed box: the layer may be mid hand-off.
      const width = layer.offsetWidth;
      const height = layer.offsetHeight;
      if (Math.abs(width - layerWidth) > 1 || Math.abs(height - layerHeight) > 1) {
        layerWidth = width;
        layerHeight = height;
        const nextFrame = frameForDimensions(width, height);
        viewBoxHeight = Number(nextFrame.viewBox.split(" ")[3]) || 1000;
        setFrame(nextFrame);
        setLayerSize({ width: Math.round(width), height: Math.round(height) });
      }
      // Tall screens compose the class inside the frame from where it actually sits.
      pictureFocus = PICTURE_FOCUS.wide;
      if (slot && layerWidth < layerHeight) {
        const sceneFrame = frameForDimensions(layerWidth, layerHeight);
        const [, top, , viewHeight] = sceneFrame.viewBox.split(" ").map(Number) as [
          number,
          number,
          number,
          number,
        ];
        const scale = Math.max(layerWidth / SCENE_WIDTH, layerHeight / viewHeight);
        const offset = (layerHeight - viewHeight * scale) / 2;
        pictureFocus = classFocus({
          layerWidth,
          layerHeight,
          slot,
          classTop: offset + (classTop(sceneFrame) - top) * scale,
        });
      }
      // The copy beside the picture, and how far clear of the settled frame it sits.
      const pin = pinned?.getBoundingClientRect();
      copyBoxes = [];
      if (pin && slot) {
        const settledRect = handoffGeometry({
          layerWidth,
          layerHeight,
          slot,
          focusY: pictureFocus,
          progress: 1,
        }).rect;
        for (const element of pinned!.querySelectorAll<HTMLElement>("[data-handoff-copy]")) {
          const ink = inkBox(element);
          if (!ink) continue;
          // Where the copy rests in the pinned layout, whatever its reveal transforms are doing now.
          const drawn = element.getBoundingClientRect();
          let left = 0;
          let top = 0;
          for (
            let node: HTMLElement | null = element;
            node && node !== pinned;
            node = node.offsetParent as HTMLElement | null
          ) {
            left += node.offsetLeft;
            top += node.offsetTop;
          }
          const box = {
            left: pin.left + left + ink.left - drawn.left,
            top: top + ink.top - drawn.top,
            width: ink.width,
            height: ink.height,
          };
          copyBoxes.push({
            element,
            name: element.dataset.handoffCopy ?? "",
            // Only the headline is written on the wall; the rest belongs to the page beside the picture.
            onWall: element.dataset.handoffCopy === "heading",
            box,
            settled: Math.max(
              settledRect.left - frameWidth - (box.left + box.width),
              box.left - (settledRect.left + settledRect.width + frameWidth),
              settledRect.top - frameWidth - (box.top + box.height),
              box.top - (settledRect.top + settledRect.height + frameWidth),
            ),
          });
        }
      }
      appliedPicture = "";
      appliedScene = Number.NaN;
    };

    const clearCopy = (picture: PictureRect | null) => {
      for (const { name, box, settled, onWall } of copyBoxes) {
        const value = picture ? copyClearance(box, picture, frameWidth, settled, onWall) : 1;
        studioElement?.style.setProperty(`--clear-${name}`, value.toFixed(3));
      }
    };

    const announce = (index: number) => {
      restingIndex = index;
      setActive(index);
    };

    const writeHash = (index: number) => {
      const stop = stops[index];
      if (!stop || stop.id === "handoff") return;
      const hash = stop.id === "welcome" ? "" : `#${stop.id}`;
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(window.history.state, "", url);
      }
    };

    /**
     * Shapes the picture for the hand-off. Only the shape is written here: the
     * stage holds the picture still through the story and the page's own
     * scroll carries it away afterwards, so nothing here follows the scroll.
     */
    const applyPicture = (y: number) => {
      const progress =
        y >= pageY - STOP_TOLERANCE_PX ? 1 : reduced() ? 0 : handoffProgress(y, classY, pageY);
      const key = progress.toFixed(4);
      if (key === appliedPicture) return;
      appliedPicture = key;
      setFlag("handoff", progress <= 0 ? "none" : progress >= 1 ? "settled" : "moving");
      setFlag("zone", progress >= 0.5 ? "page" : "story");
      studioElement?.style.setProperty("--handoff", progress.toFixed(3));
      if (progress <= 0 || !slot) {
        layer.style.transform = "";
        layer.style.clipPath = "";
        ring.style.opacity = "0";
        clearCopy(null);
        return;
      }
      const geometry = handoffGeometry({
        layerWidth,
        layerHeight,
        slot,
        focusY: pictureFocus,
        progress,
      });
      const [top, right, bottom, left] = geometry.inset;
      layer.style.transform = `translate3d(${geometry.translateX.toFixed(2)}px, ${geometry.translateY.toFixed(2)}px, 0) scale(${geometry.scale.toFixed(5)})`;
      layer.style.clipPath = `inset(${top.toFixed(2)}px ${right.toFixed(2)}px ${bottom.toFixed(2)}px ${left.toFixed(2)}px)`;
      const { rect } = geometry;
      ring.style.transform = `translate3d(${rect.left.toFixed(2)}px, ${rect.top.toFixed(2)}px, 0)`;
      ring.style.width = `${rect.width.toFixed(2)}px`;
      ring.style.height = `${rect.height.toFixed(2)}px`;
      ring.style.opacity = String(Math.min(1, progress * 2.4).toFixed(3));
      // Text never shares the screen with a passing edge or frame: it waits, then returns.
      clearCopy(progress >= 1 ? null : rect);
    };

    const applyReveals = (y: number) => {
      const still = reduced();
      for (const reveal of reveals) {
        const offset = (reveal.y - y) / viewportHeight;
        let opacity = "";
        let transform = "";
        if (!still && Math.abs(offset) < 1.5 && !(reveal.arriveOnly && offset <= 0)) {
          const { opacity: shown, drift } = copyReveal(offset, reveal.enter, reveal.exit);
          opacity = shown >= 0.999 ? "" : shown.toFixed(3);
          const hold = -offset * viewportHeight + drift;
          transform = Math.abs(hold) < 0.25 ? "" : `translate3d(0, ${hold.toFixed(1)}px, 0)`;
        } else if (!still && Math.abs(offset) >= 1.5) {
          opacity = "0";
        }
        const key = `${opacity}|${transform}`;
        if (key === reveal.applied) continue;
        reveal.applied = key;
        reveal.element.style.opacity = opacity;
        reveal.element.style.transform = transform;
      }
    };

    const tick = (now: number) => {
      frameRequest = 0;
      let y = window.scrollY;
      if (motion) {
        const elapsed = now - motionStart;
        const next = motion.position(elapsed);
        if (Math.abs(next - y) >= 0.5) jumpTo(next);
        y = next;
        if (elapsed >= motion.duration) {
          jumpTo(motion.to);
          y = motion.to;
          motion = null;
          const index = stopAt(stops, y);
          if (index !== -1) {
            announce(index);
            writeHash(index);
          }
        }
      }

      const target = progressForScroll(y, keyframes);
      if (reduced()) {
        displayed = stillFrame(target, scenes);
      } else if (motion || Number.isNaN(displayed)) {
        displayed = target;
      } else {
        const distance = target - displayed;
        displayed = Math.abs(distance) < 0.0006 ? target : displayed + distance * CAMERA_EASING;
      }
      if (displayed !== appliedScene) {
        appliedScene = displayed;
        sceneRef.current?.setProgress(displayed);
        loomRef.current?.setProgress(displayed);
        setFlag("tone", mastheadTone(displayed, viewBoxHeight));
      }
      applyPicture(y);
      applyReveals(y);
      setFlag("scrolled", y > 8 && !mastheadOverHills(displayed, viewBoxHeight) ? "true" : "false");

      // On phones the masthead steps aside while the page is read downward. It
      // stays through the hand-off and on the frame, so no page turn moves it.
      const delta = y - lastScrollY;
      if (!compactQuery.matches || !inPage(y)) {
        mastheadHidden = false;
        lastScrollY = y;
      } else if (Math.abs(delta) > MASTHEAD_DIRECTION_PX) {
        mastheadHidden = delta > 0;
        lastScrollY = y;
      }
      setFlag("mastheadHidden", mastheadHidden && !menuOpen() ? "true" : "false");

      if (motion || displayed !== target) frameRequest = window.requestAnimationFrame(tick);
    };

    const schedule = () => {
      if (!frameRequest) frameRequest = window.requestAnimationFrame(tick);
    };

    const preparePanel = (index: number, fromY: number) => {
      const panel = panels[index];
      const stop = stops[index];
      // Settling back onto the chapter the reader is in keeps their place in its panel.
      if (!panel || !stop || Math.abs(stop.y - fromY) < viewportHeight * 0.5) return;
      // Arriving from above starts at the top of the day; from below, at its end.
      panel.scrollTop = stop.y >= fromY ? 0 : panel.scrollHeight;
    };

    const startMotion = (next: Motion, targetIndex: number) => {
      motion = next.duration > 0 ? next : null;
      motionStart = performance.now();
      motionTarget = targetIndex;
      if (!motion) {
        jumpTo(next.to);
        const index = stopAt(stops, next.to);
        if (index !== -1) {
          announce(index);
          writeHash(index);
        }
      }
      schedule();
    };

    /**
     * WebKit keeps snapping the window back to a fragment it landed on until
     * the page itself is scrolled, so a chapter panel scrolling inside itself
     * would drag the whole story with it. Before the first input after a
     * fragment landing, a one-pixel nudge releases it.
     */
    let fragmentHeld = false;
    const releaseFragment = () => {
      if (!fragmentHeld) return;
      fragmentHeld = false;
      const y = window.scrollY;
      jumpTo(y > 0 ? y - 1 : y + 1);
      jumpTo(y);
    };

    const currentVelocity = () => (motion ? motion.velocity(performance.now() - motionStart) : 0);

    /**
     * Far jumps (links, Home, the rail) cut through a brief veil instead of
     * racing through every beat: calmer, and nothing has to repaint at speed.
     */
    let veilTimer = 0;
    const cut = (y: number, index: number) => {
      motion = null;
      window.clearTimeout(veilTimer);
      setFlag("veil", "on");
      veilTimer = window.setTimeout(() => {
        jumpTo(y);
        if (index !== -1) {
          announce(index);
          writeHash(index);
        }
        schedule();
        window.requestAnimationFrame(() => setFlag("veil", "off"));
      }, VEIL_MS);
    };
    const isFar = (fromY: number, toY: number) =>
      Math.abs(toY - fromY) > viewportHeight * FAR_SCREENS;

    const goIndex = (requested: number) => {
      if (!stops.length) return;
      const index = Math.max(0, Math.min(stops.length - 1, requested));
      const fromY = window.scrollY;
      preparePanel(index, fromY);
      const fromIndex = stopAt(stops, fromY);
      const neighbour = fromIndex !== -1 && Math.abs(fromIndex - index) === 1;
      if (!reduced() && !neighbour && !motion && isFar(fromY, stops[index]!.y)) {
        cut(stops[index]!.y, index);
        return;
      }
      if (reduced()) {
        motion = null;
        jumpTo(stops[index]!.y);
        announce(index);
        writeHash(index);
        schedule();
        return;
      }
      startMotion(
        planMove(stops, fromY, index, {
          viewportHeight,
          compact: compactQuery.matches,
          velocity: currentVelocity(),
        }),
        index,
      );
    };

    const goY = (y: number) => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const targetY = Math.max(0, Math.min(max, Math.round(y)));
      if (reduced()) {
        motion = null;
        jumpTo(targetY);
        schedule();
        return;
      }
      if (!motion && isFar(window.scrollY, targetY)) {
        cut(targetY, stopAt(stops, targetY));
        return;
      }
      const distance = Math.abs(targetY - window.scrollY) / viewportHeight;
      const duration = Math.min(1700, Math.max(560, 480 + distance * 170));
      startMotion(
        monotoneMotion(
          [
            { t: 0, y: window.scrollY },
            { t: duration, y: targetY },
          ],
          currentVelocity(),
          0,
        ),
        -1,
      );
    };

    /**
     * Reading back up out of the page comes to rest on the frame: a short
     * ease from wherever the reader's scroll has reached, carrying its speed
     * (px/ms, negative going up). Only a fresh gesture there pages on.
     */
    const landOnFrame = (velocity: number) => {
      const y = window.scrollY;
      const distance = y - pageY;
      if (reduced() || distance <= 2) {
        motion = null;
        jumpTo(pageY);
        schedule();
        return;
      }
      const duration = Math.min(420, Math.max(160, distance * 1.2));
      startMotion(
        monotoneMotion(
          [
            { t: 0, y },
            { t: duration, y: pageY },
          ],
          Math.min(0, velocity),
          0,
        ),
        stops.length - 1,
      );
    };

    const goRelative = (direction: -1 | 1) => {
      const y = window.scrollY;
      const base = motion && motionTarget !== -1 ? motionTarget : stopAt(stops, y);
      const index = base === -1 ? stopToward(stops, y, direction) : base + direction;
      if (index < 0 || index >= stops.length) return;
      if (!motion && index === base) return;
      goIndex(index);
    };

    const go = (id: string, history: "push" | "replace" | "none") => {
      const resolved = resolveLegacyHash(`#${id}`) ?? id;
      const index = stops.findIndex((stop) => stop.id === resolved);
      const element = index === -1 ? document.getElementById(resolved) : null;
      if (index === -1 && !element) return false;
      if (history !== "none") {
        const url = `${window.location.pathname}${window.location.search}${resolved === "welcome" ? "" : `#${resolved}`}`;
        if (history === "push") window.history.pushState(null, "", url);
        else window.history.replaceState(window.history.state, "", url);
      }
      if (index !== -1) {
        goIndex(index);
      } else if (element) {
        const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
        goY(element.getBoundingClientRect().top + window.scrollY - margin);
      }
      return true;
    };

    engineRef.current = { go, goIndex };

    /** The scrolling panel of the stop the reader rests on, if any. */
    const restingPanel = (): HTMLElement | null => {
      if (motion) return null;
      const index = stopAt(stops, window.scrollY);
      return index === -1 ? null : (panels[index] ?? null);
    };

    const settle = () => {
      settleTimer = 0;
      if (motion || touch || pointerDown) return;
      const y = window.scrollY;
      if (y >= pageY - STOP_TOLERANCE_PX || stopAt(stops, y) !== -1) {
        const index = stopAt(stops, y);
        if (index !== -1 && index !== restingIndex) announce(index);
        return;
      }
      goIndex(nearestStop(stops, y));
    };

    let seenY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const fromY = seenY;
      seenY = y;
      // A native scroll that runs up out of the page (keys, a fling's momentum)
      // stops on the frame, as the wheel does. Where the stage and the copy are
      // both pinned, nothing on screen shows the few pixels it overshot.
      if (
        !motion &&
        !touch &&
        !pointerDown &&
        Math.abs(y - writtenY) > 1.5 &&
        fromY > pageY + STOP_TOLERANCE_PX &&
        y < pageY - STOP_TOLERANCE_PX
      ) {
        jumpTo(pageY);
        seenY = pageY;
      }
      schedule();
      if (motion || touch) return;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SETTLE_AFTER_MS);
    };

    const onWheel = (event: WheelEvent) => {
      releaseFragment();
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (menuOpen()) return;
      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, window.innerHeight);
      if (!delta) return;
      const direction = delta > 0 ? 1 : -1;
      const y = window.scrollY;
      const now = event.timeStamp;

      if (!motion && (inPage(y) || (atPageStart(y) && direction > 0))) {
        // The page scrolls natively. Scrolling up into the frame comes to rest
        // on the frame; the next gesture pages back into the story.
        if (direction < 0 && y + delta < pageY) {
          event.preventDefault();
          // A wheel step is about one frame's travel.
          landOnFrame(delta / 16);
          wheelState = holdWheelGesture(wheelState, delta, now);
          return;
        }
        wheelState = reduceWheelGesture(wheelState, { delta, now, panelCanScroll: true }).state;
        return;
      }

      const panel = restingPanel();
      const panelCanScroll = panel ? canScrollablePanelMove(metricsFor(panel), direction) : false;
      const result = reduceWheelGesture(wheelState, { delta, now, panelCanScroll });
      wheelState = result.state;
      if (result.action === "panel-scroll") {
        if (panel && !(event.target instanceof Node && panel.contains(event.target))) {
          event.preventDefault();
          panel.scrollBy({ top: delta, behavior: "instant" });
        }
        return;
      }
      if (result.preventDefault) event.preventDefault();
      if (result.action === "advance") goRelative(direction);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      releaseFragment();
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      const activeElement = document.activeElement;
      if (
        !shouldHandleJourneyKeyboardFocus({
          hasActiveElement: Boolean(activeElement),
          activeIsBody: activeElement === document.body,
          activeIsDocumentElement: activeElement === document.documentElement,
          rootContainsActive: Boolean(activeElement && root.contains(activeElement)),
        })
      ) {
        return;
      }
      const y = window.scrollY;
      const down =
        ["ArrowDown", "PageDown", "End"].includes(event.key) ||
        (event.key === " " && !event.shiftKey);
      const onControl =
        isFormTarget(activeElement) ||
        (event.key === " " &&
          activeElement instanceof Element &&
          Boolean(activeElement.closest("a, button, summary")));
      if (!motion && inPage(y)) {
        if (onControl) return;
        // Home goes back to the hills, through the veil.
        if (event.key === "Home") {
          event.preventDefault();
          goIndex(0);
          return;
        }
        // The page reads natively; the step that would run past the top of the
        // page comes to rest on the frame instead.
        const step =
          event.key === "ArrowUp"
            ? 40
            : event.key === "PageUp" || (event.key === " " && event.shiftKey)
              ? viewportHeight * 0.875
              : 0;
        if (step && y - step < pageY + STOP_TOLERANCE_PX) {
          event.preventDefault();
          landOnFrame(0);
        }
        return;
      }
      if (!motion && atPageStart(y) && down) return;
      const panel = restingPanel();
      const decision = decideJourneyKey({
        key: event.key,
        shiftKey: event.shiftKey,
        interactiveTarget: onControl,
        panel: panel ? metricsFor(panel) : null,
      });
      if (decision.action === "none") return;
      event.preventDefault();
      if (decision.action === "chapter") goRelative(decision.direction);
      else if (decision.action === "chapter-edge")
        goIndex(decision.edge === "first" ? 0 : stops.length - 1);
      else if (panel) {
        const amount = decision.amount === "line" ? 64 : panel.clientHeight * 0.8;
        panel.scrollBy({
          top: decision.direction * amount,
          behavior: reduced() ? "auto" : "smooth",
        });
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      releaseFragment();
      if (
        event.touches.length !== 1 ||
        isFormTarget(event.target) ||
        (window.visualViewport?.scale ?? 1) > 1.01
      ) {
        touch = null;
        return;
      }
      const point = event.touches[0]!;
      const y = window.scrollY;
      const panel = restingPanel();
      const usesPanel =
        panel && event.target instanceof Node && panel.contains(event.target) ? panel : null;
      touch = {
        startY: point.clientY,
        startX: point.clientX,
        mode: motion ? "story" : inPage(y) ? "page" : atPageStart(y) ? "edge" : "story",
        panel: usesPanel,
        panelStart: usesPanel?.scrollTop ?? 0,
        panelMetrics: usesPanel ? metricsFor(usesPanel) : null,
      };
      window.clearTimeout(settleTimer);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!touch || touch.mode === "page" || event.touches.length !== 1) return;
      const point = event.touches[0]!;
      const dy = point.clientY - touch.startY;
      const dx = point.clientX - touch.startX;
      if (Math.abs(dy) < Math.abs(dx)) return;
      const direction = dy < 0 ? 1 : -1;
      if (touch.mode === "edge") {
        if (direction > 0) {
          touch.mode = "page";
          return;
        }
      } else if (touch.panel && canScrollablePanelMove(metricsFor(touch.panel), direction)) {
        return;
      }
      if (event.cancelable) event.preventDefault();
    };

    const onTouchEnd = (event: TouchEvent) => {
      const current = touch;
      touch = null;
      const point = event.changedTouches[0];
      if (!current || !point || current.mode === "page") {
        onScroll();
        return;
      }
      const direction = current.startY - point.clientY > 0 ? 1 : -1;
      const panel = current.panel;
      const chapter = decideTouchChapter({
        startY: current.startY,
        endY: point.clientY,
        deltaX: point.clientX - current.startX,
        panelMoved: panel ? Math.abs(panel.scrollTop - current.panelStart) > 4 : false,
        panelCanScroll:
          Boolean(
            current.panelMetrics && canScrollablePanelMove(current.panelMetrics, direction),
          ) || Boolean(panel && canScrollablePanelMove(metricsFor(panel), direction)),
      });
      if (chapter && (current.mode === "story" || chapter < 0)) {
        if (event.cancelable) event.preventDefault();
        goRelative(chapter);
      }
    };

    const onTouchCancel = () => {
      touch = null;
    };

    const onPointerDown = () => {
      releaseFragment();
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
      onScroll();
    };

    // Keyboard focus moving into a chapter brings that chapter's frame.
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      const owner = event.target.closest<HTMLElement>("[data-focus-stop]");
      const index = owner ? stops.findIndex((stop) => stop.id === owner.dataset.focusStop) : -1;
      if (index === -1) return;
      if (stopAt(stops, window.scrollY) === index && !motion) return;
      if (motion && motionTarget === index) return;
      goIndex(index);
    };

    const onHashChange = () => {
      fragmentHeld = true;
      const id = window.location.hash.replace(/^#/, "");
      if (!id) {
        goIndex(0);
        return;
      }
      go(decodeURIComponent(id), resolveLegacyHash(window.location.hash) ? "replace" : "none");
    };

    const onResize = () => {
      const resting = motion ? motionTarget : stopAt(stops, window.scrollY);
      measure();
      if (resting !== -1 && stops[resting] && !motion) jumpTo(stops[resting]!.y);
      schedule();
    };

    // Enhanced layout (the hand-off run, pinned copy) applies before anything is measured.
    root.dataset.enhanced = "true";
    measure();
    // Land a linked or restored visitor on a composed frame.
    const initialHash = window.location.hash.replace(/^#/, "");
    if (initialHash) {
      const resolved = resolveLegacyHash(window.location.hash);
      const id = resolved ?? decodeURIComponent(initialHash);
      if (resolved) {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}#${resolved}`,
        );
      }
      const index = stops.findIndex((stop) => stop.id === id);
      if (index !== -1) jumpTo(stops[index]!.y);
      else document.getElementById(id)?.scrollIntoView({ block: "start" });
    }
    fragmentHeld = Boolean(initialHash);
    {
      const y = window.scrollY;
      const index = stopAt(stops, y);
      if (index !== -1) announce(index);
      else if (y < pageY) goIndex(nearestStop(stops, y));
      else announce(stops.length - 1);
    }
    tick(performance.now());
    setEnhanced(true);

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(layer);
    resizeObserver.observe(root);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: false });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("hashchange", onHashChange);
    root.addEventListener("focusin", onFocusIn);
    motionQuery.addEventListener("change", schedule);
    return () => {
      engineRef.current = null;
      window.cancelAnimationFrame(frameRequest);
      window.clearTimeout(settleTimer);
      window.clearTimeout(veilTimer);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("hashchange", onHashChange);
      root.removeEventListener("focusin", onFocusIn);
      motionQuery.removeEventListener("change", schedule);
    };
  }, []);

  // In-page links travel through the story instead of cutting to it.
  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
    const destination = new URL(anchor.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      destination.pathname !== window.location.pathname ||
      !destination.hash ||
      destination.hash === "#main-content"
    ) {
      return;
    }
    const id = decodeURIComponent(destination.hash.slice(1));
    if (engineRef.current?.go(id, "push")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const activeStop = RAIL_STOPS[active] ?? RAIL_STOPS[0]!;

  return (
    <div
      ref={rootRef}
      className={styles.journey}
      data-enhanced={enhanced ? "true" : "false"}
      data-scrolled="false"
      data-masthead-hidden="false"
      data-tone="light"
      data-zone="story"
      data-handoff="none"
      data-veil="off"
      data-active={activeStop.id}
      onClickCapture={onClickCapture}
    >
      <div ref={dockRef} className={styles.stageDock} aria-hidden="true">
        <div className={styles.stage}>
          <div ref={sceneLayerRef} className={styles.sceneLayer}>
            <JourneyScene ref={sceneRef} frame={frame} />
            {/* The weave is part of the picture: it takes the scene's paper grain. */}
            <WeaveLoom ref={loomRef} width={layerSize.width} height={layerSize.height} />
          </div>
          {/* The timber frame the story has been inside all along. */}
          <div ref={ringRef} className={styles.pictureRing} />
        </div>
      </div>
      <div className={styles.veil} aria-hidden="true" />
      {/* A belt that ranks up from white to black as the page is read. */}
      <div className={styles.beltProgress} aria-hidden="true" />
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div ref={mastheadRef} className={styles.masthead}>
        <MarketingHeader />
      </div>
      {children}
      <nav className={styles.rail} aria-label="Story chapters">
        <ol>
          {RAIL_STOPS.map((stop, index) => (
            <li key={stop.id}>
              <button
                type="button"
                aria-current={index === active ? "step" : undefined}
                onClick={() => engineRef.current?.goIndex(index)}
              >
                <span className={styles.railLabel}>
                  <span className={styles.railNumber} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {stop.label}
                </span>
                <span className={styles.railDot} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <p className={styles.liveStatus} aria-live="polite" aria-atomic="true">
        {enhanced ? `Chapter ${active + 1} of ${RAIL_STOPS.length}: ${activeStop.title}` : ""}
      </p>
    </div>
  );
}
