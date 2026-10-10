"use client";

import type { CSSProperties } from "react";
import type { BeltRank } from "@/types";
import styles from "./belt-tracker.module.css";

export type BeltSwatchSize = "xs" | "sm" | "md" | "lg";

/**
 * A drawn belt: the rank's own colour (a data colour), a knot, and a tip band
 * for sub-ranks. Decorative; the rank's name always sits beside it in words.
 */
export function BeltSwatch({
  color,
  isTip,
  size = "md",
  tipColor,
}: {
  color: string | null | undefined;
  isTip?: boolean;
  size?: BeltSwatchSize;
  tipColor?: string | null;
}) {
  const style = {
    "--belt": color || "var(--hz-tile)",
    ...(isTip && tipColor ? { "--belt-tip": tipColor } : {}),
  } as CSSProperties;
  return (
    <span
      className={styles.beltSwatch}
      data-size={size}
      data-tip={isTip && tipColor ? "true" : undefined}
      data-empty={color ? undefined : "true"}
      style={style}
      aria-hidden="true"
    />
  );
}

/** Progress toward one promotion requirement, in words and a thin bar. */
export function ProgressBar({
  caption,
  current,
  label,
  required,
  met,
  unit,
}: {
  caption?: string;
  current: number;
  label: string;
  required: number;
  met: boolean;
  unit?: string;
}) {
  if (required <= 0) {
    return (
      <div className={styles.requirement} data-met="true">
        {caption ? <span className={styles.requirementCaption}>{caption}</span> : null}
        <span className={styles.requirementValue}>Not required</span>
      </div>
    );
  }

  const pct = Math.min(100, Math.round((current / required) * 100));
  return (
    <div className={styles.requirement} data-met={met ? "true" : undefined}>
      {caption ? <span className={styles.requirementCaption}>{caption}</span> : null}
      <span className={styles.requirementValue}>
        <strong>{current.toLocaleString()}</strong> of {required.toLocaleString()}
        {unit ? ` ${unit}` : ""}
      </span>
      <span
        className={styles.requirementTrack}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={Math.min(current, required)}
        aria-valuetext={`${current} of ${required}`}
      >
        <span className={styles.requirementFill} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** A rank named in words with its belt beside it. */
export function RankBadge({
  name,
  color,
  isTip,
  tipColor,
}: {
  name: string;
  color: string;
  isTip?: boolean;
  tipColor?: string;
}) {
  return (
    <span className={styles.rankBadge}>
      <BeltSwatch color={color} isTip={isTip} tipColor={tipColor} size="xs" />
      {name}
    </span>
  );
}

export function BeltVisual({
  rank,
  size = "md",
}: {
  rank: Pick<BeltRank, "color_hex" | "is_tip" | "tip_color_hex">;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <BeltSwatch
      color={rank.color_hex}
      isTip={rank.is_tip}
      tipColor={rank.tip_color_hex}
      size={size}
    />
  );
}
