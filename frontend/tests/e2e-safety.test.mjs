import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const atomicBeltLadderSpecPath = new URL("../e2e/atomic-belt-ladder.spec.ts", import.meta.url);
const frontendReadmePath = new URL("../README.md", import.meta.url);

describe("stateful Playwright e2e safety", () => {
  it("keeps live-stateful Playwright checks explicitly gated", async () => {
    const spec = await readFile(atomicBeltLadderSpecPath, "utf8");

    assert.match(spec, /KOARYU_LIVE_STATEFUL_E2E/);
    assert.match(spec, /test\.skip/);
    assert.match(spec, /KOARYU_E2E_LOGIN_EMAIL/);
    assert.match(spec, /KOARYU_E2E_LOGIN_PASSWORD/);
    assert.match(spec, /KOARYU_E2E_STUDIO_NAME/);
    assert.equal(spec.includes("TEST_LOGIN_EMAIL"), false);
    assert.equal(spec.includes("TEST_LOGIN_PASSWORD"), false);
    assert.equal(spec.includes("Date.now()"), false);
    assert.equal(spec.includes("console.log"), false);
  });

  it("documents disposable-account usage for the stateful e2e check", async () => {
    const readme = await readFile(frontendReadmePath, "utf8");

    assert.match(readme, /Stateful E2E Checks/);
    assert.match(readme, /disposable account and studio name/);
    assert.match(readme, /avoids logging account identifiers/);
  });
});
