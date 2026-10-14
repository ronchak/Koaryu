import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { securityHeadersFromProcessEnv } from "./src/lib/security-headers.ts";
import { getNavigationDeploymentId } from "./src/lib/deployment-id.ts";

// Keep local resolution and deployment asset paths within the monorepo.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const nextConfig: NextConfig = {
  deploymentId: getNavigationDeploymentId(),
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
  // Drop the framework advertisement; it only helps someone fingerprinting us.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeadersFromProcessEnv()],
      },
      {
        source: "/marketing/:path*",
        // These filenames are not hashed, so changed artwork must revalidate.
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "www.koaryu.app",
          },
        ],
        destination: "https://koaryu.app/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
