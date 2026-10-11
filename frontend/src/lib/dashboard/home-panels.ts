import {
  HOME_LINKS,
  HOME_STAT_ORDER,
  type HomeRole,
  type HomeStat,
  type HomeStatId,
} from "./home-model.ts";

/*
 * What Home lays out for a role: the stats strip's slots and the optional
 * panels under the bands. The three bands themselves are fixed and always
 * shown. A slot the role has but the payload lacks means the server couldn't
 * compute it ("Couldn't check"); a slot the role doesn't have is simply absent.
 * Pure, so Node tests import it directly.
 */

// D1: who sees each stat. The model decides from the payload; the loading
// placeholder uses this to reserve the right slots before the payload lands.
export const HOME_STAT_ROLES = {
  followUps: ["admin", "front_desk"],
  promotions: ["admin", "instructor"],
  activeStudents: ["admin", "front_desk", "instructor"],
  attendance: ["admin", "front_desk", "instructor"],
} as const satisfies Record<HomeStatId, readonly HomeRole[]>;

/** The role's stats, left to right (D1). */
export function homeStatIdsForRole(role: HomeRole | null): HomeStatId[] {
  if (!role) return [];
  return HOME_STAT_ORDER.filter((id) =>
    (HOME_STAT_ROLES[id] as readonly HomeRole[]).includes(role),
  );
}

/** A stat the role has whose section the payload lacks: kept as a cell that says so. */
export type HomeMissingStat = { id: HomeStatId; missing: true; tone: "neutral"; href: string };
export type HomeStatCell = HomeStat | HomeMissingStat;

// Where each stat leads when its number is unknown: the view that explains it.
const HOME_STAT_LINKS = {
  followUps: HOME_LINKS.leads,
  promotions: HOME_LINKS.beltTrackerReady,
  activeStudents: HOME_LINKS.students,
  attendance: HOME_LINKS.reports,
} as const satisfies Record<HomeStatId, string>;

export function isHomeMissingStat(cell: HomeStatCell): cell is HomeMissingStat {
  return "missing" in cell && cell.missing === true;
}

/**
 * The strip's cells for a role, left to right: each stat the role has, from
 * the model when the payload carried it, else a missing cell. Without a role
 * the model's stats stand as they are.
 */
export function homeStatCells(
  role: HomeRole | null,
  stats: readonly HomeStat[] | null,
): HomeStatCell[] {
  if (!stats) return [];
  if (!role) return [...stats];
  return homeStatIdsForRole(role).map(
    (id) =>
      stats.find((stat) => stat.id === id) ?? {
        id,
        missing: true,
        tone: "neutral",
        href: HOME_STAT_LINKS[id],
      },
  );
}

// D4: optional panels in default order.
export const HOME_PANEL_IDS = ["followUps", "promotions", "newStudents"] as const;
export type HomePanelId = (typeof HOME_PANEL_IDS)[number];

export const HOME_PANEL_ROLES = {
  followUps: ["admin", "front_desk"],
  promotions: ["admin", "instructor"],
  newStudents: ["admin", "front_desk", "instructor"],
} as const satisfies Record<HomePanelId, readonly HomeRole[]>;

/** Off until the viewer turns it on in Edit Home (D4). */
export const HOME_PANEL_DEFAULT_HIDDEN: readonly HomePanelId[] = ["newStudents"];

/**
 * The optional panels Home shows, in order: the role's D4 defaults. A shown
 * panel whose section the payload lacks says it couldn't check, rather than
 * vanishing. Phase 4's saved preferences replace the defaults.
 */
export function defaultHomePanels(role: HomeRole | null): HomePanelId[] {
  if (!role) return [];
  return HOME_PANEL_IDS.filter(
    (id) =>
      (HOME_PANEL_ROLES[id] as readonly HomeRole[]).includes(role) &&
      !HOME_PANEL_DEFAULT_HIDDEN.includes(id),
  );
}
