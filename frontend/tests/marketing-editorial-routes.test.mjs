import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import ts from "typescript";
import * as pages from "../src/lib/marketing-pages.ts";
import * as routeModel from "../src/lib/marketing-detail-route-model.ts";

const require = createRequire(import.meta.url);
function loadRoute(path) {
  const source = readFileSync(new URL(`../src/app/${path}/page.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (specifier) => {
      if (specifier === "@/lib/marketing-pages") return pages;
      if (specifier === "@/lib/marketing-detail-route-model") return routeModel;
      return require(specifier);
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function permanentRedirectTo(destination) {
  return (error) => error.digest === `NEXT_REDIRECT;replace;${destination};308;`;
}

describe("consolidated marketing routes", () => {
  it("permanently sends the two retired directories to the relevant product answer", () => {
    assert.throws(() => loadRoute("explore").default(), permanentRedirectTo("/features"));
    assert.throws(() => loadRoute("about").default(), permanentRedirectTo("/features#fit"));
  });

  it("sends the known family guide to its replacement and uses its canonical metadata", async () => {
    const route = loadRoute("studio-types/[slug]");
    const props = { params: Promise.resolve({ slug: "family-martial-arts-schools" }) };
    assert.deepEqual(route.generateStaticParams(), [{ slug: "family-martial-arts-schools" }]);
    await assert.rejects(
      route.default(props),
      permanentRedirectTo("/features/student-management#families"),
    );
    const metadata = await route.generateMetadata(props);
    assert.equal(metadata.alternates.canonical, "https://koaryu.app/features/student-management");
    assert.equal(metadata.description, pages.getFeaturePage("student-management").description);
  });

  it("keeps unknown studio slugs as 404s rather than redirecting every URL", async () => {
    const route = loadRoute("studio-types/[slug]");
    for (const slug of ["unknown", "family-martial-arts-school", "__proto__"]) {
      const props = { params: Promise.resolve({ slug }) };
      await assert.rejects(
        route.default(props),
        (error) => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404",
      );
      assert.deepEqual(await route.generateMetadata(props), {});
    }
  });
});
