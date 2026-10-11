import { Moon } from "lucide-react";
import {
  CalmState,
  HorizonPanel,
  HorizonPanelLink,
  HorizonWorkList,
  HorizonWorkRow,
} from "@/components/ui/horizon";
import {
  HOME_COPY,
  clock,
  homeAgendaMore,
  homeClassAction,
  homeClassCount,
} from "@/lib/dashboard/home-copy";
import { HOME_LINKS, type HomeAgenda } from "@/lib/dashboard/home-model";
import styles from "./home.module.css";

/**
 * Band three: today's agenda, each row opening Schedule on that class (D3).
 * `agenda` is null when the server couldn't compute it.
 */
export function TodaysClasses({ agenda }: { agenda: HomeAgenda | null }) {
  const copy = HOME_COPY.agenda;
  const isEmpty = agenda !== null && agenda.rows.length === 0 && agenda.overflow === null;
  return (
    <HorizonPanel
      title={copy.title}
      titleId="home-classes-title"
      actions={<HorizonPanelLink href={HOME_LINKS.schedule}>{copy.link}</HorizonPanelLink>}
    >
      {agenda === null ? (
        <CalmState tone="neutral" title={copy.missing.title} />
      ) : isEmpty ? (
        <CalmState
          tone="calm"
          icon={<Moon aria-hidden="true" />}
          title={copy.empty.title}
          detail={copy.empty.detail}
        />
      ) : (
        <>
          <HorizonWorkList>
            {agenda.rows.map((row) => {
              const count = homeClassCount(row);
              return (
                <HorizonWorkRow
                  key={row.id}
                  data-home-row={row.id}
                  href={row.href}
                  leading={<time dateTime={row.startTime}>{clock(row.startTime)}</time>}
                  title={row.name}
                  tag={count?.kind === "tag" ? { label: count.text, tone: count.tone } : undefined}
                  meta={count?.kind === "meta" ? count.text : undefined}
                  action={homeClassAction(row)}
                  emphasized={row.emphasized}
                />
              );
            })}
          </HorizonWorkList>
          {agenda.overflow ? (
            <div className={styles.more}>
              <HorizonPanelLink href={agenda.overflow.href}>
                {homeAgendaMore(agenda.overflow.count)}
              </HorizonPanelLink>
            </div>
          ) : null}
        </>
      )}
    </HorizonPanel>
  );
}
