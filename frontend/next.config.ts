import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

import { securityHeadersFromProcessEnv } from "./src/lib/security-headers.ts";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: frontendRoot,
  },
  outputFileTracingRoot: frontendRoot,
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
