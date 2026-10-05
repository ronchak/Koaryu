import { SceneClock } from "./scene-clock";
import { SCENE_TIME_SCRIPT } from "./scene-time";
import "./scene-tokens.css";

/**
 * Mount at the top of any page drawn on the illustrated world (the landing
 * page, /try). The inline script runs while the HTML is parsed, so the night
 * world is the first thing a night visitor sees; SceneClock takes over after
 * hydration.
 */
export function SceneTimeScript() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SCENE_TIME_SCRIPT }} />
      <SceneClock />
    </>
  );
}
