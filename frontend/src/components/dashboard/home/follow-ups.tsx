import { Check } from "lucide-react";
import {
  CalmState,
  HorizonPanel,
  HorizonPanelLink,
  HorizonWorkList,
  HorizonWorkRow,
} from "@/components/ui/horizon";
import { HOME_COPY, homeFollowUpNextStep, homeFollowUpTag } from "@/lib/dashboard/home-copy";
import { HOME_LINKS, type HomeFollowUpRow } from "@/lib/dashboard/home-model";

/** Leads due today or overdue, oldest first; each row opens that lead (D4). Null rows: couldn't check. */
export function FollowUpsPanel({ rows }: { rows: readonly HomeFollowUpRow[] | null }) {
  const copy = HOME_COPY.followUps;
  return (
    <HorizonPanel
      title={copy.title}
      titleId="home-follow-ups-title"
      actions={<HorizonPanelLink href={HOME_LINKS.leads}>{copy.link}</HorizonPanelLink>}
    >
      {rows === null ? (
        <CalmState tone="neutral" title={copy.missing.title} />
      ) : rows.length === 0 ? (
        <CalmState
          tone="calm"
          icon={<Check aria-hidden="true" />}
          title={copy.empty.title}
          detail={copy.empty.detail}
        />
      ) : (
        <HorizonWorkList>
          {rows.map((row) => (
            <HorizonWorkRow
              key={row.id}
              data-home-row={row.id}
              href={row.href}
              title={row.name}
              tag={homeFollowUpTag(row.due)}
              meta={homeFollowUpNextStep(row.stage)}
            />
          ))}
        </HorizonWorkList>
      )}
    </HorizonPanel>
  );
}
