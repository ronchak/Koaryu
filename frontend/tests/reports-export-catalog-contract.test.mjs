import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const panelSource = readFileSync(
  new URL("../src/components/reports/reports-data-exports-panel.tsx", import.meta.url),
  "utf8"
);

describe("report export catalog", () => {
  it("keeps exactly 29 effective rows in six visible ruled groups", () => {
    const reportIds = [...panelSource.matchAll(/\{ id: "([a-z0-9_]+)", title:/g)].map((match) => match[1]);
    assert.equal(reportIds.length, 29);
    assert.equal(new Set(reportIds).size, 29);
    assert.equal((panelSource.match(/title: "(?:Owner Intelligence|Student Records|Growth|Programs and Ranks|Schedule|Administration)"/g) || []).length, 6);
    assert.match(panelSource, /function ExportGroupRegister/);
    assert.doesNotMatch(panelSource, /aria-hidden=\{!isOpen\}|useId\(|setIsOpen/);
  });

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

  it("checks per-row authorization before preview, token, or download work", () => {
    const handler = panelSource.slice(panelSource.indexOf("async function handleDownloadReport"));
    assert.ok(handler.indexOf("canRunReportExport") < handler.indexOf("isPreviewMode"));
    assert.ok(handler.indexOf("canRunReportExport") < handler.indexOf("api.download"));
    assert.match(panelSource, /Minimum role:/);
  });
});
