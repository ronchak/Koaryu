export function LoadingScreen() {
  return (
    <div className="koaryu-loading-screen" role="status" aria-live="polite">
      <div className="koaryu-panda-stage" aria-hidden="true">
        <svg
          className="koaryu-panda"
          viewBox="0 0 64 64"
          xmlns="http://www.w3.org/2000/svg"
        >
          <ellipse className="koaryu-panda__shadow" cx="32" cy="58" rx="16" ry="3" />
          <g className="koaryu-panda__dance">
            <circle className="koaryu-panda__dark" cx="20" cy="15" r="7" />
            <circle className="koaryu-panda__dark" cx="44" cy="15" r="7" />

            <ellipse className="koaryu-panda__arm koaryu-panda__arm--left" cx="16" cy="40" rx="5" ry="8" />
            <ellipse className="koaryu-panda__arm koaryu-panda__arm--right" cx="48" cy="40" rx="5" ry="8" />
            <ellipse className="koaryu-panda__leg koaryu-panda__leg--left" cx="23" cy="53" rx="6" ry="4" />
            <ellipse className="koaryu-panda__leg koaryu-panda__leg--right" cx="41" cy="53" rx="6" ry="4" />

            <ellipse className="koaryu-panda__fur" cx="32" cy="42" rx="17" ry="14" />
            <path className="koaryu-panda__soft-line" d="M22 43C27 47 37 47 42 43" />

            <circle className="koaryu-panda__fur" cx="32" cy="27" r="18" />
            <ellipse className="koaryu-panda__patch" cx="25" cy="27" rx="7" ry="8" transform="rotate(18 25 27)" />
            <ellipse className="koaryu-panda__patch" cx="39" cy="27" rx="7" ry="8" transform="rotate(-18 39 27)" />
            <circle className="koaryu-panda__eye" cx="27" cy="27" r="2.2" />
            <circle className="koaryu-panda__eye" cx="37" cy="27" r="2.2" />
            <circle className="koaryu-panda__eye-shine" cx="27.8" cy="26.2" r="0.8" />
            <circle className="koaryu-panda__eye-shine" cx="37.8" cy="26.2" r="0.8" />
            <ellipse className="koaryu-panda__nose" cx="32" cy="33" rx="2.3" ry="1.8" />
            <path className="koaryu-panda__mouth" d="M28.5 37C30 39 34 39 35.5 37" />
            <path className="koaryu-panda__accent" d="M45 10C46 7.5 50 8 50 11.5C50 15.5 45 17.5 45 17.5C45 17.5 40 15.5 40 11.5C40 8 44 7.5 45 10Z" />
          </g>
        </svg>
      </div>
      <p className="koaryu-loading-screen__text">Loading Koaryu...</p>
    </div>
  );
}
