/**
 * The paged story, as pure functions. One wheel, swipe or key gesture moves
 * one chapter: the controller animates the document's scroll position to the
 * next composed stop along a curve planned here, and the scene follows the
 * scroll position. The gesture handling is production's, so trackpad momentum
 * never double-fires. Everything here is unit tested.
 */

import type { SceneKeyframe } from "./scroll-model.ts";

export const WHEEL_THRESHOLD = 14;
export const WHEEL_LOCK_MS = 260;
export const PANEL_WHEEL_LOCK_MS = 220;
export const NEW_GESTURE_GAP_MS = 115;
/**
 * A momentum tail can stall behind a busy frame. Deltas that are still
 * decaying continue the same gesture across pauses up to this long.
 */
export const MOMENTUM_STALL_MS = 420;
export const TOUCH_THRESHOLD_PX = 40;
export const LINE_DELTA_SCALE = 18;
/** Positions within this many pixels of a stop count as resting on it. */
export const STOP_TOLERANCE_PX = 3;

// ---------------------------------------------------------------- Gestures

export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * LINE_DELTA_SCALE;
  if (deltaMode === 2) {
    const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
    return deltaY * safeHeight;
  }
  return deltaY;
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether a chapter's own scrolling panel still has room in this direction. */
export function canScrollablePanelMove(metrics: ScrollMetrics, direction: -1 | 1): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight + 2) return false;
  const maximum = metrics.scrollHeight - metrics.clientHeight;
  return direction > 0 ? metrics.scrollTop < maximum - 2 : metrics.scrollTop > 2;
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
  /** The active chapter has a panel that can still scroll this way: let it scroll natively. */
  readonly panelCanScroll: boolean;
}

export interface WheelGestureResult {
  readonly state: WheelGestureState;
  readonly action: "none" | "advance" | "panel-scroll";
  readonly direction: -1 | 0 | 1;
  readonly preventDefault: boolean;
}

/**
 * Coalesces a stream of wheel events into gestures. A gesture advances once;
 * its momentum tail is swallowed. A new gesture starts after a pause, or when
 * the deltas jump well above a decaying tail after the short lock.
 */
export function reduceWheelGesture(
  state: WheelGestureState,
  input: WheelGestureInput,
): WheelGestureResult {
  const magnitude = Math.abs(input.delta);
  const direction = input.delta > 0 ? 1 : input.delta < 0 ? -1 : 0;
  const now = Number.isFinite(input.now) ? input.now : state.lastAt;

  if (!direction || !magnitude) {
    return { state, action: "none", direction: 0, preventDefault: false };
  }

  if (input.panelCanScroll) {
    return {
      state: {
        total: 0,
        active: true,
        lastAt: now,
        lastMagnitude: magnitude,
        lockUntil: now + PANEL_WHEEL_LOCK_MS,
      },
      action: "panel-scroll",
      direction,
      preventDefault: false,
    };
  }

  let nextState = state;
  if (state.active) {
    const gap = now - state.lastAt;
    const deliberateMagnitude = Math.max(24, state.lastMagnitude * 1.75);
    const decaying = magnitude <= state.lastMagnitude * 1.08;
    const paused = gap > NEW_GESTURE_GAP_MS && !(decaying && gap <= MOMENTUM_STALL_MS);
    const newGesture = paused || (now > state.lockUntil && magnitude > deliberateMagnitude);

    if (!newGesture) {
      return {
        state: { ...state, lastAt: now, lastMagnitude: magnitude },
        action: "none",
        direction: 0,
        preventDefault: true,
      };
    }

    nextState = { ...state, total: 0, active: false };
  }

  const total = nextState.total + input.delta;
  if (Math.abs(total) < WHEEL_THRESHOLD) {
    return {
      state: { ...nextState, total, lastAt: now, lastMagnitude: magnitude },
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

/** Marks a gesture as in progress without advancing, so its momentum tail is swallowed. */
export function holdWheelGesture(
  state: WheelGestureState,
  delta: number,
  now: number,
): WheelGestureState {
  return {
    total: 0,
    active: true,
    lastAt: now,
    lastMagnitude: Math.abs(delta) || state.lastMagnitude,
    lockUntil: Math.max(state.lockUntil, now + WHEEL_LOCK_MS),
  };
}

export type JourneyKeyDecision =
  | { readonly action: "none" }
  | { readonly action: "chapter"; readonly direction: -1 | 1 }
  | { readonly action: "chapter-edge"; readonly edge: "first" | "last" }
  | {
      readonly action: "panel-scroll";
      readonly direction: -1 | 1;
      readonly amount: "line" | "page";
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

/** Maps a key press in the story to a chapter move, a panel scroll, or nothing. */
export function decideJourneyKey(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly interactiveTarget: boolean;
  readonly panel: ScrollMetrics | null;
}): JourneyKeyDecision {
  if (input.interactiveTarget) return { action: "none" };

  const direction =
    input.key === " "
      ? input.shiftKey
        ? -1
        : 1
      : input.key === "ArrowDown" || input.key === "PageDown"
        ? 1
        : input.key === "ArrowUp" || input.key === "PageUp"
          ? -1
          : 0;

  if (input.panel && direction && canScrollablePanelMove(input.panel, direction)) {
    return {
      action: "panel-scroll",
      direction,
      amount: input.key.startsWith("Arrow") ? "line" : "page",
    };
  }
  if (input.key === "Home") return { action: "chapter-edge", edge: "first" };
  if (input.key === "End") return { action: "chapter-edge", edge: "last" };
  if (direction) return { action: "chapter", direction };
  return { action: "none" };
}

/** A finished swipe pages when it travelled far enough, mostly vertically, and no panel used it. */
export function decideTouchChapter(input: {
  readonly startY: number;
  readonly endY: number;
  readonly deltaX?: number;
  readonly panelMoved: boolean;
  readonly panelCanScroll: boolean;
}): -1 | 0 | 1 {
  const distance = input.startY - input.endY;
  if (
    !Number.isFinite(distance) ||
    Math.abs(distance) < TOUCH_THRESHOLD_PX ||
    Math.abs(input.deltaX ?? 0) >= Math.abs(distance) ||
    input.panelMoved ||
    input.panelCanScroll
  ) {
    return 0;
  }
  return distance > 0 ? 1 : -1;
}

// ---------------------------------------------------------------- Stops and beats

/** A composed frame the story rests on, at a document scroll position. */
export interface StoryStop {
  readonly id: string;
  readonly y: number;
  readonly scene: number;
}

/**
 * How the beat into a chapter plays. The outgoing copy travels `exit` screen
 * heights before the scene starts to move, and the scene arrives `enter` screen
 * heights before the next stop, so the incoming copy rises over a finished
 * frame. `via` paces the beat in between with extra scene keyframes (fractions
 * of the beat's scroll span). `ms` is the beat's own duration when paged.
 */
export interface BeatSpec {
  readonly ms: number;
  readonly exit: number;
  readonly enter: number;
  readonly via?: readonly { readonly at: number; readonly scene: number }[];
}

const DEFAULT_BEAT: BeatSpec = Object.freeze({ ms: 900, exit: 0.42, enter: 0.6 });

/** Beats keyed by the chapter they arrive at, sized to what the scene does on the way. */
export const STORY_BEATS: Readonly<Record<string, BeatSpec>> = Object.freeze({
  // One dive: the hills fall away, the camera passes through the hill's brown
  // without stopping, and the curtain parts on the dojo.
  product: {
    ms: 1380,
    exit: 0.3,
    enter: 0.6,
    via: [{ at: 0.4, scene: 0.1 }],
  },
  // The door slides open on the painted sun.
  features: { ms: 1000, exit: 0.42, enter: 0.66 },
  // One flight: through the doorway into the open sky, where the clouds gather.
  "the-weave": {
    ms: 1300,
    exit: 0.4,
    enter: 0.5,
    via: [{ at: 0.45, scene: 0.66 }],
  },
  // The clouds lie down and the threads weave through each other, then the
  // woven floor lies down, the room rises and the class sits.
  studio: {
    ms: 2000,
    exit: 0.4,
    enter: 0.6,
    via: [
      { at: 0.12, scene: 0.768 },
      { at: 0.36, scene: 0.83 },
      { at: 0.6, scene: 0.892 },
    ],
  },
  // The class becomes a framed picture and the page turns white. No copy moves.
  handoff: { ms: 1150, exit: 0, enter: 0 },
});

export function beatFor(id: string): BeatSpec {
  return STORY_BEATS[id] ?? DEFAULT_BEAT;
}

/** Copy travel speed when it leaves or arrives, in milliseconds per screen height. */
export const EXIT_MS_PER_SCREEN = 760;
export const ENTER_MS_PER_SCREEN = 880;

/**
 * Scene keyframes for the stops: each stop's frame is held while its copy is
 * on screen and the next beat plays across the scroll in between.
 */
export function storyKeyframes(
  stops: readonly StoryStop[],
  viewportHeight: number,
): SceneKeyframe[] {
  const keyframes: SceneKeyframe[] = [];
  const push = (scrollY: number, scene: number) => {
    const previous = keyframes[keyframes.length - 1];
    const y = Math.max(previous?.scrollY ?? Number.NEGATIVE_INFINITY, scrollY);
    if (previous && previous.scrollY === y && previous.scene === scene) return;
    keyframes.push({ scrollY: y, scene });
  };
  const first = stops[0];
  if (!first) return keyframes;
  push(first.y, first.scene);
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1]!;
    const to = stops[index]!;
    const beat = beatFor(to.id);
    let start = from.y + beat.exit * viewportHeight;
    let end = to.y - beat.enter * viewportHeight;
    if (end < start) {
      const middle = (from.y + to.y) / 2;
      start = Math.min(start, middle);
      end = Math.max(end, middle);
    }
    push(start, from.scene);
    for (const step of beat.via ?? []) push(start + (end - start) * step.at, step.scene);
    push(end, to.scene);
    push(to.y, to.scene);
  }
  return keyframes;
}

/** Index of the stop the position rests on, or -1 between stops. */
export function stopAt(stops: readonly StoryStop[], y: number): number {
  return stops.findIndex((stop) => Math.abs(stop.y - y) <= STOP_TOLERANCE_PX);
}

export function nearestStop(stops: readonly StoryStop[], y: number): number {
  let best = 0;
  stops.forEach((stop, index) => {
    if (Math.abs(stop.y - y) < Math.abs(stops[best]!.y - y)) best = index;
  });
  return best;
}

/** The next stop in a direction from a position (the neighbour when resting on a stop). */
export function stopToward(stops: readonly StoryStop[], y: number, direction: -1 | 1): number {
  if (!stops.length) return -1;
  if (direction > 0) {
    const next = stops.findIndex((stop) => stop.y > y + STOP_TOLERANCE_PX);
    return next === -1 ? stops.length - 1 : next;
  }
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    if (stops[index]!.y < y - STOP_TOLERANCE_PX) return index;
  }
  return 0;
}

// ---------------------------------------------------------------- Motion

export interface MotionKnot {
  readonly t: number;
  readonly y: number;
}

export interface Motion {
  readonly duration: number;
  readonly from: number;
  readonly to: number;
  position(t: number): number;
  /** Pixels per millisecond. */
  velocity(t: number): number;
}

/**
 * A smooth, monotone curve through timed positions (Fritsch-Carlson cubic
 * Hermite). It never overshoots a knot, so the scroll never runs backwards or
 * past a stop, and the velocity is continuous between segments.
 */
export function monotoneMotion(
  knots: readonly MotionKnot[],
  startVelocity = 0,
  endVelocity = 0,
): Motion {
  const points = knots.filter((knot, index) => index === 0 || knot.t > knots[index - 1]!.t + 1e-6);
  const first = points[0] ?? { t: 0, y: 0 };
  const last = points[points.length - 1] ?? first;
  if (points.length < 2) {
    return {
      duration: 0,
      from: first.y,
      to: last.y,
      position: () => last.y,
      velocity: () => 0,
    };
  }

  const count = points.length;
  const secants = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1]!;
    return (next.y - point.y) / (next.t - point.t);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return startVelocity;
    if (index === count - 1) return endVelocity;
    const before = secants[index - 1]!;
    const after = secants[index]!;
    return before * after <= 0 ? 0 : (before + after) / 2;
  });
  for (let index = 0; index < count - 1; index += 1) {
    const secant = secants[index]!;
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    // Tangents that point against the motion would make it run backwards.
    if (tangents[index]! / secant < 0) tangents[index] = 0;
    if (tangents[index + 1]! / secant < 0) tangents[index + 1] = 0;
    const alpha = tangents[index]! / secant;
    const beta = tangents[index + 1]! / secant;
    const length = alpha * alpha + beta * beta;
    if (length > 9) {
      const tau = 3 / Math.sqrt(length);
      tangents[index] = tau * alpha * secant;
      tangents[index + 1] = tau * beta * secant;
    }
  }

  const segmentAt = (t: number) => {
    let index = 0;
    while (index < count - 2 && t > points[index + 1]!.t) index += 1;
    return index;
  };

  return {
    duration: last.t - first.t,
    from: first.y,
    to: last.y,
    position(t: number) {
      if (t <= first.t) return first.y;
      if (t >= last.t) return last.y;
      const index = segmentAt(t);
      const a = points[index]!;
      const b = points[index + 1]!;
      const h = b.t - a.t;
      const s = (t - a.t) / h;
      const s2 = s * s;
      const s3 = s2 * s;
      return (
        (2 * s3 - 3 * s2 + 1) * a.y +
        (s3 - 2 * s2 + s) * h * tangents[index]! +
        (-2 * s3 + 3 * s2) * b.y +
        (s3 - s2) * h * tangents[index + 1]!
      );
    },
    velocity(t: number) {
      if (t <= first.t || t >= last.t) return t <= first.t ? startVelocity : endVelocity;
      const index = segmentAt(t);
      const a = points[index]!;
      const b = points[index + 1]!;
      const h = b.t - a.t;
      const s = (t - a.t) / h;
      const s2 = s * s;
      return (
        ((6 * s2 - 6 * s) * a.y +
          (3 * s2 - 4 * s + 1) * h * tangents[index]! +
          (-6 * s2 + 6 * s) * b.y +
          (3 * s2 - 2 * s) * h * tangents[index + 1]!) /
        h
      );
    },
  };
}

export interface MoveOptions {
  readonly viewportHeight: number;
  /** Phones play the beats a little quicker. */
  readonly compact?: boolean;
  /** Current scroll velocity (px/ms), so a retargeted move continues smoothly. */
  readonly velocity?: number;
}

/**
 * Plans the scroll from a position to a stop. From one stop to its neighbour,
 * the move follows the beat: the copy leaves at reading speed, the scene plays
 * at its own pace, the next copy arrives and settles. Longer or interrupted
 * moves take one direct, eased path.
 */
export function planMove(
  stops: readonly StoryStop[],
  fromY: number,
  toIndex: number,
  options: MoveOptions,
): Motion {
  const target = stops[toIndex];
  const height = options.viewportHeight > 0 ? options.viewportHeight : 1;
  if (!target) return monotoneMotion([{ t: 0, y: fromY }]);
  const speed = options.compact ? 0.86 : 1;
  const fromIndex = stopAt(stops, fromY);
  const neighbour = fromIndex !== -1 && Math.abs(fromIndex - toIndex) === 1;

  if (neighbour) {
    const forward = toIndex > fromIndex;
    const early = stops[Math.min(fromIndex, toIndex)]!;
    const late = stops[Math.max(fromIndex, toIndex)]!;
    const beat = beatFor(late.id);
    const beatMs = beat.ms * speed * (forward ? 1 : 0.82);
    if (beat.exit === 0 && beat.enter === 0) {
      return monotoneMotion([
        { t: 0, y: fromY },
        { t: beatMs, y: target.y },
      ]);
    }
    const start = early.y + beat.exit * height;
    const end = late.y - beat.enter * height;
    // Leaving copy moves first, at reading speed; arriving copy settles last.
    const leave = Math.max(220, (forward ? beat.exit : beat.enter) * EXIT_MS_PER_SCREEN);
    const arrive = Math.max(300, (forward ? beat.enter : beat.exit) * ENTER_MS_PER_SCREEN);
    const [first, second] = forward ? [start, end] : [end, start];
    const startVelocity = ((first - fromY) / leave) * 0.7;
    return monotoneMotion(
      [
        { t: 0, y: fromY },
        { t: leave, y: first },
        { t: leave + beatMs, y: second },
        { t: leave + beatMs + arrive, y: target.y },
      ],
      startVelocity,
      0,
    );
  }

  const distance = Math.abs(target.y - fromY) / height;
  const duration = Math.min(1800, Math.max(620, 520 + distance * 210)) * speed;
  return monotoneMotion(
    [
      { t: 0, y: fromY },
      { t: duration, y: target.y },
    ],
    options.velocity ?? 0,
    0,
  );
}

/** Hand-off progress (0 the full scene, 1 the framed picture) for a scroll position. */
export function handoffProgress(y: number, classY: number, handoffY: number): number {
  if (!(handoffY > classY)) return y >= handoffY ? 1 : 0;
  const t = Math.min(1, Math.max(0, (y - classY) / (handoffY - classY)));
  // Ease in and out so the picture starts softly and lands softly.
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface PictureRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HandoffGeometry {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
  /** clip-path inset on the full-screen layer, in px: top, right, bottom, left. */
  readonly inset: readonly [number, number, number, number];
  /** Where the visible picture sits on screen. */
  readonly rect: PictureRect;
}

/**
 * Maps the full-screen scene into a framed picture. The picture shows a crop
 * of the scene with the slot's proportions, centred on `focusY` (a fraction of
 * the layer's height where the class sits), scaled into the slot.
 */
export function handoffGeometry(input: {
  readonly layerWidth: number;
  readonly layerHeight: number;
  readonly slot: PictureRect;
  readonly focusY: number;
  readonly progress: number;
}): HandoffGeometry {
  const { layerWidth: width, layerHeight: height, slot } = input;
  const p = Math.min(1, Math.max(0, input.progress));
  const slotAspect = slot.width / Math.max(1, slot.height);
  let cropWidth = width;
  let cropHeight = width / slotAspect;
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = height * slotAspect;
  }
  const cropLeft = (width - cropWidth) / 2;
  const cropTop = Math.min(
    height - cropHeight,
    Math.max(0, input.focusY * height - cropHeight / 2),
  );
  const finalScale = slot.width / cropWidth;
  const scale = 1 + (finalScale - 1) * p;
  const translateX = (slot.left - finalScale * cropLeft) * p;
  const translateY = (slot.top - finalScale * cropTop) * p;
  const inset: [number, number, number, number] = [
    cropTop * p,
    (width - cropLeft - cropWidth) * p,
    (height - cropTop - cropHeight) * p,
    cropLeft * p,
  ];
  return {
    scale,
    translateX,
    translateY,
    inset,
    rect: {
      left: translateX + scale * inset[3],
      top: translateY + scale * inset[0],
      width: scale * (width - inset[1] - inset[3]),
      height: scale * (height - inset[0] - inset[2]),
    },
  };
}

/** Copy waits this far clear of the picture's edge and frame, and returns over this distance. */
export const COPY_CLEARANCE_PX = 6;
export const COPY_RETURN_PX = 28;

/**
 * How visible a block of copy is beside a picture moving into its frame: whole
 * while it lies well inside the picture or well clear of it and its frame,
 * gone while an edge or the frame passes through it, so text and frame never
 * cross. `settled` is how far clear the copy sits once the picture has landed;
 * the return ramp ends there, so the settled layout is always fully visible.
 */
export function copyClearance(
  box: PictureRect,
  picture: PictureRect,
  frame: number,
  settled: number,
  /** Copy written on the wall of the picture may also show while the picture still holds it. */
  onWall = true,
): number {
  const inside = Math.min(
    box.left - picture.left,
    box.top - picture.top,
    picture.left + picture.width - (box.left + box.width),
    picture.top + picture.height - (box.top + box.height),
  );
  const outside = Math.max(
    picture.left - frame - (box.left + box.width),
    box.left - (picture.left + picture.width + frame),
    picture.top - frame - (box.top + box.height),
    box.top - (picture.top + picture.height + frame),
  );
  const start = Math.min(COPY_CLEARANCE_PX, settled - 1);
  const span = Math.max(1, Math.min(COPY_RETURN_PX, settled - start));
  const ramp = (distance: number) => Math.min(1, Math.max(0, (distance - start) / span));
  return Math.max(onWall ? ramp(inside) : 0, ramp(outside));
}

/** Copy drifts this far (px) as it fades in or out where it rests. */
export const COPY_DRIFT_PX = 10;

export interface CopyReveal {
  readonly opacity: number;
  /** Offset from the resting place, px (down while arriving, up while leaving). */
  readonly drift: number;
}

const smoothstep = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

/**
 * Copy is held at its resting place while its screen scrolls in and out, so it
 * never rides across moving art or under the masthead: it fades in once the
 * scene beneath has settled and fades out before the scene starts to move.
 * `offset` is where the chapter sits, in screen heights below its stop (negative
 * once it is leaving); `enter` is the arriving beat's settle point and `exit`
 * the next beat's departure (both from STORY_BEATS).
 */
export function copyReveal(offset: number, enter: number, exit: number): CopyReveal {
  if (offset > 0) {
    // A margin after the scene settles, so a slow frame never shows copy over moving art.
    const start = enter * 0.82;
    const full = enter * 0.42;
    const shown = smoothstep((start - offset) / Math.max(0.001, start - full));
    return { opacity: shown, drift: (1 - shown) * COPY_DRIFT_PX };
  }
  const by = Math.max(0.04, Math.min(0.16, exit * 0.7));
  const shown = 1 - smoothstep(-offset / by);
  return { opacity: shown, drift: (shown - 1) * COPY_DRIFT_PX };
}

/**
 * Where to centre the framed picture's crop (a fraction of the layer height)
 * so the seated class is composed inside a tall screen's frame: the heads a
 * little below the frame's top edge, never cut, the floor below them.
 */
export function classFocus(input: {
  readonly layerWidth: number;
  readonly layerHeight: number;
  readonly slot: PictureRect;
  /** The top of the class on the layer, px. */
  readonly classTop: number;
}): number {
  const { layerWidth: width, layerHeight: height, slot } = input;
  const aspect = slot.width / Math.max(1, slot.height);
  const cropHeight = Math.min(height, width / aspect);
  const top = Math.min(height - cropHeight, Math.max(0, input.classTop - cropHeight * 0.18));
  return (top + cropHeight / 2) / Math.max(1, height);
}
