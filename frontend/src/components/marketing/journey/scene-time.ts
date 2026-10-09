/**
 * Day or night for the landing page's illustrated world, by the clock in the
 * Pacific time zone (the studio's clock, not the visitor's): night from 7 PM
 * to 5:59 AM in America/Los_Angeles, daylight saving included. `?scene=night`
 * or `?scene=day` forces either for review.
 *
 * The same rules run twice: as typed functions here (tests, the client clock)
 * and as SCENE_TIME_SCRIPT, the dependency-free inline script that sets
 * <html data-scene> before first paint so night visitors never see the day.
 */
export type SceneTime = "day" | "night";

export const SCENE_TIME_ZONE = "America/Los_Angeles";
/** First night hour (19:00) and first day hour (06:00), Pacific. */
export const NIGHT_FROM_HOUR = 19;
export const DAY_FROM_HOUR = 6;
export const SCENE_QUERY_PARAM = "scene";
/** The attribute on <html> that styles key on: html[data-scene="night"]. */
export const SCENE_ATTRIBUTE = "data-scene";

/** The hour (0-23) on a Pacific wall clock at this instant. */
export function pacificHour(date: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: SCENE_TIME_ZONE,
    hour: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  // Some engines print midnight as "24" even with h23.
  const value = Number(hour) % 24;
  if (!Number.isInteger(value)) throw new RangeError("No Pacific hour for this date");
  return value;
}

export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_FROM_HOUR || hour < DAY_FROM_HOUR;
}

/** Night between 19:00 and 05:59 Pacific; day otherwise, and whenever the clock is unknown. */
export function sceneFor(date: Date): SceneTime {
  try {
    return isNightHour(pacificHour(date)) ? "night" : "day";
  } catch {
    return "day";
  }
}

/** `?scene=night|day` from a location.search string, or null. */
export function sceneOverride(search: string): SceneTime | null {
  const value = new URLSearchParams(search).get(SCENE_QUERY_PARAM);
  return value === "night" || value === "day" ? value : null;
}

export function resolveScene(date: Date, search: string): SceneTime {
  return sceneOverride(search) ?? sceneFor(date);
}

/**
 * The pre-paint switch. Plain ES5 with no imports, wrapped so it can never
 * throw; any failure leaves the day scene, which is the server-rendered default.
 * Written out in full rather than built from the constants above, so no value is
 * ever spliced into script source; tests/marketing-scene-time.test.mjs checks it
 * still carries those constants.
 */
export const SCENE_TIME_SCRIPT =
  '(function(){var d=document.documentElement,s="day";try{var q=new URLSearchParams(location.search).get("scene");if(q==="night"||q==="day"){s=q}else{var p=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",hourCycle:"h23"}).formatToParts(new Date()),h=NaN;for(var i=0;i<p.length;i++){if(p[i].type==="hour")h=Number(p[i].value)%24}if(h>=19||h<6)s="night"}}catch(e){s="day"}d.setAttribute("data-scene",s)})();';
