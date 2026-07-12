import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const configDir = path.join(rootDir, "config", "recovery");
const fixtureDir = path.join(scriptDir, "fixtures", "recovery");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const fixture = (name) => readJson(path.join(fixtureDir, name));
const schema = (name) => readJson(path.join(configDir, name));
const clone = (value) => JSON.parse(JSON.stringify(value));

const metadata = fixture("backup-set-metadata.json");
const projectConfig = fixture("project-config-manifest.json");
const restoreIntegrity = fixture("restore-integrity-manifest.json");
const classificationSource = fixture("classification-source.json");
const classificationPolicy = readJson(
  path.join(configDir, "production-data-classification-policy.json"),
);
const approvedAdapters = readJson(
  path.join(configDir, "approved-provider-adapters.json"),
);

const classificationResult = spawnSync(
  "python3",
  [
    "-c",
    [
      "import json,sys",
      "from pathlib import Path",
      "sys.path.insert(0, 'scripts')",
      "import recovery_tooling as r",
      "source=json.loads(Path('scripts/fixtures/recovery/classification-source.json').read_text())",
      "policy=json.loads(Path('config/recovery/production-data-classification-policy.json').read_text())",
      "print(json.dumps(r.build_classification_manifest(source, policy, generated_at='2026-07-12T12:01:00Z'))) ",
    ].join(";"),
  ],
  { cwd: rootDir, encoding: "utf8" },
);
assert.equal(classificationResult.status, 0, classificationResult.stderr);
const classificationManifest = JSON.parse(classificationResult.stdout);

const artifactRoles = {
  "roles.sql.gpg": "database_roles",
  "schema.sql.gpg": "database_schema",
  "data.sql.gpg": "database_data",
  "migration-history-schema.sql.gpg": "migration_history_schema",
  "migration-history-data.sql.gpg": "migration_history_data",
  "project-config-manifest.json.gpg": "project_configuration",
  "restore-integrity-manifest.json.gpg": "restore_integrity",
  "classification-source.json.gpg": "classification_source",
  "record-classification-manifest.json.gpg": "record_classification",
  "storage-objects.tar.gpg": "storage_objects",
};
const contractArtifacts = new Set([
  "project-config-manifest.json.gpg",
  "restore-integrity-manifest.json.gpg",
  "classification-source.json.gpg",
  "record-classification-manifest.json.gpg",
]);
const backupManifest = {
  schema_version: 1,
  backup_set_id: metadata.backup_set_id,
  created_at: "2026-07-12T12:03:00Z",
  source: clone(metadata.source),
  tools: clone(metadata.tools),
  encryption: clone(metadata.encryption),
  retention_class: metadata.retention_class,
  artifacts: Object.entries(artifactRoles).map(([name, role]) => ({
    name,
    role,
    size_bytes: 1,
    sha256: `sha256:${"3".repeat(64)}`,
    plaintext_size_bytes: 1,
    plaintext_sha256: `sha256:${"4".repeat(64)}`,
    ...(contractArtifacts.has(name)
      ? { plaintext_contract_sha256: `sha256:${"4".repeat(64)}` }
      : {}),
  })),
};

const downloadedNames = [
  ...Object.keys(artifactRoles),
  "backup-manifest.json.gpg",
].sort();
const providerReceipt = {
  schema_version: 1,
  evidence_scope: "untrusted_adapter_attestation",
  backup_set_id: metadata.backup_set_id,
  provider: "fixture-cloud",
  container_id: "fixture-container",
  object_set_id: "fixture-object-set",
  downloaded_at: "2026-07-12T12:02:00Z",
  operator_id: "fixture-operator",
  expected_manifest_sha256: `sha256:${"1".repeat(64)}`,
  objects: downloadedNames.map((name, index) => ({
    name,
    object_id: `object.${index + 1}`,
    version_id: `version.${index + 1}`,
    size_bytes: 1,
    sha256: `sha256:${"2".repeat(64)}`,
  })),
};

const contracts = new Map([
  ["backup-set-metadata.schema.json", metadata],
  ["backup-set-manifest.schema.json", backupManifest],
  ["classification-source.schema.json", classificationSource],
  ["classification-manifest.schema.json", classificationManifest],
  ["project-config-manifest.schema.json", projectConfig],
  ["provider-download-receipt.schema.json", providerReceipt],
  ["restore-integrity-manifest.schema.json", restoreIntegrity],
  ["production-data-classification-policy.schema.json", classificationPolicy],
  ["approved-provider-adapters.schema.json", approvedAdapters],
]);

// `contains` and conditional subschemas inherit types/properties from their
// parent schemas. Disable only Ajv's redundant inheritance warnings; keep every
// other strict check on.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
addFormats(ajv);
const validators = new Map(
  [...contracts.keys()].map((name) => [name, ajv.compile(schema(name))]),
);

function assertValid(schemaName, value) {
  const validate = validators.get(schemaName);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function assertInvalid(schemaName, value) {
  const validate = validators.get(schemaName);
  assert.equal(validate(value), false, "Expected Draft 2020-12 schema rejection");
}

test("all recovery schemas compile as Draft 2020-12 and validate representative contracts", () => {
  assert.equal(contracts.size, 9);
  for (const [schemaName, value] of contracts) {
    assertValid(schemaName, value);
  }
});

test("versioned schemas reject weak encryption and unsafe identifier lists", () => {
  const weakMetadata = clone(metadata);
  weakMetadata.encryption.s2k_count = 65_536;
  assertInvalid("backup-set-metadata.schema.json", weakMetadata);

  const unsafeSchema = clone(projectConfig);
  unsafeSchema.data_api.exposed_schemas = ["public schema"];
  assertInvalid("project-config-manifest.schema.json", unsafeSchema);

  const unsafeRealtime = clone(projectConfig);
  unsafeRealtime.realtime.publications = ["bad publication"];
  assertInvalid("project-config-manifest.schema.json", unsafeRealtime);

  const unsafeColumn = clone(restoreIntegrity);
  unsafeColumn.migration_history.columns.push("bad col");
  assertInvalid("restore-integrity-manifest.schema.json", unsafeColumn);

  const unsafeExtension = clone(restoreIntegrity);
  unsafeExtension.catalog.extensions = ["pg crypto"];
  assertInvalid("restore-integrity-manifest.schema.json", unsafeExtension);

  const unsafePublication = clone(restoreIntegrity);
  unsafePublication.catalog.publications = ["bad publication"];
  assertInvalid("restore-integrity-manifest.schema.json", unsafePublication);
});

test("adapter schema rejects known execution-control environment families", () => {
  for (const name of [
    "PATH",
    "NODE_OPTIONS",
    "RUBYOPT",
    "PERL5OPT",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "LD_AUDIT",
    "LD_PROFILE",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_FRAMEWORK_PATH",
  ]) {
    assertInvalid("approved-provider-adapters.schema.json", {
      schema_version: 1,
      adapters: [
        {
          profile_id: "fixture-provider-v1",
          provider: "fixture-cloud",
          locator_scheme: "s3",
          adapter_sha256: `sha256:${"0".repeat(64)}`,
          allowed_environment_variables: [name],
        },
      ],
    });
  }
});
