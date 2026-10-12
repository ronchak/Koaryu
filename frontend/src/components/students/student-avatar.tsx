"use client";

/* eslint-disable @next/next/no-img-element -- Student photos can use private signed URLs or local blob previews. */

import { useState, type CSSProperties } from "react";
import type { Student } from "@/types";

type StudentAvatarSize = "sm" | "md" | "lg" | "xl";

interface StudentAvatarProps {
  student: Student;
  size?: StudentAvatarSize;
  src?: string | null;
  className?: string;
  /** A belt colour (data colour) drawn as a ring around the avatar. */
  ringColor?: string | null;
}

const avatarSizeStyles: Record<StudentAvatarSize, string> = {
  sm: "w-7 h-7 text-xs",
  md: "w-10 h-10 text-[0.8125rem]",
  lg: "w-16 h-16 text-2xl",
  xl: "w-20 h-20 text-[1.75rem]",
};

function studentInitials(student: Student) {
  const first = student.legal_first_name?.trim()[0] || "?";
  const last = student.legal_last_name?.trim()[0] || "";
  return `${first}${last}`.toUpperCase();
}

function studentDisplayName(student: Student) {
  return `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`.trim();
}

export function StudentAvatar({
  student,
  size = "sm",
  src,
  className = "",
  ringColor,
}: StudentAvatarProps) {
  const imageSrc = src ?? student.photo_url ?? "";
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const shouldShowImage = Boolean(imageSrc && failedImageSrc !== imageSrc);
  const ringStyle: CSSProperties | undefined = ringColor
    ? {
        boxShadow: `0 0 0 2px var(--product-paper, var(--surface)), 0 0 0 4px ${ringColor}`,
      }
    : undefined;

  return (
    <div
      className={`
        ${avatarSizeStyles[size]}
        rounded-full bg-[var(--hz-tile,var(--surface-raised))]
        border border-[var(--product-rule-soft,var(--border))]
        flex items-center justify-center overflow-hidden flex-shrink-0
        ${className}
      `}
      style={ringStyle}
    >
      {shouldShowImage ? (
        <img
          src={imageSrc}
          alt={`${studentDisplayName(student)} profile photo`}
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailedImageSrc(imageSrc)}
        />
      ) : (
        <span className="font-bold tracking-[-0.01em] text-text-secondary">
          {studentInitials(student)}
        </span>
      )}
    </div>
  );
}
