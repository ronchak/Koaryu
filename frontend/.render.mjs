import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const model = await import("./src/components/marketing/journey/scene-model.ts");
const src = readFileSync("./src/components/marketing/journey/journey-scene.tsx", "utf8");
const out = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const mod = { exports: {} };
new Function("require", "module", "exports", out)((n) => n === "./scene-model" ? model : n === "./journey-scene.module.css" ? { scene: "scene" } : require(n), mod, mod.exports);
const { JourneyScene } = mod.exports;
const [w, h, prefix, ...values] = process.argv.slice(2);
const frame = model.frameForDimensions(+w, +h);
const pub = new URL("./public", import.meta.url).href;
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: +w, height: +h } })).newPage();
for (const v of values) {
  const svg = renderToStaticMarkup(React.createElement(JourneyScene, { initialProgress: +v, frame })).replaceAll('href="/marketing/', `href="${pub}/marketing/`);
  writeFileSync("/tmp/landing-new/frame.html", `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}.scene{position:absolute;inset:0;width:100%;height:100%}</style>${svg}`);
  await p.goto("file:///tmp/landing-new/frame.html"); await p.waitForTimeout(150);
  await p.screenshot({ path: `/tmp/landing-new/${prefix}-${v}.png` });
}
await b.close();
