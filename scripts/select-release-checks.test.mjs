import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyDiff,
  isDocumentationPath,
  selectReleaseChecks,
} from "./select-release-checks.mjs";

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

test("allows ordinary guides and documentation additions, edits and deletions", (t) => {
  const r = repository(t, { "docs/old.md": "old\n" });
  r.write("README.md", "changed\n");
  r.write("AGENTS.md");
  r.write("frontend/CLAUDE.md");
  r.write("docs/nested/new.md");
  fs.unlinkSync(path.join(r.cwd, "docs/old.md"));
  r.commit();
  assert.equal(r.select().docsOnly, true);
  assert.equal(r.select({ eventName: "push" }).docsOnly, true);
});

test("any code, database, dependency, workflow, helper or unknown path selects the full suite", (t) => {
  const r = repository(t);
  for (const name of [
    "supabase/migrations/change.sql",
    "supabase/verification/test.sql",
    "supabase/config.toml",
    "backend/requirements.txt",
    "backend/app/query.py",
    "frontend/src/page.tsx",
    "package.json",
    "performance/budget.json",
    ".github/workflows/release-candidate.yml",
    "scripts/select-release-checks.mjs",
    "scripts/README.md",
    "unknown.md",
  ]) {
    r.write(name);
    r.commit();
    assert.equal(r.select().docsOnly, false, name);
  }
});

test("mixed documentation and runtime changes cannot use the fast path", (t) => {
  const r = repository(t);
  r.write("docs/change.md");
  r.write("backend/app/change.py");
  r.commit();
  assert.equal(r.select().docsOnly, false);
});

test("renaming runtime code into documentation checks the original path", (t) => {
  const r = repository(t, { "backend/app.py": "code\n" });
  fs.mkdirSync(path.join(r.cwd, "docs"));
  r.git("mv", "backend/app.py", "docs/moved.md");
  r.commit();
  assert.equal(r.select().docsOnly, false);
});

test("renaming a guide into runtime code checks the destination", (t) => {
  const r = repository(t);
  r.git("mv", "README.md", "runtime.py");
  r.commit();
  assert.equal(r.select().docsOnly, false);
});

test("symlinks and executable files named Markdown do not qualify", (t) => {
  const r = repository(t);
  fs.mkdirSync(path.join(r.cwd, "docs"));
  fs.symlinkSync("../README.md", path.join(r.cwd, "docs/link.md"));
  r.commit();
  assert.equal(r.select().docsOnly, false);
  fs.unlinkSync(path.join(r.cwd, "docs/link.md"));
  r.write("docs/run.md");
  fs.chmodSync(path.join(r.cwd, "docs/run.md"), 0o755);
  r.commit();
  assert.equal(r.select().docsOnly, false);
});

test("a Markdown mode-only change cannot select documentation checks", (t) => {
  const r = repository(t);
  fs.chmodSync(path.join(r.cwd, "README.md"), 0o755);
  r.commit();
  assert.equal(r.select().docsOnly, false);
});

test("missing metadata, unavailable commits, manual runs and empty diffs run the full suite", (t) => {
  const r = repository(t);
  assert.equal(r.select().docsOnly, false);
  r.write("docs/change.md");
  r.commit();
  for (const options of [
    { baseSha: undefined },
    { baseSha: "0".repeat(40) },
    { baseSha: "a".repeat(40) },
    { eventName: "workflow_dispatch" },
    { eventName: "unknown" },
  ]) {
    assert.equal(r.select(options).docsOnly, false);
  }
});

test("a base that is not an ancestor runs the full suite", (t) => {
  const r = repository(t);
  r.write("docs/first.md");
  const sibling = r.commit();
  r.git("checkout", "--detach", r.baseSha);
  r.write("docs/second.md");
  r.commit();
  assert.equal(r.select({ baseSha: sibling }).docsOnly, false);
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

test("malformed or truncated raw comparisons cannot report docs-only", () => {
  for (const raw of [
    "",
    "garbage\0docs/a.md\0",
    ":100644 100644 abc def M\0docs/a.md",
    ":100644 100644 " +
      "a".repeat(40) +
      " " +
      "b".repeat(40) +
      " X\0docs/a.md\0",
  ]) {
    assert.equal(classifyDiff(Buffer.from(raw)).docsOnly, false);
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
  assert.equal(fs.readFileSync(output, "utf8"), "docs-only=true\n");
  assert.match(
    fs.readFileSync(summary, "utf8"),
    /not selected.*only ordinary documentation/,
  );
});
