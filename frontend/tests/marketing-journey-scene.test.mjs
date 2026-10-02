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
      drop: [0.1, 0.22],
      settle: [0.22, 0.3],
      push: [0.3, 0.5],
      door: [0.34, 0.5],
      students: [0.54, 0.96],
    });
  });

  it("keeps landscape and portrait frames, with the class narrowed on phones", () => {
    assert.deepEqual(landscape, {
      viewBox: "0 0 1600 1000",
      visibleHalfWidth: 800,
      studentSpread: 1,
      variant: "landscape",
    });
    const portrait = model.frameForDimensions(390, 844);
    assert.equal(portrait.viewBox, "0 -500 1600 2000");
    assert.equal(portrait.variant, "portrait");
    assert.ok(portrait.studentSpread >= 0.6 && portrait.studentSpread < 1);
  });
});

describe("Journey scene story", () => {
  it("falls from the hills into a closed dojo, opens the door, then seats the class", () => {
    const hero = sceneState(0, landscape);
    assert.ok(shown(hero, "mountains"));
    assert.ok(!shown(hero, "dojo"));

    const problem = sceneState(0.1, landscape);
    assert.ok(shown(problem, "curtain-closed"), "the dark interlude covers the frame");
    assert.ok(!shown(problem, "mountains"));

    const product = sceneState(0.3, landscape);
    assert.ok(shown(product, "dojo"));
    assert.ok(!shown(product, "curtain-open"));
    assert.equal(product["door-right"].transform, "translate(0 0)");

    const features = sceneState(0.5, landscape);
    assert.equal(features["door-right"].transform, "translate(185 0)");
    assert.ok(STUDENT_SEATS.every((_, index) => !shown(features, `student-${index}`)));

    const closing = sceneState(1, landscape);
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
    assert.match(sceneSource, /\/marketing\/washi\.webp/);
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
    for (const layer of ["mountains", "curtain", "dojo", "doorway", "students"]) {
      assert.match(renderScene(1), new RegExp(`data-scene-layer="${layer}"`));
    }
  });
});
