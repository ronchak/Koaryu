export type DashboardBriefGreeting = {
  id: string;
  /** Copy for the owner brief heading. `{name}` is replaced with the owner's first name. */
  text: string;
  /** When set, the greeting is only eligible on that day (0 = Sunday ... 6 = Saturday). */
  weekday?: number;
};

const NAME_TOKEN = "{name}";

/**
 * Rotating owner brief headings. Entries without `{name}` stay eligible for owners
 * whose profile name is missing, so the heading never reads as a blank greeting.
 */
export const DASHBOARD_BRIEF_GREETINGS: DashboardBriefGreeting[] = [
  // Nameless fallbacks.
  { id: "n01", text: "Welcome back." },
  { id: "n02", text: "Good morning." },
  { id: "n03", text: "Here's your studio." },
  { id: "n04", text: "The floor is yours." },
  { id: "n05", text: "Back at it." },
  { id: "n06", text: "Where things stand." },
  { id: "n07", text: "Today's read." },
  { id: "n08", text: "Ready when you are." },
  { id: "n09", text: "Everything in one place." },
  { id: "n10", text: "The short version." },
  { id: "n11", text: "Nothing's on fire. Probably." },
  { id: "n12", text: "The floor is swept." },
  { id: "n13", text: "One roster, no surprises." },
  { id: "n14", text: "Let's get into it." },
  { id: "n15", text: "Deep breath." },
  { id: "n16", text: "What's moving today." },
  { id: "n17", text: "Clear eyes." },
  { id: "n18", text: "The studio, at a glance." },

  // Standard greetings.
  { id: "s01", text: "Welcome back, {name}." },
  { id: "s02", text: "Good morning, {name}." },
  { id: "s03", text: "{name} returns." },
  { id: "s04", text: "Here's your studio, {name}." },
  { id: "s05", text: "Morning, {name}." },
  { id: "s06", text: "Back at it, {name}." },
  { id: "s07", text: "The floor is yours, {name}." },
  { id: "s08", text: "Ready when you are, {name}." },
  { id: "s09", text: "Let's get into it, {name}." },
  { id: "s10", text: "Today's read, {name}." },
  { id: "s11", text: "Where things stand, {name}." },
  { id: "s12", text: "Your studio at a glance, {name}." },
  { id: "s13", text: "Good to see you, {name}." },
  { id: "s14", text: "Picking up where you left off, {name}." },
  { id: "s15", text: "Everything in one place, {name}." },
  { id: "s16", text: "Here's the state of the studio, {name}." },
  { id: "s17", text: "Clear eyes, {name}." },
  { id: "s18", text: "What's moving today, {name}." },
  { id: "s19", text: "The short version, {name}." },
  { id: "s20", text: "Hello again, {name}." },
  { id: "s21", text: "You're all caught up, {name}." },
  { id: "s22", text: "Straight to it, {name}." },
  { id: "s23", text: "Here's the morning read, {name}." },
  { id: "s24", text: "{name}, here's your studio." },
  { id: "s25", text: "Signed in, {name}." },
  { id: "s26", text: "Let's take a look, {name}." },

  // Lighter greetings.
  { id: "w01", text: "The studio missed you, {name}." },
  { id: "w02", text: "{name}, reporting for duty." },
  { id: "w03", text: "Look who's back on the floor, {name}." },
  { id: "w04", text: "Coffee first, {name}. Then this." },
  { id: "w05", text: "Shoes off, {name}. Let's go." },
  { id: "w06", text: "{name}, the mats are swept." },
  { id: "w07", text: "Belt on, {name}." },
  { id: "w08", text: "Nothing's on fire, {name}. Probably." },
  { id: "w09", text: "Deep breath, {name}." },
  { id: "w10", text: "One roster, no surprises, {name}." },
  { id: "w11", text: "{name} takes the floor." },
  { id: "w12", text: "{name}, on deck." },
  { id: "w13", text: "Let's keep the streak going, {name}." },
  { id: "w14", text: "You run the studio, {name}. We'll run the numbers." },
  { id: "w15", text: "{name}, the spreadsheets have been handled." },
  { id: "w16", text: "The paperwork can wait, {name}. Mostly." },
  { id: "w17", text: "No forms to fill out, {name}. You're welcome." },
  { id: "w18", text: "{name}, the numbers behaved themselves." },
  { id: "w19", text: "Attendance waits for no one, {name}." },
  { id: "w20", text: "Ready stance, {name}." },
  { id: "w21", text: "{name}, the roster has thoughts." },
  { id: "w22", text: "Somebody's been busy, {name}." },
  { id: "w23", text: "Look sharp, {name}." },
  { id: "w24", text: "{name}, let's make it a clean one." },
  { id: "w25", text: "The hard part is already done, {name}." },
  { id: "w26", text: "{name}, your studio, summarized." },

  // Sunday.
  { id: "d-sun-1", text: "Happy Sunday, {name}.", weekday: 0 },
  { id: "d-sun-2", text: "Sunday, {name}. Quiet before the week.", weekday: 0 },
  { id: "d-sun-3", text: "Sunday reset, {name}.", weekday: 0 },
  { id: "d-sun-4", text: "Sunday. A quiet read before the week.", weekday: 0 },

  // Monday.
  { id: "d-mon-1", text: "Happy Monday, {name}.", weekday: 1 },
  { id: "d-mon-2", text: "Monday, {name}. Let's set the tone.", weekday: 1 },
  { id: "d-mon-3", text: "New week, {name}.", weekday: 1 },
  { id: "d-mon-4", text: "Monday reset, {name}.", weekday: 1 },
  { id: "d-mon-5", text: "Monday. The week is wide open.", weekday: 1 },

  // Tuesday.
  { id: "d-tue-1", text: "Happy Tuesday, {name}.", weekday: 2 },
  { id: "d-tue-2", text: "Tuesday, {name}. The week has momentum.", weekday: 2 },
  { id: "d-tue-3", text: "Tuesday and rolling, {name}.", weekday: 2 },
  { id: "d-tue-4", text: "Tuesday, already moving.", weekday: 2 },

  // Wednesday.
  { id: "d-wed-1", text: "Happy Wednesday, {name}.", weekday: 3 },
  { id: "d-wed-2", text: "Midweek check, {name}.", weekday: 3 },
  { id: "d-wed-3", text: "Wednesday, {name}. Halfway there.", weekday: 3 },
  { id: "d-wed-4", text: "Wednesday. Halfway there.", weekday: 3 },

  // Thursday.
  { id: "d-thu-1", text: "Happy Thursday, {name}.", weekday: 4 },
  { id: "d-thu-2", text: "Thursday, {name}. Home stretch.", weekday: 4 },
  { id: "d-thu-3", text: "Thursday, {name}. Almost the weekend.", weekday: 4 },
  { id: "d-thu-4", text: "Thursday. The home stretch.", weekday: 4 },

  // Friday.
  { id: "d-fri-1", text: "Happy Friday, {name}.", weekday: 5 },
  { id: "d-fri-2", text: "Friday, {name}. Let's land it clean.", weekday: 5 },
  { id: "d-fri-3", text: "Friday, {name}. Close it out strong.", weekday: 5 },
  { id: "d-fri-4", text: "Made it to Friday, {name}.", weekday: 5 },
  { id: "d-fri-5", text: "Friday. Let's close it out clean.", weekday: 5 },

  // Saturday.
  { id: "d-sat-1", text: "Happy Saturday, {name}.", weekday: 6 },
  { id: "d-sat-2", text: "Saturday classes, {name}.", weekday: 6 },
  { id: "d-sat-3", text: "Saturday, {name}. The busy one.", weekday: 6 },
  { id: "d-sat-4", text: "Saturday. The busy one.", weekday: 6 },
];

const FALLBACK_GREETING = "Welcome back.";
const MAX_FIRST_NAME_LENGTH = 24;

/**
 * Pulls a display-safe first name out of a stored profile name. Returns `null`
 * when nothing usable is left, which keeps the greeting pool on nameless copy.
 */
export function resolveDashboardOwnerFirstName(rawName: string | null | undefined): string | null {
  if (typeof rawName !== "string") {
    return null;
  }

  const firstToken = rawName.trim().split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.'-]+$/gu, "");
  if (!cleaned || cleaned.length > MAX_FIRST_NAME_LENGTH || cleaned.includes("@")) {
    return null;
  }

  return cleaned;
}

function resolveWeekday(dateKey: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }

  const parsed = new Date(`${dateKey}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getDay();
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/**
 * Picks one greeting deterministically: the same owner on the same day always
 * gets the same heading, while different owners on that day usually differ.
 */
export function selectDashboardBriefGreeting({
  dateKey,
  ownerName,
  seedKey,
}: {
  dateKey: string;
  ownerName: string | null | undefined;
  seedKey: string | null | undefined;
}): string {
  const firstName = resolveDashboardOwnerFirstName(ownerName);
  const weekday = resolveWeekday(dateKey);
  const pool = DASHBOARD_BRIEF_GREETINGS.filter((greeting) => {
    if (greeting.weekday !== undefined && greeting.weekday !== weekday) {
      return false;
    }

    // Greet owners by name whenever we have one; the nameless copy is the fallback pool.
    return greeting.text.includes(NAME_TOKEN) === (firstName !== null);
  });

  if (pool.length === 0) {
    return FALLBACK_GREETING;
  }

  const seed = `${seedKey || firstName || "koaryu"}|${dateKey}`;
  const greeting = pool[hashSeed(seed) % pool.length];

  return firstName === null
    ? greeting.text
    : greeting.text.replaceAll(NAME_TOKEN, firstName);
}
