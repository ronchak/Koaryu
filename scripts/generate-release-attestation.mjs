#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_RELEASE, migrationVersions, releaseState } from "./release-attestation/states.mjs";
import { renderCompatibility, renderServicePrivileges } from "./release-attestation/sql.mjs";
import { renderPreflight } from "./release-attestation/preflight.mjs";
import { renderRankReceiptManifest, renderRankReturnManifest } from "./release-attestation/manifests.mjs";
import { renderChainedShellRestore, renderV24Restore, renderV27Restore } from "./release-attestation/restore-shell.mjs";
import restoreCases from "./release-attestation/restore-cases.json" with { type: "json" };
import manifestSchema from "./release-attestation/manifest-schema.json" with { type: "json" };
import preflightSchema from "./release-attestation/preflight-schema.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalBase = "9785f13c77ebd1ffb55c31185a1ca5c055ab9e41";
const historicalHead = "20260908183744";
const requiredRestores = [
  "verify-v24-v25-restore-contract.sh", "verify-v25-v26-restore-contract.sh",
  "verify-v26-v27-restore-contract.sh", "verify-v27-v28-restore-contract.sh",
  "verify-v28-v29-restore-contract.sh", "verify-v29-v30-restore-contract.sh",
  "verify-v30-v31-restore-contract.sh", "verify-v38-v39-restore-contract.py",
  "verify-v39-v40-restore-contract.py", "verify-v40-v41-restore-contract.py",
];

export function renderHistoryModule(versions) {
  return '// Generated from the candidate migration filenames. Do not edit by hand.\n'
    + 'export const MIGRATION_VERSIONS = Object.freeze([\n'
    + versions.map(version => `  "${version}",\n`).join("") + ']);\n';
}

export function sqlArtifacts(filenames) {
  const versions = migrationVersions(filenames);
  const artifacts = [];
  for (const specification of manifestSchema.artifacts) {
    let text;
    if (specification.kind === "rank-return") {
      text = renderRankReturnManifest({ ...specification, functions: manifestSchema.functionSets[specification.functionSet] });
    } else if (specification.kind === "rank-receipt") {
      text = renderRankReceiptManifest(specification);
    } else {
      throw new Error(`Unknown manifest declaration: ${specification.kind}`);
    }
    artifacts.push({ source: specification.path, signature: specification.signature, text });
  }
  for (const id of Object.keys(preflightSchema.states)) {
    const state = releaseState(id, versions);
    const target = releaseState(state.predecessor, versions);
    const filename = filenames.find(name => name.startsWith(`${state.head}_`));
    const source = `supabase/migrations/${filename}`;
    artifacts.push({ source, signature: state.preflight, text: renderPreflight(state) });
    artifacts.push({ source, signature: target.preflight,
      text: renderCompatibility(state, target, { expandedCondition: id === "v39" }) });
  }
  return artifacts;
}

export function committedStatement(source, signature) {
  const starts = [`CREATE FUNCTION ${signature}`, `CREATE OR REPLACE FUNCTION ${signature}`];
  const found = starts.flatMap(beginning => {
    const start = source.indexOf(beginning);
    if (start < 0) return [];
    assert.equal(source.indexOf(beginning, start + beginning.length), -1, `Ambiguous statement: ${signature}`);
    return [start];
  });
  assert.equal(found.length, 1, `Expected one historical statement: ${signature}`);
  const start = found[0];
  const opening = /\bAS\s+(\$\w*\$)/.exec(source.slice(start));
  assert.ok(opening, `Missing SQL body delimiter: ${signature}`);
  const closing = source.indexOf(opening[1], start + opening.index + opening[0].length);
  assert.ok(closing > start, `Missing SQL body end: ${signature}`);
  const end = source.indexOf(";", closing + opening[1].length) + 1;
  assert.ok(end > closing, `Missing statement terminator: ${signature}`);
  return source.slice(start, end);
}

function historicalMigrationCheck() {
  const changed = execFileSync("git", ["diff", "--name-status", historicalBase, "--", "supabase/migrations"],
    { cwd: root, encoding: "utf8" }).trim();
  for (const line of changed ? changed.split("\n") : []) {
    const [status, filename] = line.split("\t");
    if (status !== "A" || path.basename(filename).slice(0, 14) <= historicalHead) {
      throw new Error(`Historical migration changed: ${line}`);
    }
  }
}

function restoreArtifacts(filenames, versions) {
  const renderers = {
    "verify-v24-v25-restore-contract.sh": renderV24Restore,
    "verify-v26-v27-restore-contract.sh": renderV27Restore,
  };
  for (const [id, specification] of Object.entries(restoreCases)) {
    renderers[path.basename(specification.file)] = (names, history) =>
      renderChainedShellRestore(id, specification, names, history);
  }
  return {
    missing: requiredRestores.filter(name => !Object.hasOwn(renderers, name)),
    artifacts: Object.entries(renderers).map(([name, render]) => ({
      source: `scripts/${name}`, text: render(filenames, versions),
    })),
  };
}

export function main(argv = process.argv.slice(2)) {
  let check = false;
  let outputDirectory;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check" && !check) check = true;
    else if (argument === "--output-dir" && outputDirectory === undefined && argv[index + 1]
        && !argv[index + 1].startsWith("--")) outputDirectory = path.resolve(argv[++index]);
    else throw new Error(`Unknown, repeated or incomplete argument: ${argument}`);
  }
  if (check === Boolean(outputDirectory)) throw new Error("Choose --check or --output-dir <empty-directory>");
  const filenames = fs.readdirSync(path.join(root, "supabase/migrations")).filter(name => name.endsWith(".sql")).sort();
  const versions = migrationVersions(filenames);
  assert.equal(releaseState(CURRENT_RELEASE, versions).head, versions.at(-1), "The current release must declare the last migration");
  const sql = sqlArtifacts(filenames);
  const restores = restoreArtifacts(filenames, versions);
  const history = renderHistoryModule(versions);
  if (check) {
    historicalMigrationCheck();
    for (const artifact of sql) {
      const existing = fs.readFileSync(path.join(root, artifact.source), "utf8");
      assert.equal(artifact.text, committedStatement(existing, artifact.signature), `${artifact.source}: ${artifact.signature}`);
    }
    for (const artifact of restores.artifacts) {
      assert.equal(artifact.text, fs.readFileSync(path.join(root, artifact.source), "utf8"), artifact.source);
    }
    assert.equal(history, fs.readFileSync(path.join(root, "scripts/release-attestation/generated-history.mjs"), "utf8"), "Generated history is stale");
    if (restores.missing.length) throw new Error(`Restore generation remains incomplete: ${restores.missing.join(", ")}`);
    console.log(JSON.stringify({ historicalBase, sqlStatements: sql.length, restoreScripts: restores.artifacts.length, result: "identical" }));
    return;
  }
  if (restores.missing.length) throw new Error(`Restore generation remains incomplete: ${restores.missing.join(", ")}`);
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length) {
    throw new Error("Output directory must be empty; existing files are never overwritten");
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const grouped = new Map();
  for (const artifact of sql) {
    const entries = grouped.get(artifact.source) ?? [];
    entries.push(artifact);
    grouped.set(artifact.source, entries);
  }
  for (const [source, artifacts] of grouped) {
    const statements = artifacts.map(artifact => artifact.text);
    const privileges = artifacts.map(({ signature }) => signature.startsWith("public.")
      ? renderServicePrivileges(signature)
      : `ALTER FUNCTION ${signature} OWNER TO postgres;\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;`);
    fs.writeFileSync(path.join(outputDirectory, `${path.basename(source)}.attestation.sql`),
      [...statements, ...privileges].join("\n\n") + "\n");
  }
  for (const artifact of restores.artifacts) {
    fs.writeFileSync(path.join(outputDirectory, path.basename(artifact.source)), artifact.text,
      { mode: fs.statSync(path.join(root, artifact.source)).mode & 0o777 });
  }
  fs.writeFileSync(path.join(outputDirectory, "generated-history.mjs"), history);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
