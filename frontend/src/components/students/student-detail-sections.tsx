import { StudentRankBadge, type StudentRankWithContext } from "@/components/students/student-rank-badge";
import type { Promotion, Student } from "@/types";
import { Award, Mail, Phone, User } from "lucide-react";

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
  const hasHoldDetails =
    student.hold_start_date || student.hold_end_date || student.status === "paused";

  return (
    <div className="col-span-1 min-w-0 space-y-4 lg:col-span-2">
      <section className="bg-surface border border-border rounded-[6px] p-5">
        <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
          <Mail className="w-3.5 h-3.5 text-muted" />
          Contact Information
        </h3>
        <InfoRow label="Email" value={student.email} />
        <InfoRow label="Phone" value={student.phone} />
        <InfoRow
          label="Address"
          value={
            [student.address_line1, student.address_city, student.address_state]
              .filter(Boolean)
              .join(", ") || undefined
          }
        />
      </section>

      <section className="bg-surface border border-border rounded-[6px] p-5">
        <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
          <Award className="w-3.5 h-3.5 text-muted" />
          Belt & Promotion History
        </h3>

        {beltLoadError ? (
          <p className="text-sm text-warning">{beltLoadError}</p>
        ) : isLoadingBeltData ? (
          <p className="text-sm text-text-secondary">Loading belt and promotion history…</p>
        ) : promotionHistory.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              No promotion history has been recorded yet.
            </p>
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
                </span>
                {" "}on the {currentRank.ladderName} ladder.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {promotionHistory.map((promotion) => {
              const fromRank = promotion.from_rank_id
                ? rankById.get(promotion.from_rank_id)
                : undefined;
              const toRank = rankById.get(promotion.to_rank_id);

              return (
                <div
                  key={promotion.id}
                  className="rounded-[6px] border border-border bg-surface-raised/40 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        {fromRank ? (
                          <StudentRankBadge
                            name={promotion.from_rank_name || fromRank.name}
                            colorHex={fromRank.color_hex}
                            isTip={fromRank.is_tip}
                            tipColorHex={fromRank.tip_color_hex ?? undefined}
                          />
                        ) : (
                          <span className="text-xs text-muted">Unranked</span>
                        )}
                        <span className="text-xs text-muted">→</span>
                        {toRank ? (
                          <StudentRankBadge
                            name={promotion.to_rank_name || toRank.name}
                            colorHex={toRank.color_hex}
                            isTip={toRank.is_tip}
                            tipColorHex={toRank.tip_color_hex ?? undefined}
                          />
                        ) : (
                          <span className="text-xs text-text-primary">
                            {promotion.to_rank_name || "Rank updated"}
                          </span>
                        )}
                      </div>
                      {promotion.notes ? (
                        <p className="text-sm text-text-secondary leading-relaxed">
                          {promotion.notes}
                        </p>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted font-mono">
                      {formatDateTime(promotion.promoted_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="bg-surface border border-border rounded-[6px] p-5">
        <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
          <Phone className="w-3.5 h-3.5 text-muted" />
          Emergency Contact
        </h3>
        <InfoRow label="Name" value={student.emergency_contact_name} />
        <InfoRow label="Phone" value={student.emergency_contact_phone} />
        <InfoRow label="Relation" value={student.emergency_contact_relation} />
      </section>

      {hasHoldDetails ? (
        <section className="bg-surface border border-border rounded-[6px] p-5">
          <h3 className="text-sm font-medium text-text-primary mb-4">Hold / Vacation</h3>
          <InfoRow
            label="Status"
            value={isCurrentHold ? "Currently on hold" : "Hold scheduled / ended"}
          />
          <InfoRow
            label="Hold start"
            value={student.hold_start_date ? formatDate(student.hold_start_date) : undefined}
          />
          <InfoRow
            label="Hold end"
            value={student.hold_end_date ? formatDate(student.hold_end_date) : "Open-ended"}
          />
        </section>
      ) : null}

      {student.is_minor && primaryGuardian ? (
        <section className="bg-surface border border-border rounded-[6px] p-5">
          <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
            <User className="w-3.5 h-3.5 text-muted" />
            Primary Guardian
          </h3>
          <InfoRow
            label="Name"
            value={`${primaryGuardian.first_name} ${primaryGuardian.last_name}`}
          />
          <InfoRow label="Email" value={primaryGuardian.email} />
          <InfoRow label="Phone" value={primaryGuardian.phone} />
          <InfoRow label="Relation" value={primaryGuardian.relation} />
        </section>
      ) : null}

      {student.notes ? (
        <section className="bg-surface border border-border rounded-[6px] p-5">
          <h3 className="text-sm font-medium text-text-primary mb-3">Notes</h3>
          <p className="text-sm text-text-secondary leading-relaxed">{student.notes}</p>
        </section>
      ) : null}
    </div>
  );
}
