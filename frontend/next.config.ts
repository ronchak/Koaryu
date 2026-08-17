import path from "node:path";

import type { NextConfig } from "next";

const repositoryRoot = path.join(process.cwd(), "..");

const nextConfig: NextConfig = {
  outputFileTracingRoot: repositoryRoot,
  turbopack: {
    root: repositoryRoot,
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
