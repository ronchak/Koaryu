import type { NextConfig } from "next";

import { securityHeadersFromProcessEnv } from "./src/lib/security-headers.ts";

const nextConfig: NextConfig = {
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
