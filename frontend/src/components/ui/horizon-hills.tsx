import {
  HORIZON_BAND_RIDGE_PATHS,
  HORIZON_BAND_VIEWBOX,
  HORIZON_RIDGE_PATHS,
  HORIZON_VIEWBOX,
} from "@/lib/dashboard-horizon";
import styles from "./horizon.module.css";

/** The landing page's ridges. `hero` fills the Dashboard greeting; `band` sits under page titles. */
export function HorizonHills({
  className,
  sun = true,
  variant = "hero",
}: {
  className?: string;
  sun?: boolean;
  variant?: "hero" | "band";
}) {
  const box = variant === "band" ? HORIZON_BAND_VIEWBOX : HORIZON_VIEWBOX;
  const paths = variant === "band" ? HORIZON_BAND_RIDGE_PATHS : HORIZON_RIDGE_PATHS;
  const sunCircle = variant === "band" ? { cx: 1010, cy: 70, r: 24 } : { cx: 1160, cy: 132, r: 46 };
  return (
    <svg
      className={[styles.hills, className].filter(Boolean).join(" ")}
      data-variant={variant}
      viewBox={`0 0 ${box.width} ${box.height}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      {sun ? (
        <>
          <circle className={styles.sun} {...sunCircle} />
          <circle
            className={styles.sunHalo}
            cx={sunCircle.cx + 5}
            cy={sunCircle.cy + 5}
            r={sunCircle.r}
          />
        </>
      ) : null}
      {paths.map((path, index) => (
        <path key={index} d={path} fill={`var(--hz-ridge-${index})`} />
      ))}
    </svg>
  );
}
