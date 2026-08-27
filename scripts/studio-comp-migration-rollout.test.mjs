import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  ROLLOUT,
  CATALOG_STATE_SQL,
  SCHEDULE_V25_CATALOG_STATE_SQL,
  EXPECTED_CATALOG_STATE,
  EXPECTED_RESTORED_CATALOG_STATE,
  EXPECTED_V29_RESTORED_CATALOG_STATE,
  EXPECTED_V30_CATALOG_STATE,
  EXPECTED_V30_RESTORED_CATALOG_STATE,
  EXPECTED_V31_CATALOG_STATE,
  EXPECTED_V31_RESTORED_CATALOG_STATE,
  EXPECTED_SCHEDULE_V25_CATALOG_STATE,
  EXPECTED_SCHEDULE_V25_OPERATIONAL_READINESS,
  EXPECTED_SCHEDULE_WINDOW_MANIFEST,
  TOLERATED_HISTORY_COLUMNS,
  EXPECTED_OPERATIONAL_MANIFEST,
  EXPECTED_RESTORED_OPERATIONAL_MANIFEST,
  EXPECTED_V27_OPERATIONAL_MANIFEST,
  EXPECTED_RESTORED_V27_OPERATIONAL_MANIFEST,
  EXPECTED_CRITICAL_SURFACE_MANIFEST,
  EXPECTED_V26_CRITICAL_SURFACE_MANIFEST,
  EXPECTED_V26_EXPECTATION_STATE,
  EXPECTED_V27_COMPAT_V26_EXPECTATION_STATE,
  EXPECTED_V27_EXPECTATION_STATE,
  EXPECTED_V28_COMPAT_V27_EXPECTATION_STATE,
  EXPECTED_V28_EXPECTATION_STATE,
  EXPECTED_V29_EXPECTATION_STATE,
  EXPECTED_V29_TRANSITION_MANIFEST,
  EXPECTED_V29_OPERATIONAL_CONTRACT,
  EXPECTED_V29_OPERATIONAL_MANIFEST,
  EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE,
  EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE,
  EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE,
  EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE,
  EXPECTED_V30_COMPAT_V29_OPERATIONAL_CONTRACT,
  EXPECTED_V30_PREDECESSOR_OPERATIONAL_MANIFEST,
  EXPECTED_V30_EXPECTATION_STATE,
  EXPECTED_V30_REPLAY_REPAIRS_MANIFEST,
  EXPECTED_V30_OPERATIONAL_CONTRACT,
  EXPECTED_V30_OPERATIONAL_MANIFEST,
  EXPECTED_V31_EXPECTATION_STATE,
  EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST,
  EXPECTED_V31_OPERATIONAL_CONTRACT,
  EXPECTED_V31_OPERATIONAL_MANIFEST,
  EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST,
  EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST,
  EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT,
  EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST,
  EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST,
  EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT,
  EXPECTED_PRE_OPERATIONAL_READINESS,
  EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS,
  EXPECTED_RECOVERY_OPERATIONAL_READINESS,
  EXPECTED_CONVERGENCE_OPERATIONAL_READINESS,
  EXPECTED_ATTESTED_OPERATIONAL_READINESS,
  EXPECTED_CRITICAL_OPERATIONAL_READINESS,
  EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS,
  EXPECTED_OPERATIONAL_READINESS,
  EXPECTED_V30_OPERATIONAL_READINESS,
  EXPECTED_V29_OPERATIONAL_READINESS,
  EXPECTED_V26_OPERATIONAL_READINESS,
  EXPECTED_V27_OPERATIONAL_READINESS,
  EXPECTED_V28_OPERATIONAL_READINESS,
  EXPECTED_V25_OPERATIONAL_READINESS,
  EXPECTED_V24_OPERATIONAL_READINESS,
  EXPECTED_RESTORED_V22_OPERATIONAL_READINESS,
  EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS,
  EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS,
  EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS,
  EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS,
  EXPECTED_WRITER_RETURN_CONTRACT_STATE,
  WRITER_RETURN_CONTRACT_STATE_SQL,
  V26_OPERATIONAL_READINESS_SQL,
  V27_OPERATIONAL_READINESS_SQL,
  V29_OPERATIONAL_READINESS_SQL,
  V30_OPERATIONAL_READINESS_SQL,
  SCHEDULE_V25_OPERATIONAL_READINESS_SQL,
  assertApplyableState,
  approvedProviderFingerprintVariants,
  assertExactPendingMigrations,
  assertInspectionToken,
  assertSafeCredentialedTransport,
  buildApplyApprovalRecordBody,
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
  validateApplyApprovalRecord,
  validateCatalogState,
  validateHistoryColumnMetadata,
  validateOperationalManifest,
  validateOperationalReadiness,
  validateV30OperationalReadiness,
  validateV26OperationalReadiness,
  validateCriticalSurfaceManifest,
  validateV26CriticalSurfaceManifest,
  validateV26ExpectationState,
  validateV27CompatV26ExpectationState,
  validateV27ExpectationState,
  validateV28CompatV27ExpectationState,
  validateV28ExpectationState,
  validateV29ExpectationState,
  validateV29TransitionManifest,
  validateV29OperationalContract,
  validateV29OperationalManifest,
  validateV30CompatV28ExpectationState,
  validateV30CompatV29ExpectationState,
  validateV30CompatV29OperationalContract,
  validateV30PredecessorOperationalManifest,
  validateV30ExpectationState,
  validateV30ReplayRepairsManifest,
  validateV30OperationalContract,
  validateV30OperationalManifest,
  validateV31ExpectationState,
  validateV31ResourceOwnershipManifest,
  validateV31OperationalContract,
  validateV31OperationalManifest,
  validateV29OperationalReadiness,
  validateV28OperationalReadiness,
  verifySourceTree,
} from "./studio-comp-migration-rollout.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const validCatalogState = EXPECTED_V31_CATALOG_STATE;
const validFingerprint =
  "functions=3:0123456789abcdef0123456789abcdef:0;" +
  "trigger=1:fedcba9876543210fedcba9876543210:0;" +
  `catalog=${validCatalogState};expectation=${EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE};` +
  `v27_expectation=${EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE};` +
  `v28_expectation=${EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE};` +
  `v29_expectation=${EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE};` +
  `v29_transition=${EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST};` +
  `v29_contract=${EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT};` +
  `v29_manifest=${EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST};` +
  `v30_expectation=${EXPECTED_V30_EXPECTATION_STATE};` +
  `v30_replay=${EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST};` +
  `v30_contract=${EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT};` +
  `v30_manifest=${EXPECTED_V30_OPERATIONAL_MANIFEST};` +
  `v31_compat_v30_manifest=${EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST};` +
  `v31_expectation=${EXPECTED_V31_EXPECTATION_STATE};` +
  `v31_resource=${EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST};` +
  `v31_contract=${EXPECTED_V31_OPERATIONAL_CONTRACT};` +
  `v31_manifest=${EXPECTED_V31_OPERATIONAL_MANIFEST};` +
  `critical_surface=${EXPECTED_CRITICAL_SURFACE_MANIFEST}`;
const validRestoredFingerprint = validFingerprint.replace(
  `catalog=${EXPECTED_V31_CATALOG_STATE}`,
  `catalog=${EXPECTED_V31_RESTORED_CATALOG_STATE}`,
);

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
    v26ExpectationState: EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE,
    v27ExpectationState: EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE,
    v28ExpectationState: EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE,
    v29ExpectationState: EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE,
    v29TransitionManifest: EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST,
    v29OperationalContract: EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT,
    v29OperationalManifest: EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST,
    v30ExpectationState: EXPECTED_V30_EXPECTATION_STATE,
    v30ReplayRepairsManifest: EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST,
    v30OperationalContract: EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT,
    v30OperationalManifest: EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST,
    v31ExpectationState: EXPECTED_V31_EXPECTATION_STATE,
    v31ResourceOwnershipManifest: EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST,
    v31OperationalContract: EXPECTED_V31_OPERATIONAL_CONTRACT,
    v31OperationalManifest: EXPECTED_V31_OPERATIONAL_MANIFEST,
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

function restoredV22Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.restoredV22History,
    targetHistory: packet.restoredV22TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_RESTORED_V22_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function canonicalV23Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.canonicalV23History,
    targetHistory: packet.canonicalV23TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    operationalReadiness: EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function restoredV23PendingV24Snapshot(packet, overrides = {}) {
  return canonicalV23Snapshot(packet, {
    operationalReadiness: EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS,
    ...overrides,
  });
}

function v24Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v24History,
    targetHistory: packet.v24TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V24_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function scheduleV25Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.scheduleV25History,
    targetHistory: packet.scheduleV25TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: EXPECTED_SCHEDULE_V25_CATALOG_STATE,
    scheduleWindowManifest: EXPECTED_SCHEDULE_WINDOW_MANIFEST,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_SCHEDULE_V25_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function v25Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v25History,
    targetHistory: packet.v25TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V25_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function v26Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v26History,
    targetHistory: packet.v26TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V26_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function v27Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v27History,
    targetHistory: packet.v27TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V27_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function v28Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v28History,
    targetHistory: packet.v28TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V28_OPERATIONAL_READINESS,
    writerReturnContractState: null,
    ...overrides,
  };
}

function v29Snapshot(packet, overrides = {}) {
  return {
    historyColumns: minimalHistoryColumns,
    history: packet.v29History,
    targetHistory: packet.v29TargetHistory,
    objectCounts: "3:1",
    functionState: null,
    triggerState: null,
    catalogState: null,
    criticalSurfaceManifest: null,
    operationalReadiness: EXPECTED_V29_OPERATIONAL_READINESS,
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
    assert.equal(
      validateOperationalManifest(EXPECTED_RESTORED_OPERATIONAL_MANIFEST),
      EXPECTED_RESTORED_OPERATIONAL_MANIFEST,
    );
    assert.equal(
      validateOperationalManifest(EXPECTED_V27_OPERATIONAL_MANIFEST),
      EXPECTED_V27_OPERATIONAL_MANIFEST,
    );
    assert.equal(
      validateOperationalManifest(EXPECTED_RESTORED_V27_OPERATIONAL_MANIFEST),
      EXPECTED_RESTORED_V27_OPERATIONAL_MANIFEST,
    );
    assert.throws(
      () => validateOperationalManifest("0".repeat(64)),
      /Operational semantic\/ACL manifest mismatch/,
    );
    assert.throws(
      () => validateOperationalManifest(
        "f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233",
      ),
      /Operational semantic\/ACL manifest mismatch/,
    );
  });

  it("pins exact canonical and restored raw catalogs without accepting hybrid fingerprints", () => {
    assert.equal(validateCatalogState(EXPECTED_CATALOG_STATE), EXPECTED_CATALOG_STATE);
    assert.equal(
      validateCatalogState(EXPECTED_RESTORED_CATALOG_STATE),
      EXPECTED_RESTORED_CATALOG_STATE,
    );
    assert.equal(validateCatalogState(EXPECTED_V30_CATALOG_STATE), EXPECTED_V30_CATALOG_STATE);
    assert.deepEqual(approvedProviderFingerprintVariants(validFingerprint), [
      validFingerprint,
      validRestoredFingerprint,
    ]);
    assert.throws(
      () => approvedProviderFingerprintVariants(validRestoredFingerprint),
      /not the exact canonical staging evidence shape/,
    );
    assert.throws(
      () => validateCatalogState(EXPECTED_CATALOG_STATE.replace("indexes=12", "indexes=11")),
      /raw catalog manifest mismatch/,
    );
    const formerV25RestoredCatalog =
      "column_acls=205:32ad7f660d40de1c75de0e9d50e4c23f3588124e67f3665159f8f2f027617414:0;" +
      "columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;" +
      "constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;" +
      "functions=68:2468ddb856d9b0ab920a045996a4d1af575e27f144fa85094d6fc01b8f75f68b:0;" +
      "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
      "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
      "scoped_constraints=149:47cacc1ce1d31ca8a7d63158aaa66aaf24452c085015c226f40e810995a6cd18:0;" +
      "scoped_indexes=33:4d401ee4a7e7f104957cb8cc84ad45164d57938ced0c2609259310aa980895f2:0;" +
      "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
      "table_acls=14:d71f968d375333515659bd0220224c127cee6e7b3878f9ae36427f7c1561c92c:0;" +
      "tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;" +
      "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";
    assert.throws(
      () => validateCatalogState(formerV25RestoredCatalog),
      /raw catalog manifest mismatch/,
    );
  });

  it("requires the exact V26 operational readiness output", () => {
    assert.equal(
      validateV26OperationalReadiness(EXPECTED_V26_OPERATIONAL_READINESS),
      EXPECTED_V26_OPERATIONAL_READINESS,
    );
    for (const value of [null, "", "true|101|20260814043325", `${EXPECTED_V26_OPERATIONAL_READINESS}|extra`]) {
      assert.throws(() => validateV26OperationalReadiness(value), /V26 operational readiness/);
    }
  });

  it("requires exact V29, V30, and V31 operational readiness outputs", () => {
    assert.equal(
      validateV29OperationalReadiness(EXPECTED_V29_OPERATIONAL_READINESS),
      EXPECTED_V29_OPERATIONAL_READINESS,
    );
    assert.throws(
      () => validateV29OperationalReadiness(`${EXPECTED_V29_OPERATIONAL_READINESS}|extra`),
      /V29 operational readiness/,
    );
    assert.equal(validateOperationalReadiness(EXPECTED_OPERATIONAL_READINESS), EXPECTED_OPERATIONAL_READINESS);
    assert.throws(
      () => validateOperationalReadiness(`${EXPECTED_OPERATIONAL_READINESS}|extra`),
      /V31 operational readiness/,
    );
    assert.equal(
      validateV30OperationalReadiness(EXPECTED_V30_OPERATIONAL_READINESS),
      EXPECTED_V30_OPERATIONAL_READINESS,
    );
    assert.throws(
      () => validateV30OperationalReadiness(`${EXPECTED_V30_OPERATIONAL_READINESS}|extra`),
      /V30 operational readiness/,
    );
  });

  it("requires the exact archive-critical semantic manifest output", () => {
    assert.equal(
      validateV26CriticalSurfaceManifest(EXPECTED_V26_CRITICAL_SURFACE_MANIFEST),
      EXPECTED_V26_CRITICAL_SURFACE_MANIFEST,
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

  it("pins the private V26 expectation independently from the full V6 body catalog", () => {
    assert.equal(
      validateV26ExpectationState(EXPECTED_V26_EXPECTATION_STATE),
      EXPECTED_V26_EXPECTATION_STATE,
    );
    for (const value of [
      null,
      "",
      EXPECTED_V26_EXPECTATION_STATE.replace(/^1:/, "0:"),
      EXPECTED_V26_EXPECTATION_STATE.replace(/[0-9a-f]$/, "0"),
      `${EXPECTED_V26_EXPECTATION_STATE}|extra`,
    ]) {
      assert.throws(
        () => validateV26ExpectationState(value),
        /V26 release expectation row/,
      );
    }

    assert.match(CATALOG_STATE_SQL, /koaryu_release_schema_preflight_v6/);
    assert.match(CATALOG_STATE_SQL, /private\.koaryu_release_schedule_window_manifest_v1\(\)/);
    assert.match(CATALOG_STATE_SQL, /public\.schedule_window_read\(uuid, date, date, text\)/);
    assert.match(CATALOG_STATE_SQL, /koaryu_release_schema_preflight_v12/);
    assertReadOnlySql(SCHEDULE_V25_CATALOG_STATE_SQL);
    assert.match(CATALOG_STATE_SQL, /body_sha256/);
    const v6BodyDriftedCatalog = EXPECTED_CATALOG_STATE.replace(
      /(functions=[0-9]+:)[0-9a-f]{64}/,
      `$1${"0".repeat(64)}`,
    );
    assert.notEqual(v6BodyDriftedCatalog, EXPECTED_CATALOG_STATE);
    assert.throws(
      () => validateCatalogState(v6BodyDriftedCatalog),
      /raw catalog manifest mismatch/,
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

  it("decodes the pinned CLI single-field CSV contract before exact V31 validation", () => {
    const quotedReadiness = singleValueCsv(
      "operational_readiness",
      EXPECTED_OPERATIONAL_READINESS,
    );
    assert.match(quotedReadiness, /^operational_readiness\n"true\|126\|/);
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

  it("derives an exact 100-to-126 packet through schedule V25 and the Payments predecessors", () => {
    const packet = candidatePacket();
    assert.equal(packet.candidateSha, candidateSha);
    assert.equal(ROLLOUT.scheduleV25MigrationCount, 119);
    assert.deepEqual(
      ROLLOUT.scheduleMigrations.map(({ filename, sha256 }) => [filename, sha256]),
      [
        [
          "20260825042838_schedule_window_read_rpc.sql",
          "6e36b37902564eeb4eb54c9284615e80bbf44582cce864514db2060565092313",
        ],
        [
          "20260825043911_attest_schedule_window_release.sql",
          "22637698a5af2043b74ed344c16ab111a27d83b54b1621a82deb091f436174f5",
        ],
      ],
    );
    assert.equal(ROLLOUT.v26MigrationCount, 121);
    assert.equal(packet.migrationCount, 126);
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
    assert.match(packet.restoredV22History, /^115:[0-9a-f]{32}$/);
    assert.match(packet.restoredV22TargetHistory, /20260822193000:revoke_client_read_access$/);
    assert.match(packet.canonicalV23History, /^116:[0-9a-f]{32}$/);
    assert.match(packet.scheduleV25History, /^119:[0-9a-f]{32}$/);
    assert.match(packet.scheduleV25TargetHistory, /20260825043911:attest_schedule_window_release$/);
    assert.match(packet.v25History, /^120:[0-9a-f]{32}$/);
    assert.match(packet.v25TargetHistory, /20260826030234:live_billing_reconciliation_v3$/);
    assert.match(packet.v26History, /^121:[0-9a-f]{32}$/);
    assert.match(packet.v26TargetHistory, /20260826030249:payments_adjustment_convergence$/);
    assert.match(packet.v27History, /^122:[0-9a-f]{32}$/);
    assert.match(packet.v27TargetHistory, /20260826051527:billing_provider_operations_and_payer_consent$/);
    assert.match(packet.v28History, /^123:[0-9a-f]{32}$/);
    assert.match(packet.v28TargetHistory, /20260826073728:billing_provider_operation_steps$/);
    assert.match(packet.v29History, /^124:[0-9a-f]{32}$/);
    assert.match(packet.v29TargetHistory, /20260826102840:enrollment_period_safe_transitions$/);
    assert.match(packet.v30History, /^125:[0-9a-f]{32}$/);
    assert.match(packet.v30TargetHistory, /20260826155911:payments_workflow_catalog_and_replay_repairs$/);
    assert.match(packet.canonicalV23TargetHistory, /20260823193155:revoke_public_function_execute$/);
    assert.match(packet.v24History, /^117:[0-9a-f]{32}$/);
    assert.match(packet.v24TargetHistory, /20260824190500:attest_verified_restore_manifest$/);
    assert.match(packet.postHistory, new RegExp(`^${packet.migrationCount}:[0-9a-f]{32}$`));
    assert.equal(
      packet.pendingMigrations.length,
      packet.migrationCount - ROLLOUT.baselineMigrationCount,
    );
    assert.match(packet.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(packet.integrationComplete, true);
    assert.equal(packet.pendingMigrations.length, 26);
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

  it("accepts exact historical, V22, V23, V24, and semantically valid post-state", () => {
    const packet = candidatePacket();
    assert.deepEqual(classifyStateSnapshot(preSnapshot(), packet), {
      state: "pre",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(postSnapshot(packet), packet, validFingerprint), {
      state: "post",
      providerFingerprint: validFingerprint,
    });
    assert.deepEqual(
      classifyStateSnapshot(
        postSnapshot(packet, { catalogState: EXPECTED_V31_RESTORED_CATALOG_STATE }),
        packet,
        validFingerprint,
      ),
      { state: "post", providerFingerprint: validRestoredFingerprint },
    );
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
    assert.deepEqual(classifyStateSnapshot(restoredV22Snapshot(packet), packet), {
      state: "restored-v22",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(canonicalV23Snapshot(packet), packet), {
      state: "canonical-v23",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(restoredV23PendingV24Snapshot(packet), packet), {
      state: "restored-v23-pending-v24",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(v24Snapshot(packet), packet), {
      state: "v24",
      providerFingerprint: null,
    });
    assert.deepEqual(classifyStateSnapshot(scheduleV25Snapshot(packet), packet), {
      state: "schedule-v25",
      providerFingerprint: null,
    });
    for (const [overrides, message] of [
      [{ targetHistory: packet.v25TargetHistory }, /exact target history/],
      [{ operationalReadiness: EXPECTED_V25_OPERATIONAL_READINESS }, /operational readiness/],
      [{ scheduleWindowManifest: "0:" + "0".repeat(64) }, /window manifest/],
      [{ catalogState: EXPECTED_SCHEDULE_V25_CATALOG_STATE.replace("functions=71", "functions=72") }, /raw catalog/],
    ]) {
      assert.throws(
        () => classifyStateSnapshot(scheduleV25Snapshot(packet, overrides), packet),
        message,
      );
    }
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
      /does not match an exact approved staging or restored-production catalog state/,
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

  it("independently rejects every non-exact V26 output before post certification", () => {
    const packet = candidatePacket();
    for (const operationalReadiness of [
      null,
      "",
      EXPECTED_V26_OPERATIONAL_READINESS.replace(/^true/, "false"),
      EXPECTED_V26_OPERATIONAL_READINESS.replace("|121|", "|109|"),
      EXPECTED_V26_OPERATIONAL_READINESS.replace("|20260826030249|", "|20260814213000|"),
      EXPECTED_V26_OPERATIONAL_READINESS.replace(",20260826030249|", "|"),
      EXPECTED_V26_OPERATIONAL_READINESS.replace("|0||", "|1|table_acl|"),
      EXPECTED_V26_OPERATIONAL_READINESS.replace("release-db-attestation-v26", "release-db-attestation-v16"),
    ]) {
      assert.throws(
        () => classifyStateSnapshot(v26Snapshot(packet, { operationalReadiness }), packet),
        /V26 operational readiness/,
      );
    }
  });

  it("independently rejects every non-exact V27 output before post certification", () => {
    const packet = candidatePacket();
    for (const operationalReadiness of [
      null,
      "",
      EXPECTED_V27_OPERATIONAL_READINESS.replace(/^true/, "false"),
      EXPECTED_V27_OPERATIONAL_READINESS.replace("|122|", "|109|"),
      EXPECTED_V27_OPERATIONAL_READINESS.replace("|20260826051527|", "|20260814213000|"),
      EXPECTED_V27_OPERATIONAL_READINESS.replace(",20260826051527|", "|"),
      EXPECTED_V27_OPERATIONAL_READINESS.replace("|0||", "|1|table_acl|"),
      EXPECTED_V27_OPERATIONAL_READINESS.replace("release-db-attestation-v27", "release-db-attestation-v16"),
    ]) {
      assert.throws(
        () => classifyStateSnapshot(v27Snapshot(packet, { operationalReadiness }), packet),
        /V27 operational readiness/,
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

  it("rejects every hybrid restored V22 or canonical V23 rollout state", () => {
    const packet = candidatePacket();
    for (const [snapshot, message] of [
      [restoredV22Snapshot(packet, { targetHistory: packet.canonicalV23TargetHistory }), /exact V22 target history/],
      [restoredV22Snapshot(packet, { operationalReadiness: EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS }), /Restored V22 operational readiness/],
      [canonicalV23Snapshot(packet, { targetHistory: packet.restoredV22TargetHistory }), /exact V23 target history/],
      [canonicalV23Snapshot(packet, { operationalReadiness: EXPECTED_RESTORED_V22_OPERATIONAL_READINESS }), /exact canonical staging or restored-production/],
      [restoredV23PendingV24Snapshot(packet, {
        operationalReadiness: EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS.replace(
          "operational_semantic_acl_manifest_v7",
          "unexpected_failure",
        ),
      }), /exact canonical staging or restored-production/],
    ]) {
      assert.throws(() => classifyStateSnapshot(snapshot, packet), message);
    }
  });

  it("reads exact V22, V23, V24, and V25 remote states without post-only catalogs", () => {
    const packet = candidatePacket();
    for (const [expectedState, history, targetHistory, operationalReadiness] of [
      [
        "restored-v22",
        packet.restoredV22History,
        packet.restoredV22TargetHistory,
        EXPECTED_RESTORED_V22_OPERATIONAL_READINESS,
      ],
      [
        "canonical-v23",
        packet.canonicalV23History,
        packet.canonicalV23TargetHistory,
        EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS,
      ],
      [
        "restored-v23-pending-v24",
        packet.canonicalV23History,
        packet.canonicalV23TargetHistory,
        EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS,
      ],
      [
        "v24",
        packet.v24History,
        packet.v24TargetHistory,
        EXPECTED_V24_OPERATIONAL_READINESS,
      ],
      [
        "v25",
        packet.v25History,
        packet.v25TargetHistory,
        EXPECTED_V25_OPERATIONAL_READINESS,
      ],
    ]) {
      const values = new Map([
        ["history_columns", JSON.stringify(minimalHistoryColumns)],
        ["history_state", history],
        ["target_history", targetHistory],
        ["object_counts", "3:1"],
        ["operational_readiness", operationalReadiness],
      ]);
      const headers = [];
      const result = readRemoteState(
        repositoryRoot,
        packet,
        {},
        null,
        (_root, _sql, header) => {
          headers.push(header);
          return values.get(header);
        },
      );
      assert.deepEqual(result, { state: expectedState, providerFingerprint: null });
      assert.equal(headers.at(-1), "operational_readiness");
      assert.ok(!headers.includes("catalog_state"));
    }
  });

  it("reads the exact canonical schedule V25 state with its dedicated raw catalog", () => {
    const packet = candidatePacket();
    const values = new Map([
      ["history_columns", JSON.stringify(minimalHistoryColumns)],
      ["history_state", packet.scheduleV25History],
      ["target_history", packet.scheduleV25TargetHistory],
      ["object_counts", "3:1"],
      ["catalog_state", EXPECTED_SCHEDULE_V25_CATALOG_STATE],
      ["schedule_window_manifest", EXPECTED_SCHEDULE_WINDOW_MANIFEST],
      ["operational_readiness", EXPECTED_SCHEDULE_V25_OPERATIONAL_READINESS],
    ]);
    const sqlSeen = [];
    const result = readRemoteState(
      repositoryRoot,
      packet,
      {},
      null,
      (_root, sql, header) => {
        sqlSeen.push(sql);
        return values.get(header);
      },
    );
    assert.deepEqual(result, { state: "schedule-v25", providerFingerprint: null });
    assert.ok(sqlSeen.includes(SCHEDULE_V25_CATALOG_STATE_SQL));
    assert.match(sqlSeen.at(-1), /koaryu_release_schema_preflight_v5/);
  });

  it("retains exact V26 predecessor classification and V7 readiness SQL", () => {
    const packet = candidatePacket();
    assert.deepEqual(
      classifyStateSnapshot(v26Snapshot(packet), packet),
      { state: "v26", providerFingerprint: null },
    );
    assert.match(V26_OPERATIONAL_READINESS_SQL, /koaryu_release_schema_preflight_v7/);
  });

  it("validates the exact V27 remote predecessor state independently", () => {
    const packet = candidatePacket();
    const values = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.v27History],
      ["target_history", packet.v27TargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_V27_OPERATIONAL_READINESS],
    ]);
    const sqlSeen = [];
    const result = readRemoteState(
      repositoryRoot,
      packet,
      {},
      null,
      (_root, sql, header) => {
        sqlSeen.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, values.get(header)), header);
      },
    );
    assert.deepEqual(result, { state: "v27", providerFingerprint: null });
    assert.ok(sqlSeen.some((sql) => /koaryu_release_schema_preflight_v8/.test(sql)));
    assert.match(V27_OPERATIONAL_READINESS_SQL, /koaryu_release_schema_preflight_v8/);
  });

  it("validates the exact V29 and V30 predecessors and V31 post-state independently", () => {
    const packet = candidatePacket();
    assert.deepEqual(classifyStateSnapshot(v29Snapshot(packet), packet), {
      state: "v29",
      providerFingerprint: null,
    });
    assert.match(V29_OPERATIONAL_READINESS_SQL, /koaryu_release_schema_preflight_v10/);
    const postValues = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.postHistory],
      ["target_history", packet.postTargetHistory],
      ["object_counts", "3:1"],
      ["function_state", "3:0123456789abcdef0123456789abcdef:0"],
      ["trigger_state", "1:fedcba9876543210fedcba9876543210:0"],
      ["catalog_state", validCatalogState],
      ["critical_surface_manifest", EXPECTED_CRITICAL_SURFACE_MANIFEST],
      ["v26_expectation_state", EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE],
      ["v27_expectation_state", EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE],
      ["v28_expectation_state", EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE],
      ["v29_expectation_state", EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE],
      ["v29_transition_manifest", EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST],
      ["v29_operational_contract", EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT],
      ["v29_operational_manifest", EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST],
      ["v30_expectation_state", EXPECTED_V30_EXPECTATION_STATE],
      ["v30_replay_repairs_manifest", EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST],
      ["v30_operational_contract", EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT],
      ["v30_operational_manifest", EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST],
      ["v31_expectation_state", EXPECTED_V31_EXPECTATION_STATE],
      ["v31_resource_ownership_manifest", EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST],
      ["v31_operational_contract", EXPECTED_V31_OPERATIONAL_CONTRACT],
      ["v31_operational_manifest", EXPECTED_V31_OPERATIONAL_MANIFEST],
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
    assert.match(postSql.at(-1), /koaryu_release_schema_preflight_v12/);

    const v30Values = new Map([
      ["history_columns", extendedHistoryColumns],
      ["history_state", packet.v30History],
      ["target_history", packet.v30TargetHistory],
      ["object_counts", "3:1"],
      ["operational_readiness", EXPECTED_V30_OPERATIONAL_READINESS],
    ]);
    const v30Sql = [];
    assert.deepEqual(
      readRemoteState(repositoryRoot, packet, {}, null, (_root, sql, header) => {
        v30Sql.push(sql);
        return parseSingleValueCsv(singleValueCsv(header, v30Values.get(header)), header);
      }),
      { state: "v30", providerFingerprint: null },
    );
    assert.match(v30Sql.at(-1), /koaryu_release_schema_preflight_v11/);
    assert.match(V30_OPERATIONAL_READINESS_SQL, /koaryu_release_schema_preflight_v11/);

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
      detail: `Unexpected migration history ${observedHistory}; expected exact pre-, intermediate-, recovery-, convergence-, attested-, return-attested-, retained-, critical-, column-attested-, trial-locked-, staff-identity-, restored-v22-, canonical-v23-, restored-v23-pending-v24-, v24-, schedule-v25, v25, v26, v27, v28, v29, v30, or post-state.`,
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
        ["v26_expectation_state", snapshot.v26ExpectationState],
        ["v27_expectation_state", snapshot.v27ExpectationState],
        ["v28_expectation_state", snapshot.v28ExpectationState],
        ["v29_expectation_state", snapshot.v29ExpectationState],
        ["v29_transition_manifest", snapshot.v29TransitionManifest],
        ["v29_operational_contract", snapshot.v29OperationalContract],
        ["v29_operational_manifest", snapshot.v29OperationalManifest],
        ["v30_expectation_state", snapshot.v30ExpectationState],
        ["v30_replay_repairs_manifest", snapshot.v30ReplayRepairsManifest],
        ["v30_operational_contract", snapshot.v30OperationalContract],
        ["v30_operational_manifest", snapshot.v30OperationalManifest],
        ["v31_expectation_state", snapshot.v31ExpectationState],
        ["v31_resource_ownership_manifest", snapshot.v31ResourceOwnershipManifest],
        ["v31_operational_contract", snapshot.v31OperationalContract],
        ["v31_operational_manifest", snapshot.v31OperationalManifest],
        ["operational_readiness", snapshot.operationalReadiness],
        ["writer_return_contract_state", snapshot.writerReturnContractState],
        ["migration_row_count", expected.state === "pre" ? "84" : expected.state === "intermediate" ? "101" : expected.state === "recovery" ? "102" : expected.state === "convergence" ? "103" : expected.state === "attested" ? "104" : expected.state === "column-attested" ? "108" : expected.state === "trial-locked" ? String(ROLLOUT.trialLockedMigrationCount) : expected.state === "staff-identity" ? String(ROLLOUT.staffIdentityMigrationCount) : String(ROLLOUT.finalMigrationCount)],
        ["migration_newest_version", expected.state === "pre" ? "20260710123456" : expected.state === "intermediate" ? "20260814043325" : expected.state === "recovery" ? "20260814103046" : expected.state === "convergence" ? "20260814105424" : expected.state === "attested" ? "20260814114500" : expected.state === "column-attested" ? "20260814200000" : expected.state === "trial-locked" ? "20260814213000" : expected.state === "staff-identity" ? "20260815220402" : "20260820025759"],
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
    assert.equal(formatNonSuccessProbeState({ state: "restored-v22", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "canonical-v23", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "restored-v23-pending-v24", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v24", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "schedule-v25", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v25", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v26", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v27", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v28", providerFingerprint: null }), null);
    assert.equal(formatNonSuccessProbeState({ state: "v29", providerFingerprint: null }), null);
    assert.equal(
      formatNonSuccessProbeState({ state: "post", providerFingerprint: validFingerprint }),
      null,
    );
  });

  it("makes an inspection token available only for accepted probe states", () => {
    const packet = candidatePacket();
    for (const state of ["pre", "intermediate", "recovery", "convergence", "attested", "return-attested", "retained", "critical", "column-attested", "trial-locked", "staff-identity", "restored-v22", "canonical-v23", "restored-v23-pending-v24", "v24", "schedule-v25", "v25", "v26", "v27", "v28", "v29", "post"]) {
      assert.equal(
        buildInspectionTokenForAcceptedState(packet, "staging", { state }),
        buildInspectionToken(packet, "staging", state),
      );
    }
    const scheduleToken = buildInspectionTokenForAcceptedState(
      packet,
      "staging",
      { state: "schedule-v25" },
    );
    assert.notEqual(
      scheduleToken,
      buildInspectionTokenForAcceptedState(packet, "staging", { state: "v25" }),
    );
    assert.notEqual(
      scheduleToken,
      buildInspectionTokenForAcceptedState(packet, "production", { state: "schedule-v25" }),
    );
    for (const result of [
      { state: "unknown", reason: "timeout" },
      { state: "unknown", reason: "connectivity" },
      { state: "diverged", detail: "Unexpected migration history 82:0123456789abcdef0123456789abcdef." },
    ]) {
      assert.throws(
        () => buildInspectionTokenForAcceptedState(packet, "staging", result),
        /accepted pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, staff-identity, restored-v22, canonical-v23, restored-v23-pending-v24, v24, schedule-v25, v25, v26, v27, v28, v29, v30, or post probe state/,
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

  it("retains the exact V26 121-migration predecessor boundary", () => {
    const packet = candidatePacket();
    assert.equal(ROLLOUT.v26MigrationCount, 121);
    assert.match(packet.v26History, /^121:[0-9a-f]{32}$/);
    assert.match(packet.v26TargetHistory, /20260826030249:payments_adjustment_convergence$/);
  });

  it("refuses to certify post-state before the exact 126-migration integration", () => {
    const packet = { ...candidatePacket(), integrationComplete: false };
    assert.equal(packet.integrationComplete, false);
    assert.throws(
      () => classifyStateSnapshot(postSnapshot(packet), packet),
      /exact final 126-migration sequence/,
    );
  });

  it("selects exact remaining migrations through canonical V23 state", () => {
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
        "20260820025759_roster_read_rpc.sql",
        "20260820060216_atomic_bulk_student_archive.sql",
        "20260822193000_revoke_client_read_access.sql",
        "20260823193155_revoke_public_function_execute.sql",
        "20260824190500_attest_verified_restore_manifest.sql",
        "20260825042838_schedule_window_read_rpc.sql",
        "20260825043911_attest_schedule_window_release.sql",
        "20260826030234_live_billing_reconciliation_v3.sql",
        "20260826030249_payments_adjustment_convergence.sql",
        "20260826051527_billing_provider_operations_and_payer_consent.sql",
        "20260826073728_billing_provider_operation_steps.sql",
        "20260826102840_enrollment_period_safe_transitions.sql",
        "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
        "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
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
        "20260820025759_roster_read_rpc.sql",
        "20260820060216_atomic_bulk_student_archive.sql",
        "20260822193000_revoke_client_read_access.sql",
        "20260823193155_revoke_public_function_execute.sql",
        "20260824190500_attest_verified_restore_manifest.sql",
        "20260825042838_schedule_window_read_rpc.sql",
        "20260825043911_attest_schedule_window_release.sql",
        "20260826030234_live_billing_reconciliation_v3.sql",
        "20260826030249_payments_adjustment_convergence.sql",
        "20260826051527_billing_provider_operations_and_payer_consent.sql",
        "20260826073728_billing_provider_operation_steps.sql",
        "20260826102840_enrollment_period_safe_transitions.sql",
        "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
        "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
      ],
    );
    assert.deepEqual(
      staffIdentityRemaining.pendingManifest,
      packet.pendingManifest.slice(ROLLOUT.staffIdentityMigrationCount - ROLLOUT.baselineMigrationCount),
    );
    assert.match(staffIdentityRemaining.sourceManifestSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(staffIdentityRemaining.sourceManifestSha256, trialLockedRemaining.sourceManifestSha256);
    const restoredV22Remaining = packetForAcceptedState(packet, "restored-v22");
    assert.deepEqual(restoredV22Remaining.pendingMigrations, [
      "20260823193155_revoke_public_function_execute.sql",
      "20260824190500_attest_verified_restore_manifest.sql",
      "20260825042838_schedule_window_read_rpc.sql",
      "20260825043911_attest_schedule_window_release.sql",
      "20260826030234_live_billing_reconciliation_v3.sql",
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const canonicalV23Remaining = packetForAcceptedState(packet, "canonical-v23");
    assert.deepEqual(canonicalV23Remaining.pendingMigrations, [
      "20260824190500_attest_verified_restore_manifest.sql",
      "20260825042838_schedule_window_read_rpc.sql",
      "20260825043911_attest_schedule_window_release.sql",
      "20260826030234_live_billing_reconciliation_v3.sql",
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    assert.notEqual(
      restoredV22Remaining.sourceManifestSha256,
      canonicalV23Remaining.sourceManifestSha256,
    );
    const restoredV23Remaining = packetForAcceptedState(
      packet,
      "restored-v23-pending-v24",
    );
    assert.deepEqual(
      restoredV23Remaining.pendingMigrations,
      canonicalV23Remaining.pendingMigrations,
    );
    assert.equal(
      restoredV23Remaining.sourceManifestSha256,
      canonicalV23Remaining.sourceManifestSha256,
    );
    const v24Remaining = packetForAcceptedState(packet, "v24");
    assert.deepEqual(v24Remaining.pendingMigrations, [
      "20260825042838_schedule_window_read_rpc.sql",
      "20260825043911_attest_schedule_window_release.sql",
      "20260826030234_live_billing_reconciliation_v3.sql",
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const scheduleV25Remaining = packetForAcceptedState(packet, "schedule-v25");
    assert.deepEqual(scheduleV25Remaining.pendingMigrations, [
      "20260826030234_live_billing_reconciliation_v3.sql",
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v25Remaining = packetForAcceptedState(packet, "v25");
    assert.deepEqual(v25Remaining.pendingMigrations, [
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v26Remaining = packetForAcceptedState(packet, "v26");
    assert.deepEqual(v26Remaining.pendingMigrations, [
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v27Remaining = packetForAcceptedState(packet, "v27");
    assert.deepEqual(v27Remaining.pendingMigrations, [
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v28Remaining = packetForAcceptedState(packet, "v28");
    assert.deepEqual(v28Remaining.pendingMigrations, [
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v29Remaining = packetForAcceptedState(packet, "v29");
    assert.deepEqual(v29Remaining.pendingMigrations, [
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    const v30Remaining = packetForAcceptedState(packet, "v30");
    assert.deepEqual(v30Remaining.pendingMigrations, [
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
    ]);
    assert.equal(packetForAcceptedState(packet, "pre"), packet);
    assert.throws(
      () => packetForAcceptedState(packet, "post"),
        /pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, staff-identity, restored-v22, canonical-v23, restored-v23-pending-v24, v24, schedule-v25, v25, v26, v27, v28, v29, or v30 state/,
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
    for (const state of ["pre", "attested", "return-attested", "retained", "critical", "column-attested", "trial-locked", "staff-identity", "restored-v22", "canonical-v23", "restored-v23-pending-v24", "v24", "schedule-v25", "v25", "v26", "v27", "v28", "v29", "v30"]) {
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
      "20260820025759_roster_read_rpc.sql",
      "20260820060216_atomic_bulk_student_archive.sql",
      "20260822193000_revoke_client_read_access.sql",
      "20260823193155_revoke_public_function_execute.sql",
      "20260824190500_attest_verified_restore_manifest.sql",
      "20260825042838_schedule_window_read_rpc.sql",
      "20260825043911_attest_schedule_window_release.sql",
      "20260826030234_live_billing_reconciliation_v3.sql",
      "20260826030249_payments_adjustment_convergence.sql",
      "20260826051527_billing_provider_operations_and_payer_consent.sql",
      "20260826073728_billing_provider_operation_steps.sql",
      "20260826102840_enrollment_period_safe_transitions.sql",
      "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
      "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
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
      "--approval-record", "https://github.com/ronchak/Koaryu/pull/134#issuecomment-123456789",
      "--approve-staging-apply",
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
    assert.throws(
      () => validateApplyAuthorization({ ...config, approvalRecord: "director-phase-b-approval" }),
      /exact PR #134 GitHub issue-comment URL/,
    );
  });

  it("binds the durable apply approval to the exact remaining packet and inspected state", () => {
    const packet = packetForAcceptedState(candidatePacket(), "schedule-v25");
    const config = parseArguments([
      "--target", "staging", "--candidate-sha", candidateSha, "--mode", "apply",
      "--inspection-token", buildInspectionToken(candidatePacket(), "staging", "schedule-v25"),
      "--confirm-project", ROLLOUT.stagingRef,
      "--approval-record", "https://github.com/ronchak/Koaryu/pull/134#issuecomment-123456789",
      "--approve-staging-apply",
    ]);
    const expectedBody = buildApplyApprovalRecordBody(packet, "staging", "schedule-v25");
    const approvedRunner = (command, args) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, [
        "api", "repos/ronchak/Koaryu/issues/comments/123456789",
      ]);
      return JSON.stringify({
        body: expectedBody,
        issue_url: "https://api.github.com/repos/ronchak/Koaryu/issues/134",
        user: { login: "ronchak" },
        author_association: "OWNER",
      });
    };
    assert.doesNotThrow(() =>
      validateApplyApprovalRecord(config, packet, "schedule-v25", approvedRunner, {}));
    for (const stalePacket of [
      { ...packet, candidateSha: "0".repeat(40) },
      { ...packet, sourceManifestSha256: "0".repeat(64) },
      { ...packet, pendingMigrations: packet.pendingMigrations.slice(1) },
    ]) {
      assert.throws(
        () => validateApplyApprovalRecord(config, stalePacket, "schedule-v25", approvedRunner, {}),
        /does not exactly bind/,
      );
    }
    assert.throws(
      () => validateApplyApprovalRecord(config, packet, "v25", approvedRunner, {}),
      /does not exactly bind/,
    );
    const forgedOtherIssueRunner = () => JSON.stringify({
      body: expectedBody,
      issue_url: "https://api.github.com/repos/ronchak/Koaryu/issues/133",
      user: { login: "ronchak" },
      author_association: "OWNER",
    });
    assert.throws(
      () => validateApplyApprovalRecord(
        config,
        packet,
        "schedule-v25",
        forgedOtherIssueRunner,
        {},
      ),
      /does not belong to ronchak\/Koaryu PR #134/,
    );
    for (const untrustedAuthor of [
      {
        user: { login: "untrusted-outsider" },
        author_association: "NONE",
      },
      {
        user: { login: "ronchak" },
        author_association: "COLLABORATOR",
      },
    ]) {
      const untrustedAuthorRunner = () => JSON.stringify({
        body: expectedBody,
        issue_url: "https://api.github.com/repos/ronchak/Koaryu/issues/134",
        ...untrustedAuthor,
      });
      assert.throws(
        () => validateApplyApprovalRecord(
          config,
          packet,
          "schedule-v25",
          untrustedAuthorRunner,
          {},
        ),
        /not authored by the authorized Koaryu repository owner/,
      );
    }
    const missingAuthorRunner = () => JSON.stringify({
      body: expectedBody,
      issue_url: "https://api.github.com/repos/ronchak/Koaryu/issues/134",
    });
    assert.throws(
      () => validateApplyApprovalRecord(
        config,
        packet,
        "schedule-v25",
        missingAuthorRunner,
        {},
      ),
      /did not return structured GitHub comment data/,
    );
  });

  it("reserves production apply for a human with staging and restore evidence", () => {
    const packet = candidatePacket();
    const config = parseArguments([
      "--target", "production", "--candidate-sha", candidateSha, "--mode", "apply",
      "--inspection-token", buildInspectionToken(packet, "production", "pre"),
      "--confirm-project", ROLLOUT.productionRef,
      "--approval-record", "https://github.com/ronchak/Koaryu/pull/134#issuecomment-987654321",
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
        "20260820025759_roster_read_rpc.sql",
        "20260820060216_atomic_bulk_student_archive.sql",
        "20260822193000_revoke_client_read_access.sql",
        "20260823193155_revoke_public_function_execute.sql",
        "20260824190500_attest_verified_restore_manifest.sql",
        "20260825042838_schedule_window_read_rpc.sql",
        "20260825043911_attest_schedule_window_release.sql",
        "20260826030234_live_billing_reconciliation_v3.sql",
        "20260826030249_payments_adjustment_convergence.sql",
        "20260826051527_billing_provider_operations_and_payer_consent.sql",
        "20260826073728_billing_provider_operation_steps.sql",
        "20260826102840_enrollment_period_safe_transitions.sql",
        "20260826155911_payments_workflow_catalog_and_replay_repairs.sql",
        "20260826185651_payment_refund_payer_sync_resource_ownership.sql",
      ],
    );
    assert.notEqual(staffIdentityPacket.sourceManifestSha256, packet.sourceManifestSha256);
    assert.equal(
      buildProductionConfirmationPhrase(staffIdentityPacket),
      [
        "APPLY 16 MIGRATIONS FROM",
        candidateSha,
        "MANIFEST",
        staffIdentityPacket.sourceManifestSha256,
        "TO",
        ROLLOUT.productionRef,
      ].join(" "),
    );
  });
});
