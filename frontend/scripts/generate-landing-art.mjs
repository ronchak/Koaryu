// Render still frames of the evening journey scene (and the dojo seen from outside)
// for the landing page, with a paper grain and a night vignette baked in. The SVG
// scene stays the source of truth; rerun after changing its artwork.
// Run from frontend: node --experimental-strip-types scripts/generate-landing-art.mjs
// ONLY=doorway,class renders a subset; PREVIEW=/some/dir also writes PNG previews.
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
async function loadComponent(file, exportName) {
  const source = await readFile(new URL(file, journey), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) =>
      name.startsWith("./scene-model")
        ? model
        : name.startsWith("./hills")
          ? hills
          : name === "./journey-scene.module.css"
            ? { scene: "scene" }
            : require(name),
    module,
    module.exports,
  );
  return module.exports[exportName];
}
const JourneyScene = await loadComponent("journey-scene.tsx", "JourneyScene");
const DojoExterior = await loadComponent("dojo-exterior.tsx", "DojoExterior");
const DoorShadows = await loadComponent("dojo-exterior.tsx", "DoorShadows");

const publicDir = new URL("../public/", import.meta.url);
const outputDir = new URL("marketing/scenes/", publicDir);
await mkdir(outputDir, { recursive: true });

// name, what to draw, and the viewports it is composed for.
const scene = (progress) => (width, height) =>
  React.createElement(JourneyScene, {
    initialProgress: progress,
    frame: model.frameForDimensions(width, height),
  });
const exterior = (width, height) =>
  React.createElement(DojoExterior, { variant: width > height ? "wide" : "tall" });
const WIDE = ["wide", 1600, 1000];
const TALL = ["tall", 390, 844];
const shadows = () => React.createElement(DoorShadows);
const frames = [
  ["door-shadows", shadows, [["wide", 1600, 1000]], { transparent: true }],
  ["dojo-night", exterior, [WIDE, TALL]],
  ["doorway", scene(0.52), [WIDE, TALL]],
  ["sky", scene(0.69), [WIDE]],
  ["mat", scene(0.892), [WIDE]],
  ["class", scene(1), [WIDE, TALL]],
];
const SCALE = { wide: 2, tall: 2.5 };
// The shadows are soft; a lighter raster is plenty.
const SCALE_FOR = { "door-shadows": 1 };
const only = process.env.ONLY?.split(",");
const preview = process.env.PREVIEW;
if (preview) await mkdir(preview, { recursive: true });

const browser = await chromium.launch();
const htmlPath = join(tmpdir(), "koaryu-landing-art.html");
for (const [name, draw, shapes, options = {}] of frames) {
  if (only && !only.includes(name)) continue;
  for (const [shape, width, height] of shapes) {
    const svg = renderToStaticMarkup(draw(width, height)).replaceAll(
      'href="/marketing/',
      `href="${new URL("marketing/", publicDir).href}`,
    );
    const grain = new URL("marketing/scene-grain.webp", publicDir).href;
    await writeFile(
      htmlPath,
      `<!doctype html><style>
        html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${options.transparent ? "transparent" : "#15131c"}}
        .scene{position:absolute;inset:0;width:100%;height:100%}${options.transparent ? ".grain{display:none}" : ""}
        .grain{position:absolute;inset:0;mix-blend-mode:multiply;background-blend-mode:multiply;
          background:radial-gradient(ellipse 78% 74% at 50% 50%,#fff 52%,rgb(150 138 140) 100%),url("${grain}") 0 0/360px 360px}
      </style>${svg}<div class="grain"></div>`,
    );
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: SCALE_FOR[name] ?? SCALE[shape],
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForTimeout(200);
    const shot = await page.screenshot({ type: "png", omitBackground: !!options.transparent });
    await context.close();
    const target = new URL(`${name}-${shape}.webp`, outputDir);
    const output = await sharp(shot).webp({ quality: 82, effort: 6 }).toBuffer();
    await writeFile(target, output);
    if (preview) {
      await sharp(shot)
        .resize(shape === "wide" ? 1200 : 480)
        .png()
        .toFile(join(preview, `${name}-${shape}.png`));
    }
    console.log(`${name}-${shape}.webp: ${output.length} bytes`);
  }
}
await browser.close();
