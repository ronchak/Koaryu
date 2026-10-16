import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyDiff,
  isApplicationOnlyPath,
  isCurrentDatabasePath,
  isDocumentationPath,
  selectReleaseChecks,
} from "./select-release-checks.mjs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/release-candidate.yml", import.meta.url),
  "utf8",
);
const scopeBlock = workflow.slice(
  workflow.indexOf("      - name: Select database checks"),
  workflow.indexOf("      - name: Verify candidate workflow coverage"),
);
const scopeRun = scopeBlock
  .split("        run: |\n")[1]
  .split("\n")
  .filter((line) => line.startsWith("          "))
  .map((line) => line.slice(10))
  .join("\n");
const selectorSource = fs.readFileSync(
  new URL("./select-release-checks.mjs", import.meta.url),
  "utf8",
);

function runScope(r) {
  const dir = fs.mkdtempSync(path.join(r.cwd, "scope-output-"));
  const output = path.join(dir, "output"),
    summary = path.join(dir, "summary");
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", scopeRun], {
    cwd: r.cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      BASE_SHA: r.baseSha,
      EXPECTED_HEAD_SHA: r.git("rev-parse", "HEAD"),
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  r.scopeDiagnostics = `${result.stdout}\n${result.stderr}`;
  return fs.readFileSync(output, "utf8");
}

function repository(t, initial = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-doc-selection-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (name, body = "test\n") => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), body);
  };
  const commit = () => {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  git("config", "user.email", "verification@example.invalid");
  git("config", "user.name", "Verification");
  git("config", "core.filemode", "true");
  write("README.md", "initial\n");
  for (const [name, body] of Object.entries(initial)) write(name, body);
  const baseSha = commit();
  return {
    cwd,
    git,
    write,
    commit,
    baseSha,
    select: (options = {}) =>
      selectReleaseChecks({
        cwd,
        eventName: "pull_request",
        baseSha,
        headSha: git("rev-parse", "HEAD"),
        ...options,
      }),
  };
}

const fullParts = 'database-parts=["current","drift","history"]';
const currentParts = 'database-parts=["current","drift"]';

function changes(t, names, initial = {}) {
  const r = repository(t, initial);
  for (const name of names) r.write(name);
  r.commit();
  return r;
}

test("allows ordinary guides and documentation additions, edits and deletions", (t) => {
  const r = repository(t, { "docs/old.md": "old\n" });
  r.write("README.md", "changed\n");
  r.write("AGENTS.md");
  r.write("frontend/CLAUDE.md");
  r.write("docs/nested/new.md");
  fs.unlinkSync(path.join(r.cwd, "docs/old.md"));
  r.commit();
  assert.equal(r.select().database, "skip");
  assert.equal(r.select({ eventName: "push" }).database, "skip");
});

test("frontend and performance-fixture changes skip the database suite", (t) => {
  const r = changes(t, ["frontend/src/page.tsx", "frontend/package-lock.json", "performance/budget.json", "docs/notes.md"]);
  fs.chmodSync(path.join(r.cwd, "frontend/src/page.tsx"), 0o755);
  r.commit();
  assert.equal(r.select().database, "skip");
  assert.equal(r.select({ eventName: "push" }).database, "skip");
});

test("backend code, backend tests and contract SQL run current database proofs", (t) => {
  for (const name of [
    "backend/app/services/student_service.py",
    "backend/tests/test_students.py",
    "supabase/verification/new_contract.sql",
  ]) {
    const r = changes(t, [name, "frontend/src/page.tsx", "docs/notes.md"]);
    assert.equal(r.select().database, "current", name);
    assert.equal(r.select({ eventName: "push" }).database, "full", name);
  }
});

test("migrations, history inputs, tooling, dependencies, workflow and unknown paths run the full suite", (t) => {
  for (const name of [
    "supabase/migrations/change.sql",
    "supabase/config.toml",
    "backend/app/services/generated_release_readiness.py",
    "supabase/verification/billing_payer_balance_v41.sql",
    "supabase/verification/billing_subscription_terms.sql",
    "supabase/verification/missed_class_automation_contract.sql",
    "backend/requirements.txt",
    "backend/pyproject.toml",
    "package.json",
    ".github/workflows/release-candidate.yml",
    "scripts/select-release-checks.mjs",
    "scripts/verify-supabase-contracts-local.sh",
    "scripts/README.md",
    "unknown.md",
  ]) {
    const r = changes(t, [name, "backend/app/query.py"]);
    assert.equal(r.select().database, "full", name);
  }
});

test("every file a released-predecessor restore proof reads selects the full suite", () => {
  const suite = fs.readFileSync(new URL("./verify-supabase-contracts-local.sh", import.meta.url), "utf8");
  const loop = suite.slice(0, suite.indexOf('if [[ "$SUITE_PART" == history ]]; then'));
  const proofs = [...new Set(loop.match(/verify-v\d+-v\d+-restore-contract\.(?:sh|py)/g))];
  assert.ok(proofs.length >= 25, proofs.join(","));
  const inputs = new Set();
  for (const name of [...proofs, "local_postgres_verification.py"]) {
    const source = fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    for (const [input] of source.matchAll(/\b(?:backend|supabase\/verification)\/[A-Za-z0-9_./-]+\.[a-z]+/g))
      inputs.add(input);
  }
  assert.ok(inputs.size > 0);
  for (const input of inputs) {
    assert.equal(isCurrentDatabasePath(input), false, input);
    assert.equal(isApplicationOnlyPath(input), false, input);
  }
});

test("renaming runtime code into documentation checks the original path", (t) => {
  const r = repository(t, { "backend/app.py": "code\n" });
  fs.mkdirSync(path.join(r.cwd, "docs"));
  r.git("mv", "backend/app.py", "docs/moved.md");
  r.commit();
  assert.equal(r.select().database, "full");
});

test("renaming a migration into the frontend checks the original path", (t) => {
  const r = repository(t, { "supabase/migrations/old.sql": "code\n" });
  fs.mkdirSync(path.join(r.cwd, "frontend"));
  r.git("mv", "supabase/migrations/old.sql", "frontend/old.sql");
  r.commit();
  assert.equal(r.select().database, "full");
});

test("renaming a guide into runtime code checks the destination", (t) => {
  const r = repository(t);
  r.git("mv", "README.md", "runtime.py");
  r.commit();
  assert.equal(r.select().database, "full");
});

test("symlinks and executable files named Markdown do not qualify", (t) => {
  const r = repository(t);
  fs.mkdirSync(path.join(r.cwd, "docs"));
  fs.symlinkSync("../README.md", path.join(r.cwd, "docs/link.md"));
  r.commit();
  assert.equal(r.select().database, "full");
  fs.unlinkSync(path.join(r.cwd, "docs/link.md"));
  r.write("docs/run.md");
  fs.chmodSync(path.join(r.cwd, "docs/run.md"), 0o755);
  r.commit();
  assert.equal(r.select().database, "full");
});

test("symlinks in skip or current areas run the full suite", (t) => {
  for (const name of ["frontend/link.ts", "backend/app/link.py"]) {
    const r = repository(t);
    fs.mkdirSync(path.dirname(path.join(r.cwd, name)), { recursive: true });
    fs.symlinkSync("../../README.md", path.join(r.cwd, name));
    r.commit();
    assert.equal(r.select().database, "full", name);
  }
});

test("a Markdown mode-only change cannot select documentation checks", (t) => {
  const r = repository(t);
  fs.chmodSync(path.join(r.cwd, "README.md"), 0o755);
  r.commit();
  assert.equal(r.select().database, "full");
});

test("missing metadata, unavailable commits, manual runs and empty diffs run the full suite", (t) => {
  const r = repository(t);
  assert.equal(r.select().database, "full");
  r.write("docs/change.md");
  r.commit();
  for (const options of [
    { baseSha: undefined },
    { baseSha: "0".repeat(40) },
    { baseSha: "a".repeat(40) },
    { eventName: "workflow_dispatch" },
    { eventName: "schedule" },
    { eventName: "unknown" },
  ]) {
    assert.equal(r.select(options).database, "full");
  }
});

test("a base that is not an ancestor runs the full suite", (t) => {
  const r = repository(t);
  r.write("docs/first.md");
  const sibling = r.commit();
  r.git("checkout", "--detach", r.baseSha);
  r.write("docs/second.md");
  r.commit();
  assert.equal(r.select({ baseSha: sibling }).database, "full");
});

test("a moved or malformed candidate is rejected instead of emitting a selection", (t) => {
  const r = repository(t);
  r.write("docs/change.md");
  r.commit();
  assert.throws(
    () => r.select({ headSha: r.baseSha }),
    /exact checked-out candidate/,
  );
  assert.throws(
    () => r.select({ headSha: "main" }),
    /exact checked-out candidate/,
  );
});

test("malformed or truncated raw comparisons run the full suite", () => {
  for (const raw of [
    "",
    "garbage\0docs/a.md\0",
    ":100644 100644 abc def M\0docs/a.md",
    ":100644 100644 " +
      "a".repeat(40) +
      " " +
      "b".repeat(40) +
      " X\0docs/a.md\0",
    ":100644 100644 " +
      "a".repeat(40) +
      " " +
      "b".repeat(40) +
      " M\0frontend/a.ts\0garbage\0backend/app/a.py\0",
  ]) {
    assert.equal(classifyDiff(Buffer.from(raw)).database, "full");
  }
  for (const name of [
    "docs/../runtime.md",
    "docs//a.md",
    "docs/./a.md",
    "docs/a.sql",
    "docs/a.md\n",
    "docs/a.md\0runtime.py",
  ])
    assert.equal(isDocumentationPath(name), false, name);
  for (const name of ["frontend/../supabase/migrations/a.sql", "frontend//a.ts", "frontend", "frontendx/a.ts"])
    assert.equal(isApplicationOnlyPath(name), false, name);
  for (const name of ["backend/app/../../supabase/migrations/a.sql", "backend/app", "backend/application/a.py"])
    assert.equal(isCurrentDatabasePath(name), false, name);
});

test("the real CLI emits the exact selection and summary for a pinned documentation commit", (t) => {
  const r = repository(t);
  r.write("docs/change.md");
  const headSha = r.commit();
  const output = path.join(r.cwd, "output"),
    summary = path.join(r.cwd, "summary");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./select-release-checks.mjs", import.meta.url))],
    {
      cwd: r.cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        BASE_SHA: r.baseSha,
        EXPECTED_HEAD_SHA: headSha,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  assert.equal(fs.readFileSync(output, "utf8"), "database-scope=skip\n");
  assert.match(
    fs.readFileSync(summary, "utf8"),
    /skip.*only documentation/,
  );
});

test("actual workflow bootstrap runs full checks when the base has no selector", (t) => {
  const r = repository(t);
  r.write("docs/change.md");
  r.commit();
  assert.equal(runScope(r), `database-scope=full\n${fullParts}\n`);
});

test("actual workflow uses a regular trusted base selector for each scope", (t) => {
  for (const [name, scope, parts] of [
    ["docs/change.md", "skip", fullParts],
    ["frontend/src/page.tsx", "skip", fullParts],
    ["backend/app/query.py", "current", currentParts],
    ["supabase/migrations/change.sql", "full", fullParts],
  ]) {
    const r = changes(t, [name], {
      "scripts/select-release-checks.mjs": selectorSource,
    });
    assert.equal(runScope(r), `database-scope=${scope}\n${parts}\n`, `${name}\n${r.scopeDiagnostics}`);
  }
});

test("a candidate selector that approves every change cannot approve its own change", (t) => {
  const r = repository(t, {
    "scripts/select-release-checks.mjs": selectorSource,
  });
  r.write(
    "scripts/select-release-checks.mjs",
    'import fs from "node:fs"; fs.writeFileSync("candidate-ran", "bad"); fs.appendFileSync(process.env.GITHUB_OUTPUT, "database-scope=skip\\n");\n',
  );
  r.write("supabase/migrations/change.sql");
  r.commit();
  assert.equal(runScope(r), `database-scope=full\n${fullParts}\n`);
  assert.equal(fs.existsSync(path.join(r.cwd, "candidate-ran")), false);
});

test("invalid, legacy or failed trusted-base output cannot narrow the database suite", (t) => {
  for (const body of [
    'import fs from "node:fs"; fs.appendFileSync(process.env.GITHUB_OUTPUT, "database-scope=maybe\\n");\n',
    'import fs from "node:fs"; fs.appendFileSync(process.env.GITHUB_OUTPUT, "docs-only=true\\n");\n',
    'import fs from "node:fs"; fs.appendFileSync(process.env.GITHUB_OUTPUT, "database-scope=skip\\ndatabase-scope=current\\n");\n',
    'import fs from "node:fs"; fs.appendFileSync(process.env.GITHUB_OUTPUT, "database-scope=skip\\n"); process.exit(1);\n',
    "process.exit(0);\n",
  ]) {
    const r = repository(t, { "scripts/select-release-checks.mjs": body });
    r.write("docs/change.md");
    r.commit();
    assert.equal(runScope(r), `database-scope=full\n${fullParts}\n`, body);
  }
});

test("an executable trusted-base file cannot qualify as the regular pinned selector", (t) => {
  const r = repository(t, {
    "scripts/select-release-checks.mjs": selectorSource,
  });
  fs.chmodSync(path.join(r.cwd, "scripts/select-release-checks.mjs"), 0o755);
  r.baseSha = r.commit();
  r.write("docs/change.md");
  r.commit();
  assert.equal(runScope(r), `database-scope=full\n${fullParts}\n`);
});
