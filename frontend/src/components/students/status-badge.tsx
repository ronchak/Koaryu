import { STUDENT_STATUS_DISPLAY } from "@/components/students/student-status";
import { ToneTag } from "@/components/ui/horizon";
import type { StudentStatus } from "@/types";

interface StatusBadgeProps {
  status: StudentStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STUDENT_STATUS_DISPLAY[status] ?? STUDENT_STATUS_DISPLAY.inactive;
  return (
    <ToneTag tone={config.tone} className={className}>
      {config.label}
    </ToneTag>
  );
}
