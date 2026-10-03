// Render still frames of the journey scene for the landing page, with the same
// grain and vignette the live scene used. The SVG scene stays the source of truth;
// rerun after changing its artwork.
// Run from frontend: node --experimental-strip-types scripts/generate-landing-art.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import ts from "typescript";

const require = createRequire(import.meta.url);
const journey = new URL("../src/components/marketing/journey/", import.meta.url);
const model = await import(new URL("scene-model.ts", journey).href);
const hills = await import(new URL("hills.ts", journey).href);
const source = await readFile(new URL("journey-scene.tsx", journey), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const scene = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) =>
    name === "./scene-model"
      ? model
      : name === "./hills"
        ? hills
        : name === "./journey-scene.module.css"
          ? { scene: "scene" }
          : require(name),
  scene,
  scene.exports,
);
const { JourneyScene } = scene.exports;

const publicDir = new URL("../public/", import.meta.url);
const outputDir = new URL("marketing/scenes/", publicDir);
await mkdir(outputDir, { recursive: true });

// name, scene progress, and the viewports it is composed for.
const frames = [
  [
    "doorway",
    0.52,
    [
      ["wide", 1600, 1000],
      ["tall", 390, 844],
    ],
  ],
  ["sky", 0.66, [["wide", 1600, 1000]]],
  ["mat", 0.892, [["wide", 1600, 1000]]],
  [
    "class",
    1,
    [
      ["wide", 1600, 1000],
      ["tall", 390, 844],
    ],
  ],
];
const SCALE = { wide: 2, tall: 2.5 };

const browser = await chromium.launch();
const htmlPath = join(tmpdir(), "koaryu-landing-art.html");
for (const [name, progress, shapes] of frames) {
  for (const [shape, width, height] of shapes) {
    const frame = model.frameForDimensions(width, height);
    const svg = renderToStaticMarkup(
      React.createElement(JourneyScene, { initialProgress: progress, frame }),
    ).replaceAll('href="/marketing/', `href="${new URL("marketing/", publicDir).href}`);
    const grain = new URL("marketing/scene-grain.webp", publicDir).href;
    await writeFile(
      htmlPath,
      `<!doctype html><style>
        html,body{margin:0;width:100%;height:100%;overflow:hidden}
        .scene{position:absolute;inset:0;width:100%;height:100%}
        .grain{position:absolute;inset:0;mix-blend-mode:multiply;background-blend-mode:multiply;
          background:radial-gradient(ellipse 72% 72% at 50% 48%,#fff 55%,rgb(214 204 188) 100%),url("${grain}") 0 0/360px 360px}
      </style>${svg}<div class="grain"></div>`,
    );
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: SCALE[shape],
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForTimeout(200);
    const shot = await page.screenshot({ type: "png" });
    await context.close();
    const target = new URL(`${name}-${shape}.webp`, outputDir);
    const output = await sharp(shot).webp({ quality: 80, effort: 6 }).toBuffer();
    await writeFile(target, output);
    console.log(`${name}-${shape}.webp: ${output.length} bytes`);
  }
}
await browser.close();
