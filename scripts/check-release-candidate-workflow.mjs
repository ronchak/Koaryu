import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredSnippets = [
  "pull_request:",
  "workflow_dispatch:",
  "Candidate head and repository controls",
  "Frontend tests, lint, build, and audit",
  "Required production browser smoke",
  "Backend tests, contracts, and audit",
  "Supabase migration and contract suite",
  "Static and secret analysis",
  "Release candidate gate",
  "scripts/verify-supabase-contracts.sh",
  "npm audit --omit=dev --audit-level=high",
  "python -m pip_audit -r requirements.txt",
  "python -m piptools compile --quiet --generate-hashes",
  "python -m bandit -r backend/app -ll",
  "supabase/setup-cli@ab058987d8d6c725971f6cf9d0b5c98467e30bd1",
  "gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7",
  "GITLEAKS_VERSION: 8.27.2",
  'gitleaks git --redact --verbose --exit-code 1 --log-opts="--all"',
  "gitleaks dir . --redact --verbose --exit-code 1",
  "github/codeql-action/analyze@v4",
  "npm run check:env-examples",
  "npm run audit:support-privacy",
  "export NEXT_PUBLIC_PREVIEW_MODE=true",
  "npx playwright install --with-deps chromium",
  "npm run test:e2e:required-smoke",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
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
  if (exactCheckoutCount < 6) {
    errors.push("Every job must check out the exact pull-request head SHA.");
  }

  if (!source.includes("if: ${{ always() }}")) {
    errors.push("The aggregate release-candidate gate must evaluate all job outcomes.");
  }

  const aggregateBlock = source.slice(source.indexOf("  release-candidate:"));
  const needsMatch = aggregateBlock.match(/\n    needs:\n((?:      - [^\n]+\n)+)/);
  const requiredJobs = [
    { job: "repository-controls", variable: "REPOSITORY" },
    { job: "frontend", variable: "FRONTEND" },
    { job: "browser-smoke", variable: "BROWSER_SMOKE" },
    { job: "backend", variable: "BACKEND" },
    { job: "database", variable: "DATABASE" },
    { job: "static-analysis", variable: "STATIC_ANALYSIS" },
  ];
  const requiredNeeds = requiredJobs.map(({ job }) => job);
  const actualNeeds = needsMatch
    ? needsMatch[1].match(/- ([^\n]+)/g)?.map((line) => line.slice(2)).sort() ?? []
    : [];
  if (JSON.stringify(actualNeeds) !== JSON.stringify([...requiredNeeds].sort())) {
    errors.push("The aggregate gate must depend on every required candidate job exactly once.");
  }

  for (const { job, variable } of requiredJobs) {
    const envLine = `${variable}_RESULT: \${{ needs.${job}.result }}`;
    const assertion = `test "$${variable}_RESULT" = success`;
    if (!aggregateBlock.includes(envLine) || !aggregateBlock.includes(assertion)) {
      errors.push(`The aggregate gate must fail closed on ${job}.`);
    }
  }

  const browserStart = source.indexOf("  browser-smoke:");
  const browserEnd = source.indexOf("\n  backend:", browserStart);
  if (browserStart === -1 || browserEnd === -1) {
    errors.push("The workflow must define the required browser-smoke job.");
  } else {
    const browserBlock = source.slice(browserStart, browserEnd);
    const browserHeader = browserBlock.slice(0, browserBlock.indexOf("\n    steps:"));
    const timeoutMatch = browserHeader.match(/\n    timeout-minutes: (\d+)\n/);
    const smokeStepStart = browserBlock.indexOf("      - name: Run required browser smoke");
    const smokeStepEnd = browserBlock.indexOf("\n      - name:", smokeStepStart + 1);
    const smokeStep = smokeStepStart === -1
      ? ""
      : browserBlock.slice(
        smokeStepStart,
        smokeStepEnd === -1 ? browserBlock.length : smokeStepEnd,
      );
    const artifactStepStart = browserBlock.indexOf("      - name: Preserve browser failure artifacts");
    const artifactStepEnd = browserBlock.indexOf("\n      - name:", artifactStepStart + 1);
    const artifactStep = artifactStepStart === -1
      ? ""
      : browserBlock.slice(
        artifactStepStart,
        artifactStepEnd === -1 ? browserBlock.length : artifactStepEnd,
      );

    if (/\n    if:/.test(browserHeader)) {
      errors.push("The required browser-smoke job must not be conditional.");
    }
    if (!timeoutMatch || Number(timeoutMatch[1]) > 15) {
      errors.push("The required browser-smoke job must have a timeout of at most 15 minutes.");
    }
    if (!smokeStep.includes("run: npm run test:e2e:required-smoke")) {
      errors.push("The browser-smoke job must run the required browser suite.");
    }
    if (/\n        if:/.test(smokeStep)) {
      errors.push("The required browser-smoke step must not be conditional.");
    }
    if (
      !artifactStep.includes("if: failure()")
      || !artifactStep.includes("frontend/playwright-report/")
      || !artifactStep.includes("frontend/test-results/required-browser-smoke/")
      || !artifactStep.includes("retention-days: 7")
    ) {
      errors.push("The browser-smoke job must retain only bounded failure artifacts.");
    }
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
