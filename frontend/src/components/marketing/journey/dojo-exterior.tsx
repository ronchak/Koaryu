// The dojo from outside on a class night: paper walls lit from within, the class
// sitting behind them as shadows, lanterns at the eaves and light spilling down the
// steps. Rendered to stills by scripts/generate-landing-art.mjs; never shipped live.
import { makeCloudPath, mulberry32, round2, smoothPath } from "./scene-model.ts";
import { closedRidgePath, ridgeLine } from "./hills.ts";

export type DojoExteriorVariant = "wide" | "tall";

const VIEWBOX: Record<DojoExteriorVariant, string> = {
  wide: "0 0 1600 1000",
  tall: "380 -560 840 1818",
};
const MOON: Record<DojoExteriorVariant, readonly [number, number]> = {
  wide: [1236, 148],
  tall: [1040, -250],
};

const STARS = (() => {
  const random = mulberry32(2207);
  return Array.from({ length: 120 }, () => ({
    x: round2(-200 + random() * 2000),
    y: round2(-600 + random() ** 1.3 * 1180),
    r: round2(0.8 + random() ** 3 * 2.2),
    opacity: round2(0.3 + random() * 0.6),
  }));
})();

const HILLS = [
  { color: "#232947", rim: "#4C5785", baseY: 590, amplitude: 46, frequency: 1.1, phase: 2.2 },
  { color: "#1A1E35", rim: "#3A4268", baseY: 640, amplitude: 34, frequency: 1.6, phase: 4.6 },
] as const;

const WALL_TOP = 432;
const WALL_BOTTOM = 600;
const KICK_BOTTOM = 634;
/** Shoji panels across the front: two fixed panels in each side bay, two doors in the middle. */
const PANELS = [
  { x: 342, width: 117, columns: 3 },
  { x: 459, width: 117, columns: 3 },
  { x: 600, width: 200, columns: 4 },
  { x: 800, width: 200, columns: 4 },
  { x: 1024, width: 117, columns: 3 },
  { x: 1141, width: 117, columns: 3 },
] as const;
const POSTS = [318, 576, 1000, 1258] as const;
const ROWS = 5;

/** The class, seated behind the paper. Nearer the paper means a sharper shadow. */
const SITTERS = [
  { x: 392, scale: 0.29, near: false },
  { x: 520, scale: 0.3, near: false },
  { x: 662, scale: 0.34, near: true },
  { x: 752, scale: 0.33, near: true },
  { x: 852, scale: 0.34, near: true },
  { x: 942, scale: 0.33, near: true },
  { x: 1076, scale: 0.3, near: false },
] as const;

const SITTER_PATH = smoothPath(
  [
    { x: -34, y: -128 },
    { x: -54, y: -110 },
    { x: -63, y: -64 },
    { x: -92, y: -18 },
    { x: -121, y: 6 },
    { x: -70, y: 22 },
    { x: 74, y: 21 },
    { x: 123, y: 4 },
    { x: 94, y: -20 },
    { x: 64, y: -64 },
    { x: 54, y: -110 },
    { x: 34, y: -128 },
  ],
  true,
  0.9,
);

const PINE_PADS = [
  { x: 210, y: 360, scale: 0.5, seed: 4410 },
  { x: 92, y: 452, scale: 0.46, seed: 812 },
  { x: 268, y: 498, scale: 0.4, seed: 3307 },
  { x: 140, y: 292, scale: 0.36, seed: 1903 },
  { x: 40, y: 560, scale: 0.42, seed: 9021 },
] as const;

function latticePath(x: number, width: number, columns: number): string {
  let path = "";
  for (let column = 1; column < columns; column += 1) {
    const lineX = round2(x + (column * width) / columns);
    path += `M${lineX} ${WALL_TOP}V${WALL_BOTTOM}`;
  }
  for (let row = 1; row < ROWS; row += 1) {
    const lineY = round2(WALL_TOP + (row * (WALL_BOTTOM - WALL_TOP)) / ROWS);
    path += `M${x} ${lineY}H${x + width}`;
  }
  return path;
}

function Lantern({ x, y }: { readonly x: number; readonly y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="170" fill="url(#dx-lantern-glow)" style={{ mixBlendMode: "screen" }} />
      <line x1="0" y1="-60" x2="0" y2="-32" stroke="#0E0A08" strokeWidth="2" />
      <ellipse rx="22" ry="29" fill="url(#dx-lantern)" />
      {[-0.62, -0.31, 0, 0.31, 0.62].map((rib) => {
        const half = 22 * Math.sqrt(1 - rib * rib);
        return (
          <path
            key={rib}
            d={`M${round2(-half)} ${round2(rib * 29)}Q0 ${round2(rib * 29 + 3)} ${round2(half)} ${round2(rib * 29)}`}
            stroke="#C9733A"
            strokeWidth="1.1"
            opacity="0.55"
            fill="none"
          />
        );
      })}
      <rect x="-13" y="-35" width="26" height="8" rx="2" fill="#1C120C" />
      <rect x="-13" y="27" width="26" height="8" rx="2" fill="#1C120C" />
    </g>
  );
}

export function DojoExterior({ variant = "wide" }: { readonly variant?: DojoExteriorVariant }) {
  const [moonX, moonY] = MOON[variant];
  return (
    <svg
      viewBox={VIEWBOX[variant]}
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className="scene"
    >
      <defs>
        <linearGradient id="dx-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0B0E20" />
          <stop offset="0.45" stopColor="#161C38" />
          <stop offset="0.8" stopColor="#262B4C" />
          <stop offset="1" stopColor="#3A3150" />
        </linearGradient>
        <radialGradient id="dx-moon-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#CDD6F2" stopOpacity="0.3" />
          <stop offset="0.4" stopColor="#8E9BCB" stopOpacity="0.1" />
          <stop offset="1" stopColor="#5D6A9C" stopOpacity="0" />
        </radialGradient>
        <mask id="dx-crescent">
          <circle cx={moonX} cy={moonY} r="40" fill="#fff" />
          <circle cx={moonX + 17} cy={moonY - 11} r="37" fill="#000" />
        </mask>
        <radialGradient id="dx-paper" cx="0.5" cy="0.62" r="0.75">
          <stop offset="0" stopColor="#FFE6B4" />
          <stop offset="0.5" stopColor="#F7B96A" />
          <stop offset="1" stopColor="#D88642" />
        </radialGradient>
        <linearGradient id="dx-ranma" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#C77B3C" />
          <stop offset="1" stopColor="#F0AE62" />
        </linearGradient>
        <radialGradient id="dx-lantern" cx="0.46" cy="0.42" r="0.62">
          <stop offset="0" stopColor="#FFF0CF" />
          <stop offset="0.5" stopColor="#FFC977" />
          <stop offset="1" stopColor="#D9813F" />
        </radialGradient>
        <radialGradient id="dx-lantern-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFC66E" stopOpacity="0.55" />
          <stop offset="0.3" stopColor="#F2A24F" stopOpacity="0.18" />
          <stop offset="1" stopColor="#D98236" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dx-facade-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#F7A957" stopOpacity="0.42" />
          <stop offset="0.45" stopColor="#C8743A" stopOpacity="0.14" />
          <stop offset="1" stopColor="#8A4A26" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dx-soffit" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24180F" />
          <stop offset="1" stopColor="#7C4C27" />
        </linearGradient>
        <linearGradient id="dx-deck" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3A2717" />
          <stop offset="0.5" stopColor="#8E6038" />
          <stop offset="1" stopColor="#3A2717" />
        </linearGradient>
        <radialGradient id="dx-spill" cx="0.5" cy="0.5" r="0.5" fy="0.1">
          <stop offset="0" stopColor="#F4B061" stopOpacity="0.4" />
          <stop offset="0.4" stopColor="#D98A45" stopOpacity="0.14" />
          <stop offset="1" stopColor="#B86F33" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dx-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1C1822" />
          <stop offset="1" stopColor="#0F0D14" />
        </linearGradient>
        <filter id="dx-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <filter id="dx-softer" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <clipPath id="dx-paper-clip">
          <rect x="342" y={WALL_TOP} width="916" height={WALL_BOTTOM - WALL_TOP} />
        </clipPath>
        <pattern id="dx-washi" patternUnits="userSpaceOnUse" width="220" height="220">
          <image href="/marketing/washi.webp" width="220" height="220" />
        </pattern>
      </defs>

      {/* Sky, stars and a new moon. */}
      <rect x="-400" y="-700" width="2400" height="1500" fill="url(#dx-sky)" />
      {STARS.map((star, index) => (
        <circle
          key={index}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="#F3EAD6"
          opacity={star.opacity}
        />
      ))}
      <circle cx={moonX} cy={moonY} r="230" fill="url(#dx-moon-glow)" />
      <circle cx={moonX} cy={moonY} r="40" fill="#F4ECD8" mask="url(#dx-crescent)" />

      {/* The hills from the opening, now dark. */}
      {HILLS.map((hill) => (
        <g key={hill.baseY}>
          <path
            d={closedRidgePath(hill.baseY, hill.amplitude, hill.frequency, hill.phase, 30)}
            fill={hill.color}
          />
          <path
            d={smoothPath(ridgeLine(hill.baseY, hill.amplitude, hill.frequency, hill.phase, 30))}
            fill="none"
            stroke={hill.rim}
            strokeWidth="2"
            opacity="0.6"
          />
        </g>
      ))}

      {/* Ground, the light falling out of the doors, and the stepping stones. */}
      <rect x="-400" y="686" width="2400" height="700" fill="url(#dx-ground)" />
      <ellipse cx="800" cy="760" rx="620" ry="330" fill="url(#dx-spill)" />
      {[
        [800, 788, 74, 13],
        [772, 862, 86, 16],
        [826, 952, 100, 20],
        [790, 1060, 116, 23],
      ].map(([cx, cy, rx, ry]) => (
        <g key={cy}>
          <ellipse cx={cx} cy={cy! + 4} rx={rx} ry={ry} fill="#0B090E" opacity="0.7" />
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="#2B2630" />
          <ellipse
            cx={cx! - rx! * 0.06}
            cy={cy! - ry! * 0.28}
            rx={rx! * 0.82}
            ry={ry! * 0.55}
            fill="#6E5442"
            opacity="0.55"
          />
        </g>
      ))}

      {/* A glow on the night air around the lit front. */}
      <ellipse
        cx="800"
        cy="540"
        rx="760"
        ry="330"
        fill="url(#dx-facade-glow)"
        style={{ mixBlendMode: "screen" }}
      />

      {/* Veranda and steps. */}
      <rect x="292" y="634" width="1016" height="58" fill="#1A120C" />
      <rect x="276" y="630" width="1048" height="16" fill="url(#dx-deck)" />
      <rect x="276" y="644" width="1048" height="3" fill="#0E0906" opacity="0.6" />
      <rect x="680" y="692" width="240" height="18" fill="#5A4436" />
      <rect x="680" y="708" width="240" height="8" fill="#231B1C" />
      <rect x="656" y="716" width="288" height="16" fill="#4A382E" />
      <rect x="656" y="730" width="288" height="8" fill="#1D1719" />
      {[300, 560, 1016, 1272].map((x) => (
        <rect key={x} x={x} y="646" width="28" height="46" fill="#120C08" />
      ))}

      {/* The lit paper wall, the class behind it, and the lattice. */}
      <rect x="342" y="380" width="916" height="40" fill="url(#dx-ranma)" />
      {PANELS.map((panel) => (
        <rect
          key={panel.x}
          x={panel.x}
          y={WALL_TOP}
          width={panel.width}
          height={WALL_BOTTOM - WALL_TOP}
          fill="url(#dx-paper)"
        />
      ))}
      <g clipPath="url(#dx-paper-clip)" style={{ mixBlendMode: "multiply" }}>
        {SITTERS.map((sitter) => (
          <g
            key={sitter.x}
            transform={`translate(${sitter.x} ${WALL_BOTTOM + 4}) scale(${sitter.scale})`}
            filter={sitter.near ? "url(#dx-soft)" : "url(#dx-softer)"}
            opacity={sitter.near ? 0.62 : 0.4}
          >
            <path d={SITTER_PATH} fill="#9A5422" />
            <ellipse cx="0" cy="-182" rx="52" ry="58" fill="#9A5422" />
          </g>
        ))}
        {/* The instructor, standing in front of the class. */}
        <g transform={`translate(1188 ${WALL_BOTTOM + 4})`} filter="url(#dx-softer)" opacity="0.42">
          <path
            d="M-24 -118C-30 -112 -33 -96 -34 -78L-40 0H40L34 -78C33 -96 30 -112 24 -118Z"
            fill="#9A5422"
          />
          <circle cx="0" cy="-136" r="16" fill="#9A5422" />
        </g>
      </g>
      <rect
        x="342"
        y="380"
        width="916"
        height={WALL_BOTTOM - 380}
        fill="url(#dx-washi)"
        opacity="0.55"
        style={{ mixBlendMode: "multiply" }}
      />
      <path
        d={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
          .map((index) => `M${342 + index * 41.6} 380V420`)
          .join("")}
        stroke="#2B1B10"
        strokeWidth="3"
      />
      {PANELS.map((panel) => (
        <g key={`lattice-${panel.x}`}>
          <path
            d={latticePath(panel.x, panel.width, panel.columns)}
            stroke="#3A2415"
            strokeWidth="3.4"
            fill="none"
          />
          <rect
            x={panel.x + 4}
            y={WALL_TOP + 4}
            width={panel.width - 8}
            height={WALL_BOTTOM - WALL_TOP - 8}
            fill="none"
            stroke="#2E1C10"
            strokeWidth="8"
          />
          {/* The kick panel at the foot of each shoji, its top edge catching the glow. */}
          <rect
            x={panel.x}
            y={WALL_BOTTOM}
            width={panel.width}
            height={KICK_BOTTOM - WALL_BOTTOM}
            fill="#3B2617"
          />
          <rect x={panel.x} y={WALL_BOTTOM} width={panel.width} height="3" fill="#A86B36" />
        </g>
      ))}
      <rect x="796" y={WALL_TOP} width="8" height={KICK_BOTTOM - WALL_TOP} fill="#24160D" />
      <rect x="318" y="420" width="964" height="12" fill="#2A1B11" />
      <rect x="318" y="362" width="964" height="18" fill="#2E1F15" />
      <rect x="318" y="377" width="964" height="3" fill="#7A4B27" />
      {POSTS.map((x) => (
        <g key={x}>
          <rect x={x} y="350" width="24" height="296" fill="#24180F" />
          <rect x={x + (x < 800 ? 19 : 0)} y="380" width="5" height="254" fill="#8A5A30" />
        </g>
      ))}

      {/* Roof: under-lit soffit, rafter ends, tiles and a moonlit ridge. */}
      <rect x="252" y="340" width="1096" height="24" fill="url(#dx-soffit)" />
      {Array.from({ length: 38 }, (_, index) => (
        <rect key={index} x={268 + index * 28.6} y="350" width="10" height="9" fill="#120C09" />
      ))}
      <path
        d="M196 326Q420 298 568 198L1032 198Q1180 298 1404 326Q1376 346 1310 348L290 348Q224 346 196 326Z"
        fill="#19141A"
      />
      {[228, 256, 284, 312].map((y) => (
        <path
          key={y}
          d={`M${round2(568 - (y - 198) * 1.62)} ${y}H${round2(1032 + (y - 198) * 1.62)}`}
          stroke="#241D25"
          strokeWidth="3"
        />
      ))}
      <path
        d="M196 326Q420 298 568 198"
        fill="none"
        stroke="#3B4266"
        strokeWidth="2.5"
        opacity="0.7"
      />
      <path
        d="M1032 198Q1180 298 1404 326"
        fill="none"
        stroke="#4A5380"
        strokeWidth="3"
        opacity="0.8"
      />
      <rect x="548" y="184" width="504" height="16" fill="#121015" />
      <rect x="548" y="184" width="504" height="3" fill="#4A5380" opacity="0.8" />
      <rect x="532" y="170" width="22" height="30" rx="3" fill="#121015" />
      <rect x="1046" y="170" width="22" height="30" rx="3" fill="#121015" />
      <path d="M290 348H1310" stroke="#5E3A20" strokeWidth="2" opacity="0.8" />

      <Lantern x={452} y={420} />
      <Lantern x={1148} y={420} />

      {/* A pine on the left, a stone lantern and shrubs on the right. */}
      <path
        d="M70 1000C96 860 118 760 150 650C176 560 196 470 214 380M150 650C120 600 96 560 70 470M176 560C214 530 250 515 280 505"
        stroke="#0E0D13"
        strokeWidth="26"
        strokeLinecap="round"
        fill="none"
      />
      {PINE_PADS.map((pad) => {
        const path = makeCloudPath(pad.seed);
        return (
          <g
            key={pad.seed}
            transform={`translate(${pad.x} ${pad.y}) scale(${pad.scale} ${pad.scale * 1.9})`}
          >
            <path d={path} transform="translate(0 -6)" fill="#2C3354" opacity="0.8" />
            <path d={path} fill="#0F1018" />
          </g>
        );
      })}
      <g>
        <ellipse cx="1470" cy="700" rx="200" ry="74" fill="#101119" />
        <ellipse cx="1600" cy="680" rx="170" ry="90" fill="#0D0E15" />
        <path d="M1290 690Q1380 616 1520 626" stroke="#2C3354" strokeWidth="3" fill="none" />
        <rect x="1404" y="666" width="48" height="22" fill="#1C1A21" />
        <rect x="1419" y="610" width="18" height="58" fill="#1C1A21" />
        <rect x="1398" y="574" width="60" height="38" fill="#1C1A21" />
        <rect x="1415" y="582" width="26" height="22" fill="#FFC46E" />
        <circle cx="1428" cy="593" r="60" fill="url(#dx-lantern-glow)" />
        <path d="M1380 576L1428 548L1476 576Z" fill="#1C1A21" />
        <circle cx="1428" cy="542" r="7" fill="#1C1A21" />
      </g>
    </svg>
  );
}

/**
 * The class as shadows on the paper doors, close up: what the shoji doors carry
 * before they slide open. Rendered on a transparent background.
 */
export function DoorShadows() {
  const seats = [
    { x: 250, scale: 0.92, near: false },
    { x: 520, scale: 1.04, near: true },
    { x: 770, scale: 0.98, near: true },
    { x: 1030, scale: 1.06, near: true },
    { x: 1290, scale: 0.9, near: false },
  ];
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className="scene"
    >
      <defs>
        <filter id="ds-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="ds-softer" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      {seats.map((seat) => (
        <g
          key={seat.x}
          transform={`translate(${seat.x} 1010) scale(${seat.scale * 1.7})`}
          filter={seat.near ? "url(#ds-soft)" : "url(#ds-softer)"}
          opacity={seat.near ? 0.5 : 0.32}
        >
          <path d={SITTER_PATH} fill="#7A3E16" />
          <ellipse cx="0" cy="-182" rx="52" ry="58" fill="#7A3E16" />
        </g>
      ))}
    </svg>
  );
}
