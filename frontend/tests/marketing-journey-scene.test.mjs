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
const { JourneyScene } = sceneModule.exports;
const renderScene = (progress) =>
  renderToStaticMarkup(React.createElement(JourneyScene, { progress }));

describe("Journey scene geometry", () => {
  it("keeps renderer inputs, phase boundaries, and easing curves", () => {
    assert.equal(model.clamp(-1), 0);
    assert.equal(model.clamp(2), 1);
    assert.equal(model.clamp(Number.NaN), 0);
    assert.equal(model.easeIn(0.5), 0.125);
    assert.equal(model.easeOut(0.5), 0.875);
    assert.equal(model.easeInOut(0.25), 0.125);
    assert.equal(model.easeInOut(0.5), 0.5);
    assert.equal(model.easeInOut(0.75), 0.875);
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
      floor: [0.892, 0.952],
      students: [0.952, 1],
    });
  });

  it("generates stable bounded clouds and weave geometry", () => {
    assert.deepEqual(model.createCloudGeometry(), model.createCloudGeometry());
    assert.notDeepEqual(model.createCloudGeometry(), model.createCloudGeometry(1208));
    assert.equal(model.CLOUD_GEOMETRY.length, 42);
    assert.equal(model.PLANK_GEOMETRY.length, 256);
    assert.equal(Object.isFrozen(model.CLOUD_GEOMETRY), true);
    assert.equal(Object.isFrozen(model.PLANK_GEOMETRY), true);
    assert.equal(model.makeCloudPath(31), model.makeCloudPath(31));
    assert.notEqual(model.makeCloudPath(31), model.makeCloudPath(32));
    for (const cloud of model.CLOUD_GEOMETRY) assert.match(cloud.path, /^M.*Z$/);
    for (const plank of model.PLANK_GEOMETRY) {
      assert.equal(plank.uv.length, 8);
      assert.equal(plank.flat.length, 8);
      assert.equal(plank.cloud.length, 8);
      for (const point of [...plank.uv, ...plank.flat, ...plank.cloud]) {
        assert.equal(Number.isFinite(point.x), true);
        assert.equal(Number.isFinite(point.y), true);
      }
    }
  });

  it("keeps landscape and portrait frame geometry", () => {
    assert.equal(model.SCENE_WIDTH, 1600);
    assert.equal(model.SCENE_HEIGHT, 1000);
    assert.deepEqual(model.SCENE_OVERSCAN, { x: -520, y: -740, width: 2640, height: 2480 });
    assert.deepEqual(model.frameForDimensions(1600, 1000), {
      viewBox: "0 0 1600 1000",
      visibleHalfWidth: 800,
      studentSpread: 1,
      variant: "landscape",
    });
    const portrait = model.frameForDimensions(390, 844);
    assert.equal(portrait.viewBox, "0 -500 1600 2000");
    assert.equal(portrait.variant, "portrait");
    assert.ok(portrait.studentSpread >= 0.34 && portrait.studentSpread < 1);
  });
});

describe("Journey scene rendered SVG", () => {
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

  it("keeps IDs unique between instances and deterministic geometry", () => {
    const pair = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        React.createElement(JourneyScene, { progress: 0.7 }),
        React.createElement(JourneyScene, { progress: 0.7 }),
      ),
    );
    const ids = [...pair.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    const paths = (html) => [...html.matchAll(/<path[^>]* d="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(paths(renderScene(0.7)), paths(renderScene(0.7)));
  });

  it("renders connected layers at representative progress states", () => {
    const rendered = [0.025, 0.18, 0.48, 0.7, 0.85, 0.93, 1].map(renderScene).join("\n");
    assert.doesNotMatch(rendered, /NaN|Infinity/);
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
      assert.match(rendered, new RegExp(`data-scene-layer="${layer}"`));
    }
    assert.match(renderScene(-1), /data-scene-progress="0"/);
    assert.match(renderScene(2), /data-scene-progress="1"/);
  });
});
