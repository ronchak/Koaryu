import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertCleanGitWorktree,
  loadBudgetManifest,
  validatePerformanceEvidence,
} from "./check-performance-regression.mjs";

const manifest = loadBudgetManifest();
const SHA = "a".repeat(40);

function validEvidence() {
  return {
    schema_version: manifest.schema_version,
    budget_manifest_version: manifest.budget_manifest_version,
    git_sha: SHA,
    fixture_revision: manifest.fixture_revision,
    privacy: manifest.privacy,
    long_task_threshold_ms: manifest.long_task_threshold_ms,
    profiles: Object.entries(manifest.profiles).map(([profile, definition]) => ({
      profile,
      route: "dashboard-summary",
      cardinalities: { ...definition.cardinalities },
      metrics: {
        request_count: 1,
        table_query_count: 0,
        rpc_count: 0,
        total_provider_call_count: 0,
        returned_row_count: 0,
        provider_response_bytes: 0,
        serialized_response_payload_bytes: 1,
        total_duration_ms: 1,
        max_stage_duration_ms: 1,
        long_task_count: 0,
        peak_rss_bytes: 1,
        data_ready: true,
      },
    })),
  };
}

function mutateProfileEvidence(mutator) {
  const evidence = validEvidence();
  const profile = evidence.profiles.find((entry) => entry.profile === "small");
  mutator(profile, evidence);
  return evidence;
}

describe("deterministic performance evidence validator", () => {
  it("rejects tracked or untracked worktree changes before exact-SHA evidence", () => {
    assert.doesNotThrow(() => assertCleanGitWorktree(""));
    assert.throws(
      () => assertCleanGitWorktree(" M backend/app/main.py\n"),
      /requires a clean Git worktree/,
    );
    assert.throws(
      () => assertCleanGitWorktree("?? untracked-fixture.py\n"),
      /requires a clean Git worktree/,
    );
  });

  it("accepts a complete aggregate-only evidence set", () => {
    assert.equal(validatePerformanceEvidence(validEvidence(), manifest, SHA).privacy, manifest.privacy);
  });

  it("rejects a 19-second dashboard-ready result", () => {
    assert.throws(
      () => validatePerformanceEvidence(mutateProfileEvidence((profile) => {
        profile.metrics.total_duration_ms = 19000;
      }), manifest, SHA),
      /total_duration_ms exceeds/,
    );
  });

  for (const [metric, message] of [
    ["serialized_response_payload_bytes", "payload bytes"],
    ["total_provider_call_count", "provider calls"],
    ["returned_row_count", "rows"],
    ["peak_rss_bytes", "RSS"],
    ["long_task_count", "long tasks"],
  ]) {
    it(`rejects ${message} over budget`, () => {
      assert.throws(
        () => validatePerformanceEvidence(mutateProfileEvidence((profile) => {
          profile.metrics[metric] = manifest.profiles.small.budgets[metric] + 1;
          if (metric === "total_provider_call_count") {
            profile.metrics.table_query_count = manifest.profiles.small.budgets.table_query_count;
          }
        }), manifest, SHA),
        new RegExp(`${metric} exceeds`),
      );
    });
  }

  it("rejects a missing profile and a missing metric", () => {
    const missingProfile = validEvidence();
    missingProfile.profiles.pop();
    assert.throws(
      () => validatePerformanceEvidence(missingProfile, manifest, SHA),
      /every manifest profile and route exactly once/,
    );

    const missingMetric = validEvidence();
    delete missingMetric.profiles[0].metrics.long_task_count;
    assert.throws(
      () => validatePerformanceEvidence(missingMetric, manifest, SHA),
      /unknown or missing fields/,
    );
  });

  it("rejects unknown privacy-bearing fields", () => {
    const evidence = validEvidence();
    evidence.student_names = ["must-not-be-emitted"];
    assert.throws(
      () => validatePerformanceEvidence(evidence, manifest, SHA),
      /unknown or missing fields/,
    );
  });

  it("rejects non-finite metrics", () => {
    assert.throws(
      () => validatePerformanceEvidence(mutateProfileEvidence((profile) => {
        profile.metrics.total_duration_ms = Number.NaN;
      }), manifest, SHA),
      /finite and nonnegative/,
    );
  });

  it("rejects false data readiness", () => {
    assert.throws(
      () => validatePerformanceEvidence(mutateProfileEvidence((profile) => {
        profile.metrics.data_ready = false;
      }), manifest, SHA),
      /data_ready must be true/,
    );
  });

  it("rejects a mismatched exact SHA and wrong cardinalities", () => {
    assert.throws(
      () => validatePerformanceEvidence(validEvidence(), manifest, "b".repeat(40)),
      /exact expected Git SHA/,
    );
    assert.throws(
      () => validatePerformanceEvidence(mutateProfileEvidence((profile) => {
        profile.cardinalities.students += 1;
      }), manifest, SHA),
      /cardinalities do not match/,
    );
  });
});
