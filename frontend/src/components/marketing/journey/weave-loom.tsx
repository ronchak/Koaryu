"use client";

import { forwardRef, useId, useImperativeHandle, useMemo, useRef } from "react";

import {
  loomFrame,
  loomLayout,
  warpPath,
  weftPath,
  type LoomFrame,
  type LoomLayout,
} from "./weave-model";
import styles from "./journey.module.css";

export interface WeaveLoomHandle {
  setProgress(progress: number): void;
}

interface WeaveLoomProps {
  readonly width: number;
  readonly height: number;
}

function set(element: Element | null | undefined, name: string, value: string) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setStyle(element: HTMLElement | null | undefined, name: string, value: string) {
  if (element && element.style.getPropertyValue(name) !== value) {
    element.style.setProperty(name, value);
  }
}

/** Angle the woven mat tips toward the camera as it becomes the room's floor, in degrees. */
const LIE_ANGLE = 52;

interface LoomElements {
  readonly live: Element[];
  readonly warps: Element[];
  readonly shadows: Element[][];
  readonly clouds: Element[];
  readonly wefts: Element[];
  readonly slides: Element[];
  readonly reaches: Element[];
  readonly ground: Element | null;
  readonly texture: Element | null;
}

/**
 * The weave moment, layered over the scene between the sky and the room and
 * under the scene's own paper grain. It renders once per layout; scene
 * progress writes attributes and transforms directly. Paper throughout: flat
 * strips with hand-cut edges, offset shadows where one lies on another, and
 * wipes instead of dissolves when it hands over to the room.
 */
export const WeaveLoom = forwardRef<WeaveLoomHandle, WeaveLoomProps>(function WeaveLoom(
  { width, height },
  ref,
) {
  const rawId = useId();
  const id = (name: string) => `koaryu-loom-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}-${name}`;
  const layout = useMemo(() => loomLayout(width, height), [width, height]);
  const rootRef = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const floorRef = useRef<HTMLDivElement>(null);
  const floorInnerRef = useRef<HTMLDivElement>(null);
  const matRef = useRef<HTMLDivElement>(null);
  const seamRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const lastRef = useRef<{
    layout: LoomLayout | null;
    frame: LoomFrame | null;
    elements: LoomElements | null;
  }>({ layout: null, frame: null, elements: null });

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
        if (last.layout !== layout || !last.elements) {
          // Look the moving parts up once per layout, not once per frame.
          const all = (selector: string) => Array.from(svg.querySelectorAll(selector));
          const warps = all("[data-warp]");
          last.elements = {
            live: all("[data-live]"),
            warps,
            shadows: warps.map((group) => Array.from(group.querySelectorAll("[data-shadow]"))),
            clouds: all("[data-cloud]"),
            wefts: all("[data-weft]"),
            slides: all("[data-slide]"),
            reaches: all("[data-reach]"),
            ground: svg.querySelector("[data-ground]"),
            texture: svg.querySelector("[data-texture]"),
          };
        }
        // A new layout is a fresh render, so nothing of it has been drawn yet.
        if (last.layout !== layout) last.frame = null;
        last.layout = layout;
        const elements = last.elements;

        if (root.dataset.visible !== String(frame.visible)) {
          root.dataset.visible = String(frame.visible);
        }
        // Only frames that were drawn count as drawn: a page opened on the class
        // never drew the weave, so paging back must draw every strip.
        if (!frame.visible) return;
        last.frame = frame;

        // The sky: washed in over the clouds, then lifted off the wall from the floor line up.
        setStyle(washRef.current, "opacity", String(frame.wash));
        const lifted = Math.max(0, (1 - frame.wallEdge) * height);
        setStyle(
          skyRef.current,
          "transform",
          lifted ? `translateY(${(-lifted).toFixed(1)}px)` : "",
        );
        setStyle(washRef.current, "transform", lifted ? `translateY(${lifted.toFixed(1)}px)` : "");

        // The floor is laid over the mat: everything above its leading edge is the room's.
        const edge = Math.max(0, frame.floorEdge * height);
        const laid = frame.floorEdge > layout.floorFraction;
        setStyle(floorRef.current, "transform", laid ? `translateY(${edge.toFixed(1)}px)` : "");
        setStyle(
          floorInnerRef.current,
          "transform",
          laid ? `translateY(${(-edge).toFixed(1)}px)` : "",
        );
        setStyle(seamRef.current, "opacity", String(frame.seam));
        setStyle(seamRef.current, "transform", `translateY(${edge.toFixed(1)}px)`);

        // The mat tips toward the camera around its far edge, which settles on the room's floor line.
        const drop = (layout.floorFraction - layout.matTopFraction) * height * frame.lie;
        setStyle(
          matRef.current,
          "transform",
          frame.lie
            ? `translateY(${drop.toFixed(1)}px) perspective(${Math.round(height * 1.4)}px) rotateX(${(frame.lie * LIE_ANGLE).toFixed(2)}deg)`
            : "",
        );

        // The backing card slides up behind the strips; only the gaps between them show it coming.
        const backing = (1 - frame.ground) * (layout.matBottom - layout.matTop + 40);
        set(elements.ground, "transform", backing ? `translate(0 ${backing.toFixed(1)})` : "");
        set(elements.texture, "opacity", String(frame.ground));

        frame.warps.forEach((warp, index) => {
          const before = previous?.warps[index];
          if (!before || before.settle !== warp.settle) {
            set(elements.live[index], "d", warpPath(layout, layout.warps[index]!, warp.settle));
          }
          set(elements.warps[index], "transform", warp.slide ? `translate(${warp.slide} 0)` : "");
          const [far, near] = elements.shadows[index] ?? [];
          set(
            far,
            "transform",
            `translate(${(warp.shadow * 0.5).toFixed(1)} ${(warp.shadow * 1.9).toFixed(1)})`,
          );
          set(near, "transform", `translate(0 ${warp.shadow.toFixed(1)})`);
          set(elements.clouds[index], "opacity", String(warp.cloud));
        });
        frame.wefts.forEach((woven, index) => {
          if (previous && previous.wefts[index] === woven) return;
          const group = elements.wefts[index];
          if (!group) return;
          if (woven <= 0) {
            set(group, "display", "none");
            return;
          }
          set(group, "display", "inline");
          const rise = (1 - woven) * layout.weftTravel;
          set(elements.slides[index], "transform", rise ? `translate(0 ${rise.toFixed(1)})` : "");
          // Where a warp lies over this strip, its shadow falls only on the part already threaded.
          set(elements.reaches[index], "y", (layout.weftTop + rise).toFixed(1));
        });
      },
    }),
    [height, layout],
  );

  const { visible, matTop, matBottom, shadow, warps, wefts, over, grain, weftTop } = layout;
  const left = visible.left - 160;
  const right = visible.right + 160;
  // Crossings redraw the warp a little either side of the weft, over all of the weft's own shadow.
  const margin = shadow * 1.8 + 1.5;

  return (
    <div ref={rootRef} className={styles.loom} data-visible="false" aria-hidden="true">
      <div ref={skyRef} className={styles.loomSky}>
        <div ref={washRef} className={styles.loomWash} />
      </div>
      <div ref={floorRef} className={styles.loomFloor}>
        <div ref={floorInnerRef} className={styles.loomFloorInner}>
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
                <pattern
                  id={id("fibre")}
                  patternUnits="userSpaceOnUse"
                  width={grain}
                  height={grain}
                >
                  <image href="/marketing/washi.webp" width={grain} height={grain} />
                </pattern>
                {warps.map((_, row) => (
                  <path key={row} id={id(`live-${row}`)} data-live="" />
                ))}
                {warps.map((warp, row) => (
                  <path key={row} id={id(`strip-${row}`)} d={warpPath(layout, warp, 1)} />
                ))}
                {wefts.map((weft, column) => (
                  <clipPath key={column} id={id(`reach-${column}`)}>
                    <rect
                      data-reach=""
                      x={weft.x}
                      y={weftTop + layout.weftTravel}
                      width={weft.width}
                      height={matBottom - weftTop}
                    />
                  </clipPath>
                ))}
                {wefts.map((weft, column) => (
                  <clipPath key={column} id={id(`column-${column}`)}>
                    <rect
                      x={weft.x - margin}
                      y={visible.top - 10}
                      width={weft.width + margin * 2}
                      height={matBottom - visible.top + 20}
                    />
                  </clipPath>
                ))}
              </defs>

              {/* The backing sheet the strips are woven against. */}
              <rect
                data-ground=""
                className={styles.loomGround}
                x={left}
                y={matTop - 2}
                width={right - left}
                height={matBottom - matTop + 40}
                transform={`translate(0 ${matBottom - matTop + 40})`}
              />

              {warps.map((warp, row) => (
                <g key={row} data-warp={row}>
                  <use
                    href={`#${id(`live-${row}`)}`}
                    data-shadow=""
                    className={styles.loomShadowFar}
                  />
                  <use
                    href={`#${id(`live-${row}`)}`}
                    data-shadow=""
                    className={styles.loomShadow}
                  />
                  <use
                    href={`#${id(`live-${row}`)}`}
                    className={styles.loomWarp}
                    data-tone={warp.tone}
                  />
                  <use href={`#${id(`live-${row}`)}`} className={styles.loomCloud} data-cloud="" />
                </g>
              ))}

              {wefts.map((weft, column) => {
                const outline = weftPath(layout, weft);
                return (
                  <g key={column} data-weft={column} display="none">
                    <g data-slide="" transform={`translate(0 ${layout.weftTravel})`}>
                      <path
                        d={outline}
                        className={styles.loomShadowFar}
                        transform={`translate(${shadow * 1.8} ${shadow * 1.1})`}
                      />
                      <path
                        d={outline}
                        className={styles.loomShadow}
                        transform={`translate(${shadow} ${shadow * 0.5})`}
                      />
                      <path d={outline} className={styles.loomWeft} data-tone={weft.tone} />
                    </g>
                    <g clipPath={`url(#${id(`reach-${column}`)})`}>
                      {warps.map((warp, row) =>
                        over[row]![column] ? (
                          <use
                            key={row}
                            href={`#${id(`strip-${row}`)}`}
                            className={styles.loomShadow}
                            transform={`translate(0 ${shadow})`}
                          />
                        ) : null,
                      )}
                    </g>
                    <g clipPath={`url(#${id(`column-${column}`)})`}>
                      {warps.map((warp, row) =>
                        over[row]![column] ? (
                          <use
                            key={row}
                            href={`#${id(`strip-${row}`)}`}
                            className={styles.loomWarp}
                            data-tone={warp.tone}
                          />
                        ) : null,
                      )}
                    </g>
                  </g>
                );
              })}

              {/* Paper fibre over the woven mat; the scene's grain lies over everything. */}
              <rect
                data-texture=""
                className={styles.loomFibre}
                x={left}
                y={matTop - 2}
                width={right - left}
                height={matBottom - matTop + 2}
                fill={`url(#${id("fibre")})`}
                opacity="0"
              />
            </svg>
          </div>
        </div>
      </div>
      <div ref={seamRef} className={styles.loomSeam} />
    </div>
  );
});
