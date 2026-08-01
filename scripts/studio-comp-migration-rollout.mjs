#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");

export const ROLLOUT = Object.freeze({
  cliVersion: "2.95.4",
  stagingRef: "nxgsektqsgrtyfhawxbc",
  productionRef: "mimguepumzsgmcaycdsh",
  preHistory: "84:57ae4269ef4d75c249d59ef297661a3a",
  requiredAncestry: Object.freeze([
    "d12f5b8cb7fabf82383227a0e5d41113d32ff928",
    "a615bdfc9755b6c3e611e9f8829fdaf387b4f981",
  ]),
  migrations: Object.freeze([
    Object.freeze({
      filename: "20260727100000_atomic_studio_comp_management.sql",
      sha256: "2cd1e15dbe5a8224a0e4829bc92c6b01aae4699006d603d613d18cb4bc82c5c6",
    }),
    Object.freeze({
      filename: "20260727110000_order_billing_events_after_studio_comps.sql",
      sha256: "22faa79522ba2018780fb260401cd23830df553ee3faf0546b2af689eb51bfc0",
    }),
  ]),
});

const HISTORY_SCHEMA_SQL = `
select
  count(*) filter (where column_name ~* '(hash|checksum|digest)')::text
  || ':' ||
  count(*) filter (
    where column_name = 'statements'
      and data_type = 'ARRAY'
      and udt_name = '_text'
  )::text
  || ':' ||
  count(*) filter (where column_name = 'version')::text
  || ':' ||
  count(*) filter (where column_name = 'name')::text
  || ':' ||
  count(*) filter (where column_name not in ('version', 'name', 'statements'))::text
  as history_schema
from information_schema.columns
where table_schema = 'supabase_migrations'
  and table_name = 'schema_migrations'
`;

const HISTORY_SQL = `
select count(*)::text || ':' ||
       md5(string_agg(version || ':' || name, '|' order by version))
  as history_state
from supabase_migrations.schema_migrations
`;

const TARGET_HISTORY_SQL = `
select coalesce(
         string_agg(version || ':' || name, '|' order by version),
         ''
       ) as target_history
from supabase_migrations.schema_migrations
where version >= '20260727100000'
`;

const OBJECT_COUNTS_SQL = `
select
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'preserve_studio_comp_provenance',
        'set_studio_comp_atomic',
        'clear_studio_comp_for_billing_event'
      ))::text
  || ':' ||
  (select count(*)
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'studio_subscriptions'
      and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
      and not t.tgisinternal)::text
  as object_counts
`;

const FUNCTION_STATE_SQL = `
with expected(signature, expected_config, service_execute) as (
  values
    (
      'public.preserve_studio_comp_provenance()',
      array['search_path=pg_catalog']::text[],
      false
    ),
    (
      'public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)',
      array['search_path=public, pg_temp']::text[],
      true
    ),
    (
      'public.clear_studio_comp_for_billing_event(uuid, bigint)',
      array['search_path=public, pg_temp']::text[],
      true
    )
),
actual as (
  select
    format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) as signature,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    owner.rolname as owner_name,
    p.prosecdef,
    p.proconfig,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        join pg_roles granted on granted.oid = acl.grantee
       where granted.rolname = 'service_role'
         and acl.privilege_type = 'EXECUTE'
         and not acl.is_grantable
    ) as service_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        left join pg_roles granted on granted.oid = acl.grantee
       where acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and not (
           granted.rolname = 'service_role'
           and p.proname in (
             'set_studio_comp_atomic',
             'clear_studio_comp_for_billing_event'
           )
           and not acl.is_grantable
         )
    ) as unexpected_execute_grant
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner on owner.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'preserve_studio_comp_provenance',
      'set_studio_comp_atomic',
      'clear_studio_comp_for_billing_event'
    )
),
compared as (
  select
    e.signature,
    a.definition_md5,
    a.owner_name,
    a.prosecdef,
    a.proconfig,
    a.public_execute,
    a.anon_execute,
    a.authenticated_execute,
    a.service_execute,
    a.unexpected_execute_grant,
    e.expected_config,
    e.service_execute as expected_service_execute
  from expected e
  full join actual a using (signature)
)
select
  count(definition_md5)::text || ':' ||
  coalesce(
    md5(string_agg(
      signature || ':' || definition_md5 || ':' || owner_name || ':' ||
      prosecdef::text || ':' || array_to_string(proconfig, ',') || ':' ||
      public_execute::text || ':' || anon_execute::text || ':' ||
      authenticated_execute::text || ':' || service_execute::text,
      '|' order by signature
    )),
    md5('')
  ) || ':' ||
  count(*) filter (
    where definition_md5 is null
       or owner_name <> 'postgres'
       or prosecdef
       or proconfig is distinct from expected_config
       or public_execute
       or anon_execute
       or authenticated_execute
       or service_execute is distinct from expected_service_execute
       or unexpected_execute_grant
  )::text as function_state
from compared
`;

const TRIGGER_STATE_SQL = `
with actual as (
  select
    t.oid,
    md5(pg_get_triggerdef(t.oid)) as definition_md5,
    t.tgenabled,
    t.tgtype,
    t.tgattr::text as trigger_attributes,
    metadata.attnum::text as metadata_attribute,
    table_owner.rolname as table_owner,
    fn_namespace.nspname as function_schema,
    fn.proname as function_name,
    oidvectortypes(fn.proargtypes) as function_arguments
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_roles table_owner on table_owner.oid = c.relowner
  join pg_proc fn on fn.oid = t.tgfoid
  join pg_namespace fn_namespace on fn_namespace.oid = fn.pronamespace
  join pg_attribute metadata
    on metadata.attrelid = c.oid
   and metadata.attname = 'metadata'
   and not metadata.attisdropped
  where n.nspname = 'public'
    and c.relname = 'studio_subscriptions'
    and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
    and not t.tgisinternal
)
select
  count(*)::text || ':' ||
  coalesce(
    md5(string_agg(definition_md5 || ':' || table_owner, '|' order by definition_md5)),
    md5('')
  ) || ':' ||
  count(*) filter (
    where tgenabled <> 'O'
       or tgtype <> 19
       or trigger_attributes <> metadata_attribute
       or table_owner <> 'postgres'
       or function_schema <> 'public'
       or function_name <> 'preserve_studio_comp_provenance'
       or function_arguments <> ''
  )::text as trigger_state
from actual
`;

class RolloutError extends Error {}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function hashFile(filename) {
  return digest("sha256", fs.readFileSync(filename));
}

function assertPlainText(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RolloutError(`${name} is required.`);
  }
  if (!/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) {
    throw new RolloutError(`${name} must be plain printable ASCII without surrounding whitespace.`);
  }
  return value;
}

export function assertSafeCredentialedTransport(env) {
  const trustOverrideNames = new Set([
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ]);
  const overrideNames = Object.keys(env).filter(
    (name) =>
      /^(?:https?|all|ftp)_proxy$/i.test(name) ||
      name === "GIT_PROXY_COMMAND" ||
      trustOverrideNames.has(name),
  );
  const active = overrideNames.filter(
    (name) => typeof env[name] === "string" && env[name].length > 0,
  );
  if (active.length > 0) {
    throw new RolloutError(
      `Refusing credentialed work while ambient proxy or TLS trust override variables are present: ${active.sort().join(", ")}.`,
    );
  }
}

export function parseArguments(argv) {
  const result = {
    mode: "inspect",
    target: null,
    candidateSha: null,
    confirmProject: null,
    approvalRecord: null,
    inspectionToken: null,
    expectedProviderFingerprint: null,
    confirmedRestoreWindow: null,
    restoreDecisionAuthority: null,
    approveStagingApply: false,
    humanProductionOperator: false,
  };
  const valueOptions = new Map([
    ["--mode", "mode"],
    ["--target", "target"],
    ["--candidate-sha", "candidateSha"],
    ["--confirm-project", "confirmProject"],
    ["--approval-record", "approvalRecord"],
    ["--inspection-token", "inspectionToken"],
    ["--expected-provider-fingerprint", "expectedProviderFingerprint"],
    ["--confirmed-restore-window", "confirmedRestoreWindow"],
    ["--restore-decision-authority", "restoreDecisionAuthority"],
  ]);
  const booleanOptions = new Map([
    ["--approve-staging-apply", "approveStagingApply"],
    ["--human-production-operator", "humanProductionOperator"],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) {
      throw new RolloutError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RolloutError(`${option} requires a value.`);
      }
      result[valueOptions.get(option)] = assertPlainText(option, value);
      index += 1;
      continue;
    }
    if (booleanOptions.has(option)) {
      result[booleanOptions.get(option)] = true;
      continue;
    }
    throw new RolloutError(`Unknown option: ${option}`);
  }

  if (!new Set(["packet", "inspect", "dry-run", "apply"]).has(result.mode)) {
    throw new RolloutError("--mode must be packet, inspect, dry-run, or apply.");
  }
  if (result.mode !== "packet" && !new Set(["staging", "production"]).has(result.target)) {
    throw new RolloutError("--target must be staging or production.");
  }
  if (result.mode === "packet" && result.target !== null) {
    throw new RolloutError("--mode packet is local-only and must not specify --target.");
  }
  if (!/^[0-9a-f]{40}$/.test(result.candidateSha ?? "")) {
    throw new RolloutError("--candidate-sha must be a full lowercase 40-character commit SHA.");
  }
  if (
    result.expectedProviderFingerprint !== null &&
    !/^functions=3:[0-9a-f]{32}:0;trigger=1:[0-9a-f]{32}:0$/.test(
      result.expectedProviderFingerprint,
    )
  ) {
    throw new RolloutError("--expected-provider-fingerprint has an invalid shape.");
  }
  if (result.inspectionToken !== null && !/^[0-9a-f]{64}$/.test(result.inspectionToken)) {
    throw new RolloutError("--inspection-token has an invalid shape.");
  }
  if (new Set(["packet", "inspect"]).has(result.mode) && result.inspectionToken !== null) {
    throw new RolloutError("--inspection-token is created by inspect and cannot be supplied to inspect.");
  }
  if (new Set(["dry-run", "apply"]).has(result.mode) && result.inspectionToken === null) {
    throw new RolloutError("Target inspection evidence is required through --inspection-token.");
  }
  if (result.mode !== "apply") {
    const applyOnly = [
      result.confirmProject,
      result.approvalRecord,
      result.confirmedRestoreWindow,
      result.restoreDecisionAuthority,
      result.approveStagingApply,
      result.humanProductionOperator,
    ];
    if (applyOnly.some(Boolean)) {
      throw new RolloutError("Apply authorization options are valid only with --mode apply.");
    }
  }
  if (new Set(["packet", "dry-run"]).has(result.mode) && result.expectedProviderFingerprint) {
    throw new RolloutError(
      "--expected-provider-fingerprint is valid only for inspection comparison or production apply.",
    );
  }
  return result;
}

export function validateApplyAuthorization(config) {
  if (config.mode !== "apply") return;
  const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
  if (config.confirmProject !== projectRef) {
    throw new RolloutError(`--confirm-project must exactly equal the pinned ${config.target} ref.`);
  }
  assertPlainText("--approval-record", config.approvalRecord);
  if (config.target === "staging") {
    if (
      !config.approveStagingApply ||
      config.humanProductionOperator ||
      config.expectedProviderFingerprint ||
      config.confirmedRestoreWindow ||
      config.restoreDecisionAuthority
    ) {
      throw new RolloutError(
        "Staging apply requires --approve-staging-apply and must not use production-only authorization fields.",
      );
    }
    return;
  }
  if (!config.humanProductionOperator) {
    throw new RolloutError("Production apply requires --human-production-operator.");
  }
  if (!config.expectedProviderFingerprint) {
    throw new RolloutError(
      "Production apply requires the approved staging --expected-provider-fingerprint.",
    );
  }
  assertPlainText("--confirmed-restore-window", config.confirmedRestoreWindow);
  assertPlainText("--restore-decision-authority", config.restoreDecisionAuthority);
}

export function buildInspectionToken(packet, target, state) {
  return digest(
    "sha256",
    [packet.candidateSha, packet.postHistory, packet.sourceManifestSha256, target, state].join("|"),
  );
}

export function verifySourceTree(sourceRoot, candidateSha, commandRunner = runCommand) {
  const actualSha = commandRunner("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    label: "candidate SHA read",
  }).trim();
  if (actualSha !== candidateSha) {
    throw new RolloutError(
      `Candidate SHA mismatch: expected ${candidateSha}, found ${actualSha}.`,
    );
  }

  for (const requiredSha of ROLLOUT.requiredAncestry) {
    commandRunner("git", ["-C", sourceRoot, "merge-base", "--is-ancestor", requiredSha, candidateSha], {
      label: `required ancestry check for ${requiredSha}`,
    });
  }

  const migrationsDirectory = path.join(sourceRoot, "supabase", "migrations");
  const filenames = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (filenames.length < 86) {
    throw new RolloutError(`Candidate must contain at least 86 migrations, found ${filenames.length}.`);
  }
  for (const filename of filenames) {
    if (!/^[0-9]{14}_[A-Za-z0-9_]+\.sql$/.test(filename)) {
      throw new RolloutError(`Invalid migration filename in candidate: ${filename}`);
    }
  }

  const orderedHistory = filenames
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|");
  const preHistory = `84:${digest("md5", filenames.slice(0, 84)
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|"))}`;
  const postHistory = `${filenames.length}:${digest("md5", orderedHistory)}`;
  if (preHistory !== ROLLOUT.preHistory) {
    throw new RolloutError("Candidate's first 84 migration names do not match the production baseline.");
  }
  const expectedTail = ROLLOUT.migrations.map(({ filename }) => filename);
  if (JSON.stringify(filenames.slice(84, 86)) !== JSON.stringify(expectedTail)) {
    throw new RolloutError("The July studio-comp pair must be the first two migrations after baseline 84.");
  }

  for (const migration of ROLLOUT.migrations) {
    const actualHash = hashFile(path.join(migrationsDirectory, migration.filename));
    if (actualHash !== migration.sha256) {
      throw new RolloutError(`Source hash mismatch for ${migration.filename}.`);
    }
  }

  const pendingMigrations = filenames.slice(84);
  const pendingManifest = pendingMigrations.map((filename) => ({
    filename,
    sha256: hashFile(path.join(migrationsDirectory, filename)),
  }));
  return {
    candidateSha,
    migrationCount: filenames.length,
    postHistory,
    postTargetHistory: pendingMigrations
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    pendingMigrations,
    sourceManifestSha256: digest(
      "sha256",
      pendingManifest.map(({ filename, sha256 }) => `${filename}:${sha256}`).join("|"),
    ),
    pendingManifest,
  };
}

export function classifyStateSnapshot(snapshot, packet, expectedProviderFingerprint = null) {
  const { history, targetHistory, objectCounts, functionState, triggerState } = snapshot;
  if (snapshot.historySchema !== "0:1:1:1:0") {
    throw new RolloutError(
      "Supabase migration history did not have the expected no-hash/statement-array shape.",
    );
  }
  if (history === ROLLOUT.preHistory) {
    if (targetHistory !== "" || objectCounts !== "0:0") {
      throw new RolloutError(
        "Migration history is pre-state but studio-comp objects already exist; stop for drift review.",
      );
    }
    return { state: "pre", providerFingerprint: null };
  }
  if (history === packet.postHistory) {
    if (targetHistory !== packet.postTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Post-state history does not have the exact expected studio-comp objects.");
    }
    if (!/^3:[0-9a-f]{32}:0$/.test(functionState ?? "")) {
      throw new RolloutError("Function owner, definition, security, search path, or ACL checks failed.");
    }
    if (!/^1:[0-9a-f]{32}:0$/.test(triggerState ?? "")) {
      throw new RolloutError("Trigger definition, binding, enabled state, or metadata column check failed.");
    }
    const providerFingerprint = `functions=${functionState};trigger=${triggerState}`;
    if (expectedProviderFingerprint && providerFingerprint !== expectedProviderFingerprint) {
      throw new RolloutError("Provider fingerprint does not match the approved staging evidence.");
    }
    return { state: "post", providerFingerprint };
  }
  throw new RolloutError(
    `Unexpected migration history ${history}; expected exact pre-state or post-state.`,
  );
}

export function extractPendingMigrations(output) {
  return [...output.matchAll(/\b(20[0-9]{12}_[A-Za-z0-9_]+\.sql)\b/g)].map(
    (match) => match[1],
  );
}

export function assertExactPendingMigrations(output, packet) {
  const expected = packet.pendingMigrations;
  const actual = extractPendingMigrations(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RolloutError(
      `Dry-run migration set mismatch: expected ${expected.join(", ")}; found ${actual.join(", ") || "none"}.`,
    );
  }
  return actual;
}

function runCommand(command, args, { cwd = REPOSITORY_ROOT, env = process.env, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new RolloutError(`${label} failed (exit ${result.status ?? "unavailable"}).`);
  }
  return result.stdout;
}

function parseSingleValueCsv(output, expectedHeader) {
  if (output.includes("\r") || output.includes("\t")) {
    throw new RolloutError(`${expectedHeader} query returned noncanonical control characters.`);
  }
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  if (lines.length !== 2 || lines[0] !== expectedHeader) {
    throw new RolloutError(`${expectedHeader} query returned an unexpected CSV shape.`);
  }
  return lines[1];
}

function querySingleValue(sourceRoot, sql, header, env) {
  const output = runCommand(
    "supabase",
    ["db", "query", "--linked", "--agent=no", "--output", "csv", sql],
    { cwd: sourceRoot, env, label: `${header} read` },
  );
  return parseSingleValueCsv(output, header);
}

function readRemoteState(sourceRoot, packet, env, expectedProviderFingerprint = null) {
  const snapshot = {
    historySchema: querySingleValue(sourceRoot, HISTORY_SCHEMA_SQL, "history_schema", env),
    history: querySingleValue(sourceRoot, HISTORY_SQL, "history_state", env),
    targetHistory: querySingleValue(sourceRoot, TARGET_HISTORY_SQL, "target_history", env),
    objectCounts: querySingleValue(sourceRoot, OBJECT_COUNTS_SQL, "object_counts", env),
    functionState: null,
    triggerState: null,
  };
  if (snapshot.history === packet.postHistory && snapshot.objectCounts === "3:1") {
    snapshot.functionState = querySingleValue(
      sourceRoot,
      FUNCTION_STATE_SQL,
      "function_state",
      env,
    );
    snapshot.triggerState = querySingleValue(
      sourceRoot,
      TRIGGER_STATE_SQL,
      "trigger_state",
      env,
    );
  }
  return classifyStateSnapshot(snapshot, packet, expectedProviderFingerprint);
}

function assertLinkedProjectRef(sourceRoot, expectedRef) {
  const refPath = path.join(sourceRoot, "supabase", ".temp", "project-ref");
  const raw = fs.readFileSync(refPath, "utf8");
  if (raw !== expectedRef && raw !== `${expectedRef}\n`) {
    throw new RolloutError("Saved Supabase project ref is missing, noncanonical, or mismatched.");
  }
}

function runDryRun(sourceRoot, packet, env) {
  const output = runCommand(
    "supabase",
    ["db", "push", "--linked", "--dry-run", "--agent=no"],
    { cwd: sourceRoot, env, label: "Supabase migration dry-run" },
  );
  return assertExactPendingMigrations(output, packet);
}

export function buildProductionConfirmationPhrase(packet) {
  return [
    "APPLY",
    packet.pendingMigrations.length,
    "MIGRATIONS FROM",
    packet.candidateSha,
    "MANIFEST",
    packet.sourceManifestSha256,
    "TO",
    ROLLOUT.productionRef,
  ].join(" ");
}

async function confirmProductionApply(packet) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new RolloutError("Production apply requires an interactive human terminal.");
  }
  const expected = buildProductionConfirmationPhrase(packet);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type exactly '${expected}' to continue: `);
  prompt.close();
  if (answer !== expected) {
    throw new RolloutError("Production confirmation did not match exactly.");
  }
}

function usage() {
  return `Usage:
  node scripts/studio-comp-migration-rollout.mjs --mode packet --candidate-sha <full-sha>
  node scripts/studio-comp-migration-rollout.mjs --target <staging|production> --candidate-sha <full-sha> [--mode <inspect|dry-run|apply>]

Dry-run and apply require the inspection_token from a preceding inspect. Apply additionally requires:
  --confirm-project <exact-ref> --approval-record <durable-id-or-url>
  staging:    --approve-staging-apply
  production: --human-production-operator --expected-provider-fingerprint <staging-fingerprint>
              --confirmed-restore-window <window-or-record>
              --restore-decision-authority <named-person>

inspect is the default mode. Agents must never use production apply.`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseArguments(argv);
  validateApplyAuthorization(config);

  if (config.mode !== "packet") {
    assertSafeCredentialedTransport(env);
  }

  const cliVersion = runCommand("supabase", ["--version"], { env, label: "Supabase CLI version read" })
    .split("\n")[0];
  if (cliVersion !== ROLLOUT.cliVersion) {
    throw new RolloutError(
      `Supabase CLI version mismatch: expected ${ROLLOUT.cliVersion}, found ${cliVersion}.`,
    );
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-studio-comp-rollout-"));
  const sourceRoot = path.join(temporaryRoot, "candidate");
  let worktreeAdded = false;
  try {
    runCommand("git", ["worktree", "add", "--detach", sourceRoot, config.candidateSha], {
      label: "detached candidate worktree creation",
    });
    worktreeAdded = true;
    const packet = verifySourceTree(sourceRoot, config.candidateSha);
    if (config.mode === "packet") {
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`cli_version=${ROLLOUT.cliVersion}`);
      console.log(`pre_history=${ROLLOUT.preHistory}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log("remote_content_hashes=absent");
      return;
    }

    const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
    runCommand(
      "supabase",
      ["link", "--project-ref", projectRef, "--yes", "--agent=no"],
      { cwd: sourceRoot, env, label: "Supabase project link" },
    );
    assertLinkedProjectRef(sourceRoot, projectRef);

    const before = readRemoteState(
      sourceRoot,
      packet,
      env,
      config.mode === "inspect" ? config.expectedProviderFingerprint : null,
    );
    const inspectionToken = buildInspectionToken(packet, config.target, before.state);
    if (config.mode === "inspect") {
      console.log(`target=${config.target}`);
      console.log(`project_ref=${projectRef}`);
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log("remote_content_hashes=absent");
      console.log(`state=${before.state}`);
      console.log(`inspection_token=${inspectionToken}`);
      if (before.providerFingerprint) {
        console.log(`provider_fingerprint=${before.providerFingerprint}`);
      }
      return;
    }
    if (before.state !== "pre") {
      throw new RolloutError(`${config.mode} requires the exact 84-migration pre-state.`);
    }
    if (config.inspectionToken !== inspectionToken) {
      throw new RolloutError(
        "--inspection-token does not match the preceding inspection's candidate, target, and state.",
      );
    }

    const pending = runDryRun(sourceRoot, packet, env);
    console.log(`dry_run_migrations=${pending.join(",")}`);
    if (config.mode === "dry-run") return;

    if (config.target === "production") {
      await confirmProductionApply(packet);
    }
    try {
      runCommand("supabase", ["db", "push", "--linked", "--agent=no"], {
        cwd: sourceRoot,
        env,
        label: "Supabase migration apply",
      });
    } catch (error) {
      throw new RolloutError(
        `Migration apply failed and may have changed remote state. Stop and inspect; do not revert history or objects. ${error.message}`,
      );
    }
    const after = readRemoteState(sourceRoot, packet, env, config.expectedProviderFingerprint);
    if (after.state !== "post") {
      throw new RolloutError("Migration apply did not reach the exact expected post-state.");
    }
    console.log(`target=${config.target}`);
    console.log(`project_ref=${projectRef}`);
    console.log(`candidate_sha=${packet.candidateSha}`);
    console.log(`post_history=${packet.postHistory}`);
    console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
    console.log("state=post");
    console.log(`provider_fingerprint=${after.providerFingerprint}`);
  } finally {
    if (worktreeAdded) {
      spawnSync("git", ["worktree", "remove", "--force", sourceRoot], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: "ignore",
      });
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Studio-comp migration rollout refused: ${error.message}`);
    console.error(usage());
    process.exitCode = error instanceof RolloutError ? 1 : 2;
  });
}
