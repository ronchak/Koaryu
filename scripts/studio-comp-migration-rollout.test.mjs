import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  ROLLOUT,
  assertExactPendingMigrations,
  assertSafeCredentialedTransport,
  buildInspectionToken,
  buildProductionConfirmationPhrase,
  classifyStateSnapshot,
  extractPendingMigrations,
  parseArguments,
  validateApplyAuthorization,
  verifySourceTree,
} from "./studio-comp-migration-rollout.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const validCatalogState =
  "columns=1:11111111111111111111111111111111:0;" +
  "functions=19:22222222222222222222222222222222:0;" +
  "indexes=8:33333333333333333333333333333333:0;" +
  "policies=12:44444444444444444444444444444444:0;" +
  "sequences=2:55555555555555555555555555555555:0;" +
  "tables=10:66666666666666666666666666666666:0;" +
  "triggers=9:77777777777777777777777777777777:0";
const validFingerprint =
  "functions=3:0123456789abcdef0123456789abcdef:0;" +
  "trigger=1:fedcba9876543210fedcba9876543210:0;" +
  `catalog=${validCatalogState}`;

function candidatePacket() {
  return verifySourceTree(repositoryRoot, candidateSha);
}

function preSnapshot(overrides = {}) {
  return {
    historySchema: "0:1:1:1:0",
    history: ROLLOUT.preHistory,
    targetHistory: "",
    objectCounts: "0:0",
    functionState: null,
    triggerState: null,
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
    ...overrides,
  };
}

function integratedPacket() {
  return { ...candidatePacket(), integrationComplete: true };
}

describe("studio-comp migration rollout guard", () => {
  it("derives an exact 84-to-N packet from immutable ancestry and source hashes", () => {
    const packet = candidatePacket();
    assert.equal(packet.candidateSha, candidateSha);
    assert.ok(packet.migrationCount >= 86);
    assert.match(packet.postHistory, new RegExp(`^${packet.migrationCount}:[0-9a-f]{32}$`));
    assert.equal(packet.pendingMigrations.length, packet.migrationCount - 84);
    assert.deepEqual(
      packet.pendingMigrations.slice(0, 2),
      ROLLOUT.migrations.map(({ filename }) => filename),
    );
    assert.match(packet.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(packet.integrationComplete, false);
    assert.deepEqual(
      packet.pendingMigrations.map((filename) => filename.slice(0, 14)),
      ROLLOUT.finalPendingVersions.filter(
        (version) => !new Set(["20260801070000", "20260801080000"]).has(version),
      ),
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

  it("does not treat migration history as content identity", () => {
    const packet = candidatePacket();
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ historySchema: "1:1" }), packet),
      /no-hash\/statement-array shape/,
    );
    assert.equal(preSnapshot().historySchema, "0:1:1:1:0");
  });

  it("accepts only exact pre-state or semantically valid exact post-state", () => {
    const packet = integratedPacket();
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
          catalogState: validCatalogState.replace("indexes=8", "indexes=7"),
        }),
        packet,
      ),
      /Required table, RLS, grant, function, trigger, index, sequence, or column checks failed/,
    );
    assert.throws(
      () => classifyStateSnapshot(preSnapshot({ history: "85:unexpected" }), packet),
      /Unexpected migration history/,
    );
  });

  it("refuses to certify post-state before the exact 91-migration integration", () => {
    const packet = candidatePacket();
    assert.equal(packet.integrationComplete, false);
    assert.throws(
      () => classifyStateSnapshot(postSnapshot(packet), packet),
      /exact final 91-migration sequence/,
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
      pendingMigrations: [...packet.pendingMigrations, "20260801090000_later_owner_migration.sql"],
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
