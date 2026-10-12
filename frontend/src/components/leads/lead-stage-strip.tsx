import { PIPELINE_STAGES } from "@/lib/leads-page-model";
import type { Lead } from "@/types";
import { getLeadFigures, isSameLeadFocus, type LeadFocus } from "./lead-focus";
import styles from "./leads-ledger.module.css";

/*
 * The strip that opens Leads, on the header's ridge: the four open stages and the
 * leads nobody owns, each a filter on the queue below. Enrolled is left out: the
 * header sentence counts it and enrolled leads keep their rows in "Nothing due".
 */
const STRIP_STAGES = PIPELINE_STAGES.filter((stage) => stage.id !== "enrolled");
const NO_OWNER: LeadFocus = { kind: "unassigned" };

type StripTile = { key: string; label: string; focus: LeadFocus; count: number };

function stripTiles(leads: Lead[], today: string): StripTile[] {
  return [
    ...STRIP_STAGES.map((stage) => ({
      key: stage.id,
      label: stage.label,
      focus: { kind: "stage", stage: stage.id } as LeadFocus,
      count: leads.filter((lead) => lead.stage === stage.id).length,
    })),
    {
      key: "unassigned",
      label: "No owner",
      focus: NO_OWNER,
      count: getLeadFigures(leads, today).unassigned,
    },
  ];
}

export function LeadStageStrip({
  focus,
  leads,
  onFocusChange,
  today,
}: {
  focus: LeadFocus | null;
  leads: Lead[];
  onFocusChange: (focus: LeadFocus | null) => void;
  today: string;
}) {
  return (
    <ol className={styles.stageRail} aria-label="Lead stages">
      {stripTiles(leads, today).map((tile) => {
        const active = isSameLeadFocus(focus, tile.focus);
        return (
          <li
            key={tile.key}
            data-stage={tile.focus.kind === "stage" ? tile.focus.stage : undefined}
            data-focus={tile.focus.kind === "stage" ? undefined : tile.focus.kind}
            data-empty={tile.count === 0 || undefined}
          >
            <button
              type="button"
              className={styles.stageButton}
              aria-pressed={active}
              aria-label={`${tile.label}: ${tile.count} ${tile.count === 1 ? "lead" : "leads"}`}
              onClick={() => onFocusChange(active ? null : tile.focus)}
            >
              <strong>{tile.label}</strong>
              <b>{tile.count}</b>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The same strip while the roster loads: the tiles hold their place, with no numbers yet. */
export function LeadStageStripPlaceholder() {
  return (
    <ol className={styles.stageRail} aria-hidden="true">
      {[...STRIP_STAGES.map((stage) => stage.label), "No owner"].map((label) => (
        <li key={label}>
          <span className={styles.stageButton}>
            <strong>{label}</strong>
            <b>—</b>
          </span>
        </li>
      ))}
    </ol>
  );
}
