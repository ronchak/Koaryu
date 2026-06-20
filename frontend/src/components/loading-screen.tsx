import styles from "./loading-screen.module.css";

export function LoadingScreen() {
  return (
    <div className={styles.screen} role="status" aria-live="polite">
      <div className={styles.stage} aria-hidden="true">
        <svg
          className={styles.graphic}
          viewBox="0 0 64 64"
          xmlns="http://www.w3.org/2000/svg"
        >
          <ellipse className={styles.shadow} cx="32" cy="58" rx="16" ry="3" />
          <g className={styles.dance}>
            <circle className={styles.dark} cx="20" cy="15" r="7" />
            <circle className={styles.dark} cx="44" cy="15" r="7" />

            <ellipse className={`${styles.arm} ${styles.armLeft}`} cx="16" cy="40" rx="5" ry="8" />
            <ellipse className={`${styles.arm} ${styles.armRight}`} cx="48" cy="40" rx="5" ry="8" />
            <ellipse className={`${styles.leg} ${styles.legLeft}`} cx="23" cy="53" rx="6" ry="4" />
            <ellipse className={`${styles.leg} ${styles.legRight}`} cx="41" cy="53" rx="6" ry="4" />

            <ellipse className={styles.fur} cx="32" cy="42" rx="17" ry="14" />
            <path className={styles.softLine} d="M22 43C27 47 37 47 42 43" />

            <circle className={styles.fur} cx="32" cy="27" r="18" />
            <ellipse className={styles.patch} cx="25" cy="27" rx="7" ry="8" transform="rotate(18 25 27)" />
            <ellipse className={styles.patch} cx="39" cy="27" rx="7" ry="8" transform="rotate(-18 39 27)" />
            <circle className={styles.eye} cx="27" cy="27" r="2.2" />
            <circle className={styles.eye} cx="37" cy="27" r="2.2" />
            <circle className={styles.eyeShine} cx="27.8" cy="26.2" r="0.8" />
            <circle className={styles.eyeShine} cx="37.8" cy="26.2" r="0.8" />
            <ellipse className={styles.nose} cx="32" cy="33" rx="2.3" ry="1.8" />
            <path className={styles.mouth} d="M28.5 37C30 39 34 39 35.5 37" />
            <path className={styles.accent} d="M45 10C46 7.5 50 8 50 11.5C50 15.5 45 17.5 45 17.5C45 17.5 40 15.5 40 11.5C40 8 44 7.5 45 10Z" />
          </g>
        </svg>
      </div>
      <p className={styles.text}>Loading Koaryu...</p>
    </div>
  );
}
