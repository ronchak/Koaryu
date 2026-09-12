import { createHash } from "node:crypto";

/** Vercel custom IDs are at most 32 characters and must distinguish deployments. */
export function getNavigationDeploymentId(env: NodeJS.ProcessEnv = process.env) {
  if (env.NEXT_DEPLOYMENT_ID) return env.NEXT_DEPLOYMENT_ID;
  if (!/^[0-9a-f]{40}$/.test(env.VERCEL_GIT_COMMIT_SHA ?? "")) return undefined;
  return createHash("sha256")
    .update(
      [
        env.VERCEL_GIT_COMMIT_SHA,
        env.VERCEL_TARGET_ENV ?? env.VERCEL_ENV ?? "local",
        env.VERCEL_URL ?? "local",
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
}
