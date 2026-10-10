import type { HorizonTone } from "@/components/ui/horizon";
import type { StudentStatus } from "@/types";

// The words carry the state; the tone only reinforces it. A trial is a member to
// win, a cancellation is a member lost, a hold is simply paused.
export const STUDENT_STATUS_DISPLAY: Record<StudentStatus, { label: string; tone: HorizonTone }> = {
  active: { label: "Active", tone: "calm" },
  trialing: { label: "Trial", tone: "warn" },
  paused: { label: "On hold", tone: "neutral" },
  inactive: { label: "Inactive", tone: "neutral" },
  canceled: { label: "Canceled", tone: "alert" },
};
