import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkReleaseInventory, directorySource, formatFindings, overlaySource,
} from "./check-release-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(root, "scripts/check-release-inventory.mjs");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

// Replays need the real history (CI checks out with fetch-depth: 0). A missing
// commit fails the test instead of skipping the proof.
function archiveTree(commit) {
  assert.equal(spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }).status, 0,
    `${commit} must be available; fetch full history`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `koaryu-inventory-${commit}-`));
  const archive = spawnSync("git", ["archive", "--format=tar", commit, "--", "scripts", "backend",
    "supabase/verification", "supabase/migrations", ".github"], { cwd: root, maxBuffer: 1 << 30 });
  assert.equal(archive.status, 0, String(archive.stderr));
  const extract = spawnSync("tar", ["-x", "-C", directory], { input: archive.stdout });
  assert.equal(extract.status, 0, String(extract.stderr));
  return directory;
}

function runCli(treeRoot) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [checker, "--root", treeRoot], { encoding: "utf8" });
  const lines = result.stdout.trim().split("\n");
  const findings = lines.slice(0, -1).map(line => {
    const match = /^([^:]+):(\d+): (.*)$/.exec(line);
    assert.ok(match, `unparseable finding line: ${line}`);
    return { file: match[1], line: Number(match[2]), text: match[3] };
  });
  return { status: result.status, findings, summary: lines.at(-1), elapsed: Date.now() - started, stderr: result.stderr };
}

// Mutation and dry-run fixtures run on this pinned V61 tree (the base of the
// PR that added the check), so they stay valid as later releases move current.
const PINNED_V61 = "6eb1b5413a3dda4de73713e213aeb551585f00a3";
const pinnedTree = archiveTree(PINNED_V61);
after(() => fs.rmSync(pinnedTree, { recursive: true, force: true }));
const repository = directorySource(pinnedTree);

function replay(commit) {
  const directory = archiveTree(commit);
  try { return runCli(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const files = findings => [...new Set(findings.map(finding => finding.file))].sort();
const changedBetween = (from, to) => new Set(git("diff", "--name-only", from, to).trim().split("\n"));

test("the checked-out tree has zero stale inventories, exits 0 and runs well under 10 seconds", () => {
  const result = runCli(root);
  assert.equal(result.status, 0, `${result.findings.map(finding => `${finding.file}:${finding.line}: ${finding.text}`).join("\n")}\n${result.stderr}`);
  assert.deepEqual(result.findings, []);
  assert.match(result.summary, /^0 stale release inventories for v\d+ \(previous v\d+\)\.$/);
  assert.ok(result.elapsed < 10_000, `took ${result.elapsed} ms`);
});

test("the pinned V61 tree has zero findings", () => {
  const result = checkReleaseInventory(repository);
  assert.equal(result.current, "v61");
  assert.deepEqual(result.findings, [], formatFindings(result));
});

test("replay of 0b655d56 (first V61 commit) lists every later-fixed V61 miss and nothing unexplained", () => {
  const result = replay("0b655d56");
  assert.equal(result.status, 1);
  assert.match(result.summary, /^\d+ stale release inventories for v61 \(previous v60\)\.$/);
  // The seven files the audit names as later costing DB runs and CI cycles.
  const audited = [
    "backend/tests/test_release_schema_readiness.py",
    "scripts/local_postgres_verification.py",
    "scripts/release-attestation-v56.test.mjs",
    "scripts/studio-comp-migration-rollout.mjs",
    "scripts/studio-comp-migration-rollout.test.mjs",
    "scripts/verify-student-profile-rank-plan-concurrency.sh",
    "supabase/verification/timezone_names_reference_contract.sql",
  ];
  // Plus miss #3 (history part and FINAL checkpoint in the runner) and the
  // silent composition callers, all fixed in 712cb4b8.
  const structural = [
    "scripts/verify-automation-test-email-concurrency.py",
    "scripts/verify-supabase-contracts-local.sh",
    "scripts/verify-workflow-graph-mail-concurrency.py",
  ];
  assert.deepEqual(files(result.findings), [...audited, ...structural].sort());
  // Nothing unexplained: every flagged file was changed by the V61 fixes
  // between 0b655d56 and b7253693 (712cb4b8, 4e877b5f, b7253693).
  const fixed = changedBetween("0b655d56", "b7253693");
  for (const file of files(result.findings)) assert.ok(fixed.has(file), `${file} was never fixed later`);
  const text = result.findings.map(finding => `${finding.file}:${finding.line}: ${finding.text}`).join("\n");
  assert.match(text, /verify-supabase-contracts-local\.sh:\d+: history part exits before the newest v60-v61 restore/);
  assert.match(text, /verify-supabase-contracts-local\.sh:\d+: checkpoint before the v61 apply uses the moving FINAL readiness alias/);
  assert.match(text, /verify-workflow-graph-mail-concurrency\.py:\d+: composes v60 through install_final_v60/);
  assert.match(text, /release-attestation-v56\.test\.mjs:19: CURRENT_RELEASE pinned to "v60"; expected: "v61"/);
  assert.match(text, /local_postgres_verification\.py:\d+: no install_final_v61/);
});

test("replay of ce2a1799 (V60 addition) lists the timezone contract miss fixed in df604694", () => {
  const result = replay("ce2a1799");
  assert.equal(result.status, 1);
  assert.deepEqual(files(result.findings), [
    "scripts/verify-supabase-contracts-local.sh",
    "supabase/verification/timezone_names_reference_contract.sql",
  ]);
  assert.ok(changedBetween("ce2a1799", "df604694").has("supabase/verification/timezone_names_reference_contract.sql"));
  const timezone = result.findings.filter(finding => finding.file.endsWith("timezone_names_reference_contract.sql"));
  assert.ok(timezone.some(finding => /migration head pins v59 \(20261014083106\) without v60; expected: add 20261021093000/.test(finding.text)));
  // The runner rules encode today's history-part convention (712cb4b8, V61)
  // and the documented "gate the previous newest proof" rule. At V60 the
  // history part stopped at V56 and V58-V59 stayed ungated, so these two are
  // expected under today's rule rather than V60 misses.
  const runner = result.findings.filter(finding => finding.file.endsWith("verify-supabase-contracts-local.sh"));
  assert.deepEqual(runner.map(finding => finding.text.split(";")[0]), [
    "history part exits before the newest v59-v60 restore",
    "former newest restore verify-v58-v59-restore-contract.py also runs in the current part",
  ]);
});

for (const commit of ["b7253693", "83518d26"]) {
  test(`replay of ${commit} (V61 complete) has zero findings`, () => {
    const result = replay(commit);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.findings, []);
  });
}

// Mutation tests: remove the current release from one inventory of each kind
// on today's tree and require that exact file and line in the report.
function lineOf(text, needle, last = false) {
  const index = last ? text.lastIndexOf(needle) : text.indexOf(needle);
  assert.ok(index >= 0, `missing ${needle}`);
  return text.slice(0, index).split("\n").length;
}

function mutate(file, change) {
  const original = repository.read(file);
  const changed = change(original);
  assert.notEqual(changed, original, `${file} mutation did not apply`);
  return { text: changed, result: checkReleaseInventory(overlaySource(repository, { [file]: changed })) };
}

function assertReported(result, file, line, pattern) {
  const match = result.findings.find(finding => finding.file === file && finding.line === line && pattern.test(finding.stale));
  assert.ok(match, `expected ${file}:${line} ${pattern}; got\n${formatFindings(result)}`);
  assert.ok(result.findings.every(finding => finding.file === file), `unrelated findings:\n${formatFindings(result)}`);
}

const MUTATIONS = [
  {
    name: "backend readiness test keeps the previous RPC",
    file: "backend/tests/test_release_schema_readiness.py",
    change: text => text.replaceAll("koaryu_release_schema_preflight_v42", "koaryu_release_schema_preflight_v41"),
    line: text => lineOf(text, "koaryu_release_schema_preflight_v41", true), pattern: /preflight RPC pins v60/,
  },
  {
    name: "generated backend readiness not regenerated",
    file: "backend/app/services/generated_release_readiness.py",
    change: () => git("show", "ce2a1799:backend/app/services/generated_release_readiness.py"),
    line: text => lineOf(text, "koaryu_release_schema_preflight_v41"), pattern: /preflight RPC pins v60/,
  },
  {
    name: "V56 attestation canary keeps the previous CURRENT_RELEASE",
    file: "scripts/release-attestation-v56.test.mjs",
    change: text => text.replace('CURRENT_RELEASE, "v61"', 'CURRENT_RELEASE, "v60"'),
    line: text => lineOf(text, 'CURRENT_RELEASE, "v60"'), pattern: /CURRENT_RELEASE pinned to "v60"/,
  },
  {
    name: "rank race lacks the exact current arm",
    file: "scripts/verify-student-profile-rank-plan-concurrency.sh",
    change: text => text.replace(/  ELSIF history_count=156 AND history_head='20261022190000'\n[^\n]*\n[^\n]*\n/, ""),
    line: text => lineOf(text, "20261021093000", true), pattern: /migration head pins v60/,
  },
  {
    name: "timezone contract lacks the exact current arm (b7253693 reverted)",
    file: "supabase/verification/timezone_names_reference_contract.sql",
    change: () => git("show", "b7253693^:supabase/verification/timezone_names_reference_contract.sql"),
    line: text => lineOf(text, "20261021093000", true), pattern: /migration head pins v60/,
  },
  {
    name: "release UI contract does not accept the current state",
    file: "supabase/verification/release_ui_atomic_contract.sql",
    change: text => text.replace(", (156,'20261022190000')", ""),
    line: text => lineOf(text, "(155,'20261021093000')"), pattern: /migration head pins v60/,
  },
  {
    name: "runner test dispatch stops at the previous release",
    file: "scripts/verify-supabase-contracts-local.test.mjs",
    change: text => text.replaceAll("20261022190000", "<current-head>"),
    line: text => lineOf(text, "20261021093000", true), pattern: /migration head pins v60/,
  },
  {
    name: "rollout test keeps the previous evidence shape",
    file: "scripts/studio-comp-migration-rollout.test.mjs",
    change: text => text.replaceAll("v61_catalog=", "v60_catalog="),
    line: text => lineOf(text, "v60_catalog=", true), pattern: /provider fingerprint pins v60/,
  },
  {
    name: "rollout apply approval requires the previous evidence",
    file: "scripts/studio-comp-migration-rollout.mjs",
    change: text => text.replace('config.expectedProviderFingerprint.startsWith("v61_catalog=")', 'config.expectedProviderFingerprint.startsWith("v60_catalog=")'),
    line: text => lineOf(text, 'config.expectedProviderFingerprint.startsWith("v60_catalog=")'), pattern: /apply approval requires v60_catalog=/,
  },
  {
    name: "rollout --one-migration chain omits the previous release",
    file: "scripts/studio-comp-migration-rollout.mjs",
    change: text => text.replace('"v58", "v59", "v60",\n]);', '"v58", "v59",\n]);'),
    line: text => lineOf(text, "const ONE_MIGRATION_PREDECESSORS"), pattern: /--one-migration predecessors end at v59/,
  },
  {
    name: "rollout predecessor counts omit the previous release",
    file: "scripts/studio-comp-migration-rollout.mjs",
    change: text => text.replace('  "v60": ROLLOUT.v60MigrationCount,\n', ""),
    line: text => lineOf(text, "const PREDECESSOR_MIGRATION_COUNTS"), pattern: /accepted predecessor counts omit v60/,
  },
  {
    name: "silent gap: preflight settings list misses the current id",
    file: "scripts/release-attestation/preflight.mjs",
    change: text => text.replace('["v57", "v58", "v59", "v60", "v61"]', '["v57", "v58", "v59", "v60"]'),
    line: text => lineOf(text, '["v57", "v58", "v59", "v60"]'), pattern: /rendering list \[v57\.\.v60\] names v60 without v61/,
  },
  {
    name: "silent gap: blank-line normalization list misses the current id",
    file: "scripts/release-attestation/preflight.mjs",
    change: text => text.replace('"v59", "v60", "v61"].includes(state.id) ? rendered', '"v59", "v60"].includes(state.id) ? rendered'),
    line: text => lineOf(text, '"v59", "v60"].includes(state.id) ? rendered'), pattern: /rendering list \[v52\.\.v60\]/,
  },
  {
    name: "silent gap: composition caller still uses the bound previous installer",
    file: "scripts/verify-workflow-graph-mail-concurrency.py",
    change: text => text.replaceAll("install_final_v61", "install_final_v60"),
    line: text => lineOf(text, "install_final_v60", true), pattern: /composes v60 through install_final_v60/,
  },
  {
    name: "installer module lacks the current installer",
    file: "scripts/local_postgres_verification.py",
    change: text => text.slice(0, text.indexOf("def install_final_v61(")),
    line: text => lineOf(text, "def install_final_v60("), pattern: /no install_final_v61/,
  },
  {
    name: "previous installer still reads the moving generated metadata",
    file: "scripts/local_postgres_verification.py",
    change: text => text.replace('    """Upgrade a V57 clone through V59 to the version-bound V60 schema."""\n',
      '    """Upgrade a V57 clone through V59 to the version-bound V60 schema."""\n'
      + '    metadata = runpy.run_path(str(Path(root) / "backend/app/services/generated_release_readiness.py"))\n'),
    line: text => lineOf(text, "def install_final_v60("), pattern: /install_final_v60 reads the moving generated readiness metadata/,
  },
  {
    name: "runner migration count not raised",
    file: "scripts/verify-supabase-contracts-local.sh",
    change: text => text.replace("${#migration_files[@]} -ne 156", "${#migration_files[@]} -ne 155"),
    line: text => lineOf(text, "-ne 155"), pattern: /migration count pinned to 155/,
  },
  {
    name: "runner history part exits before the newest restore",
    file: "scripts/verify-supabase-contracts-local.sh",
    change: text => text.replace(/  echo "\[V61 history upgrade\/restore\][^\n]*\n[^\n]*verify-v60-v61-restore-contract\.py[^\n]*\n[^\n]*\n/, ""),
    line: text => lineOf(text, "  exit 0\nfi\n\necho \"[V33"), pattern: /history part exits before the newest v60-v61 restore/,
  },
  {
    name: "runner leaves the former newest restore in the current part",
    file: "scripts/verify-supabase-contracts-local.sh",
    change: text => text.replace(/if part_enabled history; then\n(  echo "\[V60 upgrade\/restore\][^\n]*\n[^\n]*\n[^\n]*\n)fi\n/, "$1"),
    line: text => lineOf(text, "verify-v59-v60-restore-contract.py", true), pattern: /former newest restore verify-v59-v60/,
  },
  {
    name: "runner binds the previous checkpoint to the moving FINAL alias",
    file: "scripts/verify-supabase-contracts-local.sh",
    change: text => text.replace("import { V60_OPERATIONAL_READINESS_SQL } from './scripts/release-attestation/generated-readiness.mjs'; process.stdout.write(V60_OPERATIONAL_READINESS_SQL);",
      "import { FINAL_OPERATIONAL_READINESS_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(FINAL_OPERATIONAL_READINESS_SQL);"),
    line: text => lineOf(text, "FINAL_OPERATIONAL_READINESS_SQL"), pattern: /moving FINAL readiness alias/,
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation: ${mutation.name}`, () => {
    const { text, result } = mutate(mutation.file, mutation.change);
    assertReported(result, mutation.file, mutation.line(text), mutation.pattern);
  });
}

test("a parsed structure that disappears is reported instead of skipping its rule", () => {
  const { result } = mutate("scripts/studio-comp-migration-rollout.mjs",
    text => text.replace("const ONE_MIGRATION_PREDECESSORS = Object.freeze([", "const ONE_MIGRATION_CHAIN = Object.freeze(["));
  assertReported(result, "scripts/studio-comp-migration-rollout.mjs", 1, /expected structure not found: const ONE_MIGRATION_PREDECESSORS/);
});

test("a migration without a declared release identity is reported on the declaration", () => {
  const result = checkReleaseInventory(overlaySource(repository, {
    "supabase/migrations/20991231000000_undeclared_v62.sql": "-- undeclared\n",
  }));
  assert.deepEqual(result.findings.map(finding => [finding.file, finding.line]), [
    ["scripts/release-attestation/release-states.json", 1],
    ["scripts/verify-supabase-contracts-local.sh", lineOf(repository.read("scripts/verify-supabase-contracts-local.sh"), "-ne 156")],
  ], formatFindings(result));
  assert.match(result.findings[0].stale, /last migration is 20991231000000/);
  assert.match(result.findings[1].stale, /migration count pinned to 156/);
});

test("forward dry run: declaring V62 lists every hand-edited derivable pin in one pass", () => {
  const declarations = JSON.parse(repository.read("scripts/release-attestation/release-states.json"));
  declarations.identities.push(["v62", "20991231000000", 43, 62]);
  declarations.current = "v62";
  const preflights = JSON.parse(repository.read("scripts/release-attestation/preflight-schema.json"));
  preflights.states.v62 = { extends: "v61" };
  const python = JSON.parse(repository.read("scripts/release-attestation/python-restore-schema.json"));
  python.cases.v62 = {};
  const result = checkReleaseInventory(overlaySource(repository, {
    "supabase/migrations/20991231000000_dry_run_v62.sql": "-- dry run\n",
    "scripts/release-attestation/release-states.json": JSON.stringify(declarations),
    "scripts/release-attestation/preflight-schema.json": JSON.stringify(preflights),
    "scripts/release-attestation/python-restore-schema.json": JSON.stringify(python),
  }));
  assert.equal(result.current, "v62");
  assert.equal(result.previous, "v61");
  const flagged = files(result.findings);
  // Audit table 2b (#17-#27) plus the generated copies and the silent
  // preflight list (#4, #2, #9) and the security policy rename (#8).
  for (const file of [
    "scripts/local_postgres_verification.py",
    "scripts/verify-workflow-graph-mail-concurrency.py",
    "scripts/verify-automation-test-email-concurrency.py",
    "backend/tests/test_release_schema_readiness.py",
    "scripts/release-attestation-v56.test.mjs",
    "scripts/verify-student-profile-rank-plan-concurrency.sh",
    "scripts/verify-supabase-contracts-local.test.mjs",
    "scripts/verify-supabase-contracts-local.sh",
    "scripts/studio-comp-migration-rollout.mjs",
    "scripts/studio-comp-migration-rollout.test.mjs",
    "supabase/verification/release_ui_atomic_contract.sql",
    "supabase/verification/timezone_names_reference_contract.sql",
    "backend/app/services/generated_release_readiness.py",
    "scripts/release-attestation/generated-history.mjs",
    "scripts/release-attestation/preflight.mjs",
    "scripts/release-attestation/preflight-policy.mjs",
  ]) assert.ok(flagged.includes(file), `${file} not listed:\n${formatFindings(result)}`);
  // Version-bound files stay quiet: named restores and fixtures, the
  // allowlisted V61 proofs, declarations, docs and migrations.
  for (const file of flagged) {
    assert.doesNotMatch(file, /verify-v\d+-v\d+-restore-contract|fixtures\/|observations\.json|\.md$|^supabase\/migrations\//);
    assert.notEqual(file, "scripts/verify-student-import-identity-concurrency.py");
    assert.notEqual(file, "supabase/verification/student_import_row_atomic_contract.sql");
  }
  const runner = result.findings.filter(finding => finding.file === "scripts/verify-supabase-contracts-local.sh").map(finding => finding.stale);
  assert.ok(runner.some(text => /migration count pinned to 156/.test(text)));
  assert.ok(runner.some(text => /history part exits before the newest v61-v62 restore/.test(text)));
  assert.ok(runner.some(text => /former newest restore verify-v60-v61-restore-contract\.py/.test(text)));
});

test("output has one line per finding with file, line, stale value and expected edit, then a count", () => {
  const output = formatFindings({ current: "v61", previous: "v60", findings: [
    { file: "a.py", line: 3, stale: "preflight RPC pins v60", expected: "add koaryu_release_schema_preflight_v42" },
  ] });
  assert.equal(output, "a.py:3: preflight RPC pins v60; expected: add koaryu_release_schema_preflight_v42\n"
    + "1 stale release inventory for v61 (previous v60).");
});
