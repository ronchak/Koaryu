import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as model from "../src/components/marketing/journey/scene-model.ts";
import {
  DAY_FROM_HOUR,
  NIGHT_FROM_HOUR,
  SCENE_ATTRIBUTE,
  SCENE_QUERY_PARAM,
  SCENE_TIME_SCRIPT,
  SCENE_TIME_ZONE,
  isNightHour,
  pacificHour,
  resolveScene,
  sceneFor,
  sceneOverride,
} from "../src/components/marketing/journey/scene-time.ts";

const require = createRequire(import.meta.url);
const at = (iso) => new Date(iso);

/** Runs the inline pre-paint script at a given instant and query string. */
function runScript(instant, search = "", globals = {}) {
  const attributes = {};
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [instant.getTime()]));
    }
  }
  const context = vm.createContext({
    Date: FixedDate,
    Intl,
    URLSearchParams,
    Number,
    location: { search },
    document: {
      documentElement: {
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
      },
    },
    ...globals,
  });
  vm.runInContext(SCENE_TIME_SCRIPT, context);
  return attributes["data-scene"];
}

describe("Scene time: night from 19:00 to 05:59 Pacific", () => {
  it("switches at 19:00 and 06:00 on a summer (PDT, UTC-7) day", () => {
    assert.equal(sceneFor(at("2026-07-16T01:59:59Z")), "day"); // 18:59:59 PDT
    assert.equal(sceneFor(at("2026-07-16T02:00:00Z")), "night"); // 19:00 PDT
    assert.equal(sceneFor(at("2026-07-16T07:00:00Z")), "night"); // midnight PDT
    assert.equal(sceneFor(at("2026-07-16T12:59:59Z")), "night"); // 05:59:59 PDT
    assert.equal(sceneFor(at("2026-07-16T13:00:00Z")), "day"); // 06:00 PDT
  });

  it("switches at 19:00 and 06:00 on a winter (PST, UTC-8) day", () => {
    assert.equal(sceneFor(at("2026-01-16T02:59:59Z")), "day"); // 18:59:59 PST
    assert.equal(sceneFor(at("2026-01-16T03:00:00Z")), "night"); // 19:00 PST
    assert.equal(sceneFor(at("2026-01-16T13:59:59Z")), "night"); // 05:59:59 PST
    assert.equal(sceneFor(at("2026-01-16T14:00:00Z")), "day"); // 06:00 PST
  });

  it("follows daylight saving as it starts (8 March 2026, 02:00 PST becomes 03:00 PDT)", () => {
    assert.equal(pacificHour(at("2026-03-08T09:59:00Z")), 1); // 01:59 PST
    assert.equal(pacificHour(at("2026-03-08T10:00:00Z")), 3); // 03:00 PDT
    // A fixed UTC-8 offset would still call 06:00 PDT five in the morning.
    assert.equal(sceneFor(at("2026-03-08T12:59:00Z")), "night"); // 05:59 PDT
    assert.equal(sceneFor(at("2026-03-08T13:00:00Z")), "day"); // 06:00 PDT
    assert.equal(sceneFor(at("2026-03-09T01:59:00Z")), "day"); // 18:59 PDT
    assert.equal(sceneFor(at("2026-03-09T02:00:00Z")), "night"); // 19:00 PDT
  });

  it("follows daylight saving as it ends (1 November 2026, 02:00 PDT becomes 01:00 PST)", () => {
    assert.equal(pacificHour(at("2026-11-01T08:30:00Z")), 1); // 01:30 PDT
    assert.equal(pacificHour(at("2026-11-01T09:30:00Z")), 1); // 01:30 PST, the hour repeats
    // A fixed UTC-7 offset would already call 05:00 PST six in the morning.
    assert.equal(sceneFor(at("2026-11-01T13:59:00Z")), "night"); // 05:59 PST
    assert.equal(sceneFor(at("2026-11-01T14:00:00Z")), "day"); // 06:00 PST
    assert.equal(sceneFor(at("2026-11-02T02:59:00Z")), "day"); // 18:59 PST
    assert.equal(sceneFor(at("2026-11-02T03:00:00Z")), "night"); // 19:00 PST
  });

  it("names night hours by the clock and reads every hour as 0-23", () => {
    const night = Array.from({ length: 24 }, (_, hour) => hour).filter(isNightHour);
    assert.deepEqual(night, [0, 1, 2, 3, 4, 5, 19, 20, 21, 22, 23]);
    assert.equal(NIGHT_FROM_HOUR, 19);
    assert.equal(DAY_FROM_HOUR, 6);
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const value = pacificHour(new Date(Date.UTC(2026, 9, 1, hour, 30)));
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 23);
    }
  });

  it("keeps the day world when the clock is unknown", () => {
    assert.equal(sceneFor(new Date(Number.NaN)), "day");
  });

  it("lets ?scene=night and ?scene=day force either world for review", () => {
    assert.equal(sceneOverride("?scene=night"), "night");
    assert.equal(sceneOverride("?utm_source=x&scene=day"), "day");
    assert.equal(sceneOverride("?scene=dusk"), null);
    assert.equal(sceneOverride("?scene=NIGHT"), null);
    assert.equal(sceneOverride(""), null);
    const noon = at("2026-07-16T19:00:00Z");
    const midnight = at("2026-07-16T07:00:00Z");
    assert.equal(resolveScene(noon, "?scene=night"), "night");
    assert.equal(resolveScene(midnight, "?scene=day"), "day");
    assert.equal(resolveScene(midnight, ""), "night");
  });
});

describe("Scene time: the pre-paint script", () => {
  it("agrees with sceneFor every half hour across both daylight saving changes", () => {
    const days = [
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ];
    for (const day of days) {
      for (let step = 0; step < 48; step += 1) {
        const instant = new Date(Date.parse(`${day}T00:00:00Z`) + step * 30 * 60 * 1000);
        assert.equal(runScript(instant), sceneFor(instant), instant.toISOString());
      }
    }
  });

  it("honours the review override and never throws", () => {
    const noon = at("2026-07-16T19:00:00Z");
    assert.equal(runScript(noon, "?scene=night"), "night");
    assert.equal(runScript(at("2026-07-16T07:00:00Z"), "?scene=day"), "day");
    // No Intl (very old engines): the day world, no exception.
    assert.equal(runScript(at("2026-07-16T07:00:00Z"), "", { Intl: undefined }), "day");
    assert.equal(
      runScript(noon, "?scene=night", {
        URLSearchParams: function Broken() {
          throw new Error("unsupported");
        },
      }),
      "day",
    );
  });

  it("is tiny, dependency-free ES5", () => {
    assert.ok(SCENE_TIME_SCRIPT.length < 700);
    assert.doesNotMatch(SCENE_TIME_SCRIPT, /=>|\blet\b|\bconst\b|`|\bimport\b|\brequire\b/);
    assert.match(SCENE_TIME_SCRIPT, /^\(function\(\)\{.*\}\)\(\);$/);
  });

  it("is written out with the same rules as the typed functions", () => {
    for (const fragment of [
      `.get(${JSON.stringify(SCENE_QUERY_PARAM)})`,
      `timeZone:${JSON.stringify(SCENE_TIME_ZONE)}`,
      `if(h>=${NIGHT_FROM_HOUR}||h<${DAY_FROM_HOUR})s="night"`,
      `d.setAttribute(${JSON.stringify(SCENE_ATTRIBUTE)},s)`,
    ]) {
      assert.ok(SCENE_TIME_SCRIPT.includes(fragment), fragment);
    }
  });
});

// The night scene: rendered from journey-scene.tsx the same way the art script does.
const sceneSource = readFileSync(
  new URL("../src/components/marketing/journey/journey-scene.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(sceneSource, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const classes = {
  scene: "scene",
  nightFill: "nightFill",
  nightStroke: "nightStroke",
  nightStop: "nightStop",
  nightOpacity: "nightOpacity",
  nightOnly: "nightOnly",
  dayOnly: "dayOnly",
};
const sceneModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) =>
    name === "./scene-model"
      ? model
      : name === "./journey-scene.module.css"
        ? classes
        : require(name),
  sceneModule,
  sceneModule.exports,
);
const { JourneyScene, sceneState } = sceneModule.exports;
const sceneCss = readFileSync(
  new URL("../src/components/marketing/journey/journey-scene.module.css", import.meta.url),
  "utf8",
);
const landscape = model.frameForDimensions(1600, 1000);
const portrait = model.frameForDimensions(390, 844);
const tags = (markup) =>
  [...markup.matchAll(/<([a-zA-Z]+)((?:\s[^>]*?)?)\/?>/g)].map(([, name, rest]) => ({
    name,
    attributes: Object.fromEntries(
      [...rest.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
    ),
  }));
const hasClass = (tag, name) => (tag.attributes.class ?? "").split(" ").includes(name);

describe("Night scene", () => {
  const markup = renderToStaticMarkup(
    React.createElement(JourneyScene, { initialProgress: 0, frame: landscape }),
  );
  const elements = tags(markup);

  it("keeps every day colour as the attribute and stores the night colour beside it", () => {
    const relit = {
      nightFill: ["fill", "--night-fill"],
      nightStroke: ["stroke", "--night-stroke"],
      nightStop: ["stop-color", "--night-stop"],
      nightOpacity: ["opacity", "--night-opacity"],
    };
    for (const [className, [attribute, property]] of Object.entries(relit)) {
      const relitElements = elements.filter((tag) => hasClass(tag, className));
      assert.ok(relitElements.length > 0, `${className} is used`);
      for (const tag of relitElements) {
        assert.ok(
          tag.attributes[attribute] !== undefined,
          `${tag.name} keeps its day ${attribute}`,
        );
        assert.match(tag.attributes.style ?? "", new RegExp(`${property}:`));
      }
    }
  });

  it("puts the moon where the sun is, stars and lamps in the night world only", () => {
    const dayOnly = elements.filter((tag) => hasClass(tag, "dayOnly")).length;
    const nightOnly = elements.filter((tag) => hasClass(tag, "nightOnly")).length;
    assert.ok(dayOnly >= 3 && nightOnly >= 8);
    assert.match(sceneCss, /\.nightOnly\s*\{\s*display:\s*none;/);
    assert.match(
      sceneCss,
      /:global\(html\[data-scene="night"\]\) \.dayOnly\s*\{\s*display:\s*none;/,
    );
    for (const layer of ["lamps"]) assert.ok(markup.includes(`data-scene-layer="${layer}"`));
  });

  it("never lets the night styles fight an attribute that scroll frames write", () => {
    const owners = new Map(
      elements
        .filter((tag) => tag.attributes["data-scene-dynamic"])
        .map((tag) => [tag.attributes["data-scene-dynamic"], tag]),
    );
    for (let step = 0; step <= 100; step += 1) {
      for (const lighting of ["day", "night"]) {
        for (const frame of [landscape, portrait]) {
          const state = sceneState(step / 100, frame, lighting);
          for (const [key, attributes] of Object.entries(state)) {
            const tag = owners.get(key);
            if (!tag) continue;
            if (hasClass(tag, "nightOnly") || hasClass(tag, "dayOnly")) {
              assert.equal(attributes.display, undefined, `${key} display`);
            }
            if (hasClass(tag, "nightFill")) assert.equal(attributes.fill, undefined, key);
            if (hasClass(tag, "nightOpacity")) assert.equal(attributes.opacity, undefined, key);
          }
        }
      }
    }
  });

  it("relights only the weave's blended colours per frame, by the night palette", () => {
    for (const progress of [0, 0.1, 0.3, 0.52, 0.7, 0.82, 0.85, 0.892, 0.93, 1]) {
      const day = sceneState(progress, landscape);
      const night = sceneState(progress, landscape, "night");
      assert.deepEqual(Object.keys(night), Object.keys(day));
      for (const key of Object.keys(day)) {
        const { fill: dayFill, ...dayRest } = day[key];
        const { fill: nightFill, ...nightRest } = night[key];
        assert.deepEqual(nightRest, dayRest, `${key} at ${progress}`);
        if (dayFill !== undefined && progress >= 0.82) {
          assert.ok(key === "weave-ground" || key.startsWith("plank-"), key);
          assert.notEqual(nightFill, dayFill, `${key} is relit at ${progress}`);
        }
      }
    }
  });

  it("seats the andon lamps either side of the class, inside every frame", () => {
    for (const frame of [landscape, portrait]) {
      const state = sceneState(1, frame, "night");
      const x = (key) => Number(/translate\(([-\d.]+)/.exec(state[key].transform)[1]);
      const left = 800 - frame.visibleHalfWidth;
      const right = 800 + frame.visibleHalfWidth;
      assert.ok(x("room-lamp-left") > left + 60 && x("room-lamp-left") < 800);
      assert.ok(x("room-lamp-right") < right - 60 && x("room-lamp-right") > 800);
      assert.equal(state["room-lamps"].display, "inline");
    }
    assert.equal(sceneState(0.5, landscape, "night")["room-lamps"].display, "none");
  });
});
