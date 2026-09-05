import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { securityHeadersFromProcessEnv } from "./src/lib/security-headers.ts";

// Keep local resolution and deployment asset paths within the monorepo.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const nextConfig: NextConfig = {
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
