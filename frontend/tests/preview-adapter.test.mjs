import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function loader(preview) {
  const { add, modules } = createCommonJsPacker({
    "./preview-adapter": `globalThis.adapterLoads++;exports.previewAdapter={marker:'sample'};`,
  });
  const entry = add("@/lib/preview-adapter-loader");
  const context = { process: { env: { NEXT_PUBLIC_PREVIEW_MODE: preview } }, adapterLoads: 0 };
  context.loader = runInNewContext(
    `(()=>{const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}return require(${entry});})()`,
    context,
  );
  return context;
}

test("live mode cannot load or expose a preview adapter", () => {
  for (const flag of ["false", undefined]) {
    const state = loader(flag);
    assert.throws(() => state.loader.loadPreviewAdapter(), /unavailable in live mode/);
    assert.throws(() => state.loader.getPreviewAdapter(), /must load before/);
    assert.equal(state.adapterLoads, 0);
  }
});

test("preview initialization shares one adapter load and exposes it only after settlement", async () => {
  const state = loader("true");
  const first = state.loader.loadPreviewAdapter();
  assert.equal(state.loader.loadPreviewAdapter(), first);
  assert.throws(() => state.loader.getPreviewAdapter(), /must load before/);
  const adapter = await first;
  assert.equal(state.loader.getPreviewAdapter(), adapter);
  assert.equal(await state.loader.loadPreviewAdapter(), adapter);
  assert.equal(state.adapterLoads, 1);
});

test("live entry points have no static runtime path to fixture modules", () => {
  const visited = new Set();
  const forbidden = /\/(?:mock-data|preview-studio-data|billing-preview-data|preview-adapter)\.ts$/;
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    assert.doesNotMatch(path, forbidden);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (node.isTypeOnly || node.importClause?.isTypeOnly || !node.moduleSpecifier) continue;
      if (
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        !node.importClause.name &&
        node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)
      )
        continue;
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
      const base = specifier.startsWith("@/")
        ? resolve("src", specifier.slice(2))
        : resolve(path, "..", specifier);
      if (/\.(?:css|json)$/.test(base)) continue;
      const candidate = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
      ].find(existsSync);
      assert.ok(candidate, `Cannot inspect static dependency ${specifier} in ${path}`);
      visit(candidate);
    }
  }
  for (const name of [
    "store.tsx",
    "store-program-actions.ts",
    "store-belt-actions.ts",
    "store-studio-actions.ts",
    "billing-page-controller.ts",
    "dashboard/preview-home-payload.ts",
  ]) {
    visit(resolve("src/lib", name));
  }
});
