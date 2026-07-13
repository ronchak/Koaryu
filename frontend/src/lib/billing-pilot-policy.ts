import type { StaffRoleName } from "@/types";

export const FRIENDLY_PILOT_BILLING_BOUNDARY_MESSAGE =
  "Friendly Pilot billing supports external-only student attachments, payer-level external payments, and invoice reconciliation. Live Stripe mutations require a separate approval.";

export function canManageFriendlyPilotRoutineBilling(
  role: StaffRoleName | null | undefined
): boolean {
  return role === "admin" || role === "front_desk";
}

export function areFriendlyPilotProviderMutationsEnabled(isPreviewMode: boolean): boolean {
  return isPreviewMode;
}
