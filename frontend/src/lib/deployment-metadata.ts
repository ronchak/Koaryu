const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PUBLIC_ENVIRONMENTS = new Set(["production", "preview", "development", "staging"]);
const STAGING_SITE_URL = "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app";

function safeEnvironment(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && PUBLIC_ENVIRONMENTS.has(normalized) ? normalized : null;
}

function safeCommitSha(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && COMMIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

export function getDeploymentMetadata(env: NodeJS.ProcessEnv = process.env) {
  const targetEnvironment = safeEnvironment(env.VERCEL_TARGET_ENV);
  const vercelEnvironment = safeEnvironment(env.VERCEL_ENV);
  const providerEnvironment = targetEnvironment ?? vercelEnvironment;
  const environment = providerEnvironment === "preview" && env.NEXT_PUBLIC_SITE_URL === STAGING_SITE_URL
    ? "staging"
    : providerEnvironment ?? "local";

  return {
    service: "koaryu-frontend",
    environment,
    commit_sha: safeCommitSha(env.VERCEL_GIT_COMMIT_SHA),
  };
}
