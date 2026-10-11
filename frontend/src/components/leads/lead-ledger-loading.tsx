import { LEAD_AGE_BANDS } from "@/lib/leads-age-bands";
import styles from "./leads-ledger.module.css";

/*
 * The queue while the roster loads: the first two bands with rows in the loaded
 * shape. The strip above it (`LeadStageStripPlaceholder`) opens the page on the
 * header's ridge, so the page renders it there.
 */
export function LeadLedgerLoading({ canManageLeads = true }: { canManageLeads?: boolean }) {
  return (
    <section
      className={`${styles.workspace} koaryu-skeleton-reveal`}
      aria-label="Loading lead follow-up obligations"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="sr-only">Loading follow-up obligations.</p>
      <div className={styles.ageQueue} aria-hidden="true">
        {LEAD_AGE_BANDS.slice(0, 2).map((band) => (
          <section key={band.id} className={styles.ageBand} data-age-band={band.id}>
            <header>
              <h2>{band.label}</h2>
              <span>—</span>
            </header>
            <ol>
              {Array.from({ length: 3 }).map((_, row) => (
                <li key={row}>
                  <span className={styles.leadInitials} />
                  <span className={styles.queueLead}>
                    <span className={`${styles.stateBar} w-3/4`} />
                  </span>
                  <span className={styles.queueAction}>
                    <span className={`${styles.stateBar} w-3/4`} />
                  </span>
                  <span className={styles.queueContext}>
                    <span className={`${styles.stateBar} ${styles.leadStage} w-1/2`} />
                    <span className={`${styles.stateBar} ${styles.leadOwner} w-1/2`} />
                  </span>
                  {canManageLeads ? (
                    <div className={styles.stageMoves}>
                      <span className={styles.stageMovePlaceholder} data-move="previous" />
                      <span className={styles.stageMovePlaceholder} data-move="next" />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
