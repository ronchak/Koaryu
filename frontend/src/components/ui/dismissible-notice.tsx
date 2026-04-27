"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

type NoticeTone = "success" | "danger" | "warning";

interface DismissibleNoticeProps {
  children: ReactNode;
  tone: NoticeTone;
  onDismiss: () => void;
  className?: string;
}

const toneStyles: Record<NoticeTone, string> = {
  success: "border-success/20 bg-success/5 text-success",
  danger: "border-danger/20 bg-danger/5 text-danger",
  warning: "border-warning/20 bg-warning/5 text-warning",
};

export function DismissibleNotice({
  children,
  tone,
  onDismiss,
  className = "",
}: DismissibleNoticeProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start justify-between gap-3 rounded-[6px] border px-4 py-3 text-sm ${toneStyles[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-[4px] p-0.5 opacity-70 transition hover:bg-white/10 hover:opacity-100 cursor-pointer"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
