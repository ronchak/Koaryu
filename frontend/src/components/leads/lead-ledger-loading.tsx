import styles from "./leads-ledger.module.css";

const LEDGER_LOADING_ROWS = 6;

function LeadLedgerIntroLoading() {
  return (
    <div className={styles.intro}>
      <dl className={styles.totals} aria-hidden="true">
        <div><dt>Overdue</dt><dd>—</dd></div>
        <div><dt>Due today</dt><dd>—</dd></div>
        <div><dt>Unassigned</dt><dd>—</dd></div>
      </dl>
    </div>
  );
}

export function LeadLedgerLoading() {
  return (
    <section className={styles.workspace} aria-label="Loading lead follow-up obligations" role="status">
      <LeadLedgerIntroLoading />
      <p className="sr-only">Loading follow-up obligations…</p>
      <div className={styles.stateFrame} aria-hidden="true">
        <div className={styles.stateHeader}>
          {Array.from({ length: 6 }).map((_, index) => <span key={index} className={styles.stateBar} />)}
        </div>
        {Array.from({ length: LEDGER_LOADING_ROWS }).map((_, row) => (
          <div key={row} className={styles.stateRow}>
            {Array.from({ length: 6 }).map((__, column) => <span key={column} className={styles.stateBar} />)}
          </div>
        ))}
      </div>
    </section>
  );
}

