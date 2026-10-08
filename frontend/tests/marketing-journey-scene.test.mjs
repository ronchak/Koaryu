import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as model from "../src/components/marketing/journey/scene-model.ts";

const require = createRequire(import.meta.url);
const sceneSource = readFileSync(
  new URL("../src/components/marketing/journey/journey-scene.tsx", import.meta.url),
  "utf8",
);
const sceneCss = readFileSync(
  new URL("../src/components/marketing/journey/journey-scene.module.css", import.meta.url),
  "utf8",
);
const compiledScene = ts.transpileModule(sceneSource, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const sceneModule = { exports: {} };
new Function("require", "module", "exports", compiledScene)(
  (name) =>
    name === "./scene-model"
      ? model
      : name === "./journey-scene.module.css"
        ? { scene: "scene" }
        : require(name),
  sceneModule,
  sceneModule.exports,
);
const { JourneyScene, STUDENT_SEATS, applySceneState, sceneState } = sceneModule.exports;
const landscape = model.frameForDimensions(1600, 1000);
const renderScene = (initialProgress) =>
  renderToStaticMarkup(React.createElement(JourneyScene, { initialProgress }));
const shown = (state, key) => Boolean(state[key]) && state[key].display !== "none";

describe("Journey scene geometry", () => {
  it("keeps renderer inputs, phase boundaries, and easing curves", () => {
    assert.equal(model.clamp(-1), 0);
    assert.equal(model.clamp(2), 1);
    assert.equal(model.clamp(Number.NaN), 0);
    assert.equal(model.easeIn(0.5), 0.125);
    assert.equal(model.easeOut(0.5), 0.875);
    assert.equal(model.easeInOut(0.5), 0.5);
    assert.deepEqual(model.SCENE_PHASES, {
      mountains: [0, 0.1],
      drop: [0.1, 0.212],
      settle: [0.212, 0.288],
      portal: [0.288, 0.52],
      door: [0.404, 0.52],
      through: [0.516, 0.64],
      sky: [0.6, 0.7],
      clouds: [0.66, 0.802],
      morph: [0.802, 0.892],
      floor: [0.892, 0.9],
      students: [0.958, 1],
    });
  });

  it("keeps landscape and portrait frames, with the class drawn in on phones", () => {
    assert.deepEqual(landscape, {
      viewBox: "0 0 1600 1000",
      visibleHalfWidth: 800,
      studentSpread: 1,
      variant: "landscape",
    });
    const portrait = model.frameForDimensions(390, 844);
    assert.equal(portrait.viewBox, "0 -500 1600 2000");
    assert.equal(portrait.variant, "portrait");
    assert.ok(portrait.studentSpread >= 0.5 && portrait.studentSpread < 1);
  });
});

describe("Journey scene story", () => {
  it("tells the whole story: hills, dojo, doorway, sky, clouds, woven floor, room, class", () => {
    const at = (progress) => sceneState(progress, landscape);
    assert.ok(shown(at(0), "mountains"));
    assert.ok(!shown(at(0), "dojo"));
    assert.ok(shown(at(0.1), "curtain-closed"), "the dark interlude covers the frame");
    assert.ok(!shown(at(0.1), "mountains"));

    const product = at(0.288);
    assert.ok(shown(product, "dojo"));
    assert.equal(product["door-right"].transform, "translate(0 0)");
    assert.ok(!shown(product, "sky"));

    const features = at(0.52);
    assert.equal(features["door-right"].transform, "translate(185 0)");
    assert.ok(shown(features, "sky"), "the sky shows through the open door");

    const pricing = at(0.66);
    assert.ok(!shown(pricing, "dojo"), "the camera has flown through the door");
    assert.ok(shown(pricing, "sky"));
    assert.equal(pricing["sky-sun"].opacity, "1");

    const clouds = at(0.78);
    assert.ok(shown(clouds, "clouds"));

    const faq = at(0.892);
    assert.ok(shown(faq, "weave"), "the clouds have woven into a mat");
    assert.ok(!shown(faq, "plank-shadow-0"), "the woven mat is settled, not mid-morph");
    assert.ok(!shown(faq, "room"));

    const closing = at(1);
    assert.ok(shown(closing, "room"));
    assert.ok(STUDENT_SEATS.every((_, index) => shown(closing, `student-${index}`)));
    assert.ok(STUDENT_SEATS.every((_, index) => closing[`student-${index}`].opacity === "1"));
  });

  it("seats students in order and never produces invalid attributes", () => {
    let visible = 0;
    for (let step = 0; step <= 200; step += 1) {
      const state = sceneState(step / 200, model.frameForDimensions(390, 844));
      const serialized = JSON.stringify(state);
      assert.doesNotMatch(serialized, /NaN|Infinity|undefined/);
      const count = STUDENT_SEATS.filter((_, index) => shown(state, `student-${index}`)).length;
      assert.ok(count >= visible, "students never leave as the story advances");
      visible = count;
    }
    assert.equal(visible, STUDENT_SEATS.length);
  });

  it("dresses the class in a range of belts and natural hair and skin tones", () => {
    const belts = new Set(STUDENT_SEATS.map((seat) => seat.belt));
    assert.ok(belts.size >= 5);
    assert.doesNotMatch(sceneSource, /#B08E2A/i, "the olive-yellow head tone is retired");
  });
});

describe("Journey scene rendering", () => {
  it("renders once with server attributes and writes only changed attributes per frame", () => {
    const html = renderScene(0);
    assert.match(html, /data-scene-dynamic="dojo"[^>]*display="none"/);
    assert.match(html, /data-scene-dynamic="mountain-sun"[^>]*transform="translate\(1128 248\)/);

    const writes = [];
    const element = {
      attributes: new Map([["opacity", "1"]]),
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      setAttribute(name, value) {
        writes.push([name, value]);
        this.attributes.set(name, value);
      },
    };
    const root = { querySelector: () => element };
    const cache = new Map();
    applySceneState(root, { a: { opacity: "1", transform: "scale(2)" } }, cache);
    applySceneState(root, { a: { opacity: "1", transform: "scale(2)" } }, cache);
    assert.deepEqual(writes, [["transform", "scale(2)"]]);
  });

  it("uses baked materials instead of live noise filters", () => {
    assert.doesNotMatch(
      sceneSource,
      /<fe(?:Turbulence|DisplacementMap|DiffuseLighting|DropShadow)/,
    );
    assert.match(sceneSource, /\/marketing\/crumple\.webp/);
    assert.match(sceneSource, /\/marketing\/washi-shade\.webp/);
  });

  // A composited layer or blend inside the art splits the camera-scaled dojo
  // into dozens of layers held at the dive's zoom; the tab then runs out of
  // tile memory after a trip through the door and back.
  it("paints the art into the scene layer without layers or multiply blends of its own", () => {
    const sceneRule = sceneCss.match(/\.scene\s*\{([^}]*)\}/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(sceneRule, /will-change|transform/);
    assert.doesNotMatch(sceneSource, /mixBlendMode:\s*"multiply"/);
  });

  it("is decorative, pointer-inert, and uses valid local references", () => {
    const html = renderScene(0.7);
    assert.match(html, /^<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.match(
      sceneCss,
      /\.scene\s*\{[\s\S]*position:\s*absolute;[\s\S]*pointer-events:\s*none;/,
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const references = [...html.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const reference of references) assert.ok(ids.includes(reference), reference);
  });

  it("keeps IDs unique between instances and clamps progress", () => {
    const pair = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        React.createElement(JourneyScene, { initialProgress: 0.7 }),
        React.createElement(JourneyScene, { initialProgress: 0.7 }),
      ),
    );
    const ids = [...pair.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    assert.match(renderScene(-1), /data-scene-progress="0"/);
    assert.match(renderScene(2), /data-scene-progress="1"/);
    for (const layer of [
      "mountains",
      "curtain",
      "dojo",
      "sky",
      "clouds",
      "weave-floor",
      "room",
      "students",
    ]) {
      assert.match(renderScene(1), new RegExp(`data-scene-layer="${layer}"`));
    }
  });
});
