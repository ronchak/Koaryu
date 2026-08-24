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
  "Deterministic performance regression gate",
  "Static and secret analysis",
  "Release candidate gate",
  "scripts/verify-supabase-contracts.sh",
  "scripts/verify-connect-identity-concurrency.sh",
  "scripts/verify-core-checkout-accept-reserve-concurrency.sh",
  "scripts/verify-student-profile-rank-plan-concurrency.sh",
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
  "npm run check:supabase-controls",
  "npm run audit:support-privacy",
  "node --test scripts/verify-deployed-release.test.mjs",
];

const candidateJobs = [
  { job: "repository-controls", variable: "REPOSITORY" },
  { job: "frontend", variable: "FRONTEND" },
  { job: "backend", variable: "BACKEND" },
  { job: "database", variable: "DATABASE" },
  { job: "performance-regression", variable: "PERFORMANCE_REGRESSION" },
  { job: "static-analysis", variable: "STATIC_ANALYSIS" },
];

function jobBlock(source, jobName) {
  const start = source.indexOf(`  ${jobName}:`);
  if (start === -1) return null;
  const remainder = source.slice(start + 2);
  const nextJobOffset = remainder.search(/^  [a-z0-9][a-z0-9-]*:/m);
  return source.slice(start, nextJobOffset === -1 ? source.length : start + 2 + nextJobOffset);
}

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
  if (exactCheckoutCount !== candidateJobs.length) {
    errors.push("Every candidate job must check out the exact pull-request head SHA exactly once.");
  }

  const repositoryControlsStart = source.indexOf("  repository-controls:");
  const frontendStart = source.indexOf("  frontend:", repositoryControlsStart + 1);
  const repositoryControlsBlock = source.slice(repositoryControlsStart, frontendStart);
  if (!repositoryControlsBlock.includes("fetch-depth: 0")) {
    errors.push(
      "Repository controls must fetch complete history for immutable ancestry checks.",
    );
  }

  if (!source.includes("if: ${{ always() }}")) {
    errors.push("The aggregate release-candidate gate must evaluate all job outcomes.");
  }

  const aggregateBlock = source.slice(source.indexOf("  release-candidate:"));
  const needsMatch = aggregateBlock.match(/\n    needs:\n((?:      - [^\n]+\n)+)/);
  const requiredNeeds = candidateJobs.map(({ job }) => job);
  const actualNeeds = needsMatch
    ? needsMatch[1].match(/- ([^\n]+)/g)?.map((line) => line.slice(2)).sort() ?? []
    : [];
  if (JSON.stringify(actualNeeds) !== JSON.stringify([...requiredNeeds].sort())) {
    errors.push("The aggregate gate must depend on every required candidate job exactly once.");
  }

  for (const { job, variable } of candidateJobs) {
    const envLine = `${variable}_RESULT: \${{ needs.${job}.result }}`;
    const assertion = `test "$${variable}_RESULT" = success`;
    if (!aggregateBlock.includes(envLine) || !aggregateBlock.includes(assertion)) {
      errors.push(`The aggregate gate must fail closed on ${job}.`);
    }
  }

  const performanceBlock = jobBlock(source, "performance-regression");
  if (!performanceBlock) {
    errors.push("The workflow must define the performance-regression job.");
  } else {
    const requiredPerformanceControls = [
      "name: Deterministic performance regression gate",
      "timeout-minutes: 10",
      "uses: actions/checkout@v7",
      "ref: ${{ github.event.pull_request.head.sha || github.sha }}",
      'EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
      'run: test \"$(git rev-parse HEAD)\" = \"$EXPECTED_HEAD_SHA\"',
      "uses: actions/setup-node@v6",
      'node-version: "22.13.0"',
      "id: setup-python",
      "uses: actions/setup-python@v6",
      'python-version: "3.11"',
      "backend/requirements.txt",
      "performance/dashboard-summary-budget.json",
      "git ls-files --error-unmatch backend/requirements.txt performance/dashboard-summary-budget.json",
      "KOARYU_PERFORMANCE_PYTHON: ${{ steps.setup-python.outputs.python-path }}",
      'run: npm run check:performance-regression -- --expected-sha "$EXPECTED_HEAD_SHA"',
    ];
    for (const snippet of requiredPerformanceControls) {
      if (!performanceBlock.includes(snippet)) {
        errors.push(`The performance-regression job is missing control: ${snippet}`);
      }
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
