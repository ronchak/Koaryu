import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  INITIAL_WHEEL_GESTURE_STATE,
  STORY_BEATS,
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
  stopAt,
  stopToward,
  storyKeyframes,
  storyCuts,
  cutCover,
} from "../src/components/marketing/journey/paging-model.ts";
import {
  LANDING_HASH_ALIASES,
  mastheadOverHills,
  mastheadTone,
  progressForScroll,
  resolveLegacyHash,
  stillFrame,
} from "../src/components/marketing/journey/scroll-model.ts";
import {
  LOOM_PHASES,
  LOOM_ROWS,
  loomFrame,
  loomLayout,
  warpPath,
  weftPath,
} from "../src/components/marketing/journey/weave-model.ts";

const H = 1000;
const stops = [
  { id: "welcome", y: 0, scene: 0 },
  { id: "product", y: 1500, scene: 0.288 },
  { id: "features", y: 3200, scene: 0.52 },
  { id: "studio", y: 6000, scene: 1 },
  { id: "handoff", y: 6700, scene: 1 },
];

/** Feeds wheel deltas at a fixed interval and counts chapter advances. */
function advancesFor(deltas, interval = 16, start = 1000) {
  let state = INITIAL_WHEEL_GESTURE_STATE;
  let advances = 0;
  deltas.forEach((delta, index) => {
    const result = reduceWheelGesture(state, {
      delta,
      now: start + index * interval,
      panelCanScroll: false,
    });
    state = result.state;
    if (result.action === "advance") advances += 1;
  });
  return { advances, state };
}

function momentum(peak = 60, length = 70, decay = 0.93) {
  return Array.from({ length }, (_, index) => Math.max(1, peak * decay ** index));
}

describe("Wheel, key and touch gestures", () => {
  it("advances once per trackpad swipe, however long its momentum tail", () => {
    assert.equal(advancesFor(momentum()).advances, 1);
    assert.equal(advancesFor(momentum().map((delta) => -delta)).advances, 1);
  });

  it("keeps a tail together across a stalled frame, but not a fresh swipe", () => {
    const tail = momentum();
    let state = INITIAL_WHEEL_GESTURE_STATE;
    let advances = 0;
    let now = 0;
    tail.forEach((delta, index) => {
      now += index === 20 ? 300 : 16; // a busy frame delays one event
      const result = reduceWheelGesture(state, { delta, now, panelCanScroll: false });
      state = result.state;
      if (result.action === "advance") advances += 1;
    });
    assert.equal(advances, 1);
    // A deliberate new swipe after the lock pages again.
    const next = reduceWheelGesture(state, { delta: 80, now: now + 40, panelCanScroll: false });
    assert.equal(next.action, "advance");
  });

  it("pages on one mouse notch and on a pause between gestures", () => {
    assert.equal(advancesFor([100]).advances, 1);
    assert.equal(advancesFor([100, 100], 600).advances, 2);
    assert.equal(advancesFor([6]).advances, 0);
  });

  it("lets a scrollable chapter scroll natively and swallows its tail at the edge", () => {
    const panel = reduceWheelGesture(INITIAL_WHEEL_GESTURE_STATE, {
      delta: 40,
      now: 100,
      panelCanScroll: true,
    });
    assert.equal(panel.action, "panel-scroll");
    assert.equal(panel.preventDefault, false);
    const edge = reduceWheelGesture(panel.state, { delta: 30, now: 116, panelCanScroll: false });
    assert.equal(edge.action, "none");
    assert.equal(edge.preventDefault, true);
    const held = holdWheelGesture(INITIAL_WHEEL_GESTURE_STATE, -50, 500);
    assert.equal(
      reduceWheelGesture(held, { delta: -40, now: 516, panelCanScroll: false }).action,
      "none",
    );
  });

  it("normalises line and page deltas", () => {
    assert.equal(normalizeWheelDelta(3, 1, 900), 54);
    assert.equal(normalizeWheelDelta(1, 2, 900), 900);
    assert.equal(normalizeWheelDelta(Number.NaN, 0, 900), 0);
  });

  it("maps keys to chapters, panel scrolling or nothing", () => {
    const at = (key, panel = null, extra = {}) =>
      decideJourneyKey({ key, shiftKey: false, interactiveTarget: false, panel, ...extra });
    assert.deepEqual(at("ArrowDown"), { action: "chapter", direction: 1 });
    assert.deepEqual(at("PageUp"), { action: "chapter", direction: -1 });
    assert.deepEqual(at(" ", null, { shiftKey: true }), { action: "chapter", direction: -1 });
    assert.deepEqual(at("Home"), { action: "chapter-edge", edge: "first" });
    assert.deepEqual(at("End"), { action: "chapter-edge", edge: "last" });
    const panel = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };
    assert.deepEqual(at("PageDown", panel), {
      action: "panel-scroll",
      direction: 1,
      amount: "page",
    });
    assert.deepEqual(at("ArrowUp", panel), { action: "chapter", direction: -1 });
    assert.deepEqual(at("ArrowDown", null, { interactiveTarget: true }), { action: "none" });
    assert.equal(
      canScrollablePanelMove({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 }, 1),
      false,
    );
  });

  it("pages on a vertical swipe that no panel used", () => {
    assert.equal(
      decideTouchChapter({ startY: 600, endY: 300, panelMoved: false, panelCanScroll: false }),
      1,
    );
    assert.equal(
      decideTouchChapter({ startY: 300, endY: 600, panelMoved: false, panelCanScroll: false }),
      -1,
    );
    assert.equal(
      decideTouchChapter({ startY: 600, endY: 580, panelMoved: false, panelCanScroll: false }),
      0,
    );
    assert.equal(
      decideTouchChapter({
        startY: 600,
        endY: 300,
        deltaX: 400,
        panelMoved: false,
        panelCanScroll: false,
      }),
      0,
    );
    assert.equal(
      decideTouchChapter({ startY: 600, endY: 300, panelMoved: true, panelCanScroll: false }),
      0,
    );
  });
});

describe("Stops, beats and motion", () => {
  it("finds the stop a position rests on, the nearest one and the next one each way", () => {
    assert.equal(stopAt(stops, 1502), 1);
    assert.equal(stopAt(stops, 1600), -1);
    assert.equal(nearestStop(stops, 2600), 2);
    assert.equal(stopToward(stops, 1500, 1), 2);
    assert.equal(stopToward(stops, 1500, -1), 0);
    assert.equal(stopToward(stops, 2000, -1), 1);
    assert.equal(stopToward(stops, 9000, 1), stops.length - 1);
  });

  it("holds each stop's frame while its copy is on screen and plays the beat in between", () => {
    const keyframes = storyKeyframes(stops, H);
    assert.equal(progressForScroll(0, keyframes), 0);
    assert.equal(progressForScroll(1500, keyframes), 0.288);
    // The copy leaves before the scene moves...
    const beat = STORY_BEATS.product;
    assert.equal(progressForScroll(beat.exit * H - 1, keyframes), 0);
    // ...and the scene has arrived before the next copy settles.
    assert.equal(progressForScroll(1500 - beat.enter * H + 1, keyframes), 0.288);
    const positions = keyframes.map(({ scrollY }) => scrollY);
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
    const scenes = keyframes.map(({ scene }) => scene);
    assert.deepEqual(
      scenes,
      [...scenes].sort((a, b) => a - b),
    );
    assert.equal(progressForScroll(6700, keyframes), 1);
    assert.deepEqual(storyKeyframes([], H), []);
  });

  it("dissolves from the clouds into the room, never playing the scene between", () => {
    const pair = [
      { id: "the-weave", y: 0, scene: 0.685 },
      { id: "studio", y: 1900, scene: 1 },
    ];
    const keyframes = storyKeyframes(pair, H);
    const [cut] = storyCuts(pair, H);
    const { at, scene } = STORY_BEATS.studio.cut;
    const end = 1900 - 0.6 * H;
    assert.equal(cut.to, scene);
    assert.equal(cut.y, 0.4 * H + (end - 0.4 * H) * at);
    // The clouds hold right up to the cut, and the room is there right after it.
    assert.equal(progressForScroll(cut.y - 1, keyframes), 0.685);
    assert.ok(progressForScroll(cut.y + 1, keyframes) >= scene);
    // No keyframe lands inside the weave.
    assert.ok(!keyframes.some((frame) => frame.scene > 0.69 && frame.scene < scene));
    // A still of the clouds covers the art as soon as the reader leaves them,
    // hides the jump, and has dissolved into the room before the class's copy.
    assert.equal(cutCover([cut], 0), null);
    assert.deepEqual(cutCover([cut], 1), { scene: 0.685, opacity: 1 });
    assert.equal(cutCover([cut], cut.y).opacity, 1);
    assert.equal(cutCover([cut], cut.y + cut.reach / 2).opacity, 0.5);
    assert.equal(cutCover([cut], cut.y + cut.reach), null);
    assert.ok(cut.y + cut.reach < end);
    assert.equal(cutCover([cut], 1900), null);
  });

  it("draws a monotone, smooth curve that never overshoots a knot", () => {
    const motion = monotoneMotion([
      { t: 0, y: 0 },
      { t: 300, y: 450 },
      { t: 1300, y: 900 },
      { t: 1800, y: 1500 },
    ]);
    let previous = -1;
    for (let t = 0; t <= 1800; t += 10) {
      const y = motion.position(t);
      assert.ok(y >= previous - 1e-9, `runs backwards at ${t}`);
      assert.ok(y <= 1500 + 1e-9);
      previous = y;
    }
    assert.equal(motion.position(-10), 0);
    assert.equal(motion.position(5000), 1500);
    assert.equal(motion.duration, 1800);
    assert.ok(Math.abs(motion.velocity(1800)) < 1e-9);
    // Velocity is continuous across a knot.
    assert.ok(Math.abs(motion.velocity(299.9) - motion.velocity(300.1)) < 0.01);
  });

  it("plans a neighbour move by its beat and longer moves as one eased path", () => {
    const next = planMove(stops, 0, 1, { viewportHeight: H });
    const beat = STORY_BEATS.product;
    assert.ok(next.duration >= beat.ms);
    assert.ok(next.duration <= 2400);
    assert.equal(next.to, 1500);
    // The copy starts moving at once.
    assert.ok(next.position(60) > 0);
    // Phones play the beats a little quicker.
    assert.ok(planMove(stops, 0, 1, { viewportHeight: H, compact: true }).duration < next.duration);
    const back = planMove(stops, 1500, 0, { viewportHeight: H });
    assert.ok(back.duration < next.duration);
    const handoff = planMove(stops, 6000, 4, { viewportHeight: H });
    assert.equal(handoff.duration, STORY_BEATS.handoff.ms);
    const far = planMove(stops, 0, 3, { viewportHeight: H });
    assert.ok(far.duration <= 1800);
    // Every story beat stays within the paging budget.
    for (const spec of Object.values(STORY_BEATS)) assert.ok(spec.ms <= 2000);
  });

  it("frames the class into the picture slot and eases the hand-off", () => {
    assert.equal(handoffProgress(6000, 6000, 6700), 0);
    assert.equal(handoffProgress(6700, 6000, 6700), 1);
    assert.equal(handoffProgress(6350, 6000, 6700), 0.5);
    const slot = { left: 700, top: 180, width: 640, height: 400 };
    const settled = handoffGeometry({
      layerWidth: 1440,
      layerHeight: 900,
      slot,
      focusY: 0.6,
      progress: 1,
    });
    for (const key of ["left", "top", "width", "height"]) {
      assert.ok(Math.abs(settled.rect[key] - slot[key]) < 0.01, key);
    }
    const start = handoffGeometry({
      layerWidth: 1440,
      layerHeight: 900,
      slot,
      focusY: 0.6,
      progress: 0,
    });
    assert.equal(start.scale, 1);
    assert.deepEqual(start.inset, [0, 0, 0, 0]);
  });
});

describe("Copy held in place while its screen moves", () => {
  it("fades in where it rests only once the scene has settled", () => {
    for (const id of ["product", "features", "the-weave", "studio"]) {
      const { enter } = beatFor(id);
      // Before the scene settles (the beat's enter point) the copy is not shown at all.
      assert.equal(copyReveal(enter, enter, 0.3).opacity, 0, id);
      assert.equal(copyReveal(enter * 0.95, enter, 0.3).opacity, 0, id);
      const resting = copyReveal(0, enter, 0.3);
      assert.deepEqual(resting, { opacity: 1, drift: 0 });
      // A calm fade: a few px of drift at most, never a slide.
      for (let offset = enter; offset > 0; offset -= enter / 20) {
        assert.ok(Math.abs(copyReveal(offset, enter, 0.3).drift) <= 10);
      }
    }
  });

  it("is gone before the next scene starts to move", () => {
    for (const id of ["product", "features", "the-weave", "studio"]) {
      const { exit } = beatFor(id);
      assert.equal(copyReveal(-exit, 0.6, exit).opacity, 0, id);
    }
  });

  it("plays the brown and the sky as passages, never as stops", () => {
    // The dive passes through the hill's brown on its way into the dojo...
    assert.ok(beatFor("product").via.some(({ scene }) => scene === 0.1));
    // ...and the flight through the door crosses the sky before the clouds lie down.
    assert.ok(beatFor("the-weave").via.some(({ scene }) => scene === 0.66));
    // ...and the clouds dip straight to the risen room on the way to the class.
    assert.equal(beatFor("studio").cut.scene, 0.958);
    assert.ok(!landingPageContent.story.some(({ scene }) => scene > 0.7 && scene < 1));
    assert.ok(!landingPageContent.story.some(({ scene }) => scene === 0.1 || scene === 0.66));
  });
});

describe("The framed class on tall screens", () => {
  it("keeps every head inside the frame with wall above it", () => {
    for (const [width, height, slotHeight] of [
      [390, 664, 272],
      [390, 844, 388],
      [320, 568, 158],
      [430, 932, 429],
    ]) {
      const slot = { left: 32, top: 400, width: width - 64, height: slotHeight };
      const classTop = height * 0.48;
      const focus = classFocus({ layerWidth: width, layerHeight: height, slot, classTop });
      const cropHeight = Math.min(height, width / (slot.width / slot.height));
      const cropTop = focus * height - cropHeight / 2;
      assert.ok(
        cropTop >= -0.5 && cropTop + cropHeight <= height + 0.5,
        `${width}x${height} in the scene`,
      );
      assert.ok(cropTop < classTop - cropHeight * 0.1, `${width}x${height} heads clear of the top`);
    }
  });
});

describe("Copy beside the moving picture", () => {
  const box = { left: 86, top: 190, width: 370, height: 190 };
  const settled = 150;
  const frame = 16;

  it("shows wall copy while the picture still holds it, and page copy only once clear", () => {
    const full = { left: 0, top: 0, width: 1440, height: 900 };
    assert.equal(copyClearance(box, full, frame, settled), 1);
    assert.equal(copyClearance(box, full, frame, settled, false), 0);
  });

  it("hides copy while an edge or the frame passes through it", () => {
    for (const left of [80, 200, 300, 456, 470]) {
      const picture = { left, top: 60, width: 1300, height: 800 };
      assert.equal(copyClearance(box, picture, frame, settled), 0, `edge at ${left}`);
    }
  });

  it("is whole again once the picture and its frame are clear, and always when settled", () => {
    const clear = { left: 520, top: 180, width: 860, height: 540 };
    assert.equal(copyClearance(box, clear, frame, settled), 1);
    // A settled layout closer than the usual return distance is still fully visible.
    const near = { left: 86 + 370 + 16 + 10, top: 180, width: 800, height: 500 };
    assert.equal(copyClearance(box, near, frame, 10), 1);
  });
});

describe("Scene helpers and old links", () => {
  it("gives the masthead the tone of the art beneath it", () => {
    assert.equal(mastheadTone(0, 1000), "light");
    assert.equal(mastheadTone(0.1, 1000), "dark");
    assert.equal(mastheadTone(0.45, 1000), "light");
    assert.equal(mastheadTone(0.52, 2000), "dark");
    assert.equal(mastheadTone(1, 1600), "light");
  });

  it("keeps the masthead clear over the hills until the curtain reaches it", () => {
    assert.equal(mastheadOverHills(0.04, 1000), true);
    assert.equal(mastheadOverHills(0.08, 1000), false);
    // Tall frames see more sky, so the curtain reaches the top later.
    assert.equal(mastheadOverHills(0.085, 2000), true);
    assert.equal(mastheadOverHills(0.09, 2000), false);
    for (const height of [1000, 1500, 2000]) {
      for (let progress = 0; progress <= 0.2; progress += 0.005) {
        // Never a light ground in between: clear, then dark.
        if (!mastheadOverHills(progress, height) && progress < 0.3) {
          assert.equal(mastheadTone(progress, height), "dark");
        }
      }
    }
  });

  it("shows only chapter still frames for reduced motion", () => {
    const scenes = landingPageContent.story.map(({ scene }) => scene);
    assert.equal(stillFrame(0.04, scenes), 0);
    // The weave is a passage now; still frames rest on the clouds that carry its words.
    assert.equal(stillFrame(0.8, scenes), 0.685);
    assert.deepEqual(
      scenes,
      [...scenes].sort((a, b) => a - b),
    );
  });

  it("leaves current ids alone and sends retired hashes somewhere that exists", () => {
    const targets = new Set([
      ...landingPageContent.story.map(({ id }) => id),
      "pricing",
      "try",
      "faq",
      "begin",
      ...landingPageContent.faq.groups.map(({ id }) => id),
    ]);
    for (const id of targets) assert.equal(resolveLegacyHash(`#${id}`), null);
    assert.equal(resolveLegacyHash(""), null);
    assert.equal(resolveLegacyHash("#not-a-section"), null);
    for (const [from, to] of Object.entries(LANDING_HASH_ALIASES)) {
      assert.ok(targets.has(to), `${from} points at missing ${to}`);
      assert.equal(resolveLegacyHash(`#${from}`), to);
    }
    assert.equal(resolveLegacyHash("#studio-view"), "product");
    // The curtain's and the sky's old links land on the chapters that carry their words now.
    assert.equal(resolveLegacyHash("#the-problem"), "product");
    assert.equal(resolveLegacyHash("#the-path"), "the-weave");
    assert.equal(resolveLegacyHash("#faq-roadmap"), "faq-limits");
  });
});

describe("The weave", () => {
  it("lays seven strands across the floor, on screen", () => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [320, 640],
      [1920, 900],
    ]) {
      const layout = loomLayout(width, height);
      assert.equal(layout.warps.length, LOOM_ROWS);
      assert.ok(layout.wefts.length >= 8, `${width}x${height} wefts`);
      layout.warps.forEach((warp, row) => {
        assert.ok(warp.y >= layout.visible.top, `${width}x${height} strand ${row} on screen`);
        assert.ok(warp.y < layout.visible.bottom, `${width}x${height} strand ${row} visible`);
      });
      assert.ok(layout.floorFraction > layout.matTopFraction - 0.1);
    }
  });

  it("weaves a plain over-and-under, with no blank floats", () => {
    const layout = loomLayout(1440, 900);
    layout.over.forEach((crossings, row) => {
      crossings.forEach((over, column) => assert.equal(over, (row + column) % 2 === 0));
    });
  });

  it("hides the scene's morph under a full wash and hands back to the room", () => {
    const layout = loomLayout(1440, 900);
    assert.equal(loomFrame(0.7, layout).visible, false);
    const woven = loomFrame(0.892, layout);
    assert.equal(woven.wash, 1);
    assert.equal(woven.ground, 1);
    assert.equal(woven.lie, 0);
    assert.ok(woven.wefts.every((value) => value === 1));
    assert.ok(
      woven.warps.every(({ settle, cloud, slide }) => settle === 1 && cloud === 0 && slide === 0),
    );
    // Fully covered while the scene shuffles its planks.
    for (const p of [0.802, 0.85, 0.89]) assert.equal(loomFrame(p, layout).wash, 1);
    assert.ok(loomFrame(0.92, layout).lie > 0);
    assert.equal(loomFrame(LOOM_PHASES.floor[1], layout).visible, false);
    assert.match(warpPath(layout, layout.warps[0], 1), /^M/);
  });

  it("is cut paper: hand-cut edges, flat strips, no rounded ends", () => {
    const layout = loomLayout(1440, 900);
    for (const warp of layout.warps) {
      assert.ok(
        warp.cutTop.some((cut) => cut !== 0),
        "the edges wobble",
      );
      assert.ok(warp.cutTop.every((cut) => Math.abs(cut) <= warp.thickness * 0.05));
    }
    // A settled strip is a polygon of straight cuts; a weft ends in a straight, slanted cut.
    assert.doesNotMatch(warpPath(layout, layout.warps[0], 1), /NaN/);
    const weft = weftPath(layout, layout.wefts[0]);
    assert.match(weft, /^M[^A-KN-Z]*Z$/);
    // Strips arrive solid: pulled in from the side, never faded in.
    const arriving = loomFrame(LOOM_PHASES.warp[0] + 0.004, layout);
    assert.ok(arriving.warps.some(({ slide }) => Math.abs(slide) > 0));
  });

  it("hands over to the room with wipes, never a dissolve", () => {
    const layout = loomLayout(1440, 900);
    let wall = Number.POSITIVE_INFINITY;
    let floor = Number.NEGATIVE_INFINITY;
    for (let p = LOOM_PHASES.lie[0]; p < LOOM_PHASES.floor[1]; p += 0.002) {
      const frame = loomFrame(p, layout);
      // The mat itself never fades: it is covered by the floor, edge first.
      assert.equal(frame.wash, 1);
      assert.ok(frame.wallEdge <= wall && frame.floorEdge >= floor);
      wall = frame.wallEdge;
      floor = frame.floorEdge;
    }
    assert.ok(wall < 0, "the wall is up to the top of the screen");
    assert.ok(
      loomFrame(LOOM_PHASES.floor[1], layout).floorEdge > 1,
      "the floor reaches the camera",
    );
    assert.equal(loomFrame(LOOM_PHASES.floor[0], layout).floorEdge, layout.floorFraction);
  });
});
