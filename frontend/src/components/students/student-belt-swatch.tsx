import type { CSSProperties } from "react";
import styles from "./student-records.module.css";

/** A short belt drawn in the rank's own colour (a data colour, not a theme colour). */
export function BeltSwatch({ color, size = "md" }: { color?: string | null; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={styles.beltSwatch}
      data-empty={color ? undefined : "true"}
      data-size={size}
      style={color ? ({ "--belt-color": color } as CSSProperties) : undefined}
    />
  );
}
