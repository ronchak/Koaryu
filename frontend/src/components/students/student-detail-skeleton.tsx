import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import styles from "./student-records.module.css";

const SECTION_ROWS = [3, 3, 4];

function Bar({ className }: { className: string }) {
  return (
    <span aria-hidden="true" className={`block rounded-full bg-surface-raised ${className}`} />
  );
}

// A record opened without any loaded roster row (a deep link or a reload) draws
// this once, in the same header, grid and cards the record uses, so the record
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
      <Header title={<Bar className="koaryu-skeleton-reveal mt-1.5 h-4 w-44" />}>
        <Button variant="ghost" size="sm" onClick={onBackToStudents}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to students
        </Button>
        <Button variant="secondary" size="sm" disabled>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
        {canManageRoster ? (
          <Button variant="danger" size="sm" disabled>
            <Trash2 className="w-3.5 h-3.5" />
            Archive
          </Button>
        ) : null}
      </Header>
      <StudentDetailBodySkeleton />
    </div>
  );
}

export function StudentDetailBodySkeleton() {
  return (
    <>
      <p className="sr-only" role="status">
        Loading student
      </p>
      <div className="koaryu-skeleton-reveal flex-1 p-4 sm:p-6 lg:p-8" aria-hidden="true">
        <div
          className={`grid grid-cols-1 gap-6 lg:grid-cols-[minmax(14rem,0.34fr)_minmax(0,1fr)] ${styles.folioGrid}`}
        >
          <aside className={`col-span-1 min-w-0 space-y-4 ${styles.identityRail}`}>
            <div className="flex flex-col items-center gap-2.5 rounded-[14px] bg-surface p-4 shadow-[var(--product-shadow-card)]">
              <span className="mb-1 block h-16 w-16 rounded-full bg-surface-raised" />
              <Bar className="h-3.5 w-32" />
              <Bar className="h-5 w-16" />
              <Bar className="mt-2 h-7 w-20" />
            </div>
            <div className="space-y-3 rounded-[14px] bg-surface p-4 shadow-[var(--product-shadow-card)]">
              <Bar className="h-3 w-full" />
              <Bar className="h-3 w-3/4" />
            </div>
          </aside>
          <div className="min-w-0 space-y-4">
            {SECTION_ROWS.map((rows, section) => (
              <section key={section} className={`${styles.folioSection} p-4`}>
                <Bar className="h-2.5 w-16" />
                <Bar className="mb-4 mt-2 h-3.5 w-40" />
                {Array.from({ length: rows }, (_, row) => (
                  <div
                    key={row}
                    className="flex items-center gap-4 border-b border-border py-2.5 last:border-0"
                  >
                    <Bar className="h-3 w-24 sm:w-36" />
                    <Bar className="h-3 w-40" />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
