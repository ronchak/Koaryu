import fs from "node:fs";
import schema from "./python-restore-schema.json" with { type: "json" };
import { migrationVersions, releaseState, RELEASE_STATES } from "./states.mjs";

// Only business SQL and assertions live in fixtures. Database lifecycle, history,
// pin bindings, normalization, migration execution and evidence are emitted here.
// Three historical layouts preserve their whitespace and operation ordering.
// The forward layout shares balance's canonical/restored lifecycle, but all
// domain SQL, snapshots and continuation assertions belong to explicit fixtures.
const quote = JSON.stringify;
const raw = String.raw;
const paired = spec => ["balance", "forward"].includes(spec.format);

function fixture(id, name) {
  return fs.readFileSync(new URL(`./fixtures/python-${id}-${name}.py.inc`, import.meta.url), "utf8");
}

function binding(key, versions) {
  const fact = schema.bindings[key];
  if (!fact) throw new Error(`Unknown Python restore binding: ${key}`);
  const state = releaseState(fact.state, versions);
  if (fact.kind === "export") {
    const pin = { query: fact.query, expected: fact.expected,
      ...(fact.restored ? { restored: fact.restored } : {}) };
    if (Object.values(pin).some(name => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
      throw new Error(`Invalid Python restore export binding: ${key}`);
    }
    return pin;
  }
  const version = state.manifestVersion.replace("release-db-attestation-", "").toUpperCase();
  const stems = {
    readiness: "OPERATIONAL_READINESS", catalog: "CATALOG_STATE",
    release: "RELEASE_MANIFEST", billing: "BILLING_MANIFEST",
    expectation: "EXPECTATION_STATE", "rank-command": "RANK_COMMAND_STATE",
    "payer-balance": "PAYER_BALANCE_STATE",
  };
  const stem = stems[fact.kind];
  if (!stem) throw new Error(`Unknown Python restore binding kind: ${fact.kind}`);
  let prefix = fact.queryState ? releaseState(fact.queryState, versions).id.toUpperCase() : version;
  if (fact.kind === "catalog" && !fact.queryState) prefix = "";
  // FINAL is optional spelling for the latest declared state in these inputs.
  // An undeclared candidate suffix changes inventory guards, not old aliases.
  const finalAlias = fact.kind === "readiness" && fact.finalAlias
    && !Object.values(RELEASE_STATES).some(candidate =>
      candidate.head > state.head && versions.includes(candidate.head));
  return {
    query: finalAlias ? "FINAL_OPERATIONAL_READINESS_SQL" : `${prefix ? prefix + "_" : ""}${stem}_SQL`,
    expected: finalAlias ? "EXPECTED_OPERATIONAL_READINESS" : `EXPECTED_${version}_${stem}`,
    ...(fact.kind === "catalog" ? { restored: `EXPECTED_${version}_RESTORED_CATALOG_STATE` } : {}),
  };
}

function pinReference(reference, versions) {
  const [key, field] = reference.split(".");
  const value = binding(key, versions)[field];
  if (!value) throw new Error(`Unknown Python restore export: ${reference}`);
  return value;
}

function checkArguments(key, versions, restored = false, condition = null) {
  const pin = binding(key, versions);
  const expected = pin.restored && condition
    ? `${quote(pin.restored)} if ${condition} else ${quote(pin.expected)}`
    : quote(restored && pin.restored ? pin.restored : pin.expected);
  return `${quote(pin.query)}, ${expected}`;
}

function checks(keys, database, versions, { indent = 4, restored = false, condition = null } = {}) {
  return keys.map(key => `${" ".repeat(indent)}check(${database}, ${checkArguments(key, versions, restored, condition)})`).join("\n");
}

function header(spec, filename, balance) {
  const imports = ["hashlib", "json", "os"].map(name => `import ${name}`);
  imports.push("from pathlib import Path");
  if (balance) imports.push("import re");
  imports.push("import signal", "import sys");
  if (balance) imports.push("from uuid import NAMESPACE_URL, UUID, uuid5");
  const shared = "ACL_SQL, CONSTRAINT_SQL, PAIR_PATH, LocalPostgres, normalization_plan, require";
  return `#!/usr/bin/env python3\n"""${spec.docstring}"""\n`
    + (spec.format === "membership" ? "from __future__ import annotations\n\n" : "")
    + imports.join("\n") + "\n\n"
    + (balance ? `from local_postgres_verification import (\n    ${shared},\n)`
      : `from local_postgres_verification import ${shared}`)
    + `\n\nMIGRATION = ${quote(filename)}\n`;
}

function setup(spec) {
  const membership = spec.format === "membership";
  const balance = paired(spec);
  return `def main(arguments):
    require(len(arguments) == 8, "Expected pg_dump pg_restore createdb psql socket port ${balance ? "temporary root" : "temp-dir repository-root"}")
    pg_dump, pg_restore, createdb, psql, ${membership ? "socket_arg" : "socket"}, port, temporary_arg, root_arg = arguments
    ${membership ? "socket, temporary, root = Path(socket_arg), Path(temporary_arg), Path(root_arg).resolve()" : "root, temporary = Path(root_arg).resolve(), Path(temporary_arg)"}
    local = LocalPostgres(psql, socket, port, temporary)
${balance ? "" : "    run, sql, connection = local.run, local.sql, local.connection\n"}    versions = local.require_pg17(pg_dump, pg_restore, createdb, psql)`
    + (balance ? raw`
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    shared = Path(__file__).with_name("local_postgres_verification.py")
    shared_hash = hashlib.sha256(shared.read_bytes()).hexdigest()` : "");
}

function pinnedExports(spec, versions) {
  const membership = spec.format === "membership";
  const balance = paired(spec);
  const variable = balance ? "names" : "exports";
  const rows = spec.exports.map(row => row.map(ref => quote(pinReference(ref, versions))).join(", "));
  const declaration = balance
    ? `    names = [\n${rows.map(row => `        ${row},`).join("\n")}\n    ]`
    : `    exports = [${rows.join(membership ? ",\n               " : ",\n        ")}]`;
  const indent = membership ? "                            " : "        ";
  return declaration + `\n    module = (root / "scripts/studio-comp-migration-rollout.mjs").as_uri()
    pinned = json.loads(${balance ? "local." : ""}run(["node", "--input-type=module", "--eval",
${indent}f"import * as m from {json.dumps(module)}; console.log(JSON.stringify(Object.fromEntries("
${indent}f"{json.dumps(${variable})}.map(k=>[k,m[k]]))));"]))`
    + (membership ? "" : `\n    require(set(pinned) == set(${variable}) and all(isinstance(${balance ? "v" : "value"}, str) and ${balance ? "v" : "value"} for ${balance ? "v" : "value"} in pinned.values()),
            "Incomplete version-bound ${spec.format === "balance" ? "balance " : ""}restore expectations")`);
}

function checkHelper(balance) {
  return `    def check(database, query, expected):
        value = ${balance ? "local." : ""}sql(database, pinned[query])
        require(value == pinned[expected], f"{database}: {query} did not match {expected}")
        return value`;
}

function predecessor(spec, target, previous, versions) {
  const balance = spec.format === "balance";
  let result = "    def predecessor(database, restored=False):\n"
    + checks(spec.predecessor, "database", versions, { indent: 8, condition: "restored" });
  if (balance) result += `
        require(local.sql(database, "SELECT count(*)=${previous.count} AND max(version)='${previous.head}' FROM supabase_migrations.schema_migrations;") == "t",
                "Balance restore requires the actual ${previous.id.toUpperCase()} history")
        require(local.sql(database, "SELECT to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)') IS NULL "
                          "AND to_regprocedure('${target.preflight}') IS NULL;") == "t",
                "Balance restore predecessor already contains ${target.id.toUpperCase()} functions")`;
  if (spec.format === "forward") {
    const absent = [...new Set([target.preflight, ...spec.absentFunctions])];
    result += `
        require(local.sql(database, "SELECT count(*)=${previous.count} AND max(version)='${previous.head}' FROM supabase_migrations.schema_migrations;") == "t",
                "Restore requires the actual ${previous.id.toUpperCase()} history")
        require(local.sql(database, ${quote("SELECT " + absent.map(signature => `to_regprocedure('${signature}') IS NULL`).join(" AND ") + ";")}) == "t",
                "Restore predecessor already contains ${target.id.toUpperCase()} functions")`;
  }
  return result;
}

function inventory(spec, filenames, target, versions) {
  // The anchor is historical; the suffix and inventory size are candidate inputs.
  // Appending a migration extends only this guard, never an old state attestation.
  const anchor = releaseState(spec.format === "forward" ? (spec.inventoryFrom ?? target.predecessor) : "v39", versions);
  const suffix = filenames.filter(name => name.slice(0, 14) >= anchor.head);
  const values = suffix.map(name => name.slice(0, 14) === target.head ? "MIGRATION" : quote(name));
  const membership = spec.format === "membership";
  let list;
  if (membership) {
    list = `[${values.join(",\n            ")}],\n            "Unexpected V39 historical prefix or current migration suffix")`;
  } else {
    // Rank put its target on the preceding line; balance put it on the last
    // historical line. Additional candidate suffix entries get their own lines.
    const rows = [];
    for (const value of values) {
      if (value === "MIGRATION" && rows.length) rows[rows.length - 1] += `, ${value}`;
      else rows.push(value);
    }
    list = `[\n${rows.map(row => `        ${row}`).join(",\n")}], "Unexpected migration inventory")`;
  }
  return `    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted((root / "supabase/migrations").glob("*.sql"))}
    require(len(hashes) == ${filenames.length} and list(hashes)[${membership ? `${anchor.count - 1}:` : `-${suffix.length}:`}] == ${list}`;
}

function mapping() {
  return `    mapping_bytes = PAIR_PATH.read_bytes()
    pairs = json.loads(mapping_bytes)`;
}

function databaseNames(target, previous, balance) {
  if (balance) return `    source = f"koaryu_${target.id}_source_{os.getpid()}"
    restored = f"koaryu_${target.id}_restore_{os.getpid()}"
    canonical = f"koaryu_${target.id}_canonical_{os.getpid()}"
    dump = temporary / f"${previous.id}-before-${target.id}-{os.getpid()}.dump"
    owned, outcomes = [], {}`;
  return `    source, restored = f"koaryu_${target.id}_source_{os.getpid()}", f"koaryu_${target.id}_restore_{os.getpid()}"
    owned = []
    dump = temporary / f"${previous.id}-before-${target.id}-{os.getpid()}.dump"
    migration = root / "supabase/migrations" / MIGRATION`;
}

function createDatabases(balance) {
  const p = balance ? "local." : "";
  return `    try:
        for database, template in [(source, "postgres"), (restored, "template0")]:
            ${p}run([createdb, *${p}connection, "--owner=postgres", f"--template={template}", database])
            owned.append(database)
            ${p}sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",${balance ? "public,extensions" : " public, extensions"};')`;
}

function dumpRestore(spec) {
  const membership = spec.format === "membership";
  const balance = paired(spec);
  const p = balance ? "local." : "";
  const backupGuard = '        require(hashlib.sha256(dump.read_bytes()).hexdigest() == dump_hash, "Backup changed during restore")';
  const captured = membership
    ? `        constraints = json.loads(sql(source, CONSTRAINT_SQL))\n        acls = json.loads(sql(source, ACL_SQL))`
    : `        constraints, acls = json.loads(${p}sql(source, CONSTRAINT_SQL)), json.loads(${p}sql(source, ACL_SQL))`;
  const plan = membership ? `        statements, expected_constraints = normalization_plan(
            constraints, json.loads(sql(restored, CONSTRAINT_SQL)), acls, json.loads(sql(restored, ACL_SQL)), pairs)`
    : balance ? `        statements, expected_constraints = normalization_plan(
            constraints, json.loads(local.sql(restored, CONSTRAINT_SQL)),
            acls, json.loads(local.sql(restored, ACL_SQL)), pairs,
        )` : `        statements, expected_constraints = normalization_plan(constraints, json.loads(sql(restored, CONSTRAINT_SQL)),
                                                               acls, json.loads(sql(restored, ACL_SQL)), pairs)`;
  return captured + `
        ${p}run([pg_dump, *${p}connection, f"--dbname={source}", "--format=custom", f"--file={dump}"])
        dump_hash = hashlib.sha256(dump.read_bytes()).hexdigest()
        ${p}run([pg_restore, *${p}connection, f"--dbname={restored}", "--exit-on-error", str(dump)])
${balance ? "" : backupGuard + "\n"}${plan}
        ${p}sql(restored, "BEGIN;\\n" + "\\n".join(statements) + "\\nCOMMIT;")
        require(json.loads(${p}sql(restored, CONSTRAINT_SQL)) == expected_constraints, "${balance ? "Unexpected restored CHECK state" : "CHECK repair changed an unexpected definition"}")
        require(json.loads(${p}sql(restored, ACL_SQL)) == acls, "${balance ? "Unexpected restored ACL state" : "Default ACL representation repair differed"}")
        require(${balance ? "snapshot(restored)" : "json.loads(sql(restored, SNAPSHOT_SQL))"} == before, "Logical restore changed ${balance ? "retained " : ""}business rows")`
    + (balance ? "\n" + backupGuard : "");
}

function applyMigration(balance) {
  const indent = balance ? "            " : "        ";
  const continuation = balance ? "                       " : "             ";
  const p = balance ? "local." : "";
  return `${indent}require(hashlib.sha256(migration.read_bytes()).hexdigest() == hashes[MIGRATION], "Migration changed ${balance ? "before execution" : "during restore"}")
${indent}version, name = MIGRATION[:-4].split("_", 1)
${indent}${p}run([psql, *${p}connection, f"--dbname={${balance ? "database" : "restored"}}", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
${continuation}"--single-transaction", f"--file={migration}",
${continuation}f"--command=INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES${balance ? "" : " "}('{version}','{name}');"])`;
}

function outcomeChecks(spec, versions) {
  const membership = spec.format === "membership";
  const balance = paired(spec);
  const indent = balance ? "            " : "        ";
  const rows = spec.checks.map(key => `${indent}    (${checkArguments(key, versions, true, balance ? "is_restored" : null)}),`).join("\n");
  if (membership) return `        outcomes = {}
        for query, expected in [
${rows}
        ]:
            outcomes[query] = check(restored, query, expected)`;
  return `${indent}checks = [
${rows}
${indent}]
${indent}${balance ? "values" : "outcomes"} = {query: check(${balance ? "database" : "restored"}, query, expected) for query, expected in checks}`;
}

function protectSource(spec, target, versions) {
  const balance = paired(spec);
  if (balance) return `        predecessor("postgres")
        predecessor(source)
        require(snapshot(source) == before, "Restore proof edited its source rows")`;
  return `        for database in ("postgres", source):
${spec.format === "membership" ? checks(spec.predecessor.slice(0, 2), "database", versions, { indent: 12 }) : "            predecessor(database)"}
            require(sql(database, "SELECT to_regprocedure('${target.preflight}') IS NULL;") == "t",
                    "Restore proof upgraded its source database")
        require(json.loads(sql(source, SNAPSHOT_SQL)) == before, "Restore proof edited its source rows")`;
}

function recheckOutcomes(balance, forward = false) {
  const indent = balance ? "            " : "        ";
  return `${indent}require({query: check(${balance ? "database" : "restored"}, query, expected) for query, expected in checks} == ${balance ? "values" : "outcomes"},
${indent}        "${forward ? "Continuation" : balance ? "Repair/replay" : "Rank proof"} changed the attested state")`;
}

function continuation(spec, id) {
  if (spec.format === "forward") return fixture(id, "continuation").trimEnd() + "\n" + recheckOutcomes(true, true);
  if (spec.format === "membership") return fixture(id, "continuation").trimEnd();
  if (spec.format === "balance") return '            require(semantics(database) == expected_semantics, "Additive V41 changed existing semantic manifests")\n'
    + fixture(id, "continuation").trimEnd() + "\n" + recheckOutcomes(true);
  return raw`        # Real commands and FK cleanup run with the tested roles; rollback keeps
        # this restored fixture available for exact state/cleanup verification.
        sql(restored, "BEGIN;\n" + CONTINUATION_SQL + "\nROLLBACK;")` + "\n" + recheckOutcomes(false)
    + '\n        require(json.loads(sql(restored, SNAPSHOT_SQL)) == before, "Rank proof did not roll back its fixture changes")';
}

function evidence(spec, target, previous) {
  const balance = paired(spec);
  const semantics = spec.format === "balance" || spec.semanticManifests?.length;
  const membership = spec.format === "membership";
  const pathLiteral = membership ? "'supabase/migrations'" : '"supabase/migrations"';
  const hashes = `        require(all(hashlib.sha256((root / ${pathLiteral} / name).read_bytes()).hexdigest() == digest
                    for name, digest in hashes.items()), "Migration inputs changed during verification")`;
  const inputGuard = raw`
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == source_hash
                and hashlib.sha256(shared.read_bytes()).hexdigest() == shared_hash,
                "Restore helper inputs changed during verification")`;
  const digest = 'hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()';
  const fields = balance ? `        evidence = {
            "migrations": hashes, "dump_sha256": dump_hash, "helper_sha256": source_hash,
            "local_tools_sha256": shared_hash, "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(),
            "tools": versions, "queries": pinned, "outcomes": outcomes,${semantics ? ' "semantics": expected_semantics,' : ""}
            "business_before_sha256": ${digest},
            "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements) - 6,
        }` : `        evidence = {"migrations": hashes, "dump_sha256": dump_hash,
                    "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),${membership ? " " : "\n                    "}"local_tools_sha256": hashlib.sha256(Path(__file__).with_name("local_postgres_verification.py").read_bytes()).hexdigest(),
                    "mapping_sha256": hashlib.sha256(mapping_bytes).hexdigest(), "tools": versions,
                    "queries": pinned, "outcomes": outcomes,
                    "business_before_sha256": ${digest},
                    "constraint_pairs": len(pairs), "billing_replays": 6, "acl_representations": len(statements)-6}`;
  return hashes + (balance ? inputGuard : "") + "\n" + fields + `
        (temporary / "${previous.id}-${target.id}-restore-evidence.json").write_text(json.dumps(evidence, indent=2) + "\\n")
        print(${spec.passLines.map(quote).join("\n              ")}, flush=True)`;
}

function cleanup(spec) {
  return `    finally:
${spec.format === "membership" ? "        # createdb must have succeeded before a name becomes ours. Never remove a\n        # preexisting database and never stop or delete the caller's cluster.\n" : ""}        errors = []
        for database in reversed(owned):
            try:
                ${paired(spec) ? "local." : ""}sql("postgres", f"DROP DATABASE {database} WITH (FORCE);")
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("Owned restore database cleanup failed: " + "; ".join(errors))
        dump.unlink(missing_ok=True)


if __name__ == "__main__":
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main(sys.argv[1:])\n`;
}

// Forward authoring uses a releaseState identity and a schema case with format,
// docstring, exports, predecessor, checks, absentFunctions and passLines. Optional
// inventoryFrom selects an older suffix anchor; semanticManifests declares exact
// zero-argument signatures whose outputs must survive upgrade and continuation.
// Existing binding kinds derive exported names; kind "export" declares other
// query/expected/restored export identifiers without embedding executable code.
// Readiness finalAlias opts into FINAL only while that state is the latest
// declared head in the supplied history; older bindings become version-bound.
// Four python-<id>-*.py.inc fixtures supply:
//   business: module-level SEED_SQL and domain constants/helpers;
//   snapshot: a four-space-indented snapshot(database) returning JSON-compatible facts;
//   seed-proof: eight-space-indented assertions over seed (SQL output) and before;
//   continuation: twelve-space-indented business commands/assertions over database,
//     is_restored, before and seed. It runs once on each upgraded copy.
// SEED_SQL owns its transaction. The emitter always captures before itself and
// verifies source preservation, regardless of what the business fixtures assert.
function validateForward(spec, target, previous, versions) {
  if (target.count !== previous.count + 1) throw new Error("Forward restore requires one migration after its predecessor");
  if (!Array.isArray(spec.absentFunctions)) throw new Error("Forward restore must declare absentFunctions, even if empty");
  const signatures = [...spec.absentFunctions, ...(spec.semanticManifests ?? [])];
  if (signatures.some(value => typeof value !== "string" || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\([a-z0-9_., \[\]]*\)$/.test(value))) {
    throw new Error("Forward restore requires schema-qualified function signatures");
  }
  if (spec.semanticManifests?.some(value => !value.endsWith("()"))) {
    throw new Error("Forward semantic manifests must have no arguments");
  }
  const anchor = releaseState(spec.inventoryFrom ?? previous.id, versions);
  if (anchor.count > target.count) throw new Error("Forward inventory anchor cannot follow its target");
  const exported = new Set(spec.exports.flat().map(ref => pinReference(ref, versions)));
  for (const [keys, state] of [[spec.predecessor, previous], [spec.checks, target]]) {
    if (!keys?.some(key => schema.bindings[key]?.kind === "readiness" && schema.bindings[key].state === state.id)) {
      throw new Error(`Forward restore requires ${state.id} readiness checks`);
    }
    if (!keys.some(key => binding(key, versions).restored)) {
      throw new Error(`Forward restore requires explicit canonical/restored evidence for ${state.id}`);
    }
    for (const key of keys) {
      if (Object.values(binding(key, versions)).some(name => !exported.has(name))) {
        throw new Error(`Forward restore check has an undeclared export: ${key}`);
      }
    }
  }
}

function semanticHelper(signatures) {
  return `    def semantics(database):
        return {signature: local.sql(database, f"SELECT {signature};") for signature in ${quote(signatures)}}`;
}

function preserveSemantics() {
  return '            require(semantics(database) == expected_semantics, "Upgrade or continuation changed declared semantic manifests")';
}

/** Render historical profiles or a declared forward case, without target reads. */
export function renderPythonRestore(id, filenames, versions) {
  const spec = schema.cases[id];
  if (!spec) throw new Error(`Unsupported Python restore state: ${id}`);
  if (!["membership", "rank", "balance", "forward"].includes(spec.format)) {
    throw new Error(`Unsupported Python restore format: ${spec.format}`);
  }
  const sorted = [...filenames].sort();
  const actual = migrationVersions(sorted);
  if (actual.length !== versions.length || actual.some((version, i) => version !== versions[i])) {
    throw new Error("Python restore filenames and validated versions disagree");
  }
  const target = releaseState(id, versions);
  const previous = releaseState(target.predecessor, versions);
  const filename = sorted.find(name => name.startsWith(`${target.head}_`));
  const balance = paired(spec);
  const forward = spec.format === "forward";
  if (forward) validateForward(spec, target, previous, versions);
  const semantics = forward && Boolean(spec.semanticManifests?.length);
  const membership = spec.format === "membership";
  const migrationPath = '    migration = root / "supabase/migrations" / MIGRATION';
  const blocks = [header(spec, filename, spec.format === "balance") + fixture(id, "business") + "\n",
    setup(spec), pinnedExports(spec, versions), "", checkHelper(balance), ""];
  if (balance) blocks.push(fixture(id, "snapshot").trimEnd(), "");
  if (semantics) blocks.push(semanticHelper(spec.semanticManifests), "");
  if (!membership) blocks.push(predecessor(spec, target, previous, versions), "");
  blocks.push(membership ? checks(spec.predecessor, '"postgres"', versions) : '    predecessor("postgres")');
  if (membership) blocks.push(databaseNames(target, previous, balance));
  blocks.push(inventory(spec, sorted, target, versions));
  if (balance) blocks.push(migrationPath);
  blocks.push(mapping());
  if (!membership) blocks.push(databaseNames(target, previous, balance));
  blocks.push(createDatabases(balance));
  if (!balance) blocks.push(raw`        sql(source, "BEGIN;\n" + SEED_SQL + "\nCOMMIT;")
        before = json.loads(sql(source, SNAPSHOT_SQL))`);
  if (forward) blocks.push('        seed = local.sql(source, SEED_SQL)\n        before = snapshot(source)');
  blocks.push(fixture(id, "seed-proof").trimEnd());
  if (balance) blocks.push('        predecessor(source)' + (!forward || semantics ? '\n        expected_semantics = semantics(source)' : ""));
  blocks.push(dumpRestore(spec));
  blocks.push(membership ? checks(spec.restoredPredecessor, "restored", versions, { indent: 8, restored: true })
    : "        predecessor(restored, restored=True)");
  if (balance) blocks.push(`        local.run([createdb, *local.connection, "--owner=postgres", f"--template={source}", canonical])
        owned.append(canonical)
        for database, is_restored in [(canonical, False), (restored, True)]:
            predecessor(database, is_restored)
            require(snapshot(database) == before, "Predecessor rows changed before upgrade")`);
  blocks.push(applyMigration(balance));
  const noBackfill = forward ? "Migration changed retained rows before continuation" : membership ? "V39 migration rewrote business rows" : balance
    ? "V41 changed retained rows before explicit repair" : "V40 changed pre-existing business facts";
  blocks.push(`${balance ? "            " : "        "}require(${balance ? "snapshot(database)" : "json.loads(sql(restored, SNAPSHOT_SQL))"} == before, ${quote(noBackfill)})`);
  if (spec.format === "rank") blocks.push(fixture(id, "legacy-proof").trimEnd());
  blocks.push(outcomeChecks(spec, versions));
  if (semantics) blocks.push(preserveSemantics());
  blocks.push(continuation(spec, id));
  if (semantics) blocks.push(preserveSemantics());
  if (balance) blocks.push('            outcomes["restored" if is_restored else "canonical"] = values');
  blocks.push(protectSource(spec, target, versions), evidence(spec, target, previous), cleanup(spec));
  return blocks.join("\n");
}
