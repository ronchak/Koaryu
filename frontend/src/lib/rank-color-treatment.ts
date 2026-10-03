import type { CSSProperties } from "react";

export function prefersDarkRankText(color: string): boolean {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (!match) return false;

  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : match[1];
  const [red, green, blue] = [0, 2, 4].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;

  return luminance > 0.179;
}

export function getRankColorTreatment(color: string): CSSProperties {
  const useDarkText = prefersDarkRankText(color);

  return {
    backgroundColor: color,
    border: useDarkText ? "1px solid rgb(46 39 28 / 24%)" : "1px solid transparent",
    color: useDarkText ? "#000000" : "#ffffff",
  };
}
