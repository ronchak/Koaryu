import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

export function isDocumentationPath(path) {
  return (
    guidePaths.has(path) ||
    (/^docs\/[A-Za-z0-9_./-]+\.md$/.test(path) &&
      !path
        .split("/")
        .some((part) => part === "." || part === ".." || part === ""))
  );
}

// --no-renames exposes both paths when a file moves. Raw modes prevent a
// symlink or executable named *.md from qualifying as ordinary documentation.
export function classifyDiff(raw) {
  const fields = raw.toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length === 0 || fields.length % 2 !== 0) {
    return { docsOnly: false, reason: "empty or invalid comparison" };
  }
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index].match(
      /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMD])$/,
    );
    if (!match || !isDocumentationPath(fields[index + 1])) {
      return { docsOnly: false, reason: "non-documentation or unknown change" };
    }
    const [, before, after, status] = match;
    const modes = {
      A: ["000000", "100644"],
      D: ["100644", "000000"],
      M: ["100644", "100644"],
    };
    if (before !== modes[status][0] || after !== modes[status][1]) {
      return { docsOnly: false, reason: "non-regular documentation change" };
    }
  }
  return { docsOnly: true, reason: "only ordinary documentation changed" };
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
    return { docsOnly: false, reason: "no supported comparison metadata" };
  }
  try {
    git("merge-base", "--is-ancestor", baseSha, headSha);
    return classifyDiff(
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
      docsOnly: false,
      reason: "comparison unavailable; run full checks",
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selection = selectReleaseChecks({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.EXPECTED_HEAD_SHA,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `docs-only=${selection.docsOnly}\n`,
  );
  const message = `Database checks: ${selection.docsOnly ? "not selected" : "full suite"}. ${selection.reason}.\n`;
  process.stdout.write(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
}
