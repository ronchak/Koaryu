import type { CSSProperties } from "react";
import { ArrowRight, Award } from "lucide-react";
import {
  CalmState,
  HorizonPanel,
  HorizonPanelLink,
  HorizonWorkList,
  HorizonWorkRow,
} from "@/components/ui/horizon";
import {
  HOME_COPY,
  homeBeltName,
  homeBeltPairLabel,
  homePromotionMeta,
} from "@/lib/dashboard/home-copy";
import { HOME_LINKS, type HomeBelt, type HomePromotionRow } from "@/lib/dashboard/home-model";
import styles from "./home.module.css";

function BeltSwatch({ belt }: { belt: HomeBelt | null }) {
  return (
    <span
      className={styles.swatch}
      data-empty={belt ? undefined : "true"}
      // The rank's own colour is a data colour from the payload.
      style={belt?.color ? ({ "--belt": belt.color } as CSSProperties) : undefined}
    />
  );
}

/** Swatch, name, arrow, swatch, name; read aloud as "White to Yellow". */
function BeltPair({ row }: { row: HomePromotionRow }) {
  return (
    <>
      <span className="sr-only">{homeBeltPairLabel(row)}</span>
      <span className={styles.beltPair} aria-hidden="true">
        <BeltSwatch belt={row.from} />
        {homeBeltName(row.from)}
        <ArrowRight />
        <BeltSwatch belt={row.to} />
        {homeBeltName(row.to)}
      </span>
    </>
  );
}

/** Students eligible for their next belt; each row opens the student (D4). Null rows: couldn't check. */
export function ReadyToPromotePanel({ rows }: { rows: readonly HomePromotionRow[] | null }) {
  const copy = HOME_COPY.promotions;
  return (
    <HorizonPanel
      title={copy.title}
      titleId="home-promotions-title"
      actions={<HorizonPanelLink href={HOME_LINKS.beltTrackerReady}>{copy.link}</HorizonPanelLink>}
    >
      {rows === null ? (
        <CalmState tone="neutral" title={copy.missing.title} />
      ) : rows.length === 0 ? (
        <CalmState
          tone="neutral"
          icon={<Award aria-hidden="true" />}
          title={copy.empty.title}
          detail={copy.empty.detail}
        />
      ) : (
        <HorizonWorkList>
          {rows.map((row) => (
            <HorizonWorkRow
              key={row.studentId}
              data-home-row={row.studentId}
              href={row.href}
              title={row.name}
              tag={row.needsApproval ? { label: copy.tag.approval, tone: "warn" } : undefined}
              meta={
                <span className={styles.belts}>
                  <BeltPair row={row} />
                  <span>{homePromotionMeta(row)}</span>
                </span>
              }
            />
          ))}
        </HorizonWorkList>
      )}
    </HorizonPanel>
  );
}
