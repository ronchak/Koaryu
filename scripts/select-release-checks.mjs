import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// CI copies this module from the pinned base into RUNNER_TEMP. Keep it
// self-contained: importing candidate helpers would defeat that trust boundary.

const shaPattern = /^[0-9a-f]{40}$/;
const guidePaths = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "frontend/AGENTS.md",
  "frontend/CLAUDE.md",
  "frontend/README.md",
  "backend/AGENTS.md",
  "backend/README.md",
  "supabase/AGENTS.md",
]);

// Released-predecessor restore proofs read this backend file besides
// migrations, contract SQL and scripts, so it runs the historical sweep.
const historyInputs = new Set([
  "backend/app/services/generated_release_readiness.py",
]);
const scopeRank = { skip: 0, current: 1, full: 2 };

function isPlainPath(path) {
  return !path
    .split("/")
    .some((part) => part === "." || part === ".." || part === "");
}

export function isDocumentationPath(path) {
  return (
    guidePaths.has(path) ||
    (/^docs\/[A-Za-z0-9_./-]+\.md$/.test(path) && isPlainPath(path))
  );
}

// No database job reads the frontend or the performance fixture.
export function isApplicationOnlyPath(path) {
  return /^(frontend|performance)\/[^\n\0]+$/.test(path) && isPlainPath(path);
}

// Current database proofs import backend code; only the listed history inputs
// also feed the released-predecessor restore proofs. Restore proofs also run
// contract SQL by constructed paths, so supabase/verification is always full.
export function isCurrentDatabasePath(path) {
  return (
    /^backend\/(app|tests)\/[^\n\0]+$/.test(path) &&
    isPlainPath(path) &&
    !historyInputs.has(path)
  );
}

function pathScope(path, before, after, status) {
  const modes = {
    A: [["000000"], ["100644", "100755"]],
    D: [["100644", "100755"], ["000000"]],
    M: [["100644", "100755"], ["100644", "100755"]],
  };
  const documentationModes = {
    A: ["000000", "100644"],
    D: ["100644", "000000"],
    M: ["100644", "100644"],
  };
  if (isDocumentationPath(path)) {
    const [expectedBefore, expectedAfter] = documentationModes[status];
    return before === expectedBefore && after === expectedAfter
      ? "skip"
      : "full";
  }
  const regular =
    modes[status][0].includes(before) && modes[status][1].includes(after);
  if (regular && isApplicationOnlyPath(path)) return "skip";
  if (regular && isCurrentDatabasePath(path)) return "current";
  return "full";
}

const reasons = {
  skip: "only documentation, frontend or performance-fixture files changed",
  current:
    "backend changes need current database proofs, not the historical restore sweep",
  full: "migrations, database tooling, dependencies, workflow or unknown paths changed",
};

// --no-renames exposes both paths when a file moves. Raw modes prevent a
// symlink or executable named *.md from qualifying as ordinary documentation.
export function classifyDiff(raw) {
  const fields = raw.toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length === 0 || fields.length % 2 !== 0) {
    return { database: "full", reason: "empty or invalid comparison" };
  }
  let database = "skip";
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index].match(
      /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMD])$/,
    );
    if (!match) {
      return { database: "full", reason: "invalid comparison entry" };
    }
    const [, before, after, status] = match;
    const scope = pathScope(fields[index + 1], before, after, status);
    if (scopeRank[scope] > scopeRank[database]) database = scope;
  }
  return { database, reason: reasons[database] };
}

export function selectReleaseChecks({ cwd, eventName, baseSha, headSha }) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (
    !shaPattern.test(headSha ?? "") ||
    git("rev-parse", "HEAD").toString().trim() !== headSha
  ) {
    throw new Error("Selection requires the exact checked-out candidate SHA.");
  }
  if (
    !["pull_request", "push"].includes(eventName) ||
    !shaPattern.test(baseSha ?? "") ||
    /^0+$/.test(baseSha)
  ) {
    return { database: "full", reason: "no supported comparison metadata" };
  }
  let selection;
  try {
    git("merge-base", "--is-ancestor", baseSha, headSha);
    selection = classifyDiff(
      git(
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--abbrev=40",
        baseSha,
        headSha,
      ),
    );
  } catch {
    return {
      database: "full",
      reason: "comparison unavailable; run full checks",
    };
  }
  // Pushes to main are the post-merge backstop for the historical sweep.
  if (eventName === "push" && selection.database === "current") {
    return { database: "full", reason: "main push runs the historical restore sweep" };
  }
  return selection;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  const selection = selectReleaseChecks({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.EXPECTED_HEAD_SHA,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `database-scope=${selection.database}\n`,
  );
  const message = `Database checks: ${selection.database}. ${selection.reason}.\n`;
  process.stdout.write(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
}
