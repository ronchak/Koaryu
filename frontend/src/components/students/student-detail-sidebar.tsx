"use client";

import { useRef, type ReactNode } from "react";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentAvatar } from "@/components/students/student-avatar";
import {
  StudentRankBadge,
  type StudentRankWithContext,
} from "@/components/students/student-rank-badge";
import { BeltSwatch } from "@/components/students/student-belt-swatch";
import { Button } from "@/components/ui/button";
import { ToneTag } from "@/components/ui/horizon";
import { calendarAge } from "@/lib/student-age";
import type { BeltRank, Program, Student } from "@/types";
import { Camera, X } from "lucide-react";
import styles from "./student-records.module.css";

type PhotoSelectResult = boolean | void | Promise<boolean | void>;

interface StudentDetailSidebarProps {
  canManageRoster: boolean;
  student: Student;
  fullName: string;
  programs: Program[];
  activeProgramIds: string[];
  photoPreviewUrl: string | null;
  photoError: string | null;
  isPhotoSaving: boolean;
  isCommandPending: boolean;
  onPhotoSelected: (file: File) => PhotoSelectResult;
  onDeletePhoto: () => Promise<void> | void;
  isCurrentHold: boolean;
  currentRank?: StudentRankWithContext;
  nextRank?: BeltRank;
  latestPromotionAt?: string | null;
  promotionCount: number;
  isLoadingBeltData: boolean;
  beltLoadError: string | null;
  businessDate: string;
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

function calculateAge(dob: string | null | undefined, businessDate: string): string {
  const age = calendarAge(dob, businessDate);
  return age === null ? "—" : `${age} yrs`;
}

/** How long someone has trained here, in words a front desk would say. */
function trainingFor(start: string | null | undefined, businessDate: string) {
  if (!start) return null;
  const from = new Date(`${start.slice(0, 10)}T00:00:00`);
  const to = new Date(`${businessDate}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  const months =
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth()) -
    (to.getDate() < from.getDate() ? 1 : 0);
  if (months < 1) return "Less than a month training";
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} training`;
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} training`;
}

// Belt facts arrive after the record; a placeholder holds each value's place and
// appears only if the read is slow, instead of flashing "Loading…" text.
function FactPlaceholder({ className, label }: { className: string; label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`koaryu-skeleton-reveal inline-block rounded-full bg-surface-raised align-middle ${className}`}
    />
  );
}

function Fact({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.identityFact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
      {note ? <dd className={styles.identityFactNote}>{note}</dd> : null}
    </div>
  );
}

/**
 * The person at a glance, on the header's ridge: photo, status, belt and the facts
 * staff ask about most. Kept under its historical name for the page and its tests.
 */
export function StudentDetailSidebar({
  canManageRoster,
  student,
  fullName,
  programs,
  activeProgramIds,
  photoPreviewUrl,
  photoError,
  isPhotoSaving,
  isCommandPending,
  onPhotoSelected,
  onDeletePhoto,
  isCurrentHold,
  currentRank,
  nextRank,
  latestPromotionAt,
  promotionCount,
  isLoadingBeltData,
  beltLoadError,
  businessDate,
}: StudentDetailSidebarProps) {
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const beltFactsLoading = isLoadingBeltData && !beltLoadError;
  const beltFactsUnavailable = Boolean(beltLoadError);
  const activePrograms = activeProgramIds
    .map((programId) => programs.find((item) => item.id === programId))
    .filter((program): program is Program => Boolean(program));
  const tenure = trainingFor(student.membership_start_date, businessDate);

  return (
    <section className={styles.identityBand} aria-label="Student identity and current context">
      <div className={styles.identityWho}>
        <StudentAvatar
          student={student}
          size="xl"
          src={photoPreviewUrl}
          ringColor={currentRank?.color_hex ?? null}
        />
        <div className={styles.identityWhoCopy}>
          {student.legal_first_name !== student.preferred_name && student.preferred_name && (
            <p className={styles.identityLegal}>
              Legal name: {student.legal_first_name} {student.legal_last_name}
            </p>
          )}
          <div className={styles.identityTags}>
            <StatusBadge status={student.status} />
            {isCurrentHold && student.status !== "paused" ? (
              <ToneTag tone="warn">Currently on hold</ToneTag>
            ) : null}
            {student.is_minor ? <ToneTag dot={false}>Minor</ToneTag> : null}
            {student.tags.map((tag) => (
              <span key={tag} className={styles.rosterTag}>
                {tag}
              </span>
            ))}
          </div>
          {activePrograms.length > 0 ? (
            <ul className={styles.identityPrograms} aria-label={`${fullName}'s programs`}>
              {activePrograms.map((program) => (
                <li key={program.id} className={styles.beltProgram}>
                  <span
                    aria-hidden="true"
                    className={styles.programDot}
                    style={{ backgroundColor: program.color_hex }}
                  />
                  {program.name}
                </li>
              ))}
            </ul>
          ) : null}
          <div className={styles.identityPhoto}>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={isCommandPending}
              onChange={(event) => {
                const selectedFile = event.currentTarget.files?.[0];
                if (!selectedFile) return;

                const input = event.currentTarget;
                void Promise.resolve(onPhotoSelected(selectedFile)).then((shouldReset) => {
                  if (shouldReset !== false) {
                    input.value = "";
                  }
                });
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              isLoading={isPhotoSaving}
              disabled={isCommandPending}
              onClick={() => photoInputRef.current?.click()}
            >
              <Camera aria-hidden="true" className="w-3.5 h-3.5" />
              {student.photo_url ? "Replace photo" : "Upload photo"}
            </Button>
            {canManageRoster && (student.photo_path || student.photo_url || photoPreviewUrl) ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={isPhotoSaving || isCommandPending}
                onClick={() => {
                  void onDeletePhoto();
                }}
              >
                <X aria-hidden="true" className="w-3.5 h-3.5" />
                Remove
              </Button>
            ) : null}
          </div>
          {photoError ? (
            <p className="text-xs text-danger">{photoError}</p>
          ) : isPhotoSaving ? (
            <p className="text-xs text-muted">Updating photo...</p>
          ) : null}
        </div>
      </div>

      <dl className={styles.identityFacts}>
        <div className={`${styles.identityFact} ${styles.identityBelt}`}>
          <dt>Current belt</dt>
          <dd>
            {currentRank ? (
              <span className={styles.identityBeltValue}>
                <BeltSwatch color={currentRank.color_hex} size="lg" />
                <StudentRankBadge
                  name={currentRank.name}
                  colorHex={currentRank.color_hex}
                  isTip={currentRank.is_tip}
                  tipColorHex={currentRank.tip_color_hex ?? undefined}
                />
              </span>
            ) : beltFactsUnavailable ? (
              <span className={styles.identityQuiet}>Rank unavailable</span>
            ) : beltFactsLoading ? (
              <FactPlaceholder className="h-5 w-24" label="Loading rank" />
            ) : (
              <span className={styles.identityQuiet}>No rank assigned</span>
            )}
          </dd>
          {currentRank ? (
            <dd className={styles.identityFactNote}>{currentRank.ladderName}</dd>
          ) : null}
        </div>

        <Fact label="Next rank">
          {beltFactsUnavailable ? (
            "Unavailable"
          ) : beltFactsLoading ? (
            <FactPlaceholder className="h-4 w-16" label="Loading next rank" />
          ) : nextRank ? (
            <StudentRankBadge
              name={nextRank.name}
              colorHex={nextRank.color_hex}
              isTip={nextRank.is_tip}
              tipColorHex={nextRank.tip_color_hex ?? undefined}
            />
          ) : currentRank ? (
            "Top of ladder"
          ) : (
            "—"
          )}
        </Fact>

        <Fact label="Last promotion">
          {beltFactsUnavailable ? (
            "Unavailable"
          ) : beltFactsLoading ? (
            <FactPlaceholder className="h-3 w-20" label="Loading last promotion" />
          ) : (
            formatDateTime(latestPromotionAt)
          )}
        </Fact>

        <Fact label="Recorded promotions">
          {beltFactsUnavailable ? (
            "Unavailable"
          ) : beltFactsLoading ? (
            <FactPlaceholder className="h-3 w-6" label="Loading promotion count" />
          ) : (
            <span>{promotionCount}</span>
          )}
        </Fact>

        <Fact label="Age">
          <span>{calculateAge(student.date_of_birth, businessDate)}</span>
        </Fact>

        <Fact label="Member since" note={tenure}>
          {formatDate(student.membership_start_date)}
        </Fact>

        {(student.hold_start_date || student.hold_end_date) && (
          <Fact label="Hold window">
            {student.hold_start_date ? formatDate(student.hold_start_date) : "—"} to{" "}
            {student.hold_end_date ? formatDate(student.hold_end_date) : "Open"}
          </Fact>
        )}
      </dl>
      {beltLoadError ? <p className={styles.identityWarning}>{beltLoadError}</p> : null}
    </section>
  );
}
