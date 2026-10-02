"use client";

import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./journey-scene.module.css";
import {
  SCENE_OVERSCAN,
  SCENE_PHASES,
  SCENE_WIDTH,
  clamp,
  easeIn,
  easeInOut,
  easeOut,
  frameForDimensions,
  makeCloudPath,
  mix,
  mulberry32,
  polygonPoints,
  rangeProgress,
  round2,
  smoothPath,
  type SceneFrame,
  type ScenePoint,
} from "./scene-model";

const PALETTE = Object.freeze({
  paper: "#F7F3E9",
  mountainSky: "#F3F1EA",
  mountain: ["#EFE2C0", "#E7CC97", "#C9A75E", "#A28341", "#7A612E"],
  curtain: "#3A2C19",
  beam: "#56431F",
  beamLight: "#6B5230",
  wood: "#9B7E4F",
  woodPale: "#C6B183",
  shoji: "#E6E2DA",
  shojiShadow: "#D3CFC7",
  tatami: "#C1AA76",
  tatamiLight: "#CFBA8E",
  tatamiDark: "#A98F5C",
  tatamiEdge: "#E3D6B4",
  sun: "#CDB389",
  sunLight: "#DBC49E",
  gi: "#F3F0E9",
  giShade: "#DCD5C6",
  hair: ["#231C17", "#3B2A20", "#5A3B26", "#2E2A28", "#7A5232", "#8C8478"],
  skin: ["#EBCDB1", "#C99872", "#8D5E3E", "#5E4231", "#D9AE8A"],
  belt: {
    white: "#F4F1EA",
    yellow: "#D9A931",
    green: "#5F7D3A",
    blue: "#3E5C7E",
    brown: "#6B4425",
    black: "#1F1A16",
  },
} as const);

const VIEW = Object.freeze({
  backLeft: 430,
  backRight: 1170,
  backTop: 235,
  backFloor: 660,
  frontLeft: -300,
  frontRight: 1900,
  frontTop: 170,
  frontFloor: 1180,
  doorLeft: 615,
  doorRight: 985,
  doorTop: 300,
  doorBottom: 660,
  centerX: 800,
  centerY: 480,
});

const CURTAIN_TEXTURE_OPACITY = 0.3;
const PUSH_SCALE = 1.18;

interface SceneIds {
  readonly skyMountain: string;
  readonly shoji: string;
  readonly sun: string;
  readonly glow: string;
  readonly crumple: string;
  readonly washi: string;
  readonly back: string;
  readonly doorway: string;
}

type DynamicAttribute = "transform" | "opacity" | "d" | "y" | "display";
type DynamicAttributes = Readonly<Partial<Record<DynamicAttribute, string>>>;
/** Every attribute that changes with scroll, keyed by the element's data-scene-dynamic name. */
export type SceneState = Readonly<Record<string, DynamicAttributes>>;

interface Ridge {
  readonly color: string;
  readonly baseY: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
  readonly speed: number;
  readonly scale: number;
}

const RIDGES: readonly Ridge[] = [
  {
    color: PALETTE.mountain[0],
    baseY: 552,
    amplitude: 74,
    frequency: 0.9,
    phase: 0.4,
    speed: 190,
    scale: 0.05,
  },
  {
    color: PALETTE.mountain[1],
    baseY: 638,
    amplitude: 92,
    frequency: 1.2,
    phase: 2.1,
    speed: 300,
    scale: 0.1,
  },
  {
    color: PALETTE.mountain[2],
    baseY: 728,
    amplitude: 104,
    frequency: 0.8,
    phase: 4.3,
    speed: 440,
    scale: 0.17,
  },
  {
    color: PALETTE.mountain[3],
    baseY: 826,
    amplitude: 118,
    frequency: 1.1,
    phase: 1.2,
    speed: 640,
    scale: 0.27,
  },
  {
    color: PALETTE.mountain[4],
    baseY: 940,
    amplitude: 130,
    frequency: 0.7,
    phase: 5.6,
    speed: 900,
    scale: 0.42,
  },
];

function ridgeLine(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46,
): readonly ScenePoint[] {
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return {
      x: -260 + progress * (SCENE_WIDTH + 520),
      y:
        baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) * amplitude * 0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) * amplitude * 0.72,
    };
  });
}

function closedRidgePath(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46,
): string {
  return `${smoothPath(ridgeLine(baseY, amplitude, frequency, phase, resolution))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} 1900 L${SCENE_OVERSCAN.x} 1900 Z`;
}

const RIDGE_PATHS = Object.freeze(
  RIDGES.map(({ baseY, amplitude, frequency, phase }) =>
    closedRidgePath(baseY, amplitude, frequency, phase),
  ),
);

const MOUNTAIN_WISPS = Object.freeze(
  (() => {
    const random = mulberry32(31);
    return Array.from({ length: 5 }, () => ({
      x: 120 + random() * 1400,
      y: 180 + random() * 210,
      scale: 0.45 + random() * 0.6,
      opacity: 0.4 + random() * 0.4,
      path: makeCloudPath(Math.floor(random() * 9999)),
    }));
  })(),
);

function shade(color: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const [red, green, blue] = channels.map((value) =>
    Math.round(clamp(amount < 0 ? value * (1 + amount) : value + (255 - value) * amount, 0, 255)),
  );
  return `rgb(${red},${green},${blue})`;
}

function overscanRect() {
  return {
    x: SCENE_OVERSCAN.x,
    y: SCENE_OVERSCAN.y,
    width: SCENE_OVERSCAN.width,
    height: SCENE_OVERSCAN.height,
  };
}

function perspectiveLerp(progress: number): number {
  return progress / (progress + (1 - progress) * 2.6);
}

// ---------------------------------------------------------------------------
// Students: the class assembles on the tatami, facing the open door.

type BeltRank = keyof typeof PALETTE.belt;

interface StudentSeat {
  /** 0 is the left wall, 1 the right wall. */
  readonly lane: number;
  /** Perspective depth: 0 is the camera, 1 the back wall. */
  readonly depth: number;
  readonly hair: number;
  readonly skin: number;
  readonly belt: BeltRank;
  readonly bun: boolean;
  readonly lean: number;
  /** Fraction of the students phase at which this student sits down. */
  readonly arrival: number;
}

export const STUDENT_SEATS: readonly StudentSeat[] = Object.freeze([
  { lane: 0.5, depth: 0.8, hair: 0, skin: 1, belt: "black", bun: false, lean: 0.4, arrival: 0 },
  { lane: 0.3, depth: 0.8, hair: 2, skin: 0, belt: "brown", bun: true, lean: -0.8, arrival: 0.1 },
  { lane: 0.7, depth: 0.8, hair: 3, skin: 3, belt: "blue", bun: false, lean: 0.9, arrival: 0.2 },
  {
    lane: 0.4,
    depth: 0.62,
    hair: 1,
    skin: 2,
    belt: "green",
    bun: false,
    lean: -0.5,
    arrival: 0.34,
  },
  { lane: 0.6, depth: 0.62, hair: 4, skin: 4, belt: "yellow", bun: true, lean: 0.7, arrival: 0.46 },
  { lane: 0.2, depth: 0.62, hair: 5, skin: 0, belt: "white", bun: false, lean: 1.1, arrival: 0.58 },
  { lane: 0.8, depth: 0.62, hair: 0, skin: 3, belt: "white", bun: true, lean: -1, arrival: 0.7 },
]);

const STUDENT_SCALE = 1.28;
const STUDENT_BODY_WIDTH = 112;
const STUDENT_BODY_HEIGHT = 128;
const STUDENT_BODY_PATH = smoothPath(
  [
    { x: -STUDENT_BODY_WIDTH * 0.3, y: -STUDENT_BODY_HEIGHT },
    { x: -STUDENT_BODY_WIDTH * 0.48, y: -STUDENT_BODY_HEIGHT * 0.86 },
    { x: -STUDENT_BODY_WIDTH * 0.56, y: -STUDENT_BODY_HEIGHT * 0.5 },
    { x: -STUDENT_BODY_WIDTH * 0.82, y: -STUDENT_BODY_HEIGHT * 0.14 },
    { x: -STUDENT_BODY_WIDTH * 1.08, y: 6 },
    { x: -STUDENT_BODY_WIDTH * 0.62, y: 22 },
    { x: STUDENT_BODY_WIDTH * 0.66, y: 21 },
    { x: STUDENT_BODY_WIDTH * 1.1, y: 4 },
    { x: STUDENT_BODY_WIDTH * 0.84, y: -STUDENT_BODY_HEIGHT * 0.16 },
    { x: STUDENT_BODY_WIDTH * 0.57, y: -STUDENT_BODY_HEIGHT * 0.5 },
    { x: STUDENT_BODY_WIDTH * 0.48, y: -STUDENT_BODY_HEIGHT * 0.86 },
    { x: STUDENT_BODY_WIDTH * 0.3, y: -STUDENT_BODY_HEIGHT },
  ],
  true,
  0.9,
);
const BELT_Y = -STUDENT_BODY_HEIGHT * 0.27;
const BELT_HALF_WIDTH = STUDENT_BODY_WIDTH * 0.66;
const HEAD_Y = -STUDENT_BODY_HEIGHT - 52;

const Student = memo(function Student({ seat }: { readonly seat: StudentSeat }) {
  const hair = PALETTE.hair[seat.hair] ?? PALETTE.hair[0];
  const skin = PALETTE.skin[seat.skin] ?? PALETTE.skin[0];
  const belt = PALETTE.belt[seat.belt];
  const beltPath = `M${-BELT_HALF_WIDTH} ${BELT_Y}Q0 ${BELT_Y + 7} ${BELT_HALF_WIDTH} ${BELT_Y}`;
  return (
    <>
      <ellipse cx="6" cy="10" rx={STUDENT_BODY_WIDTH * 1.22} ry="22" fill="#5A4528" opacity="0.2" />
      <path d={STUDENT_BODY_PATH} fill={PALETTE.gi} />
      <path
        d={`M0 ${-STUDENT_BODY_HEIGHT + 8}V${BELT_Y - 6}`}
        stroke={PALETTE.giShade}
        strokeWidth="3"
        opacity="0.8"
      />
      {seat.belt === "white" ? (
        <path d={beltPath} stroke="#CFC6B4" strokeWidth="18" strokeLinecap="round" fill="none" />
      ) : null}
      <path d={beltPath} stroke={belt} strokeWidth="14" strokeLinecap="round" fill="none" />
      <path
        d={`M-26 ${-STUDENT_BODY_HEIGHT + 3}Q0 ${-STUDENT_BODY_HEIGHT + 13} 26 ${-STUDENT_BODY_HEIGHT + 3}`}
        stroke={PALETTE.giShade}
        strokeWidth="9"
        strokeLinecap="round"
        fill="none"
      />
      <rect x="-15" y={-STUDENT_BODY_HEIGHT - 16} width="30" height="22" rx="9" fill={skin} />
      <ellipse cx="-50" cy={HEAD_Y + 4} rx="9" ry="14" fill={skin} />
      <ellipse cx="50" cy={HEAD_Y + 4} rx="9" ry="14" fill={skin} />
      {seat.bun ? <circle cx="0" cy={HEAD_Y - 58} r="19" fill={hair} /> : null}
      <ellipse cx="0" cy={HEAD_Y} rx="52" ry="58" fill={hair} />
    </>
  );
});

function studentPlacement(seat: StudentSeat, spread: number) {
  const depth = seat.depth;
  const left = mix(VIEW.frontLeft, VIEW.backLeft, depth);
  const right = mix(VIEW.frontRight, VIEW.backRight, depth);
  const lane = 0.5 + (seat.lane - 0.5) * spread;
  return {
    x: mix(left, right, lane),
    y: mix(VIEW.frontFloor, VIEW.backFloor, depth),
    scale: mix(1, (VIEW.backRight - VIEW.backLeft) / (VIEW.frontRight - VIEW.frontLeft), depth),
  };
}

// ---------------------------------------------------------------------------
// Pure state: everything that moves is derived from progress and the frame.

function dojoCamera(progress: number) {
  const arrival = easeOut(rangeProgress(progress, SCENE_PHASES.drop[0], SCENE_PHASES.drop[1]));
  const push = easeInOut(rangeProgress(progress, SCENE_PHASES.push[0], SCENE_PHASES.push[1]));
  const verticalOffset = mix(-420, 0, arrival) + mix(0, 34, push);
  const scale = mix(1.34, 1, arrival) * mix(1, PUSH_SCALE, push);
  return `translate(${VIEW.centerX} ${VIEW.centerY}) scale(${round2(scale)}) translate(${-VIEW.centerX} ${round2(-VIEW.centerY + verticalOffset)})`;
}

function curtainEdge(edgeY: number, amplitude: number, closeToward: number): string {
  return `${smoothPath(ridgeLine(edgeY, amplitude, 0.85, 3.1))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} ${closeToward} L${SCENE_OVERSCAN.x} ${closeToward} Z`;
}

const HIDDEN = Object.freeze({ display: "none" });
const SHOWN = Object.freeze({ display: "inline" });

export function sceneState(progress: number, frame: SceneFrame): SceneState {
  const value = clamp(progress);
  const state: Record<string, DynamicAttributes> = {};

  // Mountains fall away as the dojo ceiling descends over them.
  // Once the curtain fully covers the frame, the hills are not painted.
  const mountainsVisible = value < SCENE_PHASES.mountains[1];
  if (mountainsVisible) {
    const local = rangeProgress(value, SCENE_PHASES.mountains[0], SCENE_PHASES.mountains[1] + 0.02);
    const fall = easeIn(local);
    state.mountains = {
      display: "inline",
      opacity: String(round2(1 - rangeProgress(value, 0.088, 0.106))),
    };
    state["mountain-sun"] = {
      // Portrait crops show the sky taller; lift the sun clear of the headline.
      transform: `translate(1128 ${round2((frame.variant === "portrait" ? -40 : 248) - fall * 150)}) scale(${round2(1 + fall * 0.12)})`,
    };
    MOUNTAIN_WISPS.forEach((wisp, index) => {
      state[`wisp-${index}`] = {
        transform: `translate(${round2(wisp.x - fall * (60 + index * 40))} ${round2(wisp.y - fall * (220 + index * 90))}) scale(${round2(wisp.scale * (1 + fall * 0.2))})`,
        opacity: String(round2(wisp.opacity * (1 - local * 0.7))),
      };
    });
    RIDGES.forEach((ridge, index) => {
      const grow = 1 + fall * ridge.scale;
      state[`ridge-${index}`] = {
        transform: `translate(0 ${round2(-fall * ridge.speed - fall * ridge.scale * 500)}) scale(${round2(grow)})`,
      };
    });
  } else {
    state.mountains = HIDDEN;
  }

  // The curtain is the dojo's own timber: it closes over the hills, then parts
  // into ceiling and floor as the camera settles inside.
  const reveal = rangeProgress(value, SCENE_PHASES.drop[0], SCENE_PHASES.drop[1]);
  if (reveal <= 0) {
    const cover = easeIn(
      rangeProgress(value, SCENE_PHASES.mountains[0], SCENE_PHASES.mountains[1]),
    );
    const edge = curtainEdge(
      mix(1010, SCENE_OVERSCAN.y - 120, cover),
      mix(138, 0, clamp(cover * 1.22)),
      1900,
    );
    state["curtain-closed"] = cover > 0.001 ? SHOWN : HIDDEN;
    state["curtain-closed-fill"] = { d: edge };
    state["curtain-closed-texture"] = { d: edge };
    state["curtain-open"] = HIDDEN;
  } else {
    state["curtain-closed"] = HIDDEN;
    const opacity = 1 - rangeProgress(value, SCENE_PHASES.settle[0], SCENE_PHASES.settle[1] - 0.02);
    if (opacity <= 0.001) {
      state["curtain-open"] = HIDDEN;
    } else {
      const eased = easeInOut(reveal);
      const top = curtainEdge(
        mix(612, VIEW.frontTop, eased),
        mix(52, 0, clamp(reveal * 2.1)),
        -1100,
      );
      const bottom = String(round2(mix(596, 1500, eased)));
      state["curtain-open"] = { display: "inline", opacity: String(round2(opacity)) };
      state["curtain-top-fill"] = { d: top };
      state["curtain-top-texture"] = { d: top };
      state["curtain-bottom-fill"] = { y: bottom };
      state["curtain-bottom-texture"] = { y: bottom };
    }
  }

  const dojoVisible = value > SCENE_PHASES.mountains[1] - 0.006;
  if (dojoVisible) {
    const door = easeInOut(rangeProgress(value, SCENE_PHASES.door[0], SCENE_PHASES.door[1]));
    const slide = round2(mix(0, 185, door));
    state.dojo = { display: "inline", transform: dojoCamera(value) };
    state["door-left"] = { transform: `translate(${-slide} 0)` };
    state["door-right"] = { transform: `translate(${slide} 0)` };

    const students = rangeProgress(value, SCENE_PHASES.students[0], SCENE_PHASES.students[1]);
    STUDENT_SEATS.forEach((seat, index) => {
      const arrival = clamp((students - seat.arrival) / 0.28);
      if (arrival <= 0) {
        state[`student-${index}`] = HIDDEN;
        return;
      }
      const eased = easeOut(arrival);
      const place = studentPlacement(seat, frame.studentSpread);
      const scale = place.scale * STUDENT_SCALE * mix(0.96, 1, eased);
      state[`student-${index}`] = {
        display: "inline",
        opacity: String(round2(clamp(arrival * 1.6))),
        transform: `translate(${round2(place.x)} ${round2(place.y + mix(26, 0, eased))}) scale(${round2(scale)}) rotate(${seat.lean})`,
      };
    });
  } else {
    state.dojo = HIDDEN;
  }

  return state;
}

/** Writes only the attributes that differ, so an idle frame costs no style invalidation. */
export function applySceneState(
  root: SVGSVGElement,
  state: SceneState,
  cache: Map<string, Element>,
): void {
  for (const key of Object.keys(state)) {
    let element = cache.get(key);
    if (!element) {
      element = root.querySelector(`[data-scene-dynamic="${key}"]`) ?? undefined;
      if (!element) continue;
      cache.set(key, element);
    }
    const attributes = state[key]!;
    for (const name of Object.keys(attributes) as DynamicAttribute[]) {
      const next = attributes[name]!;
      if (element.getAttribute(name) !== next) element.setAttribute(name, next);
    }
  }
}

const InitialSceneState = createContext<SceneState>({});

/** Tags a moving element and seeds its server-rendered attributes. */
function dynamic(initial: SceneState, key: string) {
  return { "data-scene-dynamic": key, ...initial[key] };
}

// ---------------------------------------------------------------------------
// Static artwork. Rendered once; scroll updates go through applySceneState.

function makeIds(reactId: string): SceneIds {
  const prefix = `koaryu-scene-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const id = (name: string) => `${prefix}-${name}`;
  return {
    skyMountain: id("sky-mountain"),
    shoji: id("shoji"),
    sun: id("sun"),
    glow: id("glow"),
    crumple: id("crumple"),
    washi: id("washi"),
    back: id("back"),
    doorway: id("doorway"),
  };
}

const SceneDefs = memo(function SceneDefs({ ids }: { readonly ids: SceneIds }) {
  return (
    <defs>
      <linearGradient id={ids.skyMountain} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#FBF8F0" />
        <stop offset="0.6" stopColor={PALETTE.mountainSky} />
        <stop offset="1" stopColor="#EFEADD" />
      </linearGradient>
      <linearGradient id={ids.shoji} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#F3EFE5" />
        <stop offset="0.52" stopColor="#E8E2D6" />
        <stop offset="1" stopColor={PALETTE.shojiShadow} />
      </linearGradient>
      <radialGradient id={ids.sun} cx="0.42" cy="0.38" r="0.78">
        <stop offset="0" stopColor={PALETTE.sunLight} />
        <stop offset="1" stopColor={PALETTE.sun} />
      </radialGradient>
      <radialGradient id={ids.glow} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#FFF6E0" stopOpacity="0.85" />
        <stop offset="0.5" stopColor="#FBEBCB" stopOpacity="0.3" />
        <stop offset="1" stopColor="#F6E3BD" stopOpacity="0" />
      </radialGradient>
      {/* Materials are pre-baked by scripts/generate-journey-textures.mjs. */}
      <pattern id={ids.crumple} patternUnits="userSpaceOnUse" width="360" height="360">
        <image href="/marketing/crumple.webp" width="360" height="360" />
      </pattern>
      <pattern id={ids.washi} patternUnits="userSpaceOnUse" width="220" height="220">
        <image href="/marketing/washi.webp" width="220" height="220" />
      </pattern>
      <clipPath id={ids.back}>
        <rect
          x={VIEW.backLeft}
          y={VIEW.doorTop - 14}
          width={VIEW.backRight - VIEW.backLeft}
          height={VIEW.doorBottom - VIEW.doorTop + 28}
        />
      </clipPath>
      <clipPath id={ids.doorway}>
        <rect
          x={VIEW.doorLeft}
          y={VIEW.doorTop}
          width={VIEW.doorRight - VIEW.doorLeft}
          height={VIEW.doorBottom - VIEW.doorTop}
        />
      </clipPath>
    </defs>
  );
});

function SunDisc({ ids, radius }: { readonly ids: SceneIds; readonly radius: number }) {
  return (
    <>
      <circle r={radius * 3.2} fill={`url(#${ids.glow})`} />
      <circle
        cx={radius * 0.12}
        cy={radius * 0.18}
        r={radius * 1.05}
        fill={PALETTE.sun}
        opacity="0.55"
      />
      <circle r={radius} fill={`url(#${ids.sun})`} />
    </>
  );
}

const Mountains = memo(function Mountains({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  return (
    <g {...dynamic(initial, "mountains")} data-scene-layer="mountains">
      <rect {...overscanRect()} fill={`url(#${ids.skyMountain})`} />
      <g {...dynamic(initial, "mountain-sun")} opacity="0.92">
        <SunDisc ids={ids} radius={60} />
      </g>
      {MOUNTAIN_WISPS.map((wisp, index) => (
        <g key={`wisp-${index}`} {...dynamic(initial, `wisp-${index}`)}>
          <path d={wisp.path} fill="#FFFFFF" opacity="0.75" />
        </g>
      ))}
      {RIDGES.map((ridge, index) => (
        <g key={`ridge-${index}`} {...dynamic(initial, `ridge-${index}`)}>
          <path d={RIDGE_PATHS[index]} fill={ridge.color} />
        </g>
      ))}
    </g>
  );
});

const Curtain = memo(function Curtain({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  const texture = `url(#${ids.crumple})`;
  const bottom = {
    x: SCENE_OVERSCAN.x,
    width: SCENE_OVERSCAN.width,
    height: 1700,
  };
  return (
    <g data-scene-layer="curtain">
      <g {...dynamic(initial, "curtain-closed")}>
        <path {...dynamic(initial, "curtain-closed-fill")} fill={PALETTE.curtain} />
        <path
          {...dynamic(initial, "curtain-closed-texture")}
          fill={texture}
          opacity={CURTAIN_TEXTURE_OPACITY}
        />
      </g>
      <g {...dynamic(initial, "curtain-open")}>
        <path {...dynamic(initial, "curtain-top-fill")} fill={PALETTE.curtain} />
        <rect {...dynamic(initial, "curtain-bottom-fill")} {...bottom} fill={PALETTE.curtain} />
        <path
          {...dynamic(initial, "curtain-top-texture")}
          fill={texture}
          opacity={CURTAIN_TEXTURE_OPACITY}
        />
        <rect
          {...dynamic(initial, "curtain-bottom-texture")}
          {...bottom}
          fill={texture}
          opacity={CURTAIN_TEXTURE_OPACITY}
        />
      </g>
    </g>
  );
});

function shojiGridPath(
  x: number,
  y: number,
  width: number,
  height: number,
  columns: number,
  rows: number,
): string {
  let path = "";
  for (let column = 1; column < columns; column += 1) {
    const gridX = x + (column * width) / columns;
    path += `M${round2(gridX)} ${round2(y)}V${round2(y + height)}`;
  }
  for (let row = 1; row < rows; row += 1) {
    const gridY = y + (row * height) / rows;
    path += `M${round2(x)} ${round2(gridY)}H${round2(x + width)}`;
  }
  return path;
}

interface ShojiProps {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  readonly strokeWidth?: number;
  readonly ids: SceneIds;
}

function Shoji({ x, y, width, height, columns, rows, strokeWidth = 7, ids }: ShojiProps) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={`url(#${ids.shoji})`} />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={`url(#${ids.washi})`}
        opacity="0.78"
        style={{ mixBlendMode: "multiply" }}
      />
      <path
        d={shojiGridPath(x, y, width, height, columns, rows)}
        stroke={PALETTE.wood}
        strokeWidth={strokeWidth}
        fill="none"
        shapeRendering="crispEdges"
      />
      <rect
        x={x + strokeWidth}
        y={y + strokeWidth}
        width={width - strokeWidth * 2}
        height={height - strokeWidth * 2}
        fill="none"
        stroke={PALETTE.wood}
        strokeWidth={strokeWidth * 2}
      />
    </g>
  );
}

function sideBand(start: number, end: number, side: "left" | "right") {
  const frontX = side === "left" ? VIEW.frontLeft : VIEW.frontRight;
  const backX = side === "left" ? VIEW.backLeft : VIEW.backRight;
  const a0 = perspectiveLerp(start);
  const a1 = perspectiveLerp(end);
  return {
    x0: mix(frontX, backX, a0),
    x1: mix(frontX, backX, a1),
    top0: mix(VIEW.frontTop, VIEW.backTop, a0),
    top1: mix(VIEW.frontTop, VIEW.backTop, a1),
    bottom0: mix(VIEW.frontFloor, VIEW.backFloor, a0),
    bottom1: mix(VIEW.frontFloor, VIEW.backFloor, a1),
  };
}

const SIDE_STOPS = Object.freeze([0, 0.22, 0.44, 0.63, 0.79, 0.92, 1]);

function SideWall({ side, ids }: { readonly side: "left" | "right"; readonly ids: SceneIds }) {
  const frontX = side === "left" ? VIEW.frontLeft : VIEW.frontRight;
  const backX = side === "left" ? VIEW.backLeft : VIEW.backRight;

  return (
    <g>
      {SIDE_STOPS.slice(0, -1).map((stop, index) => {
        const band = sideBand(stop, SIDE_STOPS[index + 1] ?? 1, side);
        const paper = [
          { x: band.x0, y: mix(band.top0, band.bottom0, 0.14) },
          { x: band.x1, y: mix(band.top1, band.bottom1, 0.14) },
          { x: band.x1, y: mix(band.top1, band.bottom1, 0.94) },
          { x: band.x0, y: mix(band.top0, band.bottom0, 0.94) },
        ];
        const alternatingShade = index % 2 === 0 ? 0 : 0.045;
        return (
          <g key={`${side}-${index}`}>
            <polygon
              points={polygonPoints([
                { x: band.x0, y: band.top0 },
                { x: band.x1, y: band.top1 },
                { x: band.x1, y: band.bottom1 },
                { x: band.x0, y: band.bottom0 },
              ])}
              fill={shade(PALETTE.shoji, -alternatingShade)}
            />
            <polygon
              points={polygonPoints(paper)}
              fill={shade("#EFECE5", -alternatingShade - 0.03)}
            />
            <polygon
              points={polygonPoints(paper)}
              fill={`url(#${ids.washi})`}
              opacity="0.68"
              style={{ mixBlendMode: "multiply" }}
            />
            <polygon
              points={polygonPoints(paper)}
              fill="none"
              stroke={PALETTE.wood}
              strokeWidth={mix(15, 5, perspectiveLerp(stop))}
            />
            <line
              x1={band.x0}
              y1={band.top0}
              x2={band.x0}
              y2={band.bottom0}
              stroke={PALETTE.wood}
              strokeWidth={mix(16, 5, perspectiveLerp(stop))}
            />
          </g>
        );
      })}
      <polygon
        points={polygonPoints([
          { x: frontX, y: VIEW.frontFloor },
          { x: backX, y: VIEW.backFloor },
          { x: backX, y: VIEW.backFloor - 14 },
          { x: frontX, y: VIEW.frontFloor - 40 },
        ])}
        fill={PALETTE.wood}
      />
      <polygon
        points={polygonPoints([
          { x: frontX, y: VIEW.frontTop },
          { x: backX, y: VIEW.backTop },
          { x: backX, y: VIEW.backTop + 16 },
          { x: frontX, y: VIEW.frontTop + 46 },
        ])}
        fill={PALETTE.beamLight}
      />
    </g>
  );
}

function DojoFloor() {
  const floorPlane = [
    { x: VIEW.frontLeft, y: VIEW.frontFloor },
    { x: VIEW.backLeft, y: VIEW.backFloor },
    { x: VIEW.backRight, y: VIEW.backFloor },
    { x: VIEW.frontRight, y: VIEW.frontFloor },
  ];
  const horizontalStops = [0.16, 0.34, 0.5, 0.64, 0.76, 0.86, 0.94];

  return (
    <g>
      <polygon points={polygonPoints(floorPlane)} fill={PALETTE.tatami} />
      <polygon points={polygonPoints(floorPlane)} fill={PALETTE.tatamiLight} opacity="0.5" />
      {Array.from({ length: 5 }, (_, index) => {
        const fraction = (index + 1) / 6;
        return (
          <line
            key={`floor-v-${index}`}
            x1={mix(VIEW.frontLeft, VIEW.frontRight, fraction)}
            y1={VIEW.frontFloor}
            x2={mix(VIEW.backLeft, VIEW.backRight, fraction)}
            y2={VIEW.backFloor}
            stroke={PALETTE.tatamiEdge}
            strokeWidth="6"
            opacity="0.85"
          />
        );
      })}
      {horizontalStops.map((stop, index) => {
        const value = perspectiveLerp(stop);
        return (
          <line
            key={`floor-h-${index}`}
            x1={mix(VIEW.frontLeft, VIEW.backLeft, value)}
            y1={mix(VIEW.frontFloor, VIEW.backFloor, value)}
            x2={mix(VIEW.frontRight, VIEW.backRight, value)}
            y2={mix(VIEW.frontFloor, VIEW.backFloor, value)}
            stroke={PALETTE.tatamiEdge}
            strokeWidth={mix(7, 3, value)}
            opacity="0.8"
          />
        );
      })}
      <polygon
        points={polygonPoints([
          { x: VIEW.backLeft, y: VIEW.backFloor },
          { x: VIEW.backRight, y: VIEW.backFloor },
          { x: VIEW.backRight, y: VIEW.backFloor + 26 },
          { x: VIEW.backLeft, y: VIEW.backFloor + 26 },
        ])}
        fill={PALETTE.tatamiDark}
        opacity="0.5"
      />
      <rect
        x={SCENE_OVERSCAN.x}
        y={VIEW.frontFloor - 4}
        width={SCENE_OVERSCAN.width}
        height={SCENE_OVERSCAN.height}
        fill={PALETTE.tatami}
      />
    </g>
  );
}

// The hills from the opening, seen again through the open door.
const DOORWAY_SCALE = (VIEW.doorRight - VIEW.doorLeft) / SCENE_WIDTH;

function DoorwayView({ ids }: { readonly ids: SceneIds }) {
  return (
    <g clipPath={`url(#${ids.doorway})`} data-scene-layer="doorway">
      <g
        transform={`translate(${VIEW.doorLeft} ${VIEW.doorTop}) scale(${round2(DOORWAY_SCALE * 1000) / 1000})`}
      >
        <rect x="0" y="0" width={SCENE_WIDTH} height="1600" fill={`url(#${ids.skyMountain})`} />
        <g transform="translate(1060 640)">
          <SunDisc ids={ids} radius={150} />
        </g>
        <g transform="translate(0 520)">
          {RIDGES.map((ridge, index) => (
            <path key={`door-ridge-${index}`} d={RIDGE_PATHS[index]} fill={ridge.color} />
          ))}
        </g>
      </g>
    </g>
  );
}

const PANEL_WIDTH = 185;

function SlidingDoor({ side, ids }: { readonly side: "left" | "right"; readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  const x = side === "left" ? VIEW.doorLeft : VIEW.doorLeft + PANEL_WIDTH;
  const height = VIEW.doorBottom - VIEW.doorTop;
  return (
    <g {...dynamic(initial, `door-${side}`)}>
      <rect
        x={x + 5}
        y={VIEW.doorTop + 6}
        width={PANEL_WIDTH}
        height={height}
        fill="#4A3A1C"
        opacity="0.16"
      />
      <Shoji
        x={x}
        y={VIEW.doorTop}
        width={PANEL_WIDTH}
        height={height}
        columns={3}
        rows={5}
        strokeWidth={8}
        ids={ids}
      />
    </g>
  );
}

const Dojo = memo(function Dojo({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  return (
    <g {...dynamic(initial, "dojo")} data-scene-layer="dojo">
      <SideWall side="left" ids={ids} />
      <SideWall side="right" ids={ids} />
      <DojoFloor />
      <polygon
        points={polygonPoints([
          { x: VIEW.frontLeft, y: -900 },
          { x: VIEW.frontRight, y: -900 },
          { x: VIEW.frontRight, y: VIEW.frontTop },
          { x: VIEW.backRight, y: VIEW.backTop },
          { x: VIEW.backLeft, y: VIEW.backTop },
          { x: VIEW.frontLeft, y: VIEW.frontTop },
        ])}
        fill={PALETTE.beam}
      />
      {[0.12, 0.32, 0.5, 0.68, 0.88].map((fraction, index) => (
        <polygon
          key={`ceiling-${index}`}
          points={polygonPoints([
            { x: mix(VIEW.frontLeft, VIEW.frontRight, fraction) - 30, y: VIEW.frontTop - 6 },
            { x: mix(VIEW.frontLeft, VIEW.frontRight, fraction) + 30, y: VIEW.frontTop - 6 },
            { x: mix(VIEW.backLeft, VIEW.backRight, fraction) + 12, y: VIEW.backTop },
            { x: mix(VIEW.backLeft, VIEW.backRight, fraction) - 12, y: VIEW.backTop },
          ])}
          fill={PALETTE.beamLight}
          opacity="0.75"
        />
      ))}
      <polygon
        points={polygonPoints([
          { x: VIEW.frontLeft, y: VIEW.frontTop - 30 },
          { x: VIEW.frontRight, y: VIEW.frontTop - 30 },
          { x: VIEW.frontRight, y: VIEW.frontTop },
          { x: VIEW.backRight, y: VIEW.backTop },
          { x: VIEW.backLeft, y: VIEW.backTop },
          { x: VIEW.frontLeft, y: VIEW.frontTop },
        ])}
        fill={shade(PALETTE.beam, -0.3)}
        opacity="0.9"
      />
      <DoorwayView ids={ids} />
      <g clipPath={`url(#${ids.back})`}>
        <SlidingDoor side="left" ids={ids} />
        <SlidingDoor side="right" ids={ids} />
      </g>
      {Array.from({ length: 4 }, (_, index) => {
        const x = VIEW.backLeft + index * PANEL_WIDTH;
        return (
          <g key={`transom-${index}`}>
            <rect
              x={x + 5}
              y={VIEW.backTop + 8}
              width={PANEL_WIDTH - 10}
              height={VIEW.doorTop - VIEW.backTop - 16}
              fill="#EFECE5"
            />
            <rect
              x={x + 5}
              y={VIEW.backTop + 8}
              width={PANEL_WIDTH - 10}
              height={VIEW.doorTop - VIEW.backTop - 16}
              fill={`url(#${ids.washi})`}
              opacity="0.66"
              style={{ mixBlendMode: "multiply" }}
            />
            <rect
              x={x + 5}
              y={VIEW.backTop + 8}
              width={PANEL_WIDTH - 10}
              height={VIEW.doorTop - VIEW.backTop - 16}
              fill="none"
              stroke={PALETTE.wood}
              strokeWidth="9"
            />
          </g>
        );
      })}
      {[0, 3].map((index) => (
        <Shoji
          key={`back-panel-${index}`}
          x={VIEW.backLeft + index * PANEL_WIDTH}
          y={VIEW.doorTop}
          width={PANEL_WIDTH}
          height={VIEW.doorBottom - VIEW.doorTop}
          columns={3}
          rows={5}
          ids={ids}
        />
      ))}
      <rect
        x={VIEW.backLeft - 10}
        y={VIEW.backTop}
        width={VIEW.backRight - VIEW.backLeft + 20}
        height="16"
        fill={PALETTE.wood}
      />
      <rect
        x={VIEW.backLeft - 10}
        y={VIEW.doorTop - 13}
        width={VIEW.backRight - VIEW.backLeft + 20}
        height="15"
        fill={PALETTE.wood}
      />
      <rect
        x={VIEW.backLeft - 10}
        y={VIEW.doorBottom - 8}
        width={VIEW.backRight - VIEW.backLeft + 20}
        height="16"
        fill={PALETTE.wood}
      />
      {[
        VIEW.backLeft,
        VIEW.backLeft + PANEL_WIDTH,
        VIEW.backLeft + PANEL_WIDTH * 3,
        VIEW.backRight,
      ].map((x, index) => (
        <rect
          key={`jamb-${index}`}
          x={x - 7}
          y={VIEW.doorTop - 10}
          width="14"
          height={VIEW.doorBottom - VIEW.doorTop + 18}
          fill={PALETTE.wood}
        />
      ))}
      <g transform="translate(1216 372)" opacity="0.95">
        <rect x="0" y="0" width="86" height="200" fill="#EDE7D8" />
        <rect
          x="0"
          y="0"
          width="86"
          height="200"
          fill={`url(#${ids.washi})`}
          opacity="0.82"
          style={{ mixBlendMode: "multiply" }}
        />
        <rect x="0" y="0" width="86" height="14" fill={PALETTE.wood} />
        <rect x="0" y="186" width="86" height="14" fill={PALETTE.wood} />
        <rect x="30" y="44" width="26" height="94" rx="6" fill={PALETTE.beam} opacity="0.3" />
      </g>
      <g data-scene-layer="students">
        {STUDENT_SEATS.map((seat, index) => (
          <g key={`student-${index}`} {...dynamic(initial, `student-${index}`)}>
            <Student seat={seat} />
          </g>
        ))}
      </g>
      {[196, 1338].map((x) => (
        <g key={`post-${x}`}>
          <rect
            x={x}
            y={VIEW.frontTop - 60}
            width="66"
            height={SCENE_OVERSCAN.height}
            fill={PALETTE.beamLight}
          />
          <rect
            x={x}
            y={VIEW.frontTop - 60}
            width="20"
            height={SCENE_OVERSCAN.height}
            fill={shade(PALETTE.beamLight, 0.13)}
          />
        </g>
      ))}
    </g>
  );
});

const SceneArtwork = memo(function SceneArtwork() {
  const reactId = useId();
  const ids = useMemo(() => makeIds(reactId), [reactId]);
  return (
    <>
      <SceneDefs ids={ids} />
      <rect {...overscanRect()} fill={PALETTE.paper} />
      <Mountains ids={ids} />
      <Dojo ids={ids} />
      <Curtain ids={ids} />
    </>
  );
});

const DEFAULT_FRAME = frameForDimensions(SCENE_WIDTH, SCENE_WIDTH / 1.6);

export interface JourneySceneHandle {
  setProgress(progress: number): void;
}

export interface JourneySceneProps {
  /** Progress rendered on the server and before the first scroll measurement. */
  readonly initialProgress?: number;
  readonly frame?: SceneFrame;
  readonly className?: string;
}

/**
 * The artwork renders once. Scroll-driven frames write attributes directly, so
 * moving the camera never reconciles the SVG tree.
 */
export const JourneyScene = forwardRef<JourneySceneHandle, JourneySceneProps>(function JourneyScene(
  { initialProgress = 0, frame, className },
  ref,
) {
  const resolvedFrame = frame ?? DEFAULT_FRAME;
  const svgRef = useRef<SVGSVGElement>(null);
  const cacheRef = useRef(new Map<string, Element>());
  const progressRef = useRef(clamp(initialProgress));
  const frameRef = useRef(resolvedFrame);
  // The initial attributes only seed server HTML; later frames are imperative.
  const [initialState] = useState(() => sceneState(clamp(initialProgress), resolvedFrame));

  useImperativeHandle(
    ref,
    () => ({
      setProgress(progress: number) {
        progressRef.current = clamp(progress);
        const svg = svgRef.current;
        if (svg) {
          applySceneState(svg, sceneState(progressRef.current, frameRef.current), cacheRef.current);
          svg.dataset.sceneProgress = String(round2(progressRef.current));
        }
      },
    }),
    [],
  );

  // Frame changes (resize) move the students; re-apply the current progress.
  useLayoutEffect(() => {
    frameRef.current = resolvedFrame;
    const svg = svgRef.current;
    if (svg) applySceneState(svg, sceneState(progressRef.current, resolvedFrame), cacheRef.current);
  }, [resolvedFrame]);

  return (
    <svg
      ref={svgRef}
      className={[styles.scene, className].filter(Boolean).join(" ")}
      viewBox={resolvedFrame.viewBox}
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      data-scene-progress={round2(clamp(initialProgress))}
      data-scene-frame={resolvedFrame.variant}
    >
      <InitialSceneState.Provider value={initialState}>
        <SceneArtwork />
      </InitialSceneState.Provider>
    </svg>
  );
});
