"use client";

/* eslint-disable @next/next/no-img-element -- Student photos can use private signed URLs or local blob previews. */

import { useState } from "react";
import type { Student } from "@/types";

type StudentAvatarSize = "sm" | "lg";

interface StudentAvatarProps {
  student: Student;
  size?: StudentAvatarSize;
  src?: string | null;
  className?: string;
}

const avatarSizeStyles: Record<StudentAvatarSize, string> = {
  sm: "w-7 h-7 text-xs",
  lg: "w-16 h-16 text-2xl",
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
}: StudentAvatarProps) {
  const imageSrc = src ?? student.photo_url ?? "";
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const shouldShowImage = Boolean(imageSrc && failedImageSrc !== imageSrc);

  return (
    <div
      className={`
        ${avatarSizeStyles[size]}
        rounded-full bg-surface-raised border border-border
        flex items-center justify-center overflow-hidden flex-shrink-0
        ${className}
      `}
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
        <span className="font-semibold text-text-secondary">
          {studentInitials(student)}
        </span>
      )}
    </div>
  );
}
