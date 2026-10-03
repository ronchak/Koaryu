"use client";

import { useEffect } from "react";

import { resolveLegacyHash } from "./legacy-hash";

/** Sends links that used retired section names to the section that replaced them. */
export function LegacyHashRedirect() {
  useEffect(() => {
    const rewrite = () => {
      const target = resolveLegacyHash(window.location.hash);
      if (!target) return;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#${target}`,
      );
      document.getElementById(target)?.scrollIntoView({ block: "start" });
    };
    rewrite();
    window.addEventListener("hashchange", rewrite);
    return () => window.removeEventListener("hashchange", rewrite);
  }, []);
  return null;
}
