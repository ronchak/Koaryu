import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  ROLLOUT,
  EXPECTED_CATALOG_STATE,
  EXPECTED_OPERATIONAL_MANIFEST,
  EXPECTED_OPERATIONAL_READINESS,
  assertExactPendingMigrations,
  assertSafeCredentialedTransport,
  buildInspectionToken,
  buildProductionConfirmationPhrase,
  classifyStateSnapshot,
  extractPendingMigrations,
  parseSingleValueCsv,
  parseArguments,
  readRemoteState,
  runCommand,
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
        "--target", "staging", "--candidate-sha", candidateSha, "--mode", "dry-run",
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
