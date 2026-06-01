import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const rootReadmePath = new URL("../../README.md", import.meta.url);
const frontendReadmePath = new URL("../README.md", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);
const packageLockPath = new URL("../package-lock.json", import.meta.url);

describe("frontend Node runtime baseline", () => {
  it("documents the Node baseline required by frontend tests", async () => {
    const [rootReadme, frontendReadme] = await Promise.all([
      readFile(rootReadmePath, "utf8"),
      readFile(frontendReadmePath, "utf8"),
    ]);

    assert.match(rootReadme, /Node\.js 22\.13\+ for frontend scripts and tests/);
    assert.match(frontendReadme, /Use Node\.js 22\.13\+ for frontend scripts and tests/);
    assert.equal(rootReadme.includes("Node.js 18+"), false);
  });

  it("keeps package metadata aligned with the type-stripping test command", async () => {
    const [packageJson, packageLock] = await Promise.all([
      readFile(packageJsonPath, "utf8").then(JSON.parse),
      readFile(packageLockPath, "utf8").then(JSON.parse),
    ]);

    assert.equal(packageJson.engines.node, ">=22.13.0");
    assert.equal(packageLock.packages[""].engines.node, ">=22.13.0");
    assert.equal(packageJson.scripts.test, "node --experimental-strip-types --test tests/*.test.mjs");
  });
});
