import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const atomicBeltLadderSpecPath = new URL("../e2e/atomic-belt-ladder.spec.ts", import.meta.url);
const coreUiPolishSpecPath = new URL("../e2e/core-ui-polish.spec.ts", import.meta.url);
const previewSmokeSpecPath = new URL("../e2e/preview-smoke.spec.ts", import.meta.url);
const scheduleAttendanceSpecPath = new URL("../e2e/schedule-attendance-counters.spec.ts", import.meta.url);
const studentImportSpecPath = new URL("../e2e/student-import-idempotency-key.spec.ts", import.meta.url);
const requiredSmokeConfigPath = new URL("../playwright.required-smoke.config.ts", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);
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

  it("restricts the preview-stateful Core UI check to loopback", async () => {
    const spec = await readFile(coreUiPolishSpecPath, "utf8");

    assert.match(spec, /KOARYU_CORE_UI_E2E/);
    assert.match(spec, /\["localhost", "127\.0\.0\.1"\]/);
    assert.match(spec, /may run only against loopback/);
  });

  it("documents disposable-account usage for the stateful e2e check", async () => {
    const readme = await readFile(frontendReadmePath, "utf8");

    assert.match(readme, /E2E Checks/);
    assert.match(readme, /disposable account and studio name/);
    assert.match(readme, /avoids logging account identifiers/);
  });

  it("keeps the required browser smoke limited to preview-only specs and data", async () => {
    const [
      atomicBeltLadderSpec,
      previewSmokeSpec,
      scheduleAttendanceSpec,
      studentImportSpec,
      requiredSmokeConfig,
      packageJsonSource,
    ] = await Promise.all([
      readFile(atomicBeltLadderSpecPath, "utf8"),
      readFile(previewSmokeSpecPath, "utf8"),
      readFile(scheduleAttendanceSpecPath, "utf8"),
      readFile(studentImportSpecPath, "utf8"),
      readFile(requiredSmokeConfigPath, "utf8"),
      readFile(packageJsonPath, "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonSource);
    const requiredSmokeScript = packageJson.scripts["test:e2e:required-smoke"];

    assert.match(requiredSmokeScript, /KOARYU_E2E_FRONTEND_URL=http:\/\/127\.0\.0\.1:4000/);
    assert.match(requiredSmokeScript, /KOARYU_PREVIEW_SMOKE_E2E=true/);
    assert.match(requiredSmokeScript, /KOARYU_PREVIEW_E2E=true/);
    assert.match(requiredSmokeScript, /playwright\.required-smoke\.config\.ts/);
    assert.doesNotMatch(requiredSmokeScript, /KOARYU_LIVE_STATEFUL_E2E/);
    assert.doesNotMatch(requiredSmokeScript, /LOGIN_EMAIL|LOGIN_PASSWORD|STUDIO_NAME/);

    assert.match(requiredSmokeConfig, /preview-smoke\.spec\.ts/);
    assert.match(requiredSmokeConfig, /schedule-attendance-counters\.spec\.ts/);
    assert.doesNotMatch(requiredSmokeConfig, /atomic-belt-ladder|student-import-idempotency-key/);
    assert.match(requiredSmokeConfig, /@required-browser-smoke/);
    assert.match(requiredSmokeConfig, /workers: 1/);
    assert.match(requiredSmokeConfig, /retries: 0/);
    assert.match(requiredSmokeConfig, /globalTimeout: 120_000/);
    assert.match(requiredSmokeConfig, /trace: "retain-on-failure"/);
    assert.match(requiredSmokeConfig, /screenshot: "only-on-failure"/);
    assert.match(requiredSmokeConfig, /video: "off"/);
    assert.match(requiredSmokeConfig, /reuseExistingServer: false/);
    assert.match(requiredSmokeConfig, /npm run start/);

    assert.match(previewSmokeSpec, /@required-browser-smoke/);
    assert.match(scheduleAttendanceSpec, /@required-browser-smoke/);
    assert.equal(
      (previewSmokeSpec.match(/@required-browser-smoke/g) ?? []).length
        + (scheduleAttendanceSpec.match(/@required-browser-smoke/g) ?? []).length,
      2,
    );
    assert.doesNotMatch(atomicBeltLadderSpec, /@required-browser-smoke/);
    assert.doesNotMatch(studentImportSpec, /@required-browser-smoke/);
  });
});
