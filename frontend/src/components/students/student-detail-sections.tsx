import type { ReactNode } from "react";
import { BeltSwatch } from "@/components/students/student-belt-swatch";
import {
  StudentRankBadge,
  type StudentRankWithContext,
} from "@/components/students/student-rank-badge";
import { Button } from "@/components/ui/button";
import { CalmState, HorizonPanel, ToneChip, type HorizonTone } from "@/components/ui/horizon";
import type { Promotion, Student } from "@/types";
import { phoneHref } from "@/lib/phone-link";
import {
  Award,
  CalendarClock,
  HeartPulse,
  Phone,
  ShieldAlert,
  Sparkles,
  UserRound,
} from "lucide-react";
import styles from "./student-records.module.css";

interface StudentDetailSectionsProps {
  student: Student;
  primaryGuardian?: Student["guardians"][number];
  currentRank?: StudentRankWithContext;
  promotionHistory: Promotion[];
  rankById: Map<string, StudentRankWithContext>;
  /** Holds are summarised on the identity band and in Next up. */
  isCurrentHold: boolean;
  isLoadingBeltData: boolean;
  beltLoadError: string | null;
  /** The person's open loose ends, drawn first. */
  lead?: ReactNode;
  /** Links beside the training record's title, such as the belt tracker. */
  recordActions?: ReactNode;
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

/** One labelled fact. Empty facts are left out; a whole empty panel says so once. */
function InfoRow({ label, value, href }: { label: string; value?: string | null; href?: string }) {
  if (!value) return null;
  return (
    <div className={styles.infoRow}>
      <dt>{label}</dt>
      <dd>
        {href ? (
          <a href={href} className={styles.infoLink}>
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function EditAction({
  children,
  disabled,
  onEdit,
}: {
  children: ReactNode;
  disabled?: boolean;
  onEdit?: () => void;
}) {
  if (!onEdit) return null;
  return (
    <Button variant="secondary" size="sm" onClick={onEdit} disabled={disabled}>
      {children}
    </Button>
  );
}

export type StudentNextStep = {
  id: string;
  tone: HorizonTone;
  icon: ReactNode;
  title: string;
  detail: string;
  action?: { kind: "edit"; label: string };
};

/** The few things worth doing for this person now, from facts already on the record. */
export function buildStudentNextSteps({
  isCurrentHold,
  primaryGuardian,
  student,
}: {
  isCurrentHold: boolean;
  primaryGuardian?: Student["guardians"][number];
  student: Student;
}): StudentNextStep[] {
  const steps: StudentNextStep[] = [];
  if (student.status === "inactive" || student.status === "canceled") {
    // Gaps in a former student's record can wait until they come back.
    return [
      {
        id: "returning",
        tone: "neutral",
        icon: <CalendarClock />,
        title: "Not training right now",
        detail: "If they come back, set their status to Active or Trial.",
        action: { kind: "edit", label: "Update status" },
      },
    ];
  }
  if (student.is_minor && !primaryGuardian) {
    steps.push({
      id: "guardian",
      tone: "alert",
      icon: <ShieldAlert />,
      title: "No guardian on file",
      detail: "Minors need a parent or guardian to contact.",
      action: { kind: "edit", label: "Add guardian" },
    });
  }
  if (!student.emergency_contact_name && !student.emergency_contact_phone) {
    steps.push({
      id: "emergency",
      tone: "warn",
      icon: <HeartPulse />,
      title: "No emergency contact",
      detail: "Add someone to call if something happens on the mat.",
      action: { kind: "edit", label: "Add contact" },
    });
  }
  const guardianReachable = Boolean(primaryGuardian?.email || primaryGuardian?.phone);
  if (!student.email && !student.phone && !guardianReachable) {
    steps.push({
      id: "reach",
      tone: "warn",
      icon: <Phone />,
      title: "No way to reach them",
      detail: "There is no email or phone for this student or a guardian.",
      action: { kind: "edit", label: "Add details" },
    });
  }
  if (student.status === "trialing") {
    steps.push({
      id: "trial",
      tone: "warn",
      icon: <Sparkles />,
      title: "On a trial",
      detail: "When they sign up, change their status to Active.",
      action: { kind: "edit", label: "Update status" },
    });
  }
  if (isCurrentHold) {
    steps.push({
      id: "hold",
      tone: "neutral",
      icon: <CalendarClock />,
      title: "On hold",
      detail:
        student.status === "paused"
          ? "Update their status and hold dates when they return."
          : student.hold_end_date
            ? `On hold through ${formatDate(student.hold_end_date)}.`
            : "No hold end date is set.",
      action: { kind: "edit", label: "Edit hold" },
    });
  }
  return steps;
}

export function StudentNextSteps({
  editDisabled,
  onEdit,
  steps,
}: {
  editDisabled?: boolean;
  onEdit?: () => void;
  steps: StudentNextStep[];
}) {
  return (
    <HorizonPanel title="Next up" titleId="student-next-up" flush={steps.length > 0}>
      {steps.length === 0 ? (
        <CalmState
          icon={<UserRound />}
          title="Nothing needs attention"
          detail="Contacts, family and belt are all on file."
        />
      ) : (
        <ul className={styles.nextSteps}>
          {steps.map((step) => (
            <li key={step.id} className={styles.nextStep}>
              <ToneChip tone={step.tone}>{step.icon}</ToneChip>
              <div className={styles.nextStepCopy}>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </div>
              {step.action ? (
                <EditAction onEdit={onEdit} disabled={editDisabled}>
                  {step.action.label}
                </EditAction>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </HorizonPanel>
  );
}

export function StudentDetailSections({
  student,
  primaryGuardian,
  currentRank,
  promotionHistory,
  rankById,
  isLoadingBeltData,
  beltLoadError,
  lead,
  recordActions,
}: StudentDetailSectionsProps) {
  const address = [
    student.address_line1,
    [student.address_city, student.address_state, student.address_zip].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const hasContact = Boolean(student.email || student.phone || address);
  const hasEmergency = Boolean(
    student.emergency_contact_name ||
    student.emergency_contact_phone ||
    student.emergency_contact_relation,
  );

  return (
    <div className={styles.folioColumns}>
      <div className={styles.folioMain}>
        {lead}

        <HorizonPanel
          title="Training record"
          titleId="student-training-record"
          description="Promotions in order. Profile edits never rewrite this history."
          actions={recordActions}
        >
          {beltLoadError ? (
            <p className="text-sm text-warning">{beltLoadError}</p>
          ) : isLoadingBeltData ? (
            <div
              role="status"
              aria-label="Loading promotion history"
              className="koaryu-skeleton-reveal space-y-2.5"
            >
              <span aria-hidden="true" className="block h-3 w-56 rounded-full bg-surface-raised" />
              <span aria-hidden="true" className="block h-3 w-40 rounded-full bg-surface-raised" />
            </div>
          ) : promotionHistory.length === 0 ? (
            <CalmState
              tone="neutral"
              icon={<Award />}
              title="No promotion history has been recorded yet."
              detail={
                currentRank
                  ? `Promotions from ${currentRank.name} onward will be listed here.`
                  : "Promotions recorded in the Belt tracker will be listed here."
              }
            />
          ) : (
            <ol className={styles.historyList}>
              {promotionHistory.map((promotion) => {
                const fromRank = promotion.from_rank_id
                  ? rankById.get(promotion.from_rank_id)
                  : undefined;
                const toRank = promotion.to_rank_id
                  ? rankById.get(promotion.to_rank_id)
                  : undefined;

                return (
                  <li key={promotion.id} className={styles.historyEntry}>
                    <BeltSwatch color={toRank?.color_hex} />
                    <div className={styles.historyCopy}>
                      <div className="flex flex-wrap items-center gap-2">
                        {fromRank ? (
                          <StudentRankBadge
                            name={promotion.from_rank_name || fromRank.name}
                            colorHex={fromRank.color_hex}
                            isTip={fromRank.is_tip}
                            tipColorHex={fromRank.tip_color_hex ?? undefined}
                          />
                        ) : promotion.from_rank_name ? (
                          <span className="text-sm text-text-primary">
                            {promotion.from_rank_name}
                          </span>
                        ) : (
                          <span className="text-sm text-muted">Unranked</span>
                        )}
                        <span aria-hidden="true" className="text-sm text-muted">
                          →
                        </span>
                        <span className="sr-only">to</span>
                        {toRank ? (
                          <StudentRankBadge
                            name={promotion.to_rank_name || toRank.name}
                            colorHex={toRank.color_hex}
                            isTip={toRank.is_tip}
                            tipColorHex={toRank.tip_color_hex ?? undefined}
                          />
                        ) : (
                          <span className="text-sm text-text-primary">
                            {promotion.to_rank_name || "Rank updated"}
                          </span>
                        )}
                      </div>
                      {promotion.notes ? (
                        <p className="text-sm leading-relaxed text-text-secondary">
                          {promotion.notes}
                        </p>
                      ) : null}
                    </div>
                    <time className={styles.historyDate} dateTime={promotion.promoted_at}>
                      {formatDateTime(promotion.promoted_at)}
                    </time>
                  </li>
                );
              })}
            </ol>
          )}
        </HorizonPanel>

        {student.notes ? (
          <HorizonPanel title="Staff notes" titleId="student-staff-notes">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
              {student.notes}
            </p>
          </HorizonPanel>
        ) : null}
      </div>

      <div className={styles.folioSide}>
        <HorizonPanel title="Contact" titleId="student-contact">
          {hasContact ? (
            <dl className={styles.infoList}>
              <InfoRow
                label="Email"
                value={student.email}
                href={student.email ? `mailto:${student.email}` : undefined}
              />
              <InfoRow
                label="Phone"
                value={student.phone}
                href={student.phone ? phoneHref(student.phone) : undefined}
              />
              <InfoRow label="Full address" value={address || undefined} />
            </dl>
          ) : (
            <p className={styles.panelQuiet}>
              {primaryGuardian
                ? "No direct contact. Reach them through their guardian."
                : "No email, phone or address on file."}
            </p>
          )}
        </HorizonPanel>

        {student.is_minor || primaryGuardian ? (
          <HorizonPanel title="Primary guardian" titleId="student-guardian">
            {primaryGuardian ? (
              <dl className={styles.infoList}>
                <InfoRow
                  label="Name"
                  value={`${primaryGuardian.first_name} ${primaryGuardian.last_name}`}
                />
                <InfoRow label="Relation" value={primaryGuardian.relation} />
                <InfoRow
                  label="Email"
                  value={primaryGuardian.email}
                  href={primaryGuardian.email ? `mailto:${primaryGuardian.email}` : undefined}
                />
                <InfoRow
                  label="Phone"
                  value={primaryGuardian.phone}
                  href={primaryGuardian.phone ? phoneHref(primaryGuardian.phone) : undefined}
                />
              </dl>
            ) : (
              <p className="text-sm text-warning">
                This minor does not have a guardian record on file.
              </p>
            )}
          </HorizonPanel>
        ) : null}

        <HorizonPanel title="Emergency contact" titleId="student-emergency">
          {hasEmergency ? (
            <dl className={styles.infoList}>
              <InfoRow label="Name" value={student.emergency_contact_name} />
              <InfoRow label="Relation" value={student.emergency_contact_relation} />
              <InfoRow
                label="Phone"
                value={student.emergency_contact_phone}
                href={
                  student.emergency_contact_phone
                    ? phoneHref(student.emergency_contact_phone)
                    : undefined
                }
              />
            </dl>
          ) : (
            <p className={styles.panelQuiet}>None on file yet.</p>
          )}
        </HorizonPanel>
      </div>
    </div>
  );
}
