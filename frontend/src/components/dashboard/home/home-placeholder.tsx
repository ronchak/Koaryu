import { HorizonPage, HorizonPanel, HorizonStats } from "@/components/ui/horizon";
import { HOME_COPY } from "@/lib/dashboard/home-copy";
import type { HomeStatId } from "@/lib/dashboard/home-model";
import styles from "./home.module.css";

const PLACEHOLDER_ROWS = [0, 1, 2] as const;

function PlaceholderRows({ leading }: { leading: "chip" | "time" }) {
  return (
    <ul className={styles.placeholderRows}>
      {PLACEHOLDER_ROWS.map((index) => (
        <li key={index} className={styles.placeholderRow}>
          <span className={styles.placeholderLeading} data-kind={leading} />
          <span className={styles.placeholderLines}>
            <span className={styles.placeholderLine} />
            <span className={styles.placeholderLine} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Cold load: the three bands with their real titles, revealed after 220ms so a
 * fast payload never flashes them. No status text in the panels; one hidden
 * status line says what is happening. The whole page flips to ready at once.
 */
export function HomePlaceholder({ statIds }: { statIds: readonly HomeStatId[] }) {
  return (
    <HorizonPage>
      <HorizonStats
        data-home-placeholder="stats"
        className="koaryu-skeleton-reveal"
        label={HOME_COPY.stats.label}
        items={statIds.map((id) => ({
          id,
          label: HOME_COPY.stats[id].label,
          pending: true,
          note: <span className={styles.placeholderNote} aria-hidden="true" />,
        }))}
      />
      <div className={`${styles.bands} koaryu-skeleton-reveal`} aria-hidden="true">
        <div data-home-placeholder="attention">
          <HorizonPanel title={HOME_COPY.attention.title}>
            <PlaceholderRows leading="chip" />
          </HorizonPanel>
        </div>
        <div data-home-placeholder="classes">
          <HorizonPanel title={HOME_COPY.agenda.title}>
            <PlaceholderRows leading="time" />
          </HorizonPanel>
        </div>
      </div>
      <p className="sr-only" role="status">
        {HOME_COPY.loading.status}
      </p>
    </HorizonPage>
  );
}
