"use client";

import { useRef } from "react";
import { ProgramBadge } from "@/components/programs/program-picker";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentAvatar } from "@/components/students/student-avatar";
import {
  StudentRankBadge,
  type StudentRankWithContext,
} from "@/components/students/student-rank-badge";
import { Button } from "@/components/ui/button";
import type { BeltRank, Program, Student } from "@/types";
import { Camera, X } from "lucide-react";

type PhotoSelectResult = boolean | void | Promise<boolean | void>;

interface StudentDetailSidebarProps {
  student: Student;
  fullName: string;
  programs: Program[];
  activeProgramIds: string[];
  photoPreviewUrl: string | null;
  photoError: string | null;
  isPhotoSaving: boolean;
  onPhotoSelected: (file: File) => PhotoSelectResult;
  onDeletePhoto: () => Promise<void> | void;
  isCurrentHold: boolean;
  currentRank?: StudentRankWithContext;
  nextRank?: BeltRank;
  latestPromotionAt?: string | null;
  promotionCount: number;
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

function calculateAge(dob?: string | null): string {
  if (!dob) return "—";
  const diff = Date.now() - new Date(dob).getTime();
  return `${Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25))} yrs`;
}

export function StudentDetailSidebar({
  student,
  fullName,
  programs,
  activeProgramIds,
  photoPreviewUrl,
  photoError,
  isPhotoSaving,
  onPhotoSelected,
  onDeletePhoto,
  isCurrentHold,
  currentRank,
  nextRank,
  latestPromotionAt,
  promotionCount,
  isLoadingBeltData,
  beltLoadError,
}: StudentDetailSidebarProps) {
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="col-span-1 space-y-4">
      <div className="bg-surface border border-border rounded-[6px] p-5 text-center">
        <StudentAvatar
          student={student}
          size="lg"
          src={photoPreviewUrl}
          className="mx-auto mb-3"
        />
        <p className="font-semibold text-text-primary text-base">{fullName}</p>
        {student.legal_first_name !== student.preferred_name && student.preferred_name && (
          <p className="text-xs text-muted mt-0.5">
            Legal: {student.legal_first_name} {student.legal_last_name}
          </p>
        )}
        <div className="mt-3">
          <StatusBadge status={student.status} />
        </div>
        <div className="mt-3 flex items-center justify-center gap-2">
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
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
            variant="secondary"
            size="sm"
            isLoading={isPhotoSaving}
            onClick={() => photoInputRef.current?.click()}
          >
            <Camera className="w-3.5 h-3.5" />
            {student.photo_url ? "Replace" : "Upload"}
          </Button>
          {student.photo_path || student.photo_url || photoPreviewUrl ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={isPhotoSaving}
              onClick={() => {
                void onDeletePhoto();
              }}
            >
              <X className="w-3.5 h-3.5" />
              Remove
            </Button>
          ) : null}
        </div>
        {photoError ? (
          <p className="text-xs text-danger mt-2">{photoError}</p>
        ) : isPhotoSaving ? (
          <p className="text-xs text-muted mt-2">Updating photo...</p>
        ) : null}
        {isCurrentHold && (
          <p className="text-xs text-warning mt-2">Currently on hold</p>
        )}
        {student.is_minor && (
          <p className="text-xs text-warning mt-2">Minor</p>
        )}
        {activeProgramIds.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {activeProgramIds.map((programId) => {
              const program = programs.find((item) => item.id === programId);
              return program ? (
                <ProgramBadge key={programId} program={program} />
              ) : null;
            })}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-[6px] p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted text-xs">Age</span>
          <span className="text-text-primary font-mono text-xs">
            {calculateAge(student.date_of_birth)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted text-xs">Member since</span>
          <span className="text-text-primary font-mono text-xs">
            {formatDate(student.membership_start_date)}
          </span>
        </div>
        {(student.hold_start_date || student.hold_end_date) && (
          <div className="flex justify-between text-sm">
            <span className="text-muted text-xs">Hold window</span>
            <span className="text-text-primary font-mono text-xs">
              {student.hold_start_date ? formatDate(student.hold_start_date) : "—"} to{" "}
              {student.hold_end_date ? formatDate(student.hold_end_date) : "Open"}
            </span>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-[6px] p-4 space-y-3">
        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">Current belt</p>
          {currentRank ? (
            <div className="flex items-center gap-2 flex-wrap">
              <StudentRankBadge
                name={currentRank.name}
                colorHex={currentRank.color_hex}
                isTip={currentRank.is_tip}
                tipColorHex={currentRank.tip_color_hex ?? undefined}
              />
              <span className="text-xs text-muted">{currentRank.ladderName}</span>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">No rank assigned</p>
          )}
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted text-xs">Next rank</span>
          <span className="text-text-primary text-xs">
            {nextRank ? (
              <StudentRankBadge
                name={nextRank.name}
                colorHex={nextRank.color_hex}
                isTip={nextRank.is_tip}
                tipColorHex={nextRank.tip_color_hex ?? undefined}
              />
            ) : currentRank ? "Top of ladder" : "—"}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted text-xs">Last promotion</span>
          <span className="text-text-primary font-mono text-xs">
            {formatDateTime(latestPromotionAt)}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted text-xs">Recorded promotions</span>
          <span className="text-text-primary font-mono text-xs">
            {promotionCount}
          </span>
        </div>

        {beltLoadError ? (
          <p className="text-xs text-warning">{beltLoadError}</p>
        ) : isLoadingBeltData ? (
          <p className="text-xs text-muted">Loading belt history…</p>
        ) : null}
      </div>

      {student.tags.length > 0 && (
        <div className="bg-surface border border-border rounded-[6px] p-4">
          <p className="text-xs font-medium text-text-secondary mb-2">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {student.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
