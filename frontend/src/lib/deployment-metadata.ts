const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PUBLIC_ENVIRONMENTS = new Set(["production", "preview", "development", "staging"]);

function safeEnvironment(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && PUBLIC_ENVIRONMENTS.has(normalized) ? normalized : null;
}

function safeCommitSha(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && COMMIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

export function getDeploymentMetadata(env: NodeJS.ProcessEnv = process.env) {
  const environment = [
    env.VERCEL_TARGET_ENV,
    env.VERCEL_ENV,
  ].map(safeEnvironment).find(Boolean) ?? "local";

  return {
    service: "koaryu-frontend",
    environment,
    commit_sha: safeCommitSha(env.VERCEL_GIT_COMMIT_SHA),
  };
}
