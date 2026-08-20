import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  ROLLOUT,
  EXPECTED_CATALOG_STATE,
  TOLERATED_HISTORY_COLUMNS,
  EXPECTED_OPERATIONAL_MANIFEST,
  EXPECTED_CRITICAL_SURFACE_MANIFEST,
  EXPECTED_PRE_OPERATIONAL_READINESS,
  EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS,
  EXPECTED_RECOVERY_OPERATIONAL_READINESS,
  EXPECTED_CONVERGENCE_OPERATIONAL_READINESS,
  EXPECTED_ATTESTED_OPERATIONAL_READINESS,
  EXPECTED_CRITICAL_OPERATIONAL_READINESS,
  EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS,
  EXPECTED_OPERATIONAL_READINESS,
  EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS,
  EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS,
  EXPECTED_WRITER_RETURN_CONTRACT_STATE,
  WRITER_RETURN_CONTRACT_STATE_SQL,
  assertApplyableState,
  assertExactPendingMigrations,
  assertInspectionToken,
  assertSafeCredentialedTransport,
  buildInspectionToken,
  buildInspectionTokenForAcceptedState,
  buildProductionConfirmationPhrase,
  classifyStateSnapshot,
  extractPendingMigrations,
  formatDiagnosisReport,
  formatNonSuccessProbeState,
  main,
  parseSingleValueCsv,
  parseArguments,
  packetForAcceptedState,
  readRemoteState,
  readRemoteDiagnosis,
  runCommand,
  runDryRun,
  validateApplyAuthorization,
  validateHistoryColumnMetadata,
  validateOperationalManifest,
  validateOperationalReadiness,
  validateCriticalSurfaceManifest,
  verifySourceTree,
} from "./studio-comp-migration-rollout.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const validCatalogState = EXPECTED_CATALOG_STATE;
const validFingerprint =
  "functions=3:0123456789abcdef0123456789abcdef:0;" +
  "trigger=1:fedcba9876543210fedcba9876543210:0;" +
  `catalog=${validCatalogState};critical_surface=${EXPECTED_CRITICAL_SURFACE_MANIFEST}`;

function historyColumn(column_name, data_type, udt_name, overrides = {}) {
  return {
    column_name,
    data_type,
    udt_name,
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
    ...overrides,
  };
}

const minimalHistoryColumns = [
  historyColumn("version", "text", "text", { is_nullable: "NO" }),
  historyColumn("statements", "ARRAY", "_text"),
  historyColumn("name", "text", "text"),
];
const stagingHistoryColumns = [
  ...minimalHistoryColumns,
  historyColumn("created_by", "text", "text"),
  historyColumn("idempotency_key", "text", "text"),
  historyColumn("rollback", "ARRAY", "_text"),
];
const extendedHistoryColumns = JSON.stringify(stagingHistoryColumns);
const divergentHistoryColumns = JSON.stringify([
  ...stagingHistoryColumns,
  historyColumn("foo", "text", "text"),
]);

function replaceHistoryColumn(columns, name, overrides) {
  return columns.map((column) =>
    column.column_name === name ? { ...column, ...overrides } : column
  );
}

function candidatePacket() {
  return verifySourceTree(repositoryRoot, candidateSha);
}

function singleValueCsv(header, value, recordEnding = "\n") {
  const encoded = /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${header}${recordEnding}${encoded}${recordEnding}`;
}

function preSnapshot(overrides = {}) {
  const packet = candidatePacket();
  return {
    historyColumns: minimalHistoryColumns,
    history: ROLLOUT.preHistory,
    targetHistory: packet.preTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_PRE_OPERATIONAL_READINESS,
    ...overrides,
  };
}

function postSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.postHistory,
    targetHistory: packet.postTargetHistory,
    objectCounts: "3:1",
    functionState: "3:0123456789abcdef0123456789abcdef:0",
    triggerState: "1:fedcba9876543210fedcba9876543210:0",
    catalogState: validCatalogState,
    criticalSurfaceManifest: EXPECTED_CRITICAL_SURFACE_MANIFEST,
    operationalReadiness: EXPECTED_OPERATIONAL_READINESS,
    ...overrides,
  };
}

function intermediateSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.intermediateHistory,
    targetHistory: packet.intermediateTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS,
    ...overrides,
  };
}

function recoverySnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.recoveryHistory,
    targetHistory: packet.recoveryTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_RECOVERY_OPERATIONAL_READINESS[0],
    ...overrides,
  };
}

function convergenceSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.convergenceHistory,
    targetHistory: packet.convergenceTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_CONVERGENCE_OPERATIONAL_READINESS,
    ...overrides,
  };
}

function attestedSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.attestedHistory,
    targetHistory: packet.attestedTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_ATTESTED_OPERATIONAL_READINESS,
    writerReturnContractState: EXPECTED_WRITER_RETURN_CONTRACT_STATE,
    ...overrides,
  };
}

function criticalSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.criticalHistory,
    targetHistory: packet.criticalTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_CRITICAL_OPERATIONAL_READINESS,
    writerReturnContractState: EXPECTED_WRITER_RETURN_CONTRACT_STATE,
    ...overrides,
  };
}

function columnAttestedSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.columnAttestedHistory,
    targetHistory: packet.columnAttestedTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS,
    writerReturnContractState: EXPECTED_WRITER_RETURN_CONTRACT_STATE,
    ...overrides,
  };
}

function trialLockedSnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.trialLockedHistory,
    targetHistory: packet.trialLockedTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function staffIdentitySnapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.staffIdentityHistory,
    targetHistory: packet.staffIdentityTargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function assertReadOnlySql(sql) {
  const normalized = sql.trim();
  const executableSql = normalized
    .replace(/'(?:''|[^'])*'/gs, "''")
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(normalized, /^(?:select|with)\b/i);
  assert.doesNotMatch(
    executableSql,
    /\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|do)\b/i,
  );
  assert.ok(!executableSql.replace(/;\s*$/, "").includes(";"));
}

describe("studio-comp migration rollout guard", () => {
  it("pins the database-observable manifest without treating it as release authority", () => {
    assert.equal(validateOperationalManifest(EXPECTED_OPERATIONAL_MANIFEST), EXPECTED_OPERATIONAL_MANIFEST);
    assert.throws(
      () => validateOperationalManifest("0".repeat(64)),
      /Operational semantic\/ACL manifest mismatch/,
    );
  });

  it("requires the exact V19 operational readiness output", () => {
    assert.equal(
      validateOperationalReadiness(EXPECTED_OPERATIONAL_READINESS),
      EXPECTED_OPERATIONAL_READINESS,
    );
    for (const value of [null, "", "true|101|20260814043325", `${EXPECTED_OPERATIONAL_READINESS}|extra`]) {
      assert.throws(() => validateOperationalReadiness(value), /V19 operational readiness/);
    }
  });

  it("requires the exact archive-critical semantic manifest output", () => {
    assert.equal(
      EXPECTED_CRITICAL_SURFACE_MANIFEST,
      "0:6c7f4eb2d78e203c0054fd0701398c373089e3409473e7f123ee90965ff161b1",
    );
    assert.equal(
      validateCriticalSurfaceManifest(EXPECTED_CRITICAL_SURFACE_MANIFEST),
      EXPECTED_CRITICAL_SURFACE_MANIFEST,
    );
    assert.throws(
      () => validateCriticalSurfaceManifest(EXPECTED_CRITICAL_SURFACE_MANIFEST.replace(/^0:/, "1:")),
      /V18 critical-surface semantic manifest/,
    );
  });

  it("pins all four student-writer return contracts through database-observable SQL", () => {
    assert.equal(
      (WRITER_RETURN_CONTRACT_STATE_SQL.match(/pg_get_function_result/g) || []).length,
      1,
    );
    for (const signature of [
      "public.write_student_profile_atomic",
      "private.write_student_profile_atomic",
      "public.import_student_row_atomic",
      "private.import_student_row_atomic",
    ]) {
      assert.match(WRITER_RETURN_CONTRACT_STATE_SQL, new RegExp(signature.replaceAll(".", "\\.")));
    }
    assert.match(WRITER_RETURN_CONTRACT_STATE_SQL, /TABLE\(student_id uuid, guardian_imported boolean\)/);
  });

  it("decodes the pinned CLI single-field CSV contract before exact V19 validation", () => {
    const quotedReadiness = singleValueCsv(
      "operational_readiness",
      EXPECTED_OPERATIONAL_READINESS,
    );
    assert.match(quotedReadiness, /^operational_readiness\n"true\|112\|/);
    assert.equal(
      parseSingleValueCsv(quotedReadiness, "operational_readiness"),
      EXPECTED_OPERATIONAL_READINESS,
    );
    assert.equal(parseSingleValueCsv("target_history\n\n", "target_history"), "");
    assert.equal(
      parseSingleValueCsv('sample\r\n"first, line\r\nsecond ""line"""\r\n', "sample"),
      'first, line\r\nsecond "line"',
    );
  });

  it("rejects malformed or non-scalar CSV without reflecting returned data", () => {
    const sentinel = "sensitive-fixture-value";
    const invalidOutputs = [
      `operational_readiness\n${sentinel},extra\n`,
      `operational_readiness\n${sentinel}\nextra\n`,
      `wrong_header\n${sentinel}\n`,
      `operational_readiness\n"${sentinel}\n`,
      `operational_readiness\n"${sentinel}"junk\n`,
      `operational_readiness\n${sentinel}"junk\n`,
      `operational_readiness\r${sentinel}\n`,
      `operational_readiness\n"${sentinel}\rcorrupt"\n`,
      `operational_readiness\n${sentinel}\tvalue\n`,
      `operational_readiness\n${sentinel}\n\n`,
      "operational_readiness\n",
    ];
    for (const output of invalidOutputs) {
      assert.throws(
        () => parseSingleValueCsv(output, "operational_readiness"),
        (error) =>
          /operational_readiness query returned/.test(error.message) &&
          !error.message.includes(sentinel),
      );
    }
  });

  it("derives an exact 100-to-112 packet from immutable ancestry and source hashes", () => {
    const packet = candidatePacket();
    assert.equal(packet.candidateSha, candidateSha);
    assert.equal(packet.migrationCount, 112);
    assert.match(packet.intermediateHistory, /^101:[0-9a-f]{32}$/);
    assert.match(packet.recoveryHistory, /^102:[0-9a-f]{32}$/);
    assert.match(packet.convergenceHistory, /^103:[0-9a-f]{32}$/);
    assert.match(packet.attestedHistory, /^104:[0-9a-f]{32}$/);
    assert.match(packet.returnAttestedHistory, /^105:[0-9a-f]{32}$/);
    assert.match(packet.retainedHistory, /^106:[0-9a-f]{32}$/);
    assert.match(packet.criticalHistory, /^107:[0-9a-f]{32}$/);
    assert.match(packet.columnAttestedHistory, /^108:[0-9a-f]{32}$/);
    assert.match(packet.trialLockedHistory, new RegExp(`^${ROLLOUT.trialLockedMigrationCount}:[0-9a-f]{32}$`));
    assert.equal(packet.staffIdentityHistory, "110:65664dce61981374e865f081fc2f9347");
    assert.match(packet.staffIdentityTargetHistory, /20260815220402:staff_identity_name_model$/);
    assert.match(packet.postHistory, new RegExp(`^${packet.migrationCount}:[0-9a-f]{32}$`));
    assert.equal(
      packet.pendingMigrations.length,
      packet.migrationCount - ROLLOUT.baselineMigrationCount,
    );
    assert.match(packet.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(packet.integrationComplete, true);
    assert.equal(packet.pendingMigrations.length, 12);
    assert.deepEqual(
      packet.pendingMigrations.map((filename) => filename.slice(0, 14)),
      ROLLOUT.releasePendingVersions,
    );
  });

  it("defaults to read-only inspection but requires an immutable candidate and pinned target", () => {
    assert.deepEqual(parseArguments(["--target", "staging", "--candidate-sha", candidateSha]), {
      mode: "inspect",
      target: "staging",
      candidateSha,
      confirmProject: null,
      approvalRecord: null,
      inspectionToken: null,
      expectedProviderFingerprint: null,
      confirmedRestoreWindow: null,
      restoreDecisionAuthority: null,
      approveStagingApply: false,
      humanProductionOperator: false,
    });
    assert.throws(() => parseArguments([]), /--target must be staging or production/);
    assert.throws(
      () => parseArguments(["--target", "staging", "--candidate-sha", "da2e02c"]),
      /full lowercase 40-character/,
    );
  });

  it("supports local packet regeneration without a provider target", () => {
    const config = parseArguments(["--mode", "packet", "--candidate-sha", candidateSha]);
    assert.equal(config.mode, "packet");
    assert.equal(config.target, null);
    assert.throws(
      () => parseArguments([
        "--mode", "packet", "--target", "staging", "--candidate-sha", candidateSha,
      ]),
      /local-only/,
    );
    assert.throws(
      () => parseArguments([
        "--mode", "packet", "--candidate-sha", candidateSha,
        "--expected-provider-fingerprint", validFingerprint,
      ]),
      /valid only for inspection comparison or production apply/,
    );
  });

  it("accepts diagnose only with a pinned target and full candidate SHA", () => {
    for (const target of ["staging", "production"]) {
      const config = parseArguments([
        "--mode", "diagnose", "--target", target, "--candidate-sha", candidateSha,
      ]);
      assert.equal(config.mode, "diagnose");
      assert.equal(config.target, target);
      assert.equal(config.candidateSha, candidateSha);
      assert.equal(config.inspectionToken, null);
      assert.equal(config.expectedProviderFingerprint, null);
    }
    assert.throws(
      () => parseArguments(["--mode", "diagnose", "--candidate-sha", candidateSha]),
      /--target must be staging or production/,
    );
    assert.throws(
      () => parseArguments([
        "--mode", "diagnose", "--target", "staging", "--candidate-sha", "da2e02c",
      ]),
      /full lowercase 40-character/,
    );
  });

  it("keeps diagnose outside inspection-token and fingerprint surfaces", () => {
    assert.throws(
      () => parseArguments([
        "--mode", "diagnose", "--target", "staging", "--candidate-sha", candidateSha,
        "--inspection-token", "a".repeat(64),
      ]),
      /cannot be supplied with --mode diagnose/,
    );
    assert.throws(
      () => parseArguments([
        "--mode", "diagnose", "--target", "production", "--candidate-sha", candidateSha,
        "--expected-provider-fingerprint", validFingerprint,
      ]),
      /valid only for inspection comparison or production apply/,
    );
  });

  it("rejects every apply authorization option for diagnose", () => {
    const applyOnlyOptions = [
      ["--confirm-project", ROLLOUT.stagingRef],
      ["--approval-record", "director-phase-b-approval"],
      ["--confirmed-restore-window", "2026-08-08T18:00:00Z/PITR-confirmed"],
      ["--restore-decision-authority", "Ronak Chakraborty"],
      ["--approve-staging-apply"],
      ["--human-production-operator"],
    ];
    for (const option of applyOnlyOptions) {
      assert.throws(
        () => parseArguments([
          "--mode", "diagnose", "--target", "staging", "--candidate-sha", candidateSha,
          ...option,
        ]),
        /Apply authorization options are valid only with --mode apply/,
      );
    }
  });

  it("rejects control characters and normalization-dependent values", () => {
    for (const value of [
      `${ROLLOUT.stagingRef}\t`,
      `${ROLLOUT.stagingRef}\r`,
      `${ROLLOUT.stagingRef}\n`,
      ` ${ROLLOUT.stagingRef}`,
    ]) {
      assert.throws(
        () => parseArguments([
          "--target", "staging", "--candidate-sha", candidateSha,
          "--mode", "apply", "--confirm-project", value,
        ]),
        /plain printable ASCII/,
      );
    }
  });

  it("fails closed on ambient proxy and TLS trust overrides before credentialed work", () => {
    for (const name of [
      "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "ALL_PROXY", "ftp_proxy", "GIT_PROXY_COMMAND",
      "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR",
      "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "PGSSLROOTCERT", "PGSSLMODE",
    ]) {
      assert.throws(
        () => assertSafeCredentialedTransport({ [name]: "configured-but-secret" }),
        (error) => error.message.includes(name) && !error.message.includes("configured-but-secret"),
      );
    }
    assert.doesNotThrow(() =>
      assertSafeCredentialedTransport({
        NO_PROXY: "localhost",
        HTTP_PROXY: "",
        NODE_EXTRA_CA_CERTS: "",
      }),
    );
  });

  it("reports a bounded command timeout as UNKNOWN(timeout) before returning output", { timeout: 3_000 }, () => {
    const timeoutMs = 100;
    const startedAt = process.hrtime.bigint();
    let returnedOutput = false;

    assert.throws(
      () => {
        const output = runCommand(
          process.execPath,
          ["-e", "setTimeout(() => {}, 5_000)"],
          {
            cwd: repositoryRoot,
            env: {},
            label: "slow timeout test command",
            timeout: timeoutMs,
          },
        );
        returnedOutput = true;
        return output;
      },
      (error) => {
        assert.equal(
          error.message,
          `slow timeout test command failed: UNKNOWN(timeout) after ${timeoutMs} ms.`,
        );
        return true;
      },
    );

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    assert.equal(returnedOutput, false);
    assert.ok(elapsedMs < 2_000, `timeout returned control after ${elapsedMs.toFixed(0)} ms`);
  });

  it("accepts the reviewed minimal shape and every optional-column subset", () => {
    for (let mask = 0; mask < 2 ** TOLERATED_HISTORY_COLUMNS.length; mask += 1) {
      const columns = [
        ...minimalHistoryColumns,
        ...stagingHistoryColumns.slice(minimalHistoryColumns.length).filter((_column, index) =>
          (mask & (1 << index)) !== 0
        ),
      ];
      assert.deepEqual(validateHistoryColumnMetadata(columns), { accepted: true });
    }
  });

  it("has no SQL name-exclusion predicate left to invert", () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot, "scripts", "studio-comp-migration-rollout.mjs"),
      "utf8",
    );
    assert.deepEqual(TOLERATED_HISTORY_COLUMNS, [
      "created_by",
      "idempotency_key",
      "rollback",
    ]);
    assert.doesNotMatch(source, /HISTORY_SCHEMA_SQL/);
    assert.doesNotMatch(source, /column_name\s+not\s+in/i);
    assert.doesNotMatch(source, /count\(\*\)\s+filter[\s\S]*history_schema/i);
  });

  it("rejects the rollback integer NOT NULL counterexample with nullability detail", () => {
    const result = validateHistoryColumnMetadata(
      replaceHistoryColumn(stagingHistoryColumns, "rollback", {
        data_type: "integer",
        udt_name: "int4",
        is_nullable: "NO",
      }),
    );
    assert.equal(result.accepted, false);
    assert.match(result.reason, /rollback.*nullability/i);
  });

  it("rejects defaults, generated columns, and identity columns for every optional column", () => {
    for (const name of TOLERATED_HISTORY_COLUMNS) {
      const defaultResult = validateHistoryColumnMetadata(
        replaceHistoryColumn(stagingHistoryColumns, name, {
          column_default: "'unexpected'::text",
        }),
      );
      assert.equal(defaultResult.accepted, false);
      assert.match(defaultResult.reason, new RegExp(`${name}.*default`, "i"));

      const generatedResult = validateHistoryColumnMetadata(
        replaceHistoryColumn(stagingHistoryColumns, name, { is_generated: "ALWAYS" }),
      );
      assert.equal(generatedResult.accepted, false);
      assert.match(generatedResult.reason, new RegExp(`${name}.*generated`, "i"));

      const identityResult = validateHistoryColumnMetadata(
        replaceHistoryColumn(stagingHistoryColumns, name, { is_identity: "YES" }),
      );
      assert.equal(identityResult.accepted, false);
      assert.match(identityResult.reason, new RegExp(`${name}.*identity`, "i"));
    }
  });

  it("rejects every insertion-relevant definition mutation for every known column", () => {
    for (const column of stagingHistoryColumns) {
      const mutations = [
        [{ data_type: "integer", udt_name: "int4" }, /type\/UDT/i],
        [{ is_nullable: column.is_nullable === "YES" ? "NO" : "YES" }, /nullability/i],
        [{ column_default: "'unexpected'::text" }, /default/i],
        [{ is_generated: "ALWAYS" }, /generated status/i],
        [{ is_identity: "YES" }, /identity status/i],
      ];
      for (const [overrides, reasonPattern] of mutations) {
        const result = validateHistoryColumnMetadata(
          replaceHistoryColumn(stagingHistoryColumns, column.column_name, overrides),
        );
        assert.equal(result.accepted, false);
        assert.match(result.reason, new RegExp(column.column_name, "i"));
        assert.match(result.reason, reasonPattern);
      }
    }
  });

  it("rejects prohibited and unrecognised history columns by name", () => {
    for (const [columnName, reasonPattern] of [
      ["content_hash", /hash\/checksum\/digest/i],
      ["foo", /unrecognised history column foo/i],
    ]) {
      const result = validateHistoryColumnMetadata([
        ...minimalHistoryColumns,
        historyColumn(columnName, "text", "text"),
      ]);
      assert.equal(result.accepted, false);
      assert.match(result.reason, reasonPattern);
    }
  });

  it("rejects each missing required history column", () => {
    for (const name of ["version", "statements", "name"]) {
      const result = validateHistoryColumnMetadata(
        minimalHistoryColumns.filter((column) => column.column_name !== name),
      );
      assert.equal(result.accepted, false);
      assert.match(result.reason, new RegExp(`missing required history column ${name}`, "i"));
    }
  });

  it("rejects statements unless it is the exact nullable _text ARRAY definition", () => {
    for (const overrides of [
      { data_type: "text", udt_name: "text" },
      { data_type: "ARRAY", udt_name: "_varchar" },
      { is_nullable: "NO" },
    ]) {
      const result = validateHistoryColumnMetadata(
        replaceHistoryColumn(minimalHistoryColumns, "statements", overrides),
      );
      assert.equal(result.accepted, false);
      assert.match(result.reason, /history column statements definition mismatch/i);
    }
  });

  it("applies the exact history-column prerequisite to both pre- and post-state", () => {
    const packet = candidatePacket();
    const unsafeColumns = replaceHistoryColumn(stagingHistoryColumns, "rollback", {
      is_nullable: "NO",
    });
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historyColumns: unsafeColumns }), packet),
      /rollback.*nullability/i,
    );
    assert.throws(
      () => classifyStateSnapshot(
        postSnapshot(packet, { historyColumns: unsafeColumns }),
        packet,
        validFingerprint,
      ),
      /rollback.*nullability/i,
    );
  });

  it("accepts exact pre-, intermediate-, recovery-, convergence-, attested-, trial-locked, staff-identity, or semantically valid post-state", () => {
    const packet = candidatePacket();
    assert.deepEqual(classifyStateSnapshot(preSnapshot(), packet), {
      state: "pre",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(postSnapshot(packet), packet, validFingerprint), {
      state: "post",
      providerFingerprint: validFingerprint,
    });
    assert.deepEqual(classifyStateSnapshot(intermediateSnapshot(packet), packet), {
      state: "intermediate",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(recoverySnapshot(packet), packet), {
      state: "recovery",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(convergenceSnapshot(packet), packet), {
      state: "convergence",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(attestedSnapshot(packet), packet), {
      state: "attested",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(staffIdentitySnapshot(packet), packet), {
      state: "staff-identity",
      providerFingerprint: null,
    });
    assert.throws(
      () => classifyStateSnapshot(
        attestedSnapshot(packet, { writerReturnContractState: "4:bad:1" }),
        packet,
      ),
      /writer return contracts/,
    );
    assert.deepEqual(
      classifyStateSnapshot(
        recoverySnapshot(packet, {
          operationalReadiness: EXPECTED_RECOVERY_OPERATIONAL_READINESS[0],
        }),
        packet,
      ),
      { state: "recovery", providerFingerprint: null },
    );
    assert.throws(
      () => classifyStateSnapshot(
        recoverySnapshot(packet, { operationalReadiness: "false|102|unexpected" }),
        packet,
      ),
      /V9 operational readiness/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        intermediateSnapshot(packet, {
          operationalReadiness: EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS.replace(/^true/, "false"),
        }),
        packet,
      ),
      /V8 operational readiness/,
    );
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ objectCounts: "1:0" }), packet),
      /exact V7 target history or studio-comp objects/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        preSnapshot({ operationalReadiness: EXPECTED_PRE_OPERATIONAL_READINESS.replace(/^true/, "false") }),
        packet,
      ),
      /V7 operational readiness/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        postSnapshot(packet, { functionState: "3:0123456789abcdef0123456789abcdef:1" }),
        packet,
      ),
      /Function owner, definition, security, search path, or ACL checks failed/,
    );
    assert.throws(
      () => classifyStateSnapshot(postSnapshot(packet), packet, validFingerprint.replace("fedc", "abcd")),
      /does not match the approved staging evidence/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        postSnapshot(packet, {
          catalogState: validCatalogState.replace("indexes=12", "indexes=11"),
        }),
        packet,
      ),
      /Repository-pinned raw catalog manifest mismatch/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        postSnapshot(packet, {
          catalogState: validCatalogState.replace(/(sequences=3:[0-9a-f]{64}):0/, "$1:1"),
        }),
        packet,
      ),
      /Repository-pinned raw catalog manifest mismatch/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        postSnapshot(packet, {
          criticalSurfaceManifest: EXPECTED_CRITICAL_SURFACE_MANIFEST.replace(/^0:/, "1:"),
        }),
        packet,
      ),
      /V18 critical-surface semantic manifest/,
    );
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ history: "85:unexpected" }), packet),
      /Unexpected migration history/,
    );
  });

  it("independently rejects every non-exact V19 output before post certification", () => {
    const packet = candidatePacket();
    for (const operationalReadiness of [
      null,
      "",
      EXPECTED_OPERATIONAL_READINESS.replace(/^true/, "false"),
      EXPECTED_OPERATIONAL_READINESS.replace(`|${ROLLOUT.finalMigrationCount}|`, "|109|"),
      EXPECTED_OPERATIONAL_READINESS.replace("|20260820012533|", "|20260814213000|"),
      EXPECTED_OPERATIONAL_READINESS.replace(",20260820012533|", "|"),
      EXPECTED_OPERATIONAL_READINESS.replace("|0||", "|1|table_acl|"),
      EXPECTED_OPERATIONAL_READINESS.replace("release-db-attestation-v19", "release-db-attestation-v16"),
    ]) {
      assert.throws(
        () => classifyStateSnapshot(postSnapshot(packet, { operationalReadiness }), packet),
        /V19 operational readiness/,
      );
    }
  });

  it("rejects substituted history, target history, or readiness for trial-locked migration 109", () => {
    const packet = candidatePacket();
    assert.throws(
      () => classifyStateSnapshot(
        trialLockedSnapshot(packet, { history: `${ROLLOUT.trialLockedMigrationCount}:00000000000000000000000000000000` }),
        packet,
      ),
      /Unexpected migration history/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        trialLockedSnapshot(packet, { targetHistory: `${packet.trialLockedTargetHistory}|substituted` }),
        packet,
      ),
      /exact V16 target history/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        trialLockedSnapshot(packet, {
          operationalReadiness: EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS.replace(
            `|${ROLLOUT.trialLockedMigrationCount}|`,
            "|108|",
          ),
        }),
        packet,
      ),
      /V16 operational readiness/,
    );
  });

  it("rejects substituted history, target history, object counts, or V17 readiness for staff-identity migration 110", () => {
    const packet = candidatePacket();
    assert.throws(
      () => classifyStateSnapshot(
        staffIdentitySnapshot(packet, { history: "110:00000000000000000000000000000000" }),
        packet,
      ),
      /Unexpected migration history/,
    );
    assert.throws(
      () => classifyStateSnapshot(
        staffIdentitySnapshot(packet, { targetHistory: `${packet.staffIdentityTargetHistory}|substituted` }),
        packet,
      ),
      /exact V17 target history/,
    );
    assert.throws(
      () => classifyStateSnapshot(staffIdentitySnapshot(packet, { objectCounts: "4:1" }), packet),
      /exact V17 target history/,
    );
    for (const operationalReadiness of [
      EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS.replace("|110|", "|109|"),
      EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS.replace(
        "|20260815220402|",
        "|20260814213000|",
      ),
      EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS.replace(
        ",20260815220402|",
        "|",
      ),
      EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS.replace(
        "release-db-attestation-v17",
        "release-db-attestation-v18",
      ),
    ]) {
      assert.throws(
        () => classifyStateSnapshot(staffIdentitySnapshot(packet, { operationalReadiness }), packet),
        /V17 operational readiness/,
      );
    }
  });

  it("validates V7-V18 pre, recovery, attested, critical, column-attested, trial-locked, staff-identity, and post-state readiness", () => {
    const packet = candidatePacket();
    const postValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.postHistory],
      ["target_history", packet.postTargetHistory],
      ["object_counts", "3:1"],
      ["function_state", "3:0123456789abcdef0123456789abcdef:0"],
      ["trigger_state", "1:fedcba9876543210fedcba9876543210:0"],
      ["catalog_state", validCatalogState],
      ["critical_surface_manifest", EXPECTED_CRITICAL_SURFACE_MANIFEST],
      ["operational_readiness", EXPECTED_OPERATIONAL_READINESS],
    ]);
    const postHeaders = [];
    const postSql = [];
    const post = readRemoteState(
      repositoryRoot,
      packet,
      {},
      validFingerprint,
      (_root, sql, header) => {
        postHeaders.push(header);
        postSql.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, postValues.get(header)), header);
      },
    );
    assert.deepEqual(post, { state: "post", providerFingerprint: validFingerprint });
    assert.equal(postHeaders.at(-1), "operational_readiness");
    assert.match(postSql.at(-1), /koaryu_release_schema_preflight_v4/);

    const trialLockedValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.trialLockedHistory],
      ["target_history", packet.trialLockedTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS],
    ]);
    const trialLockedSql = [];
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, sql, header) => {
        trialLockedSql.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, trialLockedValues.get(header)), header);
      }),
      { state: "trial-locked", providerFingerprint: null },
    );
    assert.match(trialLockedSql.at(-1), /koaryu_release_schema_preflight_v4/);

    const staffIdentityValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.staffIdentityHistory],
      ["target_history", packet.staffIdentityTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS],
    ]);
    const staffIdentitySql = [];
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, sql, header) => {
        staffIdentitySql.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, staffIdentityValues.get(header)), header);
      }),
      { state: "staff-identity", providerFingerprint: null },
    );
    assert.match(staffIdentitySql.at(-1), /koaryu_release_schema_preflight_v4/);

    const intermediateValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.intermediateHistory],
      ["target_history", packet.intermediateTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS],
    ]);
    const intermediateSql = [];
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, sql, header) => {
        intermediateSql.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, intermediateValues.get(header)), header);
      }),
      { state: "intermediate", providerFingerprint: null },
    );
    assert.match(intermediateSql.at(-1), /koaryu_release_schema_preflight_v2/);

    const recoveryValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.recoveryHistory],
      ["target_history", packet.recoveryTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_RECOVERY_OPERATIONAL_READINESS[0]],
    ]);
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, _sql, header) =>
        parseSingleValueCsv(singleValueCsv(header, recoveryValues.get(header)), header)),
      { state: "recovery", providerFingerprint: null },
    );

    const convergenceValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.convergenceHistory],
      ["target_history", packet.convergenceTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_CONVERGENCE_OPERATIONAL_READINESS],
    ]);
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, _sql, header) =>
        parseSingleValueCsv(singleValueCsv(header, convergenceValues.get(header)), header)),
      { state: "convergence", providerFingerprint: null },
    );

    const attestedValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.attestedHistory],
      ["target_history", packet.attestedTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_ATTESTED_OPERATIONAL_READINESS],
      ["writer_return_contract_state", EXPECTED_WRITER_RETURN_CONTRACT_STATE],
    ]);
    const attestedHeaders = [];
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, _sql, header) => {
        attestedHeaders.push(header);
        return parseSingleValueCsv(singleValueCsv(header, attestedValues.get(header)), header);
      }),
      { state: "attested", providerFingerprint: null },
    );
    assert.equal(attestedHeaders.at(-1), "writer_return_contract_state");

    assert.deepEqual(
      classifyStateSnapshot(criticalSnapshot(packet), packet),
      { state: "critical", providerFingerprint: null },
    );
    assert.throws(
      () => classifyStateSnapshot(
        criticalSnapshot(packet, {
          operationalReadiness: EXPECTED_CRITICAL_OPERATIONAL_READINESS.replace(/^true/, "false"),
        }),
        packet,
      ),
      /V14 operational readiness/,
    );
    assert.deepEqual(
      classifyStateSnapshot(columnAttestedSnapshot(packet), packet),
      { state: "column-attested", providerFingerprint: null },
    );
    assert.throws(
      () => classifyStateSnapshot(
        columnAttestedSnapshot(packet, {
          operationalReadiness: EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS.replace(/^true/, "false"),
        }),
        packet,
      ),
      /V15 operational readiness/,
    );
    assert.deepEqual(
      classifyStateSnapshot(trialLockedSnapshot(packet), packet),
      { state: "trial-locked", providerFingerprint: null },
    );

    const preHeaders = [];
    const preValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", ROLLOUT.preHistory],
      ["target_history", packet.preTargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_PRE_OPERATIONAL_READINESS],
    ]);
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, _sql, header) => {
        preHeaders.push(header);
        return parseSingleValueCsv(singleValueCsv(header, preValues.get(header)), header);
      }),
      { state: "pre", providerFingerprint: null },
    );
    assert.equal(preHeaders.at(-1), "operational_readiness");
  });

  it("returns only UNKNOWN(timeout) for a typed timeout during remote query acquisition", () => {
    const packet = candidatePacket();
    let timeoutError;
    assert.throws(
      () => runCommand(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5_000)"],
        {
          cwd: repositoryRoot,
          env: {},
          label: "remote query timeout fixture",
          timeout: 100,
        },
      ),
      (error) => {
        timeoutError = error;
        return error.message.includes("UNKNOWN(timeout)");
      },
    );

    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, () => {
        throw timeoutError;
      }),
      { state: "unknown", reason: "timeout" },
    );
  });

  it("returns only connectivity for a typed non-timeout runner query failure", () => {
    const packet = candidatePacket();
    let queryError;
    assert.throws(
      () => runCommand(process.execPath, ["-e", "process.exit(7)"], {
        cwd: repositoryRoot,
        env: {},
        label: "remote query connectivity fixture",
      }),
      (error) => {
        queryError = error;
        return !error.message.includes("UNKNOWN(timeout)");
      },
    );

    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, () => {
        throw queryError;
      }),
      { state: "unknown", reason: "connectivity" },
    );
  });

  it("returns diverged for a reachable 82-migration history with the exact refusal detail", () => {
    const packet = candidatePacket();
    const observedHistory = "82:0123456789abcdef0123456789abcdef";
    const values = new Map([
      ["history_columns", JSON.stringify(minimalHistoryColumns)],
      ["history_state", observedHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
    ]);

    const result = readRemoteState(
      repositoryRoot,
      packet,
      {},
      null,
      (_root, _sql, header) => values.get(header),
    );

    assert.deepEqual(result, {
      state: "diverged",
      detail: `Unexpected migration history ${observedHistory}; expected exact pre-, intermediate-, recovery-, convergence-, attested-, return-attested-, retained-, critical-, column-attested-, trial-locked-, staff-identity-, or post-state.`,
    });
  });

  it("diagnoses an extended divergent history schema with ordered read-only metadata", () => {
    const packet = candidatePacket();
    const values = new Map([
      ["history_columns", divergentHistoryColumns],
      ["history_state", ROLLOUT.preHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
      ["migration_row_count", "84"],
      ["migration_newest_version", "20260710123456"],
    ]);
    const calls = [];

    const diagnosis = readRemoteDiagnosis(
      repositoryRoot,
      packet,
      {},
      (_root, sql, header) => {
        calls.push({ sql, header });
        assertReadOnlySql(sql);
        assert.ok(values.has(header), `unexpected diagnosis query header ${header}`);
        return values.get(header);
      },
    );

    const divergenceDetail =
      "Supabase migration history schema rejected: Unrecognised history column foo.";
    assert.deepEqual(diagnosis, {
      state: "diverged",
      detail: divergenceDetail,
      historyColumns: divergentHistoryColumns,
      migrationRowCount: "84",
      migrationNewestVersion: "20260710123456",
    });
    assert.deepEqual(calls.map(({ header }) => header), [
      "history_columns",
      "history_state",
      "target_history",
      "object_counts",
      "migration_row_count",
      "migration_newest_version",
    ]);
    const historyColumnsSql = calls.find(({ header }) => header === "history_columns").sql;
    for (const property of [
      "is_nullable",
      "column_default",
      "is_generated",
      "is_identity",
    ]) {
      assert.match(historyColumnsSql, new RegExp(`'${property}', ${property}`));
    }
    const newestVersionSql = calls.find(
      ({ header }) => header === "migration_newest_version",
    ).sql;
    assert.match(
      newestVersionSql,
      /max\(to_jsonb\(schema_migration\)->>'version'\)/,
    );

    const report = formatDiagnosisReport(
      {
        target: "staging",
        projectRef: ROLLOUT.stagingRef,
        candidateSha,
      },
      diagnosis,
    );
    assert.equal(report, [
      "target=staging",
      `project_ref=${ROLLOUT.stagingRef}`,
      `candidate_sha=${candidateSha}`,
      "remote_content_hashes=absent",
      `history_columns=${divergentHistoryColumns}`,
      "migration_row_count=84",
      "migration_newest_version=20260710123456",
      `state=DIVERGED(${divergenceDetail})`,
    ].join("\n"));
    assert.ok(!report.includes("inspection_token"));
  });

  it("rejects incomplete or noncanonical history-column diagnosis metadata", () => {
    const packet = candidatePacket();
    const baseValues = new Map([
      ["history_state", ROLLOUT.preHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
      ["migration_row_count", "84"],
      ["migration_newest_version", "20260710123456"],
    ]);
    const validColumn = historyColumn("version", "text", "text", {
      is_nullable: "NO",
    });
    const invalidColumns = [
      { ...validColumn, is_nullable: "MAYBE" },
      { ...validColumn, column_default: 1 },
      { ...validColumn, is_generated: "SOMETIMES" },
      { ...validColumn, is_identity: "MAYBE" },
      Object.fromEntries(
        Object.entries(validColumn).filter(([property]) => property !== "column_default"),
      ),
    ];

    for (const column of invalidColumns) {
      const diagnosis = readRemoteDiagnosis(
        repositoryRoot,
        packet,
        {},
        (_root, sql, header) => {
          assertReadOnlySql(sql);
          if (header === "history_columns") {
            return JSON.stringify(
              minimalHistoryColumns.map((candidate) =>
                candidate.column_name === "version" ? column : candidate
              ),
            );
          }
          return baseValues.get(header);
        },
      );
      assert.equal(diagnosis.state, "diverged");
      assert.match(diagnosis.detail, /seven-field shape|definition mismatch/);
    }
  });

  it("diagnoses reachable historical and post states without minting an inspection token", () => {
    const packet = candidatePacket();
    const cases = [
      {
        snapshot: recoverySnapshot(packet),
        expected: { state: "recovery", providerFingerprint: null },
      },
      {
        snapshot: convergenceSnapshot(packet),
        expected: { state: "convergence", providerFingerprint: null },
      },
      {
        snapshot: attestedSnapshot(packet),
        expected: { state: "attested", providerFingerprint: null },
      },
      {
        snapshot: columnAttestedSnapshot(packet),
        expected: { state: "column-attested", providerFingerprint: null },
      },
      {
        snapshot: trialLockedSnapshot(packet),
        expected: { state: "trial-locked", providerFingerprint: null },
      },
      {
        snapshot: staffIdentitySnapshot(packet),
        expected: { state: "staff-identity", providerFingerprint: null },
      },
      {
        snapshot: intermediateSnapshot(packet),
        expected: { state: "intermediate", providerFingerprint: null },
      },
      {
        snapshot: preSnapshot(),
        expected: { state: "pre", providerFingerprint: null },
      },
      {
        snapshot: postSnapshot(packet),
        expected: { state: "post", providerFingerprint: validFingerprint },
      },
    ];

    for (const { snapshot, expected } of cases) {
      const values = new Map([
        ["history_columns", extendedHistoryColumns],
        ["history_state", snapshot.history],
        ["target_history", snapshot.targetHistory],
        ["object_counts", snapshot.objectCounts],
        ["function_state", snapshot.functionState],
        ["trigger_state", snapshot.triggerState],
        ["catalog_state", snapshot.catalogState],
        ["critical_surface_manifest", snapshot.criticalSurfaceManifest],
        ["operational_readiness", snapshot.operationalReadiness],
        ["writer_return_contract_state", snapshot.writerReturnContractState],
        ["migration_row_count", expected.state === "pre" ? "84" : expected.state === "intermediate" ? "101" : expected.state === "recovery" ? "102" : expected.state === "convergence" ? "103" : expected.state === "attested" ? "104" : expected.state === "column-attested" ? "108" : expected.state === "trial-locked" ? String(ROLLOUT.trialLockedMigrationCount) : expected.state === "staff-identity" ? String(ROLLOUT.staffIdentityMigrationCount) : String(ROLLOUT.finalMigrationCount)],
        ["migration_newest_version", expected.state === "pre" ? "20260710123456" : expected.state === "intermediate" ? "20260814043325" : expected.state === "recovery" ? "20260814103046" : expected.state === "convergence" ? "20260814105424" : expected.state === "attested" ? "20260814114500" : expected.state === "column-attested" ? "20260814200000" : expected.state === "trial-locked" ? "20260814213000" : expected.state === "staff-identity" ? "20260815220402" : "20260820012533"],
      ]);
      const headers = [];
      const diagnosis = readRemoteDiagnosis(repositoryRoot, packet, {}, (_root, sql, header) => {
        headers.push(header);
        assertReadOnlySql(sql);
        return values.get(header);
      });

      assert.deepEqual(
        { state: diagnosis.state, providerFingerprint: diagnosis.providerFingerprint },
        expected,
      );
      assert.equal(diagnosis.historyColumns, extendedHistoryColumns);
      assert.deepEqual(headers.slice(-2), [
        "migration_row_count",
        "migration_newest_version",
      ]);
      const report = formatDiagnosisReport(
        { target: "production", projectRef: ROLLOUT.productionRef, candidateSha },
        diagnosis,
      );
      assert.match(report, new RegExp(`state=${expected.state}(?:\\n|$)`));
      assert.ok(!report.includes("inspection_token"));
      if (expected.state === "post") {
        assert.ok(report.endsWith(`provider_fingerprint=${validFingerprint}`));
      }
    }
  });

  it("returns no partial diagnosis metadata for timeout or connectivity query failures", { timeout: 3_000 }, () => {
    const packet = candidatePacket();
    let timeoutError;
    let connectivityError;
    assert.throws(
      () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], {
        cwd: repositoryRoot,
        env: {},
        label: "diagnosis timeout fixture",
        timeout: 100,
      }),
      (error) => {
        timeoutError = error;
        return error.message.includes("UNKNOWN(timeout)");
      },
    );
    assert.throws(
      () => runCommand(process.execPath, ["-e", "process.exit(7)"], {
        cwd: repositoryRoot,
        env: {},
        label: "diagnosis connectivity fixture",
      }),
      (error) => {
        connectivityError = error;
        return !error.message.includes("UNKNOWN(timeout)");
      },
    );

    for (const [reason, queryError] of [
      ["timeout", timeoutError],
      ["connectivity", connectivityError],
    ]) {
      const classificationSql = [];
      const classificationFailure = readRemoteDiagnosis(
        repositoryRoot,
        packet,
        {},
        (_root, sql) => {
          classificationSql.push(sql);
          assertReadOnlySql(sql);
          throw queryError;
        },
      );
      assert.deepEqual(classificationFailure, { state: "unknown", reason });

      const preValues = new Map([
        ["history_columns", extendedHistoryColumns],
        ["history_state", ROLLOUT.preHistory],
        ["target_history", ""],
        ["object_counts", "0:0"],
        ["migration_row_count", "84"],
      ]);
      const metadataHeaders = [];
      const failureHeader = reason === "timeout" ? "history_columns" : "migration_newest_version";
      const metadataFailure = readRemoteDiagnosis(
        repositoryRoot,
        packet,
        {},
        (_root, sql, header) => {
          metadataHeaders.push(header);
          assertReadOnlySql(sql);
          if (header === failureHeader) throw queryError;
          return preValues.get(header);
        },
      );
      assert.deepEqual(metadataFailure, { state: "unknown", reason });
      for (const field of [
        "historyColumns",
        "migrationRowCount",
        "migrationNewestVersion",
      ]) {
        assert.ok(!Object.hasOwn(metadataFailure, field));
      }
      const report = formatDiagnosisReport(
        { target: "staging", projectRef: ROLLOUT.stagingRef, candidateSha },
        metadataFailure,
      );
      assert.equal(report, [
        "target=staging",
        `project_ref=${ROLLOUT.stagingRef}`,
        `candidate_sha=${candidateSha}`,
        "remote_content_hashes=absent",
        `state=UNKNOWN(${reason})`,
      ].join("\n"));
      assert.doesNotMatch(report, /history_columns|migration_row_count|migration_newest_version/);
      assert.ok(classificationSql.length > 0);
      assert.ok(metadataHeaders.includes(failureHeader));
    }
  });

  it("rethrows unrelated diagnosis query implementation errors", () => {
    const packet = candidatePacket();
    const queryError = new Error("unexpected diagnosis query implementation failure");
    const preValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", ROLLOUT.preHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
    ]);

    assert.throws(
      () => readRemoteDiagnosis(repositoryRoot, packet, {}, () => {
        throw queryError;
      }),
      (error) => error === queryError,
    );
    assert.throws(
      () => readRemoteDiagnosis(repositoryRoot, packet, {}, (_root, _sql, header) => {
        if (header === "history_columns") throw queryError;
        return preValues.get(header);
      }),
      (error) => error === queryError,
    );
  });

  it("returns from main diagnosis before token, dry-run, or apply behavior", async () => {
    const commands = [];
    const output = [];
    let linkedRefAsserted = false;
    const packet = { ...candidatePacket(), integrationComplete: false };
    const divergenceDetail =
      "Supabase migration history schema rejected: Unrecognised history column foo.";
    const diagnosis = {
      state: "diverged",
      detail: divergenceDetail,
      historyColumns: divergentHistoryColumns,
      migrationRowCount: "84",
      migrationNewestVersion: "20260710123456",
    };

    await main(
      ["--mode", "diagnose", "--target", "staging", "--candidate-sha", candidateSha],
      {},
      {
        commandRunner(command, args) {
          commands.push([command, ...args]);
          if (command === "supabase" && args[0] === "--version") return `${ROLLOUT.cliVersion}\n`;
          if (command === "git" && args[0] === "worktree") return "";
          if (command === "supabase" && args[0] === "link") return "";
          throw new Error(`unexpected command ${command} ${args.join(" ")}`);
        },
        sourceVerifier(_sourceRoot, actualCandidateSha) {
          assert.equal(actualCandidateSha, candidateSha);
          return packet;
        },
        linkedRefAsserter(_sourceRoot, projectRef) {
          linkedRefAsserted = true;
          assert.equal(projectRef, ROLLOUT.stagingRef);
        },
        diagnosisReader(_sourceRoot, actualPacket, env) {
          assert.equal(actualPacket, packet);
          assert.deepEqual(env, {});
          return diagnosis;
        },
        output(line) {
          output.push(line);
        },
      },
    );

    assert.equal(linkedRefAsserted, true);
    assert.deepEqual(commands.map((parts) => parts.slice(0, 2)), [
      ["supabase", "--version"],
      ["git", "worktree"],
      ["supabase", "link"],
    ]);
    assert.ok(commands.every((parts) => !parts.includes("push")));
    const report = output.join("\n");
    assert.ok(report.endsWith(`state=DIVERGED(${divergenceDetail})`));
    assert.ok(!report.includes("inspection_token"));
    assert.ok(!report.includes("dry_run_migrations"));
  });

  it("prints only UNKNOWN identity state and rejects main diagnosis on query failure", async () => {
    const output = [];
    const packet = { ...candidatePacket(), integrationComplete: false };
    await assert.rejects(
      main(
        ["--mode", "diagnose", "--target", "production", "--candidate-sha", candidateSha],
        {},
        {
          commandRunner(command, args) {
            if (command === "supabase" && args[0] === "--version") return `${ROLLOUT.cliVersion}\n`;
            if (command === "git" && args[0] === "worktree") return "";
            if (command === "supabase" && args[0] === "link") return "";
            throw new Error(`unexpected command ${command} ${args.join(" ")}`);
          },
          sourceVerifier() {
            return packet;
          },
          linkedRefAsserter() {},
          diagnosisReader() {
            return { state: "unknown", reason: "connectivity" };
          },
          output(line) {
            output.push(line);
          },
        },
      ),
      /Diagnosis refused: state=UNKNOWN\(connectivity\)\./,
    );
    const report = output.join("\n");
    assert.ok(report.endsWith("state=UNKNOWN(connectivity)"));
    assert.doesNotMatch(report, /inspection_token|history_schema_|history_columns|migration_row_/);
  });

  it("formats each structured non-success probe result without success or token fields", () => {
    const divergedDetail =
      "Unexpected migration history 82:0123456789abcdef0123456789abcdef; expected exact pre-state or post-state.";
    const cases = [
      [{ state: "unknown", reason: "timeout" }, "state=UNKNOWN(timeout)"],
      [{ state: "unknown", reason: "connectivity" }, "state=UNKNOWN(connectivity)"],
      [{ state: "diverged", detail: divergedDetail }, `state=DIVERGED(${divergedDetail})`],
    ];

    for (const [result, expectedLine] of cases) {
      const report = formatNonSuccessProbeState(result);
      assert.equal(report, expectedLine);
      assert.ok(!report.includes("inspection_token"));
      assert.ok(!/state=(?:pre|post)/.test(report));
    }
    assert.equal(formatNonSuccessProbeState({ state: "pre", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "intermediate", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "recovery", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "convergence", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "attested", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "column-attested", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "trial-locked", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "staff-identity", providerFingerprint: null }), null);
    assert.equal(
      formatNonSuccessProbeState({ state: "post", providerFingerprint: validFingerprint }),
      null,
    );
  });

  it("makes an inspection token available only for accepted probe states", () => {
    const packet = candidatePacket();
    for (const state of ["pre", "intermediate", "recovery", "convergence", "attested", "return-attested", "retained", "critical", "column-attested", "trial-locked", "staff-identity", "post"]) {
      assert.equal(
        buildInspectionTokenForAcceptedState(packet, "staging", { state }),
        buildInspectionToken(packet, "staging", state),
      );
    }
    for (const result of [
      { state: "unknown", reason: "timeout" },
      { state: "unknown", reason: "connectivity" },
      { state: "diverged", detail: "Unexpected migration history 82:0123456789abcdef0123456789abcdef." },
    ]) {
      assert.throws(
        () => buildInspectionTokenForAcceptedState(packet, "staging", result),
        /accepted pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, staff-identity, or post probe state/,
      );
    }
  });

  it("surfaces an unrelated query implementation error instead of laundering it", () => {
    const packet = candidatePacket();
    const queryError = new Error("unexpected query implementation failure");

    assert.throws(
      () => readRemoteState(repositoryRoot, packet, {}, null, () => {
        throw queryError;
      }),
      (error) => error === queryError,
    );
  });

  it("refuses to certify post-state before the exact 112-migration integration", () => {
    const packet = { ...candidatePacket(), integrationComplete: false };
    assert.equal(packet.integrationComplete, false);
    assert.throws(
      () => classifyStateSnapshot(postSnapshot(packet), packet),
      /exact final 112-migration sequence/,
    );
  });

  it("selects exact remaining migrations through staff-identity state", () => {
    const packet = candidatePacket();
    const intermediateRemaining = packetForAcceptedState(packet, "intermediate");
    assert.deepEqual(intermediateRemaining.pendingMigrations, packet.pendingMigrations.slice(1));
    assert.deepEqual(intermediateRemaining.pendingManifest, packet.pendingManifest.slice(1));
    const recoveryRemaining = packetForAcceptedState(packet, "recovery");
    assert.deepEqual(recoveryRemaining.pendingMigrations, packet.pendingMigrations.slice(2));
    assert.deepEqual(recoveryRemaining.pendingManifest, packet.pendingManifest.slice(2));
    assert.match(recoveryRemaining.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(recoveryRemaining.sourceManifestSha256, packet.sourceManifestSha256);
    const convergenceRemaining = packetForAcceptedState(packet, "convergence");
    assert.deepEqual(convergenceRemaining.pendingMigrations, packet.pendingMigrations.slice(3));
    assert.deepEqual(convergenceRemaining.pendingManifest, packet.pendingManifest.slice(3));
    const attestedRemaining = packetForAcceptedState(packet, "attested");
    assert.deepEqual(attestedRemaining.pendingMigrations, packet.pendingMigrations.slice(4));
    assert.deepEqual(attestedRemaining.pendingManifest, packet.pendingManifest.slice(4));
    const returnAttestedRemaining = packetForAcceptedState(packet, "return-attested");
    assert.deepEqual(returnAttestedRemaining.pendingMigrations, packet.pendingMigrations.slice(5));
    const retainedRemaining = packetForAcceptedState(packet, "retained");
    assert.deepEqual(retainedRemaining.pendingMigrations, packet.pendingMigrations.slice(6));
    const criticalRemaining = packetForAcceptedState(packet, "critical");
    assert.deepEqual(criticalRemaining.pendingMigrations, packet.pendingMigrations.slice(7));
    const columnAttestedRemaining = packetForAcceptedState(packet, "column-attested");
    assert.deepEqual(columnAttestedRemaining.pendingMigrations, packet.pendingMigrations.slice(8));
    const trialLockedRemaining = packetForAcceptedState(packet, "trial-locked");
    assert.deepEqual(
      trialLockedRemaining.pendingMigrations,
      [
        "20260815220402_staff_identity_name_model.sql",
        "20260816012723_archive_staff_access_and_readiness.sql",
        "20260820012533_dashboard_fact_rpc.sql",
      ],
    );
    assert.deepEqual(
      trialLockedRemaining.pendingManifest,
      packet.pendingManifest.slice(ROLLOUT.trialLockedMigrationCount - ROLLOUT.baselineMigrationCount),
    );
    const staffIdentityRemaining = packetForAcceptedState(packet, "staff-identity");
    assert.deepEqual(
      staffIdentityRemaining.pendingMigrations,
      [
        "20260816012723_archive_staff_access_and_readiness.sql",
        "20260820012533_dashboard_fact_rpc.sql",
      ],
    );
    assert.deepEqual(
      staffIdentityRemaining.pendingManifest,
      packet.pendingManifest.slice(ROLLOUT.staffIdentityMigrationCount - ROLLOUT.baselineMigrationCount),
    );
    assert.match(staffIdentityRemaining.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(staffIdentityRemaining.sourceManifestSha256, trialLockedRemaining.sourceManifestSha256);
    assert.equal(packetForAcceptedState(packet, "pre"), packet);
    assert.throws(
      () => packetForAcceptedState(packet, "post"),
        /pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, or staff-identity state/,
    );
  });

  it("keeps historical non-attested states inspectable but refuses to apply from them", () => {
    for (const state of ["intermediate", "recovery", "convergence"]) {
      assert.doesNotThrow(() => assertApplyableState("dry-run", state));
      assert.throws(
        () => assertApplyableState("apply", state),
        new RegExp(`Apply is disabled from ${state} state`),
      );
    }
    for (const state of ["pre", "attested", "return-attested", "retained", "critical", "column-attested", "trial-locked", "staff-identity"]) {
      assert.doesNotThrow(() => assertApplyableState("apply", state));
    }
  });

  it("requires a preceding same-candidate, same-target, same-state inspection", () => {
    const packet = candidatePacket();
    const stagingToken = buildInspectionToken(packet, "staging", "pre");
    assert.match(stagingToken, /^[0-9a-f]{64}$/);
    assert.notEqual(stagingToken, buildInspectionToken(packet, "production", "pre"));
    const staffIdentityResult = { state: "staff-identity", providerFingerprint: null };
    const staffIdentityToken = buildInspectionTokenForAcceptedState(
      packet,
      "staging",
      staffIdentityResult,
    );
    assert.doesNotThrow(() =>
      assertInspectionToken(packet, "staging", staffIdentityResult, staffIdentityToken));
    for (const substitutedToken of [
      buildInspectionToken(packet, "staging", "trial-locked"),
      buildInspectionToken(packet, "production", "staff-identity"),
      buildInspectionToken(
        { ...packet, sourceManifestSha256: "0".repeat(64) },
        "staging",
        "staff-identity",
      ),
    ]) {
      assert.throws(
        () => assertInspectionToken(packet, "staging", staffIdentityResult, substitutedToken),
        /candidate, target, and state/,
      );
    }
    assert.throws(
      () => parseArguments([
        "--mode", "packet", "--candidate-sha", candidateSha,
        "--inspection-token", stagingToken,
      ]),
      /cannot be supplied to inspect/,
    );
    assert.throws(
      () => parseArguments([
        "--mode", "inspect", "--target", "staging", "--candidate-sha", candidateSha,
        "--inspection-token", stagingToken,
      ]),
      /cannot be supplied to inspect/,
    );
    assert.throws(
      () => parseArguments([
        "--target", "staging", "--candidate-sha", candidateSha, "--mode", "dry-run",
      ]),
      /Target inspection evidence/,
    );
    assert.throws(
      () => parseArguments([
        "--target", "staging", "--candidate-sha", candidateSha, "--mode", "apply",
      ]),
      /Target inspection evidence/,
    );
  });

  it("requires the dry-run to report exactly the packet migration set in order", () => {
    const packet = candidatePacket();
    const exact = ["Would push these migrations:", ...packet.pendingMigrations].join("\n");
    assert.deepEqual(extractPendingMigrations(exact), packet.pendingMigrations);
    assert.throws(
      () => assertExactPendingMigrations(`${exact}\n${packet.pendingMigrations.at(-1)}`, packet),
      /Dry-run migration set mismatch/,
    );
    assert.throws(
      () => assertExactPendingMigrations(`${exact}\n20260728120000_unapproved.sql`, packet),
      /Dry-run migration set mismatch/,
    );

    const staffIdentityPacket = packetForAcceptedState(packet, "staff-identity");
    const exactStaffIdentity = [
      "Would push these migrations:",
      "20260816012723_archive_staff_access_and_readiness.sql",
      "20260820012533_dashboard_fact_rpc.sql",
    ].join("\n");
    assert.deepEqual(
      assertExactPendingMigrations(exactStaffIdentity, staffIdentityPacket),
      staffIdentityPacket.pendingMigrations,
    );
    for (const substitutedPendingSet of [
      `${exactStaffIdentity}\n20260815220402_staff_identity_name_model.sql`,
      "Would push these migrations:\n20260815220402_staff_identity_name_model.sql",
    ]) {
      assert.throws(
        () => assertExactPendingMigrations(substitutedPendingSet, staffIdentityPacket),
        /Dry-run migration set mismatch/,
      );
    }
  });

  it("dry-runs exactly the remaining migrations from staff-identity using the pinned CLI output", (t) => {
    const packet = packetForAcceptedState(candidatePacket(), "staff-identity");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-dry-run-cli-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const fakeSupabase = path.join(fakeBin, "supabase");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      fakeSupabase,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify("Dry run completed without applying migrations.\n")});`,
        `process.stderr.write(${JSON.stringify(
          ["Would push these migrations:", ...packet.pendingMigrations].join("\n") + "\n",
        )});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

    const pending = runDryRun(repositoryRoot, packet, {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.deepEqual(pending, packet.pendingMigrations);
  });

  it("gates staging apply on exact project, inspection, and durable approval", () => {
    const packet = candidatePacket();
    const config = parseArguments([
      "--target", "staging", "--candidate-sha", candidateSha, "--mode", "apply",
      "--inspection-token", buildInspectionToken(packet, "staging", "pre"),
      "--confirm-project", ROLLOUT.stagingRef,
      "--approval-record", "director-phase-b-approval", "--approve-staging-apply",
    ]);
    assert.doesNotThrow(() => validateApplyAuthorization(config));
    assert.throws(
      () => validateApplyAuthorization({ ...config, confirmProject: ROLLOUT.productionRef }),
      /pinned staging ref/,
    );
    assert.throws(
      () => validateApplyAuthorization({ ...config, expectedProviderFingerprint: validFingerprint }),
      /production-only authorization fields/,
    );
  });

  it("reserves production apply for a human with staging and restore evidence", () => {
    const packet = candidatePacket();
    const config = parseArguments([
      "--target", "production", "--candidate-sha", candidateSha, "--mode", "apply",
      "--inspection-token", buildInspectionToken(packet, "production", "pre"),
      "--confirm-project", ROLLOUT.productionRef,
      "--approval-record", "https://github.com/ronchak/Koaryu/issues/launch-approval",
      "--human-production-operator", "--expected-provider-fingerprint", validFingerprint,
      "--confirmed-restore-window", "2026-07-31T18:00:00Z/PITR-confirmed",
      "--restore-decision-authority", "Ronak Chakraborty",
    ]);
    assert.doesNotThrow(() => validateApplyAuthorization(config));
    assert.throws(
      () => validateApplyAuthorization({ ...config, humanProductionOperator: false }),
      /human-production-operator/,
    );
    assert.throws(
      () => validateApplyAuthorization({ ...config, confirmedRestoreWindow: null }),
      /confirmed-restore-window is required/,
    );
    assert.throws(
      () => validateApplyAuthorization({ ...config, restoreDecisionAuthority: null }),
      /restore-decision-authority is required/,
    );
  });

  it("binds production confirmation to a dynamic candidate migration manifest", () => {
    const packet = candidatePacket();
    const expandedPacket = {
      ...packet,
      pendingMigrations: [...packet.pendingMigrations, "20260801100000_later_owner_migration.sql"],
      sourceManifestSha256: "a".repeat(64),
    };
    const phrase = buildProductionConfirmationPhrase(expandedPacket);
    assert.match(
      phrase,
      new RegExp(`APPLY ${expandedPacket.pendingMigrations.length} MIGRATIONS FROM`),
    );
    assert.match(phrase, new RegExp(candidateSha));
    assert.match(phrase, /MANIFEST a{64}/);
    assert.match(phrase, new RegExp(`${ROLLOUT.productionRef}$`));
  });

  it("binds staff-identity production confirmation to the remaining migrations and its manifest", () => {
    const packet = candidatePacket();
    const staffIdentityPacket = packetForAcceptedState(packet, "staff-identity");
    assert.deepEqual(
      staffIdentityPacket.pendingMigrations,
      [
        "20260816012723_archive_staff_access_and_readiness.sql",
        "20260820012533_dashboard_fact_rpc.sql",
      ],
    );
    assert.notEqual(staffIdentityPacket.sourceManifestSha256, packet.sourceManifestSha256);
    assert.equal(
      buildProductionConfirmationPhrase(staffIdentityPacket),
      [
        "APPLY 2 MIGRATIONS FROM",
        candidateSha,
        "MANIFEST",
        staffIdentityPacket.sourceManifestSha256,
        "TO",
        ROLLOUT.productionRef,
      ].join(" "),
    );
  });
});
