import {
  landingPageContent,
  type JourneyChapterId,
} from "../../../lib/landing-page-content.ts";

export const WHEEL_THRESHOLD = 14;
export const WHEEL_LOCK_MS = 260;
export const FAQ_WHEEL_LOCK_MS = 220;
export const NEW_GESTURE_GAP_MS = 115;
export const TOUCH_THRESHOLD_PX = 40;
export const LINE_DELTA_SCALE = 18;

export const FAQ_HASHES = [
  "faq-fit",
  "faq-switching",
  "faq-daily",
  "faq-pricing",
  "faq-data",
  "faq-roadmap",
] as const;

export type FaqHash = (typeof FAQ_HASHES)[number];

export const JOURNEY_HASH_ALIASES = Object.freeze({
  "student-path": "use-cases",
  "daily-flow": "use-cases",
  "studio-signal": "use-cases",
  "why-koaryu": "pricing",
  operations: "about",
  privacy: "about",
  "data-control": "about",
  "doors-open": "features",
  workflow: "use-cases",
  "patterns-form": "explore",
  "floor-forms": "class-ready",
  "operations-trust": "about",
} as const satisfies Readonly<Record<string, JourneyChapterId>>);

const CHAPTER_INDEX = Object.freeze(
  Object.fromEntries(
    landingPageContent.chapters.map(({ id }, index) => [id, index])
  ) as Record<JourneyChapterId, number>
);

const FAQ_HASH_INDEX = Object.freeze(
  Object.fromEntries(FAQ_HASHES.map((hash, index) => [hash, index])) as Record<
    FaqHash,
    number
  >
);

export interface ResolvedJourneyHash {
  readonly chapterId: JourneyChapterId;
  readonly chapterIndex: number;
  readonly faqGroup: number | null;
  readonly canonicalHash: JourneyChapterId | FaqHash;
  readonly wasAlias: boolean;
}

export type JourneyHashChangeDecision =
  | {
      readonly action: "reset";
      readonly chapterIndex: number;
      readonly writeHash: false;
    }
  | { readonly action: "navigate"; readonly resolved: ResolvedJourneyHash }
  | { readonly action: "ignore" };

export function resolveJourneyHash(hash: string): ResolvedJourneyHash | null {
  const normalized = hash.trim().replace(/^#/, "").toLowerCase();
  if (!normalized) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(FAQ_HASH_INDEX, normalized)) {
    const faqHash = normalized as FaqHash;
    return {
      chapterId: "faq",
      chapterIndex: CHAPTER_INDEX.faq,
      faqGroup: FAQ_HASH_INDEX[faqHash],
      canonicalHash: faqHash,
      wasAlias: false,
    };
  }

  if (Object.prototype.hasOwnProperty.call(CHAPTER_INDEX, normalized)) {
    const chapterId = normalized as JourneyChapterId;
    return {
      chapterId,
      chapterIndex: CHAPTER_INDEX[chapterId],
      faqGroup: null,
      canonicalHash: chapterId,
      wasAlias: false,
    };
  }

  if (Object.prototype.hasOwnProperty.call(JOURNEY_HASH_ALIASES, normalized)) {
    const chapterId = JOURNEY_HASH_ALIASES[
      normalized as keyof typeof JOURNEY_HASH_ALIASES
    ];
    return {
      chapterId,
      chapterIndex: CHAPTER_INDEX[chapterId],
      faqGroup: null,
      canonicalHash: chapterId,
      wasAlias: true,
    };
  }

  return null;
}

export function decideJourneyHashChange(
  hash: string
): JourneyHashChangeDecision {
  const normalized = hash.trim().replace(/^#/, "");
  if (!normalized) {
    return {
      action: "reset",
      chapterIndex: CHAPTER_INDEX.welcome,
      writeHash: false,
    };
  }

  const resolved = resolveJourneyHash(hash);
  return resolved
    ? { action: "navigate", resolved }
    : { action: "ignore" };
}

export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }

  if (deltaMode === 1) {
    return deltaY * LINE_DELTA_SCALE;
  }

  if (deltaMode === 2) {
    const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
      ? viewportHeight
      : 1;
    return deltaY * safeHeight;
  }

  return deltaY;
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function canScrollablePanelMove(
  metrics: ScrollMetrics,
  direction: -1 | 1
): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight + 2) {
    return false;
  }

  const maximum = metrics.scrollHeight - metrics.clientHeight;
  return direction > 0
    ? metrics.scrollTop < maximum - 2
    : metrics.scrollTop > 2;
}

export interface WheelGestureState {
  readonly total: number;
  readonly active: boolean;
  readonly lastAt: number;
  readonly lastMagnitude: number;
  readonly lockUntil: number;
}

export const INITIAL_WHEEL_GESTURE_STATE: WheelGestureState = Object.freeze({
  total: 0,
  active: false,
  lastAt: 0,
  lastMagnitude: 0,
  lockUntil: 0,
});

export interface WheelGestureInput {
  readonly delta: number;
  readonly now: number;
  readonly faqCanScroll: boolean;
}

export interface WheelGestureResult {
  readonly state: WheelGestureState;
  readonly action: "none" | "advance" | "faq-scroll";
  readonly direction: -1 | 0 | 1;
  readonly preventDefault: boolean;
}

export function reduceWheelGesture(
  state: WheelGestureState,
  input: WheelGestureInput
): WheelGestureResult {
  const magnitude = Math.abs(input.delta);
  const direction = input.delta > 0 ? 1 : input.delta < 0 ? -1 : 0;
  const now = Number.isFinite(input.now) ? input.now : state.lastAt;

  if (!direction || !magnitude) {
    return {
      state,
      action: "none",
      direction: 0,
      preventDefault: false,
    };
  }

  if (input.faqCanScroll) {
    return {
      state: {
        total: 0,
        active: true,
        lastAt: now,
        lastMagnitude: magnitude,
        lockUntil: now + FAQ_WHEEL_LOCK_MS,
      },
      action: "faq-scroll",
      direction,
      preventDefault: false,
    };
  }

  let nextState = state;
  if (state.active) {
    const gap = now - state.lastAt;
    const deliberateMagnitude = Math.max(24, state.lastMagnitude * 1.75);
    const newGesture =
      gap > NEW_GESTURE_GAP_MS ||
      (now > state.lockUntil && magnitude > deliberateMagnitude);

    if (!newGesture) {
      return {
        state: {
          ...state,
          lastAt: now,
          lastMagnitude: magnitude,
        },
        action: "none",
        direction: 0,
        preventDefault: true,
      };
    }

    nextState = {
      total: 0,
      active: false,
      lastAt: state.lastAt,
      lastMagnitude: state.lastMagnitude,
      lockUntil: state.lockUntil,
    };
  }

  const total = nextState.total + input.delta;
  if (Math.abs(total) < WHEEL_THRESHOLD) {
    return {
      state: {
        ...nextState,
        total,
        lastAt: now,
        lastMagnitude: magnitude,
      },
      action: "none",
      direction: 0,
      preventDefault: true,
    };
  }

  return {
    state: {
      total: 0,
      active: true,
      lastAt: now,
      lastMagnitude: magnitude,
      lockUntil: now + WHEEL_LOCK_MS,
    },
    action: "advance",
    direction: total > 0 ? 1 : -1,
    preventDefault: true,
  };
}

export type JourneyKeyDecision =
  | { readonly action: "none" }
  | { readonly action: "chapter"; readonly direction: -1 | 1 }
  | { readonly action: "chapter-edge"; readonly edge: "first" | "last" }
  | {
      readonly action: "panel-scroll";
      readonly direction: -1 | 1;
      readonly amount: "line" | "page" | "edge";
      readonly edge?: "first" | "last";
    };

export function shouldHandleJourneyKeyboardFocus(input: {
  readonly hasActiveElement: boolean;
  readonly activeIsBody: boolean;
  readonly activeIsDocumentElement: boolean;
  readonly rootContainsActive: boolean;
}): boolean {
  return (
    !input.hasActiveElement ||
    input.activeIsBody ||
    input.activeIsDocumentElement ||
    input.rootContainsActive
  );
}

export function nextFaqTopicIndex(
  currentIndex: number,
  key: string,
  topicCount: number
): number | null {
  if (
    topicCount <= 0 ||
    (key !== "ArrowDown" && key !== "ArrowUp")
  ) {
    return null;
  }
  const direction = key === "ArrowDown" ? 1 : -1;
  return (currentIndex + direction + topicCount) % topicCount;
}

export function decideJourneyKey(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly interactiveTarget: boolean;
  readonly panel: ScrollMetrics | null;
}): JourneyKeyDecision {
  if (input.interactiveTarget) {
    return { action: "none" };
  }

  if (input.panel) {
    if (input.key === "Home" || input.key === "End") {
      return {
        action: "panel-scroll",
        direction: input.key === "Home" ? -1 : 1,
        amount: "edge",
        edge: input.key === "Home" ? "first" : "last",
      };
    }

    const panelDirection = input.key === " "
      ? input.shiftKey
        ? -1
        : 1
      : input.key === "ArrowDown" || input.key === "PageDown"
        ? 1
        : input.key === "ArrowUp" || input.key === "PageUp"
          ? -1
          : 0;
    if (
      panelDirection &&
      canScrollablePanelMove(input.panel, panelDirection as -1 | 1)
    ) {
      return {
        action: "panel-scroll",
        direction: panelDirection as -1 | 1,
        amount: input.key.startsWith("Arrow") ? "line" : "page",
      };
    }
  }

  if (input.key === "Home") {
    return { action: "chapter-edge", edge: "first" };
  }
  if (input.key === "End") {
    return { action: "chapter-edge", edge: "last" };
  }
  if (input.key === " " && input.shiftKey) {
    return { action: "chapter", direction: -1 };
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === " ") {
    return { action: "chapter", direction: 1 };
  }
  if (input.key === "ArrowUp" || input.key === "PageUp") {
    return { action: "chapter", direction: -1 };
  }
  return { action: "none" };
}

export function decideTouchChapter(input: {
  readonly startY: number;
  readonly endY: number;
  readonly panelMoved: boolean;
  readonly panelCanScroll: boolean;
}): -1 | 0 | 1 {
  const distance = input.startY - input.endY;
  if (
    !Number.isFinite(distance) ||
    Math.abs(distance) < TOUCH_THRESHOLD_PX ||
    input.panelMoved ||
    input.panelCanScroll
  ) {
    return 0;
  }
  return distance > 0 ? 1 : -1;
}

export function sceneTransitionDuration(
  origin: number,
  destination: number
): 940 | 1100 | 1260 {
  const isPortalEndpointTransition =
    (Math.abs(origin - 0.288) < 0.001 && Math.abs(destination - 0.52) < 0.001) ||
    (Math.abs(origin - 0.52) < 0.001 && Math.abs(destination - 0.288) < 0.001);

  if (isPortalEndpointTransition) {
    return 1260;
  }
  return Math.max(origin, destination) > 0.52 ? 1100 : 940;
}
