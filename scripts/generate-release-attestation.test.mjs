import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { committedStatement as extractStatement, modeMismatch, trackedModes, workingModeMismatch } from "./generate-release-attestation.mjs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CURRENT_RELEASE, migrationVersions, readinessTuple, releaseState } from "./release-attestation/states.mjs";
import { renderCompatibility } from "./release-attestation/sql.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { render_automation_tables_v57 } from "./release-attestation/preflight-policy.mjs";
import preflightSchema from "./release-attestation/preflight-schema.json" with { type: "json" };
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


test("V57 declares finite complete canonical and restored platform table profiles", () => {
  const check = { id: "automation_tables_v57", ...preflightSchema.checks.automation_tables_v57 };
  const sql = render_automation_tables_v57(check);
  const pins = [check.expected, check.restoredExpected, check.platformExpected, check.platformRestoredExpected];
  assert.equal(check.tables.length, 113);
  assert.match(sql, new RegExp("NOT IN \\(" + pins.map(pin => "'" + pin + "'").join(",") + "\\)"));
  assert.ok(sql.includes("IS DISTINCT FROM ARRAY["));
  assert.ok(sql.includes("pg_catalog.aclexplode(a.attacl)"));
  assert.ok(sql.includes("pg_catalog.aclexplode(COALESCE(c.relacl"));
  for (const field of ["platformExpected", "platformRestoredExpected"]) {
    assert.throws(() => render_automation_tables_v57({ ...check, [field]: undefined }), /both canonical and restored/);
    assert.throws(() => render_automation_tables_v57({ ...check, [field]: "*" }), /exact SHA-256/);
  }
  assert.throws(() => render_automation_tables_v57({ ...check, platformExpected: check.expected }), /distinct exact SHA-256/);
});

test("restore modes: index mode exact, owner bits exact, no extra group/other bits", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const tracked = trackedModes(repository);
  assert.equal(tracked.get("scripts/verify-v38-v39-restore-contract.py"), 0o100644);
  assert.equal(tracked.get("scripts/verify-v40-v41-restore-contract.py"), 0o100755);
  const readOnly = { source: "scripts/verify-v38-v39-restore-contract.py", mode: 0o644 };
  const executable = { source: "scripts/verify-v40-v41-restore-contract.py", mode: 0o755 };
  // Exact modes and restrictive umasks (077, 027, 022 minus world-exec) pass.
  for (const mode of [0o755, 0o700, 0o750, 0o754]) assert.equal(modeMismatch(executable, 0o100000 | mode, tracked), null, mode.toString(8));
  for (const mode of [0o644, 0o600, 0o640]) assert.equal(modeMismatch(readOnly, 0o100000 | mode, tracked), null, mode.toString(8));
  // Group/world writability, world-exec drift and special bits fail.
  for (const mode of [0o777, 0o775, 0o757, 0o4755, 0o2755]) {
    assert.match(modeMismatch(executable, 0o100000 | mode, tracked), /adds permission bits/, mode.toString(8));
  }
  for (const mode of [0o666, 0o664, 0o646, 0o645]) {
    assert.match(modeMismatch(readOnly, 0o100000 | mode, tracked), /adds permission bits/, mode.toString(8));
  }
  // Owner bits must match exactly (review row: index 100755, disk 0644).
  assert.match(modeMismatch(executable, 0o100644, tracked), /owner permissions 600 !== 700/);
  assert.match(modeMismatch(executable, 0o100655, tracked), /owner permissions 600 !== 700/);
  assert.match(modeMismatch(readOnly, 0o100744, tracked), /owner permissions 700 !== 600/);
  assert.match(modeMismatch(readOnly, 0o100444, tracked), /owner permissions 400 !== 600/);
  // Index mode must equal the attested mode (review row: index 100644, disk 0755).
  assert.match(modeMismatch({ ...readOnly, mode: 0o755 }, 0o100755, tracked), /index mode 100644 !== 100755/);
  assert.match(modeMismatch(readOnly, 0o100644, new Map([[readOnly.source, 0o120000]])), /index mode 120000 !== 100644/);
  // A working-tree symlink is rejected whatever its target, tracked or not.
  assert.match(modeMismatch(executable, 0o120755, tracked), /not a regular file/);
  assert.match(modeMismatch(executable, 0o120755, new Map()), /not a regular file/);
  // Untracked files keep the exact comparison.
  const untracked = new Map();
  assert.equal(modeMismatch(readOnly, 0o100644, untracked), null);
  assert.match(modeMismatch(readOnly, 0o100600, untracked), /mode 600 !== 644/);
  assert.match(modeMismatch(executable, 0o100777, untracked), /mode 777 !== 755/);
});

test("restore modes on real files: every row of the review's mode table", () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-modes-")));
  const gitIn = (...args) => execFileSync("git", ["-c", "core.fileMode=true", "-c", "core.symlinks=true", ...args],
    { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    gitIn("init", "-q");
    fs.mkdirSync(path.join(temporary, "scripts"));
    const artifact = { source: "scripts/restore.py", mode: 0o755 };
    const file = path.join(temporary, artifact.source);
    const target = path.join(temporary, "target.py");
    fs.writeFileSync(target, "same\n");
    fs.chmodSync(target, 0o700);
    const reset = () => {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, "same\n");
      fs.chmodSync(file, 0o755);
      gitIn("add", "--chmod=+x", artifact.source);
    };
    const check = () => workingModeMismatch(temporary, artifact, trackedModes(temporary));
    const rows = [
      ["index 100755, disk 0755", () => {}, null],
      ["index 100755, disk 0777", () => fs.chmodSync(file, 0o777), /adds permission bits 22/],
      ["index 100755, disk 0775", () => fs.chmodSync(file, 0o775), /adds permission bits 20/],
      ["index 100755, disk 0757", () => fs.chmodSync(file, 0o757), /adds permission bits 2/],
      // Allowed by policy: group/other bits are a subset of 0755 (restrictive umask).
      ["index 100755, disk 0754", () => fs.chmodSync(file, 0o754), null],
      ["index 100755, disk 0700 (umask 077)", () => fs.chmodSync(file, 0o700), null],
      ["index 100755, disk 0644", () => fs.chmodSync(file, 0o644), /owner permissions 600 !== 700/],
      ["index 100644, disk 0755", () => gitIn("update-index", "--chmod=-x", artifact.source), /index mode 100644 !== 100755/],
      ["symlink staged as 120000 to an identical 0700 target", () => {
        fs.rmSync(file); fs.symlinkSync(target, file); gitIn("add", artifact.source);
      }, /not a regular file/],
      ["unstaged symlink, index still 100755, identical 0700 target", () => {
        fs.rmSync(file); fs.symlinkSync(target, file);
      }, /not a regular file/],
    ];
    for (const [name, arrange, expected] of rows) {
      reset();
      arrange();
      if (expected === null) assert.equal(check(), null, name);
      else assert.match(check() ?? "", expected, name);
    }
    // The staged symlink is also an index-mode failure on its own.
    reset();
    fs.rmSync(file); fs.symlinkSync(target, file); gitIn("add", artifact.source);
    assert.equal(trackedModes(temporary).get(artifact.source), 0o120000);
    assert.match(modeMismatch(artifact, 0o100755, trackedModes(temporary)), /index mode 120000 !== 100755/);
    // Missing file: ENOENT, as before.
    reset();
    fs.rmSync(file);
    assert.throws(check, { code: "ENOENT" });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("--write regenerates exactly the committed generated files and modes, then is a no-op", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  // Real path: the generator runs main() only when argv[1] is its own resolved path.
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-write-")));
  try {
    fs.cpSync(path.join(repository, "scripts/release-attestation"), path.join(temporary, "scripts/release-attestation"), { recursive: true });
    fs.copyFileSync(path.join(repository, "scripts/generate-release-attestation.mjs"), path.join(temporary, "scripts/generate-release-attestation.mjs"));
    fs.cpSync(path.join(repository, "supabase/migrations"), path.join(temporary, "supabase/migrations"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "backend/app/services"), { recursive: true });
    const generated = "scripts/release-attestation/generated-history.mjs";
    fs.writeFileSync(path.join(temporary, generated), "stale\n");
    const run = () => spawnSync(process.execPath, [path.join(temporary, "scripts/generate-release-attestation.mjs"), "--write"], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const written = JSON.parse(first.stdout).written;
    assert.ok(written.includes(generated));
    assert.ok(written.includes("backend/app/services/generated_release_readiness.py"));
    const tracked = trackedModes(repository);
    for (const file of written) {
      assert.equal(fs.readFileSync(path.join(temporary, file), "utf8"), fs.readFileSync(path.join(repository, file), "utf8"), file);
      if (tracked.has(file) && /restore-contract/.test(file)) {
        assert.equal(fs.statSync(path.join(temporary, file)).mode & 0o777, tracked.get(file) & 0o777, `${file}: mode`);
      }
    }
    assert.equal(written.filter(file => /restore-contract/.test(file)).length,
      fs.readdirSync(path.join(repository, "scripts")).filter(name => /^verify-v\d+-v\d+-restore-contract\./.test(name)).length);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { written: [], result: "unchanged" });
    const combined = spawnSync(process.execPath, [path.join(temporary, "scripts/generate-release-attestation.mjs"), "--write", "--check"], { encoding: "utf8" });
    assert.notEqual(combined.status, 0);
    assert.match(combined.stderr, /Choose --check, --write or --output-dir/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("--write refuses a symlinked destination and leaves its outside target untouched", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-symlink-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-generator-outside-")));
  try {
    fs.cpSync(path.join(repository, "scripts/release-attestation"), path.join(temporary, "scripts/release-attestation"), { recursive: true });
    fs.copyFileSync(path.join(repository, "scripts/generate-release-attestation.mjs"), path.join(temporary, "scripts/generate-release-attestation.mjs"));
    fs.cpSync(path.join(repository, "supabase/migrations"), path.join(temporary, "supabase/migrations"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "backend/app/services"), { recursive: true });
    const run = () => spawnSync(process.execPath, [path.join(temporary, "scripts/generate-release-attestation.mjs"), "--write"], { encoding: "utf8" });
    // The review's scenario: generated-history.mjs is a symlink to a file outside the tree.
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "outside\n");
    const generated = path.join(temporary, "scripts/release-attestation/generated-history.mjs");
    fs.rmSync(generated);
    fs.symlinkSync(sentinel, generated);
    const linked = run();
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /generated-history\.mjs: refusing to write through a symlink/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside\n");
    // Nothing else was written before the refusal.
    assert.deepEqual(fs.readdirSync(path.join(temporary, "backend/app/services")), []);
    // A dangling symlink is refused too (existsSync would have said "absent").
    fs.rmSync(sentinel);
    const dangling = run();
    assert.notEqual(dangling.status, 0);
    assert.match(dangling.stderr, /refusing to write through a symlink/);
    assert.equal(fs.existsSync(sentinel), false);
    // A symlinked parent directory that leaves the tree is refused.
    fs.rmSync(generated);
    fs.writeFileSync(generated, "stale\n");
    fs.rmSync(path.join(temporary, "backend/app/services"), { recursive: true });
    fs.symlinkSync(outside, path.join(temporary, "backend/app/services"));
    const parent = run();
    assert.notEqual(parent.status, 0);
    assert.match(parent.stderr, /generated_release_readiness\.py: refusing to write outside the repository/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(generated, "utf8"), "stale\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
