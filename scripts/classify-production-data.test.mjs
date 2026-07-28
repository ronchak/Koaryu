import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  canonicalJson,
  classifyDocument,
  loadPolicy,
} from "./classify-production-data.mjs";
import { verifyManifest } from "./verify-production-data-classification.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "scripts/fixtures/production-data-classification.synthetic.json",
);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

function findRecord(manifest, digit) {
  const opaqueRef = `entity_${digit.repeat(64)}`;
  return manifest.records.find((record) => record.opaque_ref === opaqueRef);
}

describe("production data classification", () => {
  it("classifies the synthetic fixture with explicit reasons, confidence, and unknowns", () => {
    const manifest = classifyDocument(fixture());

    assert.equal(findRecord(manifest, "1").classification, "current_customer");
    assert.equal(findRecord(manifest, "1").confidence, "high");
    assert.deepEqual(findRecord(manifest, "1").reason_codes, [
      "application_relationship_is_context_only",
      "historical_customer_relationship_present",
      "live_customer_relationship_present",
    ]);
    assert.equal(findRecord(manifest, "2").classification, "historical_customer");
    assert.equal(findRecord(manifest, "3").classification, "controlled_synthetic");
    assert.equal(findRecord(manifest, "4").classification, "required_system");
    assert.equal(findRecord(manifest, "5").classification, "historical_setup");
    assert.equal(findRecord(manifest, "5").confidence, "medium");

    assert.equal(findRecord(manifest, "6").classification, "unknown");
    assert.equal(findRecord(manifest, "6").rule_id, "unknown-insufficient-v1");
    assert.deepEqual(findRecord(manifest, "6").reason_codes, [
      "insufficient_admissible_evidence",
      "recent_activity_is_context_only",
    ]);

    assert.equal(findRecord(manifest, "7").classification, "unknown");
    assert.equal(findRecord(manifest, "7").rule_id, "unknown-conflict-v1");
    assert.ok(
      findRecord(manifest, "7").reason_codes.includes("conflicting_conclusive_evidence"),
    );
    assert.equal(manifest.summary.classification_counts.unknown, 2);
  });

  it("produces byte-identical canonical output when records and evidence are reordered", () => {
    const original = fixture();
    const reordered = structuredClone(original);
    reordered.records.reverse();
    for (const record of reordered.records) {
      record.evidence.reverse();
    }

    assert.equal(
      canonicalJson(classifyDocument(reordered)),
      canonicalJson(classifyDocument(original)),
    );
  });

  it("binds the manifest to the classifier, policy, input, and backup snapshot", () => {
    const manifest = classifyDocument(fixture());

    for (const field of [
      "classifier_source_digest",
      "policy_digest",
      "input_digest",
      "manifest_digest",
    ]) {
      assert.match(manifest[field], /^sha256:[0-9a-f]{64}$/);
    }
    assert.match(manifest.snapshot.backup_set_ref, /^backup_[0-9a-f]{64}$/);
    assert.match(manifest.snapshot.backup_data_ciphertext_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(manifest.snapshot.retention_location_ref, /^retention_[0-9a-f]{64}$/);
    assert.equal(manifest.read_only, true);
    assert.equal(manifest.governance.classification_approver, "Ronak Chakraborty");
    assert.equal(manifest.governance.classification_approval_status, "not_recorded");
    assert.equal(manifest.governance.mutation_authority, "none");
    assert.equal(manifest.governance.mutation_requires_separate_package, true);
  });

  it("proves totality, uniqueness, and per-source partition reconciliation", () => {
    const manifest = classifyDocument(fixture());

    assert.equal(manifest.summary.total_source_count, 7);
    assert.equal(manifest.summary.total_manifest_count, 7);
    assert.equal(manifest.summary.all_partition_checks_passed, true);
    for (const check of manifest.summary.partition_checks) {
      assert.equal(check.source_count, check.manifest_identifier_count);
      assert.equal(check.manifest_identifier_count, check.distinct_manifest_identifier_count);
      assert.equal(check.missing_count, 0);
      assert.equal(check.unexpected_count, 0);
      assert.equal(check.passed, true);
    }
  });

  it("rejects missing categories, count drift, and duplicate opaque references", () => {
    const missingCategory = fixture();
    delete missingCategory.source_counts.stripe_event;
    assert.throws(
      () => classifyDocument(missingCategory),
      /missing or unsupported fields/,
    );

    const countDrift = fixture();
    countDrift.source_counts.auth_user += 1;
    assert.throws(
      () => classifyDocument(countDrift),
      /does not reconcile to declared source counts/,
    );

    const duplicate = fixture();
    duplicate.records[1].opaque_ref = duplicate.records[0].opaque_ref;
    assert.throws(
      () => classifyDocument(duplicate),
      /duplicate opaque references/,
    );
  });

  it("rejects unsupported evidence such as name or email heuristics", () => {
    for (const kind of ["name_pattern", "email_pattern"]) {
      const input = fixture();
      input.records[0].evidence = [
        {
          kind,
          count: 1,
          source_ref: `evidence_${"b".repeat(64)}`,
        },
      ];
      assert.throws(() => classifyDocument(input), /not an allowed value/);
    }
  });

  it("rejects PII fields without reflecting synthetic PII values in errors", () => {
    const input = fixture();
    const syntheticPii = "synthetic.person@example.invalid";
    input.records[0].email = syntheticPii;

    let message = "";
    try {
      classifyDocument(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.match(message, /missing or unsupported fields/);
    assert.doesNotMatch(message, /synthetic\.person|example\.invalid/);
  });

  it("rejects non-opaque references and never accepts unsalted email hashes", () => {
    const input = fixture();
    input.records[0].opaque_ref = "person@example.invalid";
    assert.throws(() => classifyDocument(input), /secret-safe contract/);

    const wrongScheme = fixture();
    wrongScheme.snapshot.opaque_ref_scheme = "sha256-email-v1";
    assert.throws(() => classifyDocument(wrongScheme), /unsupported/);
  });

  it("verifies only exact deterministic manifests and rejects tampering", () => {
    const input = fixture();
    const manifest = classifyDocument(input);
    assert.deepEqual(verifyManifest(input, manifest), {
      manifest_digest: manifest.manifest_digest,
      total_manifest_count: 7,
      unknown_count: 2,
    });

    const tampered = structuredClone(manifest);
    tampered.records[0].classification = "controlled_synthetic";
    assert.throws(() => verifyManifest(input, tampered), /does not exactly match/);
  });

  it("runs the classify and verify CLIs without leaking rejected synthetic PII", () => {
    const directory = mkdtempSync(join(tmpdir(), "koaryu-classification-"));
    const inputPath = join(directory, "input.json");
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(inputPath, `${JSON.stringify(fixture(), null, 2)}\n`, { mode: 0o600 });

    const classify = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/classify-production-data.mjs"), inputPath],
      { encoding: "utf8" },
    );
    assert.equal(classify.status, 0, classify.stderr);
    writeFileSync(manifestPath, classify.stdout, { mode: 0o600 });

    const verify = spawnSync(
      process.execPath,
      [
        resolve(ROOT, "scripts/verify-production-data-classification.mjs"),
        inputPath,
        manifestPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /records=7; unknown=2/);
    assert.doesNotMatch(verify.stdout, /entity_|evidence_/);

    const rejected = fixture();
    rejected.records[0].requester_name = "Synthetic Private Person";
    writeFileSync(inputPath, `${JSON.stringify(rejected)}\n`, { mode: 0o600 });
    const rejectedRun = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/classify-production-data.mjs"), inputPath],
      { encoding: "utf8" },
    );
    assert.notEqual(rejectedRun.status, 0);
    assert.equal(rejectedRun.stdout, "");
    assert.doesNotMatch(rejectedRun.stderr, /Synthetic Private Person/);
  });

  it("keeps the versioned policy fail-closed and mutation-free", () => {
    const { policy } = loadPolicy();
    assert.deepEqual(
      policy.taxonomy.map((entry) => entry.classification),
      [
        "current_customer",
        "historical_customer",
        "controlled_synthetic",
        "required_system",
        "historical_setup",
        "unknown",
      ],
    );
    assert.equal(policy.unknown_rules.insufficient_reason_code, "insufficient_admissible_evidence");
    assert.equal(policy.governance.mutation_authority, "none");
    assert.equal(policy.governance.retention_period, "24 months after the manifest is superseded");
  });
});
