"use client";

import { forwardRef, useId, useImperativeHandle, useMemo, useRef } from "react";

import { loomFrame, loomLayout, warpPath, type LoomFrame, type LoomLayout } from "./weave-model";
import styles from "./journey.module.css";

export interface WeaveLoomHandle {
  setProgress(progress: number): void;
}

interface WeaveLoomProps {
  readonly width: number;
  readonly height: number;
  readonly threads: readonly string[];
}

function set(element: Element | null | undefined, name: string, value: string) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setStyle(
  element: HTMLElement | SVGElement | null | undefined,
  name: string,
  value: string,
) {
  if (element && element.style.getPropertyValue(name) !== value) {
    element.style.setProperty(name, value);
  }
}

/** Angle the woven floor tips toward the camera as it becomes the room's floor, in degrees. */
const LIE_ANGLE = 52;

/**
 * The weave moment, layered over the scene between the sky and the room. It
 * renders once per layout; scene progress writes attributes directly.
 */
export const WeaveLoom = forwardRef<WeaveLoomHandle, WeaveLoomProps>(function WeaveLoom(
  { width, height, threads },
  ref,
) {
  const rawId = useId();
  const id = (name: string) => `koaryu-loom-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}-${name}`;
  const layout = useMemo(() => loomLayout(width, height, threads), [width, height, threads]);
  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const matRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const lastRef = useRef<{
    layout: LoomLayout | null;
    frame: LoomFrame | null;
    elements: { warps: Element[]; labels: Element[]; wefts: Element[]; ground: Element | null };
  }>({ layout: null, frame: null, elements: { warps: [], labels: [], wefts: [], ground: null } });

  useImperativeHandle(
    ref,
    () => ({
      setProgress(progress: number) {
        const root = rootRef.current;
        const svg = svgRef.current;
        if (!root || !svg) return;
        const last = lastRef.current;
        const frame = loomFrame(progress, layout);
        const previous = last.layout === layout ? last.frame : null;
        if (last.layout !== layout) {
          // Look the moving parts up once per layout, not once per frame.
          const all = (selector: string) => Array.from(svg.querySelectorAll(selector));
          last.elements = {
            warps: all("[data-warp]"),
            labels: all("[data-label]"),
            wefts: all("[data-weft]"),
            ground: svg.querySelector("[data-ground]"),
          };
        }
        last.layout = layout;
        last.frame = frame;
        const { elements } = last;

        if (root.dataset.visible !== String(frame.visible)) {
          root.dataset.visible = String(frame.visible);
        }
        if (!frame.visible) return;
        setStyle(washRef.current, "opacity", String(frame.wash));
        setStyle(wallRef.current, "opacity", String(Math.min(frame.wash, frame.room)));
        setStyle(matRef.current, "opacity", String(frame.mat));
        set(elements.ground, "opacity", String(frame.ground));
        // The mat tips toward the camera around its far edge, which settles on the room's floor line.
        const drop = (layout.floorFraction - layout.matTopFraction) * height * frame.lie;
        setStyle(
          matRef.current,
          "transform",
          frame.lie
            ? `translateY(${drop.toFixed(1)}px) perspective(${Math.round(height * 1.4)}px) rotateX(${(frame.lie * LIE_ANGLE).toFixed(2)}deg)`
            : "",
        );

        frame.warps.forEach((warp, index) => {
          const before = previous?.warps[index];
          const group = elements.warps[index];
          if (!group) return;
          if (!before || before.settle !== warp.settle) {
            const d = warpPath(layout, layout.warps[index]!, warp.settle);
            for (const path of group.querySelectorAll("path")) set(path, "d", d);
          }
          set(group, "opacity", String(warp.opacity));
          set(group.querySelector("[data-cloud]"), "opacity", String(warp.cloud));
        });
        frame.labels.forEach((label, index) => {
          const text = elements.labels[index];
          set(text, "opacity", String(label.opacity));
          set(text, "transform", label.shift ? `translate(${label.shift} 0)` : "");
        });
        frame.wefts.forEach((woven, index) => {
          if (previous && previous.wefts[index] === woven) return;
          const weft = layout.wefts[index]!;
          const group = elements.wefts[index];
          if (!group) return;
          if (woven <= 0) {
            set(group, "display", "none");
            return;
          }
          set(group, "display", "inline");
          const span = layout.matBottom - layout.weftTop;
          const length = Math.max(weft.width, span * woven);
          const top = weft.downward ? layout.weftTop : layout.matBottom - length;
          for (const body of group.querySelectorAll("[data-body]")) {
            set(body, "y", top.toFixed(1));
            set(body, "height", length.toFixed(1));
          }
          // Crossings are revealed just behind the strand's rounded tip.
          const reveal = Math.max(0, length - weft.width * 0.5);
          const clip = group.querySelector("clipPath rect");
          set(clip, "y", (weft.downward ? top : layout.matBottom - reveal).toFixed(1));
          set(clip, "height", reveal.toFixed(1));
        });
      },
    }),
    [height, layout],
  );

  const { visible, matTop, matBottom, shadow, warps, wefts, over, fontSize } = layout;
  const left = visible.left - 120;
  const right = visible.right + 120;

  return (
    <div ref={rootRef} className={styles.loom} data-visible="false" aria-hidden="true">
      <div ref={washRef} className={styles.loomWash} />
      <div ref={wallRef} className={styles.loomWall} />
      <div
        ref={matRef}
        className={styles.loomMat}
        style={{ transformOrigin: `50% ${(layout.matTopFraction * 100).toFixed(2)}%` }}
      >
        <svg
          ref={svgRef}
          className={styles.loomSvg}
          viewBox={layout.viewBox}
          preserveAspectRatio="xMidYMid slice"
          xmlns="http://www.w3.org/2000/svg"
          focusable="false"
        >
          <defs>
            <linearGradient id={id("round-v")} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.3" />
              <stop offset="0.38" stopColor="#fff" stopOpacity="0.06" />
              <stop offset="0.7" stopColor="#2a1a08" stopOpacity="0" />
              <stop offset="1" stopColor="#2a1a08" stopOpacity="0.24" />
            </linearGradient>
            <linearGradient id={id("round-h")} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#2a1a08" stopOpacity="0.2" />
              <stop offset="0.3" stopColor="#fff" stopOpacity="0.16" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0.04" />
              <stop offset="1" stopColor="#2a1a08" stopOpacity="0.26" />
            </linearGradient>
            {(
              [
                ["shade-up", "0", "1", "0", "0"],
                ["shade-down", "0", "0", "0", "1"],
                ["shade-left", "1", "0", "0", "0"],
                ["shade-right", "0", "0", "1", "0"],
              ] as const
            ).map(([name, x1, y1, x2, y2]) => (
              <linearGradient key={name} id={id(name)} x1={x1} y1={y1} x2={x2} y2={y2}>
                <stop offset="0" stopColor="#1e1205" stopOpacity="0.42" />
                <stop offset="1" stopColor="#1e1205" stopOpacity="0" />
              </linearGradient>
            ))}
            <radialGradient id={id("light")} cx="0.28" cy="0.1" r="0.95">
              <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
              <stop offset="1" stopColor="#1e1205" stopOpacity="0.22" />
            </radialGradient>
          </defs>

          <rect
            data-ground=""
            opacity="0"
            className={styles.loomGround}
            x={left}
            y={matTop - 2}
            width={right - left}
            height={matBottom - matTop + 4}
          />

          {warps.map((warp, row) => (
            <g key={warp.label} data-warp={row} opacity="0">
              <path className={styles.loomWarp} data-tone={warp.tone} />
              <path fill={`url(#${id("round-v")})`} />
              <path className={styles.loomCloud} data-cloud="" />
            </g>
          ))}

          {wefts.map((weft, column) => (
            <g key={column} data-weft={column} display="none">
              <clipPath id={id(`clip-${column}`)}>
                <rect
                  x={weft.x - shadow - 1}
                  y={matTop}
                  width={weft.width + shadow * 2 + 2}
                  height={0}
                />
              </clipPath>
              <rect
                className={styles.loomWeft}
                data-tone={weft.tone}
                data-body=""
                x={weft.x}
                width={weft.width}
                rx={weft.width / 2}
              />
              <rect
                data-body=""
                x={weft.x}
                width={weft.width}
                rx={weft.width / 2}
                fill={`url(#${id("round-h")})`}
              />
              <g clipPath={`url(#${id(`clip-${column}`)})`}>
                {warps.map((warp, row) =>
                  over[row]![column] ? (
                    <g key={row}>
                      <rect
                        className={styles.loomWarp}
                        data-tone={warp.tone}
                        x={weft.x - 0.5}
                        y={warp.y}
                        width={weft.width + 1}
                        height={warp.thickness}
                      />
                      <rect
                        x={weft.x - 0.5}
                        y={warp.y}
                        width={weft.width + 1}
                        height={warp.thickness}
                        fill={`url(#${id("round-v")})`}
                      />
                      <rect
                        x={weft.x}
                        y={warp.y - shadow}
                        width={weft.width}
                        height={shadow}
                        fill={`url(#${id("shade-up")})`}
                      />
                      <rect
                        x={weft.x}
                        y={warp.y + warp.thickness}
                        width={weft.width}
                        height={shadow}
                        fill={`url(#${id("shade-down")})`}
                      />
                    </g>
                  ) : (
                    <g key={row}>
                      <rect
                        x={weft.x - shadow}
                        y={warp.y}
                        width={shadow}
                        height={warp.thickness}
                        fill={`url(#${id("shade-left")})`}
                      />
                      <rect
                        x={weft.x + weft.width}
                        y={warp.y}
                        width={shadow}
                        height={warp.thickness}
                        fill={`url(#${id("shade-right")})`}
                      />
                    </g>
                  ),
                )}
              </g>
            </g>
          ))}

          <rect
            x={left}
            y={matTop - 2}
            width={right - left}
            height={matBottom - matTop + 2}
            fill={`url(#${id("light")})`}
            className={styles.loomLight}
          />

          {warps.map((warp, row) => (
            <text
              key={warp.label}
              data-label={row}
              className={styles.loomLabel}
              x={warp.labelX + fontSize * 0.8}
              y={warp.y + warp.thickness / 2}
              fontSize={fontSize}
              dominantBaseline="central"
              opacity="0"
            >
              {warp.label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
});
