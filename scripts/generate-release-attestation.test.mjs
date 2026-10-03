import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { committedStatement as extractStatement } from "./generate-release-attestation.mjs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CURRENT_RELEASE, migrationVersions, readinessTuple, releaseState } from "./release-attestation/states.mjs";
import { renderCompatibility } from "./release-attestation/sql.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { renderRankReceiptManifest, renderRankReturnManifest } from "./release-attestation/manifests.mjs";
import manifestSchema from "./release-attestation/manifest-schema.json" with { type: "json" };
import {
  renderChainedShellRestore, renderExtendedV31Restore, renderV24Restore,
  renderV26Restore, renderV27Restore, renderV31Restore,
} from "./release-attestation/restore-shell.mjs";
import restoreCases from "./release-attestation/restore-cases.json" with { type: "json" };
import { renderPythonRestore } from "./release-attestation/restore-python.mjs";

const migrations = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const filenames = fs.readdirSync(migrations).filter(name => name.endsWith(".sql"));
const versions = migrationVersions(filenames);

function committedStatement(filename, signature) {
  return extractStatement(fs.readFileSync(`${migrations}/${filename}`, "utf8"), signature);
}

const historicalPreflightHashes = {
  v39: ["9826196366c5dfdf7061eedde0811dfc7b0318bb3b2a0b04d1ada520bf63666a", "2c84f5d835bf7bcc96ce3381e8df87e8da65b28ee830d3d73622181ae4a16f07"],
  v40: ["4f76c24fa9f5571e05c6b03ca2af6705b9e9a5a7ff4314851abb1c8be99b45d5", "819dddfb1f5e487851b815a5fff4d773e050291aad482329febb551e36536a8e"],
  v41: ["d915ed8529a70dd62e178868578a3ecb7eecabce89f3c786176101248a456ad1", "5cb6033934f308df351b12beff70897ca4b8562a4fe576e5485d65261dad0c67"],
};
const sha256 = text => createHash("sha256").update(text).digest("hex");

test("historical readiness stops at its own head when future migrations are appended", () => {
  const original = releaseState("v7", versions);
  assert.equal(original.count, 100);
  assert.equal(original.pending.length, 16);
  assert.equal(original.pending.at(-1), "20260801131844");
  assert.deepEqual(releaseState("v7", [...versions, "20990101000000"]), original);
  assert.equal(releaseState("schedule-v25", versions).count, 119);
  assert.equal(releaseState("v25", versions).count, 120);
  assert.equal(readinessTuple(releaseState("v41", versions)).split("|")[6], "release-db-attestation-v41");
});

test("unknown, missing and ambiguous histories cannot select a release", () => {
  assert.throws(() => releaseState("v999", versions), /Unknown release/);
  assert.throws(() => releaseState(CURRENT_RELEASE, versions.slice(0, -1)), /Missing release head/);
  assert.throws(() => releaseState("v41", [...versions].reverse()), /unique ordered/);
  assert.throws(() => migrationVersions([...filenames, filenames[0]]), /duplicate versions/);
  assert.throws(() => renderCompatibility(releaseState("v8", versions), releaseState("v7", versions)),
    /strict predecessor/);
});

test("declared compatibility SQL reproduces committed V39 through V41 bytes", () => {
  for (const [sourceId, targetId, filename] of [
    ["v39", "v38", "20260908080420_student_membership_preservation_v39.sql"],
    ["v40", "v39", "20260908133504_rank_history_command_ownership_v40.sql"],
    ["v41", "v40", "20260908183744_serialize_billing_payer_balance_v41.sql"],
  ]) {
    const source = releaseState(sourceId, versions);
    const target = releaseState(targetId, versions);
    const generated = renderCompatibility(source, target, { expandedCondition: sourceId === "v39" });
    assert.equal(sha256(generated), historicalPreflightHashes[sourceId][1]);
    assert.equal(generated, committedStatement(filename, target.preflight), filename);
  }
});

test("full preflights reproduce historical whitespace and every declared check", () => {
  for (const id of ["v39", "v40", "v41"]) {
    const state = releaseState(id, versions);
    const filename = filenames.find(name => name.startsWith(`${state.head}_`));
    const generated = renderPreflight(state);
    assert.equal(sha256(generated), historicalPreflightHashes[id][0]);
    assert.equal(generated, committedStatement(filename, state.preflight), id);
  }
});

test("shared rank manifests reproduce declared historical and current statements", () => {
  for (const artifact of manifestSchema.artifacts) {
    const generated = artifact.kind === "rank-return"
      ? renderRankReturnManifest({ ...artifact, functions: manifestSchema.functionSets[artifact.functionSet] })
      : renderRankReceiptManifest(artifact);
    assert.equal(sha256(generated), artifact.sourceSha256);
    assert.equal(generated, committedStatement(artifact.path.split("/").at(-1), artifact.signature), artifact.path);
  }
});

test("historical restore scripts reproduce complete bytes independently of directory order", () => {
  const cases = [
    ["scripts/verify-v24-v25-restore-contract.sh", renderV24Restore],
    ["scripts/verify-v25-v26-restore-contract.sh", renderV26Restore],
    ["scripts/verify-v26-v27-restore-contract.sh", renderV27Restore],
    ["scripts/verify-v30-v31-restore-contract.sh", renderV31Restore],
    ...["v39", "v40", "v41"].map(id => [
      `scripts/verify-${releaseState(id, versions).predecessor}-${id}-restore-contract.py`,
      (names, history) => renderPythonRestore(id, names, history),
    ]),
    ...Object.entries(restoreCases).map(([id, specification]) => [specification.file,
      (names, history) => renderChainedShellRestore(id, specification, names, history)]),
  ];
  for (const [file, render] of cases) {
    const expected = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(render(filenames, versions), expected, file);
    assert.equal(render([...filenames].reverse(), versions), expected, file);
  }
});

test("the generated continuation rejects a hosted target before invoking database tools", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-refusal-"));
  try {
    const script = path.join(temporary, "continuation.sh");
    const fakeTool = path.join(temporary, "database-tool");
    const marker = path.join(temporary, "invoked");
    fs.writeFileSync(script, renderExtendedV31Restore(filenames, versions));
    fs.writeFileSync(fakeTool, '#!/bin/sh\necho invoked >> "$KOARYU_TEST_MARKER"\nexit 99\n', { mode: 0o755 });
    const result = spawnSync("bash", [script, fakeTool, fakeTool, fakeTool, fakeTool,
      "production.invalid", "5432", temporary, fileURLToPath(new URL("../", import.meta.url))], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, KOARYU_TEST_MARKER: marker },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected the local verifier's disposable directory/);
    assert.equal(fs.existsSync(marker), false, "Refusal must precede every database tool call");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("a future release uses declarations and fixtures without renderer edits or original target access", () => {
  const previousId = CURRENT_RELEASE;
  const previous = releaseState(previousId, versions);
  const nextNumber = Number(previousId.slice(1)) + 1;
  const nextId = `v${nextNumber}`;
  const nextPreflight = Number(/_v(\d+)\(\)$/.exec(previous.preflight)[1]) + 1;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-forward-"));
  try {
    const inputs = path.join(temporary, "scripts/release-attestation");
    fs.cpSync(fileURLToPath(new URL("./release-attestation", import.meta.url)), inputs, { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("./generate-release-attestation.mjs", import.meta.url)), path.join(temporary, "scripts/generate-release-attestation.mjs"));
    const read = name => JSON.parse(fs.readFileSync(path.join(inputs, name), "utf8"));
    const write = (name, value) => fs.writeFileSync(path.join(inputs, name), JSON.stringify(value));
    const declarations = read("release-states.json");
    declarations.current = nextId;
    declarations.identities.push([nextId, "20990101000000", nextPreflight, nextNumber]);
    write("release-states.json", declarations);
    const preflights = read("preflight-schema.json");
    preflights.states[nextId] = { extends: previousId };
    write("preflight-schema.json", preflights);
    const python = read("python-restore-schema.json");
    python.bindings[`readiness-${nextId}`] = { kind: "readiness", state: nextId, finalAlias: true };
    python.cases[nextId] = {
      format: "forward", docstring: "Synthetic authoring proof.",
      exports: [[`readiness-${previousId}.query`, `readiness-${previousId}.expected`],
        [`readiness-${nextId}.query`, `readiness-${nextId}.expected`],
        ["catalog-v40.query", "catalog-v40.expected", "catalog-v40.restored"]],
      predecessor: [`readiness-${previousId}`, "catalog-v40"],
      checks: [`readiness-${nextId}`, "catalog-v40", `readiness-${previousId}`],
      absentFunctions: ["public.change_lesson_label_v1(uuid,text)"], passLines: ["Synthetic authoring proof"],
    };
    write("python-restore-schema.json", python);
    const fixtures = {
      business: 'SEED_SQL = "SELECT 1;"\n',
      snapshot: '    def snapshot(database):\n        return {"value": local.sql(database, "SELECT 1;")}\n',
      "seed-proof": '        require(seed == "1", "Synthetic seed missing")\n',
      continuation: '            require(snapshot(database) == before, "Synthetic continuation changed rows")\n',
    };
    for (const [name, text] of Object.entries(fixtures)) fs.writeFileSync(path.join(inputs, `fixtures/python-${nextId}-${name}.py.inc`), text);
    const probe = path.join(temporary, "probe.mjs");
    fs.writeFileSync(probe, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {renderPythonRestore} from './scripts/release-attestation/restore-python.mjs';
import {migrationVersions,releaseState} from './scripts/release-attestation/states.mjs';
import {renderPreflight} from './scripts/release-attestation/preflight.mjs';
import {renderBackendReadiness} from './scripts/generate-release-attestation.mjs';
const names=${JSON.stringify(filenames)};
const extended=[...names,'20990101000000_synthetic_authoring.sql'];
const history=migrationVersions(extended);
const old=renderPythonRestore('${previousId}',extended,history);
assert.ok(old.includes('"${previousId.toUpperCase()}_OPERATIONAL_READINESS_SQL"'));
assert.ok(!old.includes('"FINAL_OPERATIONAL_READINESS_SQL"'));
const current=renderPythonRestore('${nextId}',extended,history);
assert.ok(current.includes('"FINAL_OPERATIONAL_READINESS_SQL"'));
assert.ok(current.includes('for database, is_restored in [(canonical, False), (restored, True)]'));
assert.ok(!current.includes('recompute_billing_payer_balance_v1'));
assert.ok(renderPreflight(releaseState('${nextId}',history)).includes('v_count <> ${previous.count + 1}'));
assert.ok(renderBackendReadiness(history).includes('koaryu_release_schema_preflight_v${nextPreflight}'));
console.log(JSON.stringify([old,current]));
`);
    const allowed = fs.realpathSync(temporary);
    const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${allowed}`, "--input-type=module"],
      { input: fs.readFileSync(probe, "utf8"), cwd: allowed, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 });
    assert.equal(result.status, 0, result.stderr);
    const scripts = JSON.parse(result.stdout);
    assert.equal(scripts.length, 2);
    const syntax = spawnSync("python3", ["-c", "import ast,json,sys; scripts=json.load(sys.stdin); [(ast.parse(s),compile(s,'generated','exec')) for s in scripts]"],
      { input: JSON.stringify(scripts), encoding: "utf8", timeout: 10_000 });
    assert.equal(syntax.status, 0, syntax.stderr);
    python.cases[nextId].checks = [`readiness-${nextId}`, `readiness-${previousId}`];
    write("python-restore-schema.json", python);
    const incomplete = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${allowed}`, "--input-type=module"],
      { input: fs.readFileSync(probe, "utf8"), cwd: allowed, encoding: "utf8", timeout: 10_000 });
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, new RegExp(`requires explicit canonical/restored evidence for ${nextId}`));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
