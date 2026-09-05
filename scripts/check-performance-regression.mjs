#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = resolve(ROOT_DIR, "performance/dashboard-summary-budget.json");
const LOCAL_PYTHON_PATH = resolve(ROOT_DIR, "backend/venv/bin/python");
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TOP_LEVEL_FIELDS = [
  "schema_version",
  "budget_manifest_version",
  "git_sha",
  "fixture_revision",
  "privacy",
  "backend_stage_threshold_ms",
  "profiles",
];
const PROFILE_FIELDS = ["profile", "route", "cardinalities", "metrics"];
const METRIC_FIELDS = [
  "request_count",
  "auth_call_count",
  "cache_hit_rpc_count",
  "concurrent_miss_rpc_count",
  "invalidation_rpc_count",
  "denied_rpc_count",
  "table_query_count",
  "rpc_count",
  "total_provider_call_count",
  "returned_row_count",
  "provider_response_bytes",
  "serialized_response_payload_bytes",
  "total_duration_ms",
  "max_stage_duration_ms",
  "slow_backend_stage_count",
  "peak_rss_bytes",
  "data_ready",
];
const COUNT_FIELDS = new Set([
  "request_count",
  "auth_call_count",
  "cache_hit_rpc_count",
  "concurrent_miss_rpc_count",
  "invalidation_rpc_count",
  "denied_rpc_count",
  "table_query_count",
  "rpc_count",
  "total_provider_call_count",
  "returned_row_count",
  "provider_response_bytes",
  "serialized_response_payload_bytes",
  "slow_backend_stage_count",
  "peak_rss_bytes",
]);
const DURATION_FIELDS = new Set(["total_duration_ms", "max_stage_duration_ms"]);
const CARDINALITY_FIELDS = [
  "students",
  "student_program_memberships",
  "billing_payments",
  "stripe_events",
  "staff_roles",
  "staff_profiles",
  "studio_subscriptions",
  "studios",
  "leads",
  "class_sessions",
  "class_templates",
  "attendance",
  "programs",
  "belt_ladders",
  "belt_ranks",
  "billing_payers",
  "billing_invoices",
  "billing_plans",
  "studio_payment_accounts",
];
const SEMANTIC_FIELDS = [
  "returned_row_count",
  "provider_response_bytes",
  "total_duration_ms",
  "max_stage_duration_ms",
  "slow_backend_stage_count",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite nonnegative integer.`);
  }
}

function loadBudgetManifest(path = MANIFEST_PATH) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`unable to read performance budget manifest: ${error.message}`);
  }
  exactKeys(manifest, [
    "schema_version",
    "budget_manifest_version",
    "fixture_revision",
    "privacy",
    "fixed_request",
    "backend_stage_threshold_ms",
    "metric_semantics",
    "routes",
    "profiles",
  ], "budget manifest");
  if (manifest.schema_version !== 1 || manifest.budget_manifest_version !== "dashboard-summary-performance-v2") {
    throw new Error("performance budget manifest version is unsupported.");
  }
  if (manifest.fixture_revision !== "dashboard-summary-endpoint-fixture-v2" || manifest.privacy !== "aggregate-only-no-payloads") {
    throw new Error("performance budget manifest binding is unsupported.");
  }
  exactKeys(manifest.fixed_request, ["route", "date", "timezone", "role"], "fixed request");
  if (
    manifest.fixed_request.route !== "dashboard-summary"
    || manifest.fixed_request.date !== "2026-05-20"
    || manifest.fixed_request.timezone !== "America/Los_Angeles"
    || manifest.fixed_request.role !== "admin"
  ) throw new Error("performance budget manifest fixed request is unsupported.");
  nonnegativeInteger(manifest.backend_stage_threshold_ms, "backend_stage_threshold_ms");
  exactKeys(manifest.metric_semantics, SEMANTIC_FIELDS, "metric semantics");
  if (manifest.routes.length !== 1 || manifest.routes[0] !== "dashboard-summary") {
    throw new Error("performance budget manifest must contain the dashboard-summary route once.");
  }
  if (!isPlainObject(manifest.profiles)) throw new Error("performance budget profiles must be an object.");
  const profileNames = Object.keys(manifest.profiles).sort();
  if (profileNames.join(",") !== "large,medium,small") {
    throw new Error("performance budget manifest must contain exactly small, medium, and large profiles.");
  }
  for (const profileName of profileNames) {
    const profile = manifest.profiles[profileName];
    exactKeys(profile, ["cardinalities", "budgets"], `manifest profile ${profileName}`);
    exactKeys(profile.cardinalities, CARDINALITY_FIELDS, `manifest cardinalities ${profileName}`);
    exactKeys(profile.budgets, METRIC_FIELDS.filter((field) => field !== "data_ready"), `manifest budgets ${profileName}`);
    for (const [name, value] of Object.entries(profile.cardinalities)) nonnegativeInteger(value, `${profileName}.${name}`);
    for (const [name, value] of Object.entries(profile.budgets)) {
      if (DURATION_FIELDS.has(name)) {
        if (!finiteNonnegative(value)) throw new Error(`${profileName}.${name} must be finite and nonnegative.`);
      } else nonnegativeInteger(value, `${profileName}.${name}`);
    }
  }
  return manifest;
}

function validatePerformanceEvidence(evidence, manifest, expectedSha) {
  exactKeys(evidence, TOP_LEVEL_FIELDS, "performance evidence");
  if (
    evidence.schema_version !== manifest.schema_version
    || evidence.budget_manifest_version !== manifest.budget_manifest_version
    || evidence.fixture_revision !== manifest.fixture_revision
    || evidence.privacy !== manifest.privacy
    || evidence.backend_stage_threshold_ms !== manifest.backend_stage_threshold_ms
  ) throw new Error("performance evidence has incorrect version, fixture, privacy, or threshold bindings.");
  if (!SHA_PATTERN.test(expectedSha) || evidence.git_sha !== expectedSha) {
    throw new Error("performance evidence is not bound to the exact expected Git SHA.");
  }
  if (!Array.isArray(evidence.profiles)) throw new Error("performance evidence profiles must be an array.");
  const profileNames = Object.keys(manifest.profiles);
  if (evidence.profiles.length !== profileNames.length * manifest.routes.length) {
    throw new Error("performance evidence must contain every manifest profile and route exactly once.");
  }
  const seenProfiles = new Set();
  const seenPairs = new Set();
  for (const entry of evidence.profiles) {
    exactKeys(entry, PROFILE_FIELDS, "performance profile evidence");
    if (!profileNames.includes(entry.profile)) {
      throw new Error("performance evidence has an unknown profile.");
    }
    if (!manifest.routes.includes(entry.route)) {
      throw new Error("performance evidence has an unknown route.");
    }
    const pair = `${entry.profile}:${entry.route}`;
    if (seenPairs.has(pair)) throw new Error("performance evidence has a duplicate profile and route.");
    const profileBudget = manifest.profiles[entry.profile];
    exactKeys(entry.cardinalities, Object.keys(profileBudget.cardinalities), `${entry.profile} cardinalities`);
    for (const [name, expected] of Object.entries(profileBudget.cardinalities)) {
      nonnegativeInteger(entry.cardinalities[name], `${entry.profile}.cardinalities.${name}`);
      if (entry.cardinalities[name] !== expected) throw new Error(`${entry.profile} cardinalities do not match the manifest.`);
    }
    exactKeys(entry.metrics, METRIC_FIELDS, `${entry.profile} metrics`);
    for (const field of COUNT_FIELDS) nonnegativeInteger(entry.metrics[field], `${entry.profile}.${field}`);
    for (const field of DURATION_FIELDS) {
      if (!finiteNonnegative(entry.metrics[field])) throw new Error(`${entry.profile}.${field} must be finite and nonnegative.`);
    }
    if (entry.metrics.data_ready !== true) throw new Error(`${entry.profile} data_ready must be true after serialization.`);
    if (entry.metrics.total_provider_call_count > profileBudget.budgets.total_provider_call_count) {
      throw new Error(`${entry.profile}.total_provider_call_count exceeds its performance budget.`);
    }
    if (entry.metrics.total_provider_call_count !== entry.metrics.auth_call_count + entry.metrics.table_query_count + entry.metrics.rpc_count) {
      throw new Error(`${entry.profile} provider call count does not equal Auth calls plus table queries plus RPCs.`);
    }
    for (const [metric, ceiling] of Object.entries(profileBudget.budgets)) {
      if (entry.metrics[metric] > ceiling) throw new Error(`${entry.profile}.${metric} exceeds its performance budget.`);
    }
    if (entry.metrics.request_count !== 7 || entry.metrics.auth_call_count !== 7
      || entry.metrics.rpc_count !== 3 || entry.metrics.cache_hit_rpc_count !== 0
      || entry.metrics.concurrent_miss_rpc_count !== 1 || entry.metrics.invalidation_rpc_count !== 1
      || entry.metrics.denied_rpc_count !== 0) {
      throw new Error(`${entry.profile} endpoint authorization or cache invariants failed.`);
    }
    seenProfiles.add(entry.profile);
    seenPairs.add(pair);
  }
  const expectedPairs = new Set(
    profileNames.flatMap((profile) => manifest.routes.map((route) => `${profile}:${route}`)),
  );
  if (seenPairs.size !== expectedPairs.size || [...expectedPairs].some((pair) => !seenPairs.has(pair))) {
    throw new Error("performance evidence must contain every manifest profile and route exactly once.");
  }
  if (seenProfiles.size !== profileNames.length) throw new Error("performance evidence must contain every manifest profile exactly once.");
  return evidence;
}

function currentGitSha() {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: ROOT_DIR, encoding: "utf8" },
  );
  assertCleanGitWorktree(status);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT_DIR, encoding: "utf8" }).trim();
  if (!SHA_PATTERN.test(sha)) throw new Error("git rev-parse HEAD did not return a full lowercase SHA.");
  return sha;
}

function assertCleanGitWorktree(status) {
  if (typeof status !== "string") throw new Error("git status output must be text.");
  if (status.trim()) {
    throw new Error("performance evidence requires a clean Git worktree at the expected SHA.");
  }
}

function performancePythonPath() {
  // Set KOARYU_PERFORMANCE_PYTHON to an explicit interpreter when the worktree's
  // backend/venv is absent, such as a shared canonical checkout or CI toolchain.
  const override = process.env.KOARYU_PERFORMANCE_PYTHON?.trim();
  if (override) return override;
  if (process.platform === "win32") return process.env.PYTHON?.trim() || "python";
  try {
    execFileSync("test", ["-x", LOCAL_PYTHON_PATH], { cwd: ROOT_DIR });
    return LOCAL_PYTHON_PATH;
  } catch {
    return process.env.PYTHON?.trim() || "python3";
  }
}

function runFixture(profile, gitSha) {
  const pythonPath = performancePythonPath();
  const result = spawnSync(pythonPath, [
    "backend/tests/performance/dashboard_summary_fixture.py",
    "--profile", profile,
    "--git-sha", gitSha,
  ], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: resolve(ROOT_DIR, "backend") },
  });
  if (result.error) throw new Error(`fixture process could not start with ${pythonPath}: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || "fixture process failed").trim();
    throw new Error(`fixture ${profile} failed: ${diagnostic}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`fixture ${profile} did not emit one JSON evidence object: ${error.message}`);
  }
}

export function runPerformanceRegression({ expectedSha, manifest = loadBudgetManifest() } = {}) {
  const sha = currentGitSha();
  if (expectedSha !== undefined && expectedSha !== sha) {
    throw new Error(`expected SHA ${expectedSha} does not match current Git SHA ${sha}.`);
  }
  const evidence = {
    schema_version: manifest.schema_version,
    budget_manifest_version: manifest.budget_manifest_version,
    git_sha: sha,
    fixture_revision: manifest.fixture_revision,
    privacy: manifest.privacy,
    backend_stage_threshold_ms: manifest.backend_stage_threshold_ms,
    profiles: Object.keys(manifest.profiles).map((profile) => runFixture(profile, sha)),
  };
  return validatePerformanceEvidence(evidence, manifest, sha);
}

export { assertCleanGitWorktree, loadBudgetManifest, validatePerformanceEvidence };

function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--expected-sha") return { expectedSha: argv[1] };
  throw new Error("arguments must be --expected-sha <full lowercase SHA>.");
}

async function main() {
  const evidence = runPerformanceRegression(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Performance regression gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
