import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredSnippets = [
  "pull_request:",
  "workflow_dispatch:",
  "Candidate head and repository controls",
  "Frontend tests, lint, build, and audit",
  "Backend tests, contracts, and audit",
  "Supabase migration and contract suite",
  "Static and secret analysis",
  "Release candidate gate",
  "scripts/verify-supabase-contracts.sh",
  "npm audit --omit=dev --audit-level=high",
  "python -m pip_audit -r requirements.txt",
  "python -m piptools compile --quiet --generate-hashes",
  "python -m bandit -r backend/app -ll",
  "gitleaks/gitleaks-action@v2.3.9",
  "github/codeql-action/analyze@v4",
  "npm run check:env-examples",
  "npm run audit:support-privacy",
];

export function validateReleaseCandidateWorkflow(source) {
  const errors = [];
  const pullRequestStart = source.indexOf("  pull_request:");
  const pushStart = source.indexOf("  push:", pullRequestStart + 1);

  if (pullRequestStart === -1 || pushStart === -1) {
    errors.push("The workflow must run for pull_request and push events.");
  } else {
    const pullRequestBlock = source.slice(pullRequestStart, pushStart);
    if (/^\s+paths(?:-ignore)?:/m.test(pullRequestBlock)) {
      errors.push("The pull_request trigger must not use path filters.");
    }
  }

  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      errors.push(`Missing release-candidate control: ${snippet}`);
    }
  }

  const exactCheckoutCount = source.match(
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g,
  )?.length ?? 0;
  if (exactCheckoutCount < 5) {
    errors.push("Every job must check out the exact pull-request head SHA.");
  }

  if (!source.includes("if: ${{ always() }}")) {
    errors.push("The aggregate release-candidate gate must evaluate all job outcomes.");
  }

  return errors;
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const workflowPath = path.join(
    scriptDir,
    "..",
    ".github",
    "workflows",
    "release-candidate.yml",
  );
  const errors = validateReleaseCandidateWorkflow(
    fs.readFileSync(workflowPath, "utf8"),
  );

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Release-candidate workflow controls are complete.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
