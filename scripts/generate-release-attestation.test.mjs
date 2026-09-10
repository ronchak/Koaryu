import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { migrationVersions, readinessTuple, releaseState } from "./release-attestation/states.mjs";
import { renderCompatibility } from "./release-attestation/sql.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { renderRankReceiptManifest, renderRankReturnManifest } from "./release-attestation/manifests.mjs";
import manifestSchema from "./release-attestation/manifest-schema.json" with { type: "json" };

const migrations = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const filenames = fs.readdirSync(migrations).filter(name => name.endsWith(".sql"));
const versions = migrationVersions(filenames);

function committedStatement(filename, signature) {
  const committed = fs.readFileSync(`${migrations}/${filename}`, "utf8");
  const starts = [`CREATE FUNCTION ${signature}`, `CREATE OR REPLACE FUNCTION ${signature}`];
  const found = starts.flatMap(beginning => {
    const start = committed.indexOf(beginning);
    if (start < 0) return [];
    assert.equal(committed.indexOf(beginning, start + beginning.length), -1);
    return [start];
  });
  assert.equal(found.length, 1, `Expected one ${signature} statement in ${filename}`);
  const start = found[0];
  const opening = /\bAS\s+(\$\w*\$)/.exec(committed.slice(start));
  assert.ok(opening);
  const closing = committed.indexOf(opening[1], start + opening.index + opening[0].length);
  assert.ok(closing > start);
  const end = committed.indexOf(";", closing + opening[1].length) + 1;
  assert.ok(end > closing);
  return committed.slice(start, end);
}

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
  assert.throws(() => releaseState("v41", versions.slice(0, -1)), /Missing release head/);
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
    assert.equal(renderCompatibility(source, target, { expandedCondition: sourceId === "v39" }),
      committedStatement(filename, target.preflight), filename);
  }
});

test("full preflights reproduce historical whitespace and every declared check", () => {
  for (const id of ["v39", "v40", "v41"]) {
    const state = releaseState(id, versions);
    const filename = filenames.find(name => name.startsWith(`${state.head}_`));
    assert.equal(renderPreflight(state), committedStatement(filename, state.preflight), id);
  }
});

test("shared rank manifests reproduce all five historical statements", () => {
  for (const artifact of manifestSchema.artifacts) {
    const generated = artifact.kind === "rank-return"
      ? renderRankReturnManifest({ ...artifact, functions: manifestSchema.functionSets[artifact.functionSet] })
      : renderRankReceiptManifest(artifact);
    assert.equal(generated, committedStatement(artifact.path.split("/").at(-1), artifact.signature), artifact.path);
  }
});
