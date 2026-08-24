#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FRONTEND_PLATFORM_KEYS = new Set([
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
  "VERCEL_GIT_COMMIT_SHA",
]);

const backendSecretKeys = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_PLATFORM_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_KOARYU_CORE_PRICE_ID",
  "ACCOUNT_DELETION_WORKER_SECRET",
  "OPERATIONAL_ALERT_WORKER_SECRET",
  "OPERATIONAL_ALERT_PRIMARY_URL",
  "OPERATIONAL_ALERT_PRIMARY_HOST",
  "OPERATIONAL_ALERT_PRIMARY_URL_SHA256",
  "OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET",
  "OPERATIONAL_ALERT_PRIMARY_ACK_SECRET",
  "OPERATIONAL_ALERT_BACKUP_URL",
  "OPERATIONAL_ALERT_BACKUP_HOST",
  "OPERATIONAL_ALERT_BACKUP_URL_SHA256",
  "OPERATIONAL_ALERT_BACKUP_BEARER_SECRET",
  "OPERATIONAL_ALERT_BACKUP_ACK_SECRET",
  "SUPPORT_TRIAGE_SECRET",
];

const backendPublicKeys = [
  "SUPABASE_URL",
  "SUPABASE_DEVELOPMENT_PROJECT_REF",
  "SUPABASE_ALLOW_LEGACY_HS256",
  "FRONTEND_URL",
  "ENVIRONMENT",
  "DEMO_RESET_ENABLED",
  "DEMO_RESET_STUDIO_IDS",
  "STRIPE_MODE",
  "LIVE_BILLING_ENABLED",
  "CORE_SELF_CHECKOUT_ENABLED",
  "OPERATIONAL_ALERTS_ENABLED",
  "BILLING_PLATFORM_FEE_BPS",
  "API_V1_PREFIX",
];

const backendOptionalBlankKeys = [
  "DEMO_RESET_STUDIO_IDS",
  "SUPABASE_DEVELOPMENT_PROJECT_REF",
  "STRIPE_RESTRICTED_KEY",
];

const frontendPublicKeys = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_SITE_URL",
  "BACKEND_API_URL",
  "NEXT_PUBLIC_USE_API_PROXY",
  "NEXT_PUBLIC_PREVIEW_MODE",
  "NEXT_PUBLIC_STUDENTS_PAGED_ROSTER",
  "NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG",
  "OPERATIONAL_ALERTS_ENABLED",
];

const frontendSecretKeys = [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "CRON_SECRET",
  "ACCOUNT_DELETION_WORKER_SECRET",
  "OPERATIONAL_ALERT_WORKER_SECRET",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_HOST",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_EVALUATOR_DEADMAN_BEARER_SECRET",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_HOST",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET",
];

const placeholderTokenPattern = /(?:^|[^a-z0-9])(?:your|placeholder|example|todo)(?:[^a-z0-9]|$)/;
const placeholderPhrasePattern = /(?:^|[^a-z0-9])(?:long-random|change-me|changeme|replace-me)(?:[^a-z0-9]|$)/;
const secretLikeKeyPattern = /(?:^|_)(?:secret|token|password|passcode|credentials?|private|signing|encryption|key)(?:_|$)|(?:^|_)(?:client_id|price_id|dsn|connection_string)(?:_|$)|^(?:database|redis)_url$/i;
const connectionLikeKeyPattern = /^(?:[A-Z0-9]+_)*(?:DATABASE|POSTGRES(?:QL)?|PG|DB|REDIS)(?:_[A-Z0-9]+)*_(?:URL|URI|DSN|CONNECTION_STRING)$/i;
const renderCriticalValues = new Map([
  ["ENVIRONMENT", "production"],
  ["DEMO_RESET_ENABLED", "false"],
  ["DEMO_RESET_STUDIO_IDS", ""],
  ["SUPABASE_ALLOW_LEGACY_HS256", "false"],
  ["SUPABASE_DEVELOPMENT_PROJECT_REF", ""],
  ["STRIPE_MODE", "live"],
  ["LIVE_BILLING_ENABLED", "true"],
  ["CORE_SELF_CHECKOUT_ENABLED", "true"],
  ["OPERATIONAL_ALERTS_ENABLED", "false"],
  ["API_V1_PREFIX", "/api/v1"],
]);
const RENDER_DOCKERFILE_PATH = "./Dockerfile";
const RENDER_DOCKER_CONTEXT = ".";
const RENDER_ROOT_DIR = "backend";
const RENDER_PYTHON_IMAGE =
  "python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317";
const RENDER_JEMALLOC_VERSION = "5.3.0-1";

// Reusable examples stay fail-closed even where production must deliberately
// differ. Each exception names both sides so neither value can drift silently.
const productionRenderExampleDivergences = new Map([
  ["LIVE_BILLING_ENABLED", { exampleValue: "false", manifestValue: "true" }],
]);

function isAllowedProductionRenderExampleDivergence(
  key,
  manifestValue,
  exampleValue,
  criticalValues,
) {
  const allowed = productionRenderExampleDivergences.get(key);
  return (
    allowed?.manifestValue === manifestValue
    && allowed.exampleValue === exampleValue
    && criticalValues.get(key) === manifestValue
  );
}

function unique(values) {
  return [...new Set(values)].sort();
}

export function parseEnvText(path, contents) {
  const entries = new Map();
  const duplicates = [];
  const invalidKeys = [];
  const lines = contents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`${path}:${index + 1} is not a KEY=value line.`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      invalidKeys.push(key);
    }
    if (entries.has(key)) {
      duplicates.push(key);
    }
    entries.set(key, value);
  }

  return { entries, duplicates, invalidKeys };
}

function parseEnvFile(path) {
  return parseEnvText(path, readFileSync(resolve(ROOT, path), "utf8"));
}

export function isPlaceholderValue(value) {
  return value.split(",").every((part) => {
    const normalized = part.trim().toLowerCase();
    return (
      placeholderTokenPattern.test(normalized)
      || placeholderPhrasePattern.test(normalized)
      || (normalized.includes("<") && normalized.includes(">"))
    );
  });
}

export function isSecretLikeKey(key) {
  return secretLikeKeyPattern.test(key) || connectionLikeKeyPattern.test(key);
}

export function classifyEnvKeys(keys, publicKeys, explicitSecretKeys) {
  const publicKeySet = new Set(publicKeys);
  const explicitSecretKeySet = new Set(explicitSecretKeys);
  const secretKeys = [];
  const unclassifiedKeys = [];
  const conflictingKeys = [];

  for (const key of unique(keys)) {
    const isPublic = publicKeySet.has(key);
    const isSecret = explicitSecretKeySet.has(key) || isSecretLikeKey(key);
    if (isPublic && isSecret) {
      conflictingKeys.push(key);
    } else if (isSecret) {
      secretKeys.push(key);
    } else if (!isPublic) {
      unclassifiedKeys.push(key);
    }
  }
  return { secretKeys, unclassifiedKeys, conflictingKeys };
}

export function extractBackendSettingsKeys(contents) {
  return unique(
    [...contents.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
  );
}

export function extractRenderEnvEntries(contents) {
  const entries = [];
  let current = null;

  for (const line of contents.split(/\r?\n/)) {
    const keyMatch = line.match(/^(\s*)-\s+key:\s*([A-Z][A-Z0-9_]*)\s*$/);
    if (keyMatch) {
      if (current) {
        entries.push(current);
      }
      current = {
        key: keyMatch[2],
        indent: keyMatch[1].length,
        hasValue: false,
        sync: null,
        value: null,
      };
      continue;
    }

    if (!current || !line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= current.indent) {
      entries.push(current);
      current = null;
      continue;
    }

    const propertyMatch = line.match(/^\s+(sync|value):\s*(.*)$/);
    if (propertyMatch?.[1] === "sync") {
      current.sync = propertyMatch[2].trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
    } else if (propertyMatch?.[1] === "value") {
      current.hasValue = true;
      current.value = propertyMatch[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }

  if (current) {
    entries.push(current);
  }
  return entries;
}

export function extractRenderEnvKeys(contents) {
  return unique(extractRenderEnvEntries(contents).map((entry) => entry.key));
}

export function extractFrontendRuntimeEnvKeys(contents) {
  const keys = [];
  for (const match of contents.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    keys.push(match[1]);
  }
  for (const match of contents.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) {
    keys.push(match[1]);
  }
  for (const match of contents.matchAll(/(?:const|let|var)\s*{([^}]+)}\s*=\s*process\.env\b/g)) {
    for (const binding of match[1].split(",")) {
      const key = binding.trim().split(/[:=]/, 1)[0]?.trim();
      if (key && ENV_KEY_PATTERN.test(key)) {
        keys.push(key);
      }
    }
  }
  return unique(keys.filter((key) => !FRONTEND_PLATFORM_KEYS.has(key)));
}

function sourceFilesUnder(path) {
  const absolutePath = resolve(ROOT, path);
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childPath = resolve(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(relative(ROOT, childPath)));
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(childPath);
    }
  }
  return files;
}

function frontendRuntimeEnvKeys() {
  const files = [
    ...sourceFilesUnder("frontend/src"),
    resolve(ROOT, "frontend/next.config.ts"),
  ];
  return unique(files.flatMap((path) => extractFrontendRuntimeEnvKeys(readFileSync(path, "utf8"))));
}

export function validateEnvExample(file, parsed) {
  const failures = [];
  const { entries, duplicates, invalidKeys } = parsed;
  const missing = file.requiredKeys.filter((key) => !entries.has(key));
  const allowBlankKeys = new Set(file.allowBlankKeys ?? []);
  const blank = file.requiredKeys.filter((key) => entries.get(key) === "" && !allowBlankKeys.has(key));
  const nonPlaceholderSecrets = file.placeholderKeys.filter((key) => {
    const value = entries.get(key);
    return value !== undefined && value !== "" && !isPlaceholderValue(value);
  });

  if (duplicates.length > 0) {
    failures.push(`${file.path}: duplicate key(s): ${unique(duplicates).join(", ")}`);
  }
  if (invalidKeys.length > 0) {
    failures.push(`${file.path}: invalid key name(s): ${unique(invalidKeys).join(", ")}`);
  }
  if (missing.length > 0) {
    failures.push(`${file.path}: missing required key(s): ${missing.join(", ")}`);
  }
  if (blank.length > 0) {
    failures.push(`${file.path}: blank required key(s): ${blank.join(", ")}`);
  }
  if (nonPlaceholderSecrets.length > 0) {
    failures.push(`${file.path}: secret-shaped example key(s) should stay placeholder-only: ${nonPlaceholderSecrets.join(", ")}`);
  }
  return failures;
}

function validateRenderDockerService(block, serviceName) {
  const failures = [];
  if (!block) {
    failures.push(`render.yaml: ${serviceName} service is missing`);
    return failures;
  }

  for (const [key, expected] of [
    ["runtime", "docker"],
    ["rootDir", RENDER_ROOT_DIR],
    ["dockerfilePath", RENDER_DOCKERFILE_PATH],
    ["dockerContext", RENDER_DOCKER_CONTEXT],
  ]) {
    if (renderScalar(block, key) !== expected) {
      failures.push(
        `render.yaml: ${serviceName} ${key} must equal ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const nativeKey of ["buildCommand", "startCommand"]) {
    if (renderScalar(block, nativeKey) !== null) {
      failures.push(`render.yaml: ${serviceName} must not declare native-runtime ${nativeKey}`);
    }
  }
  if (/^\s*- key:\s*MALLOC_ARENA_MAX\s*$/m.test(block)) {
    failures.push(
      `render.yaml: ${serviceName} must not retain the inactive glibc MALLOC_ARENA_MAX setting`,
    );
  }
  return failures;
}

export function validateRenderDockerRuntime(
  renderSource,
  dockerfileSource,
  startScriptSource,
) {
  const failures = [];
  for (const serviceName of ["koaryu", "koaryu-staging"]) {
    failures.push(...validateRenderDockerService(
      renderServiceBlock(renderSource, serviceName),
      serviceName,
    ));
  }

  const dockerfileLines = dockerfileSource.split(/\r?\n/).map((line) => line.trim());
  const directiveContracts = [
    {
      select: (line) => /^FROM\s/i.test(line),
      expected: `FROM ${RENDER_PYTHON_IMAGE}`,
      diagnostic: "must contain exactly one reviewed immutable final FROM instruction",
    },
    {
      select: (line) => /^ARG JEMALLOC_VERSION=/i.test(line),
      expected: `ARG JEMALLOC_VERSION=${RENDER_JEMALLOC_VERSION}`,
      diagnostic: "must declare the exact jemalloc package version once",
    },
    {
      select: (line) => line.includes("LD_PRELOAD"),
      expected: "ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2",
      diagnostic: "must declare the exact effective jemalloc preload once",
    },
    {
      select: (line) => /^USER\s/i.test(line),
      expected: "USER koaryu",
      diagnostic: "must declare the non-root final user exactly once",
    },
    {
      select: (line) => /^CMD\s/i.test(line),
      expected: 'CMD ["./scripts/start-render.sh"]',
      diagnostic: "must declare the allocator-verifying final command exactly once",
    },
  ];
  for (const contract of directiveContracts) {
    const matches = dockerfileLines.filter(contract.select);
    if (matches.length !== 1 || matches[0] !== contract.expected) {
      failures.push(`backend/Dockerfile: ${contract.diagnostic}`);
    }
  }
  if (dockerfileLines.some((line) => /^ENTRYPOINT\s/i.test(line))) {
    failures.push("backend/Dockerfile: must not override the reviewed command with ENTRYPOINT");
  }
  const pinnedJemallocInstall =
    `apt-get install --yes --no-install-recommends "libjemalloc2=\${JEMALLOC_VERSION}"`;
  if (!dockerfileSource.includes(pinnedJemallocInstall)) {
    failures.push("backend/Dockerfile: must install the exact declared jemalloc package version");
  }

  const activeStartScriptLines = startScriptSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const startScriptRequirements = [
    {
      select: (line) => line.includes("/proc/self/maps"),
      expected: 'if ! grep -Fq "libjemalloc.so.2" /proc/self/maps; then',
      diagnostic: "must actively verify jemalloc is mapped before startup exactly once",
    },
    {
      select: (line) => line.includes("uvicorn"),
      expected:
        'exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}"',
      diagnostic: "must actively exec the single Uvicorn process exactly once",
    },
  ];
  for (const contract of startScriptRequirements) {
    const matches = activeStartScriptLines.filter(contract.select);
    if (matches.length !== 1 || matches[0] !== contract.expected) {
      failures.push(`backend/scripts/start-render.sh: ${contract.diagnostic}`);
    }
  }
  return failures;
}

export function validateRenderManifest(
  requiredKeys,
  entries,
  secretKeys,
  exampleValues = new Map(),
  criticalValues = renderCriticalValues,
) {
  const failures = [];
  const keys = entries.map((entry) => entry.key);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  const missing = requiredKeys.filter((key) => !keys.includes(key));
  const secretKeySet = new Set(secretKeys);

  if (duplicates.length > 0) {
    failures.push(`render.yaml: duplicate key(s): ${unique(duplicates).join(", ")}`);
  }
  if (missing.length > 0) {
    failures.push(`render.yaml: missing backend setting key(s): ${missing.join(", ")}`);
  }
  for (const [key, expectedValue] of criticalValues) {
    if (!exampleValues.has(key)) {
      continue;
    }
    const exampleValue = exampleValues.get(key);
    const allowedDivergence = productionRenderExampleDivergences.get(key);
    const expectedExampleValue = allowedDivergence?.manifestValue === expectedValue
      ? allowedDivergence.exampleValue
      : expectedValue;
    if (exampleValue !== expectedExampleValue) {
      failures.push(`backend/.env.render.example: ${key} must equal ${JSON.stringify(expectedExampleValue)}`);
    }
  }
  for (const entry of entries) {
    if (secretKeySet.has(entry.key)) {
      if (entry.sync !== "false") {
        failures.push(`render.yaml: secret key ${entry.key} must use sync: false`);
      }
      if (entry.hasValue) {
        failures.push(`render.yaml: secret key ${entry.key} must not contain a literal value`);
      }
      continue;
    }

    if (!entry.hasValue) {
      failures.push(`render.yaml: fixed key ${entry.key} must contain a literal value`);
      continue;
    }
    if (
      exampleValues.has(entry.key)
      && entry.value !== exampleValues.get(entry.key)
      && !isAllowedProductionRenderExampleDivergence(
        entry.key,
        entry.value,
        exampleValues.get(entry.key),
        criticalValues,
      )
    ) {
      failures.push(`render.yaml: fixed key ${entry.key} must match backend/.env.render.example`);
    }
    if (criticalValues.has(entry.key) && entry.value !== criticalValues.get(entry.key)) {
      failures.push(`render.yaml: fixed key ${entry.key} must equal ${JSON.stringify(criticalValues.get(entry.key))}`);
    }
  }
  return failures;
}

function renderServiceBlock(source, serviceName) {
  return source
    .split(/(?=^  - type:)/m)
    .find((block) => new RegExp(`^    name: ${serviceName}$`, "m").test(block));
}

// Values that keep the staging service isolated from production and from live
// money. These are the settings whose drift would make a staging rehearsal
// meaningless — or worse, quietly point staging at production data.
const stagingRenderCriticalValues = new Map([
  ["ENVIRONMENT", "staging"],
  ["STRIPE_MODE", "test"],
  ["LIVE_BILLING_ENABLED", "false"],
  ["CORE_SELF_CHECKOUT_ENABLED", "false"],
  ["SUPABASE_URL", "https://nxgsektqsgrtyfhawxbc.supabase.co"],
  ["FRONTEND_URL", "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app"],
  ["DEMO_RESET_ENABLED", "false"],
]);

export function validateStagingRenderService(renderSource, secretKeys) {
  const failures = [];
  const block = renderServiceBlock(renderSource, "koaryu-staging");
  if (!block) {
    return ["render.yaml: staging service koaryu-staging is missing"];
  }

  if (renderScalar(block, "autoDeployTrigger") !== "off") {
    failures.push("render.yaml: staging autoDeployTrigger must be off");
  }
  if (renderScalar(block, "healthCheckPath") !== "/health/ready") {
    failures.push("render.yaml: staging healthCheckPath must enforce /health/ready");
  }

  const entries = extractRenderEnvEntries(block);
  const declared = new Map(
    entries.filter((entry) => entry.hasValue).map((entry) => [entry.key, entry.value]),
  );
  const secretKeySet = new Set(secretKeys);

  for (const [key, expected] of stagingRenderCriticalValues) {
    if (!declared.has(key)) {
      failures.push(`render.yaml: staging must declare ${key}`);
    } else if (declared.get(key) !== expected) {
      failures.push(`render.yaml: staging ${key} must equal ${JSON.stringify(expected)}`);
    }
  }

  for (const entry of entries) {
    if (!secretKeySet.has(entry.key)) {
      continue;
    }
    if (entry.sync !== "false") {
      failures.push(`render.yaml: staging secret key ${entry.key} must use sync: false`);
    }
    if (entry.hasValue) {
      failures.push(`render.yaml: staging secret key ${entry.key} must not contain a literal value`);
    }
  }

  return failures;
}

function renderScalar(block, key) {
  const match = block?.match(new RegExp(`^    ${key}:\\s*([^#\\n]+)`, "m"));
  return match?.[1].trim().replace(/^(?:'([^']*)'|"([^"]*)")$/, "$1$2") ?? null;
}

function normalizedContractText(source) {
  return typeof source === "string" ? source.replace(/\s+/g, " ").trim() : "";
}

function validateDocumentContract(path, source, requirements) {
  const text = normalizedContractText(source);
  return requirements
    .filter((requirement) => !requirement.pattern.test(text))
    .map((requirement) => `${path}: ${requirement.diagnostic}`);
}

function rejectDocumentClaims(path, source, forbiddenClaims) {
  const text = normalizedContractText(source);
  return forbiddenClaims
    .filter((claim) => claim.pattern.test(text))
    .map((claim) => `${path}: ${claim.diagnostic}`);
}

export function validateOperationalAlertCadence(
  vercelConfig,
  operationalAlertsSource,
  releaseControlsSource,
) {
  const failures = [];
  const crons = vercelConfig?.crons;
  const expectedCrons = [
    {
      path: "/api/cron/account-deletions/process-due",
      schedule: "0 8 * * *",
      diagnostic: "the account-deletion cron contract must be preserved exactly once at 0 8 * * *",
    },
    {
      path: "/api/cron/operational-alerts/evaluate",
      schedule: "0 9 * * *",
      diagnostic: "the operational-alert Vercel backup cron must appear exactly once at daily 09:00 UTC (0 9 * * *)",
    },
  ];

  if (!Array.isArray(crons)) {
    failures.push("frontend/vercel.json: crons must be an array containing exactly the two approved entries");
  } else {
    if (crons.length !== expectedCrons.length) {
      failures.push("frontend/vercel.json: crons must contain exactly the two approved entries and no others");
    }
    for (const expected of expectedCrons) {
      const matches = crons.filter(
        (cron) => cron?.path === expected.path && cron?.schedule === expected.schedule,
      );
      const samePath = crons.filter((cron) => cron?.path === expected.path);
      if (matches.length !== 1 || samePath.length !== 1) {
        failures.push(`frontend/vercel.json: ${expected.diagnostic}`);
      }
    }
    const hasOnlyExactObjects = crons.every((cron) => (
      cron
      && typeof cron === "object"
      && !Array.isArray(cron)
      && Object.keys(cron).sort().join(",") === "path,schedule"
      && expectedCrons.some(
        (expected) => cron.path === expected.path && cron.schedule === expected.schedule,
      )
    ));
    if (!hasOnlyExactObjects) {
      failures.push("frontend/vercel.json: crons must contain only the approved path/schedule objects");
    }
  }

  if (operationalAlertsSource !== undefined) {
    failures.push(...validateDocumentContract(
      "docs/operational-alerts.md",
      operationalAlertsSource,
      [
        {
          pattern: /primary trigger is an external scheduler on the director-operated home server/i,
          diagnostic: "must identify the director-operated external scheduler as the primary trigger",
        },
        {
          pattern: /director-operated home server(?:'s|’s) external scheduler[^.]*every five minutes/i,
          diagnostic: "must require the external primary scheduler to run every five minutes",
        },
        {
          pattern: /committed Vercel cron is a daily 09:00 UTC backup/i,
          diagnostic: "must identify Vercel as the daily 09:00 UTC backup",
        },
        {
          pattern: /changes the trigger source, not the required five-minute cadence/i,
          diagnostic: "must state that the trigger source changes without weakening the required five-minute cadence",
        },
        {
          pattern: /call `https:\/\/<production-frontend-origin>\/api\/cron\/operational-alerts\/evaluate` every five minutes/i,
          diagnostic: "must preserve the exact external trigger URL and five-minute invocation contract",
        },
        {
          pattern: /every five minutes with method `GET`/i,
          diagnostic: "must preserve GET as the external trigger method",
        },
        {
          pattern: /header `Authorization: Bearer \$CRON_SECRET`/,
          diagnostic: "must preserve the Authorization: Bearer $CRON_SECRET header contract",
        },
        {
          pattern: /Expect `204` while disabled and `200` when enabled/i,
          diagnostic: "must preserve disabled 204 and enabled 200 response expectations",
        },
        {
          pattern: /35-second request timeout/i,
          diagnostic: "must preserve the 35-second external trigger timeout",
        },
        {
          pattern: /No retry may start concurrently with an in-flight evaluation/i,
          diagnostic: "must forbid retries concurrent with an in-flight evaluation",
        },
        {
          pattern: /scheduler executions must be serialized/i,
          diagnostic: "must require serialized external scheduler execution",
        },
        {
          pattern: /external scheduler(?:'s|’s) restricted secret store is an additional custody location for `CRON_SECRET` and must be included in every `CRON_SECRET` rotation/i,
          diagnostic: "must include the external scheduler secret store in CRON_SECRET custody and every rotation",
        },
      ],
    ));
    failures.push(...rejectDocumentClaims(
      "docs/operational-alerts.md",
      operationalAlertsSource,
      [
        {
          pattern: /Confirm the Vercel plan supports the committed five-minute cron/i,
          diagnostic: "must not leave Vercel five-minute plan support as an open activation gate",
        },
        {
          pattern: /Vercel (?:cron|scheduler) is the (?:five-minute )?primary/i,
          diagnostic: "must not identify Vercel as the primary evaluator trigger",
        },
      ],
    ));
  }

  if (releaseControlsSource !== undefined) {
    failures.push(...validateDocumentContract(
      "docs/release-candidate-controls.md",
      releaseControlsSource,
      [
        {
          pattern: /primary trigger is the director-operated home server(?:'s|’s) external scheduler at the required five-minute cadence/i,
          diagnostic: "must preserve the external primary trigger at the required five-minute cadence",
        },
        {
          pattern: /committed Vercel cron is a daily 09:00 UTC backup/i,
          diagnostic: "must preserve the daily 09:00 UTC Vercel backup",
        },
        {
          pattern: /resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence/i,
          diagnostic: "must preserve the funded-plan resolution by moving the trigger source without weakening cadence",
        },
        {
          pattern: /Nobody may weaken the five-minute cadence merely to make a preview deploy/i,
          diagnostic: "must preserve the explicit preview-deploy cadence warning",
        },
      ],
    ));
    failures.push(...rejectDocumentClaims(
      "docs/release-candidate-controls.md",
      releaseControlsSource,
      [
        {
          pattern: /Vercel plan support for the committed five-minute operational-alert cron remains a funded operator gate/i,
          diagnostic: "must not retain the obsolete open Vercel funded-plan gate",
        },
        {
          pattern: /funded-plan gate remains (?:open|unresolved)/i,
          diagnostic: "must not contradict the resolved Vercel funded-plan decision",
        },
        {
          pattern: /Vercel (?:cron|scheduler) is the (?:five-minute )?primary/i,
          diagnostic: "must not identify Vercel as the primary evaluator trigger",
        },
      ],
    ));
  }

  return failures;
}

export function validateProviderDeploymentControls(
  renderSource,
  vercelConfig,
  operationalAlertsSource,
  releaseControlsSource,
) {
  const failures = [];
  const productionService = renderServiceBlock(renderSource, "koaryu");
  if (!productionService) {
    failures.push("render.yaml: production service koaryu is missing");
  } else {
    if (renderScalar(productionService, "autoDeployTrigger") !== "off") {
      failures.push("render.yaml: production autoDeployTrigger must be off");
    }
    if (renderScalar(productionService, "healthCheckPath") !== "/health/ready") {
      failures.push("render.yaml: production healthCheckPath must enforce /health/ready");
    }
  }

  const deploymentEnabled = vercelConfig?.git?.deploymentEnabled;
  if (!deploymentEnabled || typeof deploymentEnabled !== "object" || Array.isArray(deploymentEnabled)) {
    failures.push("frontend/vercel.json: git.deploymentEnabled must be a branch map");
  } else {
    if (deploymentEnabled.main !== false) {
      failures.push("frontend/vercel.json: automatic main deployments must be disabled");
    }
    if (deploymentEnabled.staging !== true) {
      failures.push("frontend/vercel.json: automatic staging deployments must remain enabled");
    }
    if (deploymentEnabled["codex/launch-readiness-candidate"] !== false) {
      failures.push(
        "frontend/vercel.json: the launch candidate preview must stay disabled under the documented manual-promotion controls",
      );
    }
    for (const [pattern, enabled] of Object.entries(deploymentEnabled)) {
      const isExactNonMainBranch = /^[A-Za-z0-9._/-]+$/.test(pattern) && pattern !== "main";
      if (enabled === true && !isExactNonMainBranch) {
        failures.push(
          `frontend/vercel.json: enabled branch pattern ${JSON.stringify(pattern)} must be an exact non-main branch`,
        );
      }
    }
  }

  failures.push(...validateOperationalAlertCadence(
    vercelConfig,
    operationalAlertsSource,
    releaseControlsSource,
  ));
  return failures;
}

export function runEnvExampleCheck() {
  const backendSettingsKeys = extractBackendSettingsKeys(
    readFileSync(resolve(ROOT, "backend/app/core/config.py"), "utf8"),
  );
  const renderSource = readFileSync(resolve(ROOT, "render.yaml"), "utf8");
  // render.yaml declares more than one service. Everything below is the
  // production contract and is specific to `koaryu`; scanning the whole file
  // would apply production expectations to staging and fail on values that are
  // correct precisely because staging is not production.
  const productionRenderBlock = renderServiceBlock(renderSource, "koaryu") ?? renderSource;
  const renderEnvEntries = extractRenderEnvEntries(productionRenderBlock);
  const frontendRequiredKeys = unique([
    ...frontendPublicKeys,
    ...frontendSecretKeys,
    ...frontendRuntimeEnvKeys(),
  ]);
  const backendClassification = classifyEnvKeys(
    backendSettingsKeys,
    backendPublicKeys,
    backendSecretKeys,
  );
  const frontendClassification = classifyEnvKeys(
    frontendRequiredKeys,
    frontendPublicKeys,
    frontendSecretKeys,
  );
  const backendPlaceholderKeys = backendClassification.secretKeys;
  const frontendPlaceholderKeys = frontendClassification.secretKeys;
  const envFiles = [
    {
      path: "backend/.env.example",
      requiredKeys: backendSettingsKeys,
      placeholderKeys: backendPlaceholderKeys,
      allowBlankKeys: backendOptionalBlankKeys,
    },
    {
      path: "backend/.env.render.example",
      requiredKeys: backendSettingsKeys,
      placeholderKeys: backendPlaceholderKeys,
      allowBlankKeys: backendOptionalBlankKeys,
    },
    {
      path: "frontend/.env.example",
      requiredKeys: frontendRequiredKeys,
      placeholderKeys: frontendPlaceholderKeys,
    },
  ];

  const failures = [];
  for (const [label, classification] of [
    ["backend", backendClassification],
    ["frontend", frontendClassification],
  ]) {
    if (classification.unclassifiedKeys.length > 0) {
      failures.push(`${label}: unclassified environment key(s): ${classification.unclassifiedKeys.join(", ")}`);
    }
    if (classification.conflictingKeys.length > 0) {
      failures.push(`${label}: environment key(s) classified as both public and secret: ${classification.conflictingKeys.join(", ")}`);
    }
  }
  let renderExampleValues = new Map();
  for (const file of envFiles) {
    try {
      const parsed = parseEnvFile(file.path);
      failures.push(...validateEnvExample(file, parsed));
      if (file.path === "backend/.env.render.example") {
        renderExampleValues = parsed.entries;
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  failures.push(...validateRenderManifest(
    backendSettingsKeys,
    renderEnvEntries,
    backendPlaceholderKeys,
    renderExampleValues,
  ));
  failures.push(...validateStagingRenderService(renderSource, backendPlaceholderKeys));
  try {
    failures.push(...validateRenderDockerRuntime(
      renderSource,
      readFileSync(resolve(ROOT, "backend/Dockerfile"), "utf8"),
      readFileSync(resolve(ROOT, "backend/scripts/start-render.sh"), "utf8"),
    ));
  } catch (error) {
    failures.push(`Render Docker runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
  let operationalAlertsSource;
  let releaseControlsSource;
  try {
    operationalAlertsSource = readFileSync(resolve(ROOT, "docs/operational-alerts.md"), "utf8");
  } catch (error) {
    failures.push(`docs/operational-alerts.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    releaseControlsSource = readFileSync(resolve(ROOT, "docs/release-candidate-controls.md"), "utf8");
  } catch (error) {
    failures.push(`docs/release-candidate-controls.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const vercelConfig = JSON.parse(
      readFileSync(resolve(ROOT, "frontend/vercel.json"), "utf8"),
    );
    failures.push(...validateProviderDeploymentControls(
      renderSource,
      vercelConfig,
      operationalAlertsSource,
      releaseControlsSource,
    ));
  } catch (error) {
    failures.push(
      `frontend/vercel.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`env-example check failed: ${failure}`);
    }
    return 1;
  }

  for (const file of envFiles) {
    console.log(`env-example check passed: ${relative(ROOT, resolve(ROOT, file.path))}`);
  }
  console.log("env-example check passed: runtime settings and Render manifest stay documented");
  return 0;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  process.exitCode = runEnvExampleCheck();
}
