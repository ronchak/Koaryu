import { PIPELINE_STAGES } from "@/lib/leads-page-model";
import { LEAD_AGE_BANDS } from "@/lib/leads-age-bands";
import styles from "./leads-ledger.module.css";

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
      <div className={styles.intro} aria-hidden="true">
        <dl className={styles.totals}>
          {["Overdue", "Due today", "Unassigned"].map((label) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>—</dd>
            </div>
          ))}
        </dl>
      </div>
      <ol className={styles.stageRail} aria-hidden="true">
        {PIPELINE_STAGES.map((stage) => (
          <li key={stage.id}>
            <strong>{stage.label}</strong>
            <b>—</b>
          </li>
        ))}
      </ol>
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
                  <div className={styles.queueLead}>
                    <div className={`${styles.stateBar} w-3/4`} />
                    <div className={`${styles.stateBar} mt-1 w-1/2`} />
                  </div>
                  <div className={styles.queueAction}>
                    <div className={`${styles.stateBar} w-3/4`} />
                    <div className={`${styles.stateBar} mt-1 w-1/2`} />
                  </div>
                  <div className={styles.queueContext}>
                    <div className={`${styles.stateBar} w-3/4`} />
                    <div className={`${styles.stateBar} mt-1 w-1/2`} />
                  </div>
                  {canManageLeads ? (
                    <div className={styles.stageMoves}>
                      <div className="h-11 w-11 rounded-[6px] bg-surface-raised" />
                      <div className="h-11 w-11 rounded-[6px] bg-surface-raised" />
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
