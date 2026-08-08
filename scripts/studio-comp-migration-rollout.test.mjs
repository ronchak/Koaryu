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
  EXPECTED_HISTORY_SCHEMA,
  TOLERATED_HISTORY_COLUMNS,
  EXPECTED_OPERATIONAL_MANIFEST,
  EXPECTED_OPERATIONAL_READINESS,
  assertExactPendingMigrations,
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
  readRemoteState,
  readRemoteDiagnosis,
  runCommand,
  runDryRun,
  validateApplyAuthorization,
  validateOperationalManifest,
  validateOperationalReadiness,
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
  `catalog=${validCatalogState}`;
const extendedHistoryColumns = JSON.stringify([
  { column_name: "version", data_type: "text", udt_name: "text" },
  { column_name: "name", data_type: "text", udt_name: "text" },
  { column_name: "statements", data_type: "ARRAY", udt_name: "_text" },
  { column_name: "created_by", data_type: "text", udt_name: "text" },
  { column_name: "idempotency_key", data_type: "text", udt_name: "text" },
]);

function candidatePacket() {
  return verifySourceTree(repositoryRoot, candidateSha);
}

function singleValueCsv(header, value, recordEnding = "\n") {
  const encoded = /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${header}${recordEnding}${encoded}${recordEnding}`;
}

function preSnapshot(overrides = {}) {
  return {
    historySchema: "0:1:1:1:0",
    history: ROLLOUT.preHistory,
    targetHistory: "",
    objectCounts: "0:0",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: null,
    ...overrides,
  };
}

function postSnapshot(packet, overrides = {}) {
  return {
    historySchema: "0:1:1:1:0",
    history: packet.postHistory,
    targetHistory: packet.postTargetHistory,
    objectCounts: "3:1",
    functionState: "3:0123456789abcdef0123456789abcdef:0",
    triggerState: "1:fedcba9876543210fedcba9876543210:0",
    catalogState: validCatalogState,
    operationalReadiness: EXPECTED_OPERATIONAL_READINESS,
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

  it("requires the exact V7 operational readiness output", () => {
    assert.equal(
      validateOperationalReadiness(EXPECTED_OPERATIONAL_READINESS),
      EXPECTED_OPERATIONAL_READINESS,
    );
    for (const value of [null, "", "true|100|20260801131844", `${EXPECTED_OPERATIONAL_READINESS}|extra`]) {
      assert.throws(() => validateOperationalReadiness(value), /V7 operational readiness/);
    }
  });

  it("decodes the pinned CLI single-field CSV contract before exact V7 validation", () => {
    const quotedReadiness = singleValueCsv(
      "operational_readiness",
      EXPECTED_OPERATIONAL_READINESS,
    );
    assert.match(quotedReadiness, /^operational_readiness\n"true\|100\|/);
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

  it("derives an exact 84-to-N packet from immutable ancestry and source hashes", () => {
    const packet = candidatePacket();
    assert.equal(packet.candidateSha, candidateSha);
    assert.equal(packet.migrationCount, 100);
    assert.match(packet.postHistory, new RegExp(`^${packet.migrationCount}:[0-9a-f]{32}$`));
    assert.equal(packet.pendingMigrations.length, packet.migrationCount - 84);
    assert.deepEqual(
      packet.pendingMigrations.slice(0, 2),
      ROLLOUT.migrations.map(({ filename }) => filename),
    );
    assert.match(packet.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(packet.integrationComplete, true);
    assert.deepEqual(
      packet.pendingMigrations.map((filename) => filename.slice(0, 14)),
      ROLLOUT.finalPendingVersions,
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

  it("does not treat migration history as content identity", () => {
    const packet = candidatePacket();
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historySchema: "1:1" }), packet),
      /no-hash\/statement-array shape/,
    );
    assert.equal(preSnapshot().historySchema, "0:1:1:1:0");
  });

  it("tolerates Supabase CLI bookkeeping columns without widening the guard", () => {
    const packet = candidatePacket();
    const source = fs.readFileSync(
      path.join(repositoryRoot, "scripts", "studio-comp-migration-rollout.mjs"),
      "utf8",
    );

    // The tolerated names must be excluded from the unrecognised-column counter,
    // so a target carrying them still reports the exact expected shape.
    assert.deepEqual(TOLERATED_HISTORY_COLUMNS, [
      "created_by",
      "idempotency_key",
      "rollback",
    ]);
    for (const column of TOLERATED_HISTORY_COLUMNS) {
      assert.ok(
        source.includes(`'${column}'`),
        `${column} must be excluded by name in HISTORY_SCHEMA_SQL`,
      );
    }

    // Observed staging shape once the tolerated columns stop being counted.
    assert.deepEqual(classifyStateSnapshot(preSnapshot(), packet), {
      state: "pre",
      providerFingerprint: null,
    });

    // An unrecognised extra column is still a refusal.
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historySchema: "0:1:1:1:1" }), packet),
      /no-hash\/statement-array shape/,
    );

    // A hash/checksum/digest column is still a refusal.
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historySchema: "1:1:1:1:0" }), packet),
      /no-hash\/statement-array shape/,
    );

    // A missing `_text` statements array is still a refusal.
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historySchema: "0:0:1:1:0" }), packet),
      /no-hash\/statement-array shape/,
    );
  });

  it("accepts only exact pre-state or semantically valid exact post-state", () => {
    const packet = candidatePacket();
    assert.deepEqual(classifyStateSnapshot(preSnapshot(), packet), {
      state: "pre",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(postSnapshot(packet), packet, validFingerprint), {
      state: "post",
      providerFingerprint: validFingerprint,
    });
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ objectCounts: "1:0" }), packet),
      /objects already exist/,
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
          catalogState: validCatalogState.replace("indexes=11", "indexes=10"),
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
      () => classifyStateSnapshot(preSnapshot({ history: "85:unexpected" }), packet),
      /Unexpected migration history/,
    );
  });

  it("rejects missing, malformed, or non-ready V7 output before post certification", () => {
    const packet = candidatePacket();
    for (const operationalReadiness of [
      null,
      "",
      EXPECTED_OPERATIONAL_READINESS.replace(/^true/, "false"),
      EXPECTED_OPERATIONAL_READINESS.replace("|100|", "|99|"),
      EXPECTED_OPERATIONAL_READINESS.replace("20260801131844", "20260801123112"),
      EXPECTED_OPERATIONAL_READINESS.replace("20260801105313,", ""),
      EXPECTED_OPERATIONAL_READINESS.replace("|0||", "|1|table_acl|"),
      EXPECTED_OPERATIONAL_READINESS.replace("release-db-attestation-v7", "release-db-attestation-v6"),
    ]) {
      assert.throws(
        () => classifyStateSnapshot(postSnapshot(packet, { operationalReadiness }), packet),
        /V7 operational readiness/,
      );
    }
  });

  it("invokes V7 for apparent post-state but not for the migration-84 pre-state", () => {
    const packet = candidatePacket();
    const postValues = new Map([
      ["history_schema", "0:1:1:1:0"],
      ["history_state", packet.postHistory],
      ["target_history", packet.postTargetHistory],
      ["object_counts", "3:1"],
      ["function_state", "3:0123456789abcdef0123456789abcdef:0"],
      ["trigger_state", "1:fedcba9876543210fedcba9876543210:0"],
      ["catalog_state", validCatalogState],
      ["operational_readiness", EXPECTED_OPERATIONAL_READINESS],
    ]);
    const postHeaders = [];
    const post = readRemoteState(
      repositoryRoot,
      packet,
      {},
      validFingerprint,
      (_root, _sql, header) => {
        postHeaders.push(header);
        return parseSingleValueCsv(singleValueCsv(header, postValues.get(header)), header);
      },
    );
    assert.deepEqual(post, { state: "post", providerFingerprint: validFingerprint });
    assert.equal(postHeaders.at(-1), "operational_readiness");

    const preHeaders = [];
    const preValues = new Map([
      ["history_schema", "0:1:1:1:0"],
      ["history_state", ROLLOUT.preHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
    ]);
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, _sql, header) => {
        preHeaders.push(header);
        return parseSingleValueCsv(singleValueCsv(header, preValues.get(header)), header);
      }),
      { state: "pre", providerFingerprint: null },
    );
    assert.ok(!preHeaders.includes("operational_readiness"));
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
      ["history_schema", "0:1:1:1:0"],
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
      detail: `Unexpected migration history ${observedHistory}; expected exact pre-state or post-state.`,
    });
  });

  it("diagnoses an extended divergent history schema with ordered read-only metadata", () => {
    const packet = candidatePacket();
    const values = new Map([
      ["history_schema", "0:1:1:1:2"],
      ["history_state", ROLLOUT.preHistory],
      ["target_history", ""],
      ["object_counts", "0:0"],
      ["history_columns", extendedHistoryColumns],
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
      "Supabase migration history did not have the expected no-hash/statement-array shape.";
    assert.deepEqual(diagnosis, {
      state: "diverged",
      detail: divergenceDetail,
      historySchemaActual: "0:1:1:1:2",
      historyColumns: extendedHistoryColumns,
      migrationRowCount: "84",
      migrationNewestVersion: "20260710123456",
    });
    assert.deepEqual(calls.map(({ header }) => header), [
      "history_schema",
      "history_state",
      "target_history",
      "object_counts",
      "history_columns",
      "migration_row_count",
      "migration_newest_version",
    ]);
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
      "history_schema_actual=0:1:1:1:2",
      `history_schema_expected=${EXPECTED_HISTORY_SCHEMA}`,
      `history_columns=${extendedHistoryColumns}`,
      "migration_row_count=84",
      "migration_newest_version=20260710123456",
      `state=DIVERGED(${divergenceDetail})`,
    ].join("\n"));
    assert.ok(!report.includes("inspection_token"));
  });

  it("diagnoses reachable pre and post states without minting an inspection token", () => {
    const packet = candidatePacket();
    const cases = [
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
        ["history_schema", snapshot.historySchema],
        ["history_state", snapshot.history],
        ["target_history", snapshot.targetHistory],
        ["object_counts", snapshot.objectCounts],
        ["function_state", snapshot.functionState],
        ["trigger_state", snapshot.triggerState],
        ["catalog_state", snapshot.catalogState],
        ["operational_readiness", snapshot.operationalReadiness],
        ["history_columns", extendedHistoryColumns],
        ["migration_row_count", expected.state === "pre" ? "84" : "100"],
        ["migration_newest_version", expected.state === "pre" ? "20260710123456" : "20260801131844"],
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
      assert.equal(diagnosis.historySchemaActual, EXPECTED_HISTORY_SCHEMA);
      assert.deepEqual(headers.slice(-3), [
        "history_columns",
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
        ["history_schema", EXPECTED_HISTORY_SCHEMA],
        ["history_state", ROLLOUT.preHistory],
        ["target_history", ""],
        ["object_counts", "0:0"],
        ["history_columns", extendedHistoryColumns],
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
        "historySchemaActual",
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
      assert.doesNotMatch(report, /history_schema_|history_columns|migration_row_count|migration_newest_version/);
      assert.ok(classificationSql.length > 0);
      assert.ok(metadataHeaders.includes(failureHeader));
    }
  });

  it("rethrows unrelated diagnosis query implementation errors", () => {
    const packet = candidatePacket();
    const queryError = new Error("unexpected diagnosis query implementation failure");
    const preValues = new Map([
      ["history_schema", EXPECTED_HISTORY_SCHEMA],
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
      "Supabase migration history did not have the expected no-hash/statement-array shape.";
    const diagnosis = {
      state: "diverged",
      detail: divergenceDetail,
      historySchemaActual: "0:1:1:1:2",
      historyColumns: extendedHistoryColumns,
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
    assert.equal(
      formatNonSuccessProbeState({ state: "post", providerFingerprint: validFingerprint }),
      null,
    );
  });

  it("makes an inspection token available only for accepted probe states", () => {
    const packet = candidatePacket();
    for (const state of ["pre", "post"]) {
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
        /accepted pre or post probe state/,
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

  it("refuses to certify post-state before the exact 100-migration integration", () => {
    const packet = { ...candidatePacket(), integrationComplete: false };
    assert.equal(packet.integrationComplete, false);
    assert.throws(
      () => classifyStateSnapshot(postSnapshot(packet), packet),
      /exact final 100-migration sequence/,
    );
  });

  it("requires a preceding same-candidate, same-target, same-state inspection", () => {
    const packet = candidatePacket();
    const stagingToken = buildInspectionToken(packet, "staging", "pre");
    assert.match(stagingToken, /^[0-9a-f]{64}$/);
    assert.notEqual(stagingToken, buildInspectionToken(packet, "production", "pre"));
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
  });

  it("parses the pinned CLI dry-run migration list from stderr", (t) => {
    const packet = candidatePacket();
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
});
