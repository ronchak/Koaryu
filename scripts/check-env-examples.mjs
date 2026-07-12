#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FRONTEND_PLATFORM_KEYS = new Set(["NODE_ENV"]);

const backendSecretKeys = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_PLATFORM_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_KOARYU_CORE_PRICE_ID",
  "ACCOUNT_DELETION_WORKER_SECRET",
  "SUPPORT_TRIAGE_SECRET",
];

const backendPublicKeys = [
  "SUPABASE_URL",
  "SUPABASE_ALLOW_LEGACY_HS256",
  "FRONTEND_URL",
  "ENVIRONMENT",
  "DEMO_RESET_ENABLED",
  "DEMO_RESET_STUDIO_IDS",
  "BILLING_PLATFORM_FEE_BPS",
  "API_V1_PREFIX",
];

const backendOptionalBlankKeys = [
  "DEMO_RESET_STUDIO_IDS",
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
];

const frontendSecretKeys = [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "CRON_SECRET",
  "ACCOUNT_DELETION_WORKER_SECRET",
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
  ["API_V1_PREFIX", "/api/v1"],
]);

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
    if (exampleValues.has(key) && exampleValues.get(key) !== expectedValue) {
      failures.push(`backend/.env.render.example: ${key} must equal ${JSON.stringify(expectedValue)}`);
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
    if (exampleValues.has(entry.key) && entry.value !== exampleValues.get(entry.key)) {
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

function renderScalar(block, key) {
  const match = block?.match(new RegExp(`^    ${key}:\\s*([^#\\n]+)`, "m"));
  return match?.[1].trim().replace(/^(?:'([^']*)'|"([^"]*)")$/, "$1$2") ?? null;
}

export function validateProviderDeploymentControls(renderSource, vercelConfig) {
  const failures = [];
  const productionService = renderServiceBlock(renderSource, "koaryu");
  if (!productionService) {
    failures.push("render.yaml: production service koaryu is missing");
  } else {
    if (renderScalar(productionService, "autoDeployTrigger") !== "off") {
      failures.push("render.yaml: production autoDeployTrigger must be off");
    }
    if (renderScalar(productionService, "healthCheckPath") !== "/health") {
      failures.push("render.yaml: bootstrap healthCheckPath must remain /health until /health/live is deployed");
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
    for (const [pattern, enabled] of Object.entries(deploymentEnabled)) {
      const isExactNonMainBranch = /^[A-Za-z0-9._/-]+$/.test(pattern) && pattern !== "main";
      if (enabled === true && !isExactNonMainBranch) {
        failures.push(
          `frontend/vercel.json: enabled branch pattern ${JSON.stringify(pattern)} must be an exact non-main branch`,
        );
      }
    }
  }

  const deletionCron = vercelConfig?.crons?.find(
    (cron) => cron?.path === "/api/cron/account-deletions/process-due",
  );
  if (deletionCron?.schedule !== "0 8 * * *") {
    failures.push("frontend/vercel.json: the account-deletion cron contract must be preserved");
  }
  return failures;
}

export function runEnvExampleCheck() {
  const backendSettingsKeys = extractBackendSettingsKeys(
    readFileSync(resolve(ROOT, "backend/app/core/config.py"), "utf8"),
  );
  const renderSource = readFileSync(resolve(ROOT, "render.yaml"), "utf8");
  const renderEnvEntries = extractRenderEnvEntries(renderSource);
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
  try {
    const vercelConfig = JSON.parse(
      readFileSync(resolve(ROOT, "frontend/vercel.json"), "utf8"),
    );
    failures.push(...validateProviderDeploymentControls(renderSource, vercelConfig));
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
