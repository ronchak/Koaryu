// Render still frames of the journey scene, by day or by night, with the same
// grain and vignette the live scene layer adds. The SVG scene stays the source
// of truth; rerun after changing its artwork. Also the quickest way to review
// the art at any moment of the story without running the app.
//
// Run from frontend:
//   node --experimental-strip-types scripts/generate-landing-art.mjs
//   node --experimental-strip-types scripts/generate-landing-art.mjs --scene night
//   node --experimental-strip-types scripts/generate-landing-art.mjs --scene both \
//     --progress 0,0.1,0.288,0.52 --sizes wide:1440x900,tall:390x844 --out /tmp/art --format png
//
// Options
//   --scene day|night|both   lighting to render (default both; night files get a "-night" suffix)
//   --progress a,b,c         render these scene progress values (as <scene>-<size>-NN frames)
//   --sizes name:WxH,...     frames to compose for (default wide:1600x1000,tall:390x844)
//   --scale 2                device pixel ratio (default 2 for wide, 2.5 for tall)
//   --out dir                output directory (default public/marketing/scenes)
//   --format webp|png        output format (default webp)
// Without --progress it renders the composed frames the landing page uses as stills.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import ts from "typescript";

const require = createRequire(import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (!token.startsWith("--")) return pairs;
    const next = all[index + 1];
    pairs.push([token.slice(2), next && !next.startsWith("--") ? next : "true"]);
    return pairs;
  }, []),
);

const journey = new URL("../src/components/marketing/journey/", import.meta.url);
const model = await import(new URL("scene-model.ts", journey).href);
const source = await readFile(new URL("journey-scene.tsx", journey), "utf8");
const moduleCss = await readFile(new URL("journey-scene.module.css", journey), "utf8");
// CSS Modules class names map to themselves here, so the stylesheet applies as written.
const classNames = new Proxy(
  {},
  {
    get: (_, name) =>
      name === "__esModule" || typeof name !== "string"
        ? undefined
        : name === "default"
          ? classNames
          : name,
  },
);
const sceneCss = moduleCss.replace(/:global\(([^()]*)\)/g, "$1");
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
      : name === "./journey-scene.module.css"
        ? classNames
        : require(name),
  scene,
  scene.exports,
);
const { JourneyScene } = scene.exports;

const publicDir = new URL("../public/", import.meta.url);
const outputDir = args.out ? resolve(args.out) : new URL("marketing/scenes/", publicDir).pathname;
await mkdir(outputDir, { recursive: true });

const scenes = args.scene === "day" || args.scene === "night" ? [args.scene] : ["day", "night"];
const format = args.format === "png" ? "png" : "webp";
const sizes = (args.sizes ?? "wide:1600x1000,tall:390x844").split(",").map((entry) => {
  const [name, dimensions] = entry.split(":");
  const [width, height] = dimensions.split("x").map(Number);
  return { name, width, height, scale: Number(args.scale ?? (width > height ? 2 : 2.5)) };
});
// Composed frames: the doorway, the open sky, the woven mat and the seated class.
const frames = args.progress
  ? args.progress.split(",").map((value) => [null, Number(value)])
  : [
      ["doorway", 0.52],
      ["sky", 0.66],
      ["mat", 0.892],
      ["class", 1],
    ];

// Textures are inlined so the frame renders from a blank page without file access.
const inline = async (path) =>
  `data:image/webp;base64,${(await readFile(new URL(path, publicDir))).toString("base64")}`;
const textures = Object.fromEntries(
  await Promise.all(
    ["crumple", "washi-shade", "scene-grain"].map(async (name) => [
      `/marketing/${name}.webp`,
      await inline(`marketing/${name}.webp`),
    ]),
  ),
);
const grain = textures["/marketing/scene-grain.webp"];
const page = (markup, lighting) => `<!doctype html>
<html data-scene="${lighting}"><head><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
  ${sceneCss}
  .stage{position:absolute;inset:0;overflow:hidden}
  .grain{position:absolute;inset:0;mix-blend-mode:multiply;background-blend-mode:multiply;
    background:radial-gradient(ellipse 72% 72% at 50% 48%,#fff 55%,rgb(214 204 188) 100%),url("${grain}") 0 0/360px 360px}
</style></head><body><div class="stage">${markup}<div class="grain"></div></div></body></html>`;

const browser = await chromium.launch();
for (const size of sizes) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
  });
  const tab = await context.newPage();
  const frame = model.frameForDimensions(size.width, size.height);
  for (const lighting of scenes) {
    for (const [index, [name, progress]] of frames.entries()) {
      const markup = renderToStaticMarkup(
        React.createElement(JourneyScene, { initialProgress: progress, frame, lighting }),
      ).replace(/href="(\/marketing\/[a-z-]+\.webp)"/g, (match, path) =>
        textures[path] ? `href="${textures[path]}"` : match,
      );
      await tab.setContent(page(markup, lighting), { waitUntil: "load" });
      await tab.evaluate(() => Promise.all([...document.images].map((image) => image.decode?.())));
      const shot = await tab.screenshot({ type: "png" });
      // Composed stills are named for the landing page; review frames sort by lighting and size.
      const file = join(
        outputDir,
        name
          ? `${name}${lighting === "night" ? "-night" : ""}-${size.name}.${format}`
          : `${lighting}-${size.name}-${String(index).padStart(2, "0")}.${format}`,
      );
      const output =
        format === "png" ? shot : await sharp(shot).webp({ quality: 80, effort: 6 }).toBuffer();
      await writeFile(file, output);
      console.log(`${file}: ${output.length} bytes`);
    }
  }
  await context.close();
}
await browser.close();
