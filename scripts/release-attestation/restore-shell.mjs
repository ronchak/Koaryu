import fs from "node:fs";
import { releaseState } from "./states.mjs";

const sourceArgs = '${source_args[@]}';
const restoredArgs = '${restored_args[@]}';
const argumentNames = ["pg_dump_bin", "pg_restore_bin", "createdb_bin", "psql_bin", "socket_dir", "pg_port", "temp_dir", "repository_root"];

function doubleQuoted(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function readinessSql(state, shape = "short") {
  if (!["short", "full", "diagnostic", "failures"].includes(shape)) {
    throw new Error(`Unknown readiness shape: ${shape}`);
  }
  const fields = ["ready::TEXT", "migration_count::TEXT", "migration_head"];
  if (shape === "full") fields.push("array_to_string(pending_versions, ',')");
  if (shape !== "failures") fields.push("cardinality(security_failures)::TEXT");
  if (["diagnostic", "failures", "full"].includes(shape)) {
    fields.push("COALESCE(array_to_string(security_failures,','),'')");
  }
  fields.push("manifest_version");
  return `SELECT ${fields.join(" || '|' || ")} FROM ${state.preflight};`;
}

export function readinessExpected(state, shape = "short") {
  if (!["short", "full", "diagnostic", "failures"].includes(shape)) {
    throw new Error(`Unknown readiness shape: ${shape}`);
  }
  const fields = ["true", state.count, state.head];
  if (shape === "full") fields.push(state.pending.join(","));
  if (shape !== "failures") fields.push(0);
  if (["diagnostic", "failures", "full"].includes(shape)) fields.push("");
  fields.push(state.manifestVersion);
  return fields.join("|");
}

export function shellHeader(filename, { pairedArguments = false } = {}) {
  const assignments = argumentNames.map((name, index) => `${name}="$${index + 1}"`);
  const argumentsText = pairedArguments
    ? [assignments.slice(0, 4).join("; "), assignments.slice(4).join("; ")].join("\n")
    : assignments.join("\n");
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 8 ]]; then
  echo "Usage: ${filename} pg_dump pg_restore createdb psql host port temp-dir repository-root" >&2
  exit 2
fi

${argumentsText}`;
}

export function shellConnections() {
  return String.raw`source_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
restored_args=(--host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)`;
}

export function shellCleanup() {
  return String.raw`cleanup() {
  "$psql_bin" "${sourceArgs}" --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup`;
}

export function shellApplyHelper({ spacedHistory = false, blankBeforeCommand = false } = {}) {
  const history = spacedHistory
    ? "schema_migrations (version,name) VALUES ('$version','$name');"
    : "schema_migrations(version,name) VALUES ('$version','$name');";
  return String.raw`apply_migration() {
  local version="$1"
  local name="$2"
${blankBeforeCommand ? "\n" : ""}  "$psql_bin" "${restoredArgs}" --single-transaction \
    --file="$repository_root/supabase/migrations/${'${version}_${name}'}.sql" \
    --command="INSERT INTO supabase_migrations.${history}"
}`;
}

export function shellDumpRestore(database) {
  return String.raw`"$pg_dump_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname=postgres --no-password --format=custom --file="$dump_path"
"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restoredArgs}" --command='ALTER DATABASE ${database} SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres --dbname="$restored_database" --no-password --exit-on-error "$dump_path"`;
}

export function shellRead(variable, query, { source = false, helper = null, quote = "auto" } = {}) {
  if (!["auto", "double"].includes(quote)) throw new Error(`Unknown shell query quoting: ${quote}`);
  const quoted = quote === "double" || query.includes("'") ? doubleQuoted(query) : `'${query}'`;
  const command = helper
    ? `${helper} ${quoted}`
    : String.raw`"$psql_bin" "${source ? sourceArgs : restoredArgs}" --tuples-only --no-align --command=${quoted} | tr -d '\r\n'`;
  return `${variable}="$(${command})"`;
}

export function shellAssert(variable, expected, message) {
  return String.raw`if [[ "$${variable}" != "${expected}" ]]; then
  echo "${message}" >&2
  exit 1
fi`;
}

function applyBetween(previous, next, filenames) {
  return filenames.filter(name => name.slice(0, 14) > previous.head && name.slice(0, 14) <= next.head)
    .sort()
    .map(name => `apply_migration "${name.slice(0, 14)}" "${name.slice(15, -4)}"`).join("\n");
}

export function renderV24Restore(filenames, versions) {
  const source = releaseState("v24", versions);
  const schedule = releaseState("schedule-v25", versions);
  const payment = releaseState("v25", versions);
  const database = "koaryu_v25_restore_contract";
  const blocks = [
    `${shellHeader("scripts/verify-v24-v25-restore-contract.sh", { pairedArguments: true })}\nrestored_database="${database}"\ndump_path="$temp_dir/v24-before-v25.dump"\n${shellConnections()}`,
    shellApplyHelper({ spacedHistory: true, blankBeforeCommand: true }),
    shellCleanup(),
    `${shellRead("predecessor_readiness", readinessSql(source), { source: true })}\n${shellAssert("predecessor_readiness", readinessExpected(source), "Source database is not the exact ready V24 predecessor: $predecessor_readiness")}`,
    shellDumpRestore(database),
    `${shellRead("restored_predecessor", readinessSql(source))}\n${shellAssert("restored_predecessor", "$predecessor_readiness", "Restored V24 predecessor readiness drifted: $restored_predecessor")}`,
    applyBetween(source, schedule, filenames),
    `${shellRead("restored_schedule_readiness", readinessSql(schedule))}\n${shellAssert("restored_schedule_readiness", readinessExpected(schedule), "Restored schedule V25 readiness did not match exact post-state: $restored_schedule_readiness")}`,
    `${shellRead("restored_schedule_v24_compat", readinessSql(source))}\n${shellAssert("restored_schedule_v24_compat", readinessExpected(source), "Restored schedule V25 did not preserve exact V24 compatibility: $restored_schedule_v24_compat")}`,
    applyBetween(schedule, payment, filenames),
    `${shellRead("restored_readiness", readinessSql(payment))}\n${shellAssert("restored_readiness", readinessExpected(payment), "Restored Payments V25 readiness did not match exact post-state: $restored_readiness")}`,
    `${shellRead("restored_schedule_compat", readinessSql(schedule))}\n${shellAssert("restored_schedule_compat", readinessExpected(schedule), "Restored Payments V25 did not preserve exact schedule V25 compatibility: $restored_schedule_compat")}`,
    `${shellRead("restored_v24_compat", readinessSql(source))}\n${shellAssert("restored_v24_compat", readinessExpected(source), "Restored Payments V25 did not preserve exact V24 compatibility: $restored_v24_compat")}`,
    `${shellRead("actual_contract", "SELECT private.koaryu_release_operational_contract_v25();")}\nexpected_contract="0:bde4877c461840d0f1e42fe3faccaddad8ae8c97ca7cde1a7a2ba1cee1fda0c4"\n${shellAssert("actual_contract", "$expected_contract", "Restored V25 operational contract did not match its expectation.")}`,
    [
      ["RESTORED_V24_PREDECESSOR_READINESS", "restored_predecessor"],
      ["RESTORED_SCHEDULE_V25_READINESS", "restored_schedule_readiness"],
      ["RESTORED_SCHEDULE_V25_COMPAT_V24_READINESS", "restored_schedule_v24_compat"],
      ["RESTORED_PAYMENTS_V25_READINESS", "restored_readiness"],
      ["RESTORED_PAYMENTS_V25_COMPAT_SCHEDULE_READINESS", "restored_schedule_compat"],
      ["RESTORED_PAYMENTS_V25_COMPAT_V24_READINESS", "restored_v24_compat"],
      ["RESTORED_V25_OPERATIONAL_CONTRACT", "actual_contract"],
    ].map(([label, variable]) => `echo "${label}=$${variable}"`).join("\n")
      + '\necho "PASS: V24 dump/restore, schedule migrations 118-119, and Payments migration 120 produced the exact accepted V25 compatibility chain."',
  ];
  return blocks.join("\n\n") + "\n";
}

export function shellDirectMigration(state, filenames) {
  const filename = filenames.find(name => name.startsWith(`${state.head}_`));
  if (!filename) throw new Error(`Missing migration for ${state.id}`);
  const name = filename.slice(15, -4);
  return String.raw`"$psql_bin" "${restoredArgs}" --single-transaction \
  --file="$repository_root/supabase/migrations/${filename}" \
  --command="INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('${state.head}','${name}');"`;
}

export function shellImportedRead(sqlVariable, exportedName, resultVariable) {
  return String.raw`${sqlVariable}="$(cd "$repository_root" && node --input-type=module --eval "import {${exportedName}} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(${exportedName});")"
${resultVariable}="$("$psql_bin" "${restoredArgs}" --tuples-only --no-align --command="$${sqlVariable}" | tr -d '\r\n')"`;
}

export function shellNodeValidators(imports, calls) {
  return String.raw`(
  cd "$repository_root"
  node --input-type=module --eval '
    import {
${imports.map(name => `      ${name},`).join("\n")}
    } from "./scripts/studio-comp-migration-rollout.mjs";
${calls.map(([name], index) => `    ${name}(process.argv[${index + 1}]);`).join("\n")}
  ' \
${calls.map(([, variable]) => `    "$${variable}"`).join(" \\\n")}
)`;
}

export function renderV27Restore(filenames, versions) {
  const target = releaseState("v27", versions);
  const database = "koaryu_v27_restore_contract";
  const manifests = [
    ["provider_manifest", "koaryu_release_provider_operations_manifest_v27", "RESTORED_V27_PROVIDER_MANIFEST", "0:33ef02ac5db886e340359ee735d5dd3d152cda3538be270903a2302dba3d29f8", "Restored V27 provider manifest mismatch."],
    ["operational_contract", "koaryu_release_operational_contract_v27", "RESTORED_V27_OPERATIONAL_CONTRACT", "0:4941584e8e00ddcd4aab5c8f9020d9972b1b349e164696c6f0120f25fcfbbd66", "Restored V27 operational contract mismatch."],
    ["operational_manifest", "koaryu_release_operational_manifest_v8", "RESTORED_V27_OPERATIONAL_MANIFEST", "a39c7435974be19b4a5f41d5a536402a16b429ec6d5ae1f9b8df81d95921ac91", "Restored V27 operational manifest mismatch."],
    ["operational_manifest_v7", "koaryu_release_operational_manifest_v7", "RESTORED_V27_OPERATIONAL_MANIFEST_V7"],
  ];
  const imported = [
    ["catalog_sql", "CATALOG_STATE_SQL", "catalog_state", "RESTORED_V27_CATALOG_STATE"],
    ["v26_expectation_sql", "V26_EXPECTATION_STATE_SQL", "v26_expectation_state", "RESTORED_V27_COMPAT_V26_EXPECTATION_STATE"],
    ["v27_expectation_sql", "V27_EXPECTATION_STATE_SQL", "v27_expectation_state", "RESTORED_V27_EXPECTATION_STATE"],
    ["readiness_sql", "V27_OPERATIONAL_READINESS_SQL", "full_readiness", "RESTORED_V27_FULL_READINESS"],
  ];
  const assertions = [...manifests.filter(row => row[3]).map(([variable, , , expected, message]) => [variable, expected, message]),
    ["readiness", readinessExpected(target), "Restored V27 readiness mismatch: $readiness"]];
  return [
    `${shellHeader("scripts/verify-v26-v27-restore-contract.sh")}\nrestored_database="${database}"\ndump_path="$temp_dir/v26-before-v27.dump"\n${shellConnections()}`,
    shellCleanup(),
    `${shellDumpRestore(database)}\n${shellDirectMigration(target, filenames)}`,
    [
      ...manifests.map(([variable, name]) => shellRead(variable, `SELECT private.${name}();`)),
      shellRead("readiness", readinessSql(target)),
      ...imported.map(([variable, name, result]) => shellImportedRead(variable, name, result)),
    ].join("\n"),
    [...manifests.map(([variable, , label]) => [label, variable]), ["RESTORED_V27_READINESS", "readiness"],
      ...imported.map(([, , variable, label]) => [label, variable])]
      .map(([label, variable]) => `echo "${label}=$${variable}"`).join("\n"),
    assertions.map(([variable, expected, message]) => `if [[ "$${variable}" != "${expected}" ]]; then echo "${message}" >&2; exit 1; fi`).join("\n"),
    shellNodeValidators([
      "validateOperationalManifest", "validateV27OperationalReadiness", "validateV27CatalogState",
      "validateV27CompatV26ExpectationState", "validateV27ExpectationState",
    ], [
      ["validateOperationalManifest", "operational_manifest_v7"],
      ["validateV27CatalogState", "catalog_state"],
      ["validateV27CompatV26ExpectationState", "v26_expectation_state"],
      ["validateV27ExpectationState", "v27_expectation_state"],
      ["validateV27OperationalReadiness", "full_readiness"],
    ]),
    `echo "PASS: V26 dump/restore then migration ${target.count} produced the exact accepted V27 contract."`,
  ].join("\n\n") + "\n";
}

function shellRestoreExisting(database) {
  return String.raw`"$createdb_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --no-password --owner=postgres --template=template0 "$restored_database"
"$psql_bin" "${restoredArgs}" \
  --command='ALTER DATABASE ${database} SET search_path TO "$user", public, extensions;'
"$pg_restore_bin" --host="$socket_dir" --port="$pg_port" --username=postgres \
  --dbname="$restored_database" --no-password --exit-on-error "$dump_path"`;
}

function requireV26Dump() {
  return String.raw`if [[ ! -f "$dump_path" ]]; then
  echo "Verified V26 restore artifact is missing: $dump_path" >&2
  exit 1
fi`;
}

function expectationSql(version, shape) {
  if (shape === "row") {
    return `SELECT '1:' || encode(extensions.digest(convert_to('operational_contract_v${version}:' || expected_sha256,'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v${version}_expectations WHERE expectation_key='operational_contract_v${version}';`;
  }
  if (shape !== "rows") throw new Error(`Unknown expectation shape: ${shape}`);
  return `SELECT count(*)::TEXT || ':' || encode(extensions.digest(convert_to(COALESCE(string_agg(expectation_key || ':' || expected_sha256, '|' ORDER BY expectation_key COLLATE "C"),''),'UTF8'),'sha256'),'hex') FROM private.koaryu_release_v${version}_expectations;`;
}

function renderProbe(probe, versions) {
  if (probe.kind === "export") {
    return String.raw`${probe.name}="$(cd "$repository_root" && node --input-type=module --eval "import {${probe.export}} from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(${probe.export});")"`;
  }
  if (probe.kind === "variable") {
    return probe.helper
      ? `${probe.name}="$(${probe.helper} "$${probe.variable}")"`
      : String.raw`${probe.name}="$("$psql_bin" "${restoredArgs}" --tuples-only --no-align --command="$${probe.variable}" | tr -d '\r\n')"`;
  }
  let query;
  if (probe.kind === "manifest") query = `SELECT ${probe.signature};`;
  else if (probe.kind === "readiness") query = readinessSql(releaseState(probe.state, versions), probe.shape);
  else if (probe.kind === "expectation") query = expectationSql(probe.version, probe.shape);
  else if (probe.kind === "observation") query = probe.sql;
  else throw new Error(`Unknown restore probe: ${probe.kind}`);
  return shellRead(probe.name, query, { helper: probe.helper, quote: probe.quote });
}

function renderProbeAssertion(assertion, versions) {
  const expected = assertion.readiness
    ? readinessExpected(releaseState(assertion.readiness.state, versions), assertion.readiness.shape)
    : assertion.expected;
  if (assertion.inline) {
    return `if [[ "$${assertion.variable}" != "${expected}" ]]; then echo "${assertion.message}" >&2; exit 1; fi`;
  }
  return shellAssert(assertion.variable, expected, assertion.message);
}

function helperReadValue() {
  return String.raw`read_value() {
  "$psql_bin" "${restoredArgs}" --tuples-only --no-align --command="$1" | tr -d '\r\n'
}`;
}

export function renderChainedShellRestore(id, specification, filenames, versions) {
  if (!["v28", "v29", "v30"].includes(id)) throw new Error(`Unknown historical shell layout: ${id}`);
  const target = releaseState(id, versions);
  const predecessor = releaseState(specification.predecessor, versions);
  const source = releaseState(specification.source, versions);
  const database = `koaryu_${id}_restore_contract`;
  const header = `${shellHeader(specification.file)}\nrestored_database="${database}"\n`
    + (id === "v28" ? "" : 'dump_path="$temp_dir/v26-before-v27.dump"\n') + shellConnections();
  const blocks = [header, shellCleanup()];
  const restore = shellRestoreExisting(database);
  const migrationFiles = filenames.filter(name => name.slice(0, 14) > source.head && name.slice(0, 14) <= predecessor.head).sort();
  if (id === "v28") {
    blocks.push('dump_path="$temp_dir/v26-before-v27.dump"\n' + requireV26Dump() + "\n" + restore + "\n"
      + shellDirectMigration(predecessor, filenames) + "\n"
      + shellRead("predecessor_readiness", readinessSql(predecessor, "failures")) + "\n"
      + shellRead("predecessor_provider_manifest", "SELECT private.koaryu_release_provider_operations_manifest_v27();") + "\n"
      + shellRead("predecessor_operational_contract", "SELECT private.koaryu_release_operational_contract_v27();") + "\n"
      + 'echo "RESTORED_V27_PREDECESSOR_READINESS=$predecessor_readiness"\n'
      + 'echo "RESTORED_V27_PREDECESSOR_PROVIDER_MANIFEST=$predecessor_provider_manifest"\n'
      + 'echo "RESTORED_V27_PREDECESSOR_OPERATIONAL_CONTRACT=$predecessor_operational_contract"\n'
      + shellDirectMigration(target, filenames));
  } else {
    blocks.push(requireV26Dump() + (id === "v30" ? "\n\n" : "\n") + restore
      + (id === "v29" ? "\n" + migrationFiles.map(filename => {
        const version = filename.slice(0, 14);
        return shellDirectMigration({ head: version, id: version }, filenames);
      }).join("\n") : ""));
    if (id === "v30") blocks.push(shellApplyHelper(), applyBetween(source, predecessor, filenames));
    blocks.push(shellRead("predecessor_readiness", readinessSql(predecessor)) + "\n"
      + shellAssert("predecessor_readiness", readinessExpected(predecessor), "Restored V28 predecessor readiness mismatch: $predecessor_readiness"));
    if (id === "v30") {
      blocks[blocks.length - 1] = shellRead("predecessor_readiness", readinessSql(predecessor, "diagnostic")) + "\n"
        + shellAssert("predecessor_readiness", readinessExpected(predecessor, "diagnostic"), "Restored V29 predecessor readiness mismatch: $predecessor_readiness");
      blocks.push(applyBetween(predecessor, target, filenames), helperReadValue());
    } else blocks.push(shellDirectMigration(target, filenames));
  }
  blocks.push(specification.probes.map(probe => renderProbe(probe, versions)).join("\n"));
  blocks.push(specification.echoes.map(({ label, variable }) => `echo "${label}=$${variable}"`).join("\n"));
  blocks.push(specification.assertions.map(assertion => renderProbeAssertion(assertion, versions)).join("\n"));
  const validator = id === "v28" ? "validateV27CatalogState" : "validateCatalogState";
  blocks.push(String.raw`(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { ${validator} } from './scripts/studio-comp-migration-rollout.mjs'; ${validator}(process.argv[1]);" \
    "$catalog_state"
)`);
  if (specification.negativeProbes.length) {
    blocks.push(specification.negativeProbes.flatMap(probe => [renderProbe(probe, versions),
      renderProbeAssertion(specification.negativeAssertions.find(assertion => assertion.variable === probe.name), versions)]).join("\n"));
  }
  const messages = {
    v28: "V27 dump/restore then migration 123 produced the exact V28 step contract.",
    v29: "V28 dump/restore then migration 124 produced the V29 transition contract.",
    v30: "V29 dump/restore predecessor plus migration 125 produced the exact V30 operation-bound contract.",
  };
  blocks.push(`echo "PASS: ${messages[id]}"`);
  return blocks.join("\n\n") + "\n";
}

function expandedCommand(prefix, arguments_) {
  return prefix + " \\\n" + arguments_.map(argument => `  ${argument}`).join(" \\\n");
}

function expandedRead(variable, query, { variableQuery = false, trim = true } = {}) {
  const quoted = variableQuery ? `"$${query}"` : query.includes("'") ? doubleQuoted(query) : `'${query}'`;
  return String.raw`${variable}="$(
  "$psql_bin" "${restoredArgs}" --tuples-only --no-align \
    --command=${quoted}
)"` + (trim ? "\n" + trimRead(variable) : "");
}

function trimRead(variable) {
  return String.raw`${variable}="$(printf '%s' "$${variable}" | tr -d '\r\n')"`;
}

function expandedImport(variable, exportedName) {
  return String.raw`${variable}="$(
  cd "$repository_root"
  node --input-type=module --eval \
    "import { ${exportedName} } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(${exportedName});"
)"`;
}

export function renderV26Restore(filenames, versions) {
  const state = releaseState("v26", versions);
  const filename = filenames.find(name => name.startsWith(`${state.head}_`));
  const name = filename.slice(15, -4);
  const connection = ['--host="$socket_dir"', '--port="$pg_port"', "--username=postgres"];
  const queryFlags = ["--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet"];
  const array = (name, database) => `${name}=(\n${[...connection, database, ...queryFlags].map(flag => `  ${flag}`).join("\n")}\n)`;
  const blocks = [
    shellHeader("scripts/verify-v25-v26-restore-contract.sh")
      + '\nrestored_database="koaryu_v26_restore_contract"\ndump_path="$temp_dir/v25-before-v26.dump"',
    array("source_args", "--dbname=postgres") + "\n" + array("restored_args", '--dbname="$restored_database"'),
    String.raw`cleanup() {
  "$psql_bin" "${sourceArgs}" \
    --command="DROP DATABASE IF EXISTS $restored_database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM`,
    "cleanup",
    expandedCommand('"$pg_dump_bin"', [...connection, "--dbname=postgres", "--no-password", "--format=custom", '--file="$dump_path"']),
    expandedCommand('"$createdb_bin"', [...connection, "--no-password", "--owner=postgres", "--template=template0", '"$restored_database"']),
    String.raw`"$psql_bin" "${restoredArgs}" \
  --command='ALTER DATABASE koaryu_v26_restore_contract SET search_path TO "$user", public, extensions;'`,
    expandedCommand('"$pg_restore_bin"', [...connection, '--dbname="$restored_database"', "--no-password", "--exit-on-error", '"$dump_path"']),
    expandedCommand(`"$psql_bin" "${restoredArgs}"`, ["--single-transaction", `--file="$repository_root/supabase/migrations/${filename}"`,
      `--command="INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${state.head}', '${name}');"`]),
    expandedRead("restored_operational_manifest", "SELECT private.koaryu_release_operational_manifest_v7();"),
    expandedImport("catalog_sql", "CATALOG_STATE_SQL") + "\n"
      + expandedRead("restored_catalog_state", "catalog_sql", { variableQuery: true }),
    expandedImport("expectation_sql", "V26_EXPECTATION_STATE_SQL") + "\n"
      + expandedRead("restored_expectation_state", "expectation_sql", { variableQuery: true }),
    String.raw`restored_readiness="$(
  "$psql_bin" "${restoredArgs}" --tuples-only --no-align <<'SQL'
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' ||
       cardinality(security_failures)::TEXT || '|' ||
       COALESCE(array_to_string(security_failures, ','), '') || '|' ||
       manifest_version
FROM ${state.preflight};
SQL
)"` + "\n" + trimRead("restored_readiness"),
    expandedRead("restored_operational_contract", "SELECT private.koaryu_release_operational_contract_v26();", { trim: false }) + "\n"
      + expandedRead("restored_expected_contract", "SELECT '0:' || expected_sha256 FROM private.koaryu_release_v26_expectations WHERE expectation_key = 'operational_contract_v26';", { trim: false }) + "\n"
      + trimRead("restored_operational_contract") + "\n" + trimRead("restored_expected_contract"),
    ["OPERATIONAL_MANIFEST", "CATALOG_STATE", "EXPECTATION_STATE", "READINESS", "OPERATIONAL_CONTRACT"]
      .map(label => `echo "RESTORED_V26_${label}=$restored_${label.toLowerCase()}"`).join("\n"),
    shellAssert("restored_operational_contract", "$restored_expected_contract", "Restored V26 operational contract did not match its private expectation row."),
    shellNodeValidators([
      "validateCatalogState", "validateOperationalManifest", "validateV26OperationalReadiness", "validateV26ExpectationState",
    ], [
      ["validateOperationalManifest", "restored_operational_manifest"],
      ["validateCatalogState", "restored_catalog_state"],
      ["validateV26ExpectationState", "restored_expectation_state"],
      ["validateV26OperationalReadiness", "restored_readiness"],
    ]),
    `echo "PASS: V25 dump/restore then migration ${state.count} produced the exact accepted V26 post-state."`,
  ];
  return blocks.join("\n\n") + "\n";
}

function restoreFixture(name, values = {}) {
  const source = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return source.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing fixture value ${key} in ${name}`);
    return values[key];
  }).replace(/\n$/, "");
}

export function renderV31Restore(filenames, versions, {
  continuation = "", scriptName = "scripts/verify-v30-v31-restore-contract.sh", guardLocal = false,
} = {}) {
  const source = releaseState("v26", versions);
  const predecessor = releaseState("v30", versions);
  const target = releaseState("v31", versions);
  const filename = filenames.find(name => name.startsWith(`${target.head}_`));
  const values = {
    MIGRATION_FILE: filename,
    MIGRATION_VERSION: target.head,
    MIGRATION_NAME: filename.slice(15, -4),
    CURRENT_PREFLIGHT: target.preflight,
    PREVIOUS_PREFLIGHT: predecessor.preflight,
    CURRENT_READINESS: readinessExpected(target, "diagnostic"),
    PREVIOUS_READINESS: readinessExpected(predecessor, "diagnostic"),
  };
  const readHelper = String.raw`read_restored() {
  "$psql_bin" "${restoredArgs}" --tuples-only --no-align --command="$1" | tr -d '\r\n'
}`;
  const negativeHelper = String.raw`assert_restored_preflight_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local actual_ready=""

  actual_ready="$(read_restored "BEGIN; $mutation_sql SELECT ready::TEXT FROM ${target.preflight}; ROLLBACK;")"
  if [[ "$actual_ready" != "false" ]]; then
    echo "Restored V31 preflight accepted $label." >&2
    exit 1
  fi
}`;
  const sqlBlock = name => String.raw`"$psql_bin" "${restoredArgs}" <<'SQL'
${restoreFixture(name, values)}
SQL`;
  const blocks = [
    shellHeader(scriptName)
      + '\nrestored_database="koaryu_v31_restore_contract"\ndump_path="$temp_dir/v26-before-v27.dump"\n' + shellConnections(),
    ...(guardLocal ? [String.raw`# Match the existing Python restore tools: reject routing overrides and verify
# the caller's disposable Unix-socket PostgreSQL 17 before any mutation.
while IFS= read -r pg_variable; do unset "$pg_variable"; done < <(compgen -A variable PG)
python3 - "$psql_bin" "$socket_dir" "$pg_port" "$temp_dir" "$repository_root" "$pg_dump_bin" "$pg_restore_bin" "$createdb_bin" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[5]) / "scripts"))
from local_postgres_verification import LocalPostgres
local = LocalPostgres(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
local.require_pg17(sys.argv[1], *sys.argv[6:9])
PY`] : []),
    shellCleanup(), readHelper, negativeHelper, requireV26Dump(),
    shellRestoreExisting("koaryu_v31_restore_contract"), shellApplyHelper(),
    applyBetween(source, predecessor, filenames),
    shellRead("restored_predecessor", readinessSql(predecessor, "diagnostic"), { helper: "read_restored" }) + "\n"
      + shellAssert("restored_predecessor", readinessExpected(predecessor, "diagnostic"), "Restored V30 predecessor readiness drifted: $restored_predecessor"),
    sqlBlock("v31-seed.sql"), restoreFixture("v31-upgrade-overlap.sh", values),
    restoreFixture("v31-business-state.sh", values), sqlBlock("v31-continuation.sql"),
    restoreFixture("v31-attestation-negatives.sh", values),
    ...(continuation ? [continuation] : []),
    continuation
      ? 'echo "PASS: V31 business proof and declared V32-through-V37 restored continuation completed."'
      : `echo "PASS: V30 dump/restore predecessor plus migration ${target.count} produced the exact V31 contract."`,
  ];
  return blocks.join("\n\n") + "\n";
}

export function renderV37Continuation(filenames, versions) {
  const blocks = [];
  for (const id of ["v32", "v33", "v34", "v35", "v36", "v37"]) {
    const state = releaseState(id, versions);
    blocks.push(shellDirectMigration(state, filenames) + " >/dev/null");
    if (id === "v32" || id === "v33") continue;
    const label = id.toUpperCase();
    blocks.push(String.raw`actual_catalog="$(read_restored "$catalog_sql")"
expected_catalog="$(cd "$repository_root" && node --input-type=module --eval "import { EXPECTED_${label}_RESTORED_CATALOG_STATE } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(EXPECTED_${label}_RESTORED_CATALOG_STATE);")"
echo "RESTORED_${label}_CATALOG_STATE=$actual_catalog"`);
    blocks.push(shellAssert("actual_catalog", "$expected_catalog", `Restored ${label} catalog mismatch: $actual_catalog`));
    if (id !== "v34") {
      blocks.push(shellRead("actual_readiness", readinessSql(state, "diagnostic"), { helper: "read_restored" })
        + `\necho "RESTORED_${label}_READINESS=$actual_readiness"\n`
        + shellAssert("actual_readiness", readinessExpected(state, "diagnostic"), `Restored ${label} readiness mismatch: $actual_readiness`));
    }
  }
  blocks.push(shellRead("trigger_guard", "SELECT private.koaryu_release_adjustment_trigger_guard_manifest_v37();", { helper: "read_restored" }));
  blocks.push(String.raw`expected_trigger_guard="$(cd "$repository_root" && node --input-type=module --eval "import { EXPECTED_V37_TRIGGER_GUARD_MANIFEST } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(EXPECTED_V37_TRIGGER_GUARD_MANIFEST);")"
echo "RESTORED_V37_TRIGGER_GUARD=$trigger_guard"`);
  blocks.push(shellAssert("trigger_guard", "$expected_trigger_guard", "Restored V37 adjustment trigger guard mismatch: $trigger_guard"));
  return blocks.join("\n\n");
}

export function renderExtendedV31Restore(filenames, versions) {
  return renderV31Restore(filenames, versions, {
    scriptName: "scripts/verify-v30-v37-restore-contract.sh",
    continuation: renderV37Continuation(filenames, versions),
    guardLocal: true,
  });
}
