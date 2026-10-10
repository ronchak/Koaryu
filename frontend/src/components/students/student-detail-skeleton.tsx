import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { HorizonPage } from "@/components/ui/horizon";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import styles from "./student-records.module.css";

const MAIN_PANEL_ROWS = [3, 4];
const SIDE_PANEL_ROWS = [3, 2];

function Bar({ className }: { className: string }) {
  return (
    <span aria-hidden="true" className={`block rounded-full bg-surface-raised ${className}`} />
  );
}

function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <section className={styles.skeletonPanel}>
      <Bar className="mb-4 h-3.5 w-32" />
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 py-2.5">
          <Bar className="h-3 w-20 sm:w-28" />
          <Bar className="h-3 w-40" />
        </div>
      ))}
    </section>
  );
}

// A record opened without any loaded roster row (a deep link or a reload) draws
// this once, in the same header, band and panels the record uses, so the record
// replaces it without moving.
export function StudentDetailSkeleton({
  canManageRoster,
  onBackToStudents,
}: {
  canManageRoster: boolean;
  onBackToStudents: () => void;
}) {
  return (
    <div className={`flex min-h-full flex-col ${styles.folioRoot}`} aria-busy="true">
      <Header
        eyebrow="Student"
        title={<Bar className="koaryu-skeleton-reveal mt-1.5 h-7 w-56" />}
        description={<Bar className="koaryu-skeleton-reveal mt-1 h-3 w-48" />}
      >
        <Button variant="secondary" onClick={onBackToStudents}>
          <ArrowLeft aria-hidden="true" className="w-4 h-4" />
          <span>
            Back<span className="max-sm:sr-only"> to students</span>
          </span>
        </Button>
        {canManageRoster ? (
          <Button variant="secondary" disabled>
            <Trash2 aria-hidden="true" className="w-4 h-4" />
            Archive
          </Button>
        ) : null}
        <Button variant="primary" disabled>
          <Pencil aria-hidden="true" className="w-4 h-4" />
          Edit
        </Button>
      </Header>
      <HorizonPage className={`flex-1 ${styles.folioPage}`}>
        <StudentDetailBodySkeleton />
      </HorizonPage>
    </div>
  );
}

export function StudentDetailBodySkeleton() {
  return (
    <>
      <p className="sr-only" role="status">
        Loading student
      </p>
      <div className={`koaryu-skeleton-reveal ${styles.folioSkeletonBody}`} aria-hidden="true">
        <div className={styles.identityBand}>
          <div className={styles.identityWho}>
            <span className="block h-20 w-20 flex-none rounded-full bg-surface-raised" />
            <div className="grid gap-2.5">
              <Bar className="h-4 w-40" />
              <Bar className="h-5 w-24" />
              <Bar className="h-7 w-28" />
            </div>
          </div>
          <div className={styles.identityFacts}>
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className={styles.identityFact}>
                <Bar className="h-3 w-16" />
                <Bar className="mt-2 h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
        <div className={`${styles.folioColumns} mt-5`}>
          <div className={styles.folioMain}>
            {MAIN_PANEL_ROWS.map((rows, index) => (
              <PanelSkeleton key={index} rows={rows} />
            ))}
          </div>
          <div className={styles.folioSide}>
            {SIDE_PANEL_ROWS.map((rows, index) => (
              <PanelSkeleton key={index} rows={rows} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
