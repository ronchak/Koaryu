"use client";

import { useEffect } from "react";

export function BackendWarmup() {
  useEffect(() => {
    void fetch("/api/proxy/health", {
      method: "GET",
      cache: "no-store",
      keepalive: true,
      headers: {
        Accept: "application/json",
      },
    }).catch(() => {
      // Warmup is opportunistic; the landing page should stay pure UI.
    });
  }, []);

  return null;
}
