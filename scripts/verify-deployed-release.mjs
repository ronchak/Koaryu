#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEPLOYMENT_TARGETS = Object.freeze({
  production: Object.freeze({
    frontendOrigin: "https://koaryu.app",
    backendApi: "https://koaryu.onrender.com/api/v1",
    frontendEnvironment: "production",
    backendEnvironment: "production",
  }),
  staging: Object.freeze({
    frontendOrigin: "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app",
    backendApi: "https://koaryu-staging.onrender.com/api/v1",
    frontendEnvironment: "staging",
    backendEnvironment: "staging",
  }),
});

function requiredString(name, value) {
  if (!value || value !== value.trim()) {
    throw new Error(`${name} is required and must not contain surrounding whitespace.`);
  }
  return value;
}

function expectedTarget(options) {
  const environment = requiredString("environment", options.environment).toLowerCase();
  const target = DEPLOYMENT_TARGETS[environment];
  if (!target) {
    throw new Error("environment must be staging or production.");
  }
  const expectedSha = requiredString("expected SHA", options.expectedSha).toLowerCase();
  if (!SHA_PATTERN.test(expectedSha)) {
    throw new Error("expected SHA must be a full lowercase hexadecimal commit SHA.");
  }
  const frontendOrigin = requiredString("frontend origin", options.frontendOrigin);
  const backendApi = requiredString("backend API", options.backendApi);
  if (frontendOrigin !== target.frontendOrigin || backendApi !== target.backendApi) {
    throw new Error(`deployment URLs do not match Koaryu's pinned ${environment} pair.`);
  }
  return { environment, expectedSha, frontendOrigin, backendApi, ...target };
}

function verifyPayload(name, payload, { service, environment, expectedSha, status }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${name} did not return a JSON object.`);
  }
  if (
    payload.service !== service
    || payload.environment !== environment
    || payload.commit_sha !== expectedSha
    || (status !== undefined && payload.status !== status)
  ) {
    throw new Error(`${name} does not report the exact expected release identity.`);
  }
}

async function fetchJson(url, { fetchImpl, headers }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`release identity probe failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function verifyDeployedRelease(options, dependencies = {}) {
  const target = expectedTarget(options);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable.");
  }
  const bypassSecret = options.frontendBypassSecret;
  const frontendHeaders = bypassSecret
    ? { "x-vercel-protection-bypass": requiredString("frontend bypass secret", bypassSecret) }
    : undefined;
  const backendOrigin = new URL(target.backendApi).origin;

  const frontend = await fetchJson(`${target.frontendOrigin}/api/version`, {
    fetchImpl,
    headers: frontendHeaders,
  });
  verifyPayload("frontend /api/version", frontend, {
    service: "koaryu-frontend",
    environment: target.frontendEnvironment,
    expectedSha: target.expectedSha,
  });

  const backendRoot = await fetchJson(`${backendOrigin}/health/ready`, { fetchImpl });
  verifyPayload("backend /health/ready", backendRoot, {
    service: "koaryu-api",
    environment: target.backendEnvironment,
    expectedSha: target.expectedSha,
    status: "ready",
  });

  const backendApi = await fetchJson(`${target.backendApi}/health/ready`, { fetchImpl });
  verifyPayload("backend /api/v1/health/ready", backendApi, {
    service: "koaryu-api",
    environment: target.backendEnvironment,
    expectedSha: target.expectedSha,
    status: "ready",
  });

  return {
    verified: true,
    environment: target.environment,
    expected_sha: target.expectedSha,
    frontend: { service: frontend.service, environment: frontend.environment, commit_sha: frontend.commit_sha },
    backend: { service: backendApi.service, environment: backendApi.environment, commit_sha: backendApi.commit_sha },
  };
}

export function parseReleaseVerifierArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("arguments must be --name value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  return {
    expectedSha: values["expected-sha"],
    environment: values.environment,
    frontendOrigin: values["frontend-origin"],
    backendApi: values["backend-api"],
    frontendBypassSecret: process.env.KOARYU_FRONTEND_VERIFY_BYPASS_SECRET,
  };
}

async function main() {
  const evidence = await verifyDeployedRelease(parseReleaseVerifierArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Exact-SHA deployed-release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
