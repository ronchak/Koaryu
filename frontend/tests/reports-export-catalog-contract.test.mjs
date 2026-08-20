import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const panelSource = readFileSync(
  new URL("../src/components/reports/reports-data-exports-panel.tsx", import.meta.url),
  "utf8"
);
const metricsSource = readFileSync(
  new URL("../src/lib/report-metrics.ts", import.meta.url),
  "utf8"
);
const backendManifest = JSON.parse(
  readFileSync(
    new URL("../../backend/tests/fixtures/report_exports/catalog_manifest.json", import.meta.url),
    "utf8"
  )
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

  it("matches the backend live role contract and excludes every deferred billing ID", () => {
    const frontendIds = [...panelSource.matchAll(/\{ id: "([a-z0-9_]+)", title:/g)].map(
      (match) => match[1]
    );
    const backendLive = backendManifest.filter(
      (report) => report.availability === "available"
    );
    const backendLiveIds = backendLive.map((report) => report.id);
    const frontendMinimumRoles = Object.fromEntries(
      frontendIds.map((id) => [
        id,
        panelSource.split("\n").some((line) =>
          line.includes('{ id: "' + id + '"') &&
          line.includes('minimumRole: "front_desk"')
        )
          ? "front_desk"
          : "admin",
      ])
    );
    const backendMinimumRoles = Object.fromEntries(
      backendLive.map((report) => [report.id, report.min_role])
    );
    const frontDeskBlock = metricsSource.slice(
      metricsSource.indexOf("FRONT_DESK_REPORT_EXPORT_IDS"),
      metricsSource.indexOf("] as const", metricsSource.indexOf("FRONT_DESK_REPORT_EXPORT_IDS"))
    );
    const frontDeskIds = [...frontDeskBlock.matchAll(/"([a-z0-9_]+)",/g)].map(
      (match) => match[1]
    );

    assert.deepEqual([...new Set(frontendIds)].sort(), [...backendLiveIds].sort());
    assert.deepEqual(frontendMinimumRoles, backendMinimumRoles);
    assert.deepEqual([...frontDeskIds].sort(), [
      "attendance",
      "belt_ladders",
      "belt_ranks",
      "class_sessions",
      "class_templates",
      "programs",
    ]);
    assert.deepEqual(
      [...backendLive.filter((report) => report.min_role === "front_desk")].map(
        (report) => report.id
      ).sort(),
      frontDeskIds.sort()
    );
    assert.equal(
      backendManifest.filter((report) => report.availability === "deferred_billing")
        .some((report) => frontendIds.includes(report.id)),
      false
    );
  });

  it("checks per-row authorization before preview, token, or download work", () => {
    const handler = panelSource.slice(panelSource.indexOf("async function handleDownloadReport"));
    assert.ok(handler.indexOf("canRunReportExport") < handler.indexOf("isPreviewMode"));
    assert.ok(handler.indexOf("canRunReportExport") < handler.indexOf("api.download"));
    assert.match(panelSource, /Minimum role:/);
  });
});
