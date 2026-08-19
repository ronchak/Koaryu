"use client";

import type { BeltRank } from "@/types";

export function ProgressBar({ current, label, required, met }: {
  current: number;
  label: string;
  required: number;
  met: boolean;
}) {
  if (required <= 0) {
    return <span className="text-xs text-muted">Not required</span>;
  }

  const pct = Math.min(100, Math.round((current / required) * 100));
  return (
    <div className="flex items-center gap-2 w-full">
      <div
        className="flex-1 h-1.5 bg-surface-raised rounded-full overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={Math.min(current, required)}
        aria-valuetext={`${current} of ${required}`}
      >
        <div
          className={`h-full rounded-full transition-[background-color,width] ${met ? "bg-success" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-14 text-right ${met ? "text-success" : "text-text-secondary"}`}>
        {current}/{required}
      </span>
    </div>
  );
}

export function RankBadge({ name, color, isTip, tipColor }: {
  name: string;
  color: string;
  isTip?: boolean;
  tipColor?: string;
}) {
  const useDarkText = prefersDarkText(color);
  const treatment = {
    backgroundColor: color,
    border: useDarkText ? "1px solid rgb(46 39 28 / 24%)" : "1px solid transparent",
    color: useDarkText ? "#211b12" : "#ffffff",
  };

  if (isTip && tipColor) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[10px] text-xs font-medium"
        style={treatment}
      >
        <span
          className="w-2 h-2 rounded-full border border-white/20 flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        {name}
        <span className="ml-0.5 w-1.5 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: tipColor }} />
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[10px] text-xs font-medium"
      style={treatment}
    >
      <span className="w-2 h-2 rounded-full border border-white/30" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

export function BeltVisual({ rank, size = "md" }: { rank: BeltRank; size?: "sm" | "md" }) {
  const isLight = prefersDarkText(rank.color_hex);
  const dims = size === "sm" ? "w-7 h-3" : "w-10 h-4";
  return (
    <div
      className={`relative ${dims} rounded-[6px] overflow-hidden flex-shrink-0`}
      style={{
        backgroundColor: rank.color_hex,
        border: isLight ? "1px solid rgb(46 39 28 / 24%)" : "1px solid transparent",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)",
      }}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-black/20" />
      {rank.is_tip && rank.tip_color_hex && (
        <div className="absolute right-0 inset-y-0 w-2.5" style={{ backgroundColor: rank.tip_color_hex }} />
      )}
    </div>
  );
}

function prefersDarkText(color: string): boolean {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (!match) return false;

  const hex = match[1].length === 3
    ? match[1].split("").map((character) => `${character}${character}`).join("")
    : match[1];
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const luminance = 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;

  return luminance > 0.179;
}
