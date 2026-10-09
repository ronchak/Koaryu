"use client";

import { useLayoutEffect } from "react";

import { SCENE_ATTRIBUTE, resolveScene, sceneOverride } from "./scene-time";

/**
 * Keeps <html data-scene> right after the pre-paint script: on client-side
 * navigation (where inline scripts do not run), and when a visitor comes back
 * to a tab left open across 7 PM or 6 AM. It never flips the world while the
 * page is being read. Pages without the illustrated world drop the attribute.
 */
export function SceneClock() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const next = resolveScene(new Date(), window.location.search);
      if (root.getAttribute(SCENE_ATTRIBUTE) !== next) root.setAttribute(SCENE_ATTRIBUTE, next);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") apply();
    };
    apply();
    const forced = sceneOverride(window.location.search) !== null;
    if (!forced) {
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("pageshow", apply);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", apply);
      root.removeAttribute(SCENE_ATTRIBUTE);
    };
  }, []);

  return null;
}
