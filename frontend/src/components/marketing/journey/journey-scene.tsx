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
  CLOUD_GEOMETRY,
  FLOOR_FAR,
  FLOOR_NEAR,
  PLANK_GEOMETRY,
  SCENE_HEIGHT,
  SCENE_OVERSCAN,
  SCENE_PHASES,
  SCENE_WIDTH,
  U_SPAN,
  V_SPAN,
  clamp,
  easeIn,
  easeInOut,
  easeOut,
  floorPoint,
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
  skyHigh: "#F6E9CD",
  skyMiddle: "#EDD9B2",
  skyLow: "#DEC79F",
  sun: "#CDB389",
  sunLight: "#DBC49E",
  cloud: ["#F4E7CC", "#EBD9B9", "#E1CBA5", "#D4B992", "#C4A47C"],
  bamboo: ["#E1C99E", "#D7BC90", "#CBAE82", "#BEA075", "#B09068"],
  floor: ["#E2CAA2", "#D9BD95", "#CFB086", "#C4A47A", "#B7956C"],
  wallHigh: "#DED7CF",
  wallLow: "#C4BAB0",
  baseboard: "#B7ACA1",
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

interface SceneIds {
  readonly skyMountain: string;
  readonly sky: string;
  readonly wall: string;
  readonly skyWindow: string;
  readonly floor: string;
  readonly shoji: string;
  readonly sun: string;
  readonly glow: string;
  readonly crumple: string;
  readonly washi: string;
  readonly back: string;
}

type DynamicAttribute =
  | "transform"
  | "opacity"
  | "display"
  | "d"
  | "points"
  | "fill"
  | "stroke-width"
  | "x"
  | "y"
  | "width"
  | "height";
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
  /** Across the floor: 0 is the left edge of the weave, 1 the right. */
  readonly horizontal: number;
  /** Into the floor: 0 is the far wall, 1 the camera. */
  readonly depth: number;
  readonly hair: number;
  readonly skin: number;
  readonly belt: BeltRank;
  readonly bun: boolean;
  readonly lean: number;
  /** Fraction of the students phase at which this student sits down. */
  readonly arrival: number;
}

/** Back row first, so nearer students overlap farther ones. */
export const STUDENT_SEATS: readonly StudentSeat[] = Object.freeze([
  {
    horizontal: 0.5,
    depth: 0.36,
    hair: 0,
    skin: 1,
    belt: "black",
    bun: false,
    lean: 0.4,
    arrival: 0,
  },
  {
    horizontal: 0.38,
    depth: 0.36,
    hair: 2,
    skin: 0,
    belt: "brown",
    bun: true,
    lean: -0.8,
    arrival: 0.08,
  },
  {
    horizontal: 0.62,
    depth: 0.36,
    hair: 3,
    skin: 3,
    belt: "blue",
    bun: false,
    lean: 0.9,
    arrival: 0.16,
  },
  {
    horizontal: 0.44,
    depth: 0.5,
    hair: 1,
    skin: 2,
    belt: "green",
    bun: false,
    lean: -0.5,
    arrival: 0.26,
  },
  {
    horizontal: 0.56,
    depth: 0.5,
    hair: 4,
    skin: 4,
    belt: "yellow",
    bun: true,
    lean: 0.7,
    arrival: 0.34,
  },
  {
    horizontal: 0.31,
    depth: 0.5,
    hair: 5,
    skin: 0,
    belt: "white",
    bun: false,
    lean: 1.1,
    arrival: 0.42,
  },
  {
    horizontal: 0.69,
    depth: 0.5,
    hair: 0,
    skin: 3,
    belt: "white",
    bun: true,
    lean: -1,
    arrival: 0.5,
  },
]);

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

// ---------------------------------------------------------------------------
// Pure state: everything that moves is derived from progress and the frame.

function hexToRgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function mixColor(from: string, to: string, progress: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return `rgb(${Math.round(mix(a[0], b[0], progress))},${Math.round(mix(a[1], b[1], progress))},${Math.round(mix(a[2], b[2], progress))})`;
}

function dojoCamera(progress: number) {
  const arrival = easeOut(rangeProgress(progress, SCENE_PHASES.drop[0], SCENE_PHASES.drop[1]));
  const portal = easeInOut(rangeProgress(progress, SCENE_PHASES.portal[0], SCENE_PHASES.portal[1]));
  const verticalOffset = mix(-420, 0, arrival);
  const scale =
    mix(1.34, 1, arrival) *
    mix(1, 2.015, portal) *
    mix(1, 5.6, easeIn(rangeProgress(progress, SCENE_PHASES.through[0], SCENE_PHASES.through[1])));

  return {
    transform: `translate(${VIEW.centerX} ${VIEW.centerY}) scale(${round2(scale)}) translate(${-VIEW.centerX} ${round2(-VIEW.centerY + verticalOffset)})`,
    project: (x: number, y: number): ScenePoint => ({
      x: VIEW.centerX + scale * (x - VIEW.centerX),
      y: VIEW.centerY + scale * (y - VIEW.centerY + verticalOffset),
    }),
  };
}

function curtainEdge(edgeY: number, amplitude: number, closeToward: number): string {
  return `${smoothPath(ridgeLine(edgeY, amplitude, 0.85, 3.1))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} ${closeToward} L${SCENE_OVERSCAN.x} ${closeToward} Z`;
}

const HIDDEN = Object.freeze({ display: "none" });
const SHOWN = Object.freeze({ display: "inline" });
const PANEL_WIDTH = 185;

export function sceneState(progress: number, frame: SceneFrame): SceneState {
  const value = clamp(progress);
  const state: Record<string, DynamicAttributes> = {};
  const camera = dojoCamera(value);
  const door = easeInOut(rangeProgress(value, SCENE_PHASES.door[0], SCENE_PHASES.door[1]));
  const slide = mix(0, PANEL_WIDTH, door);

  // Hills: they fall away as the dojo's timber descends over them.
  if (value < SCENE_PHASES.mountains[1]) {
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
      state[`ridge-${index}`] = {
        transform: `translate(0 ${round2(-fall * ridge.speed - fall * ridge.scale * 500)}) scale(${round2(1 + fall * ridge.scale)})`,
      };
    });
  } else {
    state.mountains = HIDDEN;
  }

  // Curtain: closes over the hills, then parts into ceiling and floor.
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

  // Dojo: the camera settles, the door slides open, and the camera flies through it.
  const dojoOpacity =
    1 -
    easeIn(rangeProgress(value, SCENE_PHASES.through[0] + 0.045, SCENE_PHASES.through[1] - 0.012));
  let dojoVisible = value > SCENE_PHASES.mountains[1] - 0.006 && dojoOpacity > 0.001;
  if (dojoVisible && door === 1) {
    // Once the open doorway covers the frame, none of the room is visible.
    const [, top, , height] = frame.viewBox.split(" ").map(Number);
    const openingTop = camera.project(VIEW.doorLeft + 9, VIEW.doorTop + 4);
    const openingBottom = camera.project(VIEW.doorRight - 9, VIEW.doorBottom - 10);
    dojoVisible = !(
      openingTop.x < VIEW.centerX - frame.visibleHalfWidth &&
      openingBottom.x > VIEW.centerX + frame.visibleHalfWidth &&
      openingTop.y < top! &&
      openingBottom.y > top! + height!
    );
  }
  if (dojoVisible) {
    state.dojo = {
      display: "inline",
      transform: camera.transform,
      opacity: String(round2(dojoOpacity)),
    };
    state["door-left"] = { transform: `translate(${round2(-slide)} 0)` };
    state["door-right"] = { transform: `translate(${round2(slide)} 0)` };
  } else {
    state.dojo = HIDDEN;
  }

  // Sky: seen through the opening door, then entered; clouds gather across it.
  const skyOpacity =
    1 - rangeProgress(value, SCENE_PHASES.morph[0] + 0.03, SCENE_PHASES.morph[0] + 0.1);
  const skyNear = value > SCENE_PHASES.portal[0] - 0.08 && value < SCENE_PHASES.morph[0] + 0.2;
  if (skyNear && skyOpacity > 0.001 && slide > 0) {
    const through = rangeProgress(value, SCENE_PHASES.through[0], SCENE_PHASES.through[1]);
    const sky = rangeProgress(value, SCENE_PHASES.sky[0], SCENE_PHASES.sky[1]);
    const clouds = rangeProgress(value, SCENE_PHASES.clouds[0], SCENE_PHASES.clouds[1]);
    const topLeft = camera.project(VIEW.doorLeft + PANEL_WIDTH - slide, VIEW.doorTop);
    const bottomRight = camera.project(VIEW.doorLeft + PANEL_WIDTH + slide, VIEW.doorBottom);
    const scale = mix(1, 1.42, easeInOut(through)) * mix(1, 0.72, easeInOut(sky));
    const rise = mix(0, -230, easeInOut(sky)) + mix(0, -180, easeInOut(clouds));
    state.sky = { display: "inline", opacity: String(round2(skyOpacity)) };
    state["sky-window"] = {
      x: String(round2(topLeft.x)),
      y: String(round2(topLeft.y)),
      width: String(round2(bottomRight.x - topLeft.x)),
      height: String(round2(bottomRight.y - topLeft.y)),
    };
    state["sky-camera"] = {
      transform: `translate(${VIEW.centerX} 520) scale(${round2(scale)}) translate(${-VIEW.centerX} ${round2(-520 + rise)})`,
    };
    state["sky-ridges"] = { opacity: String(round2(1 - easeInOut(sky) * 0.9)) };
    state["sky-sun"] = {
      transform: `translate(${VIEW.centerX} 430) scale(${round2(1 + easeInOut(sky) * 0.5)})`,
      opacity: String(
        round2(
          1 - rangeProgress(value, SCENE_PHASES.clouds[0] + 0.05, SCENE_PHASES.clouds[1] - 0.03),
        ),
      ),
    };
    const cloudsOpacity =
      1 - rangeProgress(value, SCENE_PHASES.morph[0], SCENE_PHASES.morph[0] + 0.045);
    if (cloudsOpacity > 0.001 && clouds > 0) {
      state.clouds = { display: "inline", opacity: String(round2(cloudsOpacity)) };
      CLOUD_GEOMETRY.forEach((cloud, index) => {
        const cloudProgress = clamp((clouds - cloud.arrival) / 0.26);
        if (cloudProgress <= 0) {
          state[`cloud-${index}`] = HIDDEN;
          return;
        }
        const eased = easeOut(cloudProgress);
        const offsetX = cloud.direction * mix(760, 0, eased) + cloud.drift * clouds * 90;
        const offsetY = mix(70, 0, eased) - clouds * 46 * cloud.drift;
        const cloudScale = cloud.scale * mix(0.78, 1, eased);
        state[`cloud-${index}`] = {
          display: "inline",
          transform: `translate(${round2(cloud.x + offsetX)} ${round2(cloud.y + offsetY)}) scale(${round2(cloudScale)})`,
          opacity: String(round2(clamp(cloudProgress * 2.6))),
        };
      });
    } else {
      state.clouds = HIDDEN;
    }
  } else {
    state.sky = HIDDEN;
  }

  // Floor: the clouds lie down into bamboo, the bamboo becomes a woven floor,
  // and a quiet room rises around it.
  const floor = rangeProgress(value, SCENE_PHASES.floor[0], SCENE_PHASES.floor[1]);
  const horizon = mix(-330, 330, easeInOut(floor));
  const weaveOpacity = clamp(
    rangeProgress(value, SCENE_PHASES.morph[0] - 0.012, SCENE_PHASES.morph[0] + 0.052),
  );
  if (weaveOpacity > 0.001) {
    const morph = rangeProgress(value, SCENE_PHASES.morph[0], SCENE_PHASES.morph[1]);
    const morphStagger = 0.46;
    const floorStagger = 0.34;
    const shadowOpacity = (1 - clamp(morph * 1.5)) * 0.9;
    const floorTop = String(round2(mix(-600, horizon + FLOOR_FAR, easeInOut(floor))));
    state.weave = { display: "inline", opacity: String(round2(weaveOpacity)) };
    state["weave-clip"] = { y: floorTop };
    state["weave-ground"] = {
      y: floorTop,
      fill: mixColor(PALETTE.cloud[1], PALETTE.floor[2], clamp(morph * 0.6 + floor * 0.4)),
    };
    PLANK_GEOMETRY.forEach((plank, index) => {
      const morphDelay = morphStagger * (0.72 * plank.horizontalOrder + 0.28 * plank.verticalOrder);
      const plankMorph = easeInOut(clamp((morph - morphDelay) / (1 - morphStagger)));
      const floorDelay = floorStagger * (1 - plank.normalizedDepth);
      const plankFloor = easeInOut(clamp((floor - floorDelay) / (1 - floorStagger)));
      const points = plank.flat.map((flatPoint, pointIndex) => {
        const cloudPoint = plank.cloud[pointIndex] ?? flatPoint;
        let x = mix(cloudPoint.x, flatPoint.x, plankMorph);
        let y = mix(cloudPoint.y, flatPoint.y, plankMorph);
        if (plankFloor > 0) {
          const uv = plank.uv[pointIndex] ?? { x: 0, y: 0 };
          const ground = floorPoint(uv.x, uv.y, horizon);
          x = mix(x, ground.x, plankFloor);
          y = mix(y, ground.y, plankFloor);
        }
        return { x, y };
      });
      const cloudTone = PALETTE.cloud[plank.tone]!;
      const bambooTone = PALETTE.bamboo[plank.tone]!;
      const floorTone = PALETTE.floor[plank.tone]!;
      const pointList = polygonPoints(points);
      state[`plank-${index}`] = {
        points: pointList,
        fill:
          plankFloor > 0
            ? mixColor(bambooTone, floorTone, plankFloor)
            : mixColor(cloudTone, bambooTone, plankMorph),
        "stroke-width": String(round2(mix(0, 1.5, plankMorph))),
      };
      state[`plank-shadow-${index}`] =
        shadowOpacity > 0.01
          ? {
              display: "inline",
              points: pointList,
              transform: `translate(0 ${round2(mix(15, 4, plankMorph))})`,
              opacity: String(round2(shadowOpacity * 0.3)),
            }
          : HIDDEN;
    });
  } else {
    state.weave = HIDDEN;
  }

  const room = rangeProgress(value, SCENE_PHASES.floor[0] + 0.02, SCENE_PHASES.floor[1]);
  if (room > 0.001) {
    const floorLine = horizon + FLOOR_FAR;
    state.room = { display: "inline", opacity: String(round2(room)) };
    state["room-wall"] = { height: String(round2(900 + floorLine)) };
    state["room-baseboard"] = { y: String(round2(floorLine - 20)) };
  } else {
    state.room = HIDDEN;
  }

  // The class arrives and sits facing the far wall.
  const students = rangeProgress(value, SCENE_PHASES.students[0], SCENE_PHASES.students[1]);
  STUDENT_SEATS.forEach((seat, index) => {
    const arrival = clamp((students - seat.arrival) / 0.45);
    if (arrival <= 0) {
      state[`student-${index}`] = HIDDEN;
      return;
    }
    const eased = easeOut(arrival);
    const horizontal = 0.5 + (seat.horizontal - 0.5) * frame.studentSpread;
    const point = floorPoint(horizontal * U_SPAN, seat.depth * V_SPAN, horizon);
    const depth = mix(FLOOR_FAR, FLOOR_NEAR, seat.depth);
    // Portrait crops see the room from farther back; seat the class a little larger.
    const presence = frame.variant === "portrait" ? 1.18 : 1;
    state[`student-${index}`] = {
      display: "inline",
      opacity: String(round2(clamp(arrival * 1.8))),
      transform: `translate(${round2(point.x)} ${round2(point.y + mix(120, 0, eased))}) scale(${round2((depth / 440) * presence * mix(0.94, 1, eased))}) rotate(${seat.lean})`,
    };
  });

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
  const { "stroke-width": strokeWidth, ...attributes } = initial[key] ?? {};
  return {
    "data-scene-dynamic": key,
    ...attributes,
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  };
}

// ---------------------------------------------------------------------------
// Static artwork. Rendered once; scroll updates go through applySceneState.

function makeIds(reactId: string): SceneIds {
  const prefix = `koaryu-scene-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const id = (name: string) => `${prefix}-${name}`;
  return {
    skyMountain: id("sky-mountain"),
    sky: id("sky"),
    wall: id("wall"),
    skyWindow: id("sky-window"),
    floor: id("floor"),
    shoji: id("shoji"),
    sun: id("sun"),
    glow: id("glow"),
    crumple: id("crumple"),
    washi: id("washi"),
    back: id("back"),
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
      <linearGradient id={ids.sky} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#FCF4E2" />
        <stop offset="0.42" stopColor={PALETTE.skyHigh} />
        <stop offset="0.78" stopColor={PALETTE.skyMiddle} />
        <stop offset="1" stopColor={PALETTE.skyLow} />
      </linearGradient>
      <linearGradient id={ids.wall} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={PALETTE.wallHigh} />
        <stop offset="0.7" stopColor="#D3C9C0" />
        <stop offset="1" stopColor={PALETTE.wallLow} />
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

const FAR_RIDGES = [
  { color: "#D9C7A6", baseY: 690, amplitude: 34, frequency: 1.4, phase: 0.9 },
  { color: "#C9B492", baseY: 730, amplitude: 42, frequency: 0.9, phase: 3.4 },
  { color: "#B49C78", baseY: 780, amplitude: 30, frequency: 1.9, phase: 5.1 },
] as const;

const FAR_RIDGE_PATHS = Object.freeze(
  FAR_RIDGES.map(({ baseY, amplitude, frequency, phase }) =>
    closedRidgePath(baseY, amplitude, frequency, phase, 30),
  ),
);

/** The sky beyond the door: seen through the opening, then flown into as the clouds gather. */
const SkyWorld = memo(function SkyWorld({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  return (
    <g {...dynamic(initial, "sky")} data-scene-layer="sky">
      <clipPath id={ids.skyWindow}>
        <rect {...dynamic(initial, "sky-window")} />
      </clipPath>
      <g clipPath={`url(#${ids.skyWindow})`}>
        <rect
          x="-600"
          y="-600"
          width={SCENE_WIDTH + 1200}
          height={SCENE_HEIGHT + 1200}
          fill={`url(#${ids.sky})`}
        />
        <g {...dynamic(initial, "sky-camera")}>
          <g {...dynamic(initial, "sky-ridges")}>
            {FAR_RIDGES.map((ridge, index) => (
              <path
                key={`far-ridge-${index}`}
                d={FAR_RIDGE_PATHS[index]}
                fill={ridge.color}
                opacity={0.95 - index * 0.05}
              />
            ))}
          </g>
          <g {...dynamic(initial, "sky-sun")}>
            <circle r="300" fill={`url(#${ids.glow})`} />
            <circle cx="9" cy="14" r="88" fill={PALETTE.sun} opacity="0.5" />
            <circle r="84" fill={`url(#${ids.sun})`} />
            <circle
              r="84"
              fill="none"
              stroke={shade(PALETTE.sun, -0.2)}
              strokeWidth="2"
              opacity="0.35"
            />
          </g>
          <g {...dynamic(initial, "clouds")} data-scene-layer="clouds">
            {CLOUD_GEOMETRY.map((cloud, index) => {
              const tone = PALETTE.cloud[cloud.tone]!;
              return (
                <g key={`cloud-${index}`} {...dynamic(initial, `cloud-${index}`)}>
                  <path
                    d={cloud.path}
                    transform="translate(2 19)"
                    fill={shade(tone, -0.42)}
                    opacity="0.42"
                  />
                  <path d={cloud.path} fill={tone} />
                  <path
                    d={cloud.path}
                    transform="translate(0 -5)"
                    fill={shade(tone, 0.35)}
                    opacity="0.3"
                  />
                </g>
              );
            })}
          </g>
        </g>
      </g>
    </g>
  );
});

/** A quiet room rises around the new floor. */
const RoomWall = memo(function RoomWall({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  return (
    <g {...dynamic(initial, "room")} data-scene-layer="room">
      <rect
        {...dynamic(initial, "room-wall")}
        x="-400"
        y="-900"
        width={SCENE_WIDTH + 800}
        fill={`url(#${ids.wall})`}
      />
      <rect
        {...dynamic(initial, "room-baseboard")}
        x="-400"
        width={SCENE_WIDTH + 800}
        height="22"
        fill={PALETTE.baseboard}
        opacity="0.55"
      />
    </g>
  );
});

/** The clouds lie down as bamboo strips and weave themselves into the floor. */
const Weave = memo(function Weave({ ids }: { readonly ids: SceneIds }) {
  const initial = useContext(InitialSceneState);
  const span = { x: -600, width: SCENE_WIDTH + 1200, height: SCENE_HEIGHT + 1200 };
  return (
    <g {...dynamic(initial, "weave")} data-scene-layer="weave-floor">
      <clipPath id={ids.floor}>
        <rect {...dynamic(initial, "weave-clip")} {...span} />
      </clipPath>
      <g clipPath={`url(#${ids.floor})`}>
        <rect {...dynamic(initial, "weave-ground")} {...span} />
        {PLANK_GEOMETRY.map((plank, index) => {
          const bambooTone = PALETTE.bamboo[plank.tone]!;
          return (
            <g key={`plank-${index}`}>
              <polygon
                {...dynamic(initial, `plank-shadow-${index}`)}
                fill={shade(PALETTE.cloud[plank.tone]!, -0.45)}
              />
              <polygon
                {...dynamic(initial, `plank-${index}`)}
                stroke={shade(bambooTone, -0.3)}
                strokeOpacity="0.42"
              />
            </g>
          );
        })}
      </g>
    </g>
  );
});

const Students = memo(function Students() {
  const initial = useContext(InitialSceneState);
  return (
    <g data-scene-layer="students">
      {STUDENT_SEATS.map((seat, index) => (
        <g key={`student-${index}`} {...dynamic(initial, `student-${index}`)}>
          <Student seat={seat} />
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
      <SkyWorld ids={ids} />
      <Dojo ids={ids} />
      <Curtain ids={ids} />
      <RoomWall ids={ids} />
      <Weave ids={ids} />
      <Students />
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
