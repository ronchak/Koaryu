#!/usr/bin/env node
// Lists every release-version inventory that is stale for the declared current
// release, in one pass, without a database, Docker or network.
//
// "Current" (C) and "previous" (P) come from release-states.json: C is
// `current` and P is the identity row before it. The checks only add failures;
// they never replace the generator's --check, the dispatch tests or any proof.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DECLARATION = "scripts/release-attestation/release-states.json";
const PREFLIGHT_SCHEMA = "scripts/release-attestation/preflight-schema.json";
const PYTHON_RESTORE_SCHEMA = "scripts/release-attestation/python-restore-schema.json";
const RUNNER = "scripts/verify-supabase-contracts-local.sh";
const INSTALLERS = "scripts/local_postgres_verification.py";
const PREFLIGHT_RENDERER = "scripts/release-attestation/preflight.mjs";
const ROLLOUT = "scripts/studio-comp-migration-rollout.mjs";
const BACKEND_READINESS = "backend/app/services/generated_release_readiness.py";

// Pins for the current release live in these trees. Migrations are applied
// history and docs are prose, so neither is scanned.
const SCANNED_PREFIXES = ["scripts/", "backend/", "supabase/verification/", ".github/"];
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "venv", ".venv", "__pycache__",
  ".pytest_cache", ".ruff_cache", ".mypy_cache"]);

// Declarations and measured evidence hold independent, reviewed facts (for
// example manifest-schema.json names the migration that defined each writer).
// The generator's --check already binds them to the current release.
const DECLARATION_FILES = new Set([
  DECLARATION, PREFLIGHT_SCHEMA, PYTHON_RESTORE_SCHEMA,
  "scripts/release-attestation/manifest-schema.json",
  "scripts/release-attestation/restore-cases.json",
]);

// This checker and its tests quote historical pins as fixtures against pinned
// commits, so they never move with the current release.
const CHECKER_FILES = new Set(["scripts/check-release-inventory.mjs", "scripts/check-release-inventory.test.mjs"]);

// Files that intentionally pin one release although their name does not say
// so. Each entry is bound like a versioned basename: it is exempt from the
// stale-pin rule once current is at or after `release`. Keep this list to
// files a dry run actually flagged, each with the reason it must not move.
export const VERSION_BOUND_FILES = Object.freeze({
  // The runner runs this race right after applying V61 (before any later
  // release), and its V42 call asserts that V61 stage, not the current release.
  "scripts/verify-student-import-identity-concurrency.py": { release: "v61",
    reason: "V61 import-identity race run at the V61 stage" },
  // V42 presence switches on the V61 import-identity cases; later releases keep
  // V42 as a bridge, so the gate stays correct without naming them.
  "supabase/verification/student_import_row_atomic_contract.sql": { release: "v61",
    reason: "feature gate on the V61 preflight existing, true on every later release" },
});

// Installers named install_final_vNN are version-bound once a later release
// exists. V57's installer is the accepted base that component proofs compose
// on (see local_postgres_verification.py); every other caller must name the
// current release so its proof composes the candidate schema.
const BOUND_BASE_INSTALLERS = new Set(["v57"]);

const HINTS = {
  [INSTALLERS]: "make install_final_{P} version-bound (literal count/head/preflight/manifest) and add install_final_{C} that asserts the generated readiness metadata",
  [BACKEND_READINESS]: "regenerate: npm run generate:release-attestation -- --write",
  "scripts/release-attestation/generated-history.mjs": "regenerate: npm run generate:release-attestation -- --write",
  "scripts/release-attestation/generated-readiness.mjs": "regenerate: npm run generate:release-attestation -- --write",
  "backend/tests/test_release_schema_readiness.py": "assert the current RPC {CPREFLIGHT}",
  "scripts/verify-student-profile-rank-plan-concurrency.sh": "add the exact {C} arm (history_count={CCOUNT} AND history_head='{CHEAD}' AND {CPREFLIGHT}()) and add {C} to the phase list",
  "supabase/verification/timezone_names_reference_contract.sql": "add the exact {C} arm with its failure_key and require {CPREFLIGHT}() absent on the {P} arm",
  "supabase/verification/release_ui_atomic_contract.sql": "add ({CCOUNT},'{CHEAD}') to the accepted exact release states",
  [RUNNER]: "add the {C} block: apply {CHEAD}, run the {P}-{C} restore and the {C} readiness",
  "scripts/verify-supabase-contracts-local.test.mjs": "extend the dispatch expectations to {C}",
  [ROLLOUT]: "extend the guarded rollout to {C} ({P} becomes an exact predecessor)",
  "scripts/studio-comp-migration-rollout.test.mjs": "extend the rollout chain, counts and post-state expectations to {C}",
};

export function directorySource(root) {
  const absolute = path.resolve(root);
  let files = null;
  try {
    const top = execFileSync("git", ["-C", absolute, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fs.realpathSync(top) === fs.realpathSync(absolute)) {
      files = execFileSync("git", ["-C", absolute, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
        .split("\0").filter(Boolean).filter(file => fs.existsSync(path.join(absolute, file)));
    }
  } catch { files = null; }
  if (!files) {
    files = [];
    const walk = relative => {
      for (const entry of fs.readdirSync(path.join(absolute, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
        } else if (entry.isFile()) files.push(child);
      }
    };
    walk("");
  }
  return {
    files: files.sort(),
    read: file => fs.readFileSync(path.join(absolute, file), "utf8"),
  };
}

// Replaces or removes (null) files on top of another source; used by tests.
export function overlaySource(base, overrides) {
  const files = new Set(base.files);
  for (const [file, text] of Object.entries(overrides)) {
    if (text === null) files.delete(file);
    else files.add(file);
  }
  return {
    files: [...files].sort(),
    read: file => Object.hasOwn(overrides, file) && overrides[file] !== null ? overrides[file] : base.read(file),
  };
}

function versionNumber(id) {
  const match = /^v(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

function lineAt(text, index) {
  let line = 1;
  for (let offset = text.indexOf("\n"); offset >= 0 && offset < index; offset = text.indexOf("\n", offset + 1)) line++;
  return line;
}

function lastMatch(text, pattern) {
  let found = null;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadReleases(source) {
  const declarations = JSON.parse(source.read(DECLARATION));
  const identities = declarations.identities;
  const index = identities.findIndex(row => row[0] === declarations.current);
  if (index < 1) throw new Error(`${DECLARATION}: current release ${declarations.current} needs a declared predecessor`);
  const migrations = source.files
    .filter(file => /^supabase\/migrations\/\d{14}_[A-Za-z0-9_]+\.sql$/.test(file))
    .map(file => path.posix.basename(file)).sort();
  const versions = migrations.map(name => name.slice(0, 14));
  const state = row => {
    const position = versions.indexOf(row[1]);
    return {
      id: row[0], head: row[1], preflightNumber: row[2], manifestNumber: row[3],
      count: position + 1, migration: position >= 0 ? migrations[position] : null,
      preflight: `koaryu_release_schema_preflight_v${row[2]}`,
      manifest: `release-db-attestation-v${row[3]}`,
    };
  };
  return {
    current: state(identities[index]),
    previous: state(identities[index - 1]),
    beforePrevious: index > 1 ? state(identities[index - 2]) : null,
    ids: identities.map(row => row[0]),
    migrations,
  };
}

// Token families: each spelling a release-version pin takes in the tree.
const FAMILIES = [
  { kind: "migration head", pattern: s => `(?<![0-9])${s.head}(?![0-9])`, token: s => s.head },
  { kind: "preflight RPC", pattern: s => `${s.preflight}(?![0-9])`, token: s => s.preflight },
  { kind: "manifest version", pattern: s => `${s.manifest}(?![0-9])`, token: s => s.manifest },
  { kind: "provider fingerprint", pattern: s => `(?<![A-Za-z0-9_])${s.id}_catalog=`, token: s => `${s.id}_catalog=` },
];
// Installer names are checked by rule 4. VNN_OPERATIONAL_READINESS aliases are
// not a family: older checkpoints legitimately name only their own release.

// A basename that names a release (verify-v60-v61-restore-contract.py,
// python-v61-business.py.inc, v60-rollout-observations.json, missed-class-v60.mjs)
// marks a file written for that release pair; it must not move with "current".
function boundByName(file, currentNumber) {
  const numbers = [...path.posix.basename(file).matchAll(/(?<![A-Za-z0-9])v(\d+)(?![0-9])/gi)].map(m => Number(m[1]));
  return numbers.length > 0 && Math.max(...numbers) <= currentNumber;
}

export function checkReleaseInventory(source) {
  const findings = [];
  const releases = loadReleases(source);
  const { current: C, previous: P, beforePrevious: PP } = releases;
  const fill = text => text
    .replaceAll("{C}", C.id).replaceAll("{P}", P.id).replaceAll("{CHEAD}", C.head)
    .replaceAll("{CCOUNT}", String(C.count)).replaceAll("{CPREFLIGHT}", C.preflight);
  const report = (file, line, stale, expected) => findings.push({ file, line, stale, expected });
  // A parsed structure that disappeared must fail loudly, not skip its rule.
  const missing = (file, structure) => report(file, 1, `expected structure not found: ${structure}`,
    "update scripts/check-release-inventory.mjs for the new spelling");

  // 1. The declaration itself.
  const lastMigration = releases.migrations.at(-1)?.slice(0, 14);
  if (C.head !== lastMigration) {
    report(DECLARATION, 1, `current ${C.id} declares head ${C.head} but the last migration is ${lastMigration}`,
      "declare the new release identity and set current to it");
  }
  const currentNumber = versionNumber(C.id);
  if (currentNumber !== null && currentNumber >= 57) {
    if (C.preflightNumber !== P.preflightNumber + 1) {
      report(DECLARATION, 1, `${C.id} preflight is v${C.preflightNumber}`, `preflight v${P.preflightNumber + 1} (previous + 1)`);
    }
    if (C.manifestNumber !== currentNumber) {
      report(DECLARATION, 1, `${C.id} manifest version is v${C.manifestNumber}`, `manifest v${currentNumber}`);
    }
  }
  if (!Object.hasOwn(JSON.parse(source.read(PREFLIGHT_SCHEMA)).states ?? {}, C.id)) {
    report(PREFLIGHT_SCHEMA, 1, `no preflight state for ${C.id}`, `declare states.${C.id}`);
  }
  const pythonCases = JSON.parse(source.read(PYTHON_RESTORE_SCHEMA)).cases ?? {};
  if (!Object.hasOwn(pythonCases, C.id)) {
    report(PYTHON_RESTORE_SCHEMA, 1, `no restore case for ${C.id}`, `declare cases.${C.id}`);
  }

  const scanned = source.files.filter(file => SCANNED_PREFIXES.some(prefix => file.startsWith(prefix))
    && !file.endsWith(".md") && !CHECKER_FILES.has(file));
  const texts = new Map(scanned.map(file => [file, source.read(file)]));

  // 2. Stale pins: a file that names the previous release must also name the
  // current one, per token family.
  for (const [file, text] of texts) {
    const bound = VERSION_BOUND_FILES[file];
    if (DECLARATION_FILES.has(file) || boundByName(file, versionNumber(C.id) ?? -1) || text.includes("\0")
        || (bound && releases.ids.indexOf(bound.release) >= 0
          && releases.ids.indexOf(bound.release) <= releases.ids.indexOf(C.id))) continue;
    for (const family of FAMILIES) {
      const previous = lastMatch(text, new RegExp(family.pattern(P), "g"));
      if (!previous || new RegExp(family.pattern(C)).test(text)) continue;
      const hint = HINTS[file] ? `; ${fill(HINTS[file])}` : "";
      report(file, lineAt(text, previous.index), `${family.kind} pins ${P.id} (${family.token(P)}) without ${C.id}`,
        `add ${family.token(C)}${hint}`);
    }
  }

  // 3. CURRENT_RELEASE literals must equal the declared current release.
  for (const [file, text] of texts) {
    for (const match of text.matchAll(/CURRENT_RELEASE\s*(?:,|===|!==)\s*(["'])([A-Za-z0-9-]+)\1/g)) {
      if (match[2] !== C.id) report(file, lineAt(text, match.index), `CURRENT_RELEASE pinned to "${match[2]}"`, `"${C.id}"`);
    }
  }

  // 4. Composition: callers name the current installer; only it reads the
  // generated (moving) readiness metadata, every older installer is bound.
  for (const [file, text] of texts) {
    if (file === INSTALLERS || !file.endsWith(".py")) continue;
    for (const match of text.matchAll(/install_final_(v\d+)(?![0-9])/g)) {
      if (match[1] !== C.id && !BOUND_BASE_INSTALLERS.has(match[1])) {
        report(file, lineAt(text, match.index), `composes ${match[1]} through install_final_${match[1]}`,
          `install_final_${C.id} (the current-schema installer)`);
      }
    }
  }
  if (texts.has(INSTALLERS)) {
    const text = texts.get(INSTALLERS);
    const definitions = [...text.matchAll(/^def (install_final_(v\d+))\(/gm)].map(match => {
      const next = text.slice(match.index + 1).search(/^def /m);
      return { name: match[1], id: match[2], index: match.index,
        body: text.slice(match.index, next < 0 ? text.length : match.index + 1 + next) };
    });
    if (!definitions.length) missing(INSTALLERS, "def install_final_vNN(");
    else {
      const currentInstaller = definitions.find(definition => definition.id === C.id);
      if (!currentInstaller) {
        report(INSTALLERS, lineAt(text, definitions.at(-1).index), `no install_final_${C.id}`,
          fill(HINTS[INSTALLERS]));
      } else if (!currentInstaller.body.includes("generated_release_readiness.py")) {
        report(INSTALLERS, lineAt(text, currentInstaller.index), `install_final_${C.id} does not assert the generated readiness metadata`,
          `compare ${BACKEND_READINESS} with the ${C.id} literals`);
      }
      for (const definition of definitions) {
        if (definition.id !== C.id && definition.body.includes("generated_release_readiness.py")) {
          report(INSTALLERS, lineAt(text, definition.index), `${definition.name} reads the moving generated readiness metadata`,
            `bind ${definition.name} to literal ${definition.id} count/head/preflight/manifest`);
        }
      }
    }
  }

  // 5. Runner reachability for the newest restore and the previous release.
  if (texts.has(RUNNER)) {
    const text = texts.get(RUNNER);
    const lines = text.split("\n");
    const count = /\$\{#migration_files\[@\]\} -ne (\d+)/.exec(text);
    if (!count) missing(RUNNER, "${#migration_files[@]} -ne <count>");
    else if (Number(count[1]) !== releases.migrations.length) {
      report(RUNNER, lineAt(text, count.index), `migration count pinned to ${count[1]}`, `${releases.migrations.length}`);
    }
    const start = lines.findIndex(line => /^if \[\[ "\$SUITE_PART" == history \]\]; then$/.test(line));
    const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line === "fi");
    if (start < 0 || end < 0) missing(RUNNER, 'if [[ "$SUITE_PART" == history ]]; then ... fi');
    const newest = `verify-${P.id}-${C.id}-restore-contract.py`;
    const applies = (line, state) => state.migration && line.includes(state.migration) && line.includes("--file=");
    const lineOf = (predicate, from = 0, to = lines.length) => {
      for (let index = from; index < to; index++) if (predicate(lines[index])) return index;
      return -1;
    };
    if (Object.hasOwn(pythonCases, C.id)) {
      if (start >= 0 && end > start) {
        const restore = lineOf(line => line.includes(newest), start, end);
        if (restore < 0) {
          report(RUNNER, end, `history part exits before the newest ${P.id}-${C.id} restore`,
            `apply ${P.migration} and run scripts/${newest} before exit 0`);
        } else if (lineOf(line => line.includes(P.migration ?? "\0"), start, restore) < 0) {
          report(RUNNER, restore + 1, `history part runs ${newest} without first applying ${P.id}`,
            `apply ${P.migration} before the restore`);
        }
      }
      const outside = lineOf(line => line.includes(newest), end > 0 ? end + 1 : 0);
      if (outside < 0) {
        report(RUNNER, lines.length, `no ${P.id}-${C.id} restore outside the history part`, `run scripts/${newest} in the current part`);
      }
    }
    if (PP && Object.hasOwn(pythonCases, P.id)) {
      const former = `verify-${PP.id}-${P.id}-restore-contract.py`;
      const call = lineOf(line => line.includes(former), end > 0 ? end + 1 : 0);
      if (call >= 0) {
        let gate = call - 1;
        while (gate >= 0 && lines[gate].trim() !== "fi" && !/^\s*if part_enabled history; then\s*$/.test(lines[gate])) gate--;
        if (gate < 0 || lines[gate].trim() === "fi") {
          report(RUNNER, call + 1, `former newest restore ${former} also runs in the current part`,
            "wrap it in `if part_enabled history; then ... fi`");
        }
      }
    }
    const currentApply = lineOf(line => applies(line, C), end > 0 ? end + 1 : 0);
    lines.forEach((line, index) => {
      if (index > end && line.includes("FINAL_OPERATIONAL_READINESS") && (currentApply < 0 || index < currentApply)) {
        report(RUNNER, index + 1, `checkpoint before the ${C.id} apply uses the moving FINAL readiness alias`,
          `use the version-bound V..._OPERATIONAL_READINESS of that release`);
      }
    });
  }

  // 6. Preflight rendering lists that name the previous release must also
  // name the current one (UTC/ISO settings and blank-line normalization).
  if (texts.has(PREFLIGHT_RENDERER)) {
    const text = texts.get(PREFLIGHT_RENDERER);
    let lists = 0;
    for (const match of text.matchAll(/\[((?:\s*"[A-Za-z0-9-]+",?)+)\s*\]\.includes\(state\.id\)/g)) {
      const ids = [...match[1].matchAll(/"([A-Za-z0-9-]+)"/g)].map(m => m[1]);
      lists++;
      if (ids.includes(P.id) && !ids.includes(C.id)) {
        report(PREFLIGHT_RENDERER, lineAt(text, match.index), `rendering list [${ids.at(0)}..${ids.at(-1)}] names ${P.id} without ${C.id}`,
          `add "${C.id}" to the list`);
      }
    }
    if (!lists) missing(PREFLIGHT_RENDERER, '["v..", ...].includes(state.id)');
  }

  // 7. Guarded rollout chain.
  if (texts.has(ROLLOUT)) {
    const text = texts.get(ROLLOUT);
    const approval = /expectedProviderFingerprint\.startsWith\("([A-Za-z0-9-]+)_catalog="\)/.exec(text);
    if (!approval) missing(ROLLOUT, 'expectedProviderFingerprint.startsWith("vNN_catalog=")');
    else if (approval[1] !== C.id) {
      report(ROLLOUT, lineAt(text, approval.index), `apply approval requires ${approval[1]}_catalog= evidence`, `${C.id}_catalog=`);
    }
    const chain = /const ONE_MIGRATION_PREDECESSORS = Object\.freeze\(\[([^\]]*)\]/.exec(text);
    if (!chain) missing(ROLLOUT, "const ONE_MIGRATION_PREDECESSORS = Object.freeze([...])");
    else {
      const ids = [...chain[1].matchAll(/"([A-Za-z0-9-]+)"/g)].map(m => m[1]);
      if (ids.at(-1) !== P.id) {
        report(ROLLOUT, lineAt(text, chain.index), `--one-migration predecessors end at ${ids.at(-1)}`, `end at "${P.id}"`);
      }
    }
    const counts = /const PREDECESSOR_MIGRATION_COUNTS = Object\.freeze\(\{([^}]*)\}/.exec(text);
    if (!counts) missing(ROLLOUT, "const PREDECESSOR_MIGRATION_COUNTS = Object.freeze({...})");
    else if (!new RegExp(`"${escape(P.id)}"\\s*:`).test(counts[1])) {
      report(ROLLOUT, lineAt(text, counts.index), `accepted predecessor counts omit ${P.id}`,
        `"${P.id}": ROLLOUT.${P.id}MigrationCount`);
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { current: C.id, previous: P.id, findings };
}

export function formatFindings(result) {
  const lines = result.findings.map(finding => `${finding.file}:${finding.line}: ${finding.stale}; expected: ${finding.expected}`);
  lines.push(`${result.findings.length} stale release inventor${result.findings.length === 1 ? "y" : "ies"} for ${result.current} (previous ${result.previous}).`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let root = repositoryRoot;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--root" && argv[index + 1]) root = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  const result = checkReleaseInventory(directorySource(root));
  console.log(formatFindings(result));
  return result.findings.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
