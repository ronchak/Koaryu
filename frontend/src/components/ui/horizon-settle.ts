"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/*
 * Position settle (FLIP), the product's reorder motion: capture where keyed
 * items sit, change the order, and each moved item glides from its old place
 * to its new one. Items that appear fade in; items that leave just go. The
 * duration is `--product-motion-settle-duration` (180ms in the product shell,
 * 0 under reduced motion), and `prefers-reduced-motion` turns it off anywhere:
 * the change itself always applies at once.
 */

const SETTLE_EASING = "cubic-bezier(.16, 1, .3, 1)";

function settleDuration(node: HTMLElement): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const value = window
    .getComputedStyle(node)
    .getPropertyValue("--product-motion-settle-duration")
    .trim();
  const duration = value.endsWith("ms")
    ? Number.parseFloat(value)
    : value.endsWith("s")
      ? Number.parseFloat(value) * 1000
      : 180;
  return Number.isFinite(duration) ? Math.max(0, duration) : 180;
}

export type PositionSettle<K extends string> = {
  /** A ref callback for the item with this key; stable per key. */
  register: (key: K) => (node: HTMLElement | null) => void;
  /** Call right before a change; `except` (a dragged item) is left where it is. */
  capture: (options?: { except?: K }) => void;
};

export function usePositionSettle<K extends string>(): PositionSettle<K> {
  const nodes = useRef(new Map<K, HTMLElement>());
  const refs = useRef(new Map<K, (node: HTMLElement | null) => void>());
  const pending = useRef<{ rects: Map<K, DOMRect>; except?: K } | null>(null);
  const animations = useRef(new Map<K, Animation>());

  const register = useCallback((key: K) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node: HTMLElement | null) => {
        if (node) nodes.current.set(key, node);
        else nodes.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  const capture = useCallback((options?: { except?: K }) => {
    const captured = {
      rects: new Map(
        Array.from(nodes.current, ([key, node]) => [key, node.getBoundingClientRect()]),
      ),
      except: options?.except,
    };
    pending.current = captured;
    // A capture whose change never rendered (nothing moved) must not replay on a
    // later, unrelated commit, after scrolling has moved everything.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        if (pending.current === captured) pending.current = null;
      }),
    );
  }, []);

  // After every commit: play the change captured just before it, if any.
  useLayoutEffect(() => {
    const previous = pending.current;
    pending.current = null;
    const first = nodes.current.values().next().value;
    if (!previous || !first || typeof first.animate !== "function") return;
    const duration = settleDuration(first);
    if (duration === 0) return;
    for (const [key, node] of nodes.current) {
      if (key === previous.except) continue;
      const before = previous.rects.get(key);
      animations.current.get(key)?.cancel();
      let keyframes: Keyframe[];
      if (!before) {
        keyframes = [
          { opacity: 0, transform: "scale(0.98)" },
          { opacity: 1, transform: "none" },
        ];
      } else {
        const after = node.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        keyframes = [
          { transform: `translate3d(${dx}px, ${dy}px, 0)`, zIndex: "1" },
          { transform: "translate3d(0, 0, 0)", zIndex: "1" },
        ];
      }
      const animation = node.animate(keyframes, {
        duration: Math.round(duration * 1.35),
        easing: SETTLE_EASING,
      });
      animations.current.set(key, animation);
      void animation.finished
        .catch(() => undefined)
        .finally(() => {
          if (animations.current.get(key) === animation) animations.current.delete(key);
        });
    }
  });

  useEffect(() => {
    const running = animations.current;
    return () => {
      for (const animation of running.values()) animation.cancel();
      running.clear();
    };
  }, []);

  return { register, capture };
}
