import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const panelSource = readFileSync(
  new URL("../src/components/reports/reports-data-exports-panel.tsx", import.meta.url),
  "utf8"
);

describe("Friendly Pilot report export catalog", () => {
  it("does not ship the deferred raw billing CSV catalog in Reports", () => {
    assert.doesNotMatch(panelSource, /title:\s*["']Billing["']/);
    assert.doesNotMatch(
      panelSource,
      /id:\s*["'](?:billing_|student_billing_enrollments)/
    );

    assert.match(panelSource, /id:\s*["']students["']/);
    assert.match(panelSource, /id:\s*["']class_sessions["']/);
    assert.match(panelSource, /id:\s*["']audit_logs["']/);
  });
});
