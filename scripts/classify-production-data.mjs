#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const POLICY_PATH = resolve(ROOT, "config/production-data-classification-policy.json");
const MAX_COUNT = 1_000_000_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MIGRATION_HEAD_PATTERN = /^[0-9]{14}$/;
const CAPTURED_AT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const OPAQUE_REF_PATTERNS = {
  backup: /^backup_[0-9a-f]{64}$/,
  project: /^project_[0-9a-f]{64}$/,
  keyver: /^keyver_[0-9a-f]{64}$/,
  retention: /^retention_[0-9a-f]{64}$/,
  entity: /^entity_[0-9a-f]{64}$/,
  evidence: /^evidence_[0-9a-f]{64}$/,
};

const SUPPORTED_RULES = new Map([
  [
    "live_customer_relationship",
    {
      rule_id: "customer-live-v1",
      claim_group: "customer",
      classification: "current_customer",
      reason_code: "live_customer_relationship_present",
      confidence: "high",
      priority: 100,
    },
  ],
  [
    "historical_customer_relationship",
    {
      rule_id: "customer-historical-v1",
      claim_group: "customer",
      classification: "historical_customer",
      reason_code: "historical_customer_relationship_present",
      confidence: "high",
      priority: 90,
    },
  ],
  [
    "registered_system_dependency",
    {
      rule_id: "system-registry-v1",
      claim_group: "system",
      classification: "required_system",
      reason_code: "registered_system_dependency_present",
      confidence: "high",
      priority: 80,
    },
  ],
  [
    "registered_synthetic_marker",
    {
      rule_id: "synthetic-registry-v1",
      claim_group: "synthetic",
      classification: "controlled_synthetic",
      reason_code: "registered_synthetic_marker_present",
      confidence: "high",
      priority: 80,
    },
  ],
  [
    "owner_approved_setup_attestation",
    {
      rule_id: "setup-owner-attestation-v1",
      claim_group: "setup",
      classification: "historical_setup",
      reason_code: "owner_approved_setup_attestation_present",
      confidence: "medium",
      priority: 70,
    },
  ],
]);

const SUPPORTED_CONTEXT = new Map([
  ["application_relationship", "application_relationship_is_context_only"],
  ["recent_activity", "recent_activity_is_context_only"],
]);

const SUPPORTED_CLASSIFICATIONS = [
  "current_customer",
  "historical_customer",
  "controlled_synthetic",
  "required_system",
  "historical_setup",
  "unknown",
];

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertExactKeys(value, requiredKeys, path) {
  assertPlainObject(value, path);
  const required = new Set(requiredKeys);
  const actual = Object.keys(value);
  if (actual.length !== required.size || actual.some((key) => !required.has(key))) {
    throw new Error(`${path} contains missing or unsupported fields`);
  }
}

function assertAllowedString(value, allowed, path) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${path} is not an allowed value`);
  }
}

function assertPattern(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${path} does not match the secret-safe contract`);
  }
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new Error(`${path} must be a bounded non-negative integer`);
  }
}

function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function loadPolicySource() {
  const source = readFileSync(POLICY_PATH, "utf8");
  return parseJson(source, "classification policy");
}

function validatePolicy(policy) {
  assertExactKeys(
    policy,
    [
      "policy_version",
      "input_schema_version",
      "manifest_schema_version",
      "classifier_version",
      "in_scope_record_types",
      "taxonomy",
      "evidence_hierarchy",
      "rules",
      "context_only_evidence",
      "unknown_rules",
      "governance",
    ],
    "classification policy",
  );

  if (policy.policy_version !== "koaryu-production-data-classification/v1") {
    throw new Error("classification policy version is unsupported");
  }
  if (policy.input_schema_version !== 1 || policy.manifest_schema_version !== 1) {
    throw new Error("classification schema version is unsupported");
  }
  if (policy.classifier_version !== "1.0.0") {
    throw new Error("classifier version is unsupported");
  }

  const expectedTypes = [
    "auth_user",
    "studio",
    "studio_subscription",
    "studio_payment_account",
    "stripe_event",
  ];
  if (
    !Array.isArray(policy.in_scope_record_types)
    || canonicalJson([...policy.in_scope_record_types].sort()) !== canonicalJson([...expectedTypes].sort())
  ) {
    throw new Error("classification policy has unsupported source categories");
  }

  if (!Array.isArray(policy.taxonomy)) {
    throw new Error("classification policy taxonomy must be an array");
  }
  const taxonomyLabels = policy.taxonomy.map((entry, index) => {
    assertExactKeys(entry, ["classification", "description"], `classification policy taxonomy[${index}]`);
    if (typeof entry.description !== "string" || entry.description.length === 0) {
      throw new Error("classification policy taxonomy descriptions must be non-empty");
    }
    return entry.classification;
  });
  if (canonicalJson(taxonomyLabels) !== canonicalJson(SUPPORTED_CLASSIFICATIONS)) {
    throw new Error("classification policy taxonomy is unsupported");
  }

  if (!Array.isArray(policy.rules) || policy.rules.length !== SUPPORTED_RULES.size) {
    throw new Error("classification policy rules are incomplete");
  }
  const seenRuleKinds = new Set();
  for (const [index, rule] of policy.rules.entries()) {
    assertExactKeys(
      rule,
      [
        "rule_id",
        "evidence_kind",
        "claim_group",
        "classification",
        "reason_code",
        "confidence",
        "priority",
      ],
      `classification policy rules[${index}]`,
    );
    const supported = SUPPORTED_RULES.get(rule.evidence_kind);
    if (!supported || canonicalJson(rule) !== canonicalJson({ evidence_kind: rule.evidence_kind, ...supported })) {
      throw new Error("classification policy contains an unsupported rule");
    }
    if (seenRuleKinds.has(rule.evidence_kind)) {
      throw new Error("classification policy contains a duplicate evidence rule");
    }
    seenRuleKinds.add(rule.evidence_kind);
  }

  if (!Array.isArray(policy.context_only_evidence) || policy.context_only_evidence.length !== SUPPORTED_CONTEXT.size) {
    throw new Error("classification policy context rules are incomplete");
  }
  const seenContextKinds = new Set();
  for (const [index, entry] of policy.context_only_evidence.entries()) {
    assertExactKeys(
      entry,
      ["evidence_kind", "reason_code"],
      `classification policy context_only_evidence[${index}]`,
    );
    if (SUPPORTED_CONTEXT.get(entry.evidence_kind) !== entry.reason_code) {
      throw new Error("classification policy contains unsupported contextual evidence");
    }
    if (seenContextKinds.has(entry.evidence_kind)) {
      throw new Error("classification policy contains duplicate contextual evidence");
    }
    seenContextKinds.add(entry.evidence_kind);
  }

  assertExactKeys(
    policy.unknown_rules,
    [
      "conflict_rule_id",
      "conflict_reason_code",
      "insufficient_rule_id",
      "insufficient_reason_code",
      "confidence",
    ],
    "classification policy unknown_rules",
  );
  const expectedUnknownRules = {
    conflict_rule_id: "unknown-conflict-v1",
    conflict_reason_code: "conflicting_conclusive_evidence",
    insufficient_rule_id: "unknown-insufficient-v1",
    insufficient_reason_code: "insufficient_admissible_evidence",
    confidence: "low",
  };
  if (canonicalJson(policy.unknown_rules) !== canonicalJson(expectedUnknownRules)) {
    throw new Error("classification policy unknown rules are unsupported");
  }

  if (!Array.isArray(policy.evidence_hierarchy) || policy.evidence_hierarchy.length !== 4) {
    throw new Error("classification policy evidence hierarchy is incomplete");
  }
  const expectedHierarchyRank = new Map([
    ["live_customer_relationship", 1],
    ["historical_customer_relationship", 1],
    ["registered_system_dependency", 2],
    ["registered_synthetic_marker", 2],
    ["owner_approved_setup_attestation", 3],
    ["application_relationship", 4],
    ["recent_activity", 4],
  ]);
  const seenHierarchyKinds = new Set();
  for (const [index, entry] of policy.evidence_hierarchy.entries()) {
    assertExactKeys(
      entry,
      ["rank", "evidence_kinds", "description"],
      `classification policy evidence_hierarchy[${index}]`,
    );
    if (entry.rank !== index + 1 || !Array.isArray(entry.evidence_kinds)) {
      throw new Error("classification policy evidence hierarchy rank is unsupported");
    }
    if (typeof entry.description !== "string" || entry.description.length === 0) {
      throw new Error("classification policy evidence hierarchy description is incomplete");
    }
    for (const evidenceKind of entry.evidence_kinds) {
      if (
        expectedHierarchyRank.get(evidenceKind) !== entry.rank
        || seenHierarchyKinds.has(evidenceKind)
      ) {
        throw new Error("classification policy evidence hierarchy contains unsupported evidence");
      }
      seenHierarchyKinds.add(evidenceKind);
    }
  }
  if (seenHierarchyKinds.size !== expectedHierarchyRank.size) {
    throw new Error("classification policy evidence hierarchy is incomplete");
  }

  assertExactKeys(
    policy.governance,
    [
      "data_owner",
      "technical_operator",
      "classification_approver",
      "retention_location",
      "retention_period",
      "policy_review_cadence",
      "mutation_authority",
    ],
    "classification policy governance",
  );
  if (
    policy.governance.data_owner !== "Ronak Chakraborty"
    || policy.governance.technical_operator !== "Codex release orchestrator"
    || policy.governance.classification_approver !== "Ronak Chakraborty"
    || policy.governance.mutation_authority !== "none"
  ) {
    throw new Error("classification policy governance boundary is unsupported");
  }
  for (const key of ["retention_location", "retention_period", "policy_review_cadence"]) {
    if (typeof policy.governance[key] !== "string" || policy.governance[key].length === 0) {
      throw new Error("classification policy governance is incomplete");
    }
  }
}

export function loadPolicy() {
  const policy = loadPolicySource();
  validatePolicy(policy);
  return {
    policy,
    policyDigest: sha256(canonicalJson(policy)),
    classifierSourceDigest: sha256(
      readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n"),
    ),
  };
}

function normalizeSnapshot(snapshot) {
  assertExactKeys(
    snapshot,
    [
      "backup_set_ref",
      "source_project_ref",
      "captured_at",
      "application_sha",
      "repository_migration_head",
      "remote_migration_history_digest",
      "backup_data_ciphertext_digest",
      "artifact_encryption_key_ref",
      "retention_location_ref",
      "opaque_ref_scheme",
      "opaque_ref_key_version",
      "extractor_version",
      "creation_role",
    ],
    "input snapshot",
  );
  assertPattern(snapshot.backup_set_ref, OPAQUE_REF_PATTERNS.backup, "input snapshot backup_set_ref");
  assertPattern(snapshot.source_project_ref, OPAQUE_REF_PATTERNS.project, "input snapshot source_project_ref");
  assertPattern(snapshot.captured_at, CAPTURED_AT_PATTERN, "input snapshot captured_at");
  if (Number.isNaN(Date.parse(snapshot.captured_at))) {
    throw new Error("input snapshot captured_at is invalid");
  }
  assertPattern(snapshot.application_sha, COMMIT_SHA_PATTERN, "input snapshot application_sha");
  assertPattern(
    snapshot.repository_migration_head,
    MIGRATION_HEAD_PATTERN,
    "input snapshot repository_migration_head",
  );
  assertPattern(
    snapshot.remote_migration_history_digest,
    SHA256_PATTERN,
    "input snapshot remote_migration_history_digest",
  );
  assertPattern(
    snapshot.backup_data_ciphertext_digest,
    SHA256_PATTERN,
    "input snapshot backup_data_ciphertext_digest",
  );
  assertPattern(
    snapshot.artifact_encryption_key_ref,
    OPAQUE_REF_PATTERNS.keyver,
    "input snapshot artifact_encryption_key_ref",
  );
  assertPattern(
    snapshot.retention_location_ref,
    OPAQUE_REF_PATTERNS.retention,
    "input snapshot retention_location_ref",
  );
  if (snapshot.opaque_ref_scheme !== "hmac-sha256-v1") {
    throw new Error("input snapshot opaque_ref_scheme is unsupported");
  }
  assertPattern(
    snapshot.opaque_ref_key_version,
    OPAQUE_REF_PATTERNS.keyver,
    "input snapshot opaque_ref_key_version",
  );
  if (snapshot.extractor_version !== "aggregate-extractor/v1") {
    throw new Error("input snapshot extractor_version is unsupported");
  }
  if (snapshot.creation_role !== "codex_release_orchestrator") {
    throw new Error("input snapshot creation_role is unsupported");
  }
  return { ...snapshot };
}

function normalizeEvidence(evidence, recordIndex, policy) {
  if (!Array.isArray(evidence)) {
    throw new Error(`input records[${recordIndex}].evidence must be an array`);
  }
  const allowedKinds = new Set([
    ...policy.rules.map((rule) => rule.evidence_kind),
    ...policy.context_only_evidence.map((entry) => entry.evidence_kind),
  ]);
  const seen = new Set();
  const normalized = evidence.map((entry, evidenceIndex) => {
    const path = `input records[${recordIndex}].evidence[${evidenceIndex}]`;
    assertExactKeys(entry, ["kind", "count", "source_ref"], path);
    assertAllowedString(entry.kind, [...allowedKinds], `${path}.kind`);
    assertCount(entry.count, `${path}.count`);
    assertPattern(entry.source_ref, OPAQUE_REF_PATTERNS.evidence, `${path}.source_ref`);
    const key = `${entry.kind}:${entry.source_ref}`;
    if (seen.has(key)) {
      throw new Error(`input records[${recordIndex}].evidence contains a duplicate entry`);
    }
    seen.add(key);
    return {
      kind: entry.kind,
      count: entry.count,
      source_ref: entry.source_ref,
    };
  });
  return normalized.sort(
    (left, right) => compareText(left.kind, right.kind) || compareText(left.source_ref, right.source_ref),
  );
}

export function normalizeInput(input, policy) {
  assertExactKeys(
    input,
    ["schema_version", "policy_version", "snapshot", "source_counts", "records"],
    "classification input",
  );
  if (input.schema_version !== policy.input_schema_version) {
    throw new Error("classification input schema version is unsupported");
  }
  if (input.policy_version !== policy.policy_version) {
    throw new Error("classification input policy version is unsupported");
  }
  const snapshot = normalizeSnapshot(input.snapshot);

  assertExactKeys(input.source_counts, policy.in_scope_record_types, "classification input source_counts");
  const sourceCounts = {};
  for (const recordType of policy.in_scope_record_types) {
    assertCount(input.source_counts[recordType], `classification input source_counts.${recordType}`);
    sourceCounts[recordType] = input.source_counts[recordType];
  }

  if (!Array.isArray(input.records)) {
    throw new Error("classification input records must be an array");
  }
  const seenRefs = new Set();
  const actualCounts = Object.fromEntries(policy.in_scope_record_types.map((recordType) => [recordType, 0]));
  const records = input.records.map((record, recordIndex) => {
    const path = `input records[${recordIndex}]`;
    assertExactKeys(record, ["opaque_ref", "record_type", "evidence"], path);
    assertPattern(record.opaque_ref, OPAQUE_REF_PATTERNS.entity, `${path}.opaque_ref`);
    assertAllowedString(record.record_type, policy.in_scope_record_types, `${path}.record_type`);
    if (seenRefs.has(record.opaque_ref)) {
      throw new Error("classification input contains duplicate opaque references");
    }
    seenRefs.add(record.opaque_ref);
    actualCounts[record.record_type] += 1;
    return {
      opaque_ref: record.opaque_ref,
      record_type: record.record_type,
      evidence: normalizeEvidence(record.evidence, recordIndex, policy),
    };
  });

  for (const recordType of policy.in_scope_record_types) {
    if (actualCounts[recordType] !== sourceCounts[recordType]) {
      throw new Error("classification input does not reconcile to declared source counts");
    }
  }

  records.sort(
    (left, right) => compareText(left.record_type, right.record_type)
      || compareText(left.opaque_ref, right.opaque_ref),
  );
  return {
    schema_version: input.schema_version,
    policy_version: input.policy_version,
    snapshot,
    source_counts: sourceCounts,
    records,
  };
}

function classifyRecord(record, policy) {
  const ruleByKind = new Map(policy.rules.map((rule) => [rule.evidence_kind, rule]));
  const contextByKind = new Map(
    policy.context_only_evidence.map((entry) => [entry.evidence_kind, entry.reason_code]),
  );
  const positiveEvidence = record.evidence.filter((entry) => entry.count > 0);
  const claims = positiveEvidence
    .map((entry) => ruleByKind.get(entry.kind))
    .filter(Boolean);
  const claimGroups = [...new Set(claims.map((claim) => claim.claim_group))];
  const contextReasons = positiveEvidence
    .map((entry) => contextByKind.get(entry.kind))
    .filter(Boolean);

  let classification;
  let confidence;
  let ruleId;
  let reasons;

  if (claimGroups.length > 1) {
    classification = "unknown";
    confidence = policy.unknown_rules.confidence;
    ruleId = policy.unknown_rules.conflict_rule_id;
    reasons = [
      policy.unknown_rules.conflict_reason_code,
      ...claims.map((claim) => claim.reason_code),
      ...contextReasons,
    ];
  } else if (claims.length > 0) {
    const selected = [...claims].sort(
      (left, right) => right.priority - left.priority || compareText(left.rule_id, right.rule_id),
    )[0];
    classification = selected.classification;
    confidence = selected.confidence;
    ruleId = selected.rule_id;
    reasons = [...claims.map((claim) => claim.reason_code), ...contextReasons];
  } else {
    classification = "unknown";
    confidence = policy.unknown_rules.confidence;
    ruleId = policy.unknown_rules.insufficient_rule_id;
    reasons = [policy.unknown_rules.insufficient_reason_code, ...contextReasons];
  }

  return {
    opaque_ref: record.opaque_ref,
    record_type: record.record_type,
    classification,
    confidence,
    rule_id: ruleId,
    reason_codes: [...new Set(reasons)].sort(compareText),
    evidence_fingerprint: sha256(canonicalJson(record.evidence)),
    evidence: record.evidence,
  };
}

function buildSummary(records, normalizedInput, policy) {
  const classificationCounts = Object.fromEntries(
    policy.taxonomy.map((entry) => [entry.classification, 0]),
  );
  const manifestCounts = Object.fromEntries(
    policy.in_scope_record_types.map((recordType) => [recordType, 0]),
  );
  const unknownCounts = Object.fromEntries(
    policy.in_scope_record_types.map((recordType) => [recordType, 0]),
  );
  const distinctByType = new Map(
    policy.in_scope_record_types.map((recordType) => [recordType, new Set()]),
  );

  for (const record of records) {
    classificationCounts[record.classification] += 1;
    manifestCounts[record.record_type] += 1;
    distinctByType.get(record.record_type).add(record.opaque_ref);
    if (record.classification === "unknown") {
      unknownCounts[record.record_type] += 1;
    }
  }

  const partition_checks = policy.in_scope_record_types.map((recordType) => {
    const sourceCount = normalizedInput.source_counts[recordType];
    const manifestCount = manifestCounts[recordType];
    const distinctCount = distinctByType.get(recordType).size;
    return {
      record_type: recordType,
      source_count: sourceCount,
      manifest_identifier_count: manifestCount,
      distinct_manifest_identifier_count: distinctCount,
      classified_count: manifestCount,
      missing_count: sourceCount - manifestCount,
      unexpected_count: manifestCount - sourceCount,
      passed: sourceCount === manifestCount && manifestCount === distinctCount,
    };
  });

  return {
    total_source_count: Object.values(normalizedInput.source_counts).reduce((total, count) => total + count, 0),
    total_manifest_count: records.length,
    source_counts: normalizedInput.source_counts,
    manifest_counts: manifestCounts,
    classification_counts: classificationCounts,
    unknown_counts: unknownCounts,
    partition_checks,
    all_partition_checks_passed: partition_checks.every((check) => check.passed),
  };
}

export function classifyDocument(input) {
  const { policy, policyDigest, classifierSourceDigest } = loadPolicy();
  const normalizedInput = normalizeInput(input, policy);
  const records = normalizedInput.records.map((record) => classifyRecord(record, policy));
  const baseManifest = {
    schema_version: policy.manifest_schema_version,
    policy_version: policy.policy_version,
    classifier_version: policy.classifier_version,
    classifier_source_digest: classifierSourceDigest,
    policy_digest: policyDigest,
    input_digest: sha256(canonicalJson(normalizedInput)),
    snapshot: normalizedInput.snapshot,
    read_only: true,
    taxonomy: policy.taxonomy,
    evidence_hierarchy: policy.evidence_hierarchy,
    governance: {
      data_owner: policy.governance.data_owner,
      technical_operator: policy.governance.technical_operator,
      classification_approver: policy.governance.classification_approver,
      classification_approval_status: "not_recorded",
      classification_approval_scope: "this exact read-only classification manifest only",
      retention_location: policy.governance.retention_location,
      retention_period: policy.governance.retention_period,
      policy_review_cadence: policy.governance.policy_review_cadence,
      mutation_authority: policy.governance.mutation_authority,
      mutation_requires_separate_package: true,
    },
    summary: buildSummary(records, normalizedInput, policy),
    records,
  };
  return {
    ...baseManifest,
    manifest_digest: sha256(canonicalJson(baseManifest)),
  };
}

export function readSecretSafeJson(path, label = "classification input") {
  return parseJson(readFileSync(path, "utf8"), label);
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error("usage: node scripts/classify-production-data.mjs <secret-safe-input.json>");
  }
  const input = readSecretSafeJson(resolve(argv[0]));
  process.stdout.write(`${JSON.stringify(classifyDocument(input), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "classification failed";
    process.stderr.write(`production data classification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
