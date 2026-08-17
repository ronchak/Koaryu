import { memo, useId } from "react";

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
  frameForDimensions,
  floorPoint,
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
  belt: "#241F1B",
  skin: ["#EBCDB1", "#5E4231", "#C5945A", "#B08E2A", "#9E6642"],
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

const CRUMPLE_OPACITY = 0.45;

interface SceneIds {
  readonly skyMountain: string;
  readonly sky: string;
  readonly wall: string;
  readonly shoji: string;
  readonly sun: string;
  readonly glow: string;
  readonly vignette: string;
  readonly lifted: string;
  readonly pulp: string;
  readonly fine: string;
  readonly crumpleTile: string;
  readonly crumple: string;
  readonly washiNoise: string;
  readonly washi: string;
  readonly back: string;
  readonly skyWindow: string;
  readonly floor: string;
}

export interface JourneySceneProps {
  readonly progress: number;
  readonly frame?: SceneFrame;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly className?: string;
}

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
  { color: PALETTE.mountain[0], baseY: 552, amplitude: 74, frequency: 0.9, phase: 0.4, speed: 190, scale: 0.05 },
  { color: PALETTE.mountain[1], baseY: 638, amplitude: 92, frequency: 1.2, phase: 2.1, speed: 300, scale: 0.1 },
  { color: PALETTE.mountain[2], baseY: 728, amplitude: 104, frequency: 0.8, phase: 4.3, speed: 440, scale: 0.17 },
  { color: PALETTE.mountain[3], baseY: 826, amplitude: 118, frequency: 1.1, phase: 1.2, speed: 640, scale: 0.27 },
  { color: PALETTE.mountain[4], baseY: 940, amplitude: 130, frequency: 0.7, phase: 5.6, speed: 900, scale: 0.42 },
];

const FAR_RIDGES = [
  { color: "#D9C7A6", baseY: 690, amplitude: 34, frequency: 1.4, phase: 0.9 },
  { color: "#C9B492", baseY: 730, amplitude: 42, frequency: 0.9, phase: 3.4 },
  { color: "#B49C78", baseY: 780, amplitude: 30, frequency: 1.9, phase: 5.1 },
] as const;

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

function shade(color: string, amount: number): string {
  const [red, green, blue] = hexToRgb(color);
  const channel = (value: number) =>
    Math.round(
      clamp(
        amount < 0 ? value * (1 + amount) : value + (255 - value) * amount,
        0,
        255
      )
    );
  return `rgb(${channel(red)},${channel(green)},${channel(blue)})`;
}

function ridgeLine(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46
): readonly ScenePoint[] {
  return Array.from({ length: resolution + 1 }, (_, index) => {
    const progress = index / resolution;
    return {
      x: -260 + progress * (SCENE_WIDTH + 520),
      y:
        baseY +
        Math.sin(progress * Math.PI * 2 * frequency + phase) * amplitude +
        Math.sin(progress * Math.PI * 2 * frequency * 2.31 + phase * 1.7) *
          amplitude *
          0.4 +
        Math.sin(progress * Math.PI * 2 * frequency * 0.57 + phase * 0.45) *
          amplitude *
          0.72,
    };
  });
}

function closedRidgePath(
  baseY: number,
  amplitude: number,
  frequency: number,
  phase: number,
  resolution = 46
): string {
  return `${smoothPath(ridgeLine(baseY, amplitude, frequency, phase, resolution))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} 1900 L${SCENE_OVERSCAN.x} 1900 Z`;
}

function makeCloudPath(seed: number): string {
  const random = mulberry32(seed);
  const width = 380 + random() * 560;
  const height = 44 + random() * 52;
  const lobes = 4 + Math.floor(random() * 4);
  const top: ScenePoint[] = [];
  const bottom: ScenePoint[] = [];

  for (let index = 0; index <= lobes; index += 1) {
    const progress = index / lobes;
    const arch = Math.sin(progress * Math.PI);
    top.push({
      x: -width / 2 + progress * width,
      y: -height * arch * (0.5 + 0.55 * random()),
    });
  }

  const segments = 5 + Math.floor(random() * 3);
  for (let index = segments; index >= 0; index -= 1) {
    const progress = index / segments;
    const tail = index === 0 || index === segments ? 0.12 : 0.35 + 0.75 * random();
    bottom.push({
      x: -width / 2 + progress * width,
      y: height * 0.34 * tail,
    });
  }

  return smoothPath([...top, ...bottom], true, 0.9);
}

const RIDGE_PATHS = Object.freeze(
  RIDGES.map(({ baseY, amplitude, frequency, phase }) =>
    closedRidgePath(baseY, amplitude, frequency, phase)
  )
);

const MOUNTAIN_WISPS = Object.freeze((() => {
  const random = mulberry32(31);
  return Array.from({ length: 5 }, () => ({
    x: 120 + random() * 1400,
    y: 180 + random() * 210,
    scale: 0.45 + random() * 0.6,
    opacity: 0.4 + random() * 0.4,
    path: makeCloudPath(Math.floor(random() * 9999)),
  }));
})());

function makeIds(reactId: string): SceneIds {
  const prefix = `koaryu-scene-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const id = (name: string) => `${prefix}-${name}`;
  return {
    skyMountain: id("sky-mountain"),
    sky: id("sky"),
    wall: id("wall"),
    shoji: id("shoji"),
    sun: id("sun"),
    glow: id("glow"),
    vignette: id("vignette"),
    lifted: id("lifted"),
    pulp: id("pulp"),
    fine: id("fine"),
    crumpleTile: id("crumple-tile"),
    crumple: id("crumple"),
    washiNoise: id("washi-noise"),
    washi: id("washi"),
    back: id("back"),
    skyWindow: id("sky-window"),
    floor: id("floor"),
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
      <radialGradient id={ids.vignette} cx="0.5" cy="0.48" r="0.72">
        <stop offset="0.55" stopColor="#000000" stopOpacity="0" />
        <stop offset="1" stopColor="#3A2C14" stopOpacity="0.2" />
      </radialGradient>
      <filter id={ids.lifted} x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="5" stdDeviation="6" floodColor="#4A3A1C" floodOpacity="0.24" />
      </filter>
      <filter id={ids.pulp} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.035" numOctaves="2" seed="17" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer><feFuncA type="linear" slope="0.72" /></feComponentTransfer>
      </filter>
      <filter id={ids.fine} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.68" numOctaves="2" seed="7" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer><feFuncA type="linear" slope="0.58" /></feComponentTransfer>
      </filter>
      <filter id={ids.crumpleTile} filterUnits="userSpaceOnUse" x="0" y="0" width="360" height="360" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.0111" numOctaves="4" seed="9" stitchTiles="stitch" />
        <feDiffuseLighting surfaceScale="1.9" diffuseConstant="1.05" lightingColor="#FFFFFF">
          <feDistantLight azimuth="235" elevation="58" />
        </feDiffuseLighting>
        <feColorMatrix type="matrix" values="0.2067 0.2067 0.2067 0 0.0273 0.1667 0.1667 0.1667 0 0.0127 0.1133 0.1133 0.1133 0 -0.0484 0 0 0 0 1" />
      </filter>
      <pattern id={ids.crumple} patternUnits="userSpaceOnUse" x="0" y="0" width="360" height="360">
        <rect x="0" y="0" width="360" height="360" filter={`url(#${ids.crumpleTile})`} />
      </pattern>
      <filter id={ids.washiNoise} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.026 0.44" numOctaves="2" seed="29" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer><feFuncA type="linear" slope="0.76" /></feComponentTransfer>
      </filter>
      <pattern id={ids.washi} width="220" height="220" patternUnits="userSpaceOnUse">
        <rect width="220" height="220" fill="#8B7B60" filter={`url(#${ids.washiNoise})`} opacity="0.24" />
      </pattern>
    </defs>
  );
});

const SceneGrain = memo(function SceneGrain({ ids }: { readonly ids: SceneIds }) {
  return (
    <g pointerEvents="none">
      <rect {...overscanRect()} filter={`url(#${ids.pulp})`} opacity="0.07" style={{ mixBlendMode: "multiply" }} />
      <rect {...overscanRect()} filter={`url(#${ids.fine})`} opacity="0.05" style={{ mixBlendMode: "multiply" }} />
      <rect {...overscanRect()} fill={`url(#${ids.vignette})`} />
    </g>
  );
});

function overscanRect() {
  return {
    x: SCENE_OVERSCAN.x,
    y: SCENE_OVERSCAN.y,
    width: SCENE_OVERSCAN.width,
    height: SCENE_OVERSCAN.height,
  };
}

const Mountains = memo(function Mountains({ progress, ids }: { readonly progress: number; readonly ids: SceneIds }) {
  const local = rangeProgress(progress, SCENE_PHASES.mountains[0], SCENE_PHASES.mountains[1] + 0.02);
  const fall = easeIn(local);
  const opacity = 1 - rangeProgress(progress, 0.088, 0.106);

  return (
    <g opacity={opacity} data-scene-layer="mountains">
      <rect {...overscanRect()} fill={`url(#${ids.skyMountain})`} />
      <g transform={`translate(1128 ${248 - fall * 150}) scale(${1 + fall * 0.12})`} opacity="0.92">
        <circle r="190" fill={`url(#${ids.glow})`} />
        <circle cx="7" cy="11" r="63" fill={PALETTE.sun} opacity="0.55" />
        <circle r="60" fill={`url(#${ids.sun})`} />
      </g>
      {MOUNTAIN_WISPS.map((wisp, index) => (
        <g
          key={`wisp-${index}`}
          transform={`translate(${wisp.x - fall * (60 + index * 40)} ${wisp.y - fall * (220 + index * 90)}) scale(${wisp.scale * (1 + fall * 0.2)})`}
          opacity={wisp.opacity * (1 - local * 0.7)}
        >
          <path d={wisp.path} fill="#FFFFFF" opacity="0.75" />
        </g>
      ))}
      {RIDGES.map((ridge, index) => (
        <g
          key={`ridge-${index}`}
          transform={`translate(0 ${-fall * ridge.speed}) scale(${1 + fall * ridge.scale}) translate(0 ${-(fall * ridge.scale * SCENE_HEIGHT) / 2 / (1 + fall * ridge.scale)})`}
        >
          <path d={RIDGE_PATHS[index]} fill={ridge.color} />
        </g>
      ))}
    </g>
  );
});

const Curtain = memo(function Curtain({ progress, ids }: { readonly progress: number; readonly ids: SceneIds }) {
  const cover = rangeProgress(progress, SCENE_PHASES.mountains[0], SCENE_PHASES.mountains[1]);
  const reveal = rangeProgress(progress, SCENE_PHASES.drop[0], SCENE_PHASES.drop[1]);
  const opacity = 1 - rangeProgress(progress, SCENE_PHASES.settle[0], SCENE_PHASES.settle[1] - 0.02);

  if (reveal <= 0) {
    const eased = easeIn(cover);
    const edgeY = mix(1010, SCENE_OVERSCAN.y - 120, eased);
    const amplitude = mix(138, 0, clamp(cover * 1.22));
    const path = `${smoothPath(ridgeLine(edgeY, amplitude, 0.85, 3.1))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} 1900 L${SCENE_OVERSCAN.x} 1900 Z`;
    return (
      <g data-scene-layer="curtain">
        <path d={path} fill={PALETTE.beam} />
        <path d={path} fill={`url(#${ids.crumple})`} opacity={CRUMPLE_OPACITY} />
      </g>
    );
  }

  const eased = easeInOut(reveal);
  const topY = mix(612, VIEW.frontTop, eased);
  const bottomY = mix(596, 1500, eased);
  const amplitude = mix(52, 0, clamp(reveal * 2.1));
  const topPath = `${smoothPath(ridgeLine(topY, amplitude, 0.85, 3.1))}L${SCENE_OVERSCAN.x + SCENE_OVERSCAN.width} -1100 L${SCENE_OVERSCAN.x} -1100 Z`;

  return (
    <g opacity={opacity} data-scene-layer="curtain">
      <path d={topPath} fill={PALETTE.beam} />
      <rect x={SCENE_OVERSCAN.x} y={bottomY} width={SCENE_OVERSCAN.width} height="1700" fill={PALETTE.beam} />
      <path d={topPath} fill={`url(#${ids.crumple})`} opacity={CRUMPLE_OPACITY} />
      <rect x={SCENE_OVERSCAN.x} y={bottomY} width={SCENE_OVERSCAN.width} height="1700" fill={`url(#${ids.crumple})`} opacity={CRUMPLE_OPACITY} />
    </g>
  );
});

function perspectiveLerp(progress: number): number {
  return progress / (progress + (1 - progress) * 2.6);
}

function shojiGridPath(
  x: number,
  y: number,
  width: number,
  height: number,
  columns: number,
  rows: number
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

function Shoji({
  x,
  y,
  width,
  height,
  columns,
  rows,
  strokeWidth = 7,
  ids,
}: ShojiProps) {
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

const SideWall = memo(function SideWall({
  side,
  ids,
}: {
  readonly side: "left" | "right";
  readonly ids: SceneIds;
}) {
  const frontX = side === "left" ? VIEW.frontLeft : VIEW.frontRight;
  const backX = side === "left" ? VIEW.backLeft : VIEW.backRight;

  return (
    <g>
      {SIDE_STOPS.slice(0, -1).map((stop, index) => {
        const band = sideBand(stop, SIDE_STOPS[index + 1] ?? 1, side);
        const interpolateY = (top: number, bottom: number, value: number) =>
          mix(top, bottom, value);
        const paper = [
          { x: band.x0, y: interpolateY(band.top0, band.bottom0, 0.14) },
          { x: band.x1, y: interpolateY(band.top1, band.bottom1, 0.14) },
          { x: band.x1, y: interpolateY(band.top1, band.bottom1, 0.94) },
          { x: band.x0, y: interpolateY(band.top0, band.bottom0, 0.94) },
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
            <polygon points={polygonPoints(paper)} fill={shade("#EFECE5", -alternatingShade - 0.03)} />
            <polygon points={polygonPoints(paper)} fill={`url(#${ids.washi})`} opacity="0.68" style={{ mixBlendMode: "multiply" }} />
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
});

const DojoFloor = memo(function DojoFloor() {
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
      <rect x={SCENE_OVERSCAN.x} y={VIEW.frontFloor - 4} width={SCENE_OVERSCAN.width} height={SCENE_OVERSCAN.height} fill={PALETTE.tatami} />
    </g>
  );
});

function dojoCamera(progress: number) {
  const arrival = easeOut(rangeProgress(progress, SCENE_PHASES.drop[0], SCENE_PHASES.drop[1]));
  const portal = easeInOut(rangeProgress(progress, SCENE_PHASES.portal[0], SCENE_PHASES.portal[1]));
  const verticalOffset = mix(-420, 0, arrival);
  const scale =
    mix(1.34, 1, arrival) *
    mix(1, 2.015, portal) *
    mix(1, 5.6, easeIn(rangeProgress(progress, SCENE_PHASES.through[0], SCENE_PHASES.through[1])));

  return {
    scale,
    verticalOffset,
    transform: `translate(${VIEW.centerX} ${VIEW.centerY}) scale(${round2(scale)}) translate(${-VIEW.centerX} ${round2(-VIEW.centerY + verticalOffset)})`,
    project: (x: number, y: number): ScenePoint => ({
      x: VIEW.centerX + scale * (x - VIEW.centerX),
      y: VIEW.centerY + scale * (y - VIEW.centerY + verticalOffset),
    }),
  };
}

const Dojo = memo(function Dojo({ progress, ids }: { readonly progress: number; readonly ids: SceneIds }) {
  const door = easeInOut(rangeProgress(progress, SCENE_PHASES.door[0], SCENE_PHASES.door[1]));
  const camera = dojoCamera(progress);
  const opacity = 1 - easeIn(rangeProgress(progress, SCENE_PHASES.through[0] + 0.045, SCENE_PHASES.through[1] - 0.012));
  if (opacity <= 0.001) {
    return null;
  }

  const slide = mix(0, 185, door);
  const panelWidth = 185;
  return (
    <g opacity={opacity} transform={camera.transform} data-scene-layer="dojo">
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
        <g transform={`translate(${-slide} 0)`} filter={`url(#${ids.lifted})`}>
          <Shoji x={VIEW.doorLeft} y={VIEW.doorTop} width={panelWidth} height={VIEW.doorBottom - VIEW.doorTop} columns={3} rows={5} strokeWidth={8} ids={ids} />
        </g>
        <g transform={`translate(${slide} 0)`} filter={`url(#${ids.lifted})`}>
          <Shoji x={VIEW.doorLeft + panelWidth} y={VIEW.doorTop} width={panelWidth} height={VIEW.doorBottom - VIEW.doorTop} columns={3} rows={5} strokeWidth={8} ids={ids} />
        </g>
      </g>
      {Array.from({ length: 4 }, (_, index) => {
        const x = VIEW.backLeft + index * panelWidth;
        return (
          <g key={`transom-${index}`}>
            <rect x={x + 5} y={VIEW.backTop + 8} width={panelWidth - 10} height={VIEW.doorTop - VIEW.backTop - 16} fill="#EFECE5" />
            <rect x={x + 5} y={VIEW.backTop + 8} width={panelWidth - 10} height={VIEW.doorTop - VIEW.backTop - 16} fill={`url(#${ids.washi})`} opacity="0.66" style={{ mixBlendMode: "multiply" }} />
            <rect x={x + 5} y={VIEW.backTop + 8} width={panelWidth - 10} height={VIEW.doorTop - VIEW.backTop - 16} fill="none" stroke={PALETTE.wood} strokeWidth="9" />
          </g>
        );
      })}
      {[0, 3].map((index) => (
        <Shoji
          key={`back-panel-${index}`}
          x={VIEW.backLeft + index * panelWidth}
          y={VIEW.doorTop}
          width={panelWidth}
          height={VIEW.doorBottom - VIEW.doorTop}
          columns={3}
          rows={5}
          ids={ids}
        />
      ))}
      <rect x={VIEW.backLeft - 10} y={VIEW.backTop} width={VIEW.backRight - VIEW.backLeft + 20} height="16" fill={PALETTE.wood} />
      <rect x={VIEW.backLeft - 10} y={VIEW.doorTop - 13} width={VIEW.backRight - VIEW.backLeft + 20} height="15" fill={PALETTE.wood} />
      <rect x={VIEW.backLeft - 10} y={VIEW.doorBottom - 8} width={VIEW.backRight - VIEW.backLeft + 20} height="16" fill={PALETTE.wood} />
      {[VIEW.backLeft, VIEW.backLeft + panelWidth, VIEW.backLeft + panelWidth * 3, VIEW.backRight].map((x, index) => (
        <rect key={`jamb-${index}`} x={x - 7} y={VIEW.doorTop - 10} width="14" height={VIEW.doorBottom - VIEW.doorTop + 18} fill={PALETTE.wood} />
      ))}
      <rect x="196" y={VIEW.frontTop - 60} width="66" height={SCENE_OVERSCAN.height} fill={PALETTE.beamLight} />
      <rect x="196" y={VIEW.frontTop - 60} width="20" height={SCENE_OVERSCAN.height} fill={shade(PALETTE.beamLight, 0.13)} />
      <rect x="1338" y={VIEW.frontTop - 60} width="66" height={SCENE_OVERSCAN.height} fill={PALETTE.beamLight} />
      <rect x="1338" y={VIEW.frontTop - 60} width="20" height={SCENE_OVERSCAN.height} fill={shade(PALETTE.beamLight, 0.13)} />
      <g transform="translate(292 690)" opacity="0.95">
        <rect x="0" y="0" width="15" height="150" fill={PALETTE.beamLight} />
        <rect x="86" y="0" width="15" height="150" fill={PALETTE.beamLight} />
        {[0, 1, 2].map((index) => (
          <rect key={`rack-${index}`} x="-9" y={18 + index * 36} width="119" height="11" rx="5" fill={PALETTE.woodPale} />
        ))}
      </g>
      <g transform="translate(1216 372)" opacity="0.95">
        <rect x="0" y="0" width="86" height="200" fill="#EDE7D8" />
        <rect x="0" y="0" width="86" height="200" fill={`url(#${ids.washi})`} opacity="0.82" style={{ mixBlendMode: "multiply" }} />
        <rect x="0" y="0" width="86" height="14" fill={PALETTE.wood} />
        <rect x="0" y="186" width="86" height="14" fill={PALETTE.wood} />
        <rect x="30" y="44" width="26" height="94" rx="6" fill={PALETTE.beam} opacity="0.3" />
      </g>
    </g>
  );
});

const Clouds = memo(function Clouds({ progress }: { readonly progress: number }) {
  const local = rangeProgress(progress, SCENE_PHASES.clouds[0], SCENE_PHASES.clouds[1]);
  const opacity = 1 - rangeProgress(progress, SCENE_PHASES.morph[0], SCENE_PHASES.morph[0] + 0.045);
  if (opacity <= 0.001) {
    return null;
  }

  return (
    <g opacity={opacity} data-scene-layer="clouds">
      {CLOUD_GEOMETRY.map((cloud, index) => {
        const cloudProgress = clamp((local - cloud.arrival) / 0.26);
        if (cloudProgress <= 0) {
          return null;
        }
        const eased = easeOut(cloudProgress);
        const offsetX = cloud.direction * mix(760, 0, eased) + cloud.drift * local * 90;
        const offsetY = mix(70, 0, eased) - local * 46 * cloud.drift;
        const scale = cloud.scale * mix(0.78, 1, eased);
        return (
          <g
            key={`cloud-${index}`}
            transform={`translate(${round2(cloud.x + offsetX)} ${round2(cloud.y + offsetY)}) scale(${round2(scale)})`}
            opacity={round2(clamp(cloudProgress * 2.6))}
          >
            <path d={cloud.path} transform="translate(2 19)" fill={shade(PALETTE.cloud[cloud.tone]!, -0.42)} opacity="0.42" />
            <path d={cloud.path} fill={PALETTE.cloud[cloud.tone]!} />
            <path d={cloud.path} transform="translate(0 -5)" fill={shade(PALETTE.cloud[cloud.tone]!, 0.35)} opacity="0.3" />
          </g>
        );
      })}
    </g>
  );
});

const SkyWorld = memo(function SkyWorld({ progress, ids }: { readonly progress: number; readonly ids: SceneIds }) {
  const door = easeInOut(rangeProgress(progress, SCENE_PHASES.door[0], SCENE_PHASES.door[1]));
  const through = rangeProgress(progress, SCENE_PHASES.through[0], SCENE_PHASES.through[1]);
  const sky = rangeProgress(progress, SCENE_PHASES.sky[0], SCENE_PHASES.sky[1]);
  const clouds = rangeProgress(progress, SCENE_PHASES.clouds[0], SCENE_PHASES.clouds[1]);
  const opacity = 1 - rangeProgress(progress, SCENE_PHASES.morph[0] + 0.03, SCENE_PHASES.morph[0] + 0.1);
  if (opacity <= 0.001) {
    return null;
  }

  const slide = mix(0, 185, door);
  const camera = dojoCamera(progress);
  const topLeft = camera.project(VIEW.doorLeft + 185 - slide, VIEW.doorTop);
  const bottomRight = camera.project(VIEW.doorLeft + 185 + slide, VIEW.doorBottom);
  const scale = mix(1, 1.42, easeInOut(through)) * mix(1, 0.72, easeInOut(sky));
  const rise = mix(0, -230, easeInOut(sky)) + mix(0, -180, easeInOut(clouds));
  const sunOpacity = 1 - rangeProgress(progress, SCENE_PHASES.clouds[0] + 0.05, SCENE_PHASES.clouds[1] - 0.03);

  return (
    <g opacity={opacity} data-scene-layer="sky">
      <clipPath id={ids.skyWindow}>
        <rect x={round2(topLeft.x)} y={round2(topLeft.y)} width={round2(bottomRight.x - topLeft.x)} height={round2(bottomRight.y - topLeft.y)} />
      </clipPath>
      <g clipPath={`url(#${ids.skyWindow})`}>
        <rect x="-600" y="-600" width={SCENE_WIDTH + 1200} height={SCENE_HEIGHT + 1200} fill={`url(#${ids.sky})`} />
        <g transform={`translate(${VIEW.centerX} 520) scale(${round2(scale)}) translate(${-VIEW.centerX} ${round2(-520 + rise)})`}>
          <g opacity={1 - easeInOut(sky) * 0.9}>
            {FAR_RIDGES.map((ridge, index) => (
              <path
                key={`far-ridge-${index}`}
                d={closedRidgePath(ridge.baseY, ridge.amplitude, ridge.frequency, ridge.phase, 30)}
                fill={ridge.color}
                opacity={0.95 - index * 0.05}
              />
            ))}
          </g>
          <g transform={`translate(${VIEW.centerX} 430) scale(${1 + easeInOut(sky) * 0.5})`} opacity={sunOpacity}>
            <circle r="300" fill={`url(#${ids.glow})`} />
            <circle cx="9" cy="14" r="88" fill={PALETTE.sun} opacity="0.5" />
            <circle r="84" fill={`url(#${ids.sun})`} />
            <circle r="84" fill="none" stroke={shade(PALETTE.sun, -0.2)} strokeWidth="2" opacity="0.35" />
          </g>
          <Clouds progress={progress} />
        </g>
      </g>
    </g>
  );
});

const Weave = memo(function Weave({ progress, horizon, ids }: { readonly progress: number; readonly horizon: number; readonly ids: SceneIds }) {
  const morph = rangeProgress(progress, SCENE_PHASES.morph[0], SCENE_PHASES.morph[1]);
  const floor = rangeProgress(progress, SCENE_PHASES.floor[0], SCENE_PHASES.floor[1]);
  const opacity = clamp(rangeProgress(progress, SCENE_PHASES.morph[0] - 0.012, SCENE_PHASES.morph[0] + 0.052));
  if (opacity <= 0.001) {
    return null;
  }

  const morphStagger = 0.46;
  const floorStagger = 0.34;
  const shadowOpacity = (1 - clamp(morph * 1.5)) * 0.9;
  const floorTop = mix(-600, horizon + FLOOR_FAR, easeInOut(floor));

  return (
    <g opacity={round2(opacity)} data-scene-layer="weave-floor">
      <clipPath id={ids.floor}>
        <rect x="-600" y={round2(floorTop)} width={SCENE_WIDTH + 1200} height={SCENE_HEIGHT + 1200} />
      </clipPath>
      <g clipPath={`url(#${ids.floor})`}>
        <rect
          x="-600"
          y={round2(floorTop)}
          width={SCENE_WIDTH + 1200}
          height={SCENE_HEIGHT + 1200}
          fill={mixColor(PALETTE.cloud[1], PALETTE.floor[2], clamp(morph * 0.6 + floor * 0.4))}
        />
        {PLANK_GEOMETRY.map((plank, index) => {
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
          const fill = plankFloor > 0
            ? mixColor(bambooTone, floorTone, plankFloor)
            : mixColor(cloudTone, bambooTone, plankMorph);
          const pointList = polygonPoints(points);
          return (
            <g key={`plank-${index}`}>
              {shadowOpacity > 0.01 ? (
                <polygon
                  points={pointList}
                  transform={`translate(0 ${round2(mix(15, 4, plankMorph))})`}
                  fill={shade(cloudTone, -0.45)}
                  opacity={round2(shadowOpacity * 0.3)}
                />
              ) : null}
              <polygon
                points={pointList}
                fill={fill}
                stroke={shade(bambooTone, -0.3)}
                strokeWidth={round2(mix(0, 1.5, plankMorph))}
                strokeOpacity="0.42"
              />
            </g>
          );
        })}
      </g>
    </g>
  );
});

const RoomWall = memo(function RoomWall({ progress, horizon, ids }: { readonly progress: number; readonly horizon: number; readonly ids: SceneIds }) {
  const local = rangeProgress(progress, SCENE_PHASES.floor[0] + 0.02, SCENE_PHASES.floor[1]);
  if (local <= 0.001) {
    return null;
  }

  const floorLine = horizon + FLOOR_FAR;
  return (
    <g opacity={round2(local)} data-scene-layer="room">
      <rect x="-400" y="-900" width={SCENE_WIDTH + 800} height={900 + floorLine} fill={`url(#${ids.wall})`} />
      <rect x="-400" y={floorLine - 20} width={SCENE_WIDTH + 800} height="22" fill={PALETTE.baseboard} opacity="0.55" />
      <g opacity={clamp((local - 0.45) * 3) * 0.85}>
        <rect x="182" y={floorLine - 232} width="34" height="52" rx="5" fill="#EDEAE4" />
        <rect x="192" y={floorLine - 222} width="14" height="24" rx="3" fill="#DAD4CB" />
      </g>
    </g>
  );
});

interface StudentSeat {
  readonly horizontal: number;
  readonly depth: number;
  readonly skin: string;
  readonly lean: number;
  readonly arrival: number;
}

const STUDENT_SEATS: readonly StudentSeat[] = Object.freeze([
  { horizontal: 0.42, depth: 0.35, skin: PALETTE.skin[0], lean: 1.2, arrival: 0 },
  { horizontal: 0.615, depth: 0.39, skin: PALETTE.skin[2], lean: -0.9, arrival: 0.1 },
  { horizontal: 0.69, depth: 0.45, skin: PALETTE.skin[3], lean: 1.7, arrival: 0.26 },
  { horizontal: 0.325, depth: 0.47, skin: PALETTE.skin[1], lean: -1.6, arrival: 0.19 },
  { horizontal: 0.485, depth: 0.57, skin: PALETTE.skin[4], lean: 0.7, arrival: 0.34 },
]);

const STUDENT_BODY_WIDTH = 118;
const STUDENT_BODY_HEIGHT = 132;
const STUDENT_BODY_PATH = smoothPath(
  [
    { x: -STUDENT_BODY_WIDTH * 0.3, y: -STUDENT_BODY_HEIGHT },
    { x: -STUDENT_BODY_WIDTH * 0.46, y: -STUDENT_BODY_HEIGHT * 0.6 },
    { x: -STUDENT_BODY_WIDTH * 0.74, y: -STUDENT_BODY_HEIGHT * 0.18 },
    { x: -STUDENT_BODY_WIDTH * 1.14, y: 6 },
    { x: -STUDENT_BODY_WIDTH * 0.66, y: 25 },
    { x: STUDENT_BODY_WIDTH * 0.72, y: 23 },
    { x: STUDENT_BODY_WIDTH * 1.18, y: 2 },
    { x: STUDENT_BODY_WIDTH * 0.7, y: -STUDENT_BODY_HEIGHT * 0.22 },
    { x: STUDENT_BODY_WIDTH * 0.44, y: -STUDENT_BODY_HEIGHT * 0.62 },
    { x: STUDENT_BODY_WIDTH * 0.28, y: -STUDENT_BODY_HEIGHT },
  ],
  true,
  0.92
);

function Student({
  x,
  y,
  scale,
  skin,
  lean,
  opacity,
}: {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly skin: string;
  readonly lean: number;
  readonly opacity: number;
}) {
  return (
    <g opacity={round2(opacity)} transform={`translate(${round2(x)} ${round2(y)}) scale(${round2(scale)}) rotate(${round2(lean)})`}>
      <ellipse cx="8" cy="20" rx={STUDENT_BODY_WIDTH * 1.26} ry="24" fill="#7C6748" opacity="0.24" />
      <path d={STUDENT_BODY_PATH} transform="translate(7 11)" fill="#7C6748" opacity="0.24" />
      <path d={STUDENT_BODY_PATH} fill={PALETTE.gi} />
      <path
        d={`M-42 ${-STUDENT_BODY_HEIGHT * 0.92} L2 ${-STUDENT_BODY_HEIGHT * 0.42} L46 ${-STUDENT_BODY_HEIGHT * 0.94}`}
        fill="none"
        stroke={PALETTE.belt}
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="8" cy={-STUDENT_BODY_HEIGHT - 54} rx="66" ry="72" fill="#7C6748" opacity="0.22" />
      <ellipse cx="2" cy={-STUDENT_BODY_HEIGHT - 62} rx="66" ry="72" fill={skin} />
      <ellipse cx="-16" cy={-STUDENT_BODY_HEIGHT - 78} rx="34" ry="30" fill={shade(skin, 0.16)} opacity="0.45" />
    </g>
  );
}

const Students = memo(function Students({ progress, horizon, spread }: { readonly progress: number; readonly horizon: number; readonly spread: number }) {
  const local = rangeProgress(progress, SCENE_PHASES.students[0], SCENE_PHASES.students[1]);
  if (local <= 0.001) {
    return null;
  }

  return (
    <g data-scene-layer="students">
      {STUDENT_SEATS.map((seat, index) => {
        const arrival = clamp((local - seat.arrival) / 0.5);
        if (arrival <= 0) {
          return null;
        }
        const eased = easeOut(arrival);
        const horizontal = 0.5 + (seat.horizontal - 0.5) * spread;
        const point = floorPoint(horizontal * U_SPAN, seat.depth * V_SPAN, horizon);
        const depth = mix(FLOOR_FAR, FLOOR_NEAR, seat.depth);
        const bob = Math.sin(local * 3.1 + index * 1.7) * 3 * eased;
        return (
          <Student
            key={`student-${index}`}
            x={point.x}
            y={point.y + mix(150, 0, eased) + bob}
            scale={(depth / 440) * mix(0.92, 1, eased)}
            skin={seat.skin}
            lean={seat.lean}
            opacity={clamp(arrival * 1.8)}
          />
        );
      })}
    </g>
  );
});

function isNear(progress: number, start: number, end: number, padding = 0.05): boolean {
  return progress > start - padding && progress < end + padding;
}

export const JourneyScene = memo(function JourneyScene({
  progress,
  frame,
  viewportWidth = SCENE_WIDTH,
  viewportHeight = SCENE_HEIGHT,
  className,
}: JourneySceneProps) {
  const safeProgress = clamp(progress);
  const resolvedFrame = frame ?? frameForDimensions(viewportWidth, viewportHeight);
  const ids = makeIds(useId());
  const horizon = mix(
    -330,
    330,
    easeInOut(rangeProgress(safeProgress, SCENE_PHASES.floor[0], SCENE_PHASES.floor[1]))
  );

  return (
    <svg
      className={[styles.scene, className].filter(Boolean).join(" ")}
      viewBox={resolvedFrame.viewBox}
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      data-scene-progress={round2(safeProgress)}
      data-scene-frame={resolvedFrame.variant}
    >
      <SceneDefs ids={ids} />
      <clipPath id={ids.back}>
        <rect
          x={VIEW.backLeft}
          y={VIEW.doorTop - 14}
          width={VIEW.backRight - VIEW.backLeft}
          height={VIEW.doorBottom - VIEW.doorTop + 28}
        />
      </clipPath>
      <rect {...overscanRect()} fill={PALETTE.paper} />
      {isNear(safeProgress, SCENE_PHASES.mountains[0], 0.112) ? (
        <Mountains progress={safeProgress} ids={ids} />
      ) : null}
      {isNear(safeProgress, SCENE_PHASES.portal[0], SCENE_PHASES.morph[0] + 0.12, 0.08) ? (
        <SkyWorld progress={safeProgress} ids={ids} />
      ) : null}
      {safeProgress > SCENE_PHASES.mountains[1] - 0.006 && safeProgress < SCENE_PHASES.through[1] + 0.05 ? (
        <Dojo progress={safeProgress} ids={ids} />
      ) : null}
      {safeProgress < SCENE_PHASES.settle[1] + 0.03 ? (
        <Curtain progress={safeProgress} ids={ids} />
      ) : null}
      {isNear(safeProgress, SCENE_PHASES.floor[0], 1.01, 0.06) ? (
        <RoomWall progress={safeProgress} horizon={horizon} ids={ids} />
      ) : null}
      {isNear(safeProgress, SCENE_PHASES.morph[0] - 0.02, 1.01, 0.04) ? (
        <Weave progress={safeProgress} horizon={horizon} ids={ids} />
      ) : null}
      {isNear(safeProgress, SCENE_PHASES.students[0], 1.01, 0.04) ? (
        <Students progress={safeProgress} horizon={horizon} spread={resolvedFrame.studentSpread} />
      ) : null}
      <SceneGrain ids={ids} />
    </svg>
  );
});
