import { StudentRankBadge, type StudentRankWithContext } from "@/components/students/student-rank-badge";
import type { Promotion, Student } from "@/types";
import styles from "./student-records.module.css";

interface StudentDetailSectionsProps {
  student: Student;
  primaryGuardian?: Student["guardians"][number];
  currentRank?: StudentRankWithContext;
  promotionHistory: Promotion[];
  rankById: Map<string, StudentRankWithContext>;
  isCurrentHold: boolean;
  isLoadingBeltData: boolean;
  beltLoadError: string | null;
}

function formatDate(d?: string | null) {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 border-b border-border py-2.5 last:border-0 sm:flex-row sm:gap-4">
      <span className="w-auto flex-shrink-0 pt-0.5 text-xs text-muted sm:w-36">{label}</span>
      <span className="min-w-0 break-words font-mono text-sm text-text-primary [overflow-wrap:anywhere]">{value || "—"}</span>
    </div>
  );
}

function FolioLeaf({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${styles.folioSection} p-5`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{eyebrow}</p>
      <h3 className="mb-4 mt-1 text-sm font-semibold text-text-primary">{title}</h3>
      {children}
    </section>
  );
}

export function StudentDetailSections({
  student,
  primaryGuardian,
  currentRank,
  promotionHistory,
  rankById,
  isCurrentHold,
  isLoadingBeltData,
  beltLoadError,
}: StudentDetailSectionsProps) {
  const hasHoldDetails = student.hold_start_date || student.hold_end_date || student.status === "paused";
  const address = [
    student.address_line1,
    [student.address_city, student.address_state, student.address_zip].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");

  return (
    <div className={`col-span-1 min-w-0 lg:col-span-1 ${styles.folioLeaves}`}>
      <FolioLeaf eyebrow="Contact" title="How to reach this student">
        <InfoRow label="Email" value={student.email} />
        <InfoRow label="Phone" value={student.phone} />
        <InfoRow label="Full address" value={address || undefined} />
      </FolioLeaf>

      <FolioLeaf eyebrow="Safety" title="Emergency contact">
        <InfoRow label="Name" value={student.emergency_contact_name} />
        <InfoRow label="Phone" value={student.emergency_contact_phone} />
        <InfoRow label="Relation" value={student.emergency_contact_relation} />
      </FolioLeaf>

      {hasHoldDetails ? (
        <FolioLeaf eyebrow="Lifecycle" title="Hold / vacation window">
          <InfoRow label="Status" value={isCurrentHold ? "Currently on hold" : "Hold scheduled / ended"} />
          <InfoRow label="Hold start" value={student.hold_start_date ? formatDate(student.hold_start_date) : undefined} />
          <InfoRow label="Hold end" value={student.hold_end_date ? formatDate(student.hold_end_date) : "Open-ended"} />
        </FolioLeaf>
      ) : null}

      {student.is_minor ? (
        <FolioLeaf eyebrow="Guardian" title="Primary guardian">
          {primaryGuardian ? (
            <>
              <InfoRow label="Name" value={`${primaryGuardian.first_name} ${primaryGuardian.last_name}`} />
              <InfoRow label="Email" value={primaryGuardian.email} />
              <InfoRow label="Phone" value={primaryGuardian.phone} />
              <InfoRow label="Relation" value={primaryGuardian.relation} />
            </>
          ) : (
            <p className="text-sm text-warning">This minor does not have a guardian record on file.</p>
          )}
        </FolioLeaf>
      ) : null}

      <FolioLeaf eyebrow="Training record" title="Immutable promotion history">
        <p className="mb-4 max-w-2xl text-xs leading-relaxed text-muted">
          Promotions are chronological record entries. Profile edits do not rewrite or remove this history.
        </p>
        {beltLoadError ? (
          <p className="text-sm text-warning">{beltLoadError}</p>
        ) : isLoadingBeltData ? (
          <p className="text-sm text-text-secondary">Loading belt and promotion history…</p>
        ) : promotionHistory.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">No promotion history has been recorded yet.</p>
            {currentRank ? (
              <p className="text-xs text-muted">
                Current rank is still tracked as{" "}
                <span className="inline-flex align-middle">
                  <StudentRankBadge
                    name={currentRank.name}
                    colorHex={currentRank.color_hex}
                    isTip={currentRank.is_tip}
                    tipColorHex={currentRank.tip_color_hex ?? undefined}
                  />
                </span>{" "}
                on the {currentRank.ladderName} ladder.
              </p>
            ) : null}
          </div>
        ) : (
          <ol className="space-y-4">
            {promotionHistory.map((promotion) => {
              const fromRank = promotion.from_rank_id ? rankById.get(promotion.from_rank_id) : undefined;
              const toRank = promotion.to_rank_id ? rankById.get(promotion.to_rank_id) : undefined;

              return (
                <li key={promotion.id} className={`${styles.historyEntry} py-3`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {fromRank ? (
                          <StudentRankBadge
                            name={promotion.from_rank_name || fromRank.name}
                            colorHex={fromRank.color_hex}
                            isTip={fromRank.is_tip}
                            tipColorHex={fromRank.tip_color_hex ?? undefined}
                          />
                        ) : promotion.from_rank_name ? (
                          <span className="text-xs text-text-primary">{promotion.from_rank_name}</span>
                        ) : (
                          <span className="text-xs text-muted">Unranked</span>
                        )}
                        <span aria-hidden="true" className="text-xs text-muted">→</span>
                        <span className="sr-only">to</span>
                        {toRank ? (
                          <StudentRankBadge
                            name={promotion.to_rank_name || toRank.name}
                            colorHex={toRank.color_hex}
                            isTip={toRank.is_tip}
                            tipColorHex={toRank.tip_color_hex ?? undefined}
                          />
                        ) : (
                          <span className="text-xs text-text-primary">{promotion.to_rank_name || "Rank updated"}</span>
                        )}
                      </div>
                      {promotion.notes ? <p className="text-sm leading-relaxed text-text-secondary">{promotion.notes}</p> : null}
                    </div>
                    <time className="font-mono text-xs text-muted" dateTime={promotion.promoted_at}>
                      {formatDateTime(promotion.promoted_at)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </FolioLeaf>

      {student.notes ? (
        <FolioLeaf eyebrow="Staff notes" title="Record notes">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{student.notes}</p>
        </FolioLeaf>
      ) : null}
    </div>
  );
}
